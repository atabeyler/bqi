import React from 'react';
import { useLang } from '../services/langContext.jsx';

export default function AppFooter({ fixed = false, tone = 'gold' }) {
  const { t } = useLang();
  const cyan = tone === 'cyan';
  return (
    <footer className={`${fixed ? 'fixed bottom-0 left-0 right-0' : 'relative'} z-20 py-2 ${cyan ? 'border-t border-cyan-400/20' : 'border-t border-gold/20'} bg-navy-light/80 backdrop-blur flex items-center justify-center px-4 font-serif`}>
      <p className={`text-[11px] sm:text-[12px] md:text-[13px] lg:text-xs leading-tight tracking-wide sm:tracking-wider text-center ${cyan ? 'text-cyan-100/60' : 'text-gold/60'}`}>
        <strong className={cyan ? 'text-cyan-100/80' : 'text-gold/80'}>{t('company')}</strong>
        {' · '}<span className={cyan ? 'text-cyan-100/55' : 'text-gold/50'}>{t('rights')}</span>
        {' · '}<span className={cyan ? 'text-cyan-100/45' : 'text-gold/40'}>{t('projectCode')}: QTR-200120401018</span>
        {' · '}<span className={`text-[11px] sm:text-[11px] md:text-[12px] lg:text-[13px] ${cyan ? 'text-cyan-100/45' : 'text-gold/40'}`}>{t('classified')}</span>
      </p>
    </footer>
  );
}
