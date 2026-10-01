import React from 'react';
import { Shield, Zap, Target, TrendingUp, Users, MessageSquare, HeartPulse, Layers, Landmark, Radio, ShieldAlert, Network, Home, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLang } from '../services/langContext.jsx';

export const CATEGORIES = [
  { id: 'savunma',    nameKey: 'cat_savunma',    icon: Shield,        color: '#6fb4ff', tone: 'bg-blue-500/15 border-blue-300/35',
    status: { tr: 'Kritik', en: 'Critical', de: 'Kritisch', fr: 'Critique', ar: 'حرج' },
    desc: { tr: 'Sınır, caydırıcılık, savunma refleksi', en: 'Border, deterrence, defense posture', de: 'Grenze, Abschreckung, Verteidigungshaltung', fr: 'Frontière, dissuasion, posture de défense', ar: 'الحدود، الردع، الموقف الدفاعي' } },
  { id: 'enerji',     nameKey: 'cat_enerji',     icon: Zap,           color: '#ecfbff', tone: 'bg-cyan-500/15 border-cyan-300/35',
    status: { tr: 'İzleniyor', en: 'Monitoring', de: 'Wird überwacht', fr: 'Surveillé', ar: 'قيد المراقبة' },
    desc: { tr: 'Arz, altyapı, enerji güvenliği', en: 'Supply, infrastructure, energy security', de: 'Versorgung, Infrastruktur, Energiesicherheit', fr: 'Approvisionnement, infrastructure, sécurité énergétique', ar: 'الإمداد، البنية التحتية، أمن الطاقة' } },
  { id: 'saldiri',    nameKey: 'cat_saldiri',    icon: Target,        color: '#ff6b85', tone: 'bg-rose-500/15 border-rose-300/35',
    status: { tr: 'Kritik', en: 'Critical', de: 'Kritisch', fr: 'Critique', ar: 'حرج' },
    desc: { tr: 'Ofansif kapasite ve karşı hamleler', en: 'Offensive capacity and counter-moves', de: 'Offensive Kapazität und Gegenmaßnahmen', fr: 'Capacité offensive et contre-mesures', ar: 'القدرة الهجومية والتحركات المضادة' } },
  { id: 'ekonomi',    nameKey: 'cat_ekonomi',    icon: TrendingUp,    color: '#56e6b3', tone: 'bg-emerald-500/15 border-emerald-300/35',
    status: { tr: 'Stabil', en: 'Stable', de: 'Stabil', fr: 'Stable', ar: 'مستقر' },
    desc: { tr: 'Piyasa, ticaret, finansal etkiler', en: 'Markets, trade, financial effects', de: 'Märkte, Handel, finanzielle Auswirkungen', fr: 'Marchés, commerce, effets financiers', ar: 'الأسواق، التجارة، الآثار المالية' } },
  { id: 'toplumsal',  nameKey: 'cat_toplumsal',  icon: Users,         color: '#8de0ff', tone: 'bg-cyan-500/15 border-cyan-300/35',
    status: { tr: 'İzleniyor', en: 'Monitoring', de: 'Wird überwacht', fr: 'Surveillé', ar: 'قيد المراقبة' },
    desc: { tr: 'Saha dinamiği ve kamu etkisi', en: 'Field dynamics and public impact', de: 'Lagedynamik und öffentliche Auswirkungen', fr: 'Dynamique de terrain et impact public', ar: 'ديناميكية الميدان والتأثير العام' } },
  { id: 'danisma',    nameKey: 'cat_danisma',    icon: MessageSquare, color: '#9cc7ff', tone: 'bg-sky-500/15 border-sky-300/35',
    status: { tr: 'Hazır', en: 'Ready', de: 'Bereit', fr: 'Prêt', ar: 'جاهز' },
    desc: { tr: 'Uzman görüşü ve karar desteği', en: 'Expert advisory and decision support', de: 'Expertenberatung und Entscheidungsunterstützung', fr: 'Avis d\'expert et aide à la décision', ar: 'استشارة الخبراء ودعم القرار' } },
  { id: 'saglik',     nameKey: 'cat_saglik',     icon: HeartPulse,    color: '#7bf7bc', tone: 'bg-teal-500/15 border-teal-300/35',
    status: { tr: 'Stabil', en: 'Stable', de: 'Stabil', fr: 'Stable', ar: 'مستقر' },
    desc: { tr: 'Halk sağlığı ve kapasite takibi', en: 'Public health and capacity tracking', de: 'Öffentliche Gesundheit und Kapazitätsverfolgung', fr: 'Santé publique et suivi des capacités', ar: 'الصحة العامة وتتبع القدرات' } },
  { id: 'cok-alanli', nameKey: 'cat_cok_alanli', icon: Layers,        color: '#ffd36a', tone: 'bg-yellow-500/15 border-yellow-300/35',
    status: { tr: 'Sentez', en: 'Synthesis', de: 'Synthese', fr: 'Synthèse', ar: 'توليف' },
    desc: { tr: 'Çok alanlı birleşik strateji üretimi', en: 'Cross-domain integrated strategy', de: 'Bereichsübergreifende integrierte Strategie', fr: 'Stratégie intégrée multi-domaines', ar: 'استراتيجية متكاملة متعددة المجالات' } },
  { id: 'bddk',       nameKey: 'cat_bddk',       icon: Landmark,      color: '#c9a3ff', tone: 'bg-violet-500/15 border-violet-300/35',
    status: { tr: 'Kuantum', en: 'Quantum', de: 'Quanten', fr: 'Quantique', ar: 'كمي' },
    desc: { tr: 'Bankacılık/finans işlem denetimi ve anomali tespiti', en: 'Banking/finance transaction audit and anomaly detection', de: 'Bank-/Finanztransaktionsprüfung und Anomalieerkennung', fr: 'Audit des transactions bancaires/financières et détection d\'anomalies', ar: 'تدقيق المعاملات المصرفية/المالية وكشف الحالات الشاذة' } },
  { id: 'btk',        nameKey: 'cat_btk',        icon: Radio,         color: '#ff9f6e', tone: 'bg-orange-500/15 border-orange-300/35',
    status: { tr: 'Kuantum', en: 'Quantum', de: 'Quanten', fr: 'Quantique', ar: 'كمي' },
    desc: { tr: 'Haberleşme ağı denetimi ve anomali tespiti', en: 'Telecom network audit and anomaly detection', de: 'Telekommunikationsnetzprüfung und Anomalieerkennung', fr: 'Audit du réseau télécom et détection d\'anomalies', ar: 'تدقيق شبكة الاتصالات وكشف الحالات الشاذة' } },
  { id: 'siber',      nameKey: 'cat_siber',      icon: ShieldAlert,   color: '#7dd3fc', tone: 'bg-sky-600/15 border-sky-400/35',
    status: { tr: 'BCI', en: 'BCI', de: 'BCI', fr: 'BCI', ar: 'BCI' },
    desc: { tr: 'Siber risk skoru, tarama bulguları ve saldırı yüzeyi', en: 'Cyber risk score, scan findings and attack surface', de: 'Cyberrisikobewertung, Scan-Ergebnisse und Angriffsfläche', fr: 'Score de risque cyber, résultats d\'analyse et surface d\'attaque', ar: 'درجة المخاطر السيبرانية ونتائج الفحص وسطح الهجوم' } },
  { id: 'sfre',       nameKey: 'cat_sfre',       icon: Network,       color: '#5eead4', tone: 'bg-teal-600/15 border-teal-400/35',
    status: { tr: 'BFI', en: 'BFI', de: 'BFI', fr: 'BFI', ar: 'BFI' },
    desc: { tr: 'Sistemik fon riski, bulaşma ve piyasa bütünlüğü ölçümleri', en: 'Systemic fund risk, contagion and market-integrity measurements', de: 'Systemisches Fondsrisiko, Ansteckung und Marktintegrität', fr: 'Risque systémique des fonds, contagion et intégrité du marché', ar: 'المخاطر النظامية للصناديق والعدوى وسلامة السوق' } }
];

