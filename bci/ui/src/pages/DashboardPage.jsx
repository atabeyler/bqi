import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Link } from 'react-router-dom';
import { apiErrorLabel, enumLabel, useLang } from '../i18n/LangContext.jsx';

function scoreBadge(score) {
  if (score == null) return 'muted';
  if (score >= 80) return 'ok';
  if (score >= 50) return 'warn';
  return 'danger';
}

export default function DashboardPage() {
  const { t } = useLang();
  const [security, setSecurity] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [scans, setScans] = useState([]);
  const [reports, setReports] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.securityScore(), api.coverageScore(), api.listScans(), api.listReports()])
      .then(([s, c, scanResult, reportResult]) => { setSecurity(s); setCoverage(c); setScans(scanResult.jobs || []); setReports(reportResult.reports || []); })
      .catch((err) => setError(apiErrorLabel(t, err)));
  }, [t]);

  return (
    <div>
      <h2>{t('dashboardTitle')}</h2>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        <div className="card tile">
          <div className={`value badge ${scoreBadge(security?.score)}`}>{security?.score ?? '—'}</div>
          <div className="label">{t('securityScoreLabel')}</div>
        </div>
        <div className="card tile">
          <div className={`value badge ${scoreBadge(coverage?.score)}`}>{coverage?.score ?? '—'}</div>
          <div className="label">{t('coverageScoreLabel')}</div>
          {coverage?.reason && <div className="label">{enumLabel(t, 'coverageReason', coverage.reason)}</div>}
        </div>
        <div className="card tile">
          <div className="value">{security?.openFindingCount ?? '—'}</div>
          <div className="label">{t('openFindingsLabel')}</div>
        </div>
      </div>
      <section className="card"><h3>{t('recentCompletedScans')}</h3><table><tbody>{scans.filter((scan) => scan.status === 'COMPLETED').slice(0, 5).map((scan) => <tr key={scan.id}><td>{scan.target}</td><td>{enumLabel(t, 'scanStatus', scan.status)}</td><td><Link to={`/scans?inspect=${encodeURIComponent(scan.id)}`}>{t('viewBtn')}</Link></td></tr>)}{scans.filter((scan) => scan.status === 'COMPLETED').length === 0 && <tr><td>{t('scansEmpty')}</td></tr>}</tbody></table></section>
      <section className="card"><h3>{t('recentReports')}</h3><table><tbody>{reports.slice(0, 5).map((report) => <tr key={report.id}><td>{enumLabel(t, 'reportType', report.report_type)}</td><td>{new Date(report.created_at).toLocaleString()}</td><td><Link to={`/reports?inspect=${encodeURIComponent(report.id)}`}>{t('viewBtn')}</Link></td></tr>)}{reports.length === 0 && <tr><td>{t('reportsEmpty')}</td></tr>}</tbody></table></section>
    </div>
  );
}
