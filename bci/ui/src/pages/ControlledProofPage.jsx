import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

const IMPACT_LABELS = { NO_PATH: 'NO SUPPORTED PROOF PATH', POTENTIAL: 'POTENTIAL — NOT VERIFIED', VERIFIED_IMPACT_PATH: 'VERIFIED IMPACT PATH' };

function PublicProof({ run, busy, onStart, onStop }) {
  const [duration, setDuration] = useState(30);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.publicProofStatus !== 'ACTIVE') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [run?.publicProofStatus]);
  const remaining = run?.publicExpiresAt ? Math.max(0, Math.ceil((new Date(run.publicExpiresAt).getTime() - now) / 1000)) : 0;
  return <div className="public-proof-panel">
    <h3>Customer-Visible Public Proof</h3>
    <p><strong>Public Visibility:</strong> {run?.publicProofStatus || 'UNAVAILABLE'}</p>
    {run?.publicValidator && <p><strong>Public Validator:</strong> {run.publicValidator}</p>}
    {run?.publicProofStatus === 'AVAILABLE' && <div><label htmlFor="public-duration">Duration</label>{' '}<select id="public-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>5 seconds</option><option value={10}>10 seconds</option><option value={30}>30 seconds</option></select>{' '}<button type="button" className="danger-action" disabled={busy} onClick={() => onStart(duration)}>START PUBLIC PROOF</button></div>}
    {run?.publicProofStatus === 'ACTIVE' && <div><p className="proof-countdown" aria-live="polite">PROOF ACTIVE · 00:{String(remaining).padStart(2, '0')}</p><button type="button" disabled={busy} onClick={onStop}>STOP PUBLIC PROOF</button></div>}
    {run?.publicVisibilityVerified && <p><strong>Independent Public Observation:</strong> VERIFIED</p>}
    {run?.publicEvidenceHash && <p><strong>Public Evidence Hash:</strong> {run.publicEvidenceHash}</p>}
    {run?.publicFailureReason && <p><strong>Public Proof Failure:</strong> {run.publicFailureReason}</p>}
  </div>;
}

function EvidenceCoverage({ evidence }) {
  if (!evidence) return null;
  const delivery = evidence.deliveryProviderDiscovery;
  const selection = evidence.publicVisibilitySelection;
  return (
    <div className="proof-coverage">
      {evidence.canonicalTarget && <p><strong>Canonical Target:</strong> {evidence.canonicalTarget}</p>}
      <p><strong>Endpoints Discovered:</strong> {evidence.endpointsDiscovered ?? 0}</p>
      <p><strong>Live and Historical Evidence Matched:</strong> {evidence.evidenceObservationsMatched ?? 0}</p>
      <p><strong>Content-Impact Signals:</strong> {evidence.evidenceImpactSignalsMatched ?? 0}</p>
      <p><strong>Proof Candidates:</strong> {evidence.evidenceCandidatesResolved ?? 0}</p>
      {delivery && <div><p><strong>Detected Delivery Providers:</strong> {delivery.candidates?.length ? delivery.candidates.map((candidate) => `${candidate.providerLabel || candidate.providerId} (${candidate.confidence} · ${candidate.adapterStatus}${candidate.blockingReason ? ` · ${candidate.blockingReason}` : ''})`).join(', ') : 'NONE DETECTED'}</p><p><strong>Authoritative Nameservers:</strong> {delivery.nameservers?.join(', ') || 'UNAVAILABLE'}</p></div>}
      {selection && <p><strong>Public Adapter:</strong> {selection.providerId || selection.status}{selection.reason ? ` · ${selection.reason}` : ''}</p>}
      {delivery?.supportMatrix?.length > 0 && <details><summary>Public visibility support matrix</summary><table><thead><tr><th>Provider</th><th>Status</th><th>Adapter</th><th>Technical limitation</th></tr></thead><tbody>{delivery.supportMatrix.map((item) => <tr key={item.id}><td>{item.label}</td><td>{item.adapterStatus}</td><td>{item.adapterId || '—'}</td><td>{item.blockingReason || '—'}</td></tr>)}</tbody></table></details>}
      {evidence.liveEngineExecutions?.length > 0 && <table><thead><tr><th>Live Engine</th><th>Status</th><th>Raw Records</th><th>Attempted Checks</th><th>Observations</th><th>Reason</th></tr></thead><tbody>{evidence.liveEngineExecutions.map((execution) => <tr key={execution.engineId}><td>{execution.engineId}</td><td>{execution.status}</td><td>{execution.rawRecords ?? 0}</td><td>{execution.attemptedChecks ?? '—'}</td><td>{execution.observations ?? 0}</td><td>{execution.reason || '—'}</td></tr>)}</tbody></table>}
      {evidence.securityObservations?.length > 0 && <section><h3>Finding Evidence</h3><p>Finding Evidence records scanner observations. Controlled Proof of Impact is a separate deterministic validation result.</p>{evidence.securityObservations.map((observation, index) => <article className="finding-evidence" key={`${observation.observationId || observation.evidenceHash}-${index}`}><p><strong>{observation.title}</strong> · {observation.severity || '—'}</p><p><strong>Technical Evidence:</strong> {observation.technicalEvidence || '—'}</p><p><strong>Target URL:</strong> {observation.location || '—'}</p><p><strong>Engine:</strong> {observation.engineId} · {observation.ruleId || '—'}</p><p><strong>Evidence Hash:</strong> {observation.evidenceHash}</p><p><strong>Possible Security Impact:</strong> {observation.possibleImpact || '—'}</p><p><strong>Detected Technology:</strong> {observation.technology || '—'}</p><p><strong>Recommended Remediation:</strong> {observation.remediation || '—'}</p><p><strong>Post-fix Revalidation:</strong> {observation.revalidation || '—'}</p><p><strong>Verification:</strong> {observation.verificationStatus} · <strong>Proof Eligibility:</strong> {observation.proofEligibility}</p></article>)}</section>}
      {evidence.evidenceEngineCoverage && <table><thead><tr><th>Engine</th><th>Evidence</th><th>Candidates</th><th>Rejected</th></tr></thead><tbody>{Object.entries(evidence.evidenceEngineCoverage).map(([engine, coverage]) => <tr key={engine}><td>{engine}</td><td>{coverage.observations}</td><td>{coverage.candidates}</td><td>{coverage.rejected}</td></tr>)}</tbody></table>}
      {evidence.candidateRejections?.length > 0 && <details><summary>Candidate rejection reasons</summary><ul>{evidence.candidateRejections.map((rejection, index) => <li key={`${rejection.engineId}-${index}`}>{rejection.engineId}: {rejection.reason}</li>)}</ul></details>}
    </div>
  );
}

