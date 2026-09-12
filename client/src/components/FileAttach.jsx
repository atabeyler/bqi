import React, { useRef, useState } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';
import { api } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';

const IMAGE_EXTS = /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i;
const DOC_EXTS = /\.(pdf|docx|txt|csv|xlsx|xls)$/i;

// FileMessageContent's attachment URL is parsed out of free-text message
// content (see below), including messages from OTHER chat participants
// (EmergencyChatPanel.jsx renders every m.from, not just the local user's
// own messages) -- without this check, a message body containing
// `[📎 EKLİ DOSYA: rapor.png]\njavascript:...` renders as a clickable
// styled attachment link that runs attacker JS in the viewer's own
// authenticated origin when clicked. Every real attachment URL this app
// generates itself is either a same-origin relative path (`/api/files/...`)
// or an absolute http(s)/blob: URL -- nothing else is ever legitimate.
function isSafeAttachmentUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.startsWith('/')) return true;
  try {
    const scheme = new URL(url, window.location.origin).protocol;
    return scheme === 'https:' || scheme === 'http:' || scheme === 'blob:';
  } catch {
    return false;
  }
}

export function FileMessageContent({ text, className = '' }) {
  const { t } = useLang();
  const idx = text ? text.indexOf('\n\n[📎 EKLİ DOSYA:') : -1;
  if (idx === -1) return <span className={`whitespace-pre-wrap text-sm ${className}`}>{text}</span>;

  const note = text.slice(0, idx).trim();
  const rest = text.slice(idx + 2);
  const m = rest.match(/\[📎 EKLİ DOSYA: (.+?)\]\n(.+)/);
  if (!m) return <span className={`whitespace-pre-wrap text-sm ${className}`}>{text}</span>;

  const filename = m[1];
  const url = m[2].trim();
  if (!isSafeAttachmentUrl(url)) return <span className={`whitespace-pre-wrap text-sm ${className}`}>{text}</span>;
  const isImage = IMAGE_EXTS.test(filename);

  return (
    <div className={className}>
      {note && <p className="whitespace-pre-wrap text-sm mb-2">{note}</p>}
      {isImage ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={filename} className="max-w-full rounded max-h-52 object-contain border border-current/10" />
        </a>
      ) : (
        <a href={url} target="_blank" rel="noreferrer" download={filename} className="flex items-center gap-2 bg-black/20 border border-current/15 rounded px-3 py-2 hover:bg-black/30 transition">
          <Paperclip className="w-3.5 h-3.5 shrink-0 opacity-60" />
          <span className="text-xs font-mono truncate flex-1 opacity-80">{filename}</span>
          <span className="text-xs opacity-40 shrink-0">↓ {t('faDownload')}</span>
        </a>
      )}
    </div>
  );
}

// Turns a structured /analysis/upload result (transactions/scenarios/optimization —
// see server/src/services/{transactionSource,scenarioDataSource}.js) into plain
// text so any consumer that only understands text context (e.g. ConsultChat)
// can still use it, without needing to know about each structured shape.
export function describeStructuredUpload(file) {
  if (!file) return '';
  if (file.type === 'text') return file.text;
  if (file.type === 'transactions') {
    return `[Yüklenen gerçek işlem kayıtları: ${file.filename}]\n` +
      file.transactions.map((t) => `${t.id}: ${t.amount} TL, saat ${t.hour}, sıklık ${t.frequency}, yeni taraf ${t.newCounterparty ? 'evet' : 'hayır'}, sınır ötesi ${t.crossBorder ? 'evet' : 'hayır'}`).join('\n');
  }
  if (file.type === 'scenarios') {
    return `[Yüklenen gerçek senaryo verisi: ${file.filename}]\n` +
      file.scenarios.map((s) => `${s.title}: ${s.probability}${s.timeframe ? `, ${s.timeframe}` : ''}${s.trigger ? `, tetikleyici: ${s.trigger}` : ''}`).join('\n');
  }
  if (file.type === 'optimization') {
    return `[Yüklenen gerçek optimizasyon verisi: ${file.filename}, bütçe %${file.budgetPercent}]\n` +
      file.items.map((it) => `${it.id}: değer ${it.value}, maliyet ${it.cost}`).join('\n');
  }
  return `[Eklenen dosya: ${file.filename}]\n${globalThis.location?.origin || ''}${file.url}`;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function FileAttach({ onText, onFile, onAIFile, compact = false, dataClassification = null }) {
  const { t } = useLang();
  const [filename, setFilename] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const inputRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError('');
    try {
      if (onAIFile) {
        const isDoc = DOC_EXTS.test(file.name.toLowerCase());
        const isImage = file.type.startsWith('image/');

        if (isDoc) {
          let result;
          try {
            result = await api.uploadForAI(file, dataClassification);
          } catch (uploadError) {
            // Plain-text formats can still be consumed entirely on-device
            // when the upload/parser service is unreachable. Binary Office
            // and PDF formats keep their original error because decoding
            // them as text would produce misleading garbage.
            if (!/\.(txt|csv)$/i.test(file.name)) throw uploadError;
            result = { type: 'text', filename: file.name, text: await file.text() };
          }
          setFilename(file.name);
          onAIFile(result);
        } else if (isImage) {
          const base64 = await readBase64(file);
          const blobUrl = URL.createObjectURL(file);
          setFilename(file.name);
          onAIFile({ type: 'image', blobUrl, base64, mimetype: file.type, filename: file.name });
        } else {
          const result = await api.uploadFile(file);
          setFilename(file.name);
          onAIFile({ type: 'file', url: result.url, filename: file.name, mimetype: file.type });
        }
      } else if (onFile) {
        const result = await api.uploadFile(file);
        setFilename(file.name);
        onFile(result);
      } else {
        const text = await api.uploadDocument(file);
        setFilename(file.name);
        onText?.(text);
      }
    } catch (err) {
      setError(err.message || t('faUploadError'));
    } finally {
      setLoading(false);
      e.target.value = '';
      setInputKey((k) => k + 1);
    }
  };

  const remove = () => {
    setFilename(null);
    setError('');
    onAIFile?.(null);
    onFile?.(null);
    onText?.(null);
  };

  const accept = (onAIFile || onFile) ? '*/*' : '.pdf,.docx,.txt';

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input key={inputKey} ref={inputRef} type="file" accept={accept} className="hidden" onChange={handleFile} />

      {filename && (
        <span className="flex items-center gap-1 text-xs bg-cyan-900/40 border border-cyan-500/30 text-cyan-300 rounded px-2 py-1 font-mono max-w-[180px]">
          <Paperclip className="w-3 h-3 shrink-0" />
          <span className="truncate">{filename}</span>
          <button onClick={remove} className="ml-0.5 hover:text-red-400 shrink-0" aria-label={t('faRemoveAria')}><X className="w-3 h-3" /></button>
        </span>
      )}

      <button
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        title={onAIFile ? t('faTooltipAI') : onFile ? t('faTooltipFile') : t('faTooltipDoc')}
        className={`flex items-center gap-1 border border-gold/25 text-gold/50 hover:text-gold hover:border-gold/50 rounded transition disabled:opacity-40 ${compact ? 'px-2 py-1.5 text-[14px]' : 'px-2.5 py-1.5 text-xs'} font-mono tracking-wider`}
      >
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Paperclip className="w-3 h-3" />}
        {!compact && (loading ? t('faUploading') : (filename ? t('faAddMore') : t('faAttach')))}
      </button>

      {error && <span className="text-xs text-red-400 font-mono">{error}</span>}
    </div>
  );
}
