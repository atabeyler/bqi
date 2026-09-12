import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion'; // AnimatePresence is used for the status pill
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { processVoiceCommand } from '../services/voiceAssistantEngine.js';
import { executePlan } from '../services/voiceActionRegistry.js';
import { t as translate } from '../services/i18n.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const SPEECH_LOCALE = { tr: 'tr-TR', en: 'en-US', de: 'de-DE', fr: 'fr-FR', ar: 'ar-SA' };

const S = { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' };

const FEMALE_HINTS = ['female', 'woman', 'zira', 'hazel', 'aria', 'seda', 'selin'];

function pickVoice(voices, langCode) {
  const primary = langCode.split('-')[0];
  const pool = voices.filter(v => (v.lang || '').toLowerCase().startsWith(primary));
  const src = pool.length ? pool : voices;
  return src.find(v => FEMALE_HINTS.some(h => (v.name || '').toLowerCase().includes(h))) || src[0] || null;
}

export default function GlobalVoiceAssistant({ lang = 'tr', user = null }) {
  const [on, setOn] = useState(false);
  const [status, setStatus] = useState(S.IDLE);
  const [page, setPage] = useState('unknown');
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const dragRef = useRef({ dragging: false, moved: false, sx: 0, sy: 0, px: 24, py: 24 });
  const dragListenersRef = useRef(null);
  const suppressClickRef = useRef(false);

  const onRef      = useRef(false);
  const statusRef  = useRef(S.IDLE);
  const langRef    = useRef(lang);
  const pageRef    = useRef('unknown');
  const userRef    = useRef(user);
  const recRef     = useRef(null);
  const restartRef = useRef(null);
  const startMicFn = useRef(null);
  // Merged, always-current view of every aq:context payload received so
  // far (page, category, depth, quantum, wizardStep, wizardOpen, ...) --
  // this is what lets the local engine resolve context-dependent commands
  // ("Derin yap", "Sonraki") without the caller repeating the category.
  // A ref (not state) because it's read inside the async onresult handler.
  const ctxRef = useRef({ page: 'unknown' });

  useEffect(() => { onRef.current = on; },       [on]);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { langRef.current = lang; },   [lang]);
  useEffect(() => { pageRef.current = page; },   [page]);
  useEffect(() => { userRef.current = user; },   [user]);

  useEffect(() => {
    const handler = (e) => {
      if (!e.detail) return;
      ctxRef.current = { ...ctxRef.current, ...e.detail };
      if (e.detail.page) setPage(e.detail.page);
    };
    window.addEventListener('aq:context', handler);
    return () => window.removeEventListener('aq:context', handler);
  }, []);

  const stopMic = useCallback(() => {
    clearTimeout(restartRef.current);
    try { recRef.current?.abort(); } catch {}
    recRef.current = null;
  }, []);

  const scheduleRestart = useCallback((ms = 350) => {
    clearTimeout(restartRef.current);
    restartRef.current = setTimeout(() => {
      if (onRef.current && statusRef.current === S.IDLE) startMicFn.current?.();
    }, ms);
  }, []);

  const speakText = useCallback((text, onDone) => {
    if (!text?.trim()) { onDone?.(); return; }

    const synth = window.speechSynthesis;
    if (!synth) { onDone?.(); return; }

    const utt = new SpeechSynthesisUtterance(text);
    utt.lang   = SPEECH_LOCALE[langRef.current] || 'tr-TR';
    utt.rate   = 1.25;
    utt.volume = 1;

    let done = false;
    const finish = () => { if (done) return; done = true; onDone?.(); };
    const safety = setTimeout(finish, Math.max(6000, text.length * 80));

    utt.onend   = () => { clearTimeout(safety); finish(); };
    utt.onerror = () => { clearTimeout(safety); finish(); };

    const go = () => {
      const voices = synth.getVoices();
      const v = pickVoice(voices, utt.lang) || voices[0] || null;
      if (v) utt.voice = v;
      try { synth.speak(utt); } catch { clearTimeout(safety); finish(); }
    };

    if (synth.getVoices().length) {
      go();
    } else {
      let fired = false;
      const onVC = () => {
        if (fired) return;
        fired = true;
        synth.removeEventListener('voiceschanged', onVC);
        go();
      };
      synth.addEventListener('voiceschanged', onVC);
      setTimeout(() => { if (!fired) { fired = true; synth.removeEventListener('voiceschanged', onVC); go(); } }, 1000);
    }
  }, []);

  startMicFn.current = () => {
    if (!SR || !onRef.current || statusRef.current !== S.IDLE) return;
    stopMic();

    const rec = new SR();
    rec.lang            = SPEECH_LOCALE[langRef.current] || 'tr-TR';
    rec.continuous      = false;
    rec.interimResults  = false;
    rec.maxAlternatives = 2;
    recRef.current = rec;

    rec.onresult = async (e) => {
      const text = e.results[0]?.[0]?.transcript?.trim() || '';
      recRef.current = null;

      if (!text) { setStatus(S.IDLE); scheduleRestart(250); return; }

      setStatus(S.THINKING);

      try {
        const result = await processVoiceCommand(text, {
          ...ctxRef.current,
          page: pageRef.current,
          lang: langRef.current,
          user: userRef.current?.userCode || null,
        });

        const actionList = Array.isArray(result.actions) ? result.actions : [];
        // Ordered, schema-validated plan (see voiceAssistantEngine.js /
        // voiceIntentSchema.js) -- executePlan stops a multi-step command
        // as soon as a critical step (analysis, quantum, navigation, ...)
        // fails, instead of continuing to run later steps against a state
        // the failed step never reached.
        executePlan(actionList);

        if (result.speak?.trim()) {
          setStatus(S.SPEAKING);
          speakText(result.speak, () => {
            setStatus(S.IDLE);
            scheduleRestart(400);
          });
        } else {
          setStatus(S.IDLE);
          scheduleRestart(300);
        }
      } catch {
        setStatus(S.IDLE);
        scheduleRestart(500);
      }
    };

    rec.onerror = (ev) => {
      if (recRef.current === rec) recRef.current = null;
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        console.warn('[VoiceAssistant] Recognition error:', ev.error);
      }
      setStatus(S.IDLE);
      scheduleRestart(ev.error === 'no-speech' ? 200 : 700);
    };

    rec.onend = () => {
      if (recRef.current === rec) recRef.current = null;
      if (statusRef.current === S.LISTENING) { setStatus(S.IDLE); scheduleRestart(300); }
    };

    try {
      rec.start();
      setStatus(S.LISTENING);
    } catch {
      recRef.current = null;
      scheduleRestart(800);
    }
  };

  useEffect(() => {
    const pause = () => {
      stopMic();
      clearTimeout(restartRef.current);
      restartRef.current = setTimeout(() => {
        if (onRef.current) { setStatus(S.IDLE); scheduleRestart(300); }
      }, 30000);
    };
    const resume = () => {
      clearTimeout(restartRef.current);
      if (onRef.current && statusRef.current === S.IDLE) scheduleRestart(300);
    };
    window.addEventListener('aq:pause', pause);
    window.addEventListener('aq:resume', resume);
    return () => {
      window.removeEventListener('aq:pause', pause);
      window.removeEventListener('aq:resume', resume);
    };
  }, [stopMic, scheduleRestart]);

  useEffect(() => {
    if (on) {
      setStatus(S.IDLE);
      scheduleRestart(200);
    } else {
      stopMic();
      clearTimeout(restartRef.current);
      try { window.speechSynthesis?.cancel(); } catch {}
      setStatus(S.IDLE);
    }
    return () => { stopMic(); clearTimeout(restartRef.current); };
  }, [on, lang, stopMic, scheduleRestart]);

  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        const { onDragMove, onDragEnd } = dragListenersRef.current;
        window.removeEventListener('mousemove', onDragMove);
        window.removeEventListener('mouseup', onDragEnd);
        window.removeEventListener('touchmove', onDragMove);
        window.removeEventListener('touchend', onDragEnd);
        dragListenersRef.current = null;
      }
    };
  }, []);

  if (!SR) return null;

  const onDragStart = (e) => {
    const p = e.touches ? e.touches[0] : e;
    dragRef.current = { dragging: true, moved: false, sx: p.clientX, sy: p.clientY, px: pos.x, py: pos.y };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('touchend', onDragEnd);
    dragListenersRef.current = { onDragMove, onDragEnd };
  };
  const onDragMove = (e) => {
    if (!dragRef.current.dragging) return;
    const p = e.touches ? e.touches[0] : e;
    if (e.cancelable) e.preventDefault();
    const dx = p.clientX - dragRef.current.sx;
    const dy = p.clientY - dragRef.current.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragRef.current.moved = true;
    const nx = Math.max(8, dragRef.current.px + dx);
    const ny = Math.max(8, dragRef.current.py - dy);
    setPos({ x: nx, y: ny });
  };
  const onDragEnd = () => {
    if (dragRef.current.moved) {
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 250);
    }
    dragRef.current.dragging = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('touchmove', onDragMove);
    window.removeEventListener('touchend', onDragEnd);
    dragListenersRef.current = null;
  };

  const dot = {
    [S.LISTENING]: 'bg-emerald-400',
    [S.THINKING]:  'bg-amber-400',
    [S.SPEAKING]:  'bg-gold',
    [S.IDLE]:      'bg-gold/25',
  }[status];

  const statusText = {
    [S.LISTENING]: translate(lang, 'voiceStatusListening'),
    [S.THINKING]:  translate(lang, 'voiceStatusThinking'),
    [S.SPEAKING]:  translate(lang, 'voiceStatusSpeaking'),
    [S.IDLE]:      translate(lang, 'voiceStatusWaiting'),
  }[status];

  return (
    <>
      <div className="fixed z-50 flex flex-col gap-2 items-start" style={{ left: `${pos.x}px`, bottom: `calc(${pos.y}px + env(safe-area-inset-bottom, 0px))` }}>
        <AnimatePresence>
          {on && (
            <motion.div key="status"
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
              className="bqi-assistant-label flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-mono tracking-wider border-red-300/45 text-red-100 bg-[linear-gradient(135deg,rgba(168,22,56,0.85),rgba(112,6,30,0.85))] backdrop-blur shadow-[0_6px_16px_rgba(140,0,28,0.45)]">
              <motion.span className={`w-1.5 h-1.5 rounded-full ${dot}`}
                animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />
              {statusText}
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onMouseDown={onDragStart}
          onTouchStart={onDragStart}
          onClick={() => {
            if (dragRef.current.moved || suppressClickRef.current) return;
            if (!on && window.speechSynthesis) {
              const warmup = new SpeechSynthesisUtterance(' ');
              warmup.volume = 0;
              window.speechSynthesis.speak(warmup);
              setTimeout(() => { try { window.speechSynthesis.cancel(); } catch {} }, 200);
            }
            setOn(o => !o);
          }}
          className={`bqi-assistant-label flex items-center gap-2 px-3.5 py-2 rounded-2xl text-xs font-mono tracking-wider transition-all shadow-[0_8px_24px_rgba(0,0,0,0.4)] ${
            on
              ? 'btn-emergency emergency-pulse text-white border-red-300'
              : 'btn-emergency text-white/85 border-red-400/70 opacity-90 hover:opacity-100'
          }`}>
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold ${on ? 'bg-white/20 text-white' : 'bg-black/25 text-white'}`}>Q</span>
          {on
            ? (status === S.THINKING
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Mic className="w-3 h-3" />)
            : <MicOff className="w-3 h-3" />}
          {on ? translate(lang, 'voiceAssistantOnLabel') : translate(lang, 'voiceAssistantOffLabel')}
        </button>
      </div>
    </>
  );
}
