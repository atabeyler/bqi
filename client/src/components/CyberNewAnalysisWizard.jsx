import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, cyberAnalysisApi } from '../services/api.js';
import { useLang } from '../services/langContext.jsx';

// The dedicated 5-step "New Analysis" wizard (Asset -> Engines -> Quantum
// -> Scan -> Report). This is NOT the persistent Assets/Scans/Engines/
// Quantum tabs renamed -- it is its own overlay with its own state machine,
// carrying real asset/target/plan data forward step to step, and its plan
// becomes immutable the moment a scan job is actually created (step 4):
// going back after that would let a user silently change what an
// in-flight job is analyzing, so the wizard simply doesn't allow it.
//
// Real backend contract this UI honors (BCI recommends, the user decides,
// only the real selection ever executes):
//   1. Step 2 (Engines): analysisPlanner.js still computes the real
//      recommended+compatible+healthy plan for (target type, requested
//      class), but jobQueue.js's enqueueScan() now accepts a real
//      selectedEngineIds -- a non-empty subset of compatible engines,
//      each entry independently required to be HEALTHY. Recommendation is
//      advisory; incompatible or unhealthy choices are rejected server-side.
//   2. Step 3 (Quantum): the Remediation Optimizer (bci/src/quantum) is
//      still the only thing that ever runs a quantum/quantum-inspired
//      computation, and it still only runs post-scan over real findings
//      -- so the mode picked here is a real *preference* carried forward
//      (scan_jobs.selected_compute_mode at creation, then passed as
//      preferredMode to the optimizer in step 5), never an execution that
//      happens during the scan itself. decideExecutionMode() in
//      executionPolicy.js is the sole authority on what actually runs --
//      org policy and live provider health can still force a fallback,
//      which step 5 reports honestly (selected vs. actual mode, and why).
//   3. Only genuinely backend-supported optimize parameters are exposed:
//      effortBudget and dataClassification (quantum.js's optimizeSchema).
//      No frontend-only parameter is invented.
const STEPS = ['asset', 'engines', 'quantum', 'scan', 'result'];
const COMPUTE_MODES = ['CLASSICAL', 'QUANTUM_INSPIRED', 'QUANTUM_SIMULATOR', 'QUANTUM_HARDWARE'];
const DATA_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'SECRET'];
const REPORT_URGENCY_KEYS = {
  IMMEDIATE: 'bciUrgencyImmediate',
  SHORT_TERM: 'bciUrgencyShortTerm',
  MEDIUM_TERM: 'bciUrgencyMediumTerm',
};
// Provider id that implements each compute mode (bci/src/quantum/registry.js).
const PROVIDER_ID_BY_MODE = {
  CLASSICAL: 'classical',
  QUANTUM_INSPIRED: 'quantum_inspired',
  QUANTUM_SIMULATOR: 'quantum_simulator',
  QUANTUM_HARDWARE: 'ibm_quantum',
};

export function quantumProviderHealthAllowsMode(provider, mode) {
  if (!provider) return false;
  if (provider.status === 'AVAILABLE') return true;
  // Hardware remains explicitly experimental until a live QPU run is
  // validated. Backend policy already permits this DEGRADED state, so the
  // wizard must not incorrectly label a configured provider unavailable.
  return mode === 'QUANTUM_HARDWARE' && provider.status === 'DEGRADED';
}

export function isPartialEngineCoverage(jobStatus, engineRuns = []) {
  return jobStatus === 'COMPLETED'
    && engineRuns.some((run) => run.status === 'COMPLETED')
    && engineRuns.some((run) => run.status !== 'COMPLETED');
}

// True only for the two modes executionPolicy.js's decideExecutionMode
// actually gates on org policy (allowQuantumSimulator / allowQuantumHardware
// -- both govern data leaving the org to a simulator or real QPU).
// CLASSICAL and QUANTUM_INSPIRED never leave the machine and are never
// policy-gated, matching provider.capabilities.policyGated from the
// backend (bci/src/quantum/providers/*).
export function computeModePolicyGate(mode, policy) {
  if (mode === 'QUANTUM_SIMULATOR') return policy.allowQuantumSimulator;
  if (mode === 'QUANTUM_HARDWARE') return policy.allowQuantumHardware;
  return null; // not policy-gated
}

// The real, honest reason a compute mode can't be selected right now --
// built only from data the backend actually returned (provider status,
// its detail string, org policy), never a fabricated message. Returns
// null when the mode IS usable (nothing to explain).
export function explainQuantumModeUnavailable(mode, provider, policy) {
  if (!quantumProviderHealthAllowsMode(provider, mode)) {
    const status = provider?.status || 'UNKNOWN';
    return provider?.detail ? `${status}: ${provider.detail}` : status;
  }
  const policyGate = computeModePolicyGate(mode, policy);
  if (policyGate === false) return 'org_policy_denies_quantum';
  return null;
}

export function isComputeModeUsableFromState(providers, policy, mode) {
  if (!providers || !policy) return false;
  const provider = providers.find((item) => item.id === PROVIDER_ID_BY_MODE[mode]);
  if (!quantumProviderHealthAllowsMode(provider, mode)) return false;
  const policyGate = computeModePolicyGate(mode, policy);
  return policyGate !== false;
}
const ASSET_TYPES = ['DOMAIN', 'HOST', 'WEB_APP', 'API', 'REPOSITORY', 'CONTAINER', 'CLOUD_RESOURCE', 'IDENTITY', 'SERVICE'];
const IDENTIFIER_TYPE_BY_ASSET_TYPE = {
  DOMAIN: 'DOMAIN', HOST: 'IP', WEB_APP: 'URL', API: 'URL', REPOSITORY: 'REPO_URL',
  CONTAINER: 'IMAGE', CLOUD_RESOURCE: 'CLOUD_ACCOUNT_ID', IDENTITY: 'IDENTITY', SERVICE: 'SERVICE',
};
const SCAN_CLASSES = ['PASSIVE', 'SAFE_ACTIVE', 'AUTHENTICATED', 'RESTRICTED'];
const HIGH_PRIORITY_LEVELS = ['IMMEDIATE', '24_HOURS', 'HIGH_PRIORITY'];
const TERMINAL_SCAN_STATUSES = ['COMPLETED', 'NO_COVERAGE', 'FAILED', 'TIMED_OUT', 'CANCELLED'];
const RESILIENCE_SECTION_KEYS = ['bciResSecProfile', 'bciResSecSettings', 'bciResSecModules', 'bciResSecPlan', 'bciResSecRun'];
const RESILIENCE_PROFILE_CARDS = [
  { id: 'FAST', labelKey: 'bciResProfileFastLabel', descKey: 'bciResProfileFastDesc', plan: { requestCountMode: '100', concurrency: 5, targetRps: 10, durationSeconds: 10, profile: 'constant' } },
  { id: 'STANDARD', labelKey: 'bciResProfileStandardLabel', descKey: 'bciResProfileStandardDesc', plan: { requestCountMode: '500', concurrency: 10, targetRps: 25, durationSeconds: 30, profile: 'ramp_up', rampUpSeconds: 10 } },
  { id: 'INTENSIVE', labelKey: 'bciResProfileIntensiveLabel', descKey: 'bciResProfileIntensiveDesc', plan: { requestCountMode: '5000', concurrency: 50, targetRps: 100, durationSeconds: 60, profile: 'spike', rampUpSeconds: 10, rampDownSeconds: 10 } },
  { id: 'CUSTOM', labelKey: 'bciResProfileCustomLabel', descKey: 'bciResProfileCustomDesc', plan: null },
  { id: 'UNLIMITED', labelKey: 'bciResProfileUnlimitedLabel', descKey: 'bciResProfileUnlimitedDesc', plan: { requestCountMode: 'UNLIMITED', concurrency: 10, targetRps: 20, durationEnabled: false, profile: 'sustained' } },
];
const LOAD_SHAPE_KEYS = {
  constant: ['bciLoadShapeConstantLabel', 'bciLoadShapeConstantDesc'], ramp_up: ['bciLoadShapeRampUpLabel', 'bciLoadShapeRampUpDesc'],
  ramp_down: ['bciLoadShapeRampDownLabel', 'bciLoadShapeRampDownDesc'], step: ['bciLoadShapeStepLabel', 'bciLoadShapeStepDesc'],
  spike: ['bciLoadShapeSpikeLabel', 'bciLoadShapeSpikeDesc'], burst: ['bciLoadShapeBurstLabel', 'bciLoadShapeBurstDesc'],
  sustained: ['bciLoadShapeSustainedLabel', 'bciLoadShapeSustainedDesc'],
};
const RESILIENCE_STATUS_KEYS = {
  STABLE: 'bciResStatusStable', DEGRADING: 'bciResStatusDegrading',
  SATURATED: 'bciResStatusSaturated', RECOVERED: 'bciResStatusRecovered',
  RECOVERY_FAILED: 'bciResStatusRecoveryFailed', RATE_LIMITED: 'bciResStatusRateLimited',
  INCONCLUSIVE: 'bciResStatusInconclusive',
};
const FUZZ_SECTION_KEYS = ['bciFuzzSecDiscovery', 'bciFuzzSecEndpoints', 'bciFuzzSecCategories', 'bciFuzzSecPlan', 'bciFuzzSecRun'];
const FUZZ_SOURCE_LABELS = { target: 'Target URL', html_link: 'HTML Link', html_form: 'HTML Form', robots_txt: 'robots.txt', sitemap: 'sitemap.xml', openapi: 'OpenAPI / Swagger' };
const INTRUSIVE_SECTION_KEYS = ['bciIntSecTarget', 'bciIntSecModules', 'bciIntSecSelection', 'bciIntSecPlan', 'bciIntSecRun'];

export function buildResilienceRequestedPlan({
  requestCountMode, customTotalRequests, concurrency, targetRps, durationEnabled, durationSeconds,
  requestTimeoutSeconds = 5, rampUpSeconds = 0, rampDownSeconds = 0, profile = 'constant',
}) {
  const totalRequests = requestCountMode === 'UNLIMITED' ? null : requestCountMode === 'CUSTOM' ? Number(customTotalRequests) : Number(requestCountMode);
  return {
    requestCountMode,
    totalRequests,
    concurrency: Number(concurrency),
    targetRps: Number(targetRps),
    durationMs: durationEnabled ? Number(durationSeconds) * 1000 : null,
    requestTimeoutMs: Number(requestTimeoutSeconds) * 1000,
    rampUpMs: Number(rampUpSeconds) * 1000,
    rampDownMs: Number(rampDownSeconds) * 1000,
    profile,
  };
}

// Best-effort, advisory-only, always user-editable suggestion from the
// target string's shape -- never authoritative (real enforcement is
// server-side typed-scope matching, bci/src/lib/targetMatcher.js, which
// this never calls or substitutes for). Matches the product rule: BCI may
// suggest, the user decides.
function guessAssetType(value) {
  const v = value.trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(v)) return 'CLOUD_RESOURCE';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return 'HOST';
  if (/^https?:\/\//i.test(v)) return 'WEB_APP';
  if (/github\.com|gitlab\.com|bitbucket\.org/i.test(v)) return 'REPOSITORY';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return 'DOMAIN';
  return 'DOMAIN';
}

const inputCls = 'w-full bg-black/25 border border-cyan-400/20 rounded px-2.5 py-2 text-[13px] text-cyan-100 focus:border-cyan-300 focus:outline-none';
const btnCls = 'border border-cyan-300/35 text-cyan-100 px-3 py-2 rounded text-[13px] hover:bg-cyan-400/10 disabled:opacity-40 disabled:cursor-not-allowed';
const btnPrimaryCls = 'bg-cyan-400/15 border border-cyan-300/50 text-cyan-100 px-4 py-2 rounded text-[13px] hover:bg-cyan-400/25 disabled:opacity-40 disabled:cursor-not-allowed';
const tableWrap = 'overflow-x-auto';
const th = 'text-left text-[11px] tracking-widest uppercase text-cyan-100/50 px-2 py-2 border-b border-cyan-300/15 whitespace-nowrap';
const td = 'text-[13px] text-cyan-100/85 px-2 py-2 border-b border-cyan-300/10 whitespace-nowrap';

