import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useProofText } from '../i18n/proofMessages.js';
import { useAuth } from '../AuthContext.jsx';

const IMPACT_LABELS = { NO_PATH: 'NO SUPPORTED PROOF PATH', POTENTIAL: 'POTENTIAL — NOT VERIFIED', VERIFIED_IMPACT_PATH: 'VERIFIED IMPACT PATH' };

function PublicProof({ run, busy, onStart, onStop }) {
  const p = useProofText();
  const [duration, setDuration] = useState(30);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (run?.publicProofStatus !== 'ACTIVE') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [run?.publicProofStatus]);
  const remaining = run?.publicExpiresAt ? Math.max(0, Math.ceil((new Date(run.publicExpiresAt).getTime() - now) / 1000)) : 0;
  return <div className="public-proof-panel">
    <h3>{p("Customer-Visible Public Proof")}</h3>
    <p><strong>{p("Public Visibility:")}</strong> {run?.publicProofStatus || 'UNAVAILABLE'}</p>
    {run?.publicValidator && <p><strong>{p("Public Validator:")}</strong> {run.publicValidator}</p>}
    {run?.publicProofStatus === 'AVAILABLE' && <div><label htmlFor="public-duration">{p("Duration")}</label>{' '}<select id="public-duration" value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={5}>{p("5 seconds")}</option><option value={10}>{p("10 seconds")}</option><option value={30}>{p("30 seconds")}</option></select>{' '}<button type="button" className="danger-action" disabled={busy} onClick={() => onStart(duration)}>{p("START PUBLIC PROOF")}</button></div>}
    {run?.publicProofStatus === 'ACTIVE' && <div><p className="proof-countdown" aria-live="polite">PROOF ACTIVE · 00:{String(remaining).padStart(2, '0')}</p><button type="button" disabled={busy} onClick={onStop}>{p("STOP PUBLIC PROOF")}</button></div>}
    {run?.publicVisibilityVerified && <p><strong>{p("Independent Public Observation:")}</strong>{p("VERIFIED")}</p>}
    {run?.publicEvidenceHash && <p><strong>{p("Public Evidence Hash:")}</strong> {run.publicEvidenceHash}</p>}
    {run?.publicFailureReason && <p><strong>{p("Public Proof Failure:")}</strong> {run.publicFailureReason}</p>}
  </div>;
}

