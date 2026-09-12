import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useLang } from '../i18n/LangContext.jsx';

function healthBadge(status) {
  if (status === 'AVAILABLE') return 'ok';
  if (status === 'DEGRADED') return 'warn';
  if (status === 'NOT_CONFIGURED') return 'muted';
  return 'danger';
}

function readinessBadge(score) {
  if (score == null) return 'muted';
  if (score >= 80) return 'ok';
  if (score >= 50) return 'warn';
  return 'danger';
}

function vulnerableBadge(v) {
  if (v === true) return 'danger';
  if (v === false) return 'ok';
  return 'muted';
}

export default function QuantumPage() {
  const { hasPermission } = useAuth();
  const { t } = useLang();
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
      api.listQuantumProviders(),
      api.getQuantumPolicy(),
      api.listQuantumBenchmarks(),
      api.listQuantumJobs(),
      api.listCryptoInventory(),
      api.getPqcReadiness(),
      api.getCbom(),
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

  async function onSavePolicy(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.setQuantumPolicy(policy);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function onOptimize(e) {
    e.preventDefault();
    setOptimizing(true);
    setError(null);
    try {
      const result = await api.runRemediationOptimize(Number(effortBudget));
      setOptimizeResult(result);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setOptimizing(false);
    }
  }

  async function onDiscover(e) {
    e.preventDefault();
    setDiscovering(true);
    setError(null);
    try {
      await api.discoverCrypto(discoverTarget, discoverPort ? Number(discoverPort) : undefined, discoverProtocol);
      setDiscoverTarget('');
      setDiscoverPort('');
      load();
    } catch (err) {
      setError(err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message);
    } finally {
      setDiscovering(false);
    }
  }

  async function onDiscoverJwt(e) {
    e.preventDefault();
    setJwtDiscovering(true);
    setError(null);
    try {
      await api.discoverJwtCrypto(jwtToken);
      setJwtToken('');
      load();
    } catch (err) {
      setError(err.data?.reason ? `${err.message}: ${err.data.reason}` : err.message);
    } finally {
      setJwtDiscovering(false);
    }
  }

  return (
    <div>
      <h2>{t('quantumTitle')}</h2>
      {error && <p className="error">{error}</p>}
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>
        {t('quantumIntroNote')}
      </p>

      <h3>{t('gatewayTitle')}</h3>
      <table className="card">
        <thead>
          <tr><th>{t('colProvider')}</th><th>{t('colHealth')}</th><th>{t('colDetail')}</th></tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td><span className={`badge ${healthBadge(p.status)}`}>{p.status}</span></td>
              <td style={{ color: 'var(--muted)', fontSize: 12 }}>{p.detail || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {policy && (
        <form className="stack card" onSubmit={onSavePolicy} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div>
            <label>
              <input
                type="checkbox"
                checked={policy.allowQuantumSimulator}
                disabled={!hasPermission('system:manage')}
                onChange={(e) => setPolicy({ ...policy, allowQuantumSimulator: e.target.checked })}
              />{' '}
              {t('allowSimulatorLabel')}
            </label>
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={policy.allowQuantumHardware}
                disabled={!hasPermission('system:manage')}
                onChange={(e) => setPolicy({ ...policy, allowQuantumHardware: e.target.checked })}
              />{' '}
              {t('allowHardwareLabel')}
            </label>
          </div>
          <div>
            <label htmlFor="maxClass">{t('maxClassLabel')}</label>
            <select
              id="maxClass"
              value={policy.maxExternalDataClassification}
              disabled={!hasPermission('system:manage')}
              onChange={(e) => setPolicy({ ...policy, maxExternalDataClassification: e.target.value })}
            >
              {['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {hasPermission('system:manage') && <button type="submit">{t('savePolicyBtn')}</button>}
        </form>
      )}

      <h3>{t('optimizationsTitle')}</h3>
      {hasPermission('finding:update') && (
        <form className="stack card" onSubmit={onOptimize} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div>
            <label htmlFor="effortBudget">{t('effortBudgetLabel')}</label>
            <input id="effortBudget" type="number" min="1" value={effortBudget} onChange={(e) => setEffortBudget(e.target.value)} />
          </div>
          <button type="submit" disabled={optimizing}>{optimizing ? t('runningEllipsis') : t('runOptimizerBtn')}</button>
        </form>
      )}
      {optimizeResult && (
        <div className="card">
          <div>
            {t('verdictLabel')} <span className={`badge ${optimizeResult.verdict === 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' ? 'ok' : 'muted'}`}>{optimizeResult.verdict || t('naLabel')}</span>
          </div>
          {optimizeResult.note && <div style={{ color: 'var(--muted)', fontSize: 13 }}>{optimizeResult.note}</div>}
          {optimizeResult.optimizationObjective != null && (
            <div title={t('optimizationObjectiveTitle')}>
              {t('optimizationObjectiveLabel')} {optimizeResult.optimizationObjective}
            </div>
          )}
          {optimizeResult.selection?.length > 0 && (
            <ul>
              {optimizeResult.selection.map((s) => <li key={s.id || s.title}>{s.title || s.id}</li>)}
            </ul>
          )}
        </div>
      )}

      <h4>{t('recentBenchmarksTitle')}</h4>
      <table className="card">
        <thead><tr><th>{t('colSource')}</th><th>{t('colVerdict')}</th><th>{t('colCreated')}</th></tr></thead>
        <tbody>
          {benchmarks.map((b) => (
            <tr key={b.id}>
              <td>{b.workload_source}</td>
              <td><span className={`badge ${b.verdict === 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' ? 'ok' : 'muted'}`}>{b.verdict}</span></td>
              <td>{new Date(b.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>{t('quantumJobsTitle')}</h4>
      <table className="card">
        <thead><tr><th>{t('colProvider')}</th><th>{t('colMode')}</th><th>{t('colStatus')}</th><th>{t('colFallbackReason')}</th><th>{t('colSubmitted')}</th></tr></thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{j.provider}</td>
              <td>{j.mode || '—'}</td>
              <td><span className={`badge ${j.status === 'COMPLETED' ? 'ok' : j.status === 'FAILED' ? 'danger' : 'muted'}`}>{j.status}</span></td>
              <td style={{ color: 'var(--muted)', fontSize: 12 }}>{j.fallback_reason || '—'}</td>
              <td>{new Date(j.submitted_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>{t('pqcSecurityTitle')}</h3>

      {hasPermission('scan:create') && (
        <form className="stack card" onSubmit={onDiscover} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div>
            <label htmlFor="cryptoProtocol">{t('protocolLabel')}</label>
            <select id="cryptoProtocol" value={discoverProtocol} onChange={(e) => setDiscoverProtocol(e.target.value)}>
              <option value="TLS">TLS</option>
              <option value="SSH">SSH</option>
            </select>
          </div>
          <div>
            <label htmlFor="cryptoTarget">{t('cryptoTargetLabel')}</label>
            <input id="cryptoTarget" value={discoverTarget} onChange={(e) => setDiscoverTarget(e.target.value)} required placeholder="example.com" />
          </div>
          <div>
            <label htmlFor="cryptoPort">{t('portLabel')}</label>
            <input id="cryptoPort" type="number" value={discoverPort} onChange={(e) => setDiscoverPort(e.target.value)} placeholder={discoverProtocol === 'SSH' ? '22' : '443'} />
          </div>
          <button type="submit" disabled={discovering}>{discovering ? t('probingEllipsis') : t('discoverCryptoBtn')}</button>
        </form>
      )}
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>
        {t('cryptoScopeNote')}
      </p>

      {hasPermission('scan:create') && (
        <form className="stack card" onSubmit={onDiscoverJwt} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="jwtToken">{t('jwtAlgLabel')}</label>
            <input id="jwtToken" value={jwtToken} onChange={(e) => setJwtToken(e.target.value)} required placeholder="eyJhbGciOi..." style={{ width: '100%' }} />
          </div>
          <button type="submit" disabled={jwtDiscovering}>{jwtDiscovering ? t('decodingEllipsis') : t('discoverJwtBtn')}</button>
        </form>
      )}

      <div className="grid">
        <div className="card tile">
          <div className={`value badge ${readinessBadge(readiness?.readinessScore)}`}>{readiness?.readinessScore ?? '—'}</div>
          <div className="label">{t('pqcReadinessLabel')}</div>
        </div>
        <div className="card tile">
          <div className="value">{readiness?.quantumVulnerableCount ?? '—'}</div>
          <div className="label">{t('quantumVulnerableLabel')}</div>
        </div>
        <div className="card tile">
          <div className="value">{readiness?.unclassifiedCount ?? '—'}</div>
          <div className="label">{t('unclassifiedLabel')}</div>
        </div>
        <div className="card tile">
          <div className="value">{cbom?.componentCount ?? '—'}</div>
          <div className="label">{t('cbomComponentsLabel')}</div>
        </div>
      </div>
      {readiness?.note && <p style={{ color: 'var(--muted)', fontSize: 13 }}>{readiness.note}</p>}

      <h4>{t('cryptoInventoryTitle')}</h4>
      <table className="card">
        <thead><tr><th>{t('colTarget')}</th><th>{t('colAlgorithm')}</th><th>{t('colKeySize')}</th><th>{t('colQuantumVulnerable')}</th><th>{t('colDiscovered')}</th></tr></thead>
        <tbody>
          {inventory.map((f) => (
            <tr key={f.id}>
              <td>{f.target}</td>
              <td>{f.algorithm_id}</td>
              <td>{f.key_size_bits ?? '—'}</td>
              <td><span className={`badge ${vulnerableBadge(f.quantum_vulnerable)}`}>{f.quantum_vulnerable === null ? t('unknownLabel') : String(f.quantum_vulnerable)}</span></td>
              <td>{new Date(f.discovered_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>{t('migrationRoadmapTitle')}</h4>
      <table className="card">
        <thead><tr><th>{t('colTarget')}</th><th>{t('colAlgorithm')}</th><th>{t('colPriority')}</th><th>{t('colHarvestNowDecryptLater')}</th></tr></thead>
        <tbody>
          {(readiness?.roadmap || []).map((r) => (
            <tr key={r.target}>
              <td>{r.target}</td>
              <td>{r.algorithmId}</td>
              <td>{r.priority}</td>
              <td>{r.harvestNowDecryptLater ? <span className="badge warn">{t('futureExposureLabel')}</span> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
