import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, MapPin, Radar, User } from 'lucide-react';
import { getSocket } from '../services/socket.js';
import { useLang } from '../services/langContext.jsx';
import { t as translate } from '../services/i18n.js';
import { registerActions, unregisterActions } from '../services/voiceActionRegistry.js';

const TR_BOUNDS = { minLat: 35.8, maxLat: 42.1, minLng: 25.6, maxLng: 44.8 };

function latLngToPercent(lat, lng) {
  const x = ((lng - TR_BOUNDS.minLng) / (TR_BOUNDS.maxLng - TR_BOUNDS.minLng)) * 100;
  const y = ((TR_BOUNDS.maxLat - lat) / (TR_BOUNDS.maxLat - TR_BOUNDS.minLat)) * 100;
  return { x: Math.max(2, Math.min(98, x)), y: Math.max(2, Math.min(98, y)) };
}

function formatCoord(val, posLabel, negLabel) {
  return `${Math.abs(val).toFixed(4)}° ${val >= 0 ? posLabel : negLabel}`;
}

// ─── Button only ─────────────────────────────────────────────────────────
export default function PersonnelRadar({ isAdmin, onOpen }) {
  const { t } = useLang();

  useEffect(() => {
    if (!isAdmin) return;
    registerActions('personnel-radar', [
      { name: 'open_radar',  description: 'Open personnel radar / personel radarını aç',  params: {}, handler: () => onOpen() },
      { name: 'close_radar', description: 'Close personnel radar / personel radarını kapat', params: {}, handler: () => window.dispatchEvent(new CustomEvent('aq:radar:close')) },
    ]);
    return () => unregisterActions('personnel-radar');
  }, [isAdmin, onOpen]);

  if (!isAdmin) return null;

  return (
    <button
      onClick={onOpen}
      className="btn-depth flex items-center gap-1.5 px-2 sm:px-3 py-1.5 sm:py-2 rounded text-xs tracking-widest font-mono"
      title={t('personnelRadarTooltip')}
    >
      <Radar className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">RADAR</span>
    </button>
  );
}

