import { describe, it, expect } from 'vitest';
import {
  CATEGORY_IDS, DEPTH_IDS, PRIORITY_IDS, CRITICAL_ACTIONS, CONFIRM_REQUIRED_ACTIONS,
  matchCategory, matchDepth, matchQuantum, isCriticalIntentText,
  mentionsNext, mentionsBack, mentionsReset, matchConfirm, matchCancel,
  matchPriority, mentionsDownload, mentionsPdf, mentionsShare,
  matchLanguageTarget, matchThemeTarget, matchWizardStepNumber,
  coerceAndValidateParams, validateActionCandidate, validateActionPlan,
} from './voiceIntentSchema.js';

describe('voiceIntentSchema: context/navigation slot words', () => {
  it('detects next/back/reset words across languages', () => {
    expect(mentionsNext('sonraki adıma geç')).toBe(true);
    expect(mentionsNext('next step please')).toBe(true);
    expect(mentionsBack('geri dön')).toBe(true);
    expect(mentionsBack('go back')).toBe(true);
    expect(mentionsReset('sıfırla')).toBe(true);
    expect(mentionsReset('reset it')).toBe(true);
  });

  it('detects confirm/cancel words across languages', () => {
    expect(matchConfirm('evet')).toBe(true);
    expect(matchConfirm('yes')).toBe(true);
    expect(matchCancel('hayır')).toBe(true);
    expect(matchCancel('cancel')).toBe(true);
    expect(matchConfirm('bugün hava nasıl')).toBe(false);
  });

  it('scopes CONFIRM_REQUIRED_ACTIONS to genuinely destructive actions', () => {
    expect(CONFIRM_REQUIRED_ACTIONS.has('logout')).toBe(true);
    expect(CONFIRM_REQUIRED_ACTIONS.has('start_analysis')).toBe(false);
  });
});

describe('voiceIntentSchema: category/depth synonym matching', () => {
  it('maps Turkish category words to the real internal ids', () => {
    expect(matchCategory('savunma analizi başlat')).toBe('savunma');
    expect(matchCategory('enerji analizi başlat')).toBe('enerji');
    expect(matchCategory('ekonomi analizi yap')).toBe('ekonomi');
    expect(matchCategory('saldırı analizi')).toBe('saldiri');
    expect(matchCategory('toplumsal analiz')).toBe('toplumsal');
    expect(matchCategory('sağlık analizi')).toBe('saglik');
    expect(matchCategory('çok alanlı analiz')).toBe('cok-alanli');
  });

  it('maps English/German/French/Arabic category words too', () => {
    expect(matchCategory('start an energy analysis')).toBe('enerji');
    expect(matchCategory('starte eine Verteidigungsanalyse')).toBe('savunma');
    expect(matchCategory('lancer une analyse économie')).toBe('ekonomi');
    expect(matchCategory('ابدأ تحليل الطاقة')).toBe('enerji');
  });

  it('returns null for text with no recognizable category', () => {
    expect(matchCategory('bugün hava nasıl')).toBeNull();
  });

  it('maps depth synonyms', () => {
    expect(matchDepth('derin ekonomi analizi yap')).toBe('derin');
    expect(matchDepth('hızlı bir analiz')).toBe('hizli');
    expect(matchDepth('standart derinlikte')).toBe('standart');
    expect(matchDepth('a deep analysis please')).toBe('derin');
  });

  it('detects quantum on/off/unspecified', () => {
    expect(matchQuantum('kuantum destekli enerji analizi başlat')).toBe(true);
    expect(matchQuantum('kuantumu kapat')).toBe(false);
    expect(matchQuantum('enerji analizi başlat')).toBeNull();
  });

  it('flags analysis/quantum utterances as critical intents', () => {
    expect(isCriticalIntentText('enerji analizi başlat')).toBe(true);
    expect(isCriticalIntentText('kuantumu aç')).toBe(true);
    expect(isCriticalIntentText('bugün hava nasıl')).toBe(false);
  });
});

describe('voiceIntentSchema: CATEGORY_IDS/DEPTH_IDS are the real app enums', () => {
  it('includes every real analysis category', () => {
    for (const id of ['savunma', 'enerji', 'saldiri', 'ekonomi', 'toplumsal', 'danisma', 'saglik', 'cok-alanli', 'bddk', 'btk']) {
      expect(CATEGORY_IDS).toContain(id);
    }
  });
  it('includes every real analysis depth', () => {
    expect(DEPTH_IDS).toEqual(['hizli', 'standart', 'derin']);
  });
});

