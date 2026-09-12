import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Wifi, Cpu } from 'lucide-react';
import { useLang } from '../services/langContext.jsx';
import { localeFor } from '../services/i18n.js';

// Split out of LoginPage.jsx: purely decorative/presentational pieces of
// the boot screen (background, logo animation, boot text, status bar) that
// take no closures over LoginPage's own state -- only props/hooks of their
// own -- so they don't need to live alongside the login form logic.

const BOOT_LINES_BY_LANG = {
  en: [
    { text: 'QUANTUM PROCESSING UNIT..............', result: '[ ACTIVE ]', delay: 0 },
    { text: 'ENCRYPTION PROTOCOL (AES-256)........', result: '[ LOADED ]', delay: 320 },
    { text: 'SATELLITE LINK GEO-3.................', result: '[ STRONG ]', delay: 620 },
    { text: 'IDENTITY VERIFICATION MODULE.........', result: '[ READY ]',  delay: 900 },
  ],
  tr: [
    { text: 'KUANTUM İŞLEM BİRİMİ.................', result: '[ AKTİF ]', delay: 0 },
    { text: 'ŞİFRELEME PROTOKOLü (AES-256)......', result: '[ YÜKLÜ ]', delay: 320 },
    { text: 'UYDU BAĞLANTISI GEO-3...............', result: '[ GÜÇLÜ ]', delay: 620 },
    { text: 'KİMLİK DOĞRULAMA MODÜLü.............', result: '[ HAZIR ]', delay: 900 },
  ],
  de: [
    { text: 'QUANTENVERARBEITUNGSEINHEIT..........', result: '[ AKTIV ]', delay: 0 },
    { text: 'VERSCHLÜSSELUNGSPROTOKOLL (AES-256)..', result: '[ GELADEN ]', delay: 320 },
    { text: 'SATELLITENVERBINDUNG GEO-3...........', result: '[ STARK ]', delay: 620 },
    { text: 'IDENTITÄTSPRÜFUNGSMODUL..............', result: '[ BEREIT ]', delay: 900 },
  ],
  fr: [
    { text: 'UNITÉ DE TRAITEMENT QUANTIQUE........', result: '[ ACTIF ]', delay: 0 },
    { text: 'PROTOCOLE DE CHIFFREMENT (AES-256)...', result: '[ CHARGÉ ]', delay: 320 },
    { text: 'LIAISON SATELLITE GEO-3..............', result: '[ FORTE ]', delay: 620 },
    { text: 'MODULE DE VÉRIFICATION D\'IDENTITÉ....', result: '[ PRÊT ]', delay: 900 },
  ],
  ar: [
    { text: 'وحدة المعالجة الكمية.................', result: '[ نشط ]', delay: 0 },
    { text: 'بروتوكول التشفير (AES-256)...........', result: '[ محمّل ]', delay: 320 },
    { text: 'الرابط الساتلي GEO-3..................', result: '[ قوي ]', delay: 620 },
    { text: 'وحدة التحقق من الهوية.................', result: '[ جاهز ]', delay: 900 },
  ],
};
const getBootLines = (lang) => BOOT_LINES_BY_LANG[lang] || BOOT_LINES_BY_LANG.tr;

// ─── Corner bracket ──────────────────────────────────────────────────────
export function Corner({ pos }) {
  const cls = {
    tl: 'top-3 left-3 border-t-2 border-l-2 origin-top-left',
    tr: 'top-3 right-3 border-t-2 border-r-2 origin-top-right',
    bl: 'bottom-3 left-3 border-b-2 border-l-2 origin-bottom-left',
    br: 'bottom-3 right-3 border-b-2 border-r-2 origin-bottom-right',
  }[pos];
  return (
    <motion.div
      initial={{ scale: 0 }} animate={{ scale: 1 }}
      transition={{ duration: 0.4, delay: 0.1, ease: 'easeOut' }}
      className={`fixed z-20 w-8 h-8 sm:w-14 sm:h-14 border-cyan-400/50 pointer-events-none ${cls}`}
    />
  );
}

