import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useLang } from '../i18n/LangContext.jsx';

function statusBadge(status) {
  if (status === 'HEALTHY') return 'ok';
  if (status === 'DEGRADED') return 'warn';
  return 'danger';
}

export default function EnginesPage() {
  const { hasPermission } = useAuth();
  const { t } = useLang();
  const [engines, setEngines] = useState([]);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  function load() {
    api.listEngines().then((r) => setEngines(r.engines)).catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function onHealthCheck() {
    setChecking(true);
    setError(null);
    try {
      await api.runEngineHealthCheck();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <h2>{t('enginesTitle')}</h2>
      {error && <p className="error">{error}</p>}

      {hasPermission('system:manage') && (
        <button disabled={checking} onClick={onHealthCheck} style={{ marginBottom: 12 }}>
          {checking ? t('checkingEllipsis') : t('runHealthCheckBtn')}
        </button>
      )}

      <table className="card">
        <thead>
          <tr><th>{t('colEngine')}</th><th>{t('colStatus')}</th><th>{t('colVersion')}</th><th>{t('colIntrusiveness')}</th><th>{t('colLicense')}</th><th>{t('colLastChecked')}</th></tr>
        </thead>
        <tbody>
          {engines.map((e) => (
            <tr key={e.id}>
              <td>{e.name}</td>
              <td><span className={`badge ${statusBadge(e.status)}`}>{e.status || t('unknownLabel')}</span></td>
              <td>{e.version || '—'}</td>
              <td>{e.intrusiveness}</td>
              <td>{e.license}</td>
              <td>{e.last_checked_at ? new Date(e.last_checked_at).toLocaleString() : t('neverLabel')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
