import { useId } from 'react';
import { motion } from 'framer-motion';

// Radar-globe hologram: concentric range rings + radial spokes + tilted
// "meridian" ellipses (globe latitude lines, same technique as
// LoginPageDecor's OrbitalLogo) converging on a pulsing center light, with
// an independently rotating scan sweep on top -- three separate motion
// layers (rings+spokes, sweep, pulse) so the animation reads clearly even
// in a static screenshot. Shared between AnalysisWizard's status column and
// LoginPage's "holographic & cyber" theme rather than duplicated.
const RADAR_SPOKE_ANGLES = Array.from({ length: 12 }, (_, i) => i * 30);

export default function HologramSphere({ className = '' }) {
  const filterId = useId();
  return (
    <div className={`relative w-full aspect-square flex items-center justify-center ${className}`}>
      <div className="absolute inset-0 rounded-full opacity-80" style={{ background: 'radial-gradient(circle, rgba(0,180,255,0.22) 0%, transparent 68%)' }} />

      <motion.svg viewBox="0 0 144 144" className="absolute inset-2 w-[calc(100%-16px)] h-[calc(100%-16px)]"
        animate={{ rotate: 360 }} transition={{ duration: 20, repeat: Infinity, ease: 'linear' }} style={{ transformOrigin: '72px 72px' }}>
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g filter={`url(#${filterId})`} stroke="rgba(56,214,255,0.5)" fill="none">
          <circle cx="72" cy="72" r="64" strokeWidth="0.6" />
          <circle cx="72" cy="72" r="44" strokeWidth="0.5" strokeDasharray="2 3" />
          <circle cx="72" cy="72" r="24" strokeWidth="0.5" strokeDasharray="2 3" />
          <ellipse cx="72" cy="72" rx="64" ry="20" strokeWidth="0.5" transform="rotate(60 72 72)" />
          <ellipse cx="72" cy="72" rx="64" ry="20" strokeWidth="0.5" transform="rotate(-60 72 72)" />
          {RADAR_SPOKE_ANGLES.map((deg) => {
            const rad = (deg * Math.PI) / 180;
            return <line key={deg} x1="72" y1="72" x2={72 + 64 * Math.cos(rad)} y2={72 + 64 * Math.sin(rad)} strokeWidth="0.4" opacity="0.5" />;
          })}
        </g>
      </motion.svg>

      {/* Scan sweep, counter-rotating at a different speed for a layered radar feel */}
      <motion.div animate={{ rotate: -360 }} transition={{ duration: 5, repeat: Infinity, ease: 'linear' }} className="absolute inset-4 rounded-full"
        style={{ background: 'conic-gradient(from 0deg, transparent 82%, rgba(120,235,255,0.35) 100%)' }} />
      <motion.div
        animate={{ opacity: [0.6, 1, 0.6], scale: [1, 1.35, 1] }}
        transition={{ duration: 1.8, repeat: Infinity }}
        className="absolute w-3 h-3 rounded-full bg-cyan-200"
        style={{ boxShadow: '0 0 16px 5px rgba(120,235,255,0.85)' }}
      />
    </div>
  );
}
