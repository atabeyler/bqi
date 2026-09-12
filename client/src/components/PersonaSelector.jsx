/**
 * PersonaSelector — Assistant persona and username settings
 */
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { User, Bot, Save, ChevronDown, Check } from 'lucide-react';
import { ASSISTANT_PERSONAS } from '../services/personas.js';
import { memoryApi } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';

const PERSONA_NAMES = {
  general:  { tr: 'General',  en: 'General',  de: 'General',  fr: 'Général',    ar: 'الجنرال' },
  analyst:  { tr: 'Analist',  en: 'Analyst',  de: 'Analyst',  fr: 'Analyste',   ar: 'المحلل' },
  diplomat: { tr: 'Diplomat', en: 'Diplomat', de: 'Diplomat', fr: 'Diplomate',  ar: 'الدبلوماسي' },
  hawk:     { tr: 'Şahin',    en: 'Hawk',     de: 'Falke',    fr: 'Faucon',     ar: 'الصقر' },
  sage:     { tr: 'Bilge',    en: 'Sage',     de: 'Weiser',   fr: 'Sage',       ar: 'الحكيم' },
  joker:    { tr: 'Şakacı',   en: 'Jester',   de: 'Narr',     fr: 'Bouffon',    ar: 'المهرّج' },
  stoic:    { tr: 'Stoacı',   en: 'Stoic',    de: 'Stoiker',  fr: 'Stoïque',    ar: 'الرواقي' },
  angry:    { tr: 'Sinirli',  en: 'Irritable', de: 'Reizbar', fr: 'Irritable',  ar: 'الغاضب' },
};
const PERSONA_DESCS = {
  general:  { tr: 'Otoriter, kararlı, askeri liderlik', en: 'Authoritative, decisive, military leadership', de: 'Autoritär, entschlossen, militärische Führung', fr: 'Autoritaire, déterminé, leadership militaire', ar: 'سلطوي، حازم، قيادة عسكرية' },
  analyst:  { tr: 'Soğuk, veri odaklı, istatistiksel', en: 'Cold, data-driven, statistical', de: 'Kühl, datengetrieben, statistisch', fr: 'Froid, axé sur les données, statistique', ar: 'بارد، يعتمد على البيانات، إحصائي' },
  diplomat: { tr: 'Zarif, dengeli, çok perspektifli', en: 'Elegant, balanced, multi-perspective', de: 'Elegant, ausgewogen, vielperspektivisch', fr: 'Élégant, équilibré, multi-perspective', ar: 'أنيق، متوازن، متعدد وجهات النظر' },
  hawk:     { tr: 'Sert, doğrudan, güç odaklı', en: 'Tough, direct, power-focused', de: 'Hart, direkt, machtorientiert', fr: 'Dur, direct, axé sur le pouvoir', ar: 'قاسٍ، مباشر، يركز على القوة' },
  sage:     { tr: 'Felsefi, tarihsel, derin bilge', en: 'Philosophical, historical, deep wisdom', de: 'Philosophisch, historisch, tiefgründig weise', fr: 'Philosophique, historique, sagesse profonde', ar: 'فلسفي، تاريخي، حكمة عميقة' },
  joker:    { tr: 'Esprili ama derin, mizahi danışman', en: 'Witty but deep, humorous advisor', de: 'Witzig, aber tiefgründig, humorvoller Berater', fr: 'Spirituel mais profond, conseiller humoristique', ar: 'ذكي الظرف لكنه عميق، مستشار فكاهي' },
  stoic:    { tr: 'Minimal, sakin, duygusuz', en: 'Minimal, calm, emotionless', de: 'Minimal, ruhig, gefühllos', fr: 'Minimal, calme, sans émotion', ar: 'بسيط، هادئ، بلا مشاعر' },
  angry:    { tr: 'Sabırsız, sinirli ama çok zeki', en: 'Impatient, angry but very smart', de: 'Ungeduldig, gereizt, aber sehr klug', fr: 'Impatient, irrité mais très intelligent', ar: 'غير صبور، غاضب لكنه ذكي جداً' },
};

