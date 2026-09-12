import { query } from './database.js';
import { logger } from '../lib/logger.js';

const ISTANBUL_TZ = 'Europe/Istanbul';
let inMemoryBriefing = null;

const DEFAULT_SOURCES = [
  { kind: 'rss', name: 'TRT Haber - Son Dakika', url: 'https://www.trthaber.com/sondakika_articles.rss' },
  { kind: 'rss', name: 'TRT Haber - Gündem', url: 'https://www.trthaber.com/gundem_articles.rss' },
  { kind: 'rss', name: 'TRT Haber - Dünya', url: 'https://www.trthaber.com/dunya_articles.rss' },
  { kind: 'rss', name: 'AA Teyit Hattı - Tüm Haberler', url: 'https://www.aa.com.tr/tr/teyithatti/rss/news?cat=0' },

  { kind: 'html', name: 'T.C. İçişleri Bakanlığı - Duyurular', url: 'https://www.icisleri.gov.tr/duyurular', domain: 'icisleri.gov.tr' },
  { kind: 'html', name: 'MSB - Askeralma Duyurular', url: 'https://www.msb.gov.tr/Askeralma/AsalDuyuruListe', domain: 'msb.gov.tr' },
  { kind: 'html', name: 'AFAD - Duyurular', url: 'https://www.afad.gov.tr/Duyurular/', domain: 'afad.gov.tr' },
  { kind: 'html', name: 'MGM - Duyurular', url: 'https://mgm.gov.tr/site/duyuru.aspx', domain: 'mgm.gov.tr' },
  { kind: 'html', name: 'T.C. Dışişleri Bakanlığı', url: 'https://www.mfa.gov.tr/default.tr.mfa', domain: 'mfa.gov.tr' },
  { kind: 'html', name: 'T.C. Cumhurbaşkanlığı', url: 'https://www.tccb.gov.tr/haberler/', domain: 'tccb.gov.tr' }
];

function getTodayDateTR() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function getNowHMTR() {
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: ISTANBUL_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function parseSourcesFromEnv() {
  const raw = process.env.NEWS_RSS_SOURCES;
  if (!raw) return DEFAULT_SOURCES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      return parsed
        .filter((x) => x?.url)
        .map((x) => ({ kind: x.kind || 'rss', name: x.name || x.url, url: x.url, domain: x.domain || null }));
    }
  } catch { /* invalid env JSON — fall back to default sources */ }
  return DEFAULT_SOURCES;
}

function stripHtml(s = '') {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function textBetween(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
}

function parseRssItems(xml, sourceName) {
  const items = [];
  const parts = xml.split(/<item[\s>]/i).slice(1);
  for (const p of parts) {
    const chunk = '<item ' + p;
    const title = textBetween(chunk, 'title');
    const link = textBetween(chunk, 'link');
    const desc = textBetween(chunk, 'description');
    const pubDateRaw = textBetween(chunk, 'pubDate') || textBetween(chunk, 'dc:date');
    if (!title || !link) continue;
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
    items.push({
      source: sourceName,
      title,
      link,
      description: desc,
      published_at: pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate.toISOString() : null,
      published_raw: pubDateRaw || null,
    });
  }
  return items;
}

function extractDate(text) {
  if (!text) return null;
  const m1 = text.match(/(\d{1,2})\s*(Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara)\s*(\d{4})/i);
  if (m1) return `${m1[1]} ${m1[2]} ${m1[3]}`;
  const m2 = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m2) return `${m2[1]}.${m2[2]}.${m2[3]}`;
  return null;
}

function toAbsoluteUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function parseHtmlAnnouncementItems(html, source) {
  const anchors = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const out = [];

  for (const a of anchors) {
    const href = a[1];
    const label = stripHtml(a[2]);
    if (!label || label.length < 12) continue;
    const lc = label.toLowerCase();
    if (!(lc.includes('duyuru') || lc.includes('basın') || lc.includes('haber') || lc.includes('aciklama') || /\d{4}/.test(label))) continue;

    const link = toAbsoluteUrl(source.url, href);
    if (!link) continue;
    if (source.domain && !link.includes(source.domain)) continue;

    const around = html.slice(Math.max(0, a.index - 120), Math.min(html.length, a.index + 280));
    const dateText = extractDate(stripHtml(around));

    out.push({
      source: source.name,
      title: label,
      link,
      description: null,
      published_at: null,
      published_raw: dateText,
    });
  }

  const dedup = new Map();
  for (const it of out) {
    const k = `${it.link}::${it.title}`;
    if (!dedup.has(k)) dedup.set(k, it);
  }
  return [...dedup.values()].slice(0, 40);
}

