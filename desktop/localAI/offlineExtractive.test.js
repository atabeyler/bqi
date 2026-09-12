import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../testHelpers.js';
import { encryptField } from '../db/fieldCrypto.js';
import { findReports, summarizeReport, compareReports, queryOffline, synthesizeFromArchive } from './offlineExtractive.js';

let db;
const USER = 'BOLD-001';
const TEST_KEY = '11'.repeat(32);

function insertAnalysis(id, { title, content, category = 'bddk', createdAt }) {
  const ts = createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO analyses (id, user_id, device_id, version, created_at, updated_at, sync_status, category, title, content)
    VALUES (?, ?, 'BQI-WIN-TEST', 1, ?, ?, 'synced', ?, ?, ?)
  `).run(id, USER, ts, ts, category, title, content);
}

beforeEach(() => { db = createTestDb(); });

describe('findReports', () => {
  it('ranks by keyword relevance in title and content', () => {
    insertAnalysis('r1', { title: 'Dolandırıcılık analizi', content: 'kredi kartı sahtekarlığı tespit edildi' });
    insertAnalysis('r2', { title: 'Portföy raporu', content: 'yatırım dağılımı incelendi' });

    const results = findReports(db, USER, 'dolandırıcılık sahtekarlık');
    expect(results[0].id).toBe('r1');
  });

  it('decrypts encrypted desktop analyses before keyword scoring', () => {
    insertAnalysis('encrypted', {
      title: encryptField('Deniz sınırı çatışma analizi', TEST_KEY),
      content: encryptField('Deniz sınırında gerilim ve çatışma riski değerlendirildi.', TEST_KEY),
      category: 'jeopolitik',
    });

    const raw = db.prepare('SELECT title, content FROM analyses WHERE id = ?').get('encrypted');
    expect(raw.title).toMatch(/^aqenc:v1:/);
    expect(raw.content).toMatch(/^aqenc:v1:/);

    const results = findReports(db, USER, 'deniz sınırı çatışma', { encryptionKey: TEST_KEY });
    expect(results[0].id).toBe('encrypted');
    expect(results[0].title).toBe('Deniz sınırı çatışma analizi');
    expect(results[0].preview).toContain('çatışma riski');
  });

  it('filters by a Turkish relative date phrase ("geçen ay")', () => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5).toISOString();
    insertAnalysis('old', { title: 'Eski rapor', content: 'içerik', createdAt: lastMonth });
    insertAnalysis('new', { title: 'Yeni rapor', content: 'içerik', createdAt: thisMonth });

    const results = findReports(db, USER, 'geçen ayki raporlarımı bul');
    expect(results.map((r) => r.id)).toEqual(['old']);
  });

  it('never returns another user\'s reports', () => {
    insertAnalysis('mine', { title: 'Benim raporum', content: 'x' });
    db.prepare(`UPDATE analyses SET user_id = 'BOLD-999' WHERE id = 'mine'`).run();
    expect(findReports(db, USER, 'rapor')).toHaveLength(0);
  });
});

describe('summarizeReport', () => {
  it('extracts the most relevant sentences, in original order', () => {
    insertAnalysis('r1', {
      title: 'Rapor',
      content: 'Hava bugün güzel. Dolandırıcılık işlemleri tespit edildi ve dolandırıcılık riski yüksek. Kedi uyuyor. Dolandırıcılık önlemleri artırıldı.',
    });
    const summary = summarizeReport(db, USER, 'r1', { maxSentences: 2 });
    expect(summary.summary).toContain('Dolandırıcılık işlemleri tespit edildi');
    expect(summary.summary).not.toContain('Kedi uyuyor');
  });

  it('returns null for a report that does not exist / is not the caller\'s', () => {
    expect(summarizeReport(db, USER, 'missing')).toBeNull();
  });
});

describe('compareReports', () => {
  it('reports shared vs. unique terms between two reports', () => {
    insertAnalysis('a', { title: 'A', content: 'dolandırıcılık kredi kartı işlem' });
    insertAnalysis('b', { title: 'B', content: 'dolandırıcılık sigorta işlem' });

    const result = compareReports(db, USER, 'a', 'b');
    expect(result.commonTermCount).toBeGreaterThan(0);
    expect(result.onlyInA).toContain('kredi');
    expect(result.onlyInB).toContain('sigorta');
  });
});

describe('queryOffline dispatch', () => {
  it('dispatches to compare when two entityIds are given ("bu iki raporu karşılaştır")', () => {
    insertAnalysis('a', { title: 'A', content: 'x' });
    insertAnalysis('b', { title: 'B', content: 'y' });
    const res = queryOffline(db, USER, { entityIds: ['a', 'b'] });
    expect(res.type).toBe('compare');
  });

  it('dispatches to summary when one entityId is given ("özetle")', () => {
    insertAnalysis('a', { title: 'A', content: 'x. y. z.' });
    const res = queryOffline(db, USER, { entityIds: ['a'] });
    expect(res.type).toBe('summary');
  });

  it('dispatches to find for free-text search', () => {
    insertAnalysis('a', { title: 'Rapor', content: 'x' });
    const res = queryOffline(db, USER, { text: 'raporlarımı bul' });
    expect(res.type).toBe('find');
  });

  it('infers summary intent and resolves the best matching report', () => {
    insertAnalysis('a', { title: 'Bütçe Raporu', content: 'Giderler arttı. Personel maliyeti yükseldi. Tasarruf planı hazırlandı.' });
    const res = queryOffline(db, USER, { text: 'bütçe raporunu özetle' });
    expect(res.type).toBe('summary');
    expect(res.result.id).toBe('a');
  });

  it('infers comparison intent and resolves the two best reports', () => {
    insertAnalysis('a', { title: 'Risk Raporu A', content: 'kredi riski arttı' });
    insertAnalysis('b', { title: 'Risk Raporu B', content: 'kredi riski azaldı' });
    const res = queryOffline(db, USER, { text: 'risk raporlarını karşılaştır' });
    expect(res.type).toBe('compare');
    expect([res.result.a.id, res.result.b.id]).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

describe('Turkish token normalization', () => {
  it('matches common plural and possessive suffix variants', () => {
    insertAnalysis('a', { title: 'Risk değerlendirmesi', content: 'Operasyon riskleri incelendi' });
    expect(findReports(db, USER, 'risklerin durumu')[0].id).toBe('a');
  });
});

// The Analysis Router's step-3 fallback for a "generate a new analysis"
// request when neither cloud nor the local LLM is available -- must never
// fabricate a new report (see the function's own comment in
// offlineExtractive.js), only surface the closest existing local matches.
describe('synthesizeFromArchive', () => {
  it('returns the closest matching archived reports, clearly marked as not generated', () => {
    insertAnalysis('a', { title: 'Kasım Bütçe Raporu', content: 'Toplam gider 90000 TL oldu.', category: 'finans' });
    insertAnalysis('b', { title: 'Portföy raporu', content: 'yatırım dağılımı', category: 'yatirim' });

    const result = synthesizeFromArchive(db, USER, { category: 'finans', prompt: 'bütçe' });

    expect(result.generated).toBe(false);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].title).toBe('Kasım Bütçe Raporu');
    expect(result.note).toMatch(/en yakın eşleşen/);
  });

  it('prefers a same-category match over a longer, unrelated-category report that only wins on generic term repetition', () => {
    insertAnalysis('social', {
      title: 'Toplumsal Gerilim Raporu',
      content: 'Bölgesel toplumsal gerilim ve yerel güvenlik değerlendirmesi.',
      category: 'toplumsal',
    });
    // Simulates the real incident: an old, unrelated-category test report
    // padded with generic words shared by almost any query -- under pure
    // term-frequency scoring (no category awareness) this out-scores the
    // short, actually-relevant same-category report above.
    insertAnalysis('military', {
      title: 'Saldırı Senaryosu',
      content: 'Bölge bölge bölge güvenlik güvenlik güvenlik risk risk risk toplum toplum toplum tedbir tedbir.',
      category: 'saldiri',
    });

    const result = synthesizeFromArchive(db, USER, { category: 'toplumsal', prompt: 'bölgesel güvenlik ve toplumsal gerilim' });

    expect(result.matches.map((m) => m.id)).toEqual(['social']);
  });

  it('is honest when nothing matches, instead of claiming success', () => {
    const result = synthesizeFromArchive(db, USER, { category: 'bilinmeyen', prompt: 'hiçbir şey eşleşmeyecek zzz' });
    expect(result.generated).toBe(false);
    expect(result.matches).toEqual([]);
    expect(result.note).toMatch(/çevrimiçi bağlantı veya yerel LLM/);
  });
});
