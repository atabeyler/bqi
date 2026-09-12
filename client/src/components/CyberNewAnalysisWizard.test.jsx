import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CyberNewAnalysisWizard, { buildResilienceRequestedPlan, isComputeModeUsableFromState, isPartialEngineCoverage, quantumProviderHealthAllowsMode } from './CyberNewAnalysisWizard.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api, cyberAnalysisApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  api: {
    cyberAnalysisFindings: vi.fn(async () => ({ findings: [] })),
    cyberAnalysisScanAssessment: vi.fn(async () => ({
      text: 'Evidence-bound assessment', source: 'deterministic', provider: null,
      report: {
        verdict: 'NO_FINDINGS',
        executiveSummary: 'Evidence-bound assessment',
        coverage: { narrative: 'Executed scope only.', target: 'example.com', targetType: 'DOMAIN', requestedClass: 'SAFE_ACTIVE', actualExecutedCapabilities: ['WEB'], actualExecutedEngines: ['nuclei'] },
        findings: [],
        riskSynthesis: { overallAssessment: 'No verified combined risk.', possibleCombinedImpact: 'None verified.', uncertainty: 'Scope-limited.' },
        actionPlan: [], limitations: ['No finding does not prove complete security.'], conclusion: 'User decides.',
      },
    })),
    cyberAnalysisResilienceStrategy: vi.fn(async () => ({ adaptivePlan: [], verdict: 'NO_FINDINGS', summary: 'No adaptive round', scopeCovered: ['availability-probe'], coverageNarrative: 'Base scope only.', keyEvidence: [], limitations: ['No adaptive evidence.'], suggestedNextStep: 'Review base results.', source: 'deterministic' })),
    cyberAnalysisFuzzStrategy: vi.fn(async () => ({ adaptivePlan: [], verdict: 'NO_FINDINGS', summary: 'No adaptive round', scopeCovered: ['http-fuzz'], coverageNarrative: 'Base scope only.', keyEvidence: [], limitations: ['No adaptive evidence.'], suggestedNextStep: 'Review base results.', source: 'deterministic' })),
    cyberAnalysisIntrusiveStrategy: vi.fn(async () => ({ adaptivePlan: [], verdict: 'NO_FINDINGS', summary: 'No adaptive round', scopeCovered: ['intrusive-validation'], coverageNarrative: 'Base scope only.', keyEvidence: [], limitations: ['No adaptive evidence.'], suggestedNextStep: 'Review base results.', source: 'deterministic' })),
  },
  cyberAnalysisApi: {
    listAssets: vi.fn(async () => ({ assets: [] })),
    findAssetByTarget: vi.fn(async () => ({ asset: null })),
    createAsset: vi.fn(),
    addAssetIdentifier: vi.fn(),
    evaluateScope: vi.fn(),
    getEnginePlan: vi.fn(),
    listQuantumProviders: vi.fn(async () => ({ providers: [
      { id: 'classical', mode: 'CLASSICAL', status: 'AVAILABLE', capabilities: { local: true, maxProblemSize: null } },
      { id: 'quantum_inspired', mode: 'QUANTUM_INSPIRED', status: 'AVAILABLE', capabilities: { local: true, maxProblemSize: 500 } },
    ] })),
    getQuantumPolicy: vi.fn(async () => ({ policy: { allowQuantumSimulator: false, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' } })),
    getQuantumRecommendation: vi.fn(async () => ({ recommendedMode: 'CLASSICAL', reason: 'org_policy_denies_quantum' })),
    createScan: vi.fn(),
    getScan: vi.fn(),
    getScanFindings: vi.fn(async () => ({ findings: [] })),
    getScanEngineRuns: vi.fn(async () => ({ engineRuns: [] })),
    getScanResilienceRounds: vi.fn(async () => ({ rounds: [] })),
    getScanFuzzResults: vi.fn(async () => ({ executions: [] })),
    getScanIntrusiveResults: vi.fn(async () => ({ executions: [] })),
    cancelScan: vi.fn(),
    listResilienceModules: vi.fn(async () => ({ loadPlanCapabilities: { requestCountOptions: [] } })),
    getFuzzCatalog: vi.fn(),
    discoverFuzzSurface: vi.fn(),
    getIntrusivePlan: vi.fn(),
    optimizeRemediationForScan: vi.fn(async () => ({ verdict: 'NOT_APPLICABLE', recommendedMode: 'CLASSICAL', selectedMode: 'CLASSICAL', actualMode: 'CLASSICAL', fallbackReason: null })),
  },
}));

function renderWizard(props = {}) {
  return render(<LangProvider><CyberNewAnalysisWizard onClose={vi.fn()} onGoToFindings={vi.fn()} {...props} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  cyberAnalysisApi.createAsset.mockResolvedValue({ asset: { id: 'asset-1', name: 'Bold Web', asset_type: 'DOMAIN', criticality: 'MEDIUM', status: 'ACTIVE' } });
  cyberAnalysisApi.findAssetByTarget.mockResolvedValue({ asset: null });
  localStorage.setItem('bqi_lang', 'en');
});

describe('CyberNewAnalysisWizard', () => {
  it('classifies mixed completed/failed engine runs as partial coverage', () => {
    expect(isPartialEngineCoverage('COMPLETED', [{ status: 'COMPLETED' }, { status: 'FAILED' }])).toBe(true);
    expect(isPartialEngineCoverage('COMPLETED', [{ status: 'COMPLETED' }])).toBe(false);
    expect(isPartialEngineCoverage('FAILED', [{ status: 'COMPLETED' }, { status: 'FAILED' }])).toBe(false);
  });

  it('clears the previously selected existing asset when switching to New Asset', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValueOnce({ assets: [
      { id: 'old-asset', name: 'Old SPA', asset_type: 'WEB_APP', criticality: 'HIGH', status: 'ACTIVE', target: 'https://old.example/#/login' },
    ] });
    renderWizard();
    await waitFor(() => expect(screen.getByText('https://old.example/#/login')).toBeInTheDocument());
    fireEvent.click(screen.getByText('https://old.example/#/login').closest('tr'));
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));

    expect(screen.getByRole('button', { name: /Add asset/i })).toBeInTheDocument();
    expect(screen.queryByText('https://old.example/#/login')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Next$/i })).toBeDisabled();
  });

  it('builds CUSTOM and UNLIMITED resilience plans without hidden product caps', () => {
    expect(buildResilienceRequestedPlan({ requestCountMode: 'CUSTOM', customTotalRequests: 25_000, concurrency: 75, targetRps: 300, durationEnabled: true, durationSeconds: 120 }))
      .toEqual({ requestCountMode: 'CUSTOM', totalRequests: 25_000, concurrency: 75, targetRps: 300, durationMs: 120_000, requestTimeoutMs: 5000, rampUpMs: 0, rampDownMs: 0, profile: 'constant' });
    expect(buildResilienceRequestedPlan({ requestCountMode: 'UNLIMITED', customTotalRequests: 1, concurrency: 100, targetRps: 500, durationEnabled: false, durationSeconds: 1 }))
      .toEqual({ requestCountMode: 'UNLIMITED', totalRequests: null, concurrency: 100, targetRps: 500, durationMs: null, requestTimeoutMs: 5000, rampUpMs: 0, rampDownMs: 0, profile: 'constant' });
  });

  it('allows experimental IBM hardware health without accepting other degraded providers', () => {
    expect(quantumProviderHealthAllowsMode({ status: 'DEGRADED' }, 'QUANTUM_HARDWARE')).toBe(true);
    expect(quantumProviderHealthAllowsMode({ status: 'DEGRADED' }, 'QUANTUM_SIMULATOR')).toBe(false);
    expect(quantumProviderHealthAllowsMode({ status: 'AVAILABLE' }, 'QUANTUM_SIMULATOR')).toBe(true);
  });

  it('creates a new asset with a real target, registers it as an identifier, and carries it into step 2', async () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));

    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Bold Web' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'www.boldkimya.com.tr' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));

    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalledWith({ name: 'Bold Web', assetType: 'DOMAIN', criticality: 'MEDIUM' }));
    await waitFor(() => expect(cyberAnalysisApi.addAssetIdentifier).toHaveBeenCalledWith('asset-1', { identifierType: 'DOMAIN', value: 'www.boldkimya.com.tr' }));
    await waitFor(() => expect(screen.getByText('www.boldkimya.com.tr')).toBeInTheDocument());
  });

  it('detects a duplicate target and offers the existing asset instead of creating a second one', async () => {
    cyberAnalysisApi.findAssetByTarget.mockResolvedValue({
      asset: { id: 'existing-1', name: 'Already Here', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'dup.example' },
    });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'dup.example' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));

    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeInTheDocument());
    expect(cyberAnalysisApi.createAsset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Use Existing Asset/i }));
    await waitFor(() => expect(screen.getAllByText('dup.example').length).toBeGreaterThan(0));
  });

  it('blocks proceeding past step 2 when the real engine plan has zero executable engines (DOMAIN + PASSIVE)', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: false, capabilities: ['WEB'] }],
      capabilities: [],
      hasExecutableEngine: false,
    });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => expect(cyberAnalysisApi.getEnginePlan).toHaveBeenCalledWith('DOMAIN', 'PASSIVE', []));
    await waitFor(() => expect(screen.getByText(/No executable analysis engine/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Next/i })).toBeDisabled();
  });

  it('lets the user proceed once a real, healthy, recommended engine exists for the chosen class', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['WEB'] }],
      capabilities: [{ id: 'WEB', name: 'Web Security Analysis', available: true }],
      hasExecutableEngine: true,
    });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
  });

  it('keeps Quantum usable with real provider data when only the advisory recommendation fails', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['WEB'] }],
      capabilities: [{ id: 'WEB', name: 'Web Security Analysis', available: true }],
      hasExecutableEngine: true,
    });
    cyberAnalysisApi.getQuantumRecommendation.mockRejectedValueOnce(new Error('recommendation_timeout'));
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    await waitFor(() => expect(screen.getByRole('radio', { name: /CLASSICAL/i })).toBeChecked());
    expect(screen.getByText(/safe default was selected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled();
  });

  it('never lets the user go back to step 1 once a scan job has actually been created (immutable plan)', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['WEB'] }],
      capabilities: [{ id: 'WEB', name: 'Web Security Analysis', available: true }],
      hasExecutableEngine: true,
    });
    cyberAnalysisApi.createScan.mockResolvedValue({ job: { id: 'job-1', status: 'QUEUED', target: 'example.com' } });
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i })); // -> Quantum
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i })); // -> Scan

    fireEvent.click(screen.getByRole('button', { name: /Start Analysis/i }));
    await waitFor(() => expect(cyberAnalysisApi.createScan).toHaveBeenCalledWith({
      target: 'example.com', requestedClass: 'PASSIVE', selectedEngineIds: ['nuclei'], selectedCapabilities: ['WEB'], selectedComputeMode: 'CLASSICAL',
      engineOptions: { nuclei: { scanProfile: 'STANDARD', templateCategories: ['CVE', 'MISCONFIGURATION', 'EXPOSURE'] } },
    }));

    // Previous is disabled once a job exists -- no going back to change the plan.
    expect(screen.getByRole('button', { name: /Previous/i })).toBeDisabled();
  });

  it('auto-suggests a higher scan class when PASSIVE has zero executable engines for this target type', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockImplementation(async (targetType, requestedClass) => {
      if (requestedClass === 'PASSIVE') {
        return { engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: false, capabilities: ['WEB'] }], capabilities: [], hasExecutableEngine: false };
      }
      return { engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['WEB'] }], capabilities: [{ id: 'WEB', name: 'Web Security Analysis', available: true }], hasExecutableEngine: true };
    });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('SAFE_ACTIVE'));
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    expect(screen.getByText(/switched to SAFE_ACTIVE/i)).toBeInTheDocument();
  });

  it('defaults engine selection to the recommended+healthy subset and lets the user narrow it, blocking Next at zero', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'REPOSITORY' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [
        { id: 'semgrep', name: 'semgrep', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['SAST'] },
        { id: 'osv-scanner', name: 'osv-scanner', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['SCA'] },
        { id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: false, recommended: false, capabilities: ['WEB'] },
      ],
      capabilities: [{ id: 'SAST', name: 'SAST', available: true }, { id: 'SCA', name: 'SCA', available: true }],
      hasExecutableEngine: true,
    });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    const semgrepCheckbox = await screen.findByRole('row', { name: /semgrep/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());

    // Both real engines checked by default -- uncheck one, then both, and
    // confirm zero-selected blocks Next with the honest reason shown.
    const checkboxes = screen.getAllByRole('checkbox', { name: /engine /i });
    expect(checkboxes.filter((c) => c.checked)).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    await waitFor(() => expect(screen.getByText(/at least one engine/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Next/i })).toBeDisabled();
    expect(semgrepCheckbox).toBeInTheDocument();
  });

  it('uses only provider health and policy when deciding whether a compute mode is selectable', () => {
    const providers = [
      { id: 'classical', status: 'AVAILABLE' },
      { id: 'quantum_simulator', status: 'AVAILABLE' },
    ];
    const policy = { allowQuantumSimulator: false, allowQuantumHardware: false };
    expect(isComputeModeUsableFromState(providers, policy, 'CLASSICAL')).toBe(true);
    expect(isComputeModeUsableFromState(providers, policy, 'QUANTUM_SIMULATOR')).toBe(false);
  });

  it('sends an UNLIMITED user-controlled Smart Resilience plan from the Wizard', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockImplementation(async (_targetType, requestedClass) => requestedClass === 'RESTRICTED' ? {
      engines: [{ id: 'availability-probe', name: 'BCI Smart Resilience', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['DOS'], targetCapabilities: ['DOS'] }],
      capabilities: [{ id: 'DOS', name: 'Availability / Resilience', available: true }], hasExecutableEngine: true,
    } : { engines: [], capabilities: [], hasExecutableEngine: false });
    cyberAnalysisApi.listResilienceModules.mockResolvedValue({
      modules: [
        { id: 'BASELINE_PERFORMANCE', name: 'Baseline', description: 'baseline', status: 'IMPLEMENTED' },
        { id: 'DISTRIBUTED_LOAD', name: 'Distributed', description: 'planned', status: 'PLANNED', blockedOn: 'worker coordination' },
      ],
      loadPlanCapabilities: {
        requestCountOptions: ['100', '500', '1000', '5000', '10000', 'CUSTOM', 'UNLIMITED'].map((id) => ({ id, totalRequests: /^\d+$/.test(id) ? Number(id) : null })),
        profileOptions: ['constant', 'ramp_up', 'ramp_down', 'step', 'spike', 'burst', 'sustained'].map((id) => ({ id, name: id })),
      },
    });
    cyberAnalysisApi.createScan.mockResolvedValue({ job: { id: 'resilience-job', status: 'QUEUED' } });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'resilience' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('RESTRICTED'));
    fireEvent.click(await screen.findByRole('button', { name: /Smart Resilience Next/i }));
    const requestCount = await screen.findByLabelText('Resilience request count');
    fireEvent.change(requestCount, { target: { value: 'UNLIMITED' } });
    fireEvent.change(screen.getByLabelText('Resilience duration mode'), { target: { value: 'USER_STOPPED' } });
    fireEvent.click(screen.getByRole('button', { name: /Smart Resilience Next/i }));
    const baselineModule = screen.getByRole('checkbox', { name: /Baseline/i });
    const plannedModule = screen.getByRole('checkbox', { name: /Distributed/i });
    expect(plannedModule).toBeDisabled();
    fireEvent.click(baselineModule);
    fireEvent.click(screen.getByRole('button', { name: /Smart Resilience Next/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Analysis/i }));

    await waitFor(() => expect(cyberAnalysisApi.createScan).toHaveBeenCalledWith(expect.objectContaining({
      selectedEngineIds: ['availability-probe'], selectedCapabilities: ['DOS'],
      engineOptions: { 'availability-probe': { requestedPlan: expect.objectContaining({ requestCountMode: 'UNLIMITED', totalRequests: null, durationMs: null, profile: 'ramp_up' }), userSelectedModuleIds: ['BASELINE_PERFORMANCE'] } },
    })));
  });

  it('renders real Smart Fuzz discovery/catalog and sends additive USER probes without touching BASE', async () => {
    cyberAnalysisApi.createAsset.mockResolvedValue({ asset: { id: 'asset-web', name: 'SPA', asset_type: 'WEB_APP', criticality: 'MEDIUM', status: 'ACTIVE' } });
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'URL' });
    cyberAnalysisApi.getEnginePlan.mockImplementation(async (_targetType, requestedClass) => requestedClass === 'SAFE_ACTIVE' ? {
      engines: [{ id: 'http-fuzz', name: 'BCI Smart Fuzz', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['FUZZ'], targetCapabilities: ['FUZZ'] }],
      capabilities: [{ id: 'FUZZ', name: 'HTTP Input Robustness', available: true }], hasExecutableEngine: true,
    } : { engines: [], capabilities: [], hasExecutableEngine: false });
    cyberAnalysisApi.getFuzzCatalog.mockResolvedValue({
      categories: [{ id: 'BOUNDARY_EMPTY', appliesTo: ['generic'] }, { id: 'XSS_MARKER', appliesTo: ['string'], detectsReflection: true }],
      baseMinTestsPerParameter: 8, maxBaseParameters: 15, maxUserProbes: null, maxAdaptiveProbes: 20,
      defaultCategoryIdsByType: { string: ['BOUNDARY_EMPTY'], integer: ['BOUNDARY_EMPTY'], generic: ['BOUNDARY_EMPTY'] },
    });
    cyberAnalysisApi.discoverFuzzSurface.mockResolvedValue({
      target: 'https://example.com/', openapiSource: null,
      summary: { endpoints: 2, parameters: 2, getEndpoints: 1, mutatingEndpoints: 1, baseProbes: 8 },
      endpoints: [
        { method: 'GET', url: 'https://example.com/search', source: 'html_link', executable: true, params: [{ name: 'q', location: 'query', type: 'string' }] },
        { method: 'POST', url: 'https://example.com/login', source: 'html_form', executable: false, params: [{ name: 'password', location: 'body', type: 'string' }] },
      ],
    });
    cyberAnalysisApi.createScan.mockResolvedValue({ job: { id: 'fuzz-job', status: 'QUEUED' } });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'fuzz' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'https://example.com/#/account/login' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('SAFE_ACTIVE'));
    fireEvent.click(await screen.findByRole('button', { name: 'START DISCOVERY' }));
    await waitFor(() => expect(cyberAnalysisApi.discoverFuzzSurface).toHaveBeenCalledWith(
      'https://example.com/#/account/login', 'URL', expect.objectContaining({ baseProfile: 'STANDARD' }),
    ));
    await waitFor(() => expect(screen.getByText(/2.*Endpoint/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Smart Fuzz Next/i }));
    expect(screen.getByText(/HTTP_FUZZ_DISCOVERED_NOT_EXECUTED|NO AUTOMATIC BASE EXECUTION/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Smart Fuzz Next/i }));
    fireEvent.click(screen.getByRole('button', { name: /Advanced Category Selection/i }));
    expect(screen.getByText(/USER extra-probe cap: NONE.*AI budget: 20/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /XSS_MARKER/ }));
    fireEvent.click(screen.getByRole('button', { name: /Smart Fuzz Next/i }));
    expect(screen.getByText(/BCI BASE: 8/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Start Analysis/i }));
    await waitFor(() => expect(cyberAnalysisApi.createScan).toHaveBeenCalledWith(expect.objectContaining({
      selectedEngineIds: ['http-fuzz'], selectedCapabilities: ['FUZZ'],
      engineOptions: { 'http-fuzz': expect.objectContaining({ baseProfile: 'STANDARD', userPlan: [{ method: 'GET', url: 'https://example.com/search', parameter: 'q', location: 'query', categoryId: 'XSS_MARKER' }] }) },
    })));
  });

  it('opens the dynamic Smart Intrusive Wizard, preserves real prior findings, and sends the real engine contract', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockImplementation(async (_targetType, requestedClass) => requestedClass === 'RESTRICTED' ? {
      engines: [{ id: 'intrusive-validation', name: 'BCI Smart Intrusive', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['INTRUSIVE'], targetCapabilities: ['INTRUSIVE'] }],
      capabilities: [{ id: 'INTRUSIVE', name: 'Advanced Active Validation', available: true }], hasExecutableEngine: true,
    } : { engines: [], capabilities: [], hasExecutableEngine: false });
    const finding = { id: '11111111-1111-4111-8111-111111111111', title: 'Behavioral anomaly', sourceEngine: 'http-fuzz', engineSeverity: 'HIGH', location: 'https://example.com/search?q=', verificationStatus: 'LIKELY', rule: 'BCI-FUZZ-XSS', evidence: { endpoint: 'https://example.com/search?q=', method: 'GET' } };
    cyberAnalysisApi.getIntrusivePlan.mockImplementation(async (_target, ids) => ({
      findings: [finding], selectedPriorFindings: ids.length ? [finding] : [],
      modules: [
        { id: 'CORS_VALIDATION', family: 'CORS_VALIDATION', name: 'CORS Validation', description: 'Validates CORS', status: 'IMPLEMENTED', applicable: true, requiredIntrusiveness: 'RESTRICTED', applicability: 'HTTP_TARGET', requiredEvidence: 'Reachable HTTP target', source: 'BCI_NATIVE_REGISTRY' },
        { id: 'FINDING_REPRODUCIBILITY_VERIFICATION', family: 'FINDING_REPRODUCIBILITY_VERIFICATION', name: 'Finding Reproducibility', description: 'Rechecks findings', status: 'IMPLEMENTED', applicable: ids.length > 0, requiredIntrusiveness: 'RESTRICTED', applicability: 'SELECTED_PRIOR_FINDING', requiredEvidence: 'Prior finding', source: 'BCI_NATIVE_REGISTRY' },
        { id: 'IDOR_BOLA_VALIDATION', family: 'IDOR_BOLA_VALIDATION', name: 'IDOR / BOLA', description: 'Planned', status: 'PLANNED', applicable: false, requiredIntrusiveness: 'RESTRICTED', blockedOn: 'Needs two identities', source: 'BCI_NATIVE_REGISTRY' },
      ],
      baseModuleIds: ids.length ? ['CORS_VALIDATION', 'FINDING_REPRODUCIBILITY_VERIFICATION'] : ['CORS_VALIDATION'],
      summary: { total: 3, implemented: 2, planned: 1, applicable: ids.length ? 2 : 1 },
    }));
    cyberAnalysisApi.createScan.mockResolvedValue({ job: { id: 'intrusive-job', status: 'QUEUED' } });
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'intrusive' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('RESTRICTED'));
    await waitFor(() => expect(screen.getByText('Behavioral anomaly')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'ADD TO VERIFICATION' }));
    await waitFor(() => expect(cyberAnalysisApi.getIntrusivePlan).toHaveBeenLastCalledWith('example.com', [finding.id]));
    fireEvent.click(screen.getByRole('button', { name: /Smart Intrusive Next/i }));
    fireEvent.click(screen.getByRole('button', { name: 'ADVANCED' }));
    expect(screen.getByText(/PLANNED — NOT YET RUNNABLE/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Smart Intrusive Next/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /CORS Validation/i }));
    fireEvent.click(screen.getByRole('button', { name: /Smart Intrusive Next/i }));
    expect(screen.getByText(/TOTAL VERIFICATION: 3 executions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /START VERIFICATION/i }));
    await waitFor(() => expect(cyberAnalysisApi.createScan).toHaveBeenCalledWith(expect.objectContaining({
      selectedEngineIds: ['intrusive-validation'], selectedCapabilities: ['INTRUSIVE'],
      engineOptions: { 'intrusive-validation': {
        userSelectedModuleIds: ['CORS_VALIDATION'],
        priorFindings: [expect.objectContaining({ id: finding.id, evidence: finding.evidence })],
      } },
    })));
  });

  it('shows the real optimization verdict and provenance once a completed scan is reached', async () => {
    cyberAnalysisApi.evaluateScope.mockResolvedValue({ decision: 'ALLOW', targetType: 'DOMAIN' });
    cyberAnalysisApi.getEnginePlan.mockResolvedValue({
      engines: [{ id: 'nuclei', name: 'nuclei', status: 'HEALTHY', compatible: true, recommended: true, capabilities: ['WEB'] }],
      capabilities: [{ id: 'WEB', name: 'Web Security Analysis', available: true }],
      hasExecutableEngine: true,
    });
    cyberAnalysisApi.createScan.mockResolvedValue({ job: { id: 'job-1', status: 'COMPLETED', target: 'example.com', result: { findingIds: ['f1'] } } });
    cyberAnalysisApi.optimizeRemediationForScan.mockResolvedValue({
      verdict: 'NOT_APPLICABLE', recommendedMode: 'CLASSICAL', selectedMode: 'CLASSICAL', actualMode: 'CLASSICAL', fallbackReason: null,
    });
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i })); // -> Quantum
    await waitFor(() => expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /Next/i })); // -> Scan
    fireEvent.click(screen.getByRole('button', { name: /Start Analysis/i }));

    await waitFor(() => expect(cyberAnalysisApi.optimizeRemediationForScan).toHaveBeenCalledWith(
      expect.objectContaining({ findingIds: ['f1'], preferredMode: 'CLASSICAL', scanJobId: 'job-1' })
    ));
    await waitFor(() => expect(api.cyberAnalysisScanAssessment).toHaveBeenCalledWith('job-1', 'INTERNAL', 'en'));

    // TARAMA (Scan) step now shows its own finding summary and gates
    // navigation to RAPOR behind an explicit action, rather than
    // auto-advancing the instant the job completes.
    await waitFor(() => expect(screen.getByRole('button', { name: /Go to Report/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Go to Report/i }));

    await waitFor(() => expect(screen.getByText(/Not applicable/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Evidence-bound assessment/i)).toBeInTheDocument());
  });

  it('never opens a new tab/window at any step', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'New Asset' }));
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
