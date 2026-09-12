import React from 'react';
import { motion } from 'framer-motion';

// Kept under the existing component name so every loading/menu surface uses
// one brand mark without changing application flow or call sites.
export default function QuantumLogo({ size = 'md' }) {
  const pixels = size === 'lg' ? 112 : size === 'sm' ? 40 : 52;

  return (
    <motion.div
      animate={{
        scale: [0.98, 1.04, 0.98],
        filter: [
          'drop-shadow(0 0 5px rgba(34,211,238,.35))',
          'drop-shadow(0 0 13px rgba(34,211,238,.7))',
          'drop-shadow(0 0 5px rgba(34,211,238,.35))',
        ],
      }}
      transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
      style={{ width: pixels, height: pixels, position: 'relative', flexShrink: 0 }}
      aria-label="BQI"
    >
      <motion.span
        aria-hidden="true"
        className="absolute inset-[4%] rounded-full border border-cyan-200/30"
        animate={{ rotate: 360 }}
        transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
      >
        <span className="absolute left-1/2 -top-[2px] w-1 h-1 -translate-x-1/2 rounded-full bg-cyan-100 shadow-[0_0_6px_#67e8f9]" />
      </motion.span>
      <img src="/bqi-logo.png" alt="BQI" className="relative z-10 w-full h-full object-contain" />
    </motion.div>
  );
}
