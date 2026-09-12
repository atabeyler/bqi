import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, VolumeX, Loader2, PhoneOff, Save, Settings, BookOpen, MessageSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, memoryApi } from '../services/api.js';
import { getPersonaById } from '../services/personas.js';
import { useLang } from '../services/langContext.jsx';
import { localeFor } from '../services/i18n.js';
import PersonaSelector from './PersonaSelector.jsx';
import MemoryPanel from './MemoryPanel.jsx';
import ConsultChat from './ConsultChat.jsx';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const ST = { IDLE:'idle', LISTENING:'listening', THINKING:'thinking', SPEAKING:'speaking', PAUSED:'paused' };
const FEMALE_HINTS = ['female','woman','zira','hazel','aria','seda','selin'];

function pickPreferredVoice(voices, langCode) {
  const primary = langCode.split('-')[0];
  const sameLang = voices.filter(v => (v.lang||'').toLowerCase().startsWith(primary));
  const pool = sameLang.length ? sameLang : voices;
  const female = pool.find(v => FEMALE_HINTS.some(h => (v.name||'').toLowerCase().includes(h)));
  return female || pool[0] || null;
}

function speakReliable(text, langCode, onDone) {
  const s = window.speechSynthesis;
  if (!s || !text?.trim()) { onDone?.(); return; }
  try { s.cancel(); } catch {}
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = langCode;
  utt.rate = 0.92;
  utt.pitch = 1.05;
  const doSpeak = () => {
    const voices = s.getVoices();
    const v = pickPreferredVoice(voices, utt.lang);
    if (v) utt.voice = v;
    let done = false;
    const finish = () => { if (!done) { done = true; onDone?.(); } };
    const safetyTimer = setTimeout(finish, 20000);
    utt.onend = () => { clearTimeout(safetyTimer); finish(); };
    utt.onerror = () => { clearTimeout(safetyTimer); finish(); };
    try {
      s.speak(utt);
      setTimeout(() => { try { s.resume(); } catch {} }, 100);
    } catch { finish(); }
  };
  const voices = s.getVoices();
  if (voices.length > 0) { doSpeak(); }
  else {
    let called = false;
    s.onvoiceschanged = () => { if (!called) { called = true; doSpeak(); } };
    setTimeout(() => { if (!called) { called = true; doSpeak(); } }, 600);
  }
}

const NAMES = {
  general:{tr:'General',en:'General',de:'General',fr:'Général',ar:'جنرال'},
  diplomat:{tr:'Diplomat',en:'Diplomat',de:'Diplomat',fr:'Diplomate',ar:'دبلوماسي'},
  hawk:{tr:'Şahin',en:'Hawk',de:'Falke',fr:'Faucon',ar:'الصقر'},
  analyst:{tr:'Analist',en:'Analyst',de:'Analyst',fr:'Analyste',ar:'محلل'},
  guardian:{tr:'Koruyucu',en:'Guardian',de:'Wächter',fr:'Gardien',ar:'الحارس'}
};