export default function PersonaSelector({ onSave, initialProfile }) {
  const { t, lang } = useLang();
  const [displayName, setDisplayName] = useState(initialProfile?.display_name || '');
  const [rank, setRank] = useState(initialProfile?.rank || '');
  const [unit, setUnit] = useState(initialProfile?.unit || '');
  const [selectedPersona, setSelectedPersona] = useState(initialProfile?.preferred_persona || 'general');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await memoryApi.updateProfile({
        display_name: displayName,
        rank,
        unit,
        preferred_persona: selectedPersona,
        preferred_lang: lang
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSave?.({ display_name: displayName, rank, unit, preferred_persona: selectedPersona });
    } catch (e) {
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* User profile */}
      <div>
        <h3 className="font-display text-gold text-sm tracking-widest mb-4 flex items-center gap-2">
          <User className="w-4 h-4" />
          {t('personaUserProfile')}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gold/60 tracking-widest uppercase block mb-1">
              {t('personaDisplayName')}
            </label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder={t('personaDisplayNamePh')}
              className="w-full bg-navy/80 border border-gold/30 rounded px-3 py-2 text-gold/90 text-sm focus:border-gold focus:outline-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gold/60 tracking-widest uppercase block mb-1">
                {t('personaRankLabel')}
              </label>
              <input value={rank} onChange={e => setRank(e.target.value)}
                placeholder={t('personaRankPh')}
                className="w-full bg-navy/80 border border-gold/30 rounded px-3 py-2 text-gold/90 text-sm focus:border-gold focus:outline-none" />
            </div>
            <div>
              <label className="text-xs text-gold/60 tracking-widest uppercase block mb-1">
                {t('personaUnitLabel')}
              </label>
              <input value={unit} onChange={e => setUnit(e.target.value)}
                placeholder="MSB, SSB, KKK..."
                className="w-full bg-navy/80 border border-gold/30 rounded px-3 py-2 text-gold/90 text-sm focus:border-gold focus:outline-none" />
            </div>
          </div>
        </div>
      </div>

      {/* Assistant persona */}
      <div>
        <h3 className="font-display text-gold text-sm tracking-widest mb-4 flex items-center gap-2">
          <Bot className="w-4 h-4" />
          {t('personaAssistantCharacter')}
        </h3>
        <div className="grid grid-cols-2 gap-2">
          {ASSISTANT_PERSONAS.map(p => {
            const isSelected = selectedPersona === p.id;
            return (
              <motion.button key={p.id}
                onClick={() => setSelectedPersona(p.id)}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={`p-3 rounded-lg border text-left transition ${
                  isSelected
                    ? 'border-gold/60 bg-gold/15'
                    : 'border-gold/20 bg-navy/40 hover:border-gold/40'
                }`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{p.emoji}</span>
                    <span className="font-display text-xs tracking-widest"
                      style={{ color: isSelected ? p.color : '#bcefff' }}>
                      {PERSONA_NAMES[p.id]?.[lang] || p.id}
                    </span>
                  </div>
                  {isSelected && <Check className="w-3 h-3 text-gold" />}
                </div>
                <p className="text-xs text-gold/50 leading-relaxed">
                  {PERSONA_DESCS[p.id]?.[lang] || ''}
                </p>
              </motion.button>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <button onClick={handleSave} disabled={saving}
        className="w-full btn-gold py-3 rounded font-display tracking-widest text-sm disabled:opacity-50 flex items-center justify-center gap-2">
        {saving ? <><span className="w-4 h-4 border-2 border-navy/60 border-t-navy rounded-full animate-spin" />
          {t('personaSaving')}</>
          : saved ? <><Check className="w-4 h-4" /> {t('personaSaved')}</>
          : <><Save className="w-4 h-4" /> {t('personaSaveProfile')}</>}
      </button>
    </div>
  );
}
