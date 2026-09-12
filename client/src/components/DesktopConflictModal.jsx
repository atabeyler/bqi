import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Laptop, Cloud } from 'lucide-react';
import { isNativeApp, nativeSync } from '../services/nativeBridge.js';
import { t } from '../services/i18n.js';

const POLL_MS = 15000;

function VersionCard({ icon: Icon, label, payload, deleted, accent, lang }) {
  return (
    <div className={`flex-1 border rounded-lg p-3 ${accent}`}>
      <div className="flex items-center gap-1.5 mb-2 text-xs tracking-widest uppercase opacity-80">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      {deleted ? (
        <p className="text-xs italic opacity-70">{t(lang, 'syncConflictDeletedText')}</p>
      ) : (
        <>
          <div className="text-sm font-display mb-1 truncate">{payload?.title || t(lang, 'syncConflictUntitled')}</div>
          <p className="text-xs opacity-70 line-clamp-3">{(payload?.content || '').slice(0, 220)}</p>
        </>
      )}
    </div>
  );
}

// Native-app-only: surfaces unresolved sync conflicts (two devices edited
// the same offline record) and lets the user pick a side instead of
// anything being silently overwritten -- backed by desktop/sync/conflict.js
// / client/src/mobile/sync/conflict.js's listConflicts/resolveConflict.
// Covers both Electron and Capacitor/Android (see services/nativeBridge.js);
// renders nothing on the web build or when there is nothing to resolve.
export default function DesktopConflictModal({ lang = 'tr' } = {}) {
  const [conflicts, setConflicts] = useState([]);
  const [resolving, setResolving] = useState(null);

  const refresh = useCallback(() => {
    if (!isNativeApp) return;
    nativeSync.listConflicts().then((rows) => setConflicts(rows || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isNativeApp) return undefined;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const resolve = async (conflictId, resolution) => {
    setResolving(conflictId);
    try {
      await nativeSync.resolveConflict(conflictId, resolution);
      refresh();
    } finally {
      setResolving(null);
    }
  };

  if (!isNativeApp || conflicts.length === 0) return null;
  const current = conflicts[0];

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-[95] bg-black/80 backdrop-blur p-4 flex items-center justify-center">
        <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-navy-light gold-glow-strong rounded-lg max-w-2xl w-full p-5">
          <div className="flex items-center gap-2 mb-1 text-gold">
            <AlertTriangle className="w-5 h-5" />
            <h3 className="font-display tracking-wide">{t(lang, 'syncConflictTitle')}</h3>
          </div>
          <p className="text-xs text-gold/60 mb-4">
            {t(lang, 'syncConflictBody')}
            {conflicts.length > 1 ? t(lang, 'syncConflictMultiSuffix').replace('{count}', conflicts.length) : ''}.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <VersionCard icon={Laptop} label={t(lang, 'syncConflictLocalLabel')} payload={current.localPayload} accent="border-cyan-400/40 bg-cyan-950/20 text-cyan-100" lang={lang} />
            <VersionCard icon={Cloud} label={t(lang, 'syncConflictCloudLabel')} payload={current.serverPayload} deleted={current.serverDeleted} accent="border-gold/40 bg-gold/5 text-gold" lang={lang} />
          </div>

          <div className="flex justify-end gap-2">
            <button
              disabled={resolving === current.id}
              onClick={() => resolve(current.id, 'kept_local')}
              className="border border-cyan-400/40 text-cyan-200 px-4 py-2 rounded text-xs tracking-widest hover:bg-cyan-400/10 disabled:opacity-50"
            >
              {t(lang, 'syncConflictUseLocal')}
            </button>
            <button
              disabled={resolving === current.id}
              onClick={() => resolve(current.id, 'kept_server')}
              className="btn-gold px-4 py-2 rounded text-xs tracking-widest disabled:opacity-50"
            >
              {t(lang, 'syncConflictUseCloud')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