const TX = {
  tr:{
    mic:'Mikrofon erişimi reddedildi. Chrome/Edge kullanın.',
    noSpeech:'Ses algılanamadı.',thinking:'Düşünüyor...',
    listening:'Dinliyor...',speaking:'Konuşuyor...',tap:'Mikrofona tıklayın',
    paused:'Duraksatıldı',auto:'OTO-DİNLE',arch:'Arşiv',char:'Karakter',
    consultMode:'DANIŞMA MODU',homeScreen:'ANA EKRAN',
    voiceTab:'SESLİ DANIŞMA',chatTab:'SOHBET',active:'AKTİF',
    voiceNote:'BQI sizi dinleyecek ve sesli yanıtlayacak.',
    save:'Kaydet',clear:'Temizle',error:'Hata'
  },
  en:{
    mic:'Microphone denied. Use Chrome/Edge.',noSpeech:'No speech detected.',
    thinking:'Thinking...',listening:'Listening...',speaking:'Speaking...',
    tap:'Tap microphone',paused:'Paused',auto:'AUTO-LISTEN',arch:'Archive',char:'Character',
    consultMode:'CONSULTATION MODE',homeScreen:'HOME',
    voiceTab:'VOICE CONSULTATION',chatTab:'CHAT',active:'ACTIVE',
    voiceNote:'BQI will listen to you and respond.',
    save:'Save',clear:'Clear',error:'Error'
  },
  de:{
    mic:'Mikrofonzugriff verweigert. Verwenden Sie Chrome/Edge.',noSpeech:'Keine Sprache erkannt.',
    thinking:'Denkt nach...',listening:'Hört zu...',speaking:'Spricht...',
    tap:'Mikrofon antippen',paused:'Pausiert',auto:'AUTO-HÖREN',arch:'Archiv',char:'Charakter',
    consultMode:'BERATUNGSMODUS',homeScreen:'STARTSEITE',
    voiceTab:'SPRACHBERATUNG',chatTab:'CHAT',active:'AKTIV',
    voiceNote:'BQI hört Ihnen zu und antwortet per Sprache.',
    save:'Speichern',clear:'Löschen',error:'Fehler'
  },
  fr:{
    mic:'Accès au microphone refusé. Utilisez Chrome/Edge.',noSpeech:'Aucune parole détectée.',
    thinking:'Réflexion...',listening:'Écoute...',speaking:'Parle...',
    tap:'Appuyez sur le microphone',paused:'En pause',auto:'ÉCOUTE AUTO',arch:'Archive',char:'Personnage',
    consultMode:'MODE CONSULTATION',homeScreen:'ACCUEIL',
    voiceTab:'CONSULTATION VOCALE',chatTab:'DISCUSSION',active:'ACTIF',
    voiceNote:'BQI vous écoutera et répondra à voix haute.',
    save:'Enregistrer',clear:'Effacer',error:'Erreur'
  },
  ar:{
    mic:'تم رفض الوصول إلى الميكروفون. استخدم Chrome/Edge.',noSpeech:'لم يتم اكتشاف كلام.',
    thinking:'يفكر...',listening:'يستمع...',speaking:'يتحدث...',
    tap:'اضغط على الميكروفون',paused:'متوقف مؤقتاً',auto:'استماع تلقائي',arch:'الأرشيف',char:'الشخصية',
    consultMode:'وضع الاستشارة',homeScreen:'الرئيسية',
    voiceTab:'استشارة صوتية',chatTab:'محادثة',active:'نشط',
    voiceNote:'سيستمع إليك BQI ويرد صوتياً.',
    save:'حفظ',clear:'مسح',error:'خطأ'
  }
};