// ─── Animated grid background ────────────────────────────────────────────
export function GridBackground() {
  return (
    <>
      {/* Deep space color */}
      <div className="fixed inset-0 bg-[#010812]" />
      {/* Grid lines */}
      <div className="fixed inset-0" style={{
        backgroundImage: `
          linear-gradient(rgba(0,212,255,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0,212,255,0.04) 1px, transparent 1px)
        `,
        backgroundSize: '48px 48px',
      }} />
      {/* Center glow */}
      <div className="fixed inset-0" style={{
        background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(0,100,180,0.08) 0%, transparent 70%)',
      }} />
      {/* Scan line */}
      <div className="fixed inset-0 pointer-events-none" style={{
        background: 'repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)',
      }} />
      {/* Stars */}
      <Stars />
    </>
  );
}

function Stars() {
  const stars = useRef(
    Array.from({ length: 80 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 1.5 + 0.5,
      delay: Math.random() * 4,
      dur: 2.5 + Math.random() * 3,
    }))
  ).current;

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {stars.map(s => (
        <motion.div key={s.id}
          className="absolute rounded-full bg-white"
          style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.size, height: s.size }}
          animate={{ opacity: [0.1, 0.8, 0.1] }}
          transition={{ duration: s.dur, repeat: Infinity, delay: s.delay }}
        />
      ))}
    </div>
  );
}

// ─── Orbital Logo ────────────────────────────────────────────────────────
export function OrbitalLogo() {
  return (
    <motion.div
      animate={{ scale: [0.985, 1.02, 0.985], filter: ['brightness(.94)', 'brightness(1.08)', 'brightness(.94)'] }}
      transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
      className="relative w-36 h-36 sm:w-44 sm:h-44 mx-auto -mb-2"
    >
      <img
        src="/bqi-logo.png"
        alt="BQI"
        className="absolute inset-0 w-full h-full object-contain"
        style={{ filter: 'drop-shadow(0 0 18px rgba(0,212,255,.32))' }}
      />
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
        className="absolute inset-[17%] rounded-full border border-cyan-300/35 pointer-events-none"
        style={{ transform: 'rotate(20deg) scaleY(.58)' }}
      />
      <motion.div
        animate={{ rotate: -360 }}
        transition={{ duration: 12, repeat: Infinity, ease: 'linear' }}
        className="absolute inset-[18%] rounded-full border border-cyan-100/25 pointer-events-none"
        style={{ transform: 'rotate(105deg) scaleY(.48)' }}
      />
    </motion.div>
  );
}

// ─── Boot sequence text ──────────────────────────────────────────────────
export function BootSequence({ onDone, lang }) {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    const BOOT_LINES = getBootLines(lang);
    BOOT_LINES.forEach((line, i) => {
      setTimeout(() => {
        setLines(prev => [...prev, line]);
        if (i === BOOT_LINES.length - 1) setTimeout(onDone, 300);
      }, line.delay);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="font-serif text-xs sm:text-sm text-left space-y-1 mb-6 px-2">
      {lines.map((line, i) => (
        <motion.div key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
          className="flex items-center gap-1 text-cyan-300/90">
          <span className="text-cyan-100/70">&gt;</span>
          <span>{line.text}</span>
          <span className="text-emerald-400/80 tracking-widest">{line.result}</span>
        </motion.div>
      ))}
    </div>
  );
}

// ─── Status bar (bottom) ─────────────────────────────────────────────────
export function StatusBar() {
  const { t, lang } = useLang();
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }}
      className="border-t border-cyan-500/20 bg-[#010812]/80 backdrop-blur px-3 sm:px-5 py-0.5 flex items-center justify-between gap-2 min-h-6">
      <div className="flex items-center gap-2 sm:gap-3 text-[10px] sm:text-xs leading-none font-serif">
        <span className="flex items-center gap-1 text-emerald-400/80">
          <motion.span className="w-1.5 h-1.5 rounded-full bg-emerald-400"
            animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />
          {t('statusSystemActive')}
        </span>
        <span className="hidden sm:flex items-center gap-1 text-cyan-300/90">
          <Wifi className="w-3 h-3" /> {t('statusSecureChannel')}
        </span>
        <span className="hidden sm:flex items-center gap-1 text-cyan-300/90">
          <Cpu className="w-3 h-3" /> {t('statusQuantumUnitOk')}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px] sm:text-xs leading-none font-serif text-cyan-100/60">
        <span className="hidden sm:inline">BQI v{__APP_VERSION__}</span>
        <span className="text-cyan-300/80">{time.toLocaleTimeString(localeFor(lang))}</span>
      </div>
    </motion.div>
  );
}