function Panel({ title, children }) {
  return (
    <section className="hud-panel rounded-xl p-4 sm:p-5">
      <h2 className="text-cyan-100 text-sm tracking-widest uppercase mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Badge({ tone, children }) {
  const tones = { ok: 'text-emerald-300', warn: 'text-gold', danger: 'text-red-400', muted: 'text-cyan-100/50' };
  return <span className={tones[tone] || tones.muted}>{children}</span>;
}

function ErrorNote({ error }) {
  if (!error) return null;
  return <div className="text-red-300 text-[13px] border border-red-400/30 rounded p-2 mb-3">{error}</div>;
}

function safeApiErrorMessage(error) {
  const fieldErrors = error?.data?.details?.fieldErrors || {};
  const issues = Object.entries(fieldErrors)
    .flatMap(([field, messages]) => (messages || []).map((message) => `${field}: ${message}`))
    .slice(0, 5);
  const reason = error?.data?.reason || error?.data?.detail;
  return [error?.message || 'request_failed', reason, ...issues].filter(Boolean).join(': ');
}

const ADVISOR_VERDICT_KEYS = {
  NO_FINDINGS: 'bciVerdictNoFindings',
  NEEDS_REVIEW: 'bciVerdictNeedsReview',
  CRITICAL: 'bciVerdictCritical',
  PARTIAL_COVERAGE: 'bciVerdictPartialCoverage',
};

function advisorVerdictTone(verdict) {
  if (verdict === 'CRITICAL') return 'danger';
  if (verdict === 'NEEDS_REVIEW' || verdict === 'PARTIAL_COVERAGE') return 'warn';
  return 'ok';
}

function AiAdvisorAssessmentBlock({ assessment, t }) {
  if (!assessment) return null;
  const scope = Array.isArray(assessment.scopeCovered) ? assessment.scopeCovered.join(', ') : assessment.scopeCovered;
  const limitations = Array.isArray(assessment.limitations) ? assessment.limitations : [assessment.limitations].filter(Boolean);
  return (
    <div className="space-y-2 text-[12px]">
      {assessment.verdict && (
        <p><Badge tone={advisorVerdictTone(assessment.verdict)}>{t(ADVISOR_VERDICT_KEYS[assessment.verdict] || assessment.verdict)}</Badge></p>
      )}
      <p className="text-cyan-100/70">{assessment.summary}</p>
      {assessment.coverageNarrative && <p className="text-cyan-100/50">{assessment.coverageNarrative}</p>}
      <p className="text-cyan-100/45 text-[11px]">{t('bciScopeCoveredLabel')}: {scope || '—'}</p>
      {assessment.keyEvidence?.length > 0 && <div className="text-[11px]"><p className="text-cyan-100/45">{t('bciKeyEvidenceLabel')}:</p><ul className="list-disc pl-5">{assessment.keyEvidence.map((item) => <li key={item.findingId}>{item.title} · {item.priority || '—'} · {item.riskScore ?? '—'}</li>)}</ul></div>}
      {limitations.length > 0 && <div className="text-gold/70 text-[11px]"><p>{t('bciLimitationsLabel')}:</p><ul className="list-disc pl-5">{limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {assessment.suggestedNextStep && <p className="text-cyan-100/50 text-[11px]">{t('bciSuggestedNextStepLabel')}: {assessment.suggestedNextStep}</p>}
    </div>
  );
}

function scoreTone(score) {
  if (score == null) return 'text-cyan-100/40';
  if (score >= 80) return 'text-emerald-300';
  if (score >= 50) return 'text-gold';
  return 'text-red-400';
}

function scanStatusTone(status) {
  if (status === 'COMPLETED') return 'ok';
  if (status === 'NO_COVERAGE') return 'warn';
  if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(status)) return 'danger';
  return 'warn';
}

function quantumHealthTone(status) {
  if (status === 'AVAILABLE') return 'ok';
  if (status === 'DEGRADED') return 'warn';
  if (status === 'NOT_CONFIGURED') return 'muted';
  return 'danger'; // UNAVAILABLE
}

function engineStatusTone(status) {
  if (status === 'HEALTHY') return 'ok';
  if (status === 'DEGRADED') return 'warn';
  if (status === 'UNKNOWN') return 'muted';
  return 'danger';
}

export default function CyberNewAnalysisWizard({ onClose, onGoToFindings }) {
  const { t, lang } = useLang();
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);

  // Step 1 -- Asset
  const [mode, setMode] = useState('existing');
  const [assets, setAssets] = useState(null);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newAssetType, setNewAssetType] = useState('DOMAIN');
  const [newCriticality, setNewCriticality] = useState('MEDIUM');
  const [duplicateAsset, setDuplicateAsset] = useState(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [savingAsset, setSavingAsset] = useState(false);
  const [resolvedAsset, setResolvedAsset] = useState(null); // { id, name, asset_type, criticality, status, target }

  useEffect(() => {
    cyberAnalysisApi.listAssets('ACTIVE').then((r) => setAssets(r.assets)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => { setNewAssetType(guessAssetType(newTarget || '')); }, [newTarget]);

  async function checkDuplicateAndCreate() {
    if (!newName.trim() || !newTarget.trim()) return;
    setError(null);
    setCheckingDuplicate(true);
    try {
      const { asset: existing } = await cyberAnalysisApi.findAssetByTarget(newTarget.trim());
      if (existing) {
        setDuplicateAsset(existing);
        return;
      }
      setSavingAsset(true);
      const { asset } = await cyberAnalysisApi.createAsset({ name: newName.trim(), assetType: newAssetType, criticality: newCriticality });
      await cyberAnalysisApi.addAssetIdentifier(asset.id, {
        identifierType: IDENTIFIER_TYPE_BY_ASSET_TYPE[newAssetType] || newAssetType,
        value: newTarget.trim(),
      });
      setResolvedAsset({ ...asset, target: newTarget.trim() });
    } catch (err) {
      setError(err.message);
    } finally {
      setCheckingDuplicate(false);
      setSavingAsset(false);
    }
  }

  function useDuplicateAsset() {
    setMode('existing');
    setSelectedAssetId(duplicateAsset.id);
    setResolvedAsset(duplicateAsset);
    setDuplicateAsset(null);
  }

  function selectExisting(asset) {
    setSelectedAssetId(asset.id);
    setResolvedAsset(asset);
  }

  function switchAssetMode(nextMode) {
    setMode(nextMode);
    setSelectedAssetId(null);
    setResolvedAsset(null);
    setDuplicateAsset(null);
    setError(null);
  }

  // Step 2 -- Engines: BCI recommends, the user narrows the checked set --
  // never widens it (server enforces the same bound independently).
  const [requestedClass, setRequestedClass] = useState('PASSIVE');
  const [scopeDecision, setScopeDecision] = useState(null); // { decision, reason, targetType }
  const [enginePlan, setEnginePlan] = useState(null); // { engines, hasExecutableEngine }
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [selectedEngineIds, setSelectedEngineIds] = useState([]);
  const [selectedCapabilities, setSelectedCapabilities] = useState([]);
  // Whether the user has manually touched the class dropdown for the
  // current asset -- once true, BCI never overrides their choice.
  const [classTouchedByUser, setClassTouchedByUser] = useState(false);
  // Which asset.target the auto-suggestion below has already run for, so
  // it only ever probes once per asset rather than on every class change.
  const autoSuggestedForRef = useRef(null);
  const [autoSuggestedClass, setAutoSuggestedClass] = useState(null);
  const [resilienceCatalog, setResilienceCatalog] = useState(null);
  const [resilienceSection, setResilienceSection] = useState(0);
  const [resilienceProfileCard, setResilienceProfileCard] = useState('STANDARD');
  const [resilienceAdvanced, setResilienceAdvanced] = useState(false);
  const [resilienceUserModuleIds, setResilienceUserModuleIds] = useState([]);
  const [requestCountMode, setRequestCountMode] = useState('500');
  const [customTotalRequests, setCustomTotalRequests] = useState(1000);
  const [resilienceConcurrency, setResilienceConcurrency] = useState(10);
  const [resilienceTargetRps, setResilienceTargetRps] = useState(25);
  const [resilienceDurationEnabled, setResilienceDurationEnabled] = useState(true);
  const [resilienceDurationSeconds, setResilienceDurationSeconds] = useState(30);
  const [resilienceRequestTimeoutSeconds, setResilienceRequestTimeoutSeconds] = useState(5);
  const [resilienceRampUpSeconds, setResilienceRampUpSeconds] = useState(10);
  const [resilienceRampDownSeconds, setResilienceRampDownSeconds] = useState(0);
  const [resilienceLoadProfile, setResilienceLoadProfile] = useState('ramp_up');
  const [fuzzCatalog, setFuzzCatalog] = useState(null);
  const [fuzzDiscovery, setFuzzDiscovery] = useState(null);
  const [fuzzDiscoveryLoading, setFuzzDiscoveryLoading] = useState(false);
  const [fuzzSection, setFuzzSection] = useState(0);
  const [fuzzAdvanced, setFuzzAdvanced] = useState(false);
  const [fuzzUserPlan, setFuzzUserPlan] = useState([]);
  const [intrusivePlan, setIntrusivePlan] = useState(null);
  const [intrusivePlanLoading, setIntrusivePlanLoading] = useState(false);
  const [intrusiveSection, setIntrusiveSection] = useState(0);
  const [intrusiveAdvanced, setIntrusiveAdvanced] = useState(false);
  const [intrusivePriorFindingIds, setIntrusivePriorFindingIds] = useState([]);
  const [intrusiveUserModuleIds, setIntrusiveUserModuleIds] = useState([]);
  const [nucleiProfile, setNucleiProfile] = useState('STANDARD');
  const [nucleiCategories, setNucleiCategories] = useState(['CVE', 'MISCONFIGURATION', 'EXPOSURE']);
  const [naabuPortProfile, setNaabuPortProfile] = useState('TOP_PORTS');
  const [naabuCustomPorts, setNaabuCustomPorts] = useState('80,443,8080');
  const [semgrepConfig, setSemgrepConfig] = useState('auto');
  const [fuzzBaseProfile, setFuzzBaseProfile] = useState('STANDARD');
  const [fuzzCustomMaxParameters, setFuzzCustomMaxParameters] = useState(100);
  const [authProfileId, setAuthProfileId] = useState('');
  const [engagementId, setEngagementId] = useState('');

  useEffect(() => {
    setClassTouchedByUser(false);
    setAutoSuggestedClass(null);
    setSelectedCapabilities([]);
    setFuzzDiscovery(null);
    setFuzzUserPlan([]);
    setFuzzSection(0);
    setIntrusivePlan(null);
    setIntrusivePriorFindingIds([]);
    setIntrusiveUserModuleIds([]);
    setIntrusiveSection(0);
    setAuthProfileId('');
    autoSuggestedForRef.current = null;
  }, [resolvedAsset?.target]);

  useEffect(() => {
    if (step !== 1 || !resolvedAsset?.target) return;
    let alive = true;
    setLoadingPlan(true);
    setEnginePlan(null);
    setScopeDecision(null);
    cyberAnalysisApi.evaluateScope(resolvedAsset.target, requestedClass)
      .then(async (decision) => {
        if (!alive) return;
        setScopeDecision(decision);
        if (decision.decision === 'ALLOW') {
          const plan = await cyberAnalysisApi.getEnginePlan(decision.targetType, requestedClass, selectedCapabilities);
          if (!alive) return;

          // BCI recommends a scan class too, not just engines: a target
          // type can genuinely have zero executable engines at one class
          // (e.g. a DOMAIN target has no engine that can run PASSIVE-only,
          // since even a missing-HSTS check is a real HTTP request) while
          // a higher, still-real class does. Probe classes in order once
          // per asset and jump straight to the lowest one that actually
          // has something to run, rather than leaving the user stuck on a
          // default that was never going to work for this target type.
          if (!classTouchedByUser && !plan.hasExecutableEngine && autoSuggestedForRef.current !== resolvedAsset.target) {
            autoSuggestedForRef.current = resolvedAsset.target;
            for (const candidateClass of SCAN_CLASSES) {
              if (candidateClass === requestedClass) continue;
              const candidatePlan = await cyberAnalysisApi.getEnginePlan(decision.targetType, candidateClass);
              if (!alive) return;
              if (candidatePlan.hasExecutableEngine) {
                setAutoSuggestedClass(candidateClass);
                setSelectedCapabilities([]);
                setRequestedClass(candidateClass);
                return; // re-runs this effect with the better class
              }
            }
          }

          if (selectedCapabilities.length === 0) {
            const defaults = plan.capabilities.filter((capability) => capability.available).map((capability) => capability.id);
            if (defaults.length > 0) {
              setSelectedCapabilities(defaults);
              return;
            }
          }
          setEnginePlan(plan);
          // Default selection: every recommended engine that is also
          // actually HEALTHY right now -- the real, immediately runnable
          // subset of BCI's recommendation. The user can narrow further.
          setSelectedEngineIds(plan.engines.filter((e) => e.recommended && e.status === 'HEALTHY').map((e) => e.id));
        }
      })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoadingPlan(false));
    return () => { alive = false; };
  }, [step, resolvedAsset, requestedClass, classTouchedByUser, selectedCapabilities]);

  function toggleEngine(engineId) {
    setSelectedEngineIds((ids) => (ids.includes(engineId) ? ids.filter((id) => id !== engineId) : [...ids, engineId]));
  }

  function toggleCapability(capabilityId) {
    setSelectedCapabilities((ids) => ids.includes(capabilityId)
      ? (ids.length > 1 ? ids.filter((id) => id !== capabilityId) : ids)
      : [...ids, capabilityId]);
  }

  const resilienceSelected = selectedEngineIds.includes('availability-probe') && selectedCapabilities.includes('DOS');
  const fuzzSelected = selectedEngineIds.includes('http-fuzz') && selectedCapabilities.includes('FUZZ');
  const intrusiveSelected = selectedEngineIds.includes('intrusive-validation') && selectedCapabilities.includes('INTRUSIVE');
  useEffect(() => {
    if (step !== 1 || !resilienceSelected || resilienceCatalog) return;
    cyberAnalysisApi.listResilienceModules()
      .then(setResilienceCatalog)
      .catch((err) => setError(err.message));
  }, [step, resilienceSelected, resilienceCatalog]);

  useEffect(() => {
    if (step !== 1 || !fuzzSelected || fuzzCatalog) return;
    cyberAnalysisApi.getFuzzCatalog().then(setFuzzCatalog).catch((err) => setError(err.message));
  }, [step, fuzzSelected, fuzzCatalog]);

  async function refreshIntrusivePlan(priorFindingIds = intrusivePriorFindingIds) {
    setIntrusivePlanLoading(true); setError(null);
    try {
      const plan = engagementId
        ? await cyberAnalysisApi.getIntrusivePlan(resolvedAsset.target, priorFindingIds, authProfileId || undefined, engagementId)
        : authProfileId
        ? await cyberAnalysisApi.getIntrusivePlan(resolvedAsset.target, priorFindingIds, authProfileId)
        : await cyberAnalysisApi.getIntrusivePlan(resolvedAsset.target, priorFindingIds);
      setIntrusivePlan(plan);
      setIntrusiveUserModuleIds((ids) => ids.filter((id) => plan.modules.some((module) => module.id === id && module.status === 'IMPLEMENTED' && module.applicable)));
    } catch (err) { setError(`Intrusive plan failed: ${err.message}`); }
    finally { setIntrusivePlanLoading(false); }
  }

  useEffect(() => {
    if (step !== 1 || !intrusiveSelected || intrusivePlan) return;
    refreshIntrusivePlan([]);
  }, [step, intrusiveSelected, intrusivePlan]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleIntrusivePriorFinding(findingId) {
    const next = intrusivePriorFindingIds.includes(findingId)
      ? intrusivePriorFindingIds.filter((id) => id !== findingId)
      : [...intrusivePriorFindingIds, findingId];
    setIntrusivePriorFindingIds(next);
    await refreshIntrusivePlan(next);
  }

  function toggleIntrusiveUserModule(moduleId) {
    setIntrusiveUserModuleIds((ids) => ids.includes(moduleId) ? ids.filter((id) => id !== moduleId) : [...ids, moduleId]);
  }

  async function runFuzzDiscovery() {
    setFuzzDiscoveryLoading(true); setError(null);
    try {
      // Asset types (WEB_APP, HOST, …) are a UI/inventory taxonomy. The
      // discovery API accepts the canonical execution target types returned
      // by the policy classifier (URL, IP, DOMAIN, …). Passing WEB_APP here
      // made every scan class fail schema validation with `invalid_request`.
      const discovery = await cyberAnalysisApi.discoverFuzzSurface(resolvedAsset.target, scopeDecision?.targetType, {
        ...(engagementId ? { engagementId } : {}),
        baseProfile: fuzzBaseProfile,
        ...(fuzzBaseProfile === 'CUSTOM' ? { customMaxParameters: Number(fuzzCustomMaxParameters) } : {}),
        ...(authProfileId ? { authProfileId } : {}),
      });
      setFuzzDiscovery(discovery); setFuzzUserPlan([]);
    } catch (err) { setError(`Discovery failed: ${safeApiErrorMessage(err)}`); }
    finally { setFuzzDiscoveryLoading(false); }
  }

  function toggleFuzzUserCategory(endpoint, parameter, categoryId) {
    const entry = { method: endpoint.method, url: endpoint.url, parameter: parameter.name, location: parameter.location, categoryId };
    const key = `${entry.method}|${entry.url}|${entry.location}|${entry.parameter}|${entry.categoryId}`;
    setFuzzUserPlan((plan) => plan.some((item) => `${item.method}|${item.url}|${item.location}|${item.parameter}|${item.categoryId}` === key)
      ? plan.filter((item) => `${item.method}|${item.url}|${item.location}|${item.parameter}|${item.categoryId}` !== key)
      : [...plan, entry]);
  }

  const resiliencePlan = buildResilienceRequestedPlan({
    requestCountMode, customTotalRequests, concurrency: resilienceConcurrency, targetRps: resilienceTargetRps,
    durationEnabled: resilienceDurationEnabled, durationSeconds: resilienceDurationSeconds,
    requestTimeoutSeconds: resilienceRequestTimeoutSeconds, rampUpSeconds: resilienceRampUpSeconds,
    rampDownSeconds: resilienceRampDownSeconds, profile: resilienceLoadProfile,
  });
  const resiliencePlanValid = !resilienceSelected || (
    !!resilienceCatalog && Number.isInteger(resiliencePlan.concurrency) && resiliencePlan.concurrency > 0
    && Number.isFinite(resiliencePlan.targetRps) && resiliencePlan.targetRps > 0
    && (resiliencePlan.totalRequests === null || (Number.isInteger(resiliencePlan.totalRequests) && resiliencePlan.totalRequests > 0))
    && (resiliencePlan.durationMs === null || (Number.isInteger(resiliencePlan.durationMs) && resiliencePlan.durationMs > 0))
    && Number.isInteger(resiliencePlan.requestTimeoutMs) && resiliencePlan.requestTimeoutMs > 0
    && Number.isInteger(resiliencePlan.rampUpMs) && resiliencePlan.rampUpMs >= 0
    && Number.isInteger(resiliencePlan.rampDownMs) && resiliencePlan.rampDownMs >= 0
    && (resiliencePlan.durationMs === null || resiliencePlan.rampUpMs + resiliencePlan.rampDownMs <= resiliencePlan.durationMs)
    && (resilienceCatalog?.loadPlanCapabilities?.profileOptions || []).some((option) => option.id === resiliencePlan.profile)
  );

  const recommendedResilienceProfile = ['HIGH', 'CRITICAL'].includes(resolvedAsset?.criticality) ? 'INTENSIVE' : 'STANDARD';
  function selectResilienceProfile(profile) {
    setResilienceProfileCard(profile.id);
    if (!profile.plan) return;
    const p = profile.plan;
    setRequestCountMode(p.requestCountMode);
    setResilienceConcurrency(p.concurrency);
    setResilienceTargetRps(p.targetRps);
    setResilienceDurationEnabled(p.durationEnabled ?? true);
    if (p.durationSeconds) setResilienceDurationSeconds(p.durationSeconds);
    setResilienceLoadProfile(p.profile);
    setResilienceRampUpSeconds(p.rampUpSeconds || 0);
    setResilienceRampDownSeconds(p.rampDownSeconds || 0);
  }

  function toggleResilienceModule(moduleId) {
    setResilienceUserModuleIds((ids) => ids.includes(moduleId) ? ids.filter((id) => id !== moduleId) : [...ids, moduleId]);
  }

  // Step 3 -- Quantum: a real preference among the modes the org's policy
  // and live provider health actually allow right now. The final decision
  // (with any forced fallback) is always made server-side, at optimize
  // time in step 5, by decideExecutionMode() -- this is a preference, not
  // an execution.
  const [quantumProviders, setQuantumProviders] = useState(null);
  const [quantumPolicy, setQuantumPolicy] = useState(null);
  // BCI's own recommendation, fetched from the real backend decision chain
  // (GET /quantum/recommendation -> executionPolicy.js's decideExecutionMode)
  // -- never re-derived client-side. { recommendedMode, reason } | null
  // while loading.
  const [quantumRecommendation, setQuantumRecommendation] = useState(null);
  const [selectedComputeMode, setSelectedComputeMode] = useState(null);
  const [quantumLoadError, setQuantumLoadError] = useState(null);
  const [quantumReload, setQuantumReload] = useState(0);
  const [effortBudget, setEffortBudget] = useState(5);
  const [dataClassification, setDataClassification] = useState('INTERNAL');

  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setQuantumLoadError(null);
    Promise.allSettled([
      cyberAnalysisApi.listQuantumProviders(),
      cyberAnalysisApi.getQuantumPolicy(),
      cyberAnalysisApi.getQuantumRecommendation(),
    ])
      .then(([providersResult, policyResult, recommendationResult]) => {
        if (cancelled) return;
        if (providersResult.status === 'rejected' || policyResult.status === 'rejected') {
          const reasons = [providersResult, policyResult]
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason?.message || 'bci_unavailable');
          setQuantumLoadError(reasons.join(' · '));
          return;
        }
        const providers = providersResult.value.providers;
        const policy = policyResult.value.policy;
        const recommendation = recommendationResult.status === 'fulfilled' ? recommendationResult.value : null;
        setQuantumProviders(providers);
        setQuantumPolicy(policy);
        setQuantumRecommendation(recommendation);
        // The real BCI recommendation is only the wizard's DEFAULT/starting
        // selection (spec: BCI recommends, the user decides) -- the user
        // remains free to pick any other usable compute mode below.
        const recommendedMode = recommendation?.recommendedMode;
        const defaultMode = isComputeModeUsableFromState(providers, policy, recommendedMode)
          ? recommendedMode
          : COMPUTE_MODES.find((mode) => isComputeModeUsableFromState(providers, policy, mode));
        setSelectedComputeMode(defaultMode || null);
        if (!recommendation) setQuantumLoadError(t('bciRecommendationUnavailableNote'));
      });
    return () => { cancelled = true; };
  }, [step, quantumReload]);

  function isComputeModeUsable(mode) {
    return isComputeModeUsableFromState(quantumProviders, quantumPolicy, mode);
  }

  // Step 4 -- Scan (plan freezes the instant the job is created)
  const [job, setJob] = useState(null);
  const [engineRuns, setEngineRuns] = useState([]);
  const [starting, setStarting] = useState(false);
  const [resilienceRounds, setResilienceRounds] = useState([]);
  const [resilienceAdvice, setResilienceAdvice] = useState(null);
  const [resilienceAdviceLoading, setResilienceAdviceLoading] = useState(false);
  const [resilienceAdviceRejected, setResilienceAdviceRejected] = useState(false);
  const [editingAdaptivePlan, setEditingAdaptivePlan] = useState(false);
  const [adaptivePlanDraft, setAdaptivePlanDraft] = useState([]);
  const [fuzzExecutions, setFuzzExecutions] = useState([]);
  const [fuzzAdvice, setFuzzAdvice] = useState(null);
  const [fuzzAdviceLoading, setFuzzAdviceLoading] = useState(false);
  const [fuzzAdviceRejected, setFuzzAdviceRejected] = useState(false);
  const [editingFuzzAdaptivePlan, setEditingFuzzAdaptivePlan] = useState(false);
  const [fuzzAdaptivePlanDraft, setFuzzAdaptivePlanDraft] = useState([]);
  const [intrusiveExecutions, setIntrusiveExecutions] = useState([]);
  const [intrusiveAdvice, setIntrusiveAdvice] = useState(null);
  const [intrusiveAdviceLoading, setIntrusiveAdviceLoading] = useState(false);
  const [intrusiveAdviceRejected, setIntrusiveAdviceRejected] = useState(false);
  const [editingIntrusiveAdaptivePlan, setEditingIntrusiveAdaptivePlan] = useState(false);
  const [intrusiveAdaptivePlanDraft, setIntrusiveAdaptivePlanDraft] = useState([]);

  useEffect(() => {
    if (!job || TERMINAL_SCAN_STATUSES.includes(job.status)) return undefined;
    const interval = setInterval(async () => {
      try {
        const [{ job: latest }, { engineRuns: runs }] = await Promise.all([
          cyberAnalysisApi.getScan(job.id),
          cyberAnalysisApi.getScanEngineRuns(job.id),
        ]);
        setJob(latest);
        setEngineRuns(runs);
        if (TERMINAL_SCAN_STATUSES.includes(latest.status)) clearInterval(interval);
      } catch {
        clearInterval(interval);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [job?.id, job?.status]);

  async function startAnalysis() {
    setStarting(true);
    setError(null);
    try {
      const engineOptions = {};
      if (selectedEngineIds.includes('nuclei')) engineOptions.nuclei = { scanProfile: nucleiProfile, templateCategories: nucleiProfile === 'BCI_BUNDLED' ? [] : nucleiCategories };
      if (selectedEngineIds.includes('naabu')) engineOptions.naabu = { portProfile: naabuPortProfile, ...(naabuPortProfile === 'CUSTOM' ? { customPorts: naabuCustomPorts } : {}) };
      if (selectedEngineIds.includes('semgrep')) engineOptions.semgrep = { config: semgrepConfig };
      if (resilienceSelected) engineOptions['availability-probe'] = { requestedPlan: resiliencePlan, userSelectedModuleIds: resilienceUserModuleIds };
      if (fuzzSelected) engineOptions['http-fuzz'] = { baseProfile: fuzzBaseProfile, ...(engagementId ? { engagementId } : {}), ...(fuzzBaseProfile === 'CUSTOM' ? { customMaxParameters: Number(fuzzCustomMaxParameters) } : {}), ...(authProfileId ? { authProfileId } : {}), userPlan: fuzzUserPlan };
      if (intrusiveSelected) engineOptions['intrusive-validation'] = {
        ...(engagementId ? { engagementId } : {}),
        ...(authProfileId ? { authProfileId } : {}),
        userSelectedModuleIds: intrusiveUserModuleIds,
        priorFindings: (intrusivePlan?.selectedPriorFindings || []).map((finding) => ({
          id: finding.id, title: finding.title, location: finding.location, evidence: finding.evidence,
        })),
      };
      const { job: created } = await cyberAnalysisApi.createScan({
        target: resolvedAsset.target,
        requestedClass,
        selectedEngineIds,
        selectedCapabilities,
        selectedComputeMode,
        ...(Object.keys(engineOptions).length ? { engineOptions } : {}),
      });
      setJob(created);
      const { engineRuns: runs } = await cyberAnalysisApi.getScanEngineRuns(created.id).catch(() => ({ engineRuns: [] }));
      setEngineRuns(runs);
    } catch (err) {
      setError(safeApiErrorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => {
    if (!job?.id || !resilienceSelected) return;
    cyberAnalysisApi.getScanResilienceRounds(job.id)
      .then((response) => setResilienceRounds(response.rounds || []))
      .catch(() => setResilienceRounds([]));
  }, [job?.id, job?.status, resilienceSelected]);

  useEffect(() => {
    if (!job?.id || job.status !== 'COMPLETED' || !resilienceSelected) return;
    setResilienceAdviceLoading(true);
    api.cyberAnalysisResilienceStrategy(job.id, dataClassification, lang)
      .then((advice) => { setResilienceAdvice(advice); setAdaptivePlanDraft(advice.adaptivePlan || []); })
      .catch(() => setResilienceAdvice(null))
      .finally(() => setResilienceAdviceLoading(false));
  }, [job?.id, job?.status, resilienceSelected, dataClassification, lang]);

  async function startAdaptiveResilienceAnalysis() {
    if (adaptivePlanDraft.length === 0) return;
    setStarting(true);
    setError(null);
    try {
      const priorFindings = (resultFindings || []).slice(0, 20).map((finding) => ({
        id: finding.id, title: finding.title, location: finding.location,
        ...(finding.evidence ? { evidence: finding.evidence } : {}),
      }));
      const { job: created } = await cyberAnalysisApi.createScan({
        target: resolvedAsset.target, requestedClass, selectedEngineIds: ['availability-probe'],
        selectedCapabilities: ['DOS'], selectedComputeMode,
        engineOptions: { 'availability-probe': {
          requestedPlan: resiliencePlan, userSelectedModuleIds: resilienceUserModuleIds,
          adaptivePlan: adaptivePlanDraft, ...(priorFindings.length ? { priorFindings } : {}),
        } },
      });
      setJob(created);
      setEngineRuns([]);
      setResilienceRounds([]);
      setResilienceAdvice(null);
      setEditingAdaptivePlan(false);
      setStep(3);
    } catch (err) { setError(err.message); } finally { setStarting(false); }
  }

  useEffect(() => {
    if (!job?.id || !fuzzSelected) return;
    cyberAnalysisApi.getScanFuzzResults(job.id)
      .then((response) => setFuzzExecutions(response.executions || []))
      .catch(() => setFuzzExecutions([]));
  }, [job?.id, job?.status, fuzzSelected]);

  useEffect(() => {
    if (!job?.id || job.status !== 'COMPLETED' || !fuzzSelected) return;
    setFuzzAdviceLoading(true);
    api.cyberAnalysisFuzzStrategy(job.id, dataClassification, lang)
      .then((advice) => { setFuzzAdvice(advice); setFuzzAdaptivePlanDraft(advice.adaptivePlan || []); })
      .catch(() => setFuzzAdvice(null))
      .finally(() => setFuzzAdviceLoading(false));
  }, [job?.id, job?.status, fuzzSelected, dataClassification, lang]);

  async function startAdaptiveFuzzAnalysis() {
    if (fuzzAdaptivePlanDraft.length === 0) return;
    setStarting(true); setError(null);
    try {
      const { job: created } = await cyberAnalysisApi.createScan({
        target: resolvedAsset.target, requestedClass, selectedEngineIds: ['http-fuzz'], selectedCapabilities: ['FUZZ'], selectedComputeMode,
        engineOptions: { 'http-fuzz': { baseProfile: fuzzBaseProfile, ...(engagementId ? { engagementId } : {}), ...(fuzzBaseProfile === 'CUSTOM' ? { customMaxParameters: Number(fuzzCustomMaxParameters) } : {}), ...(authProfileId ? { authProfileId } : {}), userPlan: fuzzUserPlan, adaptivePlan: fuzzAdaptivePlanDraft } },
      });
      setJob(created); setEngineRuns([]); setFuzzExecutions([]); setFuzzAdvice(null); setEditingFuzzAdaptivePlan(false); setStep(3);
    } catch (err) { setError(err.message); } finally { setStarting(false); }
  }

  useEffect(() => {
    if (!job?.id || !intrusiveSelected) return;
    cyberAnalysisApi.getScanIntrusiveResults(job.id)
      .then((response) => setIntrusiveExecutions(response.executions || []))
      .catch(() => setIntrusiveExecutions([]));
  }, [job?.id, job?.status, intrusiveSelected]);

  useEffect(() => {
    if (!job?.id || job.status !== 'COMPLETED' || !intrusiveSelected) return;
    setIntrusiveAdviceLoading(true);
    api.cyberAnalysisIntrusiveStrategy(job.id, dataClassification, lang)
      .then((advice) => { setIntrusiveAdvice(advice); setIntrusiveAdaptivePlanDraft(advice.adaptivePlan || []); })
      .catch(() => setIntrusiveAdvice(null))
      .finally(() => setIntrusiveAdviceLoading(false));
  }, [job?.id, job?.status, intrusiveSelected, dataClassification, lang]);

  async function startAdaptiveIntrusiveAnalysis() {
    if (intrusiveAdaptivePlanDraft.length === 0) return;
    setStarting(true); setError(null);
    try {
      const { job: created } = await cyberAnalysisApi.createScan({
        target: resolvedAsset.target, requestedClass, selectedEngineIds: ['intrusive-validation'],
        selectedCapabilities: ['INTRUSIVE'], selectedComputeMode,
        engineOptions: { 'intrusive-validation': {
          ...(engagementId ? { engagementId } : {}),
          ...(authProfileId ? { authProfileId } : {}),
          userSelectedModuleIds: intrusiveUserModuleIds,
          adaptivePlan: intrusiveAdaptivePlanDraft,
          priorFindings: (intrusivePlan?.selectedPriorFindings || []).map((finding) => ({ id: finding.id })),
        } },
      });
      setJob(created); setEngineRuns([]); setIntrusiveExecutions([]); setIntrusiveAdvice(null);
      setEditingIntrusiveAdaptivePlan(false); setStep(3);
    } catch (err) { setError(err.message); } finally { setStarting(false); }
  }

  // Step 5 -- Result: real findings linked to this exact scan's immutable
  // normalized evidence. Repeated scans of the same asset stay separate;
  // plus the real per-scan remediation optimization run against exactly
  // this job's findings, carrying the wizard's chosen compute-method
  // preference through to the real fallback chain.
  const [resultFindings, setResultFindings] = useState(null);
  const [optimization, setOptimization] = useState(null); // real optimizeRemediation() result, or null while pending
  const [optimizationError, setOptimizationError] = useState(null);
  const [optimizing, setOptimizing] = useState(false);
  const [aiAssessment, setAiAssessment] = useState(null);
  const [aiAssessing, setAiAssessing] = useState(false);

  // Fires as soon as the real job reaches a terminal state -- not gated on
  // which step the user happens to be viewing -- so the TARAMA step (3)
  // can show its own real finding/severity summary the moment the scan
  // finishes, and by the time the user clicks through to RAPOR (step 4)
  // the AI assessment + quantum optimization are already available rather
  // than making them wait again. Bulgular -> normalization/correlation ->
  // risk (M7/M9) have already run server-side by the time job.status is
  // COMPLETED (analysisPipeline.js), so this only ever evaluates real,
  // already-scored evidence -- never triggers before it exists.
  useEffect(() => {
    if (!resolvedAsset?.target || !job || !TERMINAL_SCAN_STATUSES.includes(job.status)) return;
    cyberAnalysisApi.getScanFindings(job.id)
      .then((r) => setResultFindings(r.findings))
      .catch(() => setResultFindings([]));

    if (job.status !== 'COMPLETED') return; // NO_COVERAGE/FAILED/etc. have no findings to optimize
    setAiAssessing(true);
    api.cyberAnalysisScanAssessment(job.id, dataClassification, lang)
      .then(setAiAssessment)
      .catch(() => setAiAssessment(null))
      .finally(() => setAiAssessing(false));
    setOptimizing(true);
    setOptimizationError(null);
    cyberAnalysisApi.optimizeRemediationForScan({
      effortBudget,
      dataClassification,
      findingIds: job.result?.findingIds || [],
      preferredMode: selectedComputeMode,
      scanJobId: job.id,
    }).then(setOptimization).catch((err) => setOptimizationError(safeApiErrorMessage(err))).finally(() => setOptimizing(false));
  }, [resolvedAsset, job]); // eslint-disable-line react-hooks/exhaustive-deps

  const planFrozen = !!job;
  const canGoBack = step > 0 && step < 3; // never back past a created job (step 3=scan once job exists), never past result
  const stepLabels = [t('cyberWizStepAsset'), t('cyberWizStepEngines'), t('cyberWizStepQuantum'), t('cyberWizStepScan'), t('cyberWizStepResult')];

  const canProceedFromAsset = !!resolvedAsset?.target;
  const selectedCapabilitiesCovered = selectedCapabilities.every((capabilityId) => selectedEngineIds.some((engineId) => {
    const engine = enginePlan?.engines.find((candidate) => candidate.id === engineId);
    return (engine?.targetCapabilities || engine?.capabilities || []).includes(capabilityId);
  }));
  const canProceedFromEngines = scopeDecision?.decision === 'ALLOW' && !!enginePlan?.hasExecutableEngine && selectedEngineIds.length > 0 && selectedCapabilities.length > 0 && selectedCapabilitiesCovered && resiliencePlanValid && (!resilienceSelected || resilienceSection === 3) && (!fuzzSelected || (!!fuzzDiscovery && fuzzSection === 3)) && (!intrusiveSelected || (!!intrusivePlan && intrusiveSection === 3));
  const canProceedFromQuantum = !!selectedComputeMode;

  return (
    <div className="fixed inset-0 z-[99] bg-black/80 overflow-y-auto p-3 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="hud-panel rounded-xl p-4 sm:p-5 flex items-center justify-between">
          <div>
            <p className="text-gold/70 text-xs tracking-widest uppercase">{t('cyberNewAnalysis')}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {stepLabels.map((label, i) => (
                <React.Fragment key={label}>
                  {i > 0 && <span className="text-cyan-100/20">→</span>}
                  <span className={`text-[11px] tracking-widest uppercase flex items-center gap-1 ${i === step ? 'text-cyan-100' : 'text-cyan-100/40'}`}>
                    <span>{i === step ? '●' : '○'}</span> {label}
                  </span>
                </React.Fragment>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-cyan-100/60 hover:text-cyan-100"><X className="w-5 h-5" /></button>
        </div>

        <ErrorNote error={error} />

        {step === 0 && (
          <Panel title={t('cyberWizStepAsset')}>
            <div className="flex gap-2 mb-4">
              <button className={mode === 'existing' ? btnPrimaryCls : btnCls} onClick={() => switchAssetMode('existing')}>{t('cyberWizExistingAsset')}</button>
              <button className={mode === 'new' ? btnPrimaryCls : btnCls} onClick={() => switchAssetMode('new')}>{t('cyberWizNewAsset')}</button>
            </div>

            {mode === 'existing' && (
              assets && (assets.length === 0 ? (
                <p className="text-cyan-100/40 text-sm">{t('cyberNoneYet')}</p>
              ) : (
                <div className={tableWrap}>
                  <table className="w-full">
                    <thead><tr><th className={th}></th><th className={th}>{t('cyberColName')}</th><th className={th}>{t('cyberColTarget')}</th><th className={th}>{t('cyberColType')}</th><th className={th}>{t('cyberColCriticality')}</th></tr></thead>
                    <tbody>
                      {assets.map((a) => (
                        <tr key={a.id} className="cursor-pointer hover:bg-cyan-400/5" onClick={() => a.target && selectExisting(a)}>
                          <td className={td}><input type="radio" checked={selectedAssetId === a.id} readOnly disabled={!a.target} /></td>
                          <td className={td}>{a.name}</td>
                          <td className={`${td} text-cyan-100/60`}>{a.target || t('cyberNoTargetYet')}</td>
                          <td className={td}>{a.asset_type}</td>
                          <td className={td}>{a.criticality}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            )}

            {mode === 'new' && (
              <div className="space-y-2">
                <div className="grid sm:grid-cols-2 gap-2">
                  <input className={inputCls} placeholder={t('cyberNamePlaceholder')} value={newName} onChange={(e) => setNewName(e.target.value)} />
                  <input className={inputCls} placeholder={t('cyberAssetTargetPlaceholder')} value={newTarget} onChange={(e) => { setNewTarget(e.target.value); setDuplicateAsset(null); }} />
                </div>
                {newTarget.trim() && (
                  <p className="text-cyan-100/40 text-xs">{t('cyberWizDetectedType', { type: newAssetType })}</p>
                )}
                <div className="grid sm:grid-cols-2 gap-2">
                  <select className={inputCls} value={newAssetType} onChange={(e) => setNewAssetType(e.target.value)}>
                    {ASSET_TYPES.map((at) => <option key={at} value={at}>{at}</option>)}
                  </select>
                  <select className={inputCls} value={newCriticality} onChange={(e) => setNewCriticality(e.target.value)}>
                    {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {duplicateAsset && (
                  <div className="border border-gold/30 rounded p-3 space-y-2">
                    <p className="text-gold text-[13px]">{t('cyberWizDuplicateTarget')}</p>
                    <button className={btnPrimaryCls} onClick={useDuplicateAsset}>{t('cyberWizUseExisting')}</button>
                  </div>
                )}

                {!resolvedAsset && (
                  <button
                    className={btnCls}
                    disabled={!newName.trim() || !newTarget.trim() || checkingDuplicate || savingAsset}
                    onClick={checkDuplicateAndCreate}
                  >
                    {checkingDuplicate || savingAsset ? t('cyberLoading') : t('cyberAddAssetBtn')}
                  </button>
                )}
              </div>
            )}

            {resolvedAsset && (
              <div className="mt-4 pt-4 border-t border-cyan-300/10 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[13px]">
                <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColName')}</span>{resolvedAsset.name}</div>
                <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColTarget')}</span>{resolvedAsset.target}</div>
                <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColType')}</span>{resolvedAsset.asset_type}</div>
                <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColCriticality')}</span>{resolvedAsset.criticality}</div>
              </div>
            )}
          </Panel>
        )}

        {step === 1 && (
          <Panel title={t('cyberWizStepEngines')}>
            <div className="mb-3">
              <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberColClass')}</label>
              <select className={inputCls} value={requestedClass} onChange={(e) => { setClassTouchedByUser(true); setSelectedCapabilities([]); setRequestedClass(e.target.value); }}>
                {SCAN_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              {autoSuggestedClass === requestedClass && (
                <p className="text-cyan-100/40 text-xs mt-1">{t('cyberWizClassAutoSuggested', { class: autoSuggestedClass })}</p>
              )}
            </div>

            {loadingPlan && <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>}

            {scopeDecision && scopeDecision.decision !== 'ALLOW' && (
              <div className="border border-red-400/30 rounded p-3 text-red-300 text-[13px]">{t('cyberWizScopeDenied', { reason: scopeDecision.reason })}</div>
            )}

            {enginePlan && (
              <>
                <p className="text-cyan-100/40 text-xs mb-2">{t('bciCapabilitiesHeader')}</p>
                <div className="grid sm:grid-cols-2 gap-2 mb-4">
                  {enginePlan.capabilities.map((capability) => (
                    <label key={capability.id} className={`border border-cyan-300/15 rounded p-2 text-[12px] ${capability.available ? 'cursor-pointer' : 'opacity-45'}`}>
                      <input
                        type="checkbox"
                        className="mr-2"
                        checked={selectedCapabilities.includes(capability.id)}
                        disabled={!capability.available}
                        onChange={() => toggleCapability(capability.id)}
                      />
                      <span className="text-cyan-100">{capability.name}</span>
                      <span className="block ml-5 text-cyan-100/45">{capability.id} · {capability.available ? t('bciAvailableBadge') : t('bciUnavailableBadge')}</span>
                    </label>
                  ))}
                </div>
                <p className="text-cyan-100/40 text-xs mb-2">{t('cyberWizSelectEngines')}</p>
                <div className={tableWrap}>
                  <table className="w-full">
                    <thead><tr><th className={th}></th><th className={th}>{t('cyberColEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberWizCompatible')}</th><th className={th}>{t('bciCapabilitiesClassColumn')}</th><th className={th}>{t('cyberWizRecommendation')}</th></tr></thead>
                    <tbody>
                      {enginePlan.engines.map((e) => {
                        // Recommendation is advisory. Any healthy, compatible
                        // engine is a valid user choice; coverage validation
                        // below still prevents an incomplete selection.
                        const selectable = e.compatible && e.status === 'HEALTHY' && e.inputReady !== false;
                        return (
                          <tr key={e.id} className={selectable ? 'cursor-pointer hover:bg-cyan-400/5' : 'opacity-50'} onClick={() => selectable && toggleEngine(e.id)}>
                            <td className={td}>
                              <input aria-label={`engine ${e.id}`} type="checkbox" checked={selectedEngineIds.includes(e.id)} disabled={!selectable} readOnly />
                            </td>
                            <td className={td}><span className="block">{e.name}</span>{e.reasons?.length > 0 && <span className="text-cyan-100/35 text-[10px]">{e.reasons.join(', ')}</span>}</td>
                            <td className={td}><Badge tone={engineStatusTone(e.status)}>{e.status}</Badge></td>
                            <td className={td}>{e.compatible ? <Badge tone="ok">{t('cyberWizYes')}</Badge> : <Badge tone="muted">{t('cyberWizNo')}</Badge>}</td>
                            <td className={td}><span className="block">{(e.targetCapabilities || e.capabilities).join(', ')}</span><span className="text-cyan-100/40">{e.intrusiveness}</span></td>
                            <td className={td}>{e.recommended ? <Badge tone="ok">{t('cyberWizRecommended')}</Badge> : <Badge tone="muted">—</Badge>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-cyan-100/40 text-xs mt-2">
                  {t('cyberWizEngineSummary', {
                    total: enginePlan.engines.length,
                    healthy: enginePlan.engines.filter((e) => e.status === 'HEALTHY').length,
                    compatible: enginePlan.engines.filter((e) => e.compatible).length,
                    recommended: enginePlan.engines.filter((e) => e.recommended).length,
                  })}
                </p>
                {(selectedEngineIds.includes('nuclei') || selectedEngineIds.includes('naabu') || selectedEngineIds.includes('semgrep')) && <div className="mt-4 grid sm:grid-cols-2 gap-3 border border-cyan-300/15 rounded-xl p-3">
                  {selectedEngineIds.includes('nuclei') && <div className="space-y-2"><p className="text-cyan-100 text-xs">{t('bciNucleiScopeLabel')}</p><select aria-label="Nuclei scan profile" className={inputCls} value={nucleiProfile} onChange={(e) => { const profile = e.target.value; setNucleiProfile(profile); if (profile === 'STANDARD') setNucleiCategories(['CVE', 'MISCONFIGURATION', 'EXPOSURE']); if (profile === 'EXTENDED') setNucleiCategories(['CVE', 'MISCONFIGURATION', 'EXPOSURE', 'VULNERABILITY', 'TECHNOLOGY']); if (profile === 'FULL_SAFE') setNucleiCategories(['CVE', 'MISCONFIGURATION', 'EXPOSURE', 'VULNERABILITY', 'TECHNOLOGY', 'API']); if (profile === 'BCI_BUNDLED') setNucleiCategories([]); }}><option value="BCI_BUNDLED">BCI BUNDLED</option><option value="STANDARD">STANDARD</option><option value="EXTENDED">EXTENDED</option><option value="FULL_SAFE">FULL SAFE</option></select>{nucleiProfile !== 'BCI_BUNDLED' && <div className="flex flex-wrap gap-2">{['CVE', 'MISCONFIGURATION', 'EXPOSURE', 'VULNERABILITY', 'TECHNOLOGY', 'API'].map((category) => <label key={category} className="text-[10px]"><input type="checkbox" className="mr-1" checked={nucleiCategories.includes(category)} onChange={() => setNucleiCategories((values) => values.includes(category) ? values.filter((id) => id !== category) : [...values, category])} />{category}</label>)}</div>}<p className="text-cyan-100/35 text-[10px]">{t('bciNucleiBundledNote')}</p></div>}
                  {selectedEngineIds.includes('naabu') && <div className="space-y-2"><p className="text-cyan-100 text-xs">{t('bciNaabuScopeLabel')}</p><select aria-label="Naabu port profile" className={inputCls} value={naabuPortProfile} onChange={(e) => setNaabuPortProfile(e.target.value)}><option value="TOP_PORTS">TOP PORTS</option><option value="PORTS_1_1000">1-1000</option><option value="FULL_PORTS">FULL PORTS</option><option value="CUSTOM">CUSTOM</option></select>{naabuPortProfile === 'CUSTOM' && <input aria-label="Naabu custom ports" className={inputCls} value={naabuCustomPorts} onChange={(e) => setNaabuCustomPorts(e.target.value)} placeholder="80,443,8000-8100" />}</div>}
                  {selectedEngineIds.includes('semgrep') && <div className="space-y-2"><p className="text-cyan-100 text-xs">{t('bciSemgrepRulesetLabel')}</p><select aria-label="Semgrep config" className={inputCls} value={semgrepConfig} onChange={(e) => setSemgrepConfig(e.target.value)}><option value="auto">auto</option><option value="p/default">p/default</option><option value="p/security-audit">p/security-audit</option><option value="p/owasp-top-ten">p/owasp-top-ten</option></select><p className="text-cyan-100/35 text-[10px]">{t('bciSemgrepFullRepoNote')}</p></div>}
                </div>}
                {resilienceSelected && (
                  <div className="mt-4 border border-cyan-300/25 rounded-xl p-3 sm:p-4 space-y-4">
                    <div>
                      <p className="text-cyan-100 text-sm tracking-wider">{t('bciSmartResilienceTitle')}</p>
                      <p className="text-cyan-100/45 text-[11px]">{t('bciResRecommendNote')}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {RESILIENCE_SECTION_KEYS.map((key, index) => (
                        <span key={key} className={`px-2 py-1 rounded border text-[10px] ${index === resilienceSection ? 'border-cyan-300/50 text-cyan-100 bg-cyan-400/10' : 'border-cyan-300/10 text-cyan-100/35'}`}>
                          {index + 1} · {t(key)}
                        </span>
                      ))}
                    </div>
                    {!resilienceCatalog && <p className="text-cyan-100/50 text-xs">{t('cyberLoading')}</p>}
                    {resilienceCatalog && resilienceSection === 0 && (
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {RESILIENCE_PROFILE_CARDS.map((profile) => (
                          <button key={profile.id} type="button" onClick={() => selectResilienceProfile(profile)} className={`text-left border rounded-lg p-3 ${resilienceProfileCard === profile.id ? 'border-cyan-300/55 bg-cyan-400/10' : 'border-cyan-300/15 hover:bg-cyan-400/5'}`}>
                            <span className="text-cyan-100 text-xs block">{t(profile.labelKey)}</span>
                            {recommendedResilienceProfile === profile.id && <span className="text-emerald-300 text-[10px] block">⭐ {t('bciFuzzRecommendationLabel')}</span>}
                            <span className="text-cyan-100/45 text-[11px] block mt-1">{t(profile.descKey)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {resilienceCatalog && resilienceSection === 1 && (
                      <div className="space-y-3">
                        <div className="grid sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-cyan-100/50 text-xs mb-1">{t('bciReqCountLabel')}</label>
                            <select aria-label="Resilience request count" className={inputCls} value={requestCountMode} onChange={(e) => { setResilienceProfileCard('CUSTOM'); setRequestCountMode(e.target.value); }}>
                              {resilienceCatalog.loadPlanCapabilities.requestCountOptions.map((option) => (
                                <option key={option.id} value={option.id}>{option.id === 'UNLIMITED' ? 'UNLIMITED' : option.id === 'CUSTOM' ? 'CUSTOM' : Number(option.totalRequests).toLocaleString(t('locale'))}</option>
                              ))}
                            </select>
                          </div>
                          {requestCountMode === 'CUSTOM' && <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciCustomTotalRequestsLabel')}</label><input aria-label="Custom total requests" type="number" min="1" step="1" className={inputCls} value={customTotalRequests} onChange={(e) => setCustomTotalRequests(e.target.value)} /></div>}
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciConcurrencyLabel')}</label><input aria-label="Resilience concurrency" type="number" min="1" step="1" className={inputCls} value={resilienceConcurrency} onChange={(e) => setResilienceConcurrency(e.target.value)} /></div>
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciTargetRpsLabel')}</label><input aria-label="Resilience target RPS" type="number" min="0.1" step="0.1" className={inputCls} value={resilienceTargetRps} onChange={(e) => setResilienceTargetRps(e.target.value)} /></div>
                          <div>
                            <label className="block text-cyan-100/50 text-xs mb-1">{t('bciDurationLabel')}</label>
                            <select aria-label="Resilience duration mode" className={inputCls} value={resilienceDurationEnabled ? 'TIMED' : 'USER_STOPPED'} onChange={(e) => setResilienceDurationEnabled(e.target.value === 'TIMED')}>
                              <option value="TIMED">{t('bciDurationTimedOption')}</option><option value="USER_STOPPED">{t('bciDurationUntilStoppedOption')}</option>
                            </select>
                          </div>
                          {resilienceDurationEnabled && <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciDurationSecondsLabel')}</label><input aria-label="Resilience duration seconds" type="number" min="1" step="1" className={inputCls} value={resilienceDurationSeconds} onChange={(e) => setResilienceDurationSeconds(e.target.value)} /></div>}
                        </div>
                        {requestCountMode === 'UNLIMITED' && <p className="text-gold/80 text-[11px]">{t('bciUnlimitedRequestsNote')}</p>}
                        <button type="button" className={btnCls} onClick={() => setResilienceAdvanced((value) => !value)}>{resilienceAdvanced ? t('bciBasicSettingsToggle') : t('bciAdvancedSettingsToggle')}</button>
                        {resilienceAdvanced && <div className="grid sm:grid-cols-2 gap-2 border-t border-cyan-300/10 pt-3">
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciRequestTimeoutLabel')}</label><input aria-label="Resilience request timeout" type="number" min="0.001" step="0.1" className={inputCls} value={resilienceRequestTimeoutSeconds} onChange={(e) => setResilienceRequestTimeoutSeconds(e.target.value)} /></div>
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciRampUpLabel')}</label><input aria-label="Resilience ramp up" type="number" min="0" step="1" className={inputCls} value={resilienceRampUpSeconds} onChange={(e) => setResilienceRampUpSeconds(e.target.value)} /></div>
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciRampDownLabel')}</label><input aria-label="Resilience ramp down" type="number" min="0" step="1" className={inputCls} value={resilienceRampDownSeconds} onChange={(e) => setResilienceRampDownSeconds(e.target.value)} /></div>
                          <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciLoadShapeLabel')}</label><select aria-label="Resilience load shape" className={inputCls} value={resilienceLoadProfile} onChange={(e) => setResilienceLoadProfile(e.target.value)}>{resilienceCatalog.loadPlanCapabilities.profileOptions.map((option) => <option key={option.id} value={option.id}>{LOAD_SHAPE_KEYS[option.id] ? t(LOAD_SHAPE_KEYS[option.id][0]) : option.name}</option>)}</select><p className="text-cyan-100/35 text-[10px] mt-1">{LOAD_SHAPE_KEYS[resilienceLoadProfile] ? t(LOAD_SHAPE_KEYS[resilienceLoadProfile][1]) : ''}</p></div>
                        </div>}
                      </div>
                    )}
                    {resilienceCatalog && resilienceSection === 2 && <div className="space-y-2">
                      <p className="text-cyan-100/45 text-[11px]">{t('bciResModulesNote')}</p>
                      <div className="grid sm:grid-cols-2 gap-2">{resilienceCatalog.modules.map((module) => {
                        const ready = module.status === 'IMPLEMENTED';
                        return <label key={module.id} className={`border rounded p-2 text-[11px] ${ready ? 'border-cyan-300/15 cursor-pointer' : 'border-cyan-300/10 opacity-55'}`}>
                          <input type="checkbox" className="mr-2" disabled={!ready} checked={resilienceUserModuleIds.includes(module.id)} onChange={() => toggleResilienceModule(module.id)} />
                          <span className="text-cyan-100">{module.name}</span><span className="block ml-5">{ready ? t('bciModuleReadyBadge') : t('bciModulePlannedBadge')}</span>
                          <span className="block ml-5 text-cyan-100/35">{module.description}{module.blockedOn ? ` · ${module.blockedOn}` : ''}</span>
                        </label>;
                      })}</div>
                    </div>}
                    {resilienceCatalog && resilienceSection === 3 && <div className="space-y-3 text-[12px]">
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div className="border border-emerald-400/20 rounded p-3"><p className="text-emerald-300 text-[10px] uppercase">⭐ {t('bciFuzzRecommendationLabel')}</p><p>{(() => { const rp = RESILIENCE_PROFILE_CARDS.find((p) => p.id === recommendedResilienceProfile); return rp ? t(rp.labelKey) : null; })()}</p><p className="text-cyan-100/45">{t('bciTargetCriticalityLabel')} {resolvedAsset?.criticality || '—'}</p></div>
                        <div className="border border-cyan-300/25 rounded p-3"><p className="text-cyan-100/45 text-[10px] uppercase">{t('bciUserPlanLabel')}</p><p>{resilienceProfileCard} · {resiliencePlan.totalRequests ?? t('bciUnlimitedBadge')} {t('bciRequestsUnit')}</p><p>{resiliencePlan.concurrency} concurrency · {resiliencePlan.targetRps} RPS · {resiliencePlan.durationMs == null ? t('bciUntilUserStops') : `${resiliencePlan.durationMs / 1000} ${t('bciSecondsUnit')}`} · {LOAD_SHAPE_KEYS[resiliencePlan.profile] ? t(LOAD_SHAPE_KEYS[resiliencePlan.profile][0]) : ''}</p></div>
                      </div>
                      <div className="border border-cyan-300/10 rounded p-3"><p className="text-cyan-100/45 text-[10px] uppercase">{t('bciEstimatedPlanLabel')}</p><p>{t('bciTargetLabel')} {resolvedAsset?.target} · {t('bciKnownEndpointNote')}</p><p>{t('bciUserModulesLabel')} {resilienceUserModuleIds.join(', ') || t('bciNoneLabel')} · {t('bciBaseModulesDynamicNote')}</p></div>
                    </div>}
                    {!resiliencePlanValid && <p className="text-red-300 text-[11px]">{t('bciInvalidPlanNote')}</p>}
                    <div className="flex justify-between border-t border-cyan-300/10 pt-3">
                      <button type="button" className={btnCls} disabled={resilienceSection === 0} onClick={() => setResilienceSection((value) => value - 1)}>{t('bciResPrevBtn')}</button>
                      <button type="button" className={btnPrimaryCls} disabled={!resiliencePlanValid || resilienceSection === 3} onClick={() => setResilienceSection((value) => value + 1)}>{t('bciResNextBtn')}</button>
                    </div>
                  </div>
                )}
                {(fuzzSelected || intrusiveSelected) && <label className="block mt-4 text-cyan-100/60 text-xs">Pentest engagement ID<input aria-label="Pentest engagement ID" className={inputCls} value={engagementId} onChange={(e) => { setEngagementId(e.target.value.trim()); setFuzzDiscovery(null); setIntrusivePlan(null); }} placeholder="Optional saved BCI engagement UUID" /></label>}
                {fuzzSelected && <div className="mt-4 border border-cyan-300/25 rounded-xl p-3 sm:p-4 space-y-4">
                  <div><p className="text-cyan-100 text-sm tracking-wider">{t('bciSmartFuzzTitle')}</p><p className="text-cyan-100/45 text-[11px]">{t('bciFuzzBaseGuaranteeNote', { count: fuzzCatalog?.baseMinTestsPerParameter ?? '—' })}</p></div>
                  <div className="flex flex-wrap gap-1.5">{FUZZ_SECTION_KEYS.map((key, index) => <span key={key} className={`px-2 py-1 rounded border text-[10px] ${index === fuzzSection ? 'border-cyan-300/50 text-cyan-100 bg-cyan-400/10' : 'border-cyan-300/10 text-cyan-100/35'}`}>{index + 1} · {t(key)}</span>)}</div>
                  {!fuzzCatalog && <p className="text-cyan-100/50 text-xs">{t('cyberLoading')}</p>}
                  {fuzzCatalog && fuzzSection === 0 && <div className="space-y-3 text-[12px]">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2"><div><span className="text-cyan-100/40 block">{t('cyberColTarget')}</span>{resolvedAsset?.target}</div><div><span className="text-cyan-100/40 block">{t('bciAssetLabel')}</span>{resolvedAsset?.asset_type}</div><div><span className="text-cyan-100/40 block">{t('bciCriticalityLabel')}</span>{resolvedAsset?.criticality}</div><div><span className="text-cyan-100/40 block">ENGINE</span>http-fuzz</div><div><span className="text-cyan-100/40 block">CAPABILITY</span>FUZZ</div></div>
                    <div className="grid sm:grid-cols-2 gap-2"><div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciFuzzBaseScopeLabel')}</label><select aria-label="Fuzz base profile" className={inputCls} value={fuzzBaseProfile} onChange={(e) => { setFuzzBaseProfile(e.target.value); setFuzzDiscovery(null); }}><option value="STANDARD">{t('bciFuzzStandardOption')}</option><option value="EXTENDED">{t('bciFuzzExtendedOption')}</option><option value="FULL">{t('bciFuzzFullOption')}</option><option value="CUSTOM">CUSTOM</option></select></div>{fuzzBaseProfile === 'CUSTOM' && <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciFuzzMaxParamLabel')}</label><input aria-label="Fuzz custom max parameters" type="number" min="1" className={inputCls} value={fuzzCustomMaxParameters} onChange={(e) => { setFuzzCustomMaxParameters(e.target.value); setFuzzDiscovery(null); }} /></div>}<div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciAuthProfileLabel')}</label><input aria-label="BCI auth profile" className={inputCls} value={authProfileId} onChange={(e) => { setAuthProfileId(e.target.value.toUpperCase()); setFuzzDiscovery(null); setIntrusivePlan(null); }} placeholder="ADMIN_API" /><p className="text-cyan-100/35 text-[10px]">{t('bciAuthProfileNote')}</p></div></div>
                    <button type="button" className={btnPrimaryCls} disabled={fuzzDiscoveryLoading} onClick={runFuzzDiscovery}>{fuzzDiscoveryLoading ? t('bciDiscoveryRunning') : t('bciStartDiscovery')}</button>
                    {fuzzDiscovery && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 border-t border-cyan-300/10 pt-3"><div>{fuzzDiscovery.summary.endpoints}<span className="block text-cyan-100/40">Endpoint</span></div><div>{fuzzDiscovery.summary.parameters}<span className="block text-cyan-100/40">{t('bciParameterLabel')}</span></div><div>{fuzzDiscovery.summary.getEndpoints}<span className="block text-cyan-100/40">GET</span></div><div>{fuzzDiscovery.summary.mutatingEndpoints}<span className="block text-cyan-100/40">Mutating</span></div></div>}
                  </div>}
                  {fuzzCatalog && fuzzSection === 1 && <div className="space-y-2">{fuzzDiscovery?.endpoints.map((endpoint) => <div key={`${endpoint.method}-${endpoint.url}`} className="border border-cyan-300/10 rounded p-2 text-[11px]"><div className="flex justify-between gap-2"><span className="text-cyan-100">{endpoint.method} {endpoint.url}</span><Badge tone={endpoint.executable ? 'ok' : 'muted'}>{endpoint.executable ? t('bciFuzzApplicableBadge') : t('bciFuzzDiscoveredNoBaseBadge')}</Badge></div><p className="text-cyan-100/40">{FUZZ_SOURCE_LABELS[endpoint.source] || endpoint.source} · {endpoint.params.length} {t('bciParametersUnit')}</p>{endpoint.params.map((parameter) => <p key={`${parameter.location}-${parameter.name}`} className="ml-2">{parameter.name} · {parameter.type} · {parameter.location} · {endpoint.executable ? t('bciBaseMinNote', { count: fuzzCatalog.baseMinTestsPerParameter }) : t('bciNotExecutable')}</p>)}</div>)}</div>}
                  {fuzzCatalog && fuzzSection === 2 && <div className="space-y-3">
                    <button type="button" className={btnCls} onClick={() => setFuzzAdvanced((value) => !value)}>{fuzzAdvanced ? t('bciBasicView') : t('bciAdvancedCategorySelection')}</button>
                    <p className="text-cyan-100/45 text-[11px]">{t('bciFuzzCatalogSummary', { count: fuzzCatalog.categories.length, profile: fuzzBaseProfile, productCap: t('bciNoCapLabel'), userCap: fuzzCatalog.maxUserProbes ?? t('bciNoCapLabel'), aiBudget: fuzzCatalog.maxAdaptiveProbes })}</p>
                    {fuzzAdvanced && fuzzDiscovery?.endpoints.filter((endpoint) => endpoint.executable).flatMap((endpoint) => endpoint.params.map((parameter) => <div key={`${endpoint.url}-${parameter.name}`} className="border border-cyan-300/10 rounded p-2"><p className="text-cyan-100 text-[11px]">{endpoint.method} {endpoint.url} · {parameter.name}</p><p className="text-cyan-100/40 text-[10px]">🔒 BCI BASE: {(fuzzCatalog.defaultCategoryIdsByType[parameter.type] || fuzzCatalog.defaultCategoryIdsByType.generic).join(', ')}</p><div className="flex flex-wrap gap-2 mt-2">{fuzzCatalog.categories.map((category) => { const checked = fuzzUserPlan.some((entry) => entry.url === endpoint.url && entry.parameter === parameter.name && entry.location === parameter.location && entry.categoryId === category.id); return <label key={category.id} className="text-[10px]"><input type="checkbox" className="mr-1" checked={checked} onChange={() => toggleFuzzUserCategory(endpoint, parameter, category.id)} />{category.id} · USER</label>; })}</div></div>))}
                  </div>}
                  {fuzzCatalog && fuzzSection === 3 && <div className="space-y-3 text-[12px]"><div className="grid sm:grid-cols-2 gap-3"><div className="border border-emerald-400/20 rounded p-3"><p className="text-emerald-300 text-[10px] uppercase">{t('bciFuzzRecommendationLabel')}</p><p>{t('bciFuzzRecommendationText')}</p></div><div className="border border-cyan-300/25 rounded p-3"><p className="text-cyan-100/45 text-[10px] uppercase">{t('bciUserPlanLabel')}</p><p>{t('bciUserExtraProbesLabel')} {fuzzUserPlan.length}</p><p>{t('bciAiAdaptiveNotYetNote')}</p></div></div><div className="border border-cyan-300/10 rounded p-3"><p>{t('bciEndpointLabel')}: {fuzzDiscovery?.summary.endpoints} · {t('bciParameterLabel')}: {fuzzDiscovery?.summary.parameters}</p><p>{t('bciFuzzPlanSummary', { base: fuzzDiscovery?.summary.baseProbes, user: fuzzUserPlan.length, planned: (fuzzDiscovery?.summary.baseProbes || 0) + fuzzUserPlan.length })}</p><p className="text-cyan-100/40">{t('bciFuzzPreviewNote')}</p></div></div>}
                  <div className="flex justify-between border-t border-cyan-300/10 pt-3"><button type="button" className={btnCls} disabled={fuzzSection === 0} onClick={() => setFuzzSection((value) => value - 1)}>{t('bciFuzzPrevBtn')}</button><button type="button" className={btnPrimaryCls} disabled={!fuzzDiscovery || fuzzSection === 3} onClick={() => setFuzzSection((value) => value + 1)}>{t('bciFuzzNextBtn')}</button></div>
                </div>}
                {intrusiveSelected && <div className="mt-4 border border-red-300/25 rounded-xl p-3 sm:p-4 space-y-4">
                  <div><p className="text-cyan-100 text-sm tracking-wider">{t('bciSmartIntrusiveTitle')}</p><p className="text-cyan-100/45 text-[11px]">{t('bciIntrusiveRecommendNote')}</p></div>
                  <div className="flex flex-wrap gap-1.5">{INTRUSIVE_SECTION_KEYS.map((key, index) => <span key={key} className={`px-2 py-1 rounded border text-[10px] ${index === intrusiveSection ? 'border-red-300/50 text-cyan-100 bg-red-400/10' : 'border-cyan-300/10 text-cyan-100/35'}`}>{index + 1} · {t(key)}</span>)}</div>
                  {intrusivePlanLoading && <p className="text-cyan-100/50 text-xs">{t('bciIntrusiveLoadingPlan')}</p>}
                  {intrusivePlan && intrusiveSection === 0 && <div className="space-y-3 text-[12px]">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2"><div><span className="text-cyan-100/40 block">{t('bciAssetLabel')}</span>{resolvedAsset?.name}</div><div><span className="text-cyan-100/40 block">{t('bciTargetTypeLabel')}</span>{resolvedAsset?.target}<br />{resolvedAsset?.asset_type}</div><div><span className="text-cyan-100/40 block">{t('bciCriticalityLabel')}</span>{resolvedAsset?.criticality}</div><div><span className="text-cyan-100/40 block">{t('bciEngineCapabilityClassLabel')}</span>intrusive-validation<br />INTRUSIVE · {requestedClass}</div></div>
                    <p className="text-cyan-100/45">{t('bciFindingsCountNote', { count: intrusivePlan.findings.length })}</p>
                    <div><label className="block text-cyan-100/50 text-xs mb-1">{t('bciAuthProfileLabel')}</label><input aria-label="Intrusive auth profile" className={inputCls} value={authProfileId} onChange={(e) => setAuthProfileId(e.target.value.toUpperCase())} onBlur={() => refreshIntrusivePlan(intrusivePriorFindingIds)} placeholder="ADMIN_API" /></div>
                    {intrusivePlan.findings.length === 0 && <div className="border border-cyan-300/10 rounded p-3 text-cyan-100/45">{t('bciNoPriorFindingsNote')}</div>}
                    {intrusivePlan.findings.map((finding) => { const selected = intrusivePriorFindingIds.includes(finding.id); return <div key={finding.id} className="border border-cyan-300/10 rounded p-2"><div className="flex justify-between gap-2"><div><p className="text-cyan-100">{finding.title}</p><p className="text-cyan-100/45">{finding.engineSeverity || finding.priority || 'UNSCORED'} · {finding.sourceEngine || 'BCI CORRELATION'} · {finding.location || finding.target}</p><p className="text-cyan-100/35">{t('bciRuleLabel')}: {finding.rule || '—'} · {t('bciVerificationLabel')}: {finding.verificationStatus || '—'}</p></div><button type="button" className={selected ? btnPrimaryCls : btnCls} disabled={intrusivePlanLoading} onClick={() => toggleIntrusivePriorFinding(finding.id)}>{selected ? t('bciRemoveFromVerification') : t('bciAddToVerification')}</button></div></div>; })}
                  </div>}
                  {intrusivePlan && intrusiveSection === 1 && <div className="space-y-3">
                    <div className="flex justify-between items-center"><p className="text-cyan-100/45 text-[11px]">{t('bciRegistrySummary', { total: intrusivePlan.summary.total, implemented: intrusivePlan.summary.implemented, planned: intrusivePlan.summary.planned, applicable: intrusivePlan.summary.applicable })}</p><button type="button" className={btnCls} onClick={() => setIntrusiveAdvanced((value) => !value)}>{intrusiveAdvanced ? t('bciBasicToggle') : t('bciAdvancedToggle')}</button></div>
                    <div className="grid sm:grid-cols-2 gap-2">{intrusivePlan.modules.filter((module) => intrusiveAdvanced || module.status === 'IMPLEMENTED').map((module) => <div key={module.id} className={`border rounded p-2 text-[11px] ${module.status === 'PLANNED' ? 'border-cyan-300/10 opacity-55' : module.applicable ? 'border-emerald-400/20' : 'border-gold/20'}`}><p className="text-cyan-100">{module.name}</p><p><Badge tone={module.status === 'PLANNED' ? 'muted' : module.applicable ? 'ok' : 'warn'}>{module.status === 'PLANNED' ? t('bciPlannedNotRunnableBadge') : module.applicable ? t('bciApplicableBadge') : t('bciNotSuitableBadge')}</Badge></p><p className="text-cyan-100/40">{module.id} · {module.family} · {module.requiredIntrusiveness}</p><p className="text-cyan-100/55 mt-1">{module.description}</p>{intrusiveAdvanced && <><p className="text-cyan-100/35">{t('bciApplicabilityLabel')}: {module.applicability} · {t('bciRequiredEvidenceLabel')}: {module.requiredEvidence}</p><p className="text-cyan-100/35">{t('bciSourceLabel')}: {module.source}</p></>}{module.blockedOn && <p className="text-gold/60 mt-1">{module.blockedOn}</p>}</div>)}</div>
                  </div>}
                  {intrusivePlan && intrusiveSection === 2 && <div className="space-y-3 text-[12px]">
                    <div className="border border-emerald-400/20 rounded p-3"><p className="text-emerald-300 text-[10px] uppercase">{t('bciFuzzRecommendationLabel')}</p><p>{intrusivePriorFindingIds.length ? t('bciIntrusiveRecWithFindings', { count: intrusivePriorFindingIds.length }) : t('bciIntrusiveRecNoFindings')}</p><p className="text-cyan-100/40">{t('bciAiCannotStartNote')}</p></div>
                    <div><p className="text-cyan-100/45 mb-2">{t('bciAdminExtraSelectionNote')}</p><div className="grid sm:grid-cols-2 gap-2">{intrusivePlan.modules.map((module) => { const selectable = module.status === 'IMPLEMENTED' && module.applicable; return <label key={module.id} className={`border border-cyan-300/10 rounded p-2 ${selectable ? 'cursor-pointer' : 'opacity-45'}`}><input type="checkbox" className="mr-2" disabled={!selectable} checked={intrusiveUserModuleIds.includes(module.id)} onChange={() => toggleIntrusiveUserModule(module.id)} />{module.name}<span className="block ml-5 text-[10px] text-cyan-100/40">{selectable ? t('bciUserApplicableBadge') : module.status === 'PLANNED' ? 'PLANNED' : 'NOT_APPLICABLE'}</span></label>; })}</div></div>
                  </div>}
                  {intrusivePlan && intrusiveSection === 3 && <div className="space-y-3 text-[12px]"><div className="border border-cyan-300/15 rounded p-3"><p className="text-cyan-100 tracking-wider">{t('bciIntrusivePlanTitle')}</p><p>{t('bciTargetLabel')} {resolvedAsset?.target}</p><p>{t('bciIntrusiveModuleSummary', { base: intrusivePlan.baseModuleIds.length, user: intrusiveUserModuleIds.length })}</p><p>{t('bciTotalValidationSummary', { total: intrusivePlan.baseModuleIds.length + intrusiveUserModuleIds.length, count: intrusivePriorFindingIds.length })}</p><p className="text-cyan-100/40">{t('bciModuleProvenanceNote')}</p></div></div>}
                  <div className="flex justify-between border-t border-cyan-300/10 pt-3"><button type="button" className={btnCls} disabled={intrusiveSection === 0 || intrusivePlanLoading} onClick={() => setIntrusiveSection((value) => value - 1)}>{t('bciIntrusivePrevBtn')}</button><button type="button" className={btnPrimaryCls} disabled={!intrusivePlan || intrusivePlanLoading || intrusiveSection === 3} onClick={() => setIntrusiveSection((value) => value + 1)}>{t('bciIntrusiveNextBtn')}</button></div>
                </div>}
                {!enginePlan.hasExecutableEngine && (
                  <div className="border border-red-400/30 rounded p-3 text-red-300 text-[13px] mt-2">{t('cyberWizNoExecutableEngine')}</div>
                )}
                {enginePlan.hasExecutableEngine && selectedEngineIds.length === 0 && (
                  <div className="border border-gold/30 rounded p-3 text-gold text-[13px] mt-2">{t('cyberWizEngineRequired')}</div>
                )}
                {!selectedCapabilitiesCovered && (
                  <div className="border border-gold/30 rounded p-3 text-gold text-[13px] mt-2">{t('bciCapabilitiesNotCovered')}</div>
                )}
              </>
            )}
          </Panel>
        )}

        {step === 2 && (
          <Panel title={t('cyberWizStepQuantum')}>
            <p className="text-cyan-100/50 text-[13px] mb-3">{t('cyberWizQuantumExplainer')}</p>

            {quantumLoadError && (
              <div className="mb-3">
                <ErrorNote error={quantumLoadError} />
                {!quantumProviders && <button type="button" className={btnCls} onClick={() => setQuantumReload((value) => value + 1)}>{t('bciRetryBtn')}</button>}
              </div>
            )}
            {!quantumProviders && !quantumLoadError && <p className="text-cyan-100/50 text-[13px]">{t('bciCheckingQuantumProviders')}</p>}

            {quantumProviders && quantumPolicy && (
              <>
                <p className="text-cyan-100/40 text-xs mb-2">{t('cyberWizComputeMethod')}</p>
                {/* Every registered provider is shown -- source of truth is
                    quantumProviders (GET /quantum/providers), not a fixed
                    client-side list, so a future 5th provider appears here
                    without a wizard code change as long as it's also added
                    to COMPUTE_MODES/PROVIDER_ID_BY_MODE above. Unusable
                    options are never hidden, only disabled, with the real
                    backend reason shown. */}
                <div className="grid sm:grid-cols-2 gap-2 mb-4">
                  {COMPUTE_MODES.map((mode) => {
                    const provider = quantumProviders.find((p) => p.id === PROVIDER_ID_BY_MODE[mode]);
                    const caps = provider?.capabilities || {};
                    const usable = isComputeModeUsable(mode);
                    const isRecommended = quantumRecommendation?.recommendedMode === mode;
                    const unavailableReason = explainQuantumModeUnavailable(mode, provider, quantumPolicy);
                    const policyGate = computeModePolicyGate(mode, quantumPolicy);
                    return (
                      <label
                        key={mode}
                        className={`block border rounded p-3 text-[13px] ${usable ? 'border-cyan-300/20 cursor-pointer hover:bg-cyan-400/5' : 'border-cyan-300/10 opacity-70'} ${selectedComputeMode === mode ? 'bg-cyan-400/10 border-cyan-300/40' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="radio"
                            name="computeMode"
                            className="mt-1"
                            checked={selectedComputeMode === mode}
                            disabled={!usable}
                            onChange={() => setSelectedComputeMode(mode)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="text-cyan-100 font-medium">{mode}</span>
                              {isRecommended && <Badge tone="ok">⭐ {t('cyberWizBciRecommended')}</Badge>}
                            </div>
                            {caps.experimental && (
                              <p className="text-gold text-[10px] mt-0.5">{t('cyberWizExperimentalQpu')}</p>
                            )}
                            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-[11px] mt-2">
                              <div>
                                <dt className="text-cyan-100/40 uppercase text-[10px]">{t('cyberWizHealthLabel')}</dt>
                                <dd><Badge tone={quantumHealthTone(provider?.status)}>{provider?.status || 'UNKNOWN'}</Badge></dd>
                              </div>
                              <div>
                                <dt className="text-cyan-100/40 uppercase text-[10px]">{t('cyberWizLocalExternalLabel')}</dt>
                                <dd className="text-cyan-100/80">{caps.local ? t('cyberWizLocal') : t('cyberWizExternal')}</dd>
                              </div>
                              <div>
                                <dt className="text-cyan-100/40 uppercase text-[10px]">{t('cyberWizProblemSizeLabel')}</dt>
                                <dd className="text-cyan-100/80">{caps.maxProblemSize == null ? t('cyberWizUnlimitedSize') : caps.maxProblemSize}</dd>
                              </div>
                              <div>
                                <dt className="text-cyan-100/40 uppercase text-[10px]">{t('cyberWizPolicyLabel')}</dt>
                                <dd className="text-cyan-100/80">
                                  {policyGate === null ? t('cyberWizPolicyNotRequired') : (policyGate ? t('cyberWizPolicyEnabled') : t('cyberWizPolicyDisabled'))}
                                </dd>
                              </div>
                              <div className="col-span-2">
                                <dt className="text-cyan-100/40 uppercase text-[10px]">{t('cyberWizApplicabilityLabel')}</dt>
                                <dd><Badge tone={usable ? 'ok' : 'muted'}>{usable ? t('cyberWizApplicableNow') : t('cyberWizNotApplicableNow')}</Badge></dd>
                              </div>
                            </dl>
                            {isRecommended && quantumRecommendation?.reason && (
                              <p className="text-emerald-300/70 text-[11px] mt-2">{quantumRecommendation.reason.replaceAll('_', ' ')}</p>
                            )}
                            {!usable && unavailableReason && (
                              <p className="text-gold/70 text-[11px] mt-2">{t('cyberWizWhyNotAvailable')}: {unavailableReason.replaceAll('_', ' ')}</p>
                            )}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <p className="text-cyan-100/40 text-xs mb-2">{t('cyberWizOptimizationParams')}</p>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberEffortBudgetLabel')}</label>
                    <input
                      type="number"
                      min="1"
                      className={inputCls}
                      value={effortBudget}
                      onChange={(e) => setEffortBudget(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    />
                  </div>
                  <div>
                    <label className="block text-cyan-100/50 text-xs mb-1">{t('cyberDataClassificationLabel')}</label>
                    <select className={inputCls} value={dataClassification} onChange={(e) => setDataClassification(e.target.value)}>
                      {DATA_CLASSIFICATIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>
              </>
            )}
          </Panel>
        )}

        {step === 3 && (
          <Panel title={t('cyberWizStepScan')}>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[13px] mb-4">
              <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColTarget')}</span>{resolvedAsset?.target}</div>
              <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColType')}</span>{resolvedAsset?.asset_type}</div>
              <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColCriticality')}</span>{resolvedAsset?.criticality}</div>
              <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberColClass')}</span>{requestedClass}</div>
              <div className="col-span-2"><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberWizSelectEngines')}</span>{selectedEngineIds.join(', ') || '—'}</div>
              <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberWizComputeMethod')}</span>{selectedComputeMode || '—'}</div>
            </div>

            {resilienceSelected && <div className="border border-cyan-300/20 rounded-lg p-3 mb-4 space-y-3">
              <div className="flex justify-between gap-2 flex-wrap"><p className="text-cyan-100 text-[13px]">{t('bciRunLiveStatusHeader')}</p><Badge tone={job ? scanStatusTone(job.status) : 'muted'}>{job?.status || t('bciReadyStatus')}</Badge></div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <div><span className="text-cyan-100/40 block">{t('bciRequestModeLabel')}</span>{resiliencePlan.totalRequests == null ? t('bciUnlimitedBadge') : resiliencePlan.totalRequests.toLocaleString(t('locale'))}</div>
                <div><span className="text-cyan-100/40 block">CONCURRENCY</span>{resiliencePlan.concurrency}</div>
                <div><span className="text-cyan-100/40 block">RPS</span>{resiliencePlan.targetRps}</div>
                <div><span className="text-cyan-100/40 block">LOAD SHAPE</span>{LOAD_SHAPE_KEYS[resiliencePlan.profile] ? t(LOAD_SHAPE_KEYS[resiliencePlan.profile][0]) : ''}</div>
              </div>
              {job && resilienceRounds.length === 0 && <p className="text-cyan-100/45 text-[11px]">{t('bciNoLiveMetricsNote')}</p>}
              {resilienceRounds.length > 0 && (() => {
                const round = resilienceRounds[resilienceRounds.length - 1]; const m = round.metrics || {};
                return <div className="space-y-2"><p className="text-[11px]"><Badge tone={round.status === 'STABLE' || round.status === 'RECOVERED' ? 'ok' : round.status === 'INCONCLUSIVE' ? 'muted' : 'warn'}>{round.status}</Badge> · {round.module} · {round.source}</p>{Object.keys(round.phases || {}).length > 0 && <p className="text-cyan-100/45 text-[10px]">{t('bciMeasuredPhasesLabel')} {Object.keys(round.phases).map((phase) => phase.toUpperCase()).join(' → ')}</p>}<div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                  {[[t('bciRequestLabel'), `${m.attempted ?? '—'} / ${round.executedPlan?.totalRequests ?? '∞'}`], ['Actual RPS', m.actualRps], ['Throughput', m.throughput], ['Completed', m.completed], ['Errors', m.failed], ['Timeouts', m.timedOut], ['p50', m.p50LatencyMs], ['p95', m.p95LatencyMs], ['p99', m.p99LatencyMs]].map(([label, value]) => <div key={label}><span className="text-cyan-100/40 block">{label}</span>{typeof value === 'number' ? Number(value.toFixed?.(2) ?? value) : value ?? '—'}</div>)}
                </div></div>;
              })()}
            </div>}
            {fuzzSelected && <div className="border border-cyan-300/20 rounded-lg p-3 mb-4 space-y-2"><div className="flex justify-between"><p className="text-cyan-100 text-[13px]">{t('bciFuzzRunHeader')}</p><Badge tone={job ? scanStatusTone(job.status) : 'muted'}>{job?.status || t('bciReadyStatus')}</Badge></div>{job && fuzzExecutions.length === 0 && <p className="text-cyan-100/45 text-[11px]">{t('bciNoLiveProbeNote')}</p>}{fuzzExecutions.length > 0 && (() => { const execution = fuzzExecutions[fuzzExecutions.length - 1]; const probes = execution.probes || []; const failureSummary = execution.discoveryMeta?.failureSummary; return <><div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]"><div>{probes.filter((p) => p.type === 'HTTP_FUZZ_PROBE').length}<span className="block text-cyan-100/40">{t('bciTotalProbesLabel')}</span></div><div>{probes.filter((p) => p.source === 'BASE').length}<span className="block text-cyan-100/40">BASE</span></div><div>{probes.filter((p) => p.source === 'USER').length}<span className="block text-cyan-100/40">USER</span></div><div>{probes.filter((p) => p.source === 'AI_ADAPTIVE').length}<span className="block text-cyan-100/40">AI_ADAPTIVE</span></div></div>{failureSummary?.total > 0 && <p className="text-red-300/80 text-[11px] break-words">{t('bciDetailColumnLabel')}: {Object.entries(failureSummary.counts || {}).map(([code, count]) => `${code}: ${count}`).join(' · ')}</p>}</>; })()}</div>}
            {intrusiveSelected && <div className="border border-red-300/20 rounded-lg p-3 mb-4 space-y-2"><div className="flex justify-between"><p className="text-cyan-100 text-[13px]">{t('bciIntrusiveRunHeader')}</p><Badge tone={job ? scanStatusTone(job.status) : 'muted'}>{job?.status || t('bciReadyStatus')}</Badge></div>{job && intrusiveExecutions.length === 0 && <p className="text-cyan-100/45 text-[11px]">{t('bciNoLiveModuleProgressNote')}</p>}{intrusiveExecutions.length > 0 && (() => { const records = intrusiveExecutions.flatMap((execution) => execution.records || []); return <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]"><div>{records.length}<span className="block text-cyan-100/40">{t('bciCompletedValidationsLabel')}</span></div>{['VERIFIED', 'UNVERIFIED', 'ERROR', 'NOT_APPLICABLE'].map((status) => <div key={status}>{records.filter((record) => record.verificationStatus === status).length}<span className="block text-cyan-100/40">{status}</span></div>)}</div>; })()}</div>}

            {!job ? (
              <>
                <p className="text-cyan-100/70 text-[13px] mb-3">{t('cyberWizReadyToStart')}</p>
                <button className={btnPrimaryCls} disabled={starting} onClick={startAnalysis}>{starting ? t('cyberRunning') : intrusiveSelected ? t('bciStartVerificationBtn') : t('cyberWizStartAnalysis')}</button>
              </>
            ) : (
              <>
                <p className="text-cyan-100/70 text-[13px] mb-2">
                  {t('cyberColStatus')}: <Badge tone={isPartialEngineCoverage(job.status, engineRuns) ? 'warn' : scanStatusTone(job.status)}>{job.status === 'NO_COVERAGE' ? t('cyberScanNoCoverage') : isPartialEngineCoverage(job.status, engineRuns) ? t('cyberWizOutcomePartial') : job.status}</Badge>
                </p>
                {job.error && <p className="text-red-300 text-[11px] mb-2 break-words">{t('bciErrorPrefixLabel')} {job.error}</p>}
                {!TERMINAL_SCAN_STATUSES.includes(job.status) && (
                  <button
                    className={`${btnCls} mb-3 border-red-400/40 text-red-300`}
                    onClick={async () => {
                      try {
                        const { job: cancelled } = await cyberAnalysisApi.cancelScan(job.id);
                        setJob((current) => ({ ...current, ...cancelled }));
                      } catch (err) { setError(err.message); }
                    }}
                  >{t('bciStopBtn')}</button>
                )}
                {job.status === 'NO_COVERAGE' && <p className="text-gold/70 text-[11px] mb-2">{t('cyberScanNoCoverageDetail')}</p>}
                <div className={tableWrap}>
                  <table className="w-full">
                    <thead><tr><th className={th}>{t('cyberColEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('bciDetailColumnLabel')}</th></tr></thead>
                    <tbody>
                      {engineRuns.map((r) => (
                        <tr key={r.engine_id}>
                          <td className={td}>{r.engine_id}</td>
                          <td className={td}><Badge tone={r.status === 'COMPLETED' ? 'ok' : r.status === 'SKIPPED' ? 'warn' : 'danger'}>{r.status}</Badge></td>
                          <td className={`${td} max-w-md break-words text-cyan-100/55`}>{r.detail || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {TERMINAL_SCAN_STATUSES.includes(job.status) && (job.status === 'COMPLETED' || job.status === 'NO_COVERAGE') && (
                  <div className="border-t border-cyan-300/10 mt-3 pt-3">
                    <p className="text-cyan-100/40 text-[11px] uppercase mb-2">{t('cyberWizFindingSummary')}</p>
                    {resultFindings === null ? (
                      <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        <Badge tone="muted">{t('cyberFindingCount')}: {resultFindings.length}</Badge>
                        {Object.entries(resultFindings.reduce((acc, f) => {
                          const k = HIGH_PRIORITY_LEVELS.includes(f.priority) ? f.priority : (f.priority || 'UNSCORED');
                          acc[k] = (acc[k] || 0) + 1;
                          return acc;
                        }, {})).map(([p, c]) => <Badge key={p} tone={HIGH_PRIORITY_LEVELS.includes(p) ? 'danger' : 'muted'}>{p}: {c}</Badge>)}
                      </div>
                    )}
                    <button className={btnPrimaryCls} onClick={() => setStep(4)}>{t('cyberWizGoToReport')}</button>
                  </div>
                )}
              </>
            )}
          </Panel>
        )}

        {step === 4 && job && (
          <Panel title={t('cyberWizStepResult')}>
            {(() => {
              const skippedOrFailed = engineRuns.filter((r) => r.status !== 'COMPLETED');
              const outcome = job.status === 'NO_COVERAGE' ? 'no_coverage'
                : skippedOrFailed.length > 0 && skippedOrFailed.length < engineRuns.length ? 'partial'
                : job.status === 'COMPLETED' ? 'success' : 'failed';
              return (
                <div className="space-y-3">
                  <p className="text-[13px]">
                    {outcome === 'success' && <Badge tone="ok">{t('cyberWizOutcomeSuccess')}</Badge>}
                    {outcome === 'partial' && <Badge tone="warn">{t('cyberWizOutcomePartial')}</Badge>}
                    {outcome === 'no_coverage' && <Badge tone="warn">{t('cyberScanNoCoverage')}</Badge>}
                    {outcome === 'failed' && <Badge tone="danger">{t('cyberWizOutcomeFailed')}</Badge>}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div className="hud-panel rounded-xl p-3 text-center">
                      <div className="text-2xl font-serif">{engineRuns.filter((r) => r.status === 'COMPLETED').reduce((s, r) => s + (r.observation_count || 0), 0)}</div>
                      <div className="text-cyan-100/50 text-[11px] uppercase">{t('cyberWizObservations')}</div>
                    </div>
                    <div className="hud-panel rounded-xl p-3 text-center">
                      <div className="text-2xl font-serif">{resultFindings?.length ?? '—'}</div>
                      <div className="text-cyan-100/50 text-[11px] uppercase">{t('cyberFindingCount')}</div>
                    </div>
                    <div className="hud-panel rounded-xl p-3 text-center">
                      <div className={`text-2xl font-serif ${scoreTone(resultFindings?.length ? Math.max(...resultFindings.map((f) => f.risk_score || 0)) : null)}`}>
                        {resultFindings?.length ? Math.max(...resultFindings.map((f) => f.risk_score || 0)) : '—'}
                      </div>
                      <div className="text-cyan-100/50 text-[11px] uppercase">{t('cyberRiskScoreLabel')}</div>
                    </div>
                  </div>
                  <div className="border border-cyan-300/20 rounded p-3 space-y-3">
                    <h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase">{t('bciExecutionProvenanceTitle')}</h3>
                    <div className="grid sm:grid-cols-3 gap-2 text-[12px]">
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizBciRecommended')} · MOTOR</span>{(job.result?.recommendedEngines || []).join(', ') || '—'}</div>
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizYouSelected')} · MOTOR</span>{(job.result?.selectedEngines || []).join(', ') || '—'}</div>
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizActuallyUsed')} · MOTOR</span>{(job.result?.enginesRun || []).join(', ') || '—'}</div>
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizBciRecommended')} · CAPABILITY</span>{(job.result?.recommendedCapabilities || []).join(', ') || '—'}</div>
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizYouSelected')} · CAPABILITY</span>{(job.result?.selectedCapabilities || []).join(', ') || '—'}</div>
                      <div><span className="text-cyan-100/40 block text-[10px] uppercase">{t('cyberWizActuallyUsed')} · CAPABILITY</span>{(job.result?.actualExecutedCapabilities || []).join(', ') || '—'}</div>
                    </div>
                    {engineRuns.length > 0 && (
                      <div className={tableWrap}>
                        <table className="w-full">
                          <thead><tr><th className={th}>{t('cyberColEngine')}</th><th className={th}>{t('cyberColStatus')}</th><th className={th}>{t('cyberWizObservations')}</th><th className={th}>{t('bciDetailColumnLabel')}</th></tr></thead>
                          <tbody>{engineRuns.map((run) => (
                            <tr key={run.engine_id}>
                              <td className={td}>{run.engine_id}</td>
                              <td className={td}><Badge tone={run.status === 'COMPLETED' ? 'ok' : run.status === 'SKIPPED' ? 'warn' : 'danger'}>{run.status}</Badge></td>
                              <td className={td}>{run.observation_count || 0}</td>
                              <td className={`${td} max-w-md break-words text-cyan-100/55`}>{run.detail || '—'}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  {intrusiveSelected && intrusiveExecutions.length > 0 && <div className="border border-red-300/20 rounded p-3 space-y-3">
                    <h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase">{t('bciIntrusiveRealResultsTitle')}</h3>
                    {intrusiveExecutions.flatMap((execution) => execution.records || []).map((record, index) => { const findingCreated = record.anomalous === true && record.verificationStatus === 'VERIFIED'; return <div key={`${record.module}-${record.source}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px] space-y-1"><p><Badge tone={record.verificationStatus === 'VERIFIED' ? 'ok' : record.verificationStatus === 'ERROR' ? 'danger' : record.verificationStatus === 'NOT_APPLICABLE' ? 'muted' : 'warn'}>{record.verificationStatus}</Badge> · {record.module} · {record.source}</p><p>{t('bciTargetLabel')} {record.endpoint || record.target} · {t('bciPriorFindingLabel')}: {record.relatedFindingId || '—'} · {t('bciAnomalyLabel')}: {record.anomalous ? t('bciYes') : t('bciNo')} · {t('bciFindingCreatedLabel')}: {findingCreated ? t('bciYes') : t('bciNo')}</p><p className="text-cyan-100/45">{t('bciObservedLabel')}: {record.observed ? JSON.stringify(record.observed) : '—'}</p><p className="text-cyan-100/35">{t('bciEvidenceLabel')}: {record.evidence ? JSON.stringify(record.evidence) : '—'}</p></div>; })}
                  </div>}
                  {intrusiveSelected && job.status === 'COMPLETED' && <div className="border border-emerald-400/20 rounded p-3 space-y-2"><h3 className="text-emerald-300 text-[11px] tracking-widest uppercase">{t('bciIntrusiveAdaptiveRecTitle')}</h3>{intrusiveAdviceLoading && <p>{t('cyberLoading')}</p>}{intrusiveAdvice && !intrusiveAdviceRejected && <><AiAdvisorAssessmentBlock assessment={intrusiveAdvice} t={t} />{editingIntrusiveAdaptivePlan && <div>{intrusiveAdvice.adaptivePlan.map((entry) => <label key={entry.moduleId} className="block text-[11px]"><input type="checkbox" className="mr-2" checked={intrusiveAdaptivePlanDraft.some((draft) => draft.moduleId === entry.moduleId)} onChange={() => setIntrusiveAdaptivePlanDraft((draft) => draft.some((item) => item.moduleId === entry.moduleId) ? draft.filter((item) => item.moduleId !== entry.moduleId) : [...draft, entry])} />{entry.moduleId} · {entry.rationale}</label>)}</div>}<div className="flex flex-wrap gap-2"><button className={btnPrimaryCls} disabled={starting || intrusiveAdaptivePlanDraft.length === 0} onClick={startAdaptiveIntrusiveAnalysis}>{t('bciApplyRecommendation')}</button><button className={btnCls} onClick={() => setIntrusiveAdviceRejected(true)}>{t('bciReject')}</button><button className={btnCls} onClick={() => setEditingIntrusiveAdaptivePlan((value) => !value)}>{t('bciEdit')}</button></div><p className="text-cyan-100/35 text-[10px]">{t('bciBaseUserUnchangedNote')}</p></>}{intrusiveAdviceRejected && <p className="text-cyan-100/45 text-[11px]">{t('bciIntrusiveRecRejectedNote')}</p>}</div>}
                  {resilienceSelected && resilienceRounds.length > 0 && <div className="border border-cyan-300/20 rounded p-3 space-y-3">
                    <h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase">{t('bciResilienceResultsTitle')}</h3>
                    {resilienceRounds.map((round, index) => { const m = round.metrics || {}; return <div key={`${round.module}-${round.source}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px] space-y-1">
                      <p><Badge tone={['STABLE', 'RECOVERED'].includes(round.status) ? 'ok' : round.status === 'INCONCLUSIVE' ? 'muted' : 'warn'}>{round.status}</Badge> · {round.module} · {round.source}</p>
                      <p className="text-cyan-100/55">{RESILIENCE_STATUS_KEYS[round.status] ? t(RESILIENCE_STATUS_KEYS[round.status]) : t('bciResStatusFallback')}</p>
                      <p>{t('bciRequestedLabel')}: {round.requestedPlan?.totalRequests ?? 'UNLIMITED'} / {t('bciExecutedLabel')}: {round.executedPlan?.totalRequests ?? 'UNLIMITED'} · {t('bciAttemptedLabel')}: {m.attempted ?? '—'} · {t('bciCompletedLabel')}: {m.completed ?? '—'} · {t('bciErrorLabel')}: {m.failed ?? '—'} · {t('bciTimeoutLabel')}: {m.timedOut ?? '—'} · {t('bciConnectionLabel')}: {m.connectionErrors ?? '—'}</p>
                      <p>RPS: {m.actualRps?.toFixed?.(2) ?? '—'} · {t('bciThroughputLabel')}: {m.throughput?.toFixed?.(2) ?? '—'} · p50/p90/p95/p99: {[m.p50LatencyMs, m.p90LatencyMs, m.p95LatencyMs, m.p99LatencyMs].map((v) => v ?? '—').join(' / ')}</p>
                      <p>{t('bciMinMaxAvgLabel')}: {[m.minLatencyMs, m.maxLatencyMs, m.avgLatencyMs].map((v) => v ?? '—').join(' / ')} · {t('bciErrorRateLabel')}: {m.errorRate == null ? '—' : `${(m.errorRate * 100).toFixed(2)}%`} · {t('bciTimeoutRateLabel')}: {m.timeoutRate == null ? '—' : `${(m.timeoutRate * 100).toFixed(2)}%`} · {t('bciRateLimitsLabel')}: {m.rateLimitedCount ?? '—'}</p>
                      <p>HTTP: {m.statusDistribution ? JSON.stringify(m.statusDistribution) : '—'}{round.runtimeLimitations?.length ? ` · ${t('bciRuntimeLabel')}: ${round.runtimeLimitations.map((item) => item.detail || item).join('; ')}` : ''}</p>
                    </div>; })}
                  </div>}

                  {fuzzSelected && fuzzExecutions.length > 0 && <div className="border border-cyan-300/20 rounded p-3 space-y-3"><h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase">{t('bciFuzzRealResultsTitle')}</h3>{fuzzExecutions.flatMap((execution) => execution.probes || []).map((probe, index) => <div key={`${probe.type}-${probe.endpoint}-${probe.parameter || index}-${index}`} className="border border-cyan-300/10 rounded p-2 text-[11px]">{probe.type === 'HTTP_FUZZ_DISCOVERED_NOT_EXECUTED' ? <><p><Badge tone="muted">HTTP_FUZZ_DISCOVERED_NOT_EXECUTED</Badge> · {probe.method} {probe.endpoint}</p><p className="text-cyan-100/45">{probe.reason}</p></> : <><p><Badge tone={probe.anomalous ? 'warn' : 'ok'}>{probe.source}</Badge> · {probe.method} {probe.endpoint} · {probe.parameter} · {probe.category}</p><div className="grid sm:grid-cols-3 gap-2 mt-1"><p>{t('bciBaselineLabel')}<br />HTTP {probe.baselineStatus ?? '—'} · {probe.baselineSizeBytes ?? '—'} B · {probe.baselineTimeMs ?? '—'} ms</p><p>{t('bciFuzzProbeLabel')}<br />HTTP {probe.status ?? '—'} · {probe.sizeBytes ?? '—'} B · {probe.timeMs ?? '—'} ms</p><p>{t('bciChangeLabel')}<br />{t('cyberColStatus')}: {probe.baselineStatus != null && probe.status !== probe.baselineStatus ? t('bciChanged') : t('bciSameUnknown')} · {t('bciSizeLabel')}: {probe.baselineSizeBytes ? `${(((probe.sizeBytes - probe.baselineSizeBytes) / probe.baselineSizeBytes) * 100).toFixed(1)}%` : '—'} · {t('bciLatencyLabel')}: {probe.baselineTimeMs != null && probe.timeMs != null ? `${probe.timeMs - probe.baselineTimeMs} ms` : '—'} · {t('bciReflectionLabel')}: {probe.reflected ? t('bciYes') : t('bciNo')}</p></div>{probe.error && <p className="text-red-300">{probe.error}</p>}</>}</div>)}</div>}

                  {fuzzSelected && job.status === 'COMPLETED' && <div className="border border-emerald-400/20 rounded p-3 space-y-2"><h3 className="text-emerald-300 text-[11px] tracking-widest uppercase">{t('bciFuzzAdaptiveRecTitle')}</h3>{fuzzAdviceLoading && <p>{t('cyberLoading')}</p>}{fuzzAdvice && !fuzzAdviceRejected && <><AiAdvisorAssessmentBlock assessment={fuzzAdvice} t={t} />{editingFuzzAdaptivePlan && <div>{fuzzAdvice.adaptivePlan.map((entry) => <label key={`${entry.url}-${entry.parameter}-${entry.categoryId}`} className="block text-[11px]"><input type="checkbox" className="mr-2" checked={fuzzAdaptivePlanDraft.some((draft) => draft.url === entry.url && draft.parameter === entry.parameter && draft.categoryId === entry.categoryId)} onChange={() => setFuzzAdaptivePlanDraft((draft) => draft.some((item) => item.url === entry.url && item.parameter === entry.parameter && item.categoryId === entry.categoryId) ? draft.filter((item) => !(item.url === entry.url && item.parameter === entry.parameter && item.categoryId === entry.categoryId)) : [...draft, entry])} />{entry.url} · {entry.parameter} · {entry.categoryId}</label>)}</div>}<div className="flex flex-wrap gap-2"><button className={btnPrimaryCls} disabled={starting || fuzzAdaptivePlanDraft.length === 0} onClick={startAdaptiveFuzzAnalysis}>{t('bciApplyRecommendation')}</button><button className={btnCls} onClick={() => setFuzzAdviceRejected(true)}>{t('bciReject')}</button><button className={btnCls} onClick={() => setEditingFuzzAdaptivePlan((value) => !value)}>{t('bciEdit')}</button></div><p className="text-cyan-100/35 text-[10px]">{t('bciFuzzBaseUnchangedNote')}</p></>}{fuzzAdviceRejected && <p className="text-cyan-100/45 text-[11px]">{t('bciFuzzRecRejectedNote')}</p>}</div>}

                  {resilienceSelected && job.status === 'COMPLETED' && <div className="border border-emerald-400/20 rounded p-3 space-y-2">
                    <h3 className="text-emerald-300 text-[11px] tracking-widest uppercase">{t('bciResilienceAdaptiveRecTitle')}</h3>
                    {resilienceAdviceLoading && <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>}
                    {resilienceAdvice && !resilienceAdviceRejected && <>
                      <AiAdvisorAssessmentBlock assessment={resilienceAdvice} t={t} />
                      {editingAdaptivePlan && <div className="space-y-1">{resilienceAdvice.adaptivePlan.map((entry) => <label key={entry.moduleId} className="block text-[11px]"><input type="checkbox" className="mr-2" checked={adaptivePlanDraft.some((draft) => draft.moduleId === entry.moduleId)} onChange={() => setAdaptivePlanDraft((draft) => draft.some((item) => item.moduleId === entry.moduleId) ? draft.filter((item) => item.moduleId !== entry.moduleId) : [...draft, entry])} />{entry.moduleId} · {entry.rationale}</label>)}</div>}
                      <div className="flex flex-wrap gap-2"><button className={btnPrimaryCls} disabled={starting || adaptivePlanDraft.length === 0} onClick={startAdaptiveResilienceAnalysis}>{t('bciApplyRecommendation')}</button><button className={btnCls} onClick={() => setResilienceAdviceRejected(true)}>{t('bciReject')}</button><button className={btnCls} onClick={() => setEditingAdaptivePlan((value) => !value)}>{t('bciChangeSettings')}</button></div>
                      <p className="text-cyan-100/35 text-[10px]">{t('bciNewRoundConsentNote')}</p>
                    </>}
                    {resilienceAdviceRejected && <p className="text-cyan-100/45 text-[11px]">{t('bciResilienceRecRejectedNote')}</p>}
                  </div>}
                  {resultFindings?.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(resultFindings.reduce((acc, f) => {
                        const k = HIGH_PRIORITY_LEVELS.includes(f.priority) ? f.priority : (f.priority || 'UNSCORED');
                        acc[k] = (acc[k] || 0) + 1;
                        return acc;
                      }, {})).map(([p, c]) => <Badge key={p} tone={HIGH_PRIORITY_LEVELS.includes(p) ? 'danger' : 'muted'}>{p}: {c}</Badge>)}
                    </div>
                  )}

                  <div className="border border-cyan-300/20 rounded p-3">
                    <h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase mb-3">{t('bciAiAssessmentTitle')}</h3>
                    {aiAssessing && <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>}
                    {aiAssessment?.report ? <div className="space-y-4 text-[13px] text-cyan-100/70">
                      <section>
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportExecutiveSummary')}</h4>
                        {aiAssessment.report.verdict && (
                          <p className="mb-2"><Badge tone={advisorVerdictTone(aiAssessment.report.verdict)}>{t(ADVISOR_VERDICT_KEYS[aiAssessment.report.verdict] || aiAssessment.report.verdict)}</Badge></p>
                        )}
                        <p>{aiAssessment.report.executiveSummary}</p>
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3">
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportCoverage')}</h4>
                        <p>{aiAssessment.report.coverage.narrative}</p>
                        <div className="grid sm:grid-cols-2 gap-2 mt-2 text-[11px]">
                          <p><span className="text-cyan-100/40">{t('bciReportTarget')}</span><br />{aiAssessment.report.coverage.target} · {aiAssessment.report.coverage.targetType || '—'} · {aiAssessment.report.coverage.requestedClass || '—'}</p>
                          <p><span className="text-cyan-100/40">{t('bciReportCapability')}</span><br />{aiAssessment.report.coverage.actualExecutedCapabilities?.join(', ') || '—'}</p>
                          <p><span className="text-cyan-100/40">{t('bciReportEngine')}</span><br />{aiAssessment.report.coverage.actualExecutedEngines?.join(', ') || '—'}</p>
                          <p><span className="text-cyan-100/40">{t('bciReportScanJob')}</span><br />{job.id}</p>
                        </div>
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3 space-y-2">
                        <h4 className="text-gold/80 text-[11px] tracking-widest">{t('bciReportFindings')}</h4>
                        {aiAssessment.report.findings.length === 0 && <p>{t('bciReportNoFindings')}</p>}
                        {aiAssessment.report.findings.map((finding, index) => <article key={finding.id} className="border border-cyan-300/15 rounded p-3 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <strong className="text-cyan-50">{index + 1}. {finding.title}</strong>
                            <Badge tone={HIGH_PRIORITY_LEVELS.includes(finding.priority) ? 'danger' : 'muted'}>{finding.priority || 'UNSCORED'}</Badge>
                            <span className="text-cyan-100/45">Risk: {finding.riskScore ?? '—'} · {finding.verificationStatus || 'UNKNOWN'}</span>
                          </div>
                          <p><span className="text-cyan-100/40">{t('bciReportPossibleImpact')}:</span> {finding.interpretation?.possibleImpact}</p>
                          <p><span className="text-cyan-100/40">{t('bciReportRecommendedAction')}:</span> {finding.interpretation?.recommendedAction}</p>
                          <p><span className="text-cyan-100/40">{t('bciReportUrgency')}:</span> {t(REPORT_URGENCY_KEYS[finding.interpretation?.urgency] || finding.interpretation?.urgency)}</p>
                          <details className="text-[11px]">
                            <summary className="cursor-pointer text-cyan-200/60">{t('bciReportEvidence')}</summary>
                            <div className="mt-2 space-y-2">
                              <p>ID: {finding.id} · Location: {finding.location || '—'} · CVE: {finding.cveIds?.join(', ') || '—'} · CWE: {finding.cweIds?.join(', ') || '—'}</p>
                              {finding.sources?.map((source, sourceIndex) => <div key={`${finding.id}-${source.engineId}-${sourceIndex}`} className="border-l border-cyan-300/20 pl-2">
                                <p>{source.engineId || '—'} · {source.capabilityId || '—'} · {source.observationTitle || '—'} · {source.engineSeverity || '—'}</p>
                                <p className="text-cyan-100/40 break-words">{source.evidence ? JSON.stringify(source.evidence) : '—'}</p>
                              </div>)}
                            </div>
                          </details>
                        </article>)}
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3">
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportRiskSynthesis')}</h4>
                        <p>{aiAssessment.report.riskSynthesis.overallAssessment}</p>
                        <p className="mt-1">{aiAssessment.report.riskSynthesis.possibleCombinedImpact}</p>
                        <p className="mt-1 text-cyan-100/45">{aiAssessment.report.riskSynthesis.uncertainty}</p>
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3">
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportActionPlan')}</h4>
                        <ol className="space-y-2">
                          {aiAssessment.report.actionPlan.map((action) => <li key={`${action.order}-${action.action}`}>
                            <strong>{action.order}. {action.action}</strong>
                            <p className="text-cyan-100/50">{action.rationale} · {t(REPORT_URGENCY_KEYS[action.urgency] || action.urgency)} · {t('bciReportUserApproval')}</p>
                          </li>)}
                        </ol>
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3">
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportLimitations')}</h4>
                        <ul className="list-disc pl-5 space-y-1">{aiAssessment.report.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                      </section>

                      <section className="border-t border-cyan-300/10 pt-3">
                        <h4 className="text-gold/80 text-[11px] tracking-widest mb-1">{t('bciReportConclusion')}</h4>
                        <p>{aiAssessment.report.conclusion}</p>
                      </section>

                      <p className="text-cyan-100/35 text-[10px]">{aiAssessment.source}{aiAssessment.provider ? ` · ${aiAssessment.provider}` : ''}</p>
                    </div> : aiAssessment && <p className="text-cyan-100/70 text-[13px] whitespace-pre-wrap">
                      {aiAssessment.text}{' '}
                      <em className="text-cyan-100/40">({aiAssessment.source}{aiAssessment.provider ? ` · ${aiAssessment.provider}` : ''})</em>
                    </p>}
                  </div>

                  {job.status === 'COMPLETED' && (
                    <div className="border-t border-cyan-300/10 pt-3">
                      <h3 className="text-cyan-100/60 text-[11px] tracking-widest uppercase mb-2">{t('cyberWizProvenanceTitle')}</h3>
                      {optimizing && <p className="text-cyan-100/50 text-sm">{t('cyberLoading')}</p>}
                      {optimizationError && <p className="text-gold/70 text-[11px] break-words">{t('bciRecommendationUnavailableNote')} ({optimizationError})</p>}
                      {optimization && (
                        <div className="space-y-2 text-[13px]">
                          <div className="grid grid-cols-3 gap-2">
                            <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberWizBciRecommended')}</span>{optimization.recommendedMode || '—'}</div>
                            <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberWizYouSelected')}</span>{optimization.selectedMode || '—'}</div>
                            <div><span className="text-cyan-100/40 block text-[11px] uppercase">{t('cyberWizActuallyUsed')}</span>{optimization.actualMode || '—'}</div>
                          </div>
                          {optimization.fallbackReason && (
                            <p className="text-gold text-[12px]">{t('cyberWizFallbackOccurred')}: {optimization.fallbackReason}</p>
                          )}
                          <p>
                            {t('cyberWizOptimizationVerdict')}: {optimization.verdict === 'NOT_APPLICABLE'
                              ? <Badge tone="muted">{t('cyberWizNotApplicable')}</Badge>
                              : <Badge tone={optimization.verdict === 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' ? 'ok' : 'muted'}>{optimization.verdict}</Badge>}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 pt-2 border-t border-cyan-300/10">
                    <button className={btnPrimaryCls} onClick={onGoToFindings}>{t('cyberNavFindings')}</button>
                    <button className={btnCls} onClick={onClose}>{t('cyberClose')}</button>
                  </div>
                </div>
              );
            })()}
          </Panel>
        )}

        {step < 4 && (
          <div className="flex justify-between">
            <button className={btnCls} disabled={!canGoBack} onClick={() => setStep((s) => s - 1)}>{t('cyberPrevTab')}</button>
            {step < 3 && (
              <button
                className={btnPrimaryCls}
                disabled={(step === 0 && !canProceedFromAsset) || (step === 1 && !canProceedFromEngines) || (step === 2 && !canProceedFromQuantum)}
                onClick={() => setStep((s) => s + 1)}
              >
                {t('cyberNextTab')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