export default function VoiceChat({ onClose }) {
  const closeChat = useCallback(() => {
    setPhase(ST.IDLE);
    clearTimeout(timerRef.current);
    try { recRef.current?.abort(); } catch {}
    try { window.speechSynthesis?.cancel(); } catch {}
    window.dispatchEvent(new CustomEvent('aq:resume'));
    onClose?.();
  }, [onClose]);
  const { lang } = useLang();
  const t = useCallback((k) => TX[lang]?.[k] || TX.en[k] || TX.tr[k] || k, [lang]);

  const [phase, setPhase] = useState(ST.IDLE);
  const [transcript, setTranscript] = useState('');
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [autoListen, setAutoListen] = useState(true);
  const [personaId, setPersonaId] = useState(() => localStorage.getItem('bqi_persona') || 'general');
  const [profile, setProfile] = useState(null);
  const [sidePanel, setSidePanel] = useState(null);
  const [saving, setSaving] = useState(false);
  const [memoryContext, setMemoryContext] = useState('');
  const [tab, setTab] = useState('voice');

  const recRef = useRef(null);
  const timerRef = useRef(null);
  const phaseRef = useRef(ST.IDLE);
  const autoListenRef = useRef(true);
  const historyRef = useRef([]);
  const personaIdRef = useRef('general');
  const profileRef = useRef(null);
  const memCtxRef = useRef('');
  const langRef = useRef(lang);
  const startListeningRef = useRef(null);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { autoListenRef.current = autoListen; }, [autoListen]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { personaIdRef.current = personaId; }, [personaId]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { memCtxRef.current = memoryContext; }, [memoryContext]);
  useEffect(() => { langRef.current = lang; }, [lang]);

  useEffect(() => {
    memoryApi.getProfile().then(p => {
      setProfile(p);
      if (p?.preferred_persona) { setPersonaId(p.preferred_persona); localStorage.setItem('bqi_persona', p.preferred_persona); }
    }).catch(()=>{});
    memoryApi.getContext().then(r => { if (r?.context) setMemoryContext(r.context); }).catch(()=>{});
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(timerRef.current);
      try { window.speechSynthesis?.cancel(); } catch {}
      try { recRef.current?.abort(); } catch {}
      window.dispatchEvent(new CustomEvent('aq:resume'));
    };
  }, []);

  startListeningRef.current = () => {
    setError('');
    if (!SR) { setError(TX[langRef.current]?.mic || TX.tr.mic); return; }
    window.dispatchEvent(new CustomEvent('aq:pause'));
    clearTimeout(timerRef.current);
    try { recRef.current?.abort(); } catch {}
    recRef.current = null;
    setTimeout(() => {
      try {
        const rec = new SR();
        rec.lang = langRef.current === 'tr' ? 'tr-TR' : 'en-US';
        rec.continuous = false;
        rec.interimResults = false;
        rec.maxAlternatives = 3;
        rec.onresult = async (event) => {
          const text = event.results[0]?.[0]?.transcript?.trim() || '';
          const normalized = text.toLowerCase().replace(/ç/g,'c').replace(/ğ/g,'g').replace(/ı/g,'i').replace(/ö/g,'o').replace(/ş/g,'s').replace(/ü/g,'u');
          if (normalized.includes('ana ekran') || normalized.includes('anasayfa') || normalized.includes('sohbetten cik') || normalized.includes('chatten cik') || normalized.includes('kapat') || normalized.includes('cik')) { closeChat(); return; }
          if (normalized.includes('ingilizce') || normalized === 'en' || normalized.includes('english')) { window.dispatchEvent(new CustomEvent('aq:lang:set', { detail: { lang: 'en' } })); }
          if (normalized.includes('turkce') || normalized === 'tr' || normalized.includes('turkish')) { window.dispatchEvent(new CustomEvent('aq:lang:set', { detail: { lang: 'tr' } })); }
          setTranscript(text);
          if (!text) {
            setError(TX[langRef.current]?.noSpeech || TX.tr.noSpeech);
            setPhase(ST.IDLE);
            window.dispatchEvent(new CustomEvent('aq:resume'));
            return;
          }
          setPhase(ST.THINKING);
          setError('');
          try {
            const newHist = [...historyRef.current, { role:'user', content:text }];
            const res = await api.chatConsult(text, newHist);
            const aiText = (res.response || res.content || res.message || '').trim();
            if (!aiText) { setPhase(ST.IDLE); window.dispatchEvent(new CustomEvent('aq:resume')); return; }
            const updatedHist = [...newHist, { role:'assistant', content:aiText }];
            setHistory(updatedHist);
            setPhase(ST.SPEAKING);
            speakReliable(aiText, langRef.current === 'tr' ? 'tr-TR' : 'en-US', () => {
              setPhase(ST.IDLE);
              if (autoListenRef.current) timerRef.current = setTimeout(() => startListeningRef.current?.(), 600);
              else window.dispatchEvent(new CustomEvent('aq:resume'));
            });
          } catch(e) {
            setError(e.message || TX[langRef.current]?.error || TX.tr.error);
            setPhase(ST.IDLE);
            window.dispatchEvent(new CustomEvent('aq:resume'));
          }
        };
        rec.onerror = (ev) => {
          if (ev.error === 'no-speech') setError(TX[langRef.current]?.noSpeech || TX.tr.noSpeech);
          else if (ev.error !== 'aborted') setError((TX[langRef.current]?.mic || TX.tr.mic) + ': ' + ev.error);
          setPhase(ST.IDLE);
          window.dispatchEvent(new CustomEvent('aq:resume'));
        };
        rec.onend = () => { if (phaseRef.current === ST.LISTENING) setPhase(ST.IDLE); };
        recRef.current = rec;
        rec.start();
        setPhase(ST.LISTENING);
      } catch(e) {
        setError((TX[langRef.current]?.mic || TX.tr.mic) + ': ' + e.message);
        setPhase(ST.IDLE);
        window.dispatchEvent(new CustomEvent('aq:resume'));
      }
    }, 200);
  };

  const handleMicClick = useCallback(() => {
    const p = phaseRef.current;
    if (p === ST.LISTENING) { try { recRef.current?.stop(); } catch {} }
    else if (p === ST.SPEAKING) {
      try { window.speechSynthesis?.cancel(); } catch {}
      clearTimeout(timerRef.current);
      setPhase(ST.PAUSED);
    }
    else if (p !== ST.THINKING) startListeningRef.current?.();
  }, []);

  const saveConversation = async () => {
    if (!history.length) return;
    setSaving(true);
    try {
      const label = (NAMES[personaId]?.[lang] || personaId) + ' - ' + new Date().toLocaleString(localeFor(lang));
      await memoryApi.saveConversation(history, personaId, label);
    } catch(e) { setError(e.message); }
    setSaving(false);
  };

  const phaseLabel = () => {
    if (phase===ST.LISTENING) return TX[lang]?.listening || TX.tr.listening;
    if (phase===ST.THINKING) return TX[lang]?.thinking || TX.tr.thinking;
    if (phase===ST.SPEAKING) return TX[lang]?.speaking || TX.tr.speaking;
    if (phase===ST.PAUSED) return TX[lang]?.paused || TX.tr.paused;
    return TX[lang]?.tap || TX.tr.tap;
  };

  const persona = getPersonaById(personaId);

  return (
    <div className="h-full w-full flex flex-col bg-[#020c18]/95 backdrop-blur-sm rounded-xl overflow-hidden">

      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 border-b border-gold/20 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gold/10 border border-gold/30 flex items-center justify-center text-lg">{persona?.emoji||'Q'}</div>
          <div>
            <div className="text-gold font-semibold tracking-widest uppercase text-sm">{NAMES[personaId]?.[lang]||personaId}</div>
            <div className="text-xs text-gold/40 tracking-wider uppercase">{t('consultMode')}</div>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          {tab === 'voice' && (
            <button onClick={()=>setAutoListen(a=>!a)}
              className={`hidden sm:flex px-3 py-1 rounded text-xs border tracking-widest uppercase transition ${
                autoListen?'bg-gold/10 border-gold text-gold':'border-gold/30 text-gold/40'
              }`}>
              {t('auto')} {autoListen?t('active'):''}
            </button>
          )}
          <button onClick={()=>setSidePanel(p=>p==='history'?null:'history')}
            className="hidden sm:flex px-3 py-1 rounded text-xs border border-gold/30 text-gold/60 hover:text-gold hover:border-gold transition tracking-widest uppercase items-center gap-1">
            <BookOpen className="w-3 h-3"/> {t('arch')}
          </button>
          <button onClick={()=>setSidePanel(p=>p==='persona'?null:'persona')}
            className="hidden sm:flex px-3 py-1 rounded text-xs border border-gold/30 text-gold/60 hover:text-gold hover:border-gold transition tracking-widest uppercase items-center gap-1">
            <Settings className="w-3 h-3"/> {t('char')}
          </button>
          <button onClick={closeChat}
            className="px-3 py-1 rounded text-xs border border-cyan-300/40 text-cyan-100 hover:bg-cyan-400/10 transition tracking-widest uppercase">
            {t('homeScreen')}
          </button>
          <button onClick={closeChat} className="p-2 text-gold/60 hover:text-crimson transition">
            <PhoneOff className="w-5 h-5"/>
          </button>
        </div>
      </div>

      <div className="flex border-b border-gold/20 flex-shrink-0">
        <button
          onClick={() => setTab('voice')}
          className={`flex items-center gap-2 px-5 py-2.5 text-xs tracking-widest uppercase border-r border-gold/10 transition ${
            tab === 'voice'
              ? 'bg-gold/10 text-gold border-b-2 border-b-gold'
              : 'text-gold/50 hover:text-gold hover:bg-gold/5'
          }`}>
          <Mic className="w-3.5 h-3.5" /> {t('voiceTab')}
        </button>
        <button
          onClick={() => setTab('chat')}
          className={`flex items-center gap-2 px-5 py-2.5 text-xs tracking-widest uppercase transition ${
            tab === 'chat'
              ? 'bg-purple-500/10 text-purple-300 border-b-2 border-b-purple-400'
              : 'text-gold/50 hover:text-gold hover:bg-gold/5'
          }`}>
          <MessageSquare className="w-3.5 h-3.5" /> {t('chatTab')}
        </button>
      </div>

      {tab === 'chat' ? (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden p-3 sm:p-4">
            <ConsultChat />
          </div>
          <AnimatePresence>
            {sidePanel && (
              <motion.div initial={{x:300,opacity:0}} animate={{x:0,opacity:1}} exit={{x:300,opacity:0}}
                className="w-72 border-l border-gold/20 bg-[#020c18]/95 overflow-y-auto p-4">
                {sidePanel==='persona' && <PersonaSelector current={personaId} onSelect={(id)=>{setPersonaId(id);localStorage.setItem('bqi_persona',id);setSidePanel(null);}}/> }
                {sidePanel==='history' && <MemoryPanel onLoad={(conv)=>{if(conv.messages)setHistory(conv.messages);setSidePanel(null);}}/> }
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col items-center justify-between p-3 sm:p-6">
            <div className="w-full max-w-2xl flex-1 overflow-y-auto space-y-3 sm:space-y-4 mb-3 sm:mb-4">
              {history.length===0 && (
                <div className="text-center text-gold/30 text-sm tracking-widest uppercase mt-8">
                  {persona?.emoji} {t('voiceNote')}
                </div>
              )}
              {history.map((msg,i) => (
                <div key={i} className={`flex ${msg.role==='user'?'justify-end':'justify-start'}`}>
                  <div className={`max-w-[88%] sm:max-w-lg px-3 sm:px-4 py-2.5 sm:py-3 rounded text-xs sm:text-sm ${
                    msg.role==='user'?'bg-gold/10 border border-gold/30 text-gold':'bg-navy/60 border border-gold/10 text-gold/80'
                  }`}>
                    {msg.role==='assistant'
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : msg.content}
                  </div>
                </div>
              ))}
              {phase===ST.THINKING && (
                <div className="flex justify-start">
                  <div className="bg-navy/60 border border-gold/10 px-4 py-3 rounded text-sm text-gold/60 flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin"/>{t('thinking')}
                  </div>
                </div>
              )}
            </div>

            {transcript && <div className="w-full max-w-2xl mb-3 text-center text-gold/60 text-sm italic">"{transcript}"</div>}
            {error && <div className="w-full max-w-2xl mb-3 text-center text-crimson text-xs">{error}</div>}

            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <motion.button onClick={handleMicClick} whileHover={{scale:1.05}} whileTap={{scale:0.95}}
                  disabled={phase===ST.THINKING}
                  className={`w-20 h-20 rounded-full border-2 flex items-center justify-center shadow-2xl transition ${
                    phase===ST.THINKING?'opacity-50 cursor-wait':''
                  } ${
                    phase===ST.LISTENING?'bg-crimson border-red-400':
                    phase===ST.SPEAKING?'bg-gold/20 border-gold':
                    'bg-navy border-gold/40 hover:border-gold hover:bg-gold/10'
                  }`}
                  style={phase===ST.LISTENING?{boxShadow:'0 0 30px rgba(200,16,46,0.6)'}:phase===ST.SPEAKING?{boxShadow:'0 0 20px rgba(88,221,255,0.4)'}:{}}>
                  {phase===ST.LISTENING?<MicOff className="w-8 h-8 text-white"/>:
                   phase===ST.SPEAKING?<VolumeX className="w-8 h-8 text-gold"/>:
                   phase===ST.THINKING?<Loader2 className="w-8 h-8 text-gold animate-spin"/>:
                   <Mic className="w-8 h-8 text-gold"/>}
                </motion.button>
                {phase===ST.LISTENING && (
                  <motion.div className="absolute inset-0 rounded-full border-2 border-crimson pointer-events-none"
                    animate={{scale:[1,1.4,1],opacity:[0.7,0,0.7]}} transition={{duration:1.3,repeat:Infinity}}/>
                )}
              </div>
              <div className="text-xs text-gold/50 tracking-widest uppercase">{phaseLabel()}</div>
              {history.length > 0 && (
                <div className="flex gap-2 mt-2">
                  <button onClick={saveConversation} disabled={saving}
                    className="flex items-center gap-1 px-3 py-1 rounded border border-gold/30 text-gold/60 hover:text-gold hover:border-gold text-xs uppercase tracking-widest transition">
                    <Save className="w-3 h-3"/>{saving?'...':t('save')}
                  </button>
                  <button onClick={()=>{setHistory([]);setTranscript('');}}
                    className="px-3 py-1 rounded border border-red-500/30 text-red-400/60 hover:text-red-400 hover:border-red-500 text-xs uppercase tracking-widest transition">
                    {t('clear')}
                  </button>
                </div>
              )}
            </div>
          </div>

          <AnimatePresence>
            {sidePanel && (
              <motion.div initial={{x:300,opacity:0}} animate={{x:0,opacity:1}} exit={{x:300,opacity:0}}
                className="w-72 border-l border-gold/20 bg-[#020c18]/95 overflow-y-auto p-4">
                {sidePanel==='persona' && <PersonaSelector current={personaId} onSelect={(id)=>{setPersonaId(id);localStorage.setItem('bqi_persona',id);setSidePanel(null);}}/> }
                {sidePanel==='history' && <MemoryPanel onLoad={(conv)=>{if(conv.messages)setHistory(conv.messages);setSidePanel(null);}}/> }
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
