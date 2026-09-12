import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export const SPLASH_DISPLAY_MS = 3000;

// Shown briefly when the app is launched as an installed PWA (home screen /
// desktop icon) -- the icon itself can't animate (OS-level icons are static
// PNGs), so this reproduces the in-app animated logo full-screen for a
// moment right after launch instead.
export default function SplashScreen({
  logoSrc = '/bqi-logo.png',
  acronym = 'BQI',
  fullName = 'BOLD QUANTUM INTELLIGENCE',
  displayMs = SPLASH_DISPLAY_MS,
  onComplete,
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, displayMs);
    return () => clearTimeout(t);
  }, [displayMs, onComplete]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#060b16] overflow-hidden"
        >
          <motion.div
            className="absolute w-[23rem] h-[23rem] sm:w-[30rem] sm:h-[30rem] rounded-full border border-cyan-300/10"
            animate={{ rotate: 360 }}
            transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
          >
            <span className="absolute left-1/2 -top-1.5 w-3 h-3 -translate-x-1/2 rounded-full bg-cyan-200 shadow-[0_0_18px_#67e8f9]" />
            <span className="absolute top-1/2 -right-1.5 w-2.5 h-2.5 -translate-y-1/2 rounded-full bg-cyan-400 shadow-[0_0_16px_#22d3ee]" />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: [0.98, 1.04, 0.98] }}
            transition={{ opacity: { duration: 0.45 }, scale: { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } }}
            className="relative w-48 h-48 sm:w-60 sm:h-60"
          >
            <div className="absolute inset-4 rounded-full bg-cyan-400/10 blur-3xl" />
            <img src={logoSrc} alt={acronym} className="relative w-full h-full object-contain drop-shadow-[0_0_28px_rgba(34,211,238,.45)]" />
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="relative text-center -mt-2"
          >
            <div className="font-display text-cyan-50 text-2xl sm:text-3xl tracking-[0.34em] pl-[0.34em] uppercase">
              {acronym}
            </div>
            <div lang="en" className="font-display text-cyan-100/70 text-[11px] sm:text-xs tracking-[0.18em] mt-2">
              {fullName}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
