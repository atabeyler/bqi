import { describe, it, expect, beforeEach } from 'vitest';
import { createTestMobileDb } from '../testHelpers.js';
import { dbRun } from '../db/index.js';
import { findReports, summarizeReport, compareReports, queryOffline, synthesizeFromArchive } from './offlineExtractive.js';

let db;
const USER = 'BOLD-001';

async function insertAnalysis(id, { title, content, category = 'bddk', createdAt }) {
  const ts = createdAt || new Date().toISOString();
  await dbRun(db, `
    INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
    VALUES (?, ?, 'BQI-AND-TEST', 1, ?, ?, 'synced', ?, ?, ?)
  `, [id, USER, ts, ts, category, title, content]);
}

beforeEach(async () => { db = await createTestMobileDb(); });

describe('findReports', () => {
  it('ranks by keyword relevance in title and content', async () => {
    await insertAnalysis('r1', { title: 'Dolandırıcılık analizi', content: 'kredi kartı sahtekarlığı tespit edildi' });
    await insertAnalysis('r2', { title: 'Portföy raporu', content: 'yatırım dağılımı incelendi' });

    const results = await findReports(db, USER, 'dolandırıcılık sahtekarlık');
    expect(results[0].id).toBe('r1');
  });

  it('filters by a Turkish relative date phrase ("geçen ay")', async () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
    await insertAnalysis('old', { title: 'Eski rapor', content: 'içerik', createdAt: lastMonth });
    await insertAnalysis('new', { title: 'Yeni rapor', content: 'içerik', createdAt: thisMonth });

    const results = await findReports(db, USER, 'geçen ayki raporlarımı bul');
    expect(results.map((r) => r.id)).toEqual(['old']);
  });

  it('never returns another user\'s reports', async () => {
    await insertAnalysis('mine', { title: 'Benim raporum', content: 'x' });
    await dbRun(db, `UPDATE analyses SET user_id = 'BOLD-999' WHERE id = 'mine'`);
    expect(await findReports(db, USER, 'rapor')).toHaveLength(0);
  });
});

describe('summarizeReport', () => {
  it('extracts the most relevant sentences, in original order', async () => {
    await insertAnalysis('r1', {
      title: 'Rapor',
      content: 'Hava bugün güzel. Dolandırıcılık işlemleri tespit edildi ve dolandırıcılık riski yüksek. Kedi uyuyor. Dolandırıcılık önlemleri artırıldı.',
    });
    const summary = await summarizeReport(db, USER, 'r1', { maxSentences: 2 });
    expect(summary.summary).toContain('Dolandırıcılık işlemleri tespit edildi');
    expect(summary.summary).not.toContain('Kedi uyuyor');
  });

  it('returns null for a report that does not exist / is not the caller\'s', async () => {
    expect(await summarizeReport(db, USER, 'missing')).toBeNull();
  });
});

describe('compareReports', () => {
  it('reports shared vs. unique terms between two reports', async () => {
    await insertAnalysis('a', { title: 'A', content: 'dolandırıcılık kredi kartı işlem' });
    await insertAnalysis('b', { title: 'B', content: 'dolandırıcılık sigorta işlem' });

    const result = await compareReports(db, USER, 'a', 'b');
    expect(result.commonTermCount).toBeGreaterThan(0);
    expect(result.onlyInA).toContain('kredi');
    expect(result.onlyInB).toContain('sigorta');
  });
});

describe('queryOffline dispatch', () => {
  it('dispatches to compare when two entityIds are given ("bu iki raporu karşılaştır")', async () => {
    await insertAnalysis('a', { title: 'A', content: 'x' });
    await insertAnalysis('b', { title: 'B', content: 'y' });
    const res = await queryOffline(db, USER, { entityIds: ['a', 'b'] });
    expect(res.type).toBe('compare');
  });

  it('dispatches to summary when one entityId is given ("özetle")', async () => {
    await insertAnalysis('a', { title: 'A', content: 'x. y. z.' });
    const res = await queryOffline(db, USER, { entityIds: ['a'] });
    expect(res.type).toBe('summary');
  });

  it('dispatches to find for free-text search', async () => {
    await insertAnalysis('a', { title: 'Rapor', content: 'x' });
    const res = await queryOffline(db, USER, { text: 'raporlarımı bul' });
    expect(res.type).toBe('find');
  });
});

// Mirrors desktop/localAI/offlineExtractive.test.js's synthesizeFromArchive
// tests -- see that module's comment for why this never fabricates a new
// report.
describe('synthesizeFromArchive', () => {
  it('returns the closest matching archived reports, clearly marked as not generated', async () => {
    await insertAnalysis('a', { title: 'Kasım Bütçe Raporu', content: 'Toplam gider 90000 TL oldu.', category: 'finans' });
    await insertAnalysis('b', { title: 'Portföy raporu', content: 'yatırım dağılımı', category: 'yatirim' });

    const result = await synthesizeFromArchive(db, USER, { category: 'finans', prompt: 'bütçe' });

    expect(result.generated).toBe(false);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].title).toBe('Kasım Bütçe Raporu');
  });

  it('prefers a same-category match over a longer, unrelated-category report that only wins on generic term repetition', async () => {
    await insertAnalysis('social', {
      title: 'Toplumsal Gerilim Raporu',
      content: 'Bölgesel toplumsal gerilim ve yerel güvenlik değerlendirmesi.',
      category: 'toplumsal',
    });
    await insertAnalysis('military', {
      title: 'Saldırı Senaryosu',
      content: 'Bölge bölge bölge güvenlik güvenlik güvenlik risk risk risk toplum toplum toplum tedbir tedbir.',
      category: 'saldiri',
    });

    const result = await synthesizeFromArchive(db, USER, { category: 'toplumsal', prompt: 'bölgesel güvenlik ve toplumsal gerilim' });

    expect(result.matches.map((m) => m.id)).toEqual(['social']);
  });

  it('is honest when nothing matches, instead of claiming success', async () => {
    const result = await synthesizeFromArchive(db, USER, { category: 'bilinmeyen', prompt: 'hiçbir şey eşleşmeyecek zzz' });
    expect(result.generated).toBe(false);
    expect(result.matches).toEqual([]);
  });
});
