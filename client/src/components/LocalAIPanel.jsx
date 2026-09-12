import React, { useEffect, useState } from 'react';
import { Cpu, Download, Trash2, CircleCheck, CircleAlert } from 'lucide-react';
import { isNativeApp, nativeAI } from '../services/nativeBridge.js';
import { isLocalModeForced, setLocalModeForced, subscribeLocalModePreference } from '../services/localModePreference.js';

// Human-readable byte formatting for RAM/disk/model-size figures shown in
// this panel -- no existing shared helper for this in the codebase (checked),
// so it's local and intentionally simple (GB with one decimal, MB below 1 GB).
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Settings > Local AI: model-manager UI for the local LLM. Desktop
// (Electron, via desktop/localAI/modelManager.js + desktop/main.js's
// ai:model* IPC handlers) and Android (Capacitor, via
// client/src/mobile/localAI/) share the exact same nativeAI surface (see
// services/nativeBridge.js), so this one component drives both.
//
// The shared local-mode preference renders everywhere so browser, Android,
// and desktop expose the same Settings affordance. Plain web still cannot
// download/run the native model, so the model-manager controls remain native
// only.
//
// This is UI-only: it never touches modelManager.js's download/checksum/
// gating logic, only calls the existing IPC/bridge surface.
export default function LocalAIPanel({ t }) {
  const [status, setStatus] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [tiers, setTiers] = useState([]);
  const [selectingTier, setSelectingTier] = useState(false);
  const [forceLocalMode, setForceLocalModeState] = useState(() => isLocalModeForced());

  const refresh = () => {
    if (!isNativeApp) return;
    nativeAI.modelStatus().then((s) => setStatus(s || {})).catch((e) => setError(e?.message || ''));
  };

  useEffect(() => { refresh(); }, []);

  // Loaded once -- the pinned tier list itself never changes at runtime,
  // only which one is currently selected (status.spec, refreshed above).
  useEffect(() => {
    if (!isNativeApp) return;
    // Promise.resolve(...) rather than a bare `?.().then(...)` chain: the
    // underlying bridge call itself can synchronously return undefined
    // (an older/mocked bridge without this method), not just be missing
    // outright, and undefined.then would throw before .catch could ever
    // attach to it.
    Promise.resolve(nativeAI.modelTiers?.()).then((list) => setTiers(list || [])).catch(() => {});
  }, []);

  useEffect(() => subscribeLocalModePreference(setForceLocalModeState), []);

  const toggleLocalMode = () => {
    const next = setLocalModeForced(!forceLocalMode);
    setForceLocalModeState(next);
  };

  // Desktop reports download progress via a separate IPC event (see
  // desktop/preload.cjs's onModelDownloadProgress); Android's bridge takes
  // an onProgress callback directly in modelDownload() below instead (see
  // mobileBridge.js). Subscribing to both here costs nothing on whichever
  // platform doesn't use this path -- desktopAI/mobileAI's `bridge?.`-style
  // guards make the unused one a safe no-op.
  useEffect(() => {
    if (!isNativeApp) return undefined;
    // Android's bridge doesn't expose this listener (progress arrives via
    // the direct callback passed to modelDownload() instead) -- optional
    // so this stays a safe no-op there rather than throwing.
    return nativeAI.onModelDownloadProgress?.(setProgress) || (() => {});
  }, []);

  const handleDownload = async () => {
    setError('');
    setDownloading(true);
    setProgress(null);
    try {
      const result = await nativeAI.modelDownload(setProgress);
      // A user-initiated stop/cancel (see handleStopDownload/
      // handleCancelDownload below) settles this same promise as
      // `{ ok: false, cancelled: true }` -- not an error to show, the
      // panel's own refresh() below already reflects whatever actually
      // landed on disk (paused with partial bytes, or cleanly deleted).
      if (result && result.ok === false && !result.cancelled) {
        setError(result.error || t('localAIDownloadFailed'));
      }
    } catch (e) {
      if (!e?.cancelled) setError(e?.message || t('localAIDownloadFailed'));
    } finally {
      // Refresh on every path, not just success: a failed/aborted attempt
      // (e.g. a dropped connection -- downloadModel() preserves the bytes
      // received so far on disk for the next Range-resumed attempt, see
      // modelManager.js) still leaves real partial bytes behind. Without
      // this, status.partialBytes stays stuck at its pre-attempt value, so
      // the button silently keeps saying "İndir" instead of "Devam Et"
      // even though the next click *does* correctly resume server-side --
      // the label just lied about what was actually about to happen.
      refresh();
      setDownloading(false);
      setProgress(null);
    }
  };

  // "Durdur": pauses the in-flight download. The .download file's bytes so
  // far are kept on disk, so the next click on the (now "Devam Et"-labeled)
  // download button resumes it with HTTP Range instead of starting over.
  const handleStopDownload = async () => {
    setStopping(true);
    try {
      await nativeAI.modelDownloadCancel?.({ deletePartial: false });
    } catch (e) {
      setError(e?.message || t('localAIStopFailed'));
    } finally {
      setStopping(false);
    }
  };

  // "İptal": stops the in-flight download AND deletes whatever partial
  // bytes it had written, leaving a clean not-installed state -- the
  // opposite of "Durdur", which keeps them for a later resume.
  const handleCancelDownload = async () => {
    setError('');
    setCancelling(true);
    try {
      await nativeAI.modelDownloadCancel?.({ deletePartial: true });
    } catch (e) {
      setError(e?.message || t('localAICancelFailed'));
    } finally {
      // While actively downloading, handleDownload's own finally already
      // refreshes once its promise settles from this cancel -- redundant
      // there, but required for the paused ("Devam Et") case: cancelling
      // a download that isn't running has no other pending call whose
      // finally would ever pick up the now-deleted partial file.
      refresh();
      setCancelling(false);
    }
  };

  // Repoints the backend's modelManager at a different pinned tier --
  // setModelTier() itself never downloads or deletes a file (see
  // registry.js's comment), so when a model is already installed this
  // removes it first -- otherwise the old tier's file would sit on disk
  // orphaned (never tracked or cleaned up again) while the panel points at
  // the new tier. Always leaves the panel showing the normal Download
  // button next, pointed at the newly-selected tier's spec.
  const handleSelectTier = async (tier) => {
    if (installed && spec?.id === tier.id) return;
    // A tier button sits right next to the one already selected/installed,
    // in a scrollable list a misclick can easily land in -- unlike the
    // dedicated "Kaldır" (remove) button below, clicking here used to
    // delete the installed model with zero confirmation before repointing
    // at the new tier. The already-installed model is exactly what's at
    // risk of a stray click, so only that case needs a confirm; picking a
    // tier while nothing is installed yet stays a single click, same as
    // before.
    if (installed && !window.confirm(t('localAITierSwitchConfirm'))) return;
    setError('');
    setSelectingTier(true);
    try {
      if (installed) await nativeAI.modelRemove();
      const result = await nativeAI.modelSelectTier(tier.tier);
      if (result && result.ok === false) {
        setError(result.error || t('localAITierSelectFailed'));
      } else {
        refresh();
      }
    } catch (e) {
      setError(e?.message || t('localAITierSelectFailed'));
    } finally {
      setSelectingTier(false);
    }
  };

  const handleRemove = async () => {
    setError('');
    setRemoving(true);
    try {
      await nativeAI.modelRemove();
      refresh();
    } catch (e) {
      setError(e?.message || t('localAIRemoveFailed'));
    } finally {
      setRemoving(false);
    }
  };

  const spec = status?.spec;
  const installed = !!status?.installed;
  const capability = status?.capability;
  const capable = capability ? capability.capable !== false : null;
  const partialBytes = Number(status?.partialBytes) || 0;

  return (
    <div>
      <div className="border border-cyan-300/20 rounded px-2.5 py-2.5 mb-3">
        <button
          onClick={toggleLocalMode}
          className="w-full flex items-center justify-between gap-3 text-left text-[14px] text-cyan-100"
          aria-pressed={forceLocalMode}
        >
          <span>
            <span className="block tracking-[0.16em] uppercase text-gold/70">{t('localAIModeTitle')}</span>
            <span className="block text-[14px] text-cyan-100/60 mt-1">{t(isNativeApp ? 'localAIModeNativeHint' : 'localAIModeWebHint')}</span>
          </span>
          <span className={`shrink-0 rounded border px-2 py-1 text-[11px] tracking-[0.18em] uppercase ${forceLocalMode ? 'border-emerald-300/40 text-emerald-200 bg-emerald-400/10' : 'border-cyan-300/20 text-cyan-100/50'}`}>
            {forceLocalMode ? t('localAIModeOn') : t('localAIModeOff')}
          </span>
        </button>
      </div>

      {!isNativeApp && <p className="text-xs text-gold/60 leading-relaxed mb-3">{t('localAIWebUnavailable')}</p>}

      {isNativeApp && (
        <>
      <p className="text-xs text-gold/60 leading-relaxed mb-3">{t('localAIIntro')}</p>

      {status === null && <p className="text-xs text-cyan-100/50">{t('localAIChecking')}</p>}

      {status !== null && (
        <div className="border border-cyan-300/20 rounded px-2.5 py-2.5 mb-3">
          <div className="flex items-center gap-2">
            {installed ? <CircleCheck className="w-4 h-4 text-emerald-300/80 shrink-0" /> : <CircleAlert className="w-4 h-4 text-amber-300/80 shrink-0" />}
            <span className="text-xs text-cyan-100">{installed ? t('localAIInstalled') : t('localAINotInstalled')}</span>
          </div>
          {spec && (
            <div className="text-[14px] text-cyan-300/50 pl-6 mt-0.5">
              {spec.displayLabel || spec.label} · {formatBytes(spec.sizeBytes)}
              {/* Not-installed state: this line names whichever tier is
                  currently selected/targeted -- what İndir would fetch --
                  not something already on disk. Without this qualifier it
                  reads as if the model were already installed. */}
              {!installed && <span className="text-cyan-300/30"> ({t('localAITargetModelHint')})</span>}
            </div>
          )}
          {!installed && partialBytes > 0 && spec && (
            <div className="text-[14px] text-amber-300/70 pl-6 mt-1">{t('localAIPartialDownload')}: {formatBytes(partialBytes)} / {formatBytes(spec.sizeBytes)}</div>
          )}
        </div>
      )}

      {capability && (
        <div className="border border-cyan-300/20 rounded px-2.5 py-2.5 mb-3">
          <div className="text-xs tracking-[0.18em] uppercase text-gold/60 mb-1.5 flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5" />{t('localAIDeviceInfo')}
          </div>
          <div className="text-[14px] text-cyan-100/70 space-y-0.5">
            <div>{t('localAIRamLabel')}: {formatBytes(capability.totalMemBytes)}</div>
            {typeof capability.freeDiskBytes === 'number' && <div>{t('localAIDiskLabel')}: {formatBytes(capability.freeDiskBytes)}</div>}
            {typeof capability.cpuCount === 'number' && <div>{t('localAICpuLabel')}: {capability.cpuCount}</div>}
          </div>
          {capable === false && <p className="text-[14px] text-amber-300/80 mt-1.5 leading-relaxed">{t('localAINotCapable')}</p>}
        </div>
      )}

      {error && <p className="text-[14px] text-red-300 mb-2 leading-relaxed">{error}</p>}

      {downloading && (
        <p className="text-[14px] text-cyan-300/70 mb-2">
          {progress && progress.total ? `${t('localAIDownloading')} (${formatBytes(progress.received)} / ${formatBytes(progress.total)})` : t('localAIDownloading')}
        </p>
      )}

      {/* Always offered, installed or not, so the user can see and switch
          to a different tier at any time (e.g. after an update changes
          what's recommended for their device). Picking a different tier
          while one is installed removes it first (see handleSelectTier)
          before repointing at the new one. */}
      {tiers.length > 0 && (
        <div className="border border-cyan-300/20 rounded px-2.5 py-2.5 mb-3">
          <div className="text-xs tracking-[0.18em] uppercase text-gold/60 mb-1.5">{t('localAITierPickerTitle')}</div>
          <div className="space-y-1.5">
            {tiers.map((tier) => {
              const selected = spec?.id === tier.id;
              return (
                <button
                  key={tier.tier}
                  onClick={() => handleSelectTier(tier)}
                  disabled={selectingTier || downloading || removing || (installed && selected)}
                  aria-pressed={selected}
                  className={`w-full flex items-center justify-between gap-2 text-left text-[14px] rounded border px-2.5 py-2 disabled:opacity-40 ${
                    selected ? 'border-cyan-300/50 text-cyan-100 bg-cyan-400/10' : 'border-cyan-300/20 text-cyan-100/70'
                  }`}
                >
                  <span>{tier.displayLabel || tier.label}</span>
                  <span className="text-[14px] text-cyan-300/50 shrink-0">{formatBytes(tier.sizeBytes)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {!installed && !downloading && partialBytes === 0 && (
          <button
            onClick={handleDownload}
            className="w-full flex items-center justify-center gap-2 text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2 disabled:opacity-40"
          >
            <Download className="w-4 h-4" />
            {t('localAIDownloadButton')}
          </button>
        )}
        {/* Paused (partial bytes on disk, nothing actively downloading):
            offer both continuing it and giving up on it outright, not just
            "Devam Et" -- walking away used to require resuming first just
            to have something to cancel. */}
        {!installed && !downloading && partialBytes > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleDownload}
              className="flex items-center justify-center gap-2 text-[14px] border border-cyan-300/30 text-cyan-100 rounded px-2.5 py-2 disabled:opacity-40"
            >
              <Download className="w-4 h-4" />
              {t('localAIResumeButton')}
            </button>
            <button
              onClick={handleCancelDownload}
              disabled={cancelling}
              className="flex items-center justify-center gap-2 text-[14px] border border-red-400/30 text-red-200 rounded px-2.5 py-2 disabled:opacity-40"
            >
              {cancelling ? t('localAICancelling') : t('localAICancelButton')}
            </button>
          </div>
        )}
        {!installed && downloading && (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleStopDownload}
              disabled={stopping || cancelling}
              className="flex items-center justify-center gap-2 text-[14px] border border-amber-300/30 text-amber-200 rounded px-2.5 py-2 disabled:opacity-40"
            >
              {stopping ? t('localAIStopping') : t('localAIStopButton')}
            </button>
            <button
              onClick={handleCancelDownload}
              disabled={stopping || cancelling}
              className="flex items-center justify-center gap-2 text-[14px] border border-red-400/30 text-red-200 rounded px-2.5 py-2 disabled:opacity-40"
            >
              {cancelling ? t('localAICancelling') : t('localAICancelButton')}
            </button>
          </div>
        )}
        {installed && (
          <button
            onClick={handleRemove}
            disabled={removing}
            className="w-full flex items-center justify-center gap-2 text-[14px] border border-red-400/30 text-red-200 rounded px-2.5 py-2 disabled:opacity-40"
          >
            <Trash2 className="w-4 h-4" />
            {removing ? t('localAIRemoving') : t('localAIRemoveButton')}
          </button>
        )}
      </div>
        </>
      )}
    </div>
  );
}