export default function CategorySidebar({ activeCategory, onSelect, onHome, collapsed = false, onToggleCollapse = null }) {
  const { t, lang } = useLang();
  const labelClass = collapsed ? 'hidden' : 'inline';
  const blockLabelClass = collapsed ? 'hidden' : 'block';
  const justify = collapsed ? 'justify-center' : 'justify-start';
  const iconSize = collapsed ? 'w-6 h-6' : 'w-5 h-5';
  const rowGap = collapsed ? 'gap-0' : 'gap-3';
  const rowPad = collapsed ? 'py-2' : 'px-3 py-2';

  return (
    <aside className={`bqi-category-sidebar relative z-10 ${collapsed ? 'w-14' : 'w-64 sm:w-72 md:w-80'} backdrop-blur border-r overflow-y-auto flex-shrink-0 transition-all`} style={{ background: "rgba(0,8,22,0.92)", borderColor: "rgba(0,200,255,0.15)" }}>
      <div className="p-1 sm:p-4">
        {onToggleCollapse && (
          <button onClick={onToggleCollapse}
            className="btn-depth flex w-full items-center justify-center py-1.5 mb-2 rounded text-xs"
            title={collapsed ? t('expandSidebarTooltip') : t('collapseSidebarTooltip')}
            aria-label={collapsed ? t('expandSidebarTooltip') : t('collapseSidebarTooltip')}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        )}
        <button onClick={onHome}
          className={`btn-depth w-full flex ${justify} items-center ${rowGap} ${rowPad} mb-2 sm:mb-4 rounded text-sm`}>
          <Home className={`${iconSize} flex-shrink-0`} />
          <span className={`${labelClass} tracking-widest text-xs uppercase`}>{t('home')}</span>
        </button>
        <button onClick={() => onSelect(null)}
          className={`btn-depth w-full flex ${justify} items-center ${rowGap} ${rowPad} mb-2 sm:mb-4 rounded text-sm`}>
          <Plus className={`${iconSize} flex-shrink-0`} />
          <span className={`${labelClass} tracking-widest text-xs uppercase`}>{t('newAnalysis')}</span>
        </button>

        <div className={`${blockLabelClass} bqi-sidebar-heading text-xs text-cyan-200/80 tracking-[0.3em] uppercase mb-3 px-3`}>
          {t('analysisCategories')}
        </div>

        <div className="space-y-2">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeCategory === cat.id;
            const status = cat.status[lang] || cat.status.tr;
            const desc = cat.desc[lang] || cat.desc.tr;
            return (
              <button key={cat.id}
                onClick={() => onSelect(cat.id)}
                title={collapsed ? t(cat.nameKey) : undefined}
                className={`w-full text-left flex ${justify} items-center ${rowGap} ${collapsed ? 'py-2.5' : 'px-3 py-2.5'} rounded-lg border transition ${
                  isActive
                    ? `${cat.tone} shadow-[0_0_18px_rgba(120,220,255,0.28)]`
                    : 'border-transparent hover:border-cyan-300/20 hover:bg-white/5'
                }`}>
                <Icon className={`${iconSize} flex-shrink-0`} style={{ color: isActive ? cat.color : '#bcefff' }} />
                <div className={`${blockLabelClass} min-w-0 flex-1`}>
                  <div className="flex items-center gap-2">
                    <span className="bqi-category-title font-display tracking-wider text-xs uppercase">{t(cat.nameKey)}</span>
                    <span className="bqi-category-status text-xs px-1.5 py-0.5 rounded-full border border-cyan-300/35 text-cyan-100/85">{status}</span>
                  </div>
                  <div className="bqi-category-desc text-xs text-cyan-200/65 mt-0.5 truncate">{desc}</div>
                </div>
                {isActive && <div className={`ml-auto w-1.5 h-1.5 rounded-full bg-gold animate-pulse ${collapsed ? 'hidden' : 'block'}`} />}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