// ─── Modal — rendered at the DashboardPage level ───────────────────────────
export function RadarModal({ onClose, lang }) {
  const [locations, setLocations] = useState({});
  const [selected, setSelected] = useState(null);
  const sweepRef = useRef(0);
  const [sweep, setSweep] = useState(0);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    sock.emit('locations:request');
    const onUpdate = (data) => setLocations(data || {});
    sock.on('locations:update', onUpdate);
    return () => sock.off('locations:update', onUpdate);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      sweepRef.current = (sweepRef.current + 2) % 360;
      setSweep(sweepRef.current);
    }, 30);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onClose_ = () => onClose();
    window.addEventListener('aq:radar:close', onClose_);
    return () => window.removeEventListener('aq:radar:close', onClose_);
  }, [onClose]);

  const userEntries = Object.entries(locations).filter(([nick]) => nick !== 'BOLD');
  const cx = 50 + 48 * Math.cos((sweep - 90) * Math.PI / 180);
  const cy = 50 + 48 * Math.sin((sweep - 90) * Math.PI / 180);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.94, y: 12 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-[#010812] border border-cyan-500/30 rounded-lg flex flex-col"
        style={{ maxHeight: 'calc(100dvh - 24px)', boxShadow: '0 0 60px rgba(0,200,255,0.15)' }}
      >
        {/* Title */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-cyan-500/20 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Radar className="w-4 h-4 text-cyan-400" />
            <span className="font-mono text-xs sm:text-sm text-cyan-300 tracking-widest uppercase">
              {translate(lang, 'personnelRadarTitle')}
            </span>
            <motion.span animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1.2, repeat: Infinity }}
              className="w-2 h-2 rounded-full bg-emerald-400" />
          </div>
          <button onClick={onClose} className="text-cyan-400/50 hover:text-cyan-300 p-1" aria-label="Kapat">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-col sm:flex-row flex-1 overflow-hidden min-h-0">

          {/* Radar screen */}
          <div className="relative bg-[#000d1a] overflow-hidden flex-shrink-0 w-full sm:w-72 sm:h-auto"
            style={{ height: 'min(70vw, 280px)' }}>

            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
              {[20, 40, 60, 80].map(r => (
                <circle key={r} cx="50" cy="50" r={r / 2} fill="none" stroke="rgba(0,200,255,0.08)" strokeWidth="0.3" />
              ))}
              <line x1="50" y1="2" x2="50" y2="98" stroke="rgba(0,200,255,0.07)" strokeWidth="0.3" />
              <line x1="2" y1="50" x2="98" y2="50" stroke="rgba(0,200,255,0.07)" strokeWidth="0.3" />
              <line x1="50" y1="50" x2={cx} y2={cy} stroke="rgba(0,255,120,0.7)" strokeWidth="0.6" />
              <path d={`M 50 50 L ${cx} ${cy}`} stroke="rgba(0,255,120,0.12)" strokeWidth="10" fill="none" strokeLinecap="round" />
            </svg>

            <span className="absolute top-1.5 left-2 text-[11px] font-mono text-cyan-400/25">TÜRKİYE</span>
            <span className="absolute bottom-1.5 left-2 text-[11px] font-mono text-cyan-400/20">25.6°D</span>
            <span className="absolute bottom-1.5 right-2 text-[11px] font-mono text-cyan-400/20">44.8°D</span>

            {userEntries.map(([nick, loc]) => {
              const { x, y } = latLngToPercent(loc.lat, loc.lng);
              const isSel = selected?.nick === nick;
              return (
                <button key={nick} onClick={() => setSelected(isSel ? null : { nick, ...loc })}
                  className="absolute" style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%,-50%)', zIndex: 10 }}>
                  <motion.div
                    animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                    transition={{ duration: 1.6, repeat: Infinity }}
                    className={`w-3.5 h-3.5 rounded-full border-2 ${isSel ? 'bg-gold border-gold' : 'bg-emerald-400 border-emerald-300'}`}
                    style={{ boxShadow: isSel ? '0 0 12px #bcefff' : '0 0 10px #4ade80' }}
                  />
                  <span className="absolute left-1/2 -translate-x-1/2 -top-4 text-[11px] font-mono text-emerald-300 whitespace-nowrap bg-black/70 px-1 rounded">
                    {nick}
                  </span>
                </button>
              );
            })}

            {userEntries.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="text-xs font-mono text-cyan-400/30 text-center">
                  {translate(lang, 'noUserLocationData')}
                </p>
              </div>
            )}
          </div>

          {/* Right panel */}
          <div className="flex flex-col sm:w-52 border-t sm:border-t-0 sm:border-l border-cyan-500/20 overflow-hidden flex-1 min-h-0">
            <div className="px-3 py-2 border-b border-cyan-500/15 text-xs font-mono text-cyan-400/50 tracking-widest uppercase flex-shrink-0">
              {translate(lang, 'personnelLabel')} ({userEntries.length})
            </div>
            <div className="overflow-y-auto flex-1">
              {userEntries.length === 0 ? (
                <p className="text-xs text-cyan-400/30 font-mono p-3">
                  {translate(lang, 'noActiveUsers')}
                </p>
              ) : userEntries.map(([nick, loc]) => (
                <button key={nick}
                  onClick={() => setSelected(selected?.nick === nick ? null : { nick, ...loc })}
                  className={`w-full text-left px-3 py-2.5 border-b border-cyan-500/10 flex items-center gap-2 transition ${selected?.nick === nick ? 'bg-gold/10' : 'hover:bg-cyan-400/5'}`}>
                  <User className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-gold tracking-wider">{nick}</div>
                    <div className="text-xs text-cyan-400/50 font-mono">{loc.lat.toFixed(2)}°, {loc.lng.toFixed(2)}°</div>
                  </div>
                  <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }}
                    className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                </button>
              ))}
            </div>

            <AnimatePresence>
              {selected && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="border-t border-gold/30 overflow-hidden flex-shrink-0">
                  <div className="p-3 bg-gold/5">
                    <div className="flex items-center gap-1.5 mb-2">
                      <MapPin className="w-3 h-3 text-gold" />
                      <span className="text-xs font-mono text-gold tracking-widest">{selected.nick}</span>
                    </div>
                    <div className="space-y-1 text-xs font-mono text-cyan-300/70">
                      <div>{translate(lang, 'latLabel')}: {formatCoord(selected.lat, 'N', 'S')}</div>
                      <div>{translate(lang, 'lngLabel')}: {formatCoord(selected.lng, 'E', 'W')}</div>
                      <div className="text-cyan-400/40">{translate(lang, 'updatedLabel')}: {new Date(selected.updatedAt).toLocaleTimeString()}</div>
                    </div>
                    <a href={`https://maps.google.com/?q=${selected.lat},${selected.lng}`}
                      target="_blank" rel="noreferrer"
                      className="mt-2 block text-center text-xs font-mono text-cyan-400 hover:text-cyan-200 underline">
                      {translate(lang, 'openInMaps')}
                    </a>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
