import { useState, useRef, useCallback } from 'react';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const FEMALE_HINTS = ['female', 'woman', 'zira', 'hazel', 'aria', 'seda', 'selin'];

function pickPreferredVoice(voices, langCode) {
  const primary = langCode.split('-')[0];
  const sameLang = voices.filter(v => (v.lang || '').toLowerCase().startsWith(primary));
  const pool = sameLang.length ? sameLang : voices;
  const female = pool.find(v => FEMALE_HINTS.some(h => (v.name || '').toLowerCase().includes(h)));
  return female || pool[0] || null;
}

export function useVoice() {
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError]       = useState('');

  const recRef       = useRef(null);
  const cbRef        = useRef(null);
  const stoppedRef   = useRef(false);   // true once the user has stopped it
  const continuousRef = useRef(false);  // continuous listening mode
  const langRef      = useRef('tr-TR');

  // Inner loop — automatically restarts after each utterance
  const doRecord = useCallback(() => {
    if (!SR || stoppedRef.current) return;
    try { recRef.current?.stop(); } catch {}
    recRef.current = null;

    const rec = new SR();
    rec.lang           = langRef.current;
    rec.continuous     = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript?.trim() || '';
      if (text && cbRef.current) cbRef.current(text);
      recRef.current = null;

      if (continuousRef.current && !stoppedRef.current) {
        // Leave a brief pause, then listen again
        setTimeout(doRecord, 150);
      } else {
        stoppedRef.current = false;
        setRecording(false);
        window.dispatchEvent(new CustomEvent('aq:resume'));
      }
    };

    rec.onerror = (ev) => {
      if (recRef.current === rec) recRef.current = null;

      // Silence error: restart in continuous mode
      if (ev.error === 'no-speech' && continuousRef.current && !stoppedRef.current) {
        setTimeout(doRecord, 150);
        return;
      }

      if (ev.error !== 'aborted') setError('speech_recognition_error: ' + ev.error);
      cbRef.current    = null;
      stoppedRef.current = false;
      setRecording(false);
      window.dispatchEvent(new CustomEvent('aq:resume'));
    };

    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch (e) {
      setError('microphone_error: ' + e.message);
      stoppedRef.current = false;
      setRecording(false);
      window.dispatchEvent(new CustomEvent('aq:resume'));
    }
  }, []);

  const startRecording = useCallback((lang, cb, continuous = true) => {
    setError('');
    cbRef.current       = cb || null;
    stoppedRef.current  = false;
    continuousRef.current = continuous;
    langRef.current     = (lang || 'tr-TR').startsWith('en') ? 'en-US' : 'tr-TR';

    if (!SR) { setError('browser_unsupported_use_chrome'); return; }

    window.dispatchEvent(new CustomEvent('aq:pause'));
    setRecording(true);
    setTimeout(doRecord, 200);
  }, [doRecord]);

  const stopRecording = useCallback(() => {
    stoppedRef.current    = true;
    continuousRef.current = false;
    try { recRef.current?.stop(); } catch {}
    recRef.current = null;
    cbRef.current  = null;
    setRecording(false);
    window.dispatchEvent(new CustomEvent('aq:resume'));
  }, []);

  const speak = useCallback((text, lang) => {
    if (!text?.trim()) return;
    const s = window.speechSynthesis;
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang  = (lang || 'tr-TR').startsWith('en') ? 'en-US' : 'tr-TR';
    u.rate  = 0.94;
    u.pitch = 1.06;
    const go = () => {
      const v = pickPreferredVoice(s.getVoices(), u.lang);
      if (v) u.voice = v;
      u.onend  = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      setSpeaking(true);
      s.speak(u);
    };
    s.getVoices().length > 0 ? go() : (s.onvoiceschanged = go);
  }, []);

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  return { recording, speaking, error, startRecording, stopRecording, speak, stopSpeaking };
}
