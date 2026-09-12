import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X, MessageCircle, Users, Lock, Building2 } from 'lucide-react';
import { api } from '../services/api.js';
import VoiceButton from './VoiceButton.jsx';
import FileAttach from './FileAttach.jsx';
import { useLang } from '../services/langContext.jsx';
import ChatPanel from './EmergencyChatPanel.jsx';
import { registerActions, unregisterActions } from '../services/voiceActionRegistry.js';
import { catalogEntry } from '../services/voiceActionCatalog.js';

const PANELS = { CENTER: 'center', USERS: 'users', CHAT: 'chat' };

// Shared with EmergencyChatPanel.jsx's own copy -- small, pure, and used by
// three independent panels (this file's Center/UsersPanel, that file's
// ChatPanel), so duplicating it here is simpler than an import between
// sibling components for six lines.
const buildMessageWithFiles = (text, files) => {
  const note = text || '';
  const attachments = files
    .map((f) => `\n\n[📎 EKLİ DOSYA: ${f.filename}]\n${window.location.origin}${f.url}`)
    .join('');
  return `${note}${attachments}`;
};

export default function EmergencyButton({ authenticated, user }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(PANELS.CENTER);
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const dragRef = useRef({ dragging: false, moved: false, sx: 0, sy: 0, px: 24, py: 24 });

  useEffect(() => {
    const onOpen = (e) => {
      const targetUser = e?.detail?.targetUser;
      const forceChat = !!e?.detail?.forceChat;
      if (targetUser || forceChat) {
        window.dispatchEvent(new CustomEvent('aq:emergency:target-user', { detail: { targetUser } }));
        setPanel(PANELS.CHAT);
      } else {
        setPanel(PANELS.CENTER);
      }
      setOpen(true);
    };
    window.addEventListener('aq:emergency:open', onOpen);
    return () => window.removeEventListener('aq:emergency:open', onOpen);
  }, []);

  // close_emergency (see voiceActionCatalog.js) -- open_emergency is
  // dispatched by dashboardVoiceActions.js as a window event this
  // component already listens for; closing needs its own action because
  // the `open` boolean lives in this component's local state, the same
  // self-registration pattern PersonnelRadar.jsx uses for open/close_radar.
  useEffect(() => {
    registerActions('emergency-button', [
      { name: 'close_emergency', description: catalogEntry('close_emergency')?.description || 'Close the emergency center panel', params: {}, handler: () => setOpen(false) },
    ]);
    return () => unregisterActions('emergency-button');
  }, []);

  const onDragStart = (e) => {
    const p = e.touches ? e.touches[0] : e;
    dragRef.current = { dragging: true, moved: false, sx: p.clientX, sy: p.clientY, px: pos.x, py: pos.y };
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('touchend', onDragEnd);
  };
  const onDragMove = (e) => {
    if (!dragRef.current.dragging) return;
    const p = e.touches ? e.touches[0] : e;
    if (e.cancelable) e.preventDefault();
    const dx = p.clientX - dragRef.current.sx;
    const dy = p.clientY - dragRef.current.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragRef.current.moved = true;
    const nx = Math.max(8, dragRef.current.px - dx);
    const ny = Math.max(8, dragRef.current.py - dy);
    setPos({ x: nx, y: ny });
  };
  const onDragEnd = () => {
    dragRef.current.dragging = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd);
    window.removeEventListener('touchmove', onDragMove);
    window.removeEventListener('touchend', onDragEnd);
  };

  return (
    <>
      <motion.button onMouseDown={onDragStart} onTouchStart={onDragStart} onClick={() => { if (!dragRef.current.moved) setOpen(true); }} className="fixed z-50 emergency-pulse rounded-full" style={{ right: `${pos.x}px`, bottom: `calc(${pos.y}px + env(safe-area-inset-bottom, 0px))` }} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.96 }} aria-label={t('emergencyCenter')}>
        <div className="relative w-8 h-8 sm:w-10 sm:h-10 md:w-14 md:h-14 rounded-full btn-emergency flex items-center justify-center"><AlertTriangle className="w-3 h-3 sm:w-4 sm:h-4 md:w-6 md:h-6 text-white" /></div>
        <div className="absolute -top-7 sm:-top-8 md:-top-9 left-1/2 -translate-x-1/2 text-xs md:text-sm tracking-[0.14em] sm:tracking-[0.2em] text-red-400 font-bold pointer-events-none text-center leading-tight whitespace-pre-line">
          {t('emergencyCenterButton')}
        </div>
      </motion.button>
      <AnimatePresence>{open && <EmergencyModal authenticated={authenticated} user={user} panel={panel} setPanel={setPanel} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  );
}

