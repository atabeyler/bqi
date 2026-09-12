import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { apiErrorLabel, enumLabel, useLang } from '../i18n/LangContext.jsx';

const REPORT_TYPES = ['EXECUTIVE', 'TECHNICAL', 'REMEDIATION', 'AUDIT', 'FULL'];

function fieldLabel(t, key) {
  const known = new Set([
    'language', 'presentation', 'title', 'description', 'scopedToTargets', 'securityScore', 'coverageScore',
    'securityCoverageScoreScope', 'openFindingCount', 'criticalFindingCount', 'highFindingCount', 'kevExposureCount',
    'topRisks', 'findingCount', 'findings', 'executionProvenance', 'items', 'eventCount', 'events', 'window',
    'sectionScopes', 'executive', 'technical', 'remediation', 'audit',
  ]);
  return known.has(key) ? t(`reportField_${key}`) : key;
}

function ReportValue({ value, t, path = 'report' }) {
  if (value == null) return <span>—</span>;
  if (typeof value === 'boolean') return <span>{value ? t('yesLabel') : t('noLabel')}</span>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>{t('reportNoData')}</span>;
    if (value.every((item) => item == null || typeof item !== 'object')) {
      return <ul>{value.map((item, index) => <li key={`${path}-${index}`}>{String(item)}</li>)}</ul>;
    }
    return <div className="stack">{value.map((item, index) => <section className="card" key={`${path}-${index}`}><strong>{t('reportItemLabel', { number: index + 1 })}</strong><ReportValue value={item} t={t} path={`${path}-${index}`} /></section>)}</div>;
  }
  return <dl>{Object.entries(value).map(([key, nested]) => <React.Fragment key={`${path}-${key}`}><dt>{fieldLabel(t, key)}</dt><dd><ReportValue value={nested} t={t} path={`${path}-${key}`} /></dd></React.Fragment>)}</dl>;
}

export default function ReportsPage() {
  const { hasPermission } = useAuth();
  const { t, lang } = useLang();
  const [searchParams] = useSearchParams();
  const [reports, setReports] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);

  function load() {
    api.listReports().then((r) => setReports(r.reports)).catch((err) => setError(apiErrorLabel(t, err)));
  }
  useEffect(load, [t]);
  useEffect(() => {
    const id = searchParams.get('inspect');
    if (id) view(id);
  // See ScansPage: query-driven inspection is a one-way dashboard handoff.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function onGenerate(reportType) {
    setGenerating(true);
    setError(null);
    try {
      await api.generateReport(reportType, lang);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    } finally {
      setGenerating(false);
    }
  }

  async function view(id) {
    try {
      setSelected(await api.getReport(id));
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  async function remove(report) {
    if (!window.confirm(t('reportDeleteConfirm', { type: enumLabel(t, 'reportType', report.report_type) }))) return;
    setError(null);
    try {
      await api.deleteReport(report.id);
      if (selected?.report?.id === report.id) setSelected(null);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  return (
    <div>
      <h2>{t('reportsTitle')}</h2>
      {error && <p className="error">{error}</p>}

      {hasPermission('report:export') && (
        <div className="card" style={{ display: 'flex', gap: 8 }}>
          {REPORT_TYPES.map((rt) => (
            <button key={rt} className="secondary" disabled={generating} onClick={() => onGenerate(rt)}>
              {t('generateBtn', { type: enumLabel(t, 'reportType', rt) })}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>{enumLabel(t, 'reportType', selected.report.report_type)}</strong>
            <button className="secondary" onClick={() => setSelected(null)}>{t('closeBtn')}</button>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>
            {t('hashLabel')} {selected.report.content_hash.slice(0, 16)}… · {t('integrityLabel')}{' '}
            <span className={`badge ${selected.report.integrityValid ? 'ok' : 'danger'}`}>
              {selected.report.integrityValid ? t('integrityValid') : t('integrityTampered')}
            </span>
          </p>
          <div className="report-content"><ReportValue value={selected.report.content} t={t} /></div>
        </div>
      )}

      <table className="card">
        <thead>
          <tr><th>{t('colType')}</th><th>{t('colGenerated')}</th><th>{t('colBciVersion')}</th><th>{t('colActions')}</th></tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td>{enumLabel(t, 'reportType', r.report_type)}</td>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.bci_version}</td>
              <td><button className="secondary" onClick={() => view(r.id)}>{t('viewBtn')}</button>{hasPermission('report:export') && <button className="secondary" onClick={() => remove(r)}>{t('deleteBtn')}</button>}</td>
            </tr>
          ))}
          {reports.length === 0 && <tr><td colSpan="4">{t('reportsEmpty')}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
