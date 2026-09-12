import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, RefreshCw, ChevronLeft, ChevronRight, BookOpen, LockKeyhole, Download, FileDown, Share2 } from 'lucide-react';
import { api, cyberAnalysisApi } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';
import { buildLocalDocxBlob, buildLocalPdfBlob } from '../services/localExport.js';
import { downloadBlob, shareOrDownloadBlob } from '../services/shareFile.js';
import {
  buildBciReportExport, buildControlledProofExportReport, buildFindingExportReport, buildScanExportReport,
  controlledProofDisplayValue, controlledProofRejectionExplanation, localizedCyberValue, reportFieldLabel,
} from '../services/cyberReportExport.js';
import CyberNewAnalysisWizard from './CyberNewAnalysisWizard.jsx';
import { formatLocalDateTime } from '../services/dateTime.js';

// Cyber Analysis content -- a faithful, in-app port of BCI's own standalone
// admin UI (bci/ui: Dashboard/Assets/Scans/Findings/Reports/Engines/
// Quantum & PQC -- there is no separate "Scopes" page there either), same
// sidebar nav + per-page titles as bci/ui/src/components/Layout.jsx and
// bci/ui/src/pages/*.jsx, restyled in BQI's own visual language
// rather than a redesign or a link out to a separate app. Every tab goes
// through BQI's server, which proxies to BCI (services/bciClient.js,
// api.js's cyberAnalysisApi) using the user's own BQI session (SSO --
// no separate BCI login); the browser never talks to BCI directly or holds
// a BCI token. Never shows the names of the third-party scanners BCI
// orchestrates underneath (spec section 56). All strings route through the
// existing i18n system (useLang/t) -- no hardcoded text.

// "flow" is the real operational journey (Command Center -> Assets ->
// Scans -> Findings -> Reports) -- Enter/Esc/Prev/Next only ever step
// through this group. "technical" (Engines, Quantum & PQC) are standalone
// status/config panels with no sequence to them; reachable from the
// sidebar but outside the guided flow, matching the product rule that
// Motorlar/Quantum must never look like analysis steps in the main nav.
function useTabs(t) {
  return [
    { id: 'dashboard', navKey: 'cyberCommandCenter', titleKey: 'cyberCommandCenter', group: 'flow' },
    { id: 'assets', navKey: 'cyberNavAssets', titleKey: 'cyberNavAssets', group: 'flow' },
    { id: 'scans', navKey: 'cyberNavScans', titleKey: 'cyberNavScans', group: 'flow' },
    { id: 'findings', navKey: 'cyberNavFindings', titleKey: 'cyberNavFindings', group: 'flow' },
    { id: 'reports', navKey: 'cyberNavReports', titleKey: 'cyberNavReports', group: 'flow' },
    { id: 'engines', navKey: 'cyberNavEngines', titleKey: 'cyberNavEngines', group: 'technical' },
    { id: 'quantum', navKey: 'cyberNavQuantum', titleKey: 'cyberTitleQuantum', group: 'technical' },
    { id: 'controlled-proof', navKey: 'cyberControlledProofNav', titleKey: 'cyberControlledProofTitle', group: 'restricted' },
  ].map((tb) => ({ ...tb, label: t(tb.navKey), title: t(tb.titleKey) }));
}

function scoreTone(score) {
  if (score == null) return 'text-cyan-100/40';
  if (score >= 80) return 'text-emerald-300';
  if (score >= 50) return 'text-gold';
  return 'text-red-400';
}

function Tile({ label, value, tone }) {
  return (
    <div className="hud-panel rounded-xl p-4 flex flex-col items-center gap-1">
      <span className="text-cyan-100/60 text-xs tracking-widest uppercase text-center">{label}</span>
      <span className={`text-3xl font-serif ${tone || 'text-cyan-100'}`}>{value ?? '—'}</span>
    </div>
  );
}

const inputCls = 'w-full bg-black/25 border border-cyan-400/20 rounded px-2.5 py-2 text-[13px] text-cyan-100 focus:border-cyan-300 focus:outline-none';
const btnCls = 'border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded text-[13px] hover:bg-cyan-400/10 disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimaryCls = 'bg-cyan-400/15 border border-cyan-300/50 text-cyan-100 px-4 py-2 rounded text-[13px] hover:bg-cyan-400/25 disabled:opacity-40 disabled:cursor-not-allowed';
const tableWrap = 'overflow-x-auto';
const th = 'text-left text-[11px] tracking-widest uppercase text-cyan-100/50 px-2 py-2 border-b border-cyan-300/15 whitespace-nowrap';
const td = 'text-[13px] text-cyan-100/85 px-2 py-2 border-b border-cyan-300/10 whitespace-nowrap';

const SENSITIVE_REPORT_KEY = /(authorization|cookie|password|secret|token(?!hash)|credential|api.?key|session)/i;

function formatDateTime(value, lang) {
  if (!value) return '—';
  return formatLocalDateTime(value, lang);
}

function localizedValue(t, value) {
  return localizedCyberValue(value, t);
}

function ReportValue({ value, t, lang, fieldKey = null, depth = 0 }) {
  if (fieldKey && SENSITIVE_REPORT_KEY.test(fieldKey)) return <span>{t('cyberReportRedacted')}</span>;
  if (value == null) return <span>—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>{t('cyberControlledProofNoData')}</span>;
    return <div className="space-y-2">{value.map((item, index) => <div key={index} className="border border-cyan-300/10 rounded p-2"><span className="text-cyan-100/40 text-[10px] uppercase">{t('cyberReportItem')} {index + 1}</span><ReportValue value={item} t={t} lang={lang} depth={depth + 1} /></div>)}</div>;
  }
  if (typeof value === 'object') {
    return <dl className={`grid gap-2 ${depth === 0 ? 'sm:grid-cols-2' : ''}`}>{Object.entries(value).map(([key, item]) => <div key={key} className="min-w-0 border-l border-cyan-300/15 pl-2"><dt className="text-cyan-100/45 text-[10px] tracking-wide uppercase">{reportFieldLabel(key, t)}</dt><dd className="text-cyan-100/80 text-[12px] break-words whitespace-normal"><ReportValue value={item} t={t} lang={lang} fieldKey={key} depth={depth + 1} /></dd></div>)}</dl>;
  }
  if (fieldKey && /(created_at|updated_at|detected_at|started_at|finished_at|from|to)$/i.test(fieldKey)) return <span>{formatDateTime(value, lang)}</span>;
  return <span>{localizedValue(t, value)}</span>;
}