async function fetchSource(source) {
  const res = await fetch(source.url, {
    headers: { 'User-Agent': 'BQI MorningBrief/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`${source.name} HTTP ${res.status}`);
  const body = await res.text();

  if (source.kind === 'html') {
    return parseHtmlAnnouncementItems(body, source);
  }
  return parseRssItems(body, source.name);
}

function toTRDateStr(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function formatSummary(items) {
  if (!items.length) return 'Bugün için kaynaklardan doğrulanmış yeni başlık bulunamadı.';
  const top = items.slice(0, 14);
  const lines = top.map((it, idx) => `${idx + 1}. ${it.title}`);
  return ['Günlük İstihbarat Özeti', '', ...lines].join('\n');
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.link}::${it.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function ensureTable() {
  if (!process.env.DATABASE_URL) return;
  await query(`
    CREATE TABLE IF NOT EXISTS daily_briefings (
      id SERIAL PRIMARY KEY,
      briefing_date DATE UNIQUE NOT NULL,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Istanbul',
      sources_json JSONB NOT NULL,
      items_json JSONB NOT NULL,
      summary_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daily_briefings_date ON daily_briefings(briefing_date);
  `);
}

export async function getTodayBriefing() {
  if (!process.env.DATABASE_URL) {
    if (inMemoryBriefing?.briefing_date === getTodayDateTR()) return inMemoryBriefing;
    return null;
  }
  const today = getTodayDateTR();
  const r = await query('SELECT * FROM daily_briefings WHERE briefing_date = $1 LIMIT 1', [today]);
  return r.rowCount ? r.rows[0] : null;
}

export async function getBriefingByDate(date) {
  if (!process.env.DATABASE_URL) {
    return inMemoryBriefing?.briefing_date === date ? inMemoryBriefing : null;
  }
  const r = await query('SELECT * FROM daily_briefings WHERE briefing_date = $1 LIMIT 1', [date]);
  return r.rowCount ? r.rows[0] : null;
}

export async function listBriefingDates(limit = 30) {
  if (!process.env.DATABASE_URL) {
    return inMemoryBriefing ? [{ date: inMemoryBriefing.briefing_date, generatedAt: inMemoryBriefing.generated_at, itemCount: (inMemoryBriefing.items_json || []).length }] : [];
  }
  const r = await query(
    'SELECT briefing_date, generated_at, jsonb_array_length(items_json) AS item_count FROM daily_briefings ORDER BY briefing_date DESC LIMIT $1',
    [limit]
  );
  return r.rows.map((row) => ({ date: row.briefing_date, generatedAt: row.generated_at, itemCount: row.item_count }));
}

export async function generateMorningBriefIfNeeded(force = false) {
  const today = getTodayDateTR();
  if (process.env.DATABASE_URL) {
    await ensureTable();
    const existing = await query('SELECT id FROM daily_briefings WHERE briefing_date = $1 LIMIT 1', [today]);
    if (!force && existing.rowCount) return null;
  } else if (!force && inMemoryBriefing?.briefing_date === today) {
    return null;
  }

  const sources = parseSourcesFromEnv();
  const all = [];
  for (const src of sources) {
    try {
      const items = await fetchSource(src);
      all.push(...items);
    } catch (err) {
      logger.warn({ err, source: src.name }, '[MorningBrief] source error');
    }
  }

  const deduped = dedupeItems(all).sort((a, b) => {
    const aa = a.published_at ? new Date(a.published_at).getTime() : 0;
    const bb = b.published_at ? new Date(b.published_at).getTime() : 0;
    return bb - aa;
  });

  const todayOnly = deduped.filter((it) => toTRDateStr(it.published_at) === today || !it.published_at);
  const baseItems = todayOnly.length > 0 ? todayOnly : deduped;

  // Keep official institution announcements and the news feed visible together
  const official = baseItems.filter((it) => /T\.C\.|Bakanlığı|MSB|AFAD|MGM/i.test(it.source));
  const media = baseItems.filter((it) => !/T\.C\.|Bakanlığı|MSB|AFAD|MGM/i.test(it.source));
  const mixed = [];
  const max = Math.max(official.length, media.length);
  for (let i = 0; i < max; i++) {
    if (official[i]) mixed.push(official[i]);
    if (media[i]) mixed.push(media[i]);
  }
  const finalItems = mixed.length ? mixed : baseItems;

  const summary = formatSummary(finalItems);
  if (process.env.DATABASE_URL) {
    await query(
      `INSERT INTO daily_briefings (briefing_date, timezone, sources_json, items_json, summary_text)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (briefing_date)
       DO UPDATE SET generated_at = NOW(), timezone = EXCLUDED.timezone, sources_json = EXCLUDED.sources_json,
                     items_json = EXCLUDED.items_json, summary_text = EXCLUDED.summary_text`,
      [today, ISTANBUL_TZ, JSON.stringify(sources), JSON.stringify(finalItems.slice(0, 120)), summary]
    );
  } else {
    inMemoryBriefing = {
      briefing_date: today,
      generated_at: new Date().toISOString(),
      timezone: ISTANBUL_TZ,
      sources_json: sources,
      items_json: finalItems.slice(0, 120),
      summary_text: summary,
    };
  }

  return true;
}

export function startMorningBriefScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    const hm = getNowHMTR();
    // Generate today's briefing after 07:00 if it doesn't exist yet.
    if (hm < '07:00') return;
    running = true;
    try {
      const existing = await getTodayBriefing();
      if (existing) return;
      await generateMorningBriefIfNeeded(false);
      logger.info('[MorningBrief] today\'s summary generated');
    } catch (e) {
      logger.error({ err: e }, '[MorningBrief] generation error');
    } finally {
      setTimeout(() => { running = false; }, 5000);
    }
  };

  setInterval(tick, 30000);
  generateMorningBriefIfNeeded(false).catch((e) => {
    logger.error({ err: e }, '[MorningBrief] startup generation error');
  });
  tick().catch(() => {});
}

