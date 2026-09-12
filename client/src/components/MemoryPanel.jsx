/**
 * MemoryPanel — Saved conversations, archive, loading from memory
 */
import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Archive, Trash2, RotateCcw, ChevronDown, ChevronUp, BookOpen, Clock, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { memoryApi } from '../services/api.js';
import { ASSISTANT_PERSONAS } from '../services/personas.js';
import { useLang } from '../services/langContext.jsx';
import { formatLocalDate } from '../services/dateTime.js';

export default function MemoryPanel({ onLoadConversation }) {
  const { t, lang } = useLang();
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    memoryApi.getConversations()
      .then(data => setConversations(data))
      .catch(e => console.error(e))
      .finally(() => setLoading(false));
  }, []);

  const archive = async (id, archived) => {
    await memoryApi.archiveConversation(id, archived);
    setConversations(prev => prev.map(c => c.id === id ? { ...c, archived } : c));
  };

  const remove = async (id) => {
    if (!confirm(t('memoryDeleteConfirm'))) return;
    await memoryApi.deleteConversation(id);
    setConversations(prev => prev.filter(c => c.id !== id));
  };

  const load = async (id) => {
    const full = await memoryApi.getConversation(id);
    onLoadConversation?.(full);
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter(c => showArchived ? true : !c.archived)
      .filter(c => !q || c.session_title?.toLowerCase().includes(q) || c.summary?.toLowerCase().includes(q));
  }, [conversations, showArchived, query]);

  const personaEmoji = (id) => ASSISTANT_PERSONAS.find(p => p.id === id)?.emoji || '🤖';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-gold text-sm tracking-widest flex items-center gap-2">
          <BookOpen className="w-4 h-4" />
          {t('memoryArchiveTitle')}
        </h3>
        <button onClick={() => setShowArchived(!showArchived)}
          className={`text-xs tracking-wider px-2 py-1 rounded border transition ${
            showArchived ? 'border-gold/40 text-gold bg-gold/10' : 'border-gold/20 text-gold/50 hover:border-gold/40'
          }`}>
          {showArchived ? t('memoryShowActive') : t('memoryShowArchived')}
        </button>
      </div>

      {!loading && conversations.length > 0 && (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gold/40 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Konuşmalarda ara…"
            className="w-full bg-navy/40 border border-gold/20 rounded pl-7 pr-2.5 py-1.5 text-xs text-gold placeholder:text-gold/30 focus:border-gold/50 outline-none"
          />
        </div>
      )}

      {loading ? (
        <div className="text-center py-6 text-gold/40 text-sm">
          {t('homeLoadingActivity')}
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-8 text-gold/40 text-sm">
          <Archive className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {t('memoryNoSaved')}
        </div>
      ) : (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {visible.map(conv => (
            <motion.div key={conv.id}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              className={`rounded-lg border transition ${
                conv.archived ? 'border-gold/10 opacity-60' : 'border-gold/25 hover:border-gold/40'
              } bg-navy/40`}>
              <div className="flex items-start gap-2 p-3 cursor-pointer"
                onClick={() => setExpanded(expanded === conv.id ? null : conv.id)}>
                <span className="text-lg mt-0.5 flex-shrink-0">{personaEmoji(conv.persona_id)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-gold/90 text-sm font-display tracking-wide truncate">{conv.session_title}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Clock className="w-3 h-3 text-gold/40" />
                    <span className="text-xs text-gold/40">
                      {formatLocalDate(conv.created_at, lang)}
                    </span>
                    {conv.archived && (
                      <span className="text-xs bg-gold/10 text-gold/50 px-1.5 rounded">
                        {t('memoryArchivedBadge')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {expanded === conv.id ? <ChevronUp className="w-4 h-4 text-gold/40" /> : <ChevronDown className="w-4 h-4 text-gold/40" />}
                </div>
              </div>

              <AnimatePresence>
                {expanded === conv.id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="px-3 pb-3 space-y-3 border-t border-gold/15 pt-3">
                      {conv.summary && (
                        <div>
                          <p className="text-xs text-gold/50 uppercase tracking-widest mb-1">
                            {t('memorySummaryLabel')}
                          </p>
                          <p className="text-xs text-gold/70 leading-relaxed">{conv.summary.slice(0, 300)}...</p>
                        </div>
                      )}
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={() => load(conv.id)}
                          className="btn-gold px-3 py-1.5 rounded text-xs tracking-widest flex items-center gap-1">
                          <RotateCcw className="w-3 h-3" />
                          {t('memoryLoadConversation')}
                        </button>
                        <button onClick={() => archive(conv.id, !conv.archived)}
                          className="border border-gold/30 text-gold/60 px-3 py-1.5 rounded text-xs hover:border-gold/50 flex items-center gap-1">
                          <Archive className="w-3 h-3" />
                          {conv.archived ? t('memoryUnarchive') : t('memoryArchive')}
                        </button>
                        <button onClick={() => remove(conv.id)}
                          className="border border-crimson/30 text-crimson/60 px-3 py-1.5 rounded text-xs hover:border-crimson/50 flex items-center gap-1">
                          <Trash2 className="w-3 h-3" />
                          {t('memoryDelete')}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
