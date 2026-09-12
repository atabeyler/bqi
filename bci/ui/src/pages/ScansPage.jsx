import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { apiErrorLabel, enumLabel, useLang } from '../i18n/LangContext.jsx';

function statusBadge(status) {
  if (['COMPLETED'].includes(status)) return 'ok';
  if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status)) return 'danger';
  return 'warn';
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'NO_COVERAGE', 'FAILED', 'TIMED_OUT', 'CANCELLED']);

export default function ScansPage() {
  const { hasPermission } = useAuth();
  const { t } = useLang();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  function load() {
    api.listScans(showArchived).then((r) => setJobs(r.jobs)).catch((err) => setError(apiErrorLabel(t, err)));
  }

  useEffect(load, [t, showArchived]);
  useEffect(() => {
    const id = searchParams.get('inspect');
    if (id) inspect(id);
  // The query parameter is the dashboard-to-detail handoff; inspect is
  // intentionally not a dependency because it is recreated per render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  async function inspect(id) {
    setError(null);
    try {
      setSelected((await api.getScan(id)).job);
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  async function remove(job) {
    if (!window.confirm(t('scanDeleteConfirm', { target: job.target }))) return;
    setError(null);
    try {
      await api.deleteScan(job.id);
      if (selected?.id === job.id) setSelected(null);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  async function archive(job) {
    setError(null);
    try {
      await api.archiveScan(job.id);
      if (selected?.id === job.id) setSelected(null);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  async function unarchive(job) {
    setError(null);
    try {
      await api.unarchiveScan(job.id);
      if (selected?.id === job.id) setSelected(null);
      load();
    } catch (err) {
      setError(apiErrorLabel(t, err));
    }
  }

  return (
    <div>
      <h2>{t('scansTitle')}</h2>
      {error && <p className="error">{error}</p>}
      <div className="card"><button type="button" disabled={!showArchived} onClick={() => setShowArchived(false)}>{t('activeBtn')}</button>{' '}<button type="button" disabled={showArchived} onClick={() => setShowArchived(true)}>{t('archivedBtn')}</button></div>

      {selected && <section className="card" aria-label={t('scanDetailsTitle')}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{t('scanDetailsTitle')}</strong><button className="secondary" onClick={() => setSelected(null)}>{t('closeBtn')}</button></div>
        <dl><dt>{t('colTarget')}</dt><dd>{selected.target}</dd><dt>{t('colClass')}</dt><dd>{enumLabel(t, 'scanClass', selected.requested_class)}</dd><dt>{t('colStatus')}</dt><dd>{enumLabel(t, 'scanStatus', selected.status)}</dd><dt>{t('colAttempts')}</dt><dd>{selected.attempts}</dd><dt>{t('technicalIdLabel')}</dt><dd>{selected.id}</dd></dl>
      </section>}

      <table className="card">
        <thead>
          <tr><th>{t('colTarget')}</th><th>{t('colClass')}</th><th>{t('colStatus')}</th><th>{t('colAttempts')}</th><th>{t('colActions')}</th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.target}</td>
              <td>{enumLabel(t, 'scanClass', j.requested_class)}</td>
              <td><span className={`badge ${statusBadge(j.status)}`}>{enumLabel(t, 'scanStatus', j.status)}</span></td>
              <td>{j.attempts}</td>
              <td><button className="secondary" onClick={() => inspect(j.id)}>{t('viewBtn')}</button>{hasPermission('scan:cancel') && <>{showArchived ? <button className="secondary" onClick={() => unarchive(j)}>{t('unarchiveBtn')}</button> : <button className="secondary" onClick={() => archive(j)}>{t('archiveBtn')}</button>}{TERMINAL_STATUSES.has(j.status) && <button className="secondary danger-action" onClick={() => remove(j)}>{t('deleteBtn')}</button>}</>}</td>
            </tr>
          ))}
          {jobs.length === 0 && <tr><td colSpan="5">{t('scansEmpty')}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