export default function ControlledProofPage() {
  const { hasPermission } = useAuth();
  const isAdmin = hasPermission('system:manage');
  const [targetUrl, setTargetUrl] = useState('');
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback((archived = showArchived) => {
    return api.listControlledProofHistory(archived).then(({ runs }) => setHistory(runs));
  }, [showArchived]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    load(showArchived).catch(() => {});
    return undefined;
  }, [isAdmin, showArchived, load]);

  useEffect(() => {
    if (!isAdmin || !busy) return undefined;
    const timer = setInterval(() => load(false).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, busy, load]);

  useEffect(() => {
    if (!isAdmin || run?.publicProofStatus !== 'ACTIVE' || !run.id) return undefined;
    const timer = setInterval(() => api.getControlledProof(run.id).then(({ run: current }) => {
      setRun(current);
      setHistory((items) => items.map((item) => item.id === current.id ? current : item));
    }).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, run?.id, run?.publicProofStatus]);

  useEffect(() => {
    if (!isAdmin || run?.status !== 'ANALYZING' || !run.id) return undefined;
    const timer = setInterval(() => api.getControlledProof(run.id).then(({ run: current }) => {
      setRun(current);
      setHistory((items) => items.map((item) => item.id === current.id ? current : item));
    }).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [isAdmin, run?.id, run?.status]);

  async function analyze(event) {
    event.preventDefault();
    setShowArchived(false);
    setBusy(true);
    setError('');
    setRun({ status: 'ANALYZING' });
    try {
      const result = await api.analyzeControlledProof(targetUrl);
      setRun(result.run);
      setHistory((items) => [result.run, ...items.filter((item) => item.id !== result.run.id)]);
    } catch (requestError) {
      setRun(null);
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  async function inspect(id) {
    setActionBusy(id);
    setError('');
    try {
      const result = await api.getControlledProof(id);
      setSelected(result.run);
    } catch (requestError) {
      setError(requestError.message);
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
      await load();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionBusy('');
    }
  }

  function remove(item) {
    if (!window.confirm(`Delete Controlled Proof ${item.proofId || item.id} from all history views? This cannot be undone.`)) return;
    lifecycle(item.id, api.deleteControlledProof);
    if (run?.id === item.id) setRun(null);
  }

  async function startPublic(durationSeconds) {
    setActionBusy(run.id);
    setError('');
    try {
      const result = await api.startControlledPublicProof(run.id, durationSeconds);
      setRun(result.run);
      setHistory((items) => items.map((item) => item.id === result.run.id ? result.run : item));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionBusy('');
    }
  }

  async function stopPublic() {
    setActionBusy(run.id);
    setError('');
    try {
      const result = await api.stopControlledPublicProof(run.id);
      setRun(result.run);
      setHistory((items) => items.map((item) => item.id === result.run.id ? result.run : item));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setActionBusy('');
    }
  }

  if (!isAdmin) {
    return (
      <section className="controlled-proof-page locked-page">
        <div className="restricted-banner">RESTRICTED ADMIN MODULE</div>
        <h2>CONTROLLED PROOF OF IMPACT</h2>
        <div className="card"><span className="badge muted">LOCKED</span> System Administrator access required</div>
      </section>
    );
  }

  return (
    <section className="controlled-proof-page">
      <div className="restricted-banner">RESTRICTED ADMIN MODULE</div>
      <h2>CONTROLLED PROOF OF IMPACT</h2>

      <form className="card stack" onSubmit={analyze}>
        <label htmlFor="proof-target">Target URL</label>
        <input
          id="proof-target" type="url" required maxLength={2048} placeholder="https://example-customer.com"
          value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} disabled={busy}
        />
        <label>Proof Type</label>
        <input value="Web Content Impact" readOnly />
        <button type="submit" className="danger-action" disabled={busy}>{busy ? 'ANALYZING…' : 'ANALYZE TARGET'}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {run && (
        <div className="card proof-result" aria-live="polite">
          {run.status === 'ANALYZING' ? <span className="badge warn">ANALYZING</span> : (
            <div className="proof-outcome-grid">
              <div>
                <small>Security Impact</small>
                <strong>{IMPACT_LABELS[run.securityImpact] || 'NOT VERIFIED'}</strong>
              </div>
            </div>
          )}
          {run.target && <p><strong>Target:</strong> {run.target}</p>}
          {run.proofId && <p><strong>Proof ID:</strong> {run.proofId}</p>}
          {run.startedAt && <p><strong>Started:</strong> {new Date(run.startedAt).toLocaleString()}</p>}
          {run.completedAt && <p><strong>Completed:</strong> {new Date(run.completedAt).toLocaleString()}</p>}
          {run.securityValidator && <p><strong>Security Validator:</strong> {run.securityValidator}</p>}
          {run.evidenceHash && <p><strong>Evidence Hash:</strong> {run.evidenceHash}</p>}
          <p><strong>Persistent Modification:</strong> {run.persistentModification ? 'YES' : 'NO'}</p>
          {run.securityImpact === 'VERIFIED_IMPACT_PATH' && <p><strong>Evidence:</strong> VERIFIED</p>}
          {run.failureReason && <p><strong>Reason:</strong> {run.failureReason}</p>}
          <EvidenceCoverage evidence={run.securityEvidence} />
          {run.status !== 'ANALYZING' && <PublicProof run={run} busy={actionBusy === run.id} onStart={startPublic} onStop={stopPublic} />}
        </div>
      )}

      <div className="card">
        <div className="proof-history-heading">
          <h3>Proof History</h3>
          <div><button type="button" onClick={() => setShowArchived(false)} disabled={!showArchived}>Active</button>{' '}<button type="button" onClick={() => setShowArchived(true)} disabled={showArchived}>Archived</button></div>
        </div>
        {history.length === 0 ? <p>No controlled proof history.</p> : (
          <table>
            <thead><tr><th>Target</th><th>Proof ID</th><th>Status</th><th>Security Impact</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>{history.map((item) => (
              <tr key={item.id}>
                <td>{item.normalizedTarget}</td><td>{item.proofId}</td>
                <td>{item.status}</td><td>{IMPACT_LABELS[item.securityImpact] || 'NOT VERIFIED'}</td><td>{new Date(item.createdAt).toLocaleString()}</td>
                <td className="proof-actions">
                  <button type="button" disabled={actionBusy === item.id} onClick={() => inspect(item.id)}>Inspect</button>
                  {item.status === 'ANALYZING' && <button type="button" disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, api.cancelControlledProof)}>Stop</button>}
                  <button type="button" disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, showArchived ? api.unarchiveControlledProof : api.archiveControlledProof)}>{showArchived ? 'Unarchive' : 'Archive'}</button>
                  {item.status !== 'ANALYZING' && <button type="button" className="danger-action" disabled={actionBusy === item.id} onClick={() => remove(item)}>Delete</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card proof-result" aria-live="polite">
          <div className="proof-history-heading"><h3>Analysis Details</h3><button type="button" onClick={() => setSelected(null)}>Close</button></div>
          <p><strong>Target:</strong> {selected.normalizedTarget}</p>
          <p><strong>Proof ID:</strong> {selected.proofId}</p>
          <p><strong>Status:</strong> {selected.status}</p>
          <p><strong>Security Impact:</strong> {IMPACT_LABELS[selected.securityImpact] || 'NOT VERIFIED'}</p>
          {selected.securityValidator && <p><strong>Validator:</strong> {selected.securityValidator}</p>}
          {selected.evidenceHash && <p><strong>Evidence Hash:</strong> {selected.evidenceHash}</p>}
          {selected.failureReason && <p><strong>Reason:</strong> {selected.failureReason}</p>}
          <EvidenceCoverage evidence={selected.securityEvidence} />
          <PublicProof run={selected} busy onStart={() => {}} onStop={() => {}} />
        </div>
      )}
    </section>
  );
}
