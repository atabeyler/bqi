import React, { Suspense, lazy, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, MapPin } from 'lucide-react';
import { api } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';
import VoiceButton from './VoiceButton.jsx';

const WorldGlobe = lazy(() => import('./WorldGlobe.jsx'));

const CITIES = [
  { id: 'istanbul', name: 'İstanbul', lat: 41.0082, lon: 28.9784 },
  { id: 'ankara', name: 'Ankara', lat: 39.9334, lon: 32.8597 },
  { id: 'izmir', name: 'İzmir', lat: 38.4237, lon: 27.1428 },
  { id: 'antalya', name: 'Antalya', lat: 36.8969, lon: 30.7133 },
  { id: 'diyarbakir', name: 'Diyarbakır', lat: 37.9144, lon: 40.2306 },
  { id: 'trabzon', name: 'Trabzon', lat: 41.0027, lon: 39.7168 },
  { id: 'lefkosa', name: 'Lefkoşa (KKTC)', lat: 35.1856, lon: 33.3823 }
];

export default function TurkeyMap() {
  const { t } = useLang();
  const [selectedCity, setSelectedCity] = useState(null);

  return (
    <>
      <div className="relative w-full max-w-6xl mx-auto turkey-map-container" style={{ fontFamily: "'Times New Roman', Times, serif" }}>
        <div className="relative border border-white/20 rounded-lg p-3 sm:p-6 overflow-hidden bg-transparent">
          <div className="relative w-full h-[52vh] min-h-[280px]">
            <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-xs text-gold/50 tracking-widest">{t('loadingGlobe')}</div>}>
              <WorldGlobe cities={CITIES} onSelectCity={setSelectedCity} />
            </Suspense>
          </div>

          <div className="absolute top-3 left-3 flex items-center gap-2 text-[13px] text-white/80 max-w-[55%] truncate">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse shrink-0" />
            <span className="truncate">{t('liveMonitor')} · {new Date().toLocaleTimeString()}</span>
          </div>
          <div className="absolute top-3 right-3 text-[13px] text-white/70 max-w-[40%] truncate text-right">{t('monitorPoints')}</div>
        </div>
      </div>

      <AnimatePresence>
        {selectedCity && <RegionEmergencyModal city={selectedCity} onClose={() => setSelectedCity(null)} />}
      </AnimatePresence>
    </>
  );
}

function RegionEmergencyModal({ city, onClose }) {
  const { t } = useLang();
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!msg.trim()) return;
    setSending(true);
    try {
      await api.emergencyRegion(city.name, msg);
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" style={{ fontFamily: "'Times New Roman', Times, serif" }} onClick={onClose}>
      <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} exit={{ scale: 0.9 }} onClick={(e) => e.stopPropagation()} className="bg-navy-light gold-glow-strong rounded-lg w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-crimson/40 bg-gradient-to-r from-crimson/30 to-transparent">
          <div className="flex items-center gap-3"><MapPin className="text-crimson w-5 h-5" /><h2 className=" text-lg text-gold tracking-widest">{city.name.toUpperCase()}</h2></div>
          <button onClick={onClose} className="text-gold/60 hover:text-gold" aria-label="Kapat"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-6">
          <p className="text-xs text-gold/50 mb-3">{city.name} {t('regionNote')}</p>
          <div className="relative">
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={5}
              placeholder={`${city.name} ${t('regionPh')}`}
              className="w-full bg-navy/80 border border-gold/30 rounded p-3 pr-12 text-gold/90 placeholder-gold/30 focus:border-gold focus:outline-none" />
            <div className="absolute bottom-3 right-3">
              <VoiceButton mode="input" size="sm"
                onTranscript={text => setMsg(prev => prev ? prev + ' ' + text : text)} />
            </div>
          </div>
          <button onClick={send} disabled={sending || !msg.trim()} className="mt-4 w-full btn-emergency py-3 rounded tracking-widest text-sm disabled:opacity-50 flex items-center justify-center gap-2">
            <Send className="w-4 h-4" /> {sending ? t('sending') : t('sendAlert')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}


