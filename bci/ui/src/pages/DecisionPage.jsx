import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { useLang } from '../i18n/LangContext.jsx';

export default function DecisionPage() {
  const { hasPermission } = useAuth();
  const { t } = useLang();
  const [twin, setTwin] = useState(null);
  const [graph, setGraph] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [aiSecurity, setAiSecurity] = useState(null);
  const [decision, setDecision] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [effortBudget, setEffortBudget] = useState(5);
  const [cveId, setCveId] = useState('');
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  function load() {
    Promise.all([api.getDigitalTwin(), api.getKnowledgeGraph(), api.getComplianceAssessment(), api.getAiSecurity()])
      .then(([nextTwin, nextGraph, nextCompliance, nextAiSecurity]) => {
        setTwin(nextTwin);
        setGraph(nextGraph);
        setCompliance(nextCompliance);
        setAiSecurity(nextAiSecurity);
      })
      .catch((nextError) => setError(nextError.message));
  }

  useEffect(load, []);

  async function recommend(event) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      setDecision(await api.runCyberDecision(Number(effortBudget)));
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setWorking(false);
    }
  }

  async function simulatePatch(event) {
    event.preventDefault();
    setWorking(true);
    setError(null);
    try {
      setSimulation(await api.runWhatIfSimulation({ type: 'PATCH_CVE', cveId }));
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setWorking(false);
    }
  }

  const nonCompliant = compliance
    ? Object.values(compliance.frameworks).reduce((sum, framework) => sum + framework.nonCompliantCount, 0)
    : null;

  return (
    <div>
      <h2>{t('decisionTitle')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('decisionIntro')}</p>
      {error && <p className="error">{error}</p>}

      <div className="grid">
        <div className="card tile"><div className="value">{graph?.nodes?.length ?? '—'}</div><div className="label">{t('decisionGraphNodes')}</div></div>
        <div className="card tile"><div className="value">{graph?.edges?.length ?? '—'}</div><div className="label">{t('decisionGraphEdges')}</div></div>
        <div className="card tile"><div className="value">{twin?.findings?.length ?? '—'}</div><div className="label">{t('decisionTwinFindings')}</div></div>
        <div className="card tile"><div className="value">{nonCompliant ?? '—'}</div><div className="label">{t('decisionEvidenceFailures')}</div></div>
        <div className="card tile"><div className="value">{aiSecurity?.findings?.length ?? '—'}</div><div className="label">{t('decisionAiFindings')}</div></div>
        <div className="card tile"><div className="value">{aiSecurity?.atlasMappings?.length ?? '—'}</div><div className="label">{t('decisionAtlasMappings')}</div></div>
      </div>

      {hasPermission('finding:update') && (
        <form className="stack card" onSubmit={recommend} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div>
            <label htmlFor="decisionBudget">{t('effortBudgetLabel')}</label>
            <input id="decisionBudget" type="number" min="1" value={effortBudget} onChange={(event) => setEffortBudget(event.target.value)} />
          </div>
          <button type="submit" disabled={working}>{working ? t('runningEllipsis') : t('decisionRecommend')}</button>
        </form>
      )}

      {decision && (
        <div className="card">
          <strong>{t('decisionEstimatedReduction')}: {decision.estimatedRiskReduction}</strong>
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>{t('decisionEstimateWarning')}</p>
          <ol>
            {decision.recommendations.map((recommendation) => (
              <li key={recommendation.findingId}>
                <strong>{recommendation.action.type}</strong> — {recommendation.title} ({recommendation.estimatedRiskReduction})
              </li>
            ))}
          </ol>
        </div>
      )}

      {hasPermission('finding:update') && (
        <form className="stack card" onSubmit={simulatePatch} style={{ flexDirection: 'row', alignItems: 'end', maxWidth: 'none' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="simulationCve">{t('decisionPatchCve')}</label>
            <input id="simulationCve" value={cveId} onChange={(event) => setCveId(event.target.value)} required placeholder="CVE-2026-12345" style={{ width: '100%' }} />
          </div>
          <button type="submit" disabled={working}>{t('decisionSimulate')}</button>
        </form>
      )}

      {simulation && (
        <div className="card">
          <strong>{t('decisionBeforeAfter')}: {simulation.riskBefore} → {simulation.estimatedRiskAfter}</strong>
          <p>{t('decisionPathsClosed')}: {simulation.closedAttackPathEdges.length}</p>
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>{simulation.assumptions.join(' ')}</p>
        </div>
      )}

      <h3>{t('decisionCompliance')}</h3>
      <table className="card">
        <thead><tr><th>{t('decisionFramework')}</th><th>{t('decisionFailures')}</th><th>{t('colDetail')}</th></tr></thead>
        <tbody>
          {Object.entries(compliance?.frameworks || {}).map(([name, framework]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{framework.nonCompliantCount}</td>
              <td style={{ color: 'var(--muted)', fontSize: 12 }}>{compliance.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