describe('voiceIntentSchema: coerceAndValidateParams', () => {
  it('accepts a fully specified start_analysis and normalizes types', () => {
    const { params, errors } = coerceAndValidateParams('start_analysis', { category: 'enerji', depth: 'derin', quantum: 'true' });
    expect(errors).toEqual([]);
    expect(params).toEqual({ category: 'enerji', depth: 'derin', quantum: true });
  });

  it('fills in schema defaults for depth/quantum when omitted', () => {
    const { params, errors } = coerceAndValidateParams('start_analysis', { category: 'savunma' });
    expect(errors).toEqual([]);
    expect(params.depth).toBe('standart');
    expect(params.quantum).toBe(false);
  });

  it('repairs a natural-language category value the AI might send instead of the internal id', () => {
    const { params, errors } = coerceAndValidateParams('start_analysis', { category: 'energy' });
    expect(errors).toEqual([]);
    expect(params.category).toBe('enerji');
  });

  it('rejects a missing required category', () => {
    const { errors } = coerceAndValidateParams('start_analysis', {});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid/unmappable category value', () => {
    const { errors } = coerceAndValidateParams('start_analysis', { category: 'atlantis' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes params through unchanged for actions with no declared schema', () => {
    const { params, errors } = coerceAndValidateParams('navigate_home', { anything: 'goes' });
    expect(errors).toEqual([]);
    expect(params).toEqual({ anything: 'goes' });
  });
});

describe('voiceIntentSchema: validateActionCandidate / validateActionPlan', () => {
  const known = new Set(['start_analysis', 'navigate_home', 'ui_activate']);

  it('accepts a valid, known, well-formed action', () => {
    const result = validateActionCandidate({ action: 'start_analysis', params: { category: 'savunma' } }, known);
    expect(result.valid).toBe(true);
    expect(result.action).toBe('start_analysis');
    expect(result.params.category).toBe('savunma');
  });

  it('rejects an unknown action name', () => {
    const result = validateActionCandidate({ action: 'delete_everything', params: {} }, known);
    expect(result.valid).toBe(false);
  });

  it('rejects a malformed candidate (not an object, missing action field)', () => {
    expect(validateActionCandidate(null, known).valid).toBe(false);
    expect(validateActionCandidate('not-an-object', known).valid).toBe(false);
    expect(validateActionCandidate({}, known).valid).toBe(false);
    expect(validateActionCandidate({ params: {} }, known).valid).toBe(false);
  });

  it('refuses ui_activate for a critical (analysis/quantum) intent even though ui_activate itself is a known action', () => {
    const result = validateActionCandidate({ action: 'ui_activate', params: { target: 'Yeni Analiz' } }, known, 'enerji analizi başlat');
    expect(result.valid).toBe(false);
  });

  it('allows ui_activate for a non-critical intent', () => {
    const result = validateActionCandidate({ action: 'ui_activate', params: { target: 'Kaydet' } }, known, 'kaydet butonuna tıkla');
    expect(result.valid).toBe(true);
  });

  it('filters a mixed plan down to only the valid entries and reports rejections', () => {
    const { valid, rejected } = validateActionPlan([
      { action: 'navigate_home', params: {} },
      { action: 'not_a_real_action', params: {} },
      { action: 'start_analysis', params: { category: 'ekonomi', depth: 'derin' } },
    ], known);
    expect(valid).toEqual([
      { action: 'navigate_home', params: {} },
      { action: 'start_analysis', params: { category: 'ekonomi', depth: 'derin', quantum: false } },
    ]);
    expect(rejected.length).toBe(1);
  });

  it('rejects a non-array plan entirely instead of throwing', () => {
    const { valid, rejected } = validateActionPlan('not-an-array', known);
    expect(valid).toEqual([]);
    expect(rejected.length).toBe(1);
  });

  it('stops collecting further actions once a critical step fails validation', () => {
    const { valid } = validateActionPlan([
      { action: 'start_analysis', params: { category: 'atlantis' } }, // invalid critical step
      { action: 'navigate_home', params: {} }, // would otherwise be valid
    ], known);
    expect(valid).toEqual([]);
  });

  it('every action listed in CRITICAL_ACTIONS is a real, meaningful semantic action name', () => {
    for (const name of CRITICAL_ACTIONS) {
      expect(typeof name).toBe('string');
      expect(name).not.toBe('ui_activate');
    }
  });
});

describe('voiceIntentSchema: priority/download/share/language/theme/step slot matching', () => {
  it('maps priority synonyms', () => {
    expect(matchPriority('önceliği yüksek yap')).toBe('yuksek');
    expect(matchPriority('set priority to critical')).toBe('kritik');
    expect(matchPriority('düşük öncelik')).toBe('dusuk');
    expect(matchPriority('bugün hava nasıl')).toBeNull();
    for (const id of PRIORITY_IDS) expect(typeof id).toBe('string');
  });

  it('detects download/pdf/share intent words', () => {
    expect(mentionsDownload('raporu indir')).toBe(true);
    expect(mentionsDownload('download the report')).toBe(true);
    expect(mentionsPdf('pdf olarak indir')).toBe(true);
    expect(mentionsPdf('raporu indir')).toBe(false);
    expect(mentionsShare('raporu paylaş')).toBe(true);
    expect(mentionsShare('share the report')).toBe(true);
  });

  it('maps a spoken target language to its internal language id', () => {
    expect(matchLanguageTarget('dili almanca yap')).toBe('de');
    expect(matchLanguageTarget('switch to french')).toBe('fr');
    expect(matchLanguageTarget('İngilizceye çevir')).toBe('en');
    expect(matchLanguageTarget('bugün hava nasıl')).toBeNull();
  });

  it('maps a spoken theme target to dark/light/system', () => {
    expect(matchThemeTarget('koyu temaya geç')).toBe('dark');
    expect(matchThemeTarget('light mode')).toBe('light');
    expect(matchThemeTarget('sistem temasına al')).toBe('system');
    expect(matchThemeTarget('bugün hava nasıl')).toBeNull();
  });

  it('extracts a wizard step number only when a step-word is present', () => {
    expect(matchWizardStepNumber('3. adıma git')).toBe('3');
    expect(matchWizardStepNumber('go to step 2')).toBe('2');
    expect(matchWizardStepNumber('3 elma aldım')).toBeNull(); // digit with no step word
  });
});