function Panel({ title, children, actions }) {
  return (
    <section className="hud-panel rounded-xl p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="text-cyan-100 text-sm tracking-widest uppercase">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function PageTitle({ children }) {
  return <h1 className="text-cyan-100 text-base sm:text-lg tracking-widest uppercase">{children}</h1>;
}

// A visually distinct "this is a reference panel, not a wizard step"
// callout for the technical group (Engines, Quantum & PQC) -- these read
// like settings/documentation, never like another path through the same
// per-scan choices the New Analysis wizard actually makes.
function GuideNote({ children }) {
  return (
    <div className="flex items-start gap-2 border border-gold/25 bg-gold/5 rounded-lg p-3 text-[12.5px] text-gold/80">
      <BookOpen className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="text-red-300 text-[13px] border border-red-400/30 rounded p-2 mb-3">{error}</div>;
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';

function ExportActions({ t, report, onError }) {
  const [busy, setBusy] = useState(false);

  async function run(kind) {
    setBusy(true);
    try {
      const timestamp = Date.now();
      if (kind === 'docx') {
        const blob = await buildLocalDocxBlob(report);
        await downloadBlob(blob, `${report.filename}_${timestamp}.docx`, DOCX_MIME);
      } else {
        const blob = buildLocalPdfBlob(report);
        const filename = `${report.filename}_${timestamp}.pdf`;
        if (kind === 'share') await shareOrDownloadBlob(blob, filename, PDF_MIME, report.title);
        else await downloadBlob(blob, filename, PDF_MIME);
      }
    } catch (error) {
      onError?.(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!report) return null;
  return <div className="flex gap-2 flex-wrap">
    <button type="button" className={btnCls} disabled={busy} onClick={() => run('docx')}><Download className="w-3.5 h-3.5 inline mr-1" />{t('downloadDocxBtn')}</button>
    <button type="button" className={btnCls} disabled={busy} onClick={() => run('pdf')}><FileDown className="w-3.5 h-3.5 inline mr-1" />{t('downloadPdf')}</button>
    <button type="button" className={btnCls} disabled={busy} onClick={() => run('share')}><Share2 className="w-3.5 h-3.5 inline mr-1" />{t('share')}</button>
  </div>;
}

function Badge({ tone, children }) {
  const tones = {
    ok: 'text-emerald-300',
    warn: 'text-gold',
    danger: 'text-red-400',
    muted: 'text-cyan-100/50',
  };
  return <span className={tones[tone] || tones.muted}>{children}</span>;
}

// ─── Komuta Merkezi (Command Center) ───────────────────────────────────
// Every number here comes from an existing, already-real endpoint --
// nothing new is fabricated for this screen. Aggregation (counts, "in
// progress" vs "recently completed", critical/high vs everything else)
// happens client-side over real list responses (assets/scans/findings/
// reports/engines), the same data every other tab already reads.
const IN_PROGRESS_SCAN_STATUSES = ['QUEUED', 'DISCOVERY', 'ANALYZING', 'NORMALIZING', 'VERIFYING', 'CORRELATING', 'SCORING', 'REPORTING'];
const HIGH_PRIORITY_LEVELS = ['IMMEDIATE', '24_HOURS', 'HIGH_PRIORITY'];

function DashboardTab({ t, lang, onNewAnalysis }) {
  const [security, setSecurity] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [activeAssetCount, setActiveAssetCount] = useState(null);
  const [criticalHighCount, setCriticalHighCount] = useState(null);
  const [inProgressScans, setInProgressScans] = useState(null);
  const [recentScans, setRecentScans] = useState(null);
  const [recentReports, setRecentReports] = useState(null);
  const [offlineEngineCount, setOfflineEngineCount] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.cyberAnalysisOverview()
      .then((o) => { setSecurity(o.securityScore); setCoverage(o.coverageScore); })
      .catch((err) => setError(err.message));
    cyberAnalysisApi.listAssets('ACTIVE').then((r) => setActiveAssetCount(r.assets.length)).catch(() => {});
    api.cyberAnalysisFindings().then((r) => {
      setCriticalHighCount(r.findings.filter((f) => HIGH_PRIORITY_LEVELS.includes(f.priority)).length);
    }).catch(() => {});
    cyberAnalysisApi.listScans().then((r) => {
      setInProgressScans(r.jobs.filter((j) => IN_PROGRESS_SCAN_STATUSES.includes(j.status)));
      setRecentScans(r.jobs.filter((j) => j.status === 'COMPLETED').slice(0, 5));
    }).catch(() => {});
    cyberAnalysisApi.listReports().then((r) => setRecentReports(r.reports.slice(0, 5))).catch(() => {});
    cyberAnalysisApi.listEngines().then((r) => {
      setOfflineEngineCount(r.engines.filter((e) => e.status !== 'HEALTHY').length);
    }).catch(() => {});
  }, []);

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberCommandCenter')}</PageTitle>
      <ErrorNote error={error} />

      {offlineEngineCount === 0 ? (
        <div className="hud-panel rounded-xl p-3 text-emerald-300 text-[13px] tracking-wide text-center">{t('cyberSystemOperational')}</div>
      ) : offlineEngineCount > 0 ? (
        <div className="hud-panel rounded-xl p-3 border border-gold/30 text-gold text-[13px] text-center">{t('cyberSystemDegraded', { count: offlineEngineCount })}</div>
      ) : null}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Tile label={t('cyberSecurityScore')} value={security?.score} tone={scoreTone(security?.score)} />
        <div className="hud-panel rounded-xl p-4 flex flex-col items-center gap-1">
          <span className="text-cyan-100/60 text-xs tracking-widest uppercase">{t('cyberCoverageScore')}</span>
          <span className={`text-3xl font-serif ${scoreTone(coverage?.score)}`}>{coverage?.score ?? '—'}</span>
          {coverage?.reason && <span className="text-cyan-100/40 text-[11px]">{coverage.reason}</span>}
        </div>
        <Tile label={t('cyberOpenFindings')} value={security?.openFindingCount} />
        <Tile label={t('cyberActiveAssets')} value={activeAssetCount} />
        <Tile label={t('cyberCriticalHighRisks')} value={criticalHighCount} tone={criticalHighCount > 0 ? 'text-red-400' : undefined} />
        <Tile label={t('cyberInProgressAnalyses')} value={inProgressScans?.length} />
      </div>

      <button onClick={onNewAnalysis} className={`${btnPrimaryCls} w-full text-center py-3 text-sm tracking-widest`}>
        {t('cyberNewAnalysis')}
      </button>

      <Panel title={t('cyberRecentAnalyses')}>
        {recentScans && (recentScans.length === 0 ? (
          <p className="text-cyan-100/40 text-sm">{t('cyberNoneYet')}</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColClass')}</th><th className={th}>{t('cyberColStatus')}</th></tr></thead>
              <tbody>
                {recentScans.map((j) => (
                  <tr key={j.id}>
                    <td className={td}>{j.target}</td>
                    <td className={td}>{localizedValue(t, j.requested_class)}</td>
                    <td className={td}><Badge tone={scanStatusTone(j.status)}>{scanStatusLabel(t, j.status)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Panel>

      <Panel title={t('cyberRecentReports')}>
        {recentReports && (recentReports.length === 0 ? (
          <p className="text-cyan-100/40 text-sm">{t('cyberNoneYet')}</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColType')}</th><th className={th}>{t('cyberColGenerated')}</th></tr></thead>
              <tbody>
                {recentReports.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{localizedValue(t, r.report_type)}</td>
                    <td className={td}>{formatDateTime(r.created_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ─── Assets ─────────────────────────────────────────────────────────────
const ASSET_TYPES = ['DOMAIN', 'HOST', 'WEB_APP', 'API', 'REPOSITORY', 'CONTAINER', 'CLOUD_RESOURCE', 'IDENTITY', 'SERVICE'];
// Real target strings go into asset_identifiers (bci/src/routes/assets.js),
// not a column on assets itself -- risk.js/coverageScore.js/securityGraph.js
// etc. already find "which asset does this scan/finding belong to" by
// matching asset_identifiers.value against the target string, so this
// identifier_type is just a readable label alongside that value, never
// consulted by the matching itself. Loosely mirrors the identifier_type
// examples in 0004_assets.sql's own comment (DOMAIN/IP/CIDR/REPO_URL/
// CLOUD_ACCOUNT_ID).
const IDENTIFIER_TYPE_BY_ASSET_TYPE = {
  DOMAIN: 'DOMAIN',
  HOST: 'IP',
  WEB_APP: 'URL',
  API: 'URL',
  REPOSITORY: 'REPO_URL',
  CONTAINER: 'IMAGE',
  CLOUD_RESOURCE: 'CLOUD_ACCOUNT_ID',
  IDENTITY: 'IDENTITY',
  SERVICE: 'SERVICE',
};

// priorityTone is defined once, below, in the Findings section -- reused
// here too (function declarations hoist) since asset detail's priority
// breakdown uses BCI's same priority scale.

// Inline confirm bar rather than a native window.confirm() -- consistent
// with the rest of this UI (no browser-chrome dialogs anywhere else) and
// keeps the "reversible, no data lost" wording directly next to the action
// instead of a terse browser prompt.
function ConfirmBar({ body, confirmLabel, cancelLabel, onConfirm, onCancel }) {
  return (
    <div className="border border-gold/30 rounded p-3 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
      <p className="text-cyan-100/80 text-[13px]">{body}</p>
      <div className="flex gap-2 shrink-0">
        <button className={btnPrimaryCls} onClick={onConfirm}>{confirmLabel}</button>
        <button className={btnCls} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  );
}

function AssetDetail({ id, t, lang, onClose, onChanged }) {
  const [asset, setAsset] = useState(null);
  const [summary, setSummary] = useState(null);
  const [history, setHistory] = useState(null);
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCriticality, setEditCriticality] = useState('MEDIUM');
  const [saving, setSaving] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [confirmingStatus, setConfirmingStatus] = useState(null); // 'ARCHIVED' | 'ACTIVE' | null

  function load() {
    Promise.all([cyberAnalysisApi.getAsset(id), cyberAnalysisApi.getAssetSummary(id)])
      .then(([a, s]) => {
        setAsset(a);
        setSummary(s.summary);
        setEditName(a.asset.name);
        setEditCriticality(a.asset.criticality);
      })
      .catch((err) => setError(err.message));
    cyberAnalysisApi.getAssetHistory(id).then((r) => setHistory(r.history)).catch(() => {});
    cyberAnalysisApi.listReports(id).then((r) => setReports(r.reports)).catch(() => {});
  }
  useEffect(load, [id]);

  async function onGenerateReport(reportType) {
    setGeneratingReport(true);
    setError(null);
    try {
      await cyberAnalysisApi.generateReport(reportType, { assetId: id, language: lang });
      cyberAnalysisApi.listReports(id).then((r) => setReports(r.reports));
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingReport(false);
    }
  }

  async function saveEdit() {
    if (!editName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await cyberAnalysisApi.updateAsset(id, { name: editName.trim(), criticality: editCriticality });
      setEditing(false);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function applyStatus(status) {
    setSaving(true);
    setError(null);
    try {
      await cyberAnalysisApi.updateAsset(id, { status });
      setConfirmingStatus(null);
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!asset) return <div className="hud-panel rounded-xl p-4 text-cyan-100/60 text-sm">{t('cyberLoading')}</div>;
  const { asset: a, identifiers, technologies } = asset;

  return (
    <div className="hud-panel rounded-xl p-4 sm:p-5 space-y-3">
      <div className="flex justify-between items-start gap-3">
        <div>
          <h3 className="text-cyan-100 text-sm flex items-center gap-2">
            {a.name}
            {a.status === 'ARCHIVED' && <Badge tone="warn">{t('cyberArchivedBadge')}</Badge>}
          </h3>
          <p className="text-cyan-100/50 text-xs">{a.asset_type} · {t('cyberColCreated')}: {formatDateTime(a.created_at, lang)}</p>
        </div>
        <button className={btnCls} onClick={onClose}>{t('cyberClose')}</button>
      </div>
      <ErrorNote error={error} />

      {editing ? (
        <div className="grid sm:grid-cols-3 gap-2 items-end border border-cyan-300/15 rounded p-3">
          <div>
            <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberColName')}</label>
            <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div>
            <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberColCriticality')}</label>
            <select className={inputCls} value={editCriticality} onChange={(e) => setEditCriticality(e.target.value)}>
              {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button className={btnPrimaryCls} disabled={saving || !editName.trim()} onClick={saveEdit}>{t('cyberSaveChanges')}</button>
            <button className={btnCls} onClick={() => setEditing(false)}>{t('cyberCancel')}</button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Tile label={t('cyberColCriticality')} value={a.criticality} />
          <Tile label={t('cyberFindingCount')} value={summary?.findingCount ?? '—'} />
          <Tile label={t('cyberOpenFindings')} value={summary?.openFindingCount ?? '—'} />
          <Tile label={t('cyberRiskScoreLabel')} value={summary?.riskScore ?? '—'} tone={scoreTone(summary?.riskScore)} />
        </div>
      )}

      <div>
        <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-1">{t('cyberLastScan')}</h4>
        {summary?.lastScan ? (
          <p className="text-cyan-100/80 text-[13px]">
            {formatDateTime(summary.lastScan.created_at, lang)} · <Badge tone={scanStatusTone(summary.lastScan.status)}>{scanStatusLabel(t, summary.lastScan.status)}</Badge>
          </p>
        ) : (
          <p className="text-cyan-100/40 text-[13px]">{t('cyberNeverScanned')}</p>
        )}
      </div>

      {summary && Object.keys(summary.priorityBreakdown).length > 0 && (
        <div>
          <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-1">{t('cyberPriorityBreakdown')}</h4>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.priorityBreakdown).map(([priority, count]) => (
              <Badge key={priority} tone={priorityTone(priority)}>{priority}: {count}</Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-1">{t('cyberIdentifiers')}</h4>
        <p className="text-cyan-100/80 text-[13px]">{identifiers.length ? identifiers.map((i) => `${i.identifier_type}: ${i.value}`).join(' · ') : t('cyberNoIdentifiers')}</p>
      </div>
      {technologies.length > 0 && (
        <div>
          <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-1">{t('cyberTechnologies')}</h4>
          <p className="text-cyan-100/80 text-[13px]">{technologies.map((tc) => tc.version ? `${tc.name} ${tc.version}` : tc.name).join(' · ')}</p>
        </div>
      )}

      <div>
        <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-1">{t('cyberAnalysisHistory')}</h4>
        {history && (history.length === 0 ? (
          <p className="text-cyan-100/40 text-[13px]">{t('cyberNoHistoryYet')}</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColCreated')}</th><th className={th}>{t('cyberRiskScoreLabel')}</th><th className={th}>{t('cyberOpenFindings')}</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className={td}>{formatDateTime(h.computed_at, lang)}</td>
                    <td className={td}><span className={scoreTone(h.risk_score)}>{h.risk_score ?? '—'}</span></td>
                    <td className={td}>{h.open_finding_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-cyan-100/70 text-xs tracking-widest uppercase">{t('cyberColReportsForAsset')}</h4>
        </div>
        <div className="flex gap-1.5 flex-wrap mb-2">
          {REPORT_TYPES.filter((rt) => rt !== 'AUDIT').map((rt) => (
            <button key={rt} className={btnCls} disabled={generatingReport} onClick={() => onGenerateReport(rt)}>{t('cyberGenerateBtn', { type: localizedValue(t, rt) })}</button>
          ))}
        </div>
        {reports && (reports.length === 0 ? (
          <p className="text-cyan-100/40 text-[13px]">{t('cyberNoneYet')}</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColType')}</th><th className={th}>{t('cyberColGenerated')}</th></tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{localizedValue(t, r.report_type)}</td>
                    <td className={td}>{formatDateTime(r.created_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {confirmingStatus && (
        <ConfirmBar
          body={confirmingStatus === 'ARCHIVED' ? t('cyberConfirmArchiveBody') : t('cyberConfirmRestoreBody')}
          confirmLabel={confirmingStatus === 'ARCHIVED' ? t('cyberYesArchive') : t('cyberYesRestore')}
          cancelLabel={t('cyberCancel')}
          onConfirm={() => applyStatus(confirmingStatus)}
          onCancel={() => setConfirmingStatus(null)}
        />
      )}

      <div className="flex gap-2 flex-wrap pt-2 border-t border-cyan-300/10">
        {!editing && <button className={btnCls} onClick={() => setEditing(true)}>{t('cyberEdit')}</button>}
        {a.status === 'ACTIVE' ? (
          <button className={btnCls} onClick={() => setConfirmingStatus('ARCHIVED')}>{t('cyberArchive')}</button>
        ) : (
          <button className={btnCls} onClick={() => setConfirmingStatus('ACTIVE')}>{t('cyberRestore')}</button>
        )}
      </div>
    </div>
  );
}

function AssetsTab({ t, lang }) {
  const [assets, setAssets] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [assetType, setAssetType] = useState(ASSET_TYPES[0]);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [confirmingAssetId, setConfirmingAssetId] = useState(null);
  const [busyAssetId, setBusyAssetId] = useState(null);

  function load() {
    cyberAnalysisApi.listAssets(showArchived ? 'ARCHIVED' : 'ACTIVE').then((r) => setAssets(r.assets)).catch((err) => setError(err.message));
  }
  useEffect(load, [showArchived]);

  async function onCreate() {
    if (!name.trim() || !target.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { asset } = await cyberAnalysisApi.createAsset({ name: name.trim(), assetType });
      // A real target/identifier is what lets risk scoring, coverage score,
      // the security graph and command-center analysis flow find this asset --
      // without it the asset would just be an inert name+type row, invisible
      // to the rest of BCI's intelligence pipeline (see IDENTIFIER_TYPE_BY_
      // ASSET_TYPE above).
      await cyberAnalysisApi.addAssetIdentifier(asset.id, {
        identifierType: IDENTIFIER_TYPE_BY_ASSET_TYPE[assetType] || assetType,
        value: target.trim(),
      });
      setName('');
      setTarget('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function archiveAsset(id) {
    setBusyAssetId(id);
    setError(null);
    try {
      await cyberAnalysisApi.updateAsset(id, { status: 'ARCHIVED' });
      if (selectedId === id) setSelectedId(null);
      setConfirmingAssetId(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAssetId(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberNavAssets')}</PageTitle>
      <ErrorNote error={error} />
      {selectedId && (
        <AssetDetail
          id={selectedId}
          t={t}
          lang={lang}
          onClose={() => setSelectedId(null)}
          onChanged={load}
        />
      )}
      <Panel title={t('cyberAddAsset')}>
        <div className="grid sm:grid-cols-4 gap-2">
          <input className={inputCls} placeholder={t('cyberNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inputCls} placeholder={t('cyberAssetTargetPlaceholder')} value={target} onChange={(e) => setTarget(e.target.value)} />
          <select className={inputCls} value={assetType} onChange={(e) => setAssetType(e.target.value)}>
            {ASSET_TYPES.map((at) => <option key={at} value={at}>{at}</option>)}
          </select>
          <button className={btnCls} onClick={onCreate} disabled={creating || !name.trim() || !target.trim()}>{t('cyberAddAssetBtn')}</button>
        </div>
      </Panel>
      <Panel
        title={t('cyberAssetsPanelTitle')}
        actions={
          <label className="flex items-center gap-2 text-[12px] text-cyan-100/60">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            {t('cyberShowArchived')}
          </label>
        }
      >
        {assets && (
          <div className={tableWrap}>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={th}>{t('cyberColName')}</th>
                  <th className={th}>{t('cyberColTarget')}</th>
                  <th className={th}>{t('cyberColType')}</th>
                  <th className={th}>{t('cyberColCriticality')}</th>
                  <th className={th}>{t('cyberColActions')}</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <React.Fragment key={a.id}>
                    <tr>
                      <td className={td}>{a.name}</td>
                      <td className={`${td} text-cyan-100/60`}>{a.target || '—'}</td>
                      <td className={td}>{a.asset_type}</td>
                      <td className={td}>{a.criticality}</td>
                      <td className={td}>
                        <div className="flex gap-1.5 flex-wrap">
                          <button className={btnCls} onClick={() => setSelectedId(a.id)}>{t('cyberSelect')}</button>
                          {!showArchived && <button className={btnCls} disabled={busyAssetId === a.id} onClick={() => setConfirmingAssetId(a.id)}>{t('cyberArchive')}</button>}
                          {showArchived && <button className={btnCls} disabled={busyAssetId === a.id} onClick={() => cyberAnalysisApi.updateAsset(a.id, { status: 'ACTIVE' }).then(load).catch((err) => setError(err.message))}>{t('cyberRestore')}</button>}
                        </div>
                      </td>
                    </tr>
                    {confirmingAssetId === a.id && <tr><td className={td} colSpan={5}><ConfirmBar body={t('cyberConfirmArchiveBody')} confirmLabel={t('cyberYesArchive')} cancelLabel={t('cyberCancel')} onConfirm={() => archiveAsset(a.id)} onCancel={() => setConfirmingAssetId(null)} /></td></tr>}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ─── Scans ──────────────────────────────────────────────────────────────
// NO_COVERAGE is its own real backend status (see bci/src/worker.js) --
// the job function finished without error, but analysisPlanner.js selected
// zero engines for this target type/class (e.g. DOMAIN + PASSIVE), so
// nothing was actually analyzed. It must never render the same as
// COMPLETED (which now only ever means at least one engine really ran) --
// "0 findings because nothing ran" and "0 findings because a real scan
// found nothing" are different facts and must look different.
function scanStatusTone(status) {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'NO_COVERAGE') return 'warn';
  if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status)) return 'danger';
  return 'warn';
}

function scanStatusLabel(t, status) {
  return localizedValue(t, status);
}

function isPartialScan(job, engineRuns) {
  if (job?.status !== 'COMPLETED') return false;
  if (Array.isArray(engineRuns)) return engineRuns.some((run) => run.status === 'COMPLETED') && engineRuns.some((run) => run.status !== 'COMPLETED');
  return Array.isArray(job?.result?.enginesSkipped) && job.result.enginesSkipped.length > 0 && (job.result.enginesRun?.length || 0) > 0;
}

const SCAN_TERMINAL_STATUSES = ['COMPLETED', 'NO_COVERAGE', 'FAILED', 'TIMED_OUT', 'CANCELLED'];
function ScansTab({ t, lang }) {
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  // Archive is reversible; delete removes the terminal job from both views
  // and redacts its stored result while retaining a minimal audit tombstone.
  const [archivedView, setArchivedView] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [busyJobId, setBusyJobId] = useState(null);

  function load() {
    cyberAnalysisApi.listScans(archivedView).then((r) => setJobs(r.jobs)).catch((err) => setError(err.message));
  }
  useEffect(load, [archivedView]);
  useEffect(() => {
    if (archivedView || !jobs?.some((job) => !SCAN_TERMINAL_STATUSES.includes(job.status))) return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [archivedView, jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runJobAction(jobId, action) {
    setBusyJobId(jobId);
    setActionError(null);
    try {
      await action();
      load();
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyJobId(null);
    }
  }

  function deleteScan(job) {
    if (!window.confirm(t('cyberScanDeleteConfirm', { target: job.target }))) return;
    runJobAction(job.id, () => cyberAnalysisApi.deleteScan(job.id));
    if (selectedJobId === job.id) setSelectedJobId(null);
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberNavScans')}</PageTitle>
      <ErrorNote error={error} />
      {selectedJobId && <ScanDetail id={selectedJobId} onClose={() => setSelectedJobId(null)} t={t} lang={lang} />}
      <Panel
        title={archivedView ? t('cyberScanArchivedTabLabel') : t('cyberScansPanelTitle')}
        actions={
          <div className="flex gap-1">
            <button className={archivedView ? btnCls : btnPrimaryCls} onClick={() => setArchivedView(false)}>{t('cyberScanActiveTabLabel')}</button>
            <button className={archivedView ? btnPrimaryCls : btnCls} onClick={() => setArchivedView(true)}>{t('cyberScanArchivedTabLabel')}</button>
          </div>
        }
      >
        <ErrorNote error={actionError} />
        {jobs && jobs.length === 0 && archivedView && <p className="text-cyan-100/50 text-sm">{t('cyberScanNoArchived')}</p>}
        {jobs && (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColClass')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberColAttempts')}</th><th className={th}>{t('cyberScanColActions')}</th></tr></thead>
              <tbody>
                {jobs.map((j) => {
                  const busy = busyJobId === j.id;
                  const stoppable = !SCAN_TERMINAL_STATUSES.includes(j.status);
                  return (
                    <React.Fragment key={j.id}>
                      <tr>
                        <td className={td}>{j.target}</td>
                        <td className={td}>{j.requested_class}</td>
                        <td className={td}><Badge tone={isPartialScan(j) ? 'warn' : scanStatusTone(j.status)}>{isPartialScan(j) ? t('cyberWizOutcomePartial') : scanStatusLabel(t, j.status)}</Badge></td>
                        <td className={td}>{j.attempts}</td>
                        <td className={td}>
                          <div className="flex gap-1.5 flex-wrap">
                            {stoppable && (
                              <button className={btnCls} disabled={busy} onClick={() => runJobAction(j.id, () => cyberAnalysisApi.cancelScan(j.id))}>{t('cyberScanStop')}</button>
                            )}
                            <button className={btnCls} onClick={() => setSelectedJobId(j.id)}>{t('cyberScanInspect')}</button>
                            {archivedView ? (
                              <button className={btnCls} disabled={busy} onClick={() => runJobAction(j.id, () => cyberAnalysisApi.unarchiveScan(j.id))}>{t('cyberScanUnarchive')}</button>
                            ) : (
                              <button className={btnCls} disabled={busy} onClick={() => runJobAction(j.id, () => cyberAnalysisApi.archiveScan(j.id))}>{t('cyberScanArchive')}</button>
                            )}
                            {!stoppable && <button className={`${btnCls} !border-red-400/40 !text-red-300`} disabled={busy} onClick={() => deleteScan(j)}>{t('cyberDelete')}</button>}
                          </div>
                        </td>
                      </tr>
                      {j.status === 'NO_COVERAGE' && (
                        <tr>
                          <td className={td} colSpan={5}>
                            <p className="text-gold/70 text-[11px] normal-case">{t('cyberScanNoCoverageDetail')}</p>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// "İncele" -- a read-only view onto one scan job's real, persisted results
// (engine runs, findings for its target, and any Smart Resilience/Fuzz/
// Intrusive round data), reachable from the Scans list at any time -- not
// only while the wizard that started it happens to still be mounted (see
// CyberNewAnalysisWizard.jsx, whose own job/results state is local and
// disappears the moment it closes).
function ScanDetail({ id, onClose, t, lang }) {
  const [job, setJob] = useState(null);
  const [engineRuns, setEngineRuns] = useState(null);
  const [findings, setFindings] = useState(null);
  const [resilienceRounds, setResilienceRounds] = useState([]);
  const [fuzzExecutions, setFuzzExecutions] = useState([]);
  const [intrusiveExecutions, setIntrusiveExecutions] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let disposed = false;
    let timer;
    setJob(null);
    const refresh = async () => {
      try {
        const [{ job: latest }, runs, scanFindings, resilience, fuzz, intrusive] = await Promise.all([
          cyberAnalysisApi.getScan(id),
          cyberAnalysisApi.getScanEngineRuns(id),
          cyberAnalysisApi.getScanFindings(id),
          cyberAnalysisApi.getScanResilienceRounds(id).catch(() => ({ rounds: [] })),
          cyberAnalysisApi.getScanFuzzResults(id).catch(() => ({ executions: [] })),
          cyberAnalysisApi.getScanIntrusiveResults(id).catch(() => ({ executions: [] })),
        ]);
        if (disposed) return;
        setJob(latest); setEngineRuns(runs.engineRuns); setFindings(scanFindings.findings);
        setResilienceRounds(resilience.rounds); setFuzzExecutions(fuzz.executions); setIntrusiveExecutions(intrusive.executions);
        if (!SCAN_TERMINAL_STATUSES.includes(latest.status)) timer = setTimeout(refresh, 3000);
      } catch (err) {
        if (!disposed) setError(err.message);
      }
    };
    refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [id]);

  if (!job) {
    return (
      <div className="hud-panel rounded-xl p-4 sm:p-5 space-y-3">
        <ErrorNote error={error} />
        <p className="text-cyan-100/60 text-sm">{t('cyberLoading')}</p>
      </div>
    );
  }

  const hasResilience = resilienceRounds.length > 0;
  const hasFuzz = fuzzExecutions.some((e) => e.probes?.length > 0);
  const hasIntrusive = intrusiveExecutions.some((e) => e.records?.length > 0);
  const exportReport = buildScanExportReport({ job, engineRuns: engineRuns || [], findings: findings || [], resilienceRounds, fuzzExecutions, intrusiveExecutions }, { translate: t, locale: lang });

  return (
    <div className="hud-panel rounded-xl p-4 sm:p-5 space-y-4">
      <div className="flex justify-between items-start gap-3">
        <div>
          <h3 className="text-cyan-100 text-sm">{t('cyberScanDetailTitle')}</h3>
          <p className="text-cyan-100/50 text-xs">{job.target} · {job.requested_class} · <Badge tone={isPartialScan(job, engineRuns) ? 'warn' : scanStatusTone(job.status)}>{isPartialScan(job, engineRuns) ? t('cyberWizOutcomePartial') : scanStatusLabel(t, job.status)}</Badge></p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end"><ExportActions t={t} report={exportReport} onError={setError} /><button className={btnCls} onClick={onClose}>{t('cyberClose')}</button></div>
      </div>

      <div>
        <p className="text-cyan-100/40 text-xs uppercase tracking-widest mb-2">{t('cyberScanEngineRunsTitle')}</p>
        {engineRuns && engineRuns.length > 0 ? (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberWizObservations')}</th></tr></thead>
              <tbody>
                {engineRuns.map((r) => (
                  <tr key={r.engine_id}>
                    <td className={td}>{r.engine_id}</td>
                    <td className={td} title={r.detail || ''}><Badge tone={r.status === 'COMPLETED' ? 'ok' : ['RUNNING', 'SKIPPED'].includes(r.status) ? 'warn' : 'danger'}>{localizedValue(t, r.status)}</Badge></td>
                    <td className={td}>{r.observation_count || 0}{r.status === 'RUNNING' && r.detail ? (() => { try { const p = JSON.parse(r.detail); return p.total ? ` / ${p.total}` : ''; } catch { return ''; } })() : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-cyan-100/50 text-sm">{t('cyberScanNoData')}</p>}
      </div>

      <div>
        <p className="text-cyan-100/40 text-xs uppercase tracking-widest mb-2">{t('cyberScanFindingsTitle')}</p>
        {findings === null ? (
          <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>
        ) : findings.length > 0 ? (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColTitle')}</th><th className={th}>{t('cyberColPriority')}</th><th className={th}>{t('cyberColRisk')}</th><th className={th}>{t('cyberColStatus')}</th></tr></thead>
              <tbody>
                {findings.map((f) => (
                  <tr key={f.id}>
                    <td className={td}>{f.title}</td>
                    <td className={td}>{f.priority && <Badge tone={priorityTone(f.priority)}>{localizedValue(t, f.priority)}</Badge>}</td>
                    <td className={td}>{f.risk_score ?? '—'}</td>
                    <td className={td}>{localizedValue(t, f.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-cyan-100/50 text-sm">{t('cyberScanNoData')}</p>}
      </div>

      {hasResilience && (
        <div>
          <p className="text-cyan-100/40 text-xs uppercase tracking-widest mb-2">{t('cyberScanResilienceRoundsTitle')}</p>
          <div className="space-y-2">
            {resilienceRounds.map((round, index) => (
              <div key={`${round.module}-${round.source}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px]">
                <Badge tone={['STABLE', 'RECOVERED'].includes(round.status) ? 'ok' : round.status === 'INCONCLUSIVE' ? 'muted' : 'warn'}>{localizedValue(t, round.status)}</Badge> · {round.module} · {localizedValue(t, round.source)}
              </div>
            ))}
          </div>
        </div>
      )}

      {hasFuzz && (
        <div>
          <p className="text-cyan-100/40 text-xs uppercase tracking-widest mb-2">{t('cyberScanFuzzResultsTitle')}</p>
          <div className="space-y-2">
            {fuzzExecutions.flatMap((e) => e.probes || []).map((probe, index) => (
              <div key={`${probe.type}-${probe.endpoint}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px]">
                <Badge tone={probe.anomalous ? 'warn' : 'ok'}>{probe.source || probe.type}</Badge> · {probe.method} {probe.endpoint} {probe.parameter ? `· ${probe.parameter}` : ''}
              </div>
            ))}
          </div>
        </div>
      )}

      {hasIntrusive && (
        <div>
          <p className="text-cyan-100/40 text-xs uppercase tracking-widest mb-2">{t('cyberScanIntrusiveResultsTitle')}</p>
          <div className="space-y-2">
            {intrusiveExecutions.flatMap((e) => e.records || []).map((record, index) => (
              <div key={`${record.module}-${record.source}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px]">
                <Badge tone={record.verificationStatus === 'VERIFIED' ? 'ok' : record.verificationStatus === 'ERROR' ? 'danger' : 'muted'}>{localizedValue(t, record.verificationStatus)}</Badge> · {record.module} · {localizedValue(t, record.source)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Findings ───────────────────────────────────────────────────────────
function priorityTone(priority) {
  if (priority === 'IMMEDIATE') return 'danger';
  if (priority === '24_HOURS' || priority === 'HIGH_PRIORITY') return 'warn';
  return 'muted';
}

function FindingDetail({ id, onClose, onChanged, t }) {
  const [finding, setFinding] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [verifyResult, setVerifyResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  function load() {
    cyberAnalysisApi.getFinding(id).then(setFinding).catch((err) => setError(err.message));
  }
  useEffect(load, [id]);

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!finding) return <div className="hud-panel rounded-xl p-4 text-cyan-100/60 text-sm">{t('cyberLoading')}</div>;
  const { finding: f, sources = [] } = finding;
  const exportReport = buildFindingExportReport({ finding: f, sources });

  return (
    <div className="hud-panel rounded-xl p-4 sm:p-5 space-y-3">
      <div className="flex justify-between items-start gap-3">
        <div>
          <h3 className="text-cyan-100 text-sm">{f.title}</h3>
          <p className="text-cyan-100/50 text-xs">{f.target} · {f.category}</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end"><ExportActions t={t} report={exportReport} onError={setError} /><button className={btnCls} onClick={onClose}>{t('cyberClose')}</button></div>
      </div>
      <ErrorNote error={error} />
      <div className="grid grid-cols-4 gap-2">
        <Tile label={t('cyberColRisk')} value={f.risk_score ?? '—'} />
        <Tile label={t('cyberColConfidence')} value={f.confidence_score} />
        <Tile label={t('cyberColStatus')} value={f.status} />
        <Tile label={t('cyberColVerification')} value={f.verification_status} />
      </div>
      <p className="text-cyan-100/70 text-[13px]"><strong>{t('cyberSourcesLabel')}</strong> {sources.map((s) => s.engine_id).join(', ') || t('cyberSourcesNone')}</p>
      <div className="flex gap-2 flex-wrap">
        <button className={btnCls} disabled={busy} onClick={() => run(async () => setExplanation(await cyberAnalysisApi.explainFinding(id)))}>{t('cyberExplain')}</button>
        <button className={btnCls} disabled={busy} onClick={() => run(async () => setVerifyResult(await cyberAnalysisApi.verifyFindingFix(id)))}>{t('cyberVerifyFix')}</button>
        <button className={btnCls} disabled={busy} onClick={() => run(() => cyberAnalysisApi.confirmFinding(id))}>{t('cyberConfirm')}</button>
        <button className={btnCls} disabled={busy} onClick={() => run(() => cyberAnalysisApi.markFalsePositive(id))}>{t('cyberMarkFalsePositive')}</button>
      </div>
      {explanation && <p className="text-cyan-100/70 text-[13px] border border-cyan-300/20 rounded p-2">{explanation.text} <em className="text-cyan-100/40">({explanation.source})</em></p>}
      {verifyResult && <p className="text-cyan-100/70 text-[13px] border border-cyan-300/20 rounded p-2">{t('cyberVerifyResultLabel')} <strong>{verifyResult.result}</strong> — {verifyResult.detail}</p>}
    </div>
  );
}

function FindingsTab({ t, lang }) {
  const [analyses, setAnalyses] = useState(null);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(null);
  const [findings, setFindings] = useState(null);
  const [selectedFindingId, setSelectedFindingId] = useState(null);
  const [error, setError] = useState(null);

  function load() {
    Promise.all([cyberAnalysisApi.listScans(false), cyberAnalysisApi.listScans(true)])
      .then(([active, archived]) => setAnalyses([...active.jobs, ...archived.jobs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))))
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function inspectAnalysis(id) {
    if (selectedAnalysisId === id) {
      setSelectedAnalysisId(null);
      setFindings(null);
      setSelectedFindingId(null);
      return;
    }
    setSelectedAnalysisId(id);
    setSelectedFindingId(null);
    setFindings(null);
    setError(null);
    try {
      const result = await cyberAnalysisApi.getScanFindings(id);
      setFindings(result.findings);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reloadSelectedFindings() {
    if (!selectedAnalysisId) return;
    const result = await cyberAnalysisApi.getScanFindings(selectedAnalysisId);
    setFindings(result.findings);
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberNavFindings')}</PageTitle>
      <ErrorNote error={error} />
      <Panel title={t('cyberFindingAnalysesTitle')}>
        {analyses && analyses.length === 0 ? <p className="text-cyan-100/50 text-sm">{t('cyberNoAnalyses')}</p> : analyses && (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColClass')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberFindingCount')}</th><th className={th}>{t('cyberColCreated')}</th><th className={th}>{t('cyberScanColActions')}</th></tr></thead>
              <tbody>
                {analyses.map((analysis) => (
                  <React.Fragment key={analysis.id}>
                    <tr>
                      <td className={td}>{analysis.target}</td>
                      <td className={td}>{localizedValue(t, analysis.requested_class)}</td>
                      <td className={td}><Badge tone={isPartialScan(analysis) ? 'warn' : scanStatusTone(analysis.status)}>{isPartialScan(analysis) ? t('cyberWizOutcomePartial') : scanStatusLabel(t, analysis.status)}</Badge></td>
                      <td className={td}>{analysis.finding_count ?? 0}</td>
                      <td className={td}>{formatDateTime(analysis.created_at, lang)}</td>
                      <td className={td}><button className={btnCls} onClick={() => inspectAnalysis(analysis.id)}>{selectedAnalysisId === analysis.id ? t('cyberClose') : t('cyberScanInspect')}</button></td>
                    </tr>
                    {selectedAnalysisId === analysis.id && (
                      <tr><td className={td} colSpan={6}>
                        <div className="space-y-3 py-2">
                          <h3 className="text-cyan-100 text-sm">{t('cyberAnalysisFindingsFor', { target: analysis.target })}</h3>
                          {selectedFindingId && <FindingDetail id={selectedFindingId} onClose={() => setSelectedFindingId(null)} onChanged={reloadSelectedFindings} t={t} />}
                          {findings === null ? <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p> : findings.length === 0 ? <p className="text-cyan-100/50 text-sm">{t('cyberAnalysisNoFindings')}</p> : (
                            <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{t('cyberColTitle')}</th><th className={th}>{t('cyberColPriority')}</th><th className={th}>{t('cyberColRisk')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberScanColActions')}</th></tr></thead><tbody>{findings.map((finding) => <tr key={finding.id}><td className={td}>{finding.title}</td><td className={td}>{finding.priority && <Badge tone={priorityTone(finding.priority)}>{localizedValue(t, finding.priority)}</Badge>}</td><td className={td}>{finding.risk_score ?? '—'}</td><td className={td}>{localizedValue(t, finding.status)}</td><td className={td}><button className={btnCls} onClick={() => setSelectedFindingId(finding.id)}>{t('cyberScanInspect')}</button></td></tr>)}</tbody></table></div>
                          )}
                        </div>
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ─── Reports ────────────────────────────────────────────────────────────
const REPORT_TYPES = ['EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT', 'FULL'];

function ReportsTab({ t, lang }) {
  const [reports, setReports] = useState(null);
  const [assets, setAssets] = useState(null);
  const [assetFilter, setAssetFilter] = useState('');
  const [generateAssetId, setGenerateAssetId] = useState('');
  const [reportScope, setReportScope] = useState('SCAN');
  const [assetScans, setAssetScans] = useState([]);
  const [generateScanJobId, setGenerateScanJobId] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [actionBusy, setActionBusy] = useState(null);

  function load() {
    cyberAnalysisApi.listReports(assetFilter || undefined).then((r) => setReports(r.reports)).catch((err) => setError(err.message));
  }
  useEffect(load, [assetFilter]);
  useEffect(() => { cyberAnalysisApi.listAssets().then((r) => setAssets(r.assets)).catch(() => {}); }, []);
  useEffect(() => {
    setGenerateScanJobId('');
    setAssetScans([]);
    if (!generateAssetId) return;
    Promise.all([
      cyberAnalysisApi.getAsset(generateAssetId),
      cyberAnalysisApi.listScans(false),
      cyberAnalysisApi.listScans(true),
    ]).then(([assetResult, active, archived]) => {
      const targets = new Set((assetResult.identifiers || []).map((identifier) => identifier.value));
      setAssetScans([...active.jobs, ...archived.jobs]
        .filter((scan) => targets.has(scan.target))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
    }).catch((err) => setError(err.message));
  }, [generateAssetId]);

  function assetName(assetId) {
    if (!assetId) return '—';
    return assets?.find((a) => a.id === assetId)?.name || assetId;
  }

  async function onGenerate(reportType) {
    setGenerating(true);
    setError(null);
    try {
      // AUDIT is deliberately never asset-scoped (see reports/builders.js) --
      // its own ledger covers org-level activity a single asset can't
      // meaningfully narrow.
      await cyberAnalysisApi.generateReport(reportType, {
        ...(reportType !== 'AUDIT' && generateAssetId ? { assetId: generateAssetId } : {}),
        ...(reportType !== 'AUDIT' && reportScope === 'SCAN' && generateScanJobId ? { scanJobId: generateScanJobId } : {}),
        language: lang,
      });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function view(id) {
    setSelected(await cyberAnalysisApi.getReport(id));
  }

  async function archive(item) {
    setActionBusy(item.id);
    setError(null);
    try {
      await cyberAnalysisApi.archiveReport(item.id);
      if (selected?.report?.id === item.id) setSelected(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionBusy(null);
    }
  }

  async function remove(item) {
    if (!window.confirm(t('cyberReportDeleteConfirm', { type: localizedValue(t, item.report_type) }))) return;
    setActionBusy(item.id);
    setError(null);
    try {
      await cyberAnalysisApi.deleteReport(item.id);
      if (selected?.report?.id === item.id) setSelected(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberNavReports')}</PageTitle>
      <ErrorNote error={error} />
      <Panel title={t('cyberGenerateReport')}>
        <div className="grid gap-2 sm:grid-cols-3 mb-2">
          <div>
            <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberReportScope')}</label>
            <select className={inputCls} value={reportScope} onChange={(e) => setReportScope(e.target.value)}>
              <option value="SCAN">{t('cyberReportScopeScan')}</option>
              <option value="ASSET_HISTORY">{t('cyberReportScopeAssetHistory')}</option>
            </select>
          </div>
          <div>
          <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberColAsset')}</label>
          <select className={inputCls} value={generateAssetId} onChange={(e) => setGenerateAssetId(e.target.value)}>
            <option value="">{reportScope === 'SCAN' ? t('cyberSelectAsset') : t('cyberAllAssets')}</option>
            {assets?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          </div>
          {reportScope === 'SCAN' && <div>
            <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberReportAnalysis')}</label>
            <select className={inputCls} value={generateScanJobId} onChange={(e) => setGenerateScanJobId(e.target.value)} disabled={!generateAssetId}>
              <option value="">{t('cyberSelectAnalysis')}</option>
              {assetScans.map((scan) => <option key={scan.id} value={scan.id}>{formatDateTime(scan.created_at, lang)} · {localizedValue(t, scan.requested_class)} · {localizedValue(t, scan.status)}</option>)}
            </select>
          </div>}
        </div>
        {reportScope === 'SCAN' && generateAssetId && assetScans.length === 0 && <p className="text-amber-200/70 text-xs mb-2">{t('cyberNoAssetAnalyses')}</p>}
        <div className="flex gap-2 flex-wrap">
          {REPORT_TYPES.map((rt) => (
            <button key={rt} className={btnCls} disabled={generating || (rt !== 'AUDIT' && reportScope === 'SCAN' && !generateScanJobId)} onClick={() => onGenerate(rt)}>{t('cyberGenerateBtn', { type: localizedValue(t, rt) })}</button>
          ))}
        </div>
      </Panel>

      {selected && (
        <Panel title={localizedValue(t, selected.report.report_type)} actions={<div className="flex gap-2 flex-wrap"><ExportActions t={t} report={buildBciReportExport(selected.report, { translate: t, locale: lang })} onError={setError} /><button className={btnCls} onClick={() => setSelected(null)}>{t('cyberClose')}</button></div>}>
          <p className="text-cyan-100/50 text-xs mb-2">
            {t('cyberHashLabel')} {selected.report.content_hash.slice(0, 16)}… · {t('cyberIntegrityLabel')}{' '}
            <Badge tone={selected.report.integrityValid ? 'ok' : 'danger'}>{selected.report.integrityValid ? t('cyberIntegrityValid') : t('cyberIntegrityTampered')}</Badge>
            {selected.report.asset_id && <> · {t('cyberColAsset')}: {assetName(selected.report.asset_id)}</>}
            {selected.report.scan_job_id && <> · {t('cyberReportAnalysis')}: {selected.report.scan_job_id}</>}
          </p>
          <div className="max-h-[520px] overflow-auto text-cyan-100/70 border border-cyan-300/15 rounded p-3">
            <ReportValue value={selected.report.content} t={t} lang={lang} />
          </div>
        </Panel>
      )}

      <Panel
        title={t('cyberReportsPanelTitle')}
        actions={
          <select className={`${inputCls} w-auto`} value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
            <option value="">{t('cyberAllAssets')}</option>
            {assets?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        }
      >
        {reports && (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColType')}</th><th className={th}>{t('cyberColAsset')}</th><th className={th}>{t('cyberReportAnalysis')}</th><th className={th}>{t('cyberColGenerated')}</th><th className={th}>{t('cyberColBciVersion')}</th><th className={th}></th></tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{localizedValue(t, r.report_type)}</td>
                    <td className={`${td} text-cyan-100/60`}>{assetName(r.asset_id)}</td>
                    <td className={`${td} text-cyan-100/60`}>{r.scan_job_id ? `${r.scan_job_id.slice(0, 8)}…` : t('cyberReportScopeAssetHistory')}</td>
                    <td className={td}>{formatDateTime(r.created_at, lang)}</td>
                    <td className={td}>{r.bci_version}</td>
                    <td className={td}><div className="flex gap-2">
                      <button className={btnCls} disabled={actionBusy === r.id} onClick={() => view(r.id)}>{t('cyberView')}</button>
                      <button className={btnCls} disabled={actionBusy === r.id} onClick={() => archive(r)}>{t('cyberArchive')}</button>
                      <button className={`${btnCls} !border-red-400/40 !text-red-300`} disabled={actionBusy === r.id} onClick={() => remove(r)}>{t('cyberDelete')}</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ─── Engines ────────────────────────────────────────────────────────────
function engineStatusTone(status) {
  if (status === 'HEALTHY') return 'ok';
  if (status === 'DEGRADED') return 'warn';
  return 'danger';
}

function EnginesTab({ t, lang }) {
  const [engines, setEngines] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  function load() {
    cyberAnalysisApi.listEngines().then((r) => setEngines(r.engines)).catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function onHealthCheck() {
    setChecking(true);
    setError(null);
    try {
      await cyberAnalysisApi.runEngineHealthCheck();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberNavEngines')}</PageTitle>
      <GuideNote>{t('cyberEnginesGuideNote')}</GuideNote>
      <ErrorNote error={error} />
      <Panel title={t('cyberEnginesPanelTitle')} actions={<button className={btnCls} disabled={checking} onClick={onHealthCheck}>{checking ? t('cyberChecking') : t('cyberRunHealthCheck')}</button>}>
        {engines && (
          <div className={tableWrap}>
            <table className="w-full">
              <thead><tr><th className={th}>{t('cyberColEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberColVersion')}</th><th className={th}>{t('cyberColIntrusiveness')}</th><th className={th}>{t('cyberColLicense')}</th><th className={th}>{t('cyberColLastChecked')}</th></tr></thead>
              <tbody>
                {engines.map((e) => (
                  <tr key={e.id}>
                    <td className={td}>{e.name}</td>
                    <td className={td}><Badge tone={engineStatusTone(e.status)}>{e.status || t('cyberUnknown')}</Badge></td>
                    <td className={td}>{e.version || '—'}</td>
                    <td className={td}>{e.intrusiveness}</td>
                    <td className={td}>{e.license}</td>
                    <td className={td}>{e.last_checked_at ? formatDateTime(e.last_checked_at, lang) : t('cyberNever')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ─── Quantum & PQC ──────────────────────────────────────────────────────
function QuantumTab({ t, lang }) {
  const [providers, setProviders] = useState([]);
  const [policy, setPolicy] = useState(null);
  const [benchmarks, setBenchmarks] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [cbom, setCbom] = useState(null);
  const [error, setError] = useState(null);

  const [effortBudget, setEffortBudget] = useState(10);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState(null);

  const [discoverTarget, setDiscoverTarget] = useState('');
  const [discoverPort, setDiscoverPort] = useState('');
  const [discoverProtocol, setDiscoverProtocol] = useState('TLS');
  const [discovering, setDiscovering] = useState(false);

  const [jwtToken, setJwtToken] = useState('');
  const [jwtDiscovering, setJwtDiscovering] = useState(false);

  function load() {
    Promise.all([
      cyberAnalysisApi.listQuantumProviders(),
      cyberAnalysisApi.getQuantumPolicy(),
      cyberAnalysisApi.listQuantumBenchmarks(),
      cyberAnalysisApi.listQuantumJobs(),
      cyberAnalysisApi.listCryptoInventory(),
      cyberAnalysisApi.getPqcReadiness(),
      cyberAnalysisApi.getCbom(),
    ])
      .then(([p, pol, b, j, inv, r, c]) => {
        setProviders(p.providers);
        setPolicy(pol.policy);
        setBenchmarks(b.benchmarks);
        setJobs(j.jobs);
        setInventory(inv.findings);
        setReadiness(r);
        setCbom(c);
      })
      .catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function onSavePolicy() {
    setError(null);
    try {
      await cyberAnalysisApi.setQuantumPolicy(policy);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function onOptimize() {
    setOptimizing(true);
    setError(null);
    try {
      const result = await cyberAnalysisApi.runRemediationOptimize(Number(effortBudget));
      setOptimizeResult(result);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setOptimizing(false);
    }
  }

  async function onDiscover() {
    if (!discoverTarget.trim()) return;
    setDiscovering(true);
    setError(null);
    try {
      await cyberAnalysisApi.discoverCrypto(discoverTarget.trim(), discoverPort ? Number(discoverPort) : undefined, discoverProtocol);
      setDiscoverTarget('');
      setDiscoverPort('');
      load();
    } catch (err) {
      setError(err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message);
    } finally {
      setDiscovering(false);
    }
  }

  async function onDiscoverJwt() {
    if (!jwtToken.trim()) return;
    setJwtDiscovering(true);
    setError(null);
    try {
      await cyberAnalysisApi.discoverJwtCrypto(jwtToken.trim());
      setJwtToken('');
      load();
    } catch (err) {
      setError(err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message);
    } finally {
      setJwtDiscovering(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageTitle>{t('cyberTitleQuantum')}</PageTitle>
      <GuideNote>{t('cyberQuantumGuideNote')}</GuideNote>
      <ErrorNote error={error} />
      <p className="text-cyan-100/50 text-[13px]">{t('cyberQuantumIntro')}</p>

      <Panel title={t('cyberQuantumGatewayTitle')}>
        <div className={tableWrap}>
          <table className="w-full">
            <thead><tr><th className={th}>{t('cyberColProvider')}</th><th className={th}>{t('cyberColHealth')}</th><th className={th}>{t('cyberColDetail')}</th></tr></thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td className={td}>{p.id}</td>
                  <td className={td}><Badge tone={p.status === 'AVAILABLE' ? 'ok' : p.status === 'DEGRADED' ? 'warn' : p.status === 'NOT_CONFIGURED' ? 'muted' : 'danger'}>{p.status}</Badge></td>
                  <td className={`${td} text-cyan-100/40`}>{p.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {policy && (
          <div className="flex flex-wrap items-end gap-4 mt-4 pt-4 border-t border-cyan-300/10">
            <label className="flex items-center gap-2 text-[13px] text-cyan-100/80">
              <input type="checkbox" checked={policy.allowQuantumSimulator} onChange={(e) => setPolicy({ ...policy, allowQuantumSimulator: e.target.checked })} />
              {t('cyberAllowSimulator')}
            </label>
            <label className="flex items-center gap-2 text-[13px] text-cyan-100/80">
              <input type="checkbox" checked={policy.allowQuantumHardware} onChange={(e) => setPolicy({ ...policy, allowQuantumHardware: e.target.checked })} />
              {t('cyberAllowHardware')}
            </label>
            <div>
              <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberMaxClassification')}</label>
              <select className={inputCls} value={policy.maxExternalDataClassification} onChange={(e) => setPolicy({ ...policy, maxExternalDataClassification: e.target.value })}>
                {['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button className={btnPrimaryCls} onClick={onSavePolicy}>{t('cyberSavePolicy')}</button>
          </div>
        )}
      </Panel>

      <Panel title={t('cyberOptimizationsTitle')}>
        <div className="flex items-end gap-2 mb-3">
          <div>
            <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberEffortBudget')}</label>
            <input type="number" min="1" className={inputCls} value={effortBudget} onChange={(e) => setEffortBudget(e.target.value)} />
          </div>
          <button className={btnCls} disabled={optimizing} onClick={onOptimize}>{optimizing ? t('cyberRunning') : t('cyberRunOptimizer')}</button>
        </div>
        {optimizeResult && (
          <div className="border border-cyan-300/20 rounded p-3 text-[13px] space-y-1">
            <div>{t('cyberVerdictLabel')} <Badge tone={optimizeResult.verdict === 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' ? 'ok' : 'muted'}>{optimizeResult.verdict || 'N/A'}</Badge></div>
            {optimizeResult.note && <div className="text-cyan-100/40">{optimizeResult.note}</div>}
            {optimizeResult.optimizationObjective != null && (
              <div title="The optimizer's own objective value for the selected findings -- not a measured real-world risk reduction.">
                {t('cyberOptimizationObjectiveLabel')} {optimizeResult.optimizationObjective}
              </div>
            )}
            {optimizeResult.selection?.length > 0 && (
              <ul className="list-disc list-inside text-cyan-100/70">
                {optimizeResult.selection.map((s) => <li key={s.id || s.title}>{s.title || s.id}</li>)}
              </ul>
            )}
          </div>
        )}

        <h3 className="text-cyan-100/70 text-xs tracking-widest uppercase mt-4 mb-2">{t('cyberRecentBenchmarks')}</h3>
        <div className={tableWrap}>
          <table className="w-full">
            <thead><tr><th className={th}>{t('cyberColSource')}</th><th className={th}>{t('cyberColVerdict')}</th><th className={th}>{t('cyberColCreated')}</th></tr></thead>
            <tbody>
              {benchmarks.map((b) => (
                <tr key={b.id}>
                  <td className={td}>{b.workload_source}</td>
                  <td className={td}><Badge tone={b.verdict === 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' ? 'ok' : 'muted'}>{b.verdict}</Badge></td>
                  <td className={td}>{formatDateTime(b.created_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="text-cyan-100/70 text-xs tracking-widest uppercase mt-4 mb-2">{t('cyberQuantumJobs')}</h3>
        <div className={tableWrap}>
          <table className="w-full">
            <thead><tr><th className={th}>{t('cyberColProvider')}</th><th className={th}>{t('cyberColMode')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberColFallbackReason')}</th><th className={th}>{t('cyberColSubmitted')}</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className={td}>{j.provider}</td>
                  <td className={td}>{j.mode || '—'}</td>
                  <td className={td}><Badge tone={j.status === 'COMPLETED' ? 'ok' : j.status === 'FAILED' ? 'danger' : 'muted'}>{j.status}</Badge></td>
                  <td className={`${td} text-cyan-100/40`}>{j.fallback_reason || '—'}</td>
                  <td className={td}>{formatDateTime(j.submitted_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={t('cyberPostQuantumSecurity')}>
        <div className="grid sm:grid-cols-4 gap-2 mb-2">
          <select className={inputCls} value={discoverProtocol} onChange={(e) => setDiscoverProtocol(e.target.value)}>
            <option value="TLS">TLS</option>
            <option value="SSH">SSH</option>
          </select>
          <input className={inputCls} placeholder="example.com" value={discoverTarget} onChange={(e) => setDiscoverTarget(e.target.value)} />
          <input className={inputCls} type="number" placeholder={discoverProtocol === 'SSH' ? '22' : '443'} value={discoverPort} onChange={(e) => setDiscoverPort(e.target.value)} />
          <button className={btnCls} disabled={discovering || !discoverTarget.trim()} onClick={onDiscover}>{discovering ? t('cyberProbing') : t('cyberDiscoverCrypto')}</button>
        </div>
        <p className="text-cyan-100/40 text-xs mb-3">{t('cyberCryptoScopeNote')}</p>

        <div className="flex gap-2 mb-4">
          <input className={inputCls} placeholder={t('cyberJwtPlaceholder')} value={jwtToken} onChange={(e) => setJwtToken(e.target.value)} />
          <button className={btnCls} disabled={jwtDiscovering || !jwtToken.trim()} onClick={onDiscoverJwt}>{jwtDiscovering ? t('cyberDecoding') : t('cyberDiscoverJwt')}</button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Tile label={t('cyberPqcReadinessScore')} value={readiness?.readinessScore ?? '—'} tone={scoreTone(readiness?.readinessScore)} />
          <Tile label={t('cyberQuantumVulnerable')} value={readiness?.quantumVulnerableCount ?? '—'} />
          <Tile label={t('cyberUnclassified')} value={readiness?.unclassifiedCount ?? '—'} />
          <Tile label={t('cyberCbomComponents')} value={cbom?.componentCount ?? '—'} />
        </div>
        {readiness?.note && <p className="text-cyan-100/40 text-xs mb-3">{readiness.note}</p>}

        <h3 className="text-cyan-100/70 text-xs tracking-widest uppercase mb-2">{t('cyberCryptoInventory')}</h3>
        <div className={tableWrap}>
          <table className="w-full">
            <thead><tr><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColAlgorithm')}</th><th className={th}>{t('cyberColKeySize')}</th><th className={th}>{t('cyberColQuantumVulnerable')}</th><th className={th}>{t('cyberColDiscovered')}</th></tr></thead>
            <tbody>
              {inventory.map((f) => (
                <tr key={f.id}>
                  <td className={td}>{f.target}</td>
                  <td className={td}>{f.algorithm_id}</td>
                  <td className={td}>{f.key_size_bits ?? '—'}</td>
                  <td className={td}><Badge tone={f.quantum_vulnerable === true ? 'danger' : f.quantum_vulnerable === false ? 'ok' : 'muted'}>{f.quantum_vulnerable === null ? t('cyberUnknown') : String(f.quantum_vulnerable)}</Badge></td>
                  <td className={td}>{formatDateTime(f.discovered_at, lang)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="text-cyan-100/70 text-xs tracking-widest uppercase mt-4 mb-2">{t('cyberMigrationRoadmap')}</h3>
        <div className={tableWrap}>
          <table className="w-full">
            <thead><tr><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColAlgorithm')}</th><th className={th}>{t('cyberColPriority')}</th><th className={th}>{t('cyberColHarvestNowDecryptLater')}</th></tr></thead>
            <tbody>
              {(readiness?.roadmap || []).map((r) => (
                <tr key={r.target}>
                  <td className={td}>{r.target}</td>
                  <td className={td}>{r.algorithmId}</td>
                  <td className={td}>{r.priority}</td>
                  <td className={td}>{r.harvestNowDecryptLater ? <Badge tone="warn">{t('cyberFutureExposure')}</Badge> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

const CONTROLLED_PROOF_IMPACT_LABELS = {
  NO_PATH: 'cyberControlledProofNoPath',
  POTENTIAL: 'cyberControlledProofPotential',
  VERIFIED_IMPACT_PATH: 'cyberControlledProofVerifiedPath',
};

function ControlledProofCoverage({ t, evidence }) {
  if (!evidence) return null;
  const delivery = evidence.deliveryProviderDiscovery;
  const selection = evidence.publicVisibilitySelection;
  const rejectionSource = evidence.candidateRejectionSummary?.length ? evidence.candidateRejectionSummary : evidence.candidateRejections || [];
  const groupedRejections = Object.values(rejectionSource.reduce((groups, rejection) => {
    const key = `${rejection.engineId || 'unknown'}:${rejection.reason || 'UNKNOWN'}`;
    groups[key] ||= { ...rejection, count: 0 };
    groups[key].count += Number(rejection.count) || 1;
    return groups;
  }, {}));
  return <div className="mt-4 pt-3 border-t border-cyan-300/15 space-y-1 text-sm text-cyan-100/70">
    {evidence.canonicalTarget && <p><strong>{t('cyberControlledProofCanonicalTarget')}:</strong> {evidence.canonicalTarget}</p>}
    <p><strong>{t('cyberControlledProofEndpoints')}:</strong> {evidence.endpointsDiscovered ?? 0}</p>
    <p><strong>{t('cyberControlledProofMatchedEvidence')}:</strong> {evidence.evidenceObservationsMatched ?? 0}</p>
    <p><strong>{t('cyberControlledProofImpactSignals')}:</strong> {evidence.evidenceImpactSignalsMatched ?? 0}</p>
    <p><strong>{t('cyberControlledProofCandidates')}:</strong> {evidence.evidenceCandidatesResolved ?? 0}</p>
    {delivery && <><p><strong>{t('cyberControlledProofDetectedProviders')}:</strong> {delivery.candidates?.length ? delivery.candidates.map((candidate) => `${candidate.providerLabel || candidate.providerId} (${candidate.confidence} · ${candidate.adapterStatus}${candidate.blockingReason ? ` · ${controlledProofDisplayValue(candidate.blockingReason, t)}` : ''})`).join(', ') : t('cyberControlledProofNoneDetected')}</p><p><strong>{t('cyberControlledProofNameservers')}:</strong> {delivery.nameservers?.join(', ') || '—'}</p></>}
    {selection && <p><strong>{t('cyberControlledProofAdapter')}:</strong> {selection.providerId || controlledProofDisplayValue(selection.status, t)}{selection.reason ? ` · ${controlledProofDisplayValue(selection.reason, t)}` : ''}</p>}
    {delivery?.supportMatrix?.length > 0 && <details><summary>{t('cyberControlledProofSupportMatrix')}</summary><div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{t('cyberControlledProofProvider')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberControlledProofAdapter')}</th><th className={th}>{t('cyberControlledProofBlockingReason')}</th></tr></thead><tbody>{delivery.supportMatrix.map((item) => <tr key={item.id}><td className={td}>{item.label}</td><td className={td}>{controlledProofDisplayValue(item.adapterStatus, t)}</td><td className={td}>{item.adapterId || '—'}</td><td className={td}>{controlledProofDisplayValue(item.blockingReason, t)}</td></tr>)}</tbody></table></div></details>}
    {evidence.liveEngineExecutions?.length > 0 && <div><p className="font-semibold mt-2">{t('cyberControlledProofLiveEngineExecution')}</p><div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{t('cyberControlledProofEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberColVersion')}</th><th className={th}>{t('cyberControlledProofRawRecords')}</th><th className={th}>{t('cyberControlledProofAttemptedChecks')}</th><th className={th}>{t('cyberControlledProofEvidence')}</th><th className={th}>{t('cyberControlledProofReason')}</th></tr></thead><tbody>{evidence.liveEngineExecutions.map((execution) => <tr key={execution.engineId}><td className={td}>{execution.engineId}</td><td className={td}>{execution.status}</td><td className={td}>{execution.version || '—'}</td><td className={td}>{execution.rawRecords ?? 0}</td><td className={td}>{execution.attemptedChecks ?? '—'}</td><td className={td}>{execution.observations ?? 0}</td><td className={td}>{execution.reason || '—'}</td></tr>)}</tbody></table></div></div>}
    {evidence.securityObservations?.length > 0 && <div className="space-y-3"><p className="font-semibold mt-2">{t('cyberControlledProofFindingEvidence')}</p><p className="text-xs text-cyan-100/50">{t('cyberControlledProofEvidenceSeparation')}</p>{evidence.securityObservations.map((observation, index) => <article className="border border-cyan-300/15 rounded p-3 space-y-1" key={`${observation.observationId || observation.evidenceHash}-${index}`}><p><strong>{observation.title}</strong> · <Badge tone={['HIGH', 'CRITICAL'].includes(observation.severity) ? 'danger' : observation.severity === 'MEDIUM' ? 'warn' : 'muted'}>{observation.severity || '—'}</Badge></p><p><strong>{t('cyberControlledProofTechnicalEvidence')}:</strong> {observation.technicalEvidence || '—'}</p><p><strong>{t('cyberControlledProofLocation')}:</strong> {observation.location || '—'}</p><p><strong>{t('cyberControlledProofEngine')}:</strong> {observation.engineId} · <code>{observation.ruleId || '—'}</code></p><p className="break-all"><strong>{t('cyberControlledProofEvidenceHash')}:</strong> {observation.evidenceHash}</p><p><strong>{t('cyberControlledProofPossibleImpact')}:</strong> {observation.possibleImpact || '—'}</p><p><strong>{t('cyberControlledProofDetectedTechnology')}:</strong> {observation.technology || '—'}</p><p><strong>{t('cyberControlledProofRecommendedRemediation')}:</strong> {observation.remediation || '—'}</p><p><strong>{t('cyberControlledProofPostFixValidation')}:</strong> {observation.revalidation || '—'}</p><p><strong>{t('cyberControlledProofVerification')}:</strong> {observation.verificationStatus} · <strong>{t('cyberControlledProofEligibility')}:</strong> <code>{observation.proofEligibility}</code></p></article>)}</div>}
    {evidence.evidenceEngineCoverage && <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{t('cyberControlledProofEngine')}</th><th className={th}>{t('cyberControlledProofEvidence')}</th><th className={th}>{t('cyberControlledProofCandidates')}</th><th className={th}>{t('cyberControlledProofRejected')}</th></tr></thead><tbody>{Object.entries(evidence.evidenceEngineCoverage).map(([engine, coverage]) => <tr key={engine}><td className={td}>{engine}</td><td className={td}>{coverage.observations}</td><td className={td}>{coverage.candidates}</td><td className={td}>{coverage.rejected}</td></tr>)}</tbody></table></div>}
    {groupedRejections.length > 0 && <details><summary>{t('cyberControlledProofRejectionReasons')}</summary><ul className="list-disc pl-5 space-y-1">{groupedRejections.map((rejection) => <li key={`${rejection.engineId}-${rejection.reason}`}><strong>{rejection.engineId}</strong>: <code>{rejection.reason}</code> ({rejection.count}) - {controlledProofRejectionExplanation(rejection.reason, t)}</li>)}</ul></details>}
  </div>;
}

function ControlledPublicProof({ t, run, busy, onStart, onStop }) {
  const [duration, setDuration] = useState(30);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.publicProofStatus !== 'ACTIVE') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [run?.publicProofStatus]);
  const remaining = run?.publicExpiresAt ? Math.max(0, Math.ceil((new Date(run.publicExpiresAt).getTime() - now) / 1000)) : 0;
  return <div className="mt-4 border border-red-400/25 rounded p-3 space-y-2">
    <p className="text-red-200 text-xs tracking-widest uppercase">{t('cyberControlledProofPublicTitle')}</p>
    <p className="text-cyan-100/70 text-sm"><strong>{t('cyberControlledProofPublicVisibility')}:</strong> {controlledProofDisplayValue(run?.publicProofStatus || 'UNAVAILABLE', t)}</p>
    {run?.publicValidator && <p className="text-cyan-100/70 text-sm"><strong>{t('cyberControlledProofPublicValidator')}:</strong> {run.publicValidator}</p>}
    {run?.publicProofStatus === 'AVAILABLE' && <div className="flex flex-wrap gap-2"><select className={inputCls} value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>5s</option><option value={10}>10s</option><option value={30}>30s</option></select><button type="button" className="border border-red-400/50 bg-red-500/10 text-red-200 px-4 py-2 rounded" disabled={busy} onClick={() => onStart(duration)}>{t('cyberControlledProofPublicStart')}</button></div>}
    {run?.publicProofStatus === 'ACTIVE' && <div><p className="text-red-200 font-mono text-xl" aria-live="polite">{t('cyberControlledProofPublicActive')} · 00:{String(remaining).padStart(2, '0')}</p><button type="button" className={btnCls} disabled={busy} onClick={onStop}>{t('cyberControlledProofPublicStop')}</button></div>}
    {run?.publicVisibilityVerified && <p className="text-emerald-300 text-sm">{t('cyberControlledProofPublicObserved')}</p>}
    {run?.publicEvidenceHash && <p className="text-cyan-100/60 text-xs break-all"><strong>{t('cyberControlledProofPublicEvidenceHash')}:</strong> {run.publicEvidenceHash}</p>}
    {run?.publicFailureReason && <p className="text-red-300 text-sm"><strong>{t('cyberControlledProofReason')}:</strong> {controlledProofDisplayValue(run.publicFailureReason, t)}</p>}
  </div>;
}

function ControlledProofHistoryDetail({ t, lang, run, onClose, onError }) {
  return (
    <div className="border border-red-400/25 rounded p-3 space-y-3 bg-red-950/10">
      <div className="flex justify-end gap-2 flex-wrap">
        <ExportActions t={t} report={buildControlledProofExportReport(run, { translate: t, locale: lang })} onError={onError} />
        <button className={btnCls} onClick={onClose}>{t('cyberClose')}</button>
      </div>
      <div className="space-y-1 text-sm text-cyan-100/70">
        <p><strong>{t('cyberControlledProofTarget')}:</strong> {run.normalizedTarget}</p>
        <p><strong>{t('cyberControlledProofId')}:</strong> {run.proofId}</p>
        <p><strong>{t('cyberColStatus')}:</strong> {controlledProofDisplayValue(run.status, t)}</p>
        <p><strong>{t('cyberControlledProofSecurityImpact')}:</strong> {t(CONTROLLED_PROOF_IMPACT_LABELS[run.securityImpact] || 'cyberControlledProofNotVerified')}</p>
        {run.securityValidator && <p><strong>{t('cyberControlledProofValidator')}:</strong> {run.securityValidator}</p>}
        {run.evidenceHash && <p className="break-all"><strong>{t('cyberControlledProofEvidenceHash')}:</strong> {run.evidenceHash}</p>}
        {run.failureReason && <p><strong>{t('cyberControlledProofReason')}:</strong> {controlledProofDisplayValue(run.failureReason, t)}</p>}
      </div>
      <ControlledProofCoverage t={t} evidence={run.securityEvidence} />
      <ControlledPublicProof t={t} run={run} busy onStart={() => {}} onStop={() => {}} />
    </div>
  );
}

function ControlledProofTab({ t, lang, isAdmin }) {
  const [targetUrl, setTargetUrl] = useState('');
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [error, setError] = useState('');

  const loadHistory = useCallback((archived = showArchived) => {
    return cyberAnalysisApi.listControlledProofHistory(archived).then(({ runs }) => setHistory(runs));
  }, [showArchived]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    loadHistory(showArchived).catch((err) => setError(err.message));
    return undefined;
  }, [isAdmin, showArchived, loadHistory]);

  useEffect(() => {
    if (!isAdmin || !busy) return undefined;
    const timer = setInterval(() => loadHistory(false).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, busy, loadHistory]);

  useEffect(() => {
    if (!isAdmin || run?.publicProofStatus !== 'ACTIVE' || !run.id) return undefined;
    const timer = setInterval(() => cyberAnalysisApi.getControlledProof(run.id).then(({ run: current }) => {
      setRun(current);
      setHistory((items) => items.map((item) => item.id === current.id ? current : item));
    }).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, run?.id, run?.publicProofStatus]);

  useEffect(() => {
    if (!isAdmin || run?.status !== 'ANALYZING' || !run.id) return undefined;
    const timer = setInterval(() => cyberAnalysisApi.getControlledProof(run.id).then(({ run: current }) => {
      setRun(current);
      setHistory((items) => items.map((item) => item.id === current.id ? current : item));
    }).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, run?.id, run?.status]);

  async function analyze(event) {
    event.preventDefault();
    if (!isAdmin) return;
    setShowArchived(false);
    setBusy(true);
    setError('');
    setRun({ status: 'ANALYZING' });
    try {
      const result = await cyberAnalysisApi.analyzeControlledProof(targetUrl);
      setRun(result.run);
      setHistory((items) => [result.run, ...items.filter((item) => item.id !== result.run.id)]);
    } catch (requestError) {
      setRun(null);
      setError(controlledProofDisplayValue(requestError.message, t));
    } finally {
      setBusy(false);
    }
  }

  async function inspect(id) {
    if (selected?.id === id) {
      setSelected(null);
      return;
    }
    setActionBusy(id);
    setError('');
    try {
      const result = await cyberAnalysisApi.getControlledProof(id);
      setSelected(result.run);
    } catch (requestError) {
      setError(controlledProofDisplayValue(requestError.message, t));
    } finally {
      setActionBusy('');
    }
  }

  async function lifecycle(id, action) {
    setActionBusy(id);
    setError('');
    try {
      await action(id);
      if (selected?.id === id) setSelected(null);
      await loadHistory();
    } catch (requestError) {
      setError(controlledProofDisplayValue(requestError.message, t));
    } finally {
      setActionBusy('');
    }
  }

  function deleteProof(item) {
    if (!window.confirm(t('cyberProofDeleteConfirm', { proofId: item.proofId || item.id }))) return;
    lifecycle(item.id, cyberAnalysisApi.deleteControlledProof);
    if (run?.id === item.id) setRun(null);
  }

  async function startPublic(durationSeconds) {
    setActionBusy(run.id);
    setError('');
    try {
      const result = await cyberAnalysisApi.startControlledPublicProof(run.id, durationSeconds);
      setRun(result.run);
      setHistory((items) => items.map((item) => item.id === result.run.id ? result.run : item));
    } catch (requestError) {
      setError(controlledProofDisplayValue(requestError.message, t));
    } finally {
      setActionBusy('');
    }
  }

  async function stopPublic() {
    setActionBusy(run.id);
    setError('');
    try {
      const result = await cyberAnalysisApi.stopControlledPublicProof(run.id);
      setRun(result.run);
      setHistory((items) => items.map((item) => item.id === result.run.id ? result.run : item));
    } catch (requestError) {
      setError(controlledProofDisplayValue(requestError.message, t));
    } finally {
      setActionBusy('');
    }
  }

  if (!isAdmin) return <div className="hud-panel rounded-xl p-5 border border-red-400/25 text-cyan-100/45 flex items-center gap-2"><LockKeyhole className="w-4 h-4" />{t('cyberControlledProofAdminRequired')}</div>;

  return (
    <div className="space-y-4">
      <div className="hud-panel rounded-xl p-4 border border-red-400/40 bg-red-950/15">
        <p className="text-red-300 text-xs tracking-[0.2em] uppercase mb-2">{t('cyberControlledProofRestricted')}</p>
        <PageTitle>{t('cyberControlledProofTitle')}</PageTitle>
      </div>
      <Panel title={t('cyberControlledProofAnalyze')}>
        <form className="space-y-3" onSubmit={analyze}>
          <label className="block text-cyan-100/60 text-xs tracking-widest uppercase" htmlFor="integrated-proof-target">{t('cyberControlledProofTarget')}</label>
          <input id="integrated-proof-target" className={inputCls} type="url" required maxLength={2048} placeholder="https://example-customer.com" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} disabled={busy} />
          <div><span className="text-cyan-100/40 text-xs">{t('cyberControlledProofType')}</span><p className="text-cyan-100/80 text-sm">{t('cyberControlledProofWebImpact')}</p></div>
          <button type="submit" className="w-full border border-red-400/50 bg-red-500/10 text-red-200 px-4 py-2.5 rounded text-sm tracking-widest hover:bg-red-500/20 disabled:opacity-40" disabled={busy}>{busy ? t('cyberControlledProofAnalyzing') : t('cyberControlledProofAnalyzeTarget')}</button>
        </form>
      </Panel>
      <ErrorNote error={error} />
      {run && (
        <Panel title={t('cyberControlledProofResult')}>
          {run.status !== 'ANALYZING' && <div className="flex justify-end mb-3"><ExportActions t={t} report={buildControlledProofExportReport(run, { translate: t, locale: lang })} onError={setError} /></div>}
          {run.status === 'ANALYZING' ? <Badge tone="warn">{t('cyberControlledProofAnalyzing')}</Badge> : (
            <div className="border border-cyan-300/15 rounded p-3 mb-4"><p className="text-cyan-100/40 text-xs mb-1">{t('cyberControlledProofSecurityImpact')}</p><p className="text-cyan-100 text-sm font-semibold">{t(CONTROLLED_PROOF_IMPACT_LABELS[run.securityImpact] || 'cyberControlledProofNotVerified')}</p></div>
          )}
          <div className="space-y-1 text-sm text-cyan-100/70">
            {run.target && <p><strong>{t('cyberControlledProofTarget')}:</strong> {run.target}</p>}
            {run.proofId && <p><strong>{t('cyberControlledProofId')}:</strong> {run.proofId}</p>}
            {run.startedAt && <p><strong>{t('cyberControlledProofStarted')}:</strong> {formatDateTime(run.startedAt, lang)}</p>}
            {run.completedAt && <p><strong>{t('cyberControlledProofCompleted')}:</strong> {formatDateTime(run.completedAt, lang)}</p>}
            {run.securityValidator && <p><strong>{t('cyberControlledProofValidator')}:</strong> {run.securityValidator}</p>}
            {run.evidenceHash && <p className="break-all"><strong>{t('cyberControlledProofEvidenceHash')}:</strong> {run.evidenceHash}</p>}
            {run.failureReason && <p><strong>{t('cyberControlledProofReason')}:</strong> {controlledProofDisplayValue(run.failureReason, t)}</p>}
          </div>
          <ControlledProofCoverage t={t} evidence={run.securityEvidence} />
          {run.status !== 'ANALYZING' && <ControlledPublicProof t={t} run={run} busy={actionBusy === run.id} onStart={startPublic} onStop={stopPublic} />}
        </Panel>
      )}
      <Panel title={t('cyberControlledProofHistory')}>
        <div className="flex gap-2 mb-3"><button className={showArchived ? btnCls : btnPrimaryCls} onClick={() => setShowArchived(false)}>{t('cyberScanActiveTabLabel')}</button><button className={showArchived ? btnPrimaryCls : btnCls} onClick={() => setShowArchived(true)}>{t('cyberScanArchivedTabLabel')}</button></div>
        {history.length === 0 ? <p className="text-cyan-100/40 text-sm">{t('cyberControlledProofNoHistory')}</p> : (
          <div className="space-y-3">{history.map((item) => (
            <article key={item.id} data-testid={`controlled-proof-history-${item.id}`} className="border border-cyan-300/15 rounded-lg p-3 bg-[#031326]/45 min-w-0">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="min-w-0"><p className="text-cyan-100/40 text-[10px] tracking-widest uppercase">{t('cyberControlledProofTarget')}</p><p className="text-cyan-100/80 text-xs break-all">{item.normalizedTarget}</p></div>
                <div className="min-w-0"><p className="text-cyan-100/40 text-[10px] tracking-widest uppercase">{t('cyberControlledProofId')}</p><p className="text-cyan-100/80 text-xs break-all">{item.proofId}</p></div>
                <div className="min-w-0"><p className="text-cyan-100/40 text-[10px] tracking-widest uppercase">{t('cyberColStatus')}</p><p className="text-cyan-100/80 text-xs break-words">{controlledProofDisplayValue(item.status, t)}</p></div>
                <div className="min-w-0"><p className="text-cyan-100/40 text-[10px] tracking-widest uppercase">{t('cyberControlledProofSecurityImpact')}</p><p className="text-cyan-100/80 text-xs break-words">{t(CONTROLLED_PROOF_IMPACT_LABELS[item.securityImpact] || 'cyberControlledProofNotVerified')}</p></div>
              </div>
              <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-cyan-300/10">
                <button className={btnCls} disabled={actionBusy === item.id} onClick={() => inspect(item.id)}>{selected?.id === item.id ? t('cyberClose') : t('cyberScanInspect')}</button>
                {item.status === 'ANALYZING' && <button className={btnCls} disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, cyberAnalysisApi.cancelControlledProof)}>{t('cyberScanStop')}</button>}
                <button className={btnCls} disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, showArchived ? cyberAnalysisApi.unarchiveControlledProof : cyberAnalysisApi.archiveControlledProof)}>{t(showArchived ? 'cyberScanUnarchive' : 'cyberScanArchive')}</button>
                {item.status !== 'ANALYZING' && <button className={`${btnCls} !border-red-400/40 !text-red-300`} disabled={actionBusy === item.id} onClick={() => deleteProof(item)}>{t('cyberDelete')}</button>}
              </div>
              {selected?.id === item.id && <div className="mt-3"><ControlledProofHistoryDetail t={t} lang={lang} run={selected} onClose={() => setSelected(null)} onError={setError} /></div>}
            </article>
          ))}</div>
        )}
      </Panel>
    </div>
  );
}

export default function CyberAnalysisContent({ isAdmin = false }) {
  const { t, lang } = useLang();
  const TABS = useTabs(t);
  const [tab, setTab] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const s = await api.cyberAnalysisStatus();
      setStatus(s);
    } catch (err) {
      setError(err.message || t('cyberAnalysisUnavailable'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadStatus(); }, []);

  const ActiveTab = {
    dashboard: DashboardTab,
    assets: AssetsTab,
    scans: ScansTab,
    findings: FindingsTab,
    reports: ReportsTab,
    engines: EnginesTab,
    quantum: QuantumTab,
    'controlled-proof': ControlledProofTab,
  }[tab];

  function changeTab(id) {
    setTab(id);
  }

  // Prev/Next/Enter/Esc only ever step through the flow group (Command
  // Center -> Assets -> Scans -> Findings -> Reports) -- Engines and
  // Quantum & PQC are standalone technical panels with no sequence, not
  // steps 6/7 of an analysis. Landing on one of them (via the sidebar)
  // hides the Prev/Next row entirely rather than pretending they fit a
  // position in the flow.
  const flowTabs = TABS.filter((tb) => tb.group === 'flow');
  const activeFlowIndex = flowTabs.findIndex((tb) => tb.id === tab);
  const isFlowTab = activeFlowIndex !== -1;
  const goPrev = () => { if (activeFlowIndex > 0) changeTab(flowTabs[activeFlowIndex - 1].id); };
  const goNext = () => { if (activeFlowIndex < flowTabs.length - 1) changeTab(flowTabs[activeFlowIndex + 1].id); };
  const activeTabProps = {
    t,
    lang,
    isAdmin,
    ...(tab === 'dashboard' ? { onNewAnalysis: () => setWizardOpen(true) } : {}),
  };

  // Esc = previous step, Enter = next step -- the same physical keys on
  // every desktop OS/keyboard layout, and neither has a native meaning
  // inside these single-line inputs (no textarea, no native form submit),
  // so both work everywhere with no need to click an empty area first.
  // Enter still respects canAdvance -- pressing it while a required field
  // is empty does nothing, same as the disabled Next button. Inert outside
  // the flow group (Engines/Quantum), same as the hidden Prev/Next row.
  useEffect(() => {
    if (!status?.available || !isFlowTab) return undefined;
    function onKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        goPrev();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status?.available, isFlowTab, activeFlowIndex, flowTabs.length]);

  return (
    <div className="space-y-4">
      <header className="hud-panel rounded-xl p-4 sm:p-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <img src="/bci-logo.png" alt="BCI" className="w-12 h-12 sm:w-14 sm:h-14 shrink-0 object-contain" />
          <div className="min-w-0">
            <h1 className="font-display text-cyan-50 text-lg sm:text-xl tracking-[0.24em]">BCI</h1>
            <p lang="en" className="font-display text-cyan-100/65 text-[10px] sm:text-xs tracking-[0.16em] whitespace-nowrap">BOLD CYBER INTELLIGENCE</p>
          </div>
        </div>
        <button
          onClick={loadStatus}
          className="border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded flex items-center gap-2 hover:bg-cyan-400/10"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {t('cyberAnalysisRefresh')}
        </button>
      </header>

      {error && (
        <div className="hud-panel rounded-xl p-4 border border-red-400/40 text-red-300 text-sm">{error}</div>
      )}

      {status && !status.available ? (
        <div className="hud-panel rounded-xl p-4 flex items-center gap-3 text-cyan-100/70">
          <ShieldAlert className="w-5 h-5 text-gold" />
          <span>{t('cyberAnalysisNotConfigured')}</span>
        </div>
      ) : status?.available ? (
        <div className="flex flex-col sm:flex-row gap-4">
          <nav className="hud-panel rounded-xl p-2 flex sm:flex-col gap-1 sm:w-48 shrink-0 overflow-x-auto sm:overflow-visible">
            {TABS.map((tb, i) => (
              <React.Fragment key={tb.id}>
                {tb.group === 'technical' && TABS[i - 1]?.group === 'flow' && (
                  <div className="hidden sm:flex items-center gap-1 border-t border-cyan-300/10 my-1 pt-1 px-3">
                    <BookOpen className="w-3 h-3 text-cyan-100/30 shrink-0" />
                    <span className="text-cyan-100/30 text-[10px] tracking-widest uppercase">{t('cyberTechnicalGroup')}</span>
                  </div>
                )}
                {tb.group === 'restricted' && (
                  <div className="hidden sm:flex items-center gap-1 border-t border-red-400/25 mt-2 pt-2 px-3">
                    <LockKeyhole className="w-3 h-3 text-red-300/60 shrink-0" />
                    <span className="text-red-300/60 text-[10px] tracking-widest uppercase">{t('cyberControlledProofRestricted')}</span>
                  </div>
                )}
                <button
                  onClick={() => { if (tb.group !== 'restricted' || isAdmin) changeTab(tb.id); }}
                  disabled={tb.group === 'restricted' && !isAdmin}
                  title={tb.group === 'restricted' && !isAdmin ? t('cyberControlledProofAdminRequired') : undefined}
                  className={`px-3 py-2 rounded text-[12px] tracking-wide uppercase transition text-left whitespace-nowrap ${
                    tb.group === 'restricted'
                      ? (isAdmin ? (tab === tb.id ? 'bg-red-500/20 text-red-100 border border-red-400/60' : 'text-red-300 border border-red-400/35 hover:bg-red-500/10') : 'text-cyan-100/25 border border-cyan-100/10 cursor-not-allowed')
                      : (tab === tb.id ? 'bg-cyan-400/15 text-cyan-100 border border-cyan-300/40' : 'text-cyan-100/50 hover:text-cyan-100/80')
                  }`}
                >
                  {tb.label}{tb.group === 'restricted' && !isAdmin ? ` · ${t('cyberControlledProofLocked')}` : ''}
                </button>
              </React.Fragment>
            ))}
          </nav>

          <div className="flex-1 min-w-0 space-y-3">
            {isFlowTab && (
              <>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={goPrev}
                    disabled={activeFlowIndex <= 0}
                    className="border border-cyan-300/35 text-cyan-100 px-3 py-1.5 rounded flex items-center gap-1 text-[12px] hover:bg-cyan-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> {t('cyberPrevTab')}
                  </button>
                  <button
                    onClick={goNext}
                    disabled={activeFlowIndex >= flowTabs.length - 1}
                    className="border border-cyan-300/35 text-cyan-100 px-3 py-1.5 rounded flex items-center gap-1 text-[12px] hover:bg-cyan-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {t('cyberNextTab')} <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            )}
            <ActiveTab {...activeTabProps} />
          </div>
        </div>
      ) : null}

      {wizardOpen && (
        <CyberNewAnalysisWizard
          onClose={() => setWizardOpen(false)}
          onGoToFindings={() => { setWizardOpen(false); changeTab('findings'); }}
        />
      )}
    </div>
  );
}
