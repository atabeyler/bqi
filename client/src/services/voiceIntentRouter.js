export function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ç]/g, 'c').replace(/[ğ]/g, 'g').replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ş]/g, 's').replace(/[ü]/g, 'u')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackIntent(raw) {
  const t = normalizeText(raw);
  if (!t) return { type: 'unknown' };
  if (t.includes('ana ekran') || t.includes('anasayfa') || t.includes('don')) return { type: 'navigate', view: 'home' };
  if (t.includes('sohbet') || t.includes('chat') || t.includes('danisma')) return { type: 'navigate', view: 'chat' };
  if (t.includes('gecmis')) return { type: 'navigate', view: 'history' };
  if (t.includes('kilavuz')) return (t.includes('cik') || t.includes('kapat')) ? { type: 'navigate', view: 'guide-close' } : { type: 'navigate', view: 'guide-open' };
  if (t.includes('ingilizce') || t === 'en' || t.includes('english')) return { type: 'lang', lang: 'en' };
  if (t.includes('turkce') || t === 'tr' || t.includes('turkish')) return { type: 'lang', lang: 'tr' };
  if (t.includes('cikis') || t.includes('logout') || t.includes('oturum')) return { type: 'logout' };
  if (t.includes('kuantum') || t.includes('quantum')) return { type: 'analysis-quantum', mode: (t.includes('kapat') || t.includes('kaldir') || t.includes('off')) ? 'off' : 'on' };
  if (t.includes('yeni analiz') || t.includes('analiz baslat')) return { type: 'navigate', view: 'analysis' };
  return { type: 'unknown' };
}

export async function parseIntentWithAI(raw, chatConsult) {
  const prompt = `Return only compact JSON intent for this command: ${raw}`;
  try {
    const res = await chatConsult(prompt, []);
    const text = (res?.response || res?.content || res?.message || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && obj.type) return obj;
    }
  } catch {}
  return fallbackIntent(raw);
}