function EvidenceCoverage({ evidence }) {
  const p = useProofText();
  if (!evidence) return null;
  const delivery = evidence.deliveryProviderDiscovery;
  const selection = evidence.publicVisibilitySelection;
  return (
    <div className="proof-coverage">
      {evidence.canonicalTarget && <p><strong>{p("Canonical Target:")}</strong> {evidence.canonicalTarget}</p>}
      <p><strong>{p("Endpoints Discovered:")}</strong> {evidence.endpointsDiscovered ?? 0}</p>
      <p><strong>{p("Live and Historical Evidence Matched:")}</strong> {evidence.evidenceObservationsMatched ?? 0}</p>
      <p><strong>{p("Content-Impact Signals:")}</strong> {evidence.evidenceImpactSignalsMatched ?? 0}</p>
      <p><strong>{p("Proof Candidates:")}</strong> {evidence.evidenceCandidatesResolved ?? 0}</p>
      {delivery && <div><p><strong>{p("Detected Delivery Providers:")}</strong> {delivery.candidates?.length ? delivery.candidates.map((candidate) => `${candidate.providerLabel || candidate.providerId} (${candidate.confidence} · ${candidate.adapterStatus}${candidate.blockingReason ? ` · ${candidate.blockingReason}` : ''})`).join(', ') : 'NONE DETECTED'}</p><p><strong>{p("Authoritative Nameservers:")}</strong> {delivery.nameservers?.join(', ') || 'UNAVAILABLE'}</p></div>}
      {selection && <p><strong>{p("Public Adapter:")}</strong> {selection.providerId || selection.status}{selection.reason ? ` · ${selection.reason}` : ''}</p>}
      {delivery?.supportMatrix?.length > 0 && <details><summary>{p("Public visibility support matrix")}</summary><table><thead><tr><th>{p("Provider")}</th><th>{p("Status")}</th><th>{p("Adapter")}</th><th>{p("Technical limitation")}</th></tr></thead><tbody>{delivery.supportMatrix.map((item) => <tr key={item.id}><td>{item.label}</td><td>{item.adapterStatus}</td><td>{item.adapterId || '—'}</td><td>{item.blockingReason || '—'}</td></tr>)}</tbody></table></details>}
      {evidence.liveEngineExecutions?.length > 0 && <table><thead><tr><th>{p("Live Engine")}</th><th>{p("Status")}</th><th>{p("Raw Records")}</th><th>{p("Attempted Checks")}</th><th>{p("Observations")}</th><th>{p("Reason")}</th></tr></thead><tbody>{evidence.liveEngineExecutions.map((execution) => <tr key={execution.engineId}><td>{execution.engineId}</td><td>{execution.status}</td><td>{execution.rawRecords ?? 0}</td><td>{execution.attemptedChecks ?? '—'}</td><td>{execution.observations ?? 0}</td><td>{execution.reason || '—'}</td></tr>)}</tbody></table>}
      {evidence.securityObservations?.length > 0 && <section><h3>{p("Finding Evidence")}</h3><p>{p("Finding Evidence records scanner observations. Controlled Proof of Impact is a separate deterministic validation result.")}</p>{evidence.securityObservations.map((observation, index) => <article className="finding-evidence" key={`${observation.observationId || observation.evidenceHash}-${index}`}><p><strong>{observation.title}</strong> · {observation.severity || '—'}</p><p><strong>{p("Technical Evidence:")}</strong> {observation.technicalEvidence || '—'}</p><p><strong>{p("Target URL:")}</strong> {observation.location || '—'}</p><p><strong>{p("Engine:")}</strong> {observation.engineId} · {observation.ruleId || '—'}</p><p><strong>{p("Evidence Hash:")}</strong> {observation.evidenceHash}</p><p><strong>{p("Possible Security Impact:")}</strong> {observation.possibleImpact || '—'}</p><p><strong>{p("Detected Technology:")}</strong> {observation.technology || '—'}</p><p><strong>{p("Recommended Remediation:")}</strong> {observation.remediation || '—'}</p><p><strong>{p("Post-fix Revalidation:")}</strong> {observation.revalidation || '—'}</p><p><strong>{p("Verification:")}</strong> {observation.verificationStatus} · <strong>{p("Proof Eligibility:")}</strong> {observation.proofEligibility}</p></article>)}</section>}
      {evidence.evidenceEngineCoverage && <table><thead><tr><th>{p("Engine")}</th><th>{p("Evidence")}</th><th>{p("Candidates")}</th><th>{p("Rejected")}</th></tr></thead><tbody>{Object.entries(evidence.evidenceEngineCoverage).map(([engine, coverage]) => <tr key={engine}><td>{engine}</td><td>{coverage.observations}</td><td>{coverage.candidates}</td><td>{coverage.rejected}</td></tr>)}</tbody></table>}
      {evidence.candidateRejections?.length > 0 && <details><summary>{p("Candidate rejection reasons")}</summary><ul>{evidence.candidateRejections.map((rejection, index) => <li key={`${rejection.engineId}-${index}`}>{rejection.engineId}: {rejection.reason}</li>)}</ul></details>}
    </div>
  );
}

