// Shared TTS utility — consistent female voice + platform-adaptive rate

const FEMALE_HINTS = [
  // Generic
  'female', 'woman', 'girl', 'femme',
  // Turkish female voices
  'yelda', 'selin', 'seda',
  // English female voices — Windows
  'zira', 'hazel', 'aria',
  // macOS female voices
  'samantha', 'victoria', 'karen', 'moira', 'fiona', 'tessa', 'veena', 'serena',
  // Google TTS (Android / Chrome)
  'google uk english female', 'google türkçe',
  // Misc
  'eva', 'susan', 'cortana',
];

// iOS/Android TTS engines run intrinsically faster at the same `rate` value.
// Apply a platform multiplier so perceived speed is consistent.
const ua = navigator.userAgent;
const isIOS     = /iPhone|iPad|iPod/i.test(ua);
const isAndroid = /Android/i.test(ua);
const RATE_FACTOR = isIOS ? 0.80 : isAndroid ? 0.87 : 1.0;

export function pickFemaleVoice(voices, langCode) {
  const primary = langCode.split('-')[0].toLowerCase();
  const sameLang = voices.filter(v => (v.lang || '').toLowerCase().startsWith(primary));
  const pool = sameLang.length ? sameLang : voices;
  const female = pool.find(v => {
    const name = (v.name || '').toLowerCase();
    return FEMALE_HINTS.some(h => name.includes(h));
  });
  return female || pool[0] || null;
}

export function speak(text, langCode, onDone, { rate = 0.95, pitch = 1.05, safetyMs = 20000 } = {}) {
  const synth = window.speechSynthesis;
  if (!synth || !text?.trim()) { onDone?.(); return; }
  try { synth.cancel(); } catch {}

  const utt = new SpeechSynthesisUtterance(text);
  utt.lang  = langCode;
  utt.rate  = rate * RATE_FACTOR;
  utt.pitch = pitch;

  let done = false;
  const finish = () => { if (!done) { done = true; onDone?.(); } };
  const safety = setTimeout(finish, safetyMs);
  utt.onend   = () => { clearTimeout(safety); finish(); };
  utt.onerror = () => { clearTimeout(safety); finish(); };

  const doSpeak = () => {
    const v = pickFemaleVoice(synth.getVoices(), langCode);
    if (v) utt.voice = v;
    try {
      synth.speak(utt);
      setTimeout(() => { try { synth.resume(); } catch {} }, 100);
    } catch { finish(); }
  };

  if (synth.getVoices().length) {
    doSpeak();
  } else {
    let called = false;
    const onVC = () => {
      if (called) return;
      called = true;
      synth.removeEventListener('voiceschanged', onVC);
      doSpeak();
    };
    synth.addEventListener('voiceschanged', onVC);
    setTimeout(() => { if (!called) { called = true; synth.removeEventListener('voiceschanged', onVC); doSpeak(); } }, 800);
  }
}