function EmergencyModal({ authenticated, user, panel, setPanel, onClose }) {
  const { t } = useLang();
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <motion.div initial={{ scale: 0.9, y: 30 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9, y: 30 }} onClick={(e) => e.stopPropagation()} className="bg-navy-light gold-glow-strong rounded-t-2xl sm:rounded-lg w-full max-w-2xl h-[92vh] sm:h-auto sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-crimson/40 bg-gradient-to-r from-crimson/20 to-transparent"><div className="flex items-center gap-3"><AlertTriangle className="text-crimson w-6 h-6" /><h2 className="font-display text-xl text-gold tracking-widest">{t('emergencyCenter')}</h2></div><button onClick={onClose} className="text-gold/60 hover:text-gold p-1" aria-label={t('close')}><X className="w-5 h-5" /></button></div>
        <div className="flex border-b border-gold/20 overflow-x-auto">
          <TabBtn active={panel === PANELS.CENTER} onClick={() => setPanel(PANELS.CENTER)}><Building2 className="w-4 h-4 mr-2" /> {t('reportToCenter')}</TabBtn>
          <TabBtn active={panel === PANELS.USERS} onClick={() => setPanel(PANELS.USERS)}><Users className="w-4 h-4 mr-2" /> {t('reportToUsers')}</TabBtn>
          <TabBtn active={panel === PANELS.CHAT} onClick={() => authenticated && setPanel(PANELS.CHAT)} locked={!authenticated}><MessageCircle className="w-4 h-4 mr-2" /> {t('messaging')} {!authenticated && <Lock className="w-3 h-3 ml-2" />}</TabBtn>
        </div>
        <div className="flex-1 overflow-auto p-3 sm:p-6">{panel === PANELS.CENTER && <CenterPanel />}{panel === PANELS.USERS && <UsersPanel />}{panel === PANELS.CHAT && (authenticated ? <ChatPanel user={user} /> : <LockedPanel />)}</div>
      </motion.div>
    </motion.div>
  );
}

function TabBtn({ children, active, onClick, locked }) { return <button onClick={onClick} disabled={locked} className={`min-w-[130px] sm:min-w-0 flex-1 flex items-center justify-center px-3 sm:px-4 py-3 text-xs sm:text-sm tracking-widest uppercase border-r border-gold/10 transition ${active ? 'bg-gold/10 text-gold border-b-2 border-b-gold' : locked ? 'text-gold/30 cursor-not-allowed' : 'text-gold/60 hover:text-gold hover:bg-gold/5'}`}>{children}</button>; }

function CenterPanel() {
  const { t } = useLang();
  const [msg, setMsg] = useState('');
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const send = async () => {
    if (!msg.trim() && attachedFiles.length === 0) return;
    setSending(true);
    const fullMsg = buildMessageWithFiles(msg, attachedFiles);
    try { await api.emergencyCenter(fullMsg); setDone(true); setMsg(''); setAttachedFiles([]); setTimeout(() => setDone(false), 3000); }
    finally { setSending(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="text-xs text-gold/40 tracking-widest uppercase">{t('attachFileLabel')}</span>
        <FileAttach onFile={(f) => f && setAttachedFiles((prev) => [...prev, f])} compact />
        {attachedFiles.length > 0 && <span className="text-xs text-emerald-400 font-mono">✓ {attachedFiles.length} {t('filesAttached')}</span>}
      </div>
      <div className="relative">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)}
          placeholder={attachedFiles.length > 0 ? t('fileNotePlaceholder') : t('emergencyMsg')} rows={6}
          className="w-full bg-navy/80 border border-gold/30 rounded p-3 pr-12 text-gold/90 font-serif focus:border-gold focus:outline-none" />
        <div className="absolute bottom-3 right-3"><VoiceButton mode="input" size="sm" onTranscript={text => setMsg(prev => prev ? prev + ' ' + text : text)} /></div>
      </div>
      <button onClick={send} disabled={sending || (!msg.trim() && attachedFiles.length === 0)} className="mt-4 w-full btn-emergency py-3 rounded font-display tracking-widest text-sm disabled:opacity-50">{sending ? t('sending') : done ? t('sent') : t('sendToCenter')}</button>
    </div>
  );
}

function UsersPanel() {
  const { t } = useLang();
  const [msg, setMsg] = useState('');
  const [attachedFiles, setAttachedFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const send = async () => {
    if (!msg.trim() && attachedFiles.length === 0) return;
    setSending(true);
    const fullMsg = buildMessageWithFiles(msg, attachedFiles);
    try { await api.emergencyUsers(fullMsg); setDone(true); setMsg(''); setAttachedFiles([]); setTimeout(() => setDone(false), 3000); }
    finally { setSending(false); }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="text-xs text-gold/40 tracking-widest uppercase">{t('attachFileLabel')}</span>
        <FileAttach onFile={(f) => f && setAttachedFiles((prev) => [...prev, f])} compact />
        {attachedFiles.length > 0 && <span className="text-xs text-emerald-400 font-mono">✓ {attachedFiles.length} {t('filesAttached')}</span>}
      </div>
      <div className="relative">
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)}
          placeholder={attachedFiles.length > 0 ? t('fileNotePlaceholder') : t('usersMsg')} rows={6}
          className="w-full bg-navy/80 border border-gold/30 rounded p-3 pr-12 text-gold/90 font-serif focus:border-gold focus:outline-none" />
        <div className="absolute bottom-3 right-3"><VoiceButton mode="input" size="sm" onTranscript={text => setMsg(prev => prev ? prev + ' ' + text : text)} /></div>
      </div>
      <button onClick={send} disabled={sending || (!msg.trim() && attachedFiles.length === 0)} className="mt-4 w-full btn-gold py-3 rounded font-display tracking-widest text-sm disabled:opacity-50">{sending ? t('sending') : done ? t('sentAll') : t('sendToUsers')}</button>
    </div>
  );
}

function LockedPanel() { const { t } = useLang(); return <div className="text-center py-12"><Lock className="w-16 h-16 text-gold/40 mx-auto mb-4" /><h3 className="text-lg font-display text-gold/70 tracking-widest mb-2">{t('lockedPanel')}</h3><p className="text-sm text-gold/50 max-w-md mx-auto">{t('lockedNote')}</p></div>; }
