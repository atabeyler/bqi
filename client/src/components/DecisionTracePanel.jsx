import { CheckCircle2, Circle, Clock3, Database, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useLang } from '../services/langContext.jsx';

function stageLabel(name, t) {
  const LABELS = {
    ingest: t('dtStageIngest'), validate: t('dtStageValidate'), normalize: t('dtStageNormalize'),
    'ai-analysis': t('dtStageAiAnalysis'), quantum: t('dtStageQuantum'), fraud: t('dtStageFraud'),
    optimizer: t('dtStageOptimizer'), evidence: t('dtStageEvidence'), finalize: t('dtStageFinalize'),
  };
  return LABELS[name] || String(name || t('dtStageFallback')).replaceAll('-', ' ').toLocaleUpperCase('en-US');
}

export default function DecisionTracePanel({ record }) {
  const { t } = useLang();
  if (!record) return null;
  const trace = record.decision_trace || record.decisionTrace || {};
  const stages = Array.isArray(trace.stages) ? trace.stages : [];
  const integrityOk = record.integrity?.ok ?? record.integrity_ok ?? null;
  const hashes = [record.input_hash, record.evidence_hash, record.record_hash].filter(Boolean);

  return (
    <section className="mt-4 rounded-lg border border-cyan-400/20 bg-[#031326]/85 overflow-hidden" aria-label="Decision Trace">
      <header className="px-4 py-3 border-b border-cyan-400/10 flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-cyan-300" />
        <div>
          <div className="text-[13px] tracking-[0.18em] text-cyan-100 font-semibold">{t('dtLabel')}</div>
          <div className="text-[12px] text-white/30 mt-0.5">{t('dtDesc')}</div>
        </div>
        <span className={`ml-auto text-[12px] px-2 py-1 rounded border ${integrityOk === false ? 'border-red-400/30 text-red-300' : 'border-emerald-400/25 text-emerald-300'}`}>
          {integrityOk === false ? t('dtIntegrityWarning') : integrityOk === true ? t('dtIntegrityVerified') : t('dtAuditRecord')}
        </span>
      </header>

      <div className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4 text-[12px]">
          <Meta icon={Database} label={t('dtDataSource')} value={record.provenance?.source || record.provenance?.type || '—'} />
          <Meta icon={Clock3} label={t('dtDuration')} value={record.duration_ms ? `${record.duration_ms} ms` : '—'} />
          <Meta icon={ShieldCheck} label={t('dtClassification')} value={record.data_classification || '—'} />
        </div>

        {stages.length ? (
          <div className="relative pl-3">
            <div className="absolute left-[22px] top-4 bottom-4 w-px bg-cyan-400/15" />
            <div className="space-y-2">
              {stages.map((stage, index) => {
                const failed = stage.status === 'failed';
                const completed = stage.status === 'completed';
                const Icon = failed ? TriangleAlert : completed ? CheckCircle2 : Circle;
                return (
                  <div key={`${stage.stage}-${index}`} className="relative flex gap-3 rounded border border-white/5 bg-black/10 p-2.5">
                    <span className={`relative z-10 w-5 h-5 rounded-full bg-[#031326] flex items-center justify-center ${failed ? 'text-red-300' : completed ? 'text-emerald-300' : 'text-cyan-300'}`}><Icon className="w-4 h-4" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="text-[13px] text-white/75 font-medium">{stageLabel(stage.stage, t)}</span><span className="text-[11px] text-white/25">#{String(index + 1).padStart(2, '0')}</span><span className={`ml-auto text-[11px] ${failed ? 'text-red-300' : 'text-emerald-300/70'}`}>{String(stage.status || 'recorded').toUpperCase()}</span></div>
                      <div className="mt-1 text-[12px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
                        {stage.metadata?.durationMs != null && <span>{stage.metadata.durationMs} ms</span>}
                        {stage.metadata?.backend && <span>Backend: {stage.metadata.backend}</span>}
                        {stage.metadata?.error && <span className="text-red-300/70">{stage.metadata.error}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : <div className="rounded border border-white/5 p-4 text-center text-[13px] text-white/30">{t('dtNoStages')}</div>}

        {hashes.length > 0 && <div className="mt-4 pt-3 border-t border-cyan-400/10 text-[11px] text-white/25 font-mono break-all">RECORD HASH: {record.record_hash || hashes.at(-1)}</div>}
      </div>
    </section>
  );
}

function Meta({ icon: Icon, label, value }) {
  return <div className="rounded border border-cyan-400/10 bg-black/10 p-2.5"><div className="flex items-center gap-1.5 text-white/25"><Icon className="w-3 h-3" />{label}</div><div className="mt-1 text-cyan-100/70 truncate" title={String(value)}>{String(value)}</div></div>;
}