export default function ControlledProofPage() {
  const p = useProofText();
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
        <div className="restricted-banner">{p("RESTRICTED ADMIN MODULE")}</div>
        <h2>{p("CONTROLLED PROOF OF IMPACT")}</h2>
        <div className="card"><span className="badge muted">{p("LOCKED")}</span>{p("System Administrator access required")}</div>
      </section>
    );
  }

  return (
    <section className="controlled-proof-page">
      <div className="restricted-banner">{p("RESTRICTED ADMIN MODULE")}</div>
      <h2>{p("CONTROLLED PROOF OF IMPACT")}</h2>

      <form className="card stack" onSubmit={analyze}>
        <label htmlFor="proof-target">{p("Target URL")}</label>
        <input
          id="proof-target" type="url" required maxLength={2048} placeholder="https://example-customer.com"
          value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} disabled={busy}
        />
        <label>{p("Proof Type")}</label>
        <input aria-label={p("Web Content Impact")} value={p("Web Content Impact")} readOnly />
        <button type="submit" className="danger-action" disabled={busy}>{p(busy ? 'ANALYZING…' : 'ANALYZE TARGET')}</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {run && (
        <div className="card proof-result" aria-live="polite">
          {run.status === 'ANALYZING' ? <span className="badge warn">{p("ANALYZING")}</span> : (
            <div className="proof-outcome-grid">
              <div>
                <small>{p("Security Impact")}</small>
                <strong>{p(IMPACT_LABELS[run.securityImpact] || 'NOT VERIFIED')}</strong>
              </div>
            </div>
          )}
          {run.target && <p><strong>{p("Target:")}</strong> {run.target}</p>}
          {run.proofId && <p><strong>{p("Proof ID:")}</strong> {run.proofId}</p>}
          {run.startedAt && <p><strong>{p("Started:")}</strong> {new Date(run.startedAt).toLocaleString()}</p>}
          {run.completedAt && <p><strong>{p("Completed:")}</strong> {new Date(run.completedAt).toLocaleString()}</p>}
          {run.securityValidator && <p><strong>{p("Security Validator:")}</strong> {run.securityValidator}</p>}
          {run.evidenceHash && <p><strong>{p("Evidence Hash:")}</strong> {run.evidenceHash}</p>}
          <p><strong>{p("Persistent Modification:")}</strong> {run.persistentModification ? 'YES' : 'NO'}</p>
          {run.securityImpact === 'VERIFIED_IMPACT_PATH' && <p><strong>{p("Evidence:")}</strong>{p("VERIFIED")}</p>}
          {run.failureReason && <p><strong>{p("Reason:")}</strong> {run.failureReason}</p>}
          <EvidenceCoverage evidence={run.securityEvidence} />
          {run.status !== 'ANALYZING' && <PublicProof run={run} busy={actionBusy === run.id} onStart={startPublic} onStop={stopPublic} />}
        </div>
      )}

      <div className="card">
        <div className="proof-history-heading">
          <h3>{p("Proof History")}</h3>
          <div><button type="button" onClick={() => setShowArchived(false)} disabled={!showArchived}>{p("Active")}</button>{' '}<button type="button" onClick={() => setShowArchived(true)} disabled={showArchived}>{p("Archived")}</button></div>
        </div>
        {history.length === 0 ? <p>{p("No controlled proof history.")}</p> : (
          <table>
            <thead><tr><th>{p("Target")}</th><th>{p("Proof ID")}</th><th>{p("Status")}</th><th>{p("Security Impact")}</th><th>{p("Created")}</th><th>{p("Actions")}</th></tr></thead>
            <tbody>{history.map((item) => (
              <tr key={item.id}>
                <td>{item.normalizedTarget}</td><td>{item.proofId}</td>
                <td>{item.status}</td><td>{p(IMPACT_LABELS[item.securityImpact] || 'NOT VERIFIED')}</td><td>{new Date(item.createdAt).toLocaleString()}</td>
                <td className="proof-actions">
                  <button type="button" disabled={actionBusy === item.id} onClick={() => inspect(item.id)}>{p("Inspect")}</button>
                  {item.status === 'ANALYZING' && <button type="button" disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, api.cancelControlledProof)}>{p("Stop")}</button>}
                  <button type="button" disabled={actionBusy === item.id} onClick={() => lifecycle(item.id, showArchived ? api.unarchiveControlledProof : api.archiveControlledProof)}>{showArchived ? 'Unarchive' : 'Archive'}</button>
                  {item.status !== 'ANALYZING' && <button type="button" className="danger-action" disabled={actionBusy === item.id} onClick={() => remove(item)}>{p("Delete")}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {selected && (
        <div className="card proof-result" aria-live="polite">
          <div className="proof-history-heading"><h3>{p("Analysis Details")}</h3><button type="button" onClick={() => setSelected(null)}>{p("Close")}</button></div>
          <p><strong>{p("Target:")}</strong> {selected.normalizedTarget}</p>
          <p><strong>{p("Proof ID:")}</strong> {selected.proofId}</p>
          <p><strong>{p("Status:")}</strong> {selected.status}</p>
          <p><strong>{p("Security Impact:")}</strong> {p(IMPACT_LABELS[selected.securityImpact] || 'NOT VERIFIED')}</p>
          {selected.securityValidator && <p><strong>{p("Validator:")}</strong> {selected.securityValidator}</p>}
          {selected.evidenceHash && <p><strong>{p("Evidence Hash:")}</strong> {selected.evidenceHash}</p>}
          {selected.failureReason && <p><strong>{p("Reason:")}</strong> {selected.failureReason}</p>}
          <EvidenceCoverage evidence={selected.securityEvidence} />
          <PublicProof run={selected} busy onStart={() => {}} onStop={() => {}} />
        </div>
      )}
    </section>
  );
}
