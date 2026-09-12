import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CyberAnalysisContent from './CyberAnalysisContent.jsx';
import { LangProvider } from '../services/langContext.jsx';
import { api, cyberAnalysisApi } from '../services/api.js';

vi.mock('../services/api.js', () => ({
  api: {
    cyberAnalysisStatus: vi.fn(async () => ({ available: true })),
    cyberAnalysisOverview: vi.fn(async () => ({ securityScore: { score: 82, openFindingCount: 3 }, coverageScore: { score: 40 } })),
    cyberAnalysisFindings: vi.fn(async () => ({ findings: [] })),
  },
  cyberAnalysisApi: {
    listAssets: vi.fn(async () => ({ assets: [] })),
    createAsset: vi.fn(),
    getAsset: vi.fn(),
    updateAsset: vi.fn(),
    getAssetSummary: vi.fn(),
    addAssetIdentifier: vi.fn(),
    getAssetHistory: vi.fn(async () => ({ history: [] })),
    listScans: vi.fn(async () => ({ jobs: [] })),
    createScan: vi.fn(),
    getScan: vi.fn(),
    cancelScan: vi.fn(),
    archiveScan: vi.fn(),
    unarchiveScan: vi.fn(),
    deleteScan: vi.fn(),
    getScanFindings: vi.fn(async () => ({ findings: [] })),
    listReports: vi.fn(async () => ({ reports: [] })),
    generateReport: vi.fn(),
    getReport: vi.fn(),
    archiveReport: vi.fn(),
    deleteReport: vi.fn(),
    listEngines: vi.fn(async () => ({ engines: [] })),
    runEngineHealthCheck: vi.fn(),
    listQuantumProviders: vi.fn(async () => ({ providers: [] })),
    getQuantumPolicy: vi.fn(async () => ({ policy: { allowQuantumSimulator: false, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' } })),
    listQuantumBenchmarks: vi.fn(async () => ({ benchmarks: [] })),
    listQuantumJobs: vi.fn(async () => ({ jobs: [] })),
    listCryptoInventory: vi.fn(async () => ({ findings: [] })),
    getPqcReadiness: vi.fn(async () => ({ readinessScore: null, quantumVulnerableCount: 0, unclassifiedCount: 0, roadmap: [] })),
    getCbom: vi.fn(async () => ({ componentCount: 0 })),
    listControlledProofHistory: vi.fn(async () => ({ runs: [] })),
    analyzeControlledProof: vi.fn(),
    getControlledProof: vi.fn(),
    startControlledPublicProof: vi.fn(),
    stopControlledPublicProof: vi.fn(),
    cancelControlledProof: vi.fn(),
    archiveControlledProof: vi.fn(),
    unarchiveControlledProof: vi.fn(),
    deleteControlledProof: vi.fn(),
  },
}));

function renderContent({ isAdmin = false } = {}) {
  return render(<LangProvider><CyberAnalysisContent isAdmin={isAdmin} /></LangProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.cyberAnalysisStatus.mockResolvedValue({ available: true });
  cyberAnalysisApi.createAsset.mockResolvedValue({ asset: { id: 'asset-1', name: 'example.com', asset_type: 'DOMAIN', criticality: 'MEDIUM', status: 'ACTIVE' } });
  // All labels now route through i18n (t()) instead of hardcoded English;
  // pin the language so the assertions below stay deterministic.
  localStorage.setItem('bqi_lang', 'en');
});

describe('CyberAnalysisContent', () => {
  it('shows Controlled Proof as red and usable for admin, but visible and locked for non-admin', async () => {
    const locked = renderContent();
    await waitFor(() => screen.getByText('82'));
    const lockedButton = screen.getByRole('button', { name: /CONTROLLED PROOF.*LOCKED/i });
    expect(lockedButton).toBeDisabled();
    expect(lockedButton).toHaveAttribute('title', 'System Administrator access required');
    locked.unmount();

    renderContent({ isAdmin: true });
    await waitFor(() => screen.getByText('82'));
    const adminButton = screen.getByRole('button', { name: 'CONTROLLED PROOF' });
    expect(adminButton).toBeEnabled();
    fireEvent.click(adminButton);
    expect(await screen.findByRole('button', { name: 'ANALYZE TARGET' })).toBeInTheDocument();
    expect(cyberAnalysisApi.listControlledProofHistory).toHaveBeenCalled();
  });

  it('offers Word, PDF, and share actions for a completed Controlled Proof result', async () => {
    cyberAnalysisApi.analyzeControlledProof.mockResolvedValue({
      run: {
        id: 'proof-1', proofId: 'ABC123', target: 'https://example.com', normalizedTarget: 'https://example.com/',
        status: 'READY', securityImpact: 'NO_PATH', publicProofStatus: 'UNAVAILABLE', persistentModification: false,
      },
    });
    renderContent({ isAdmin: true });
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'CONTROLLED PROOF' }));
    fireEvent.change(screen.getByLabelText('Target URL'), { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'ANALYZE TARGET' }));
    await waitFor(() => expect(screen.getAllByText('ABC123').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /DOWNLOAD \.DOCX/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /DOWNLOAD \.PDF/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SHARE/i })).toBeInTheDocument();
  });

  it('shows a clear unavailable message when BCI is not configured', async () => {
    api.cyberAnalysisStatus.mockResolvedValue({ available: false });
    renderContent();
    await waitFor(() => expect(screen.getByText(/BOLD CYBER INTELLIGENCE/i)).toBeInTheDocument());
  });

  it('shows real dashboard scores on load, using the existing SSO session (no separate login)', async () => {
    renderContent();
    await waitFor(() => expect(screen.getByText('82')).toBeInTheDocument());
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('counts UNKNOWN engines as unavailable in the dynamic command-center warning', async () => {
    cyberAnalysisApi.listEngines.mockResolvedValue({
      engines: [
        { id: 'healthy', status: 'HEALTHY' },
        { id: 'offline', status: 'OFFLINE' },
        { id: 'unknown', status: 'UNKNOWN' },
      ],
    });
    renderContent();
    await waitFor(() => expect(screen.getByText(/2 analysis engine\(s\) unavailable/i)).toBeInTheDocument());
  });

  it('switches to the Assets tab and lets the user add a real asset with a real target/identifier via the BCI integration API', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => expect(cyberAnalysisApi.listAssets).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'example.com' } });
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Add asset/i }));
    await waitFor(() => expect(cyberAnalysisApi.createAsset).toHaveBeenCalledWith({ name: 'example.com', assetType: 'DOMAIN' }));
    // The target is what makes the asset findable by risk scoring, coverage
    // score and the security graph -- it must always be
    // registered as a real identifier, never silently dropped.
    await waitFor(() => expect(cyberAnalysisApi.addAssetIdentifier).toHaveBeenCalledWith('asset-1', { identifierType: 'DOMAIN', value: 'example.com' }));
  });

  it('disables "Add asset" until both name and target are filled in', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => expect(cyberAnalysisApi.listAssets).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Add asset/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'example.com' } });
    expect(screen.getByRole('button', { name: /Add asset/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/Target/), { target: { value: 'example.com' } });
    expect(screen.getByRole('button', { name: /Add asset/i })).not.toBeDisabled();
  });

  it('keeps asset selection read-only and exposes no scan-start shortcut outside Command Center', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValue({
      assets: [{ id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'prod.example.com' }],
    });
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => screen.getByText('prod-web'));

    expect(screen.queryByRole('button', { name: 'Start scan' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(cyberAnalysisApi.getAsset).toHaveBeenCalledWith('asset-1'));
    expect(screen.queryByRole('button', { name: 'Start scan' })).not.toBeInTheDocument();
  });

  it('archives an asset after confirmation, keeping the same real update API (no fake delete)', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValue({
      assets: [{ id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'prod.example.com' }],
    });
    cyberAnalysisApi.getAsset.mockResolvedValue({
      asset: { id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', created_at: new Date().toISOString() },
      identifiers: [{ id: 'i1', identifier_type: 'DOMAIN', value: 'prod.example.com' }],
      technologies: [],
      relationships: [],
    });
    cyberAnalysisApi.getAssetSummary.mockResolvedValue({
      summary: { targets: ['prod.example.com'], lastScan: null, findingCount: 0, openFindingCount: 0, priorityBreakdown: {}, riskScore: null },
    });
    cyberAnalysisApi.updateAsset.mockResolvedValue({ asset: { id: 'asset-1', status: 'ARCHIVED' } });

    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => screen.getByText('prod-web'));

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, archive/i }));
    await waitFor(() => expect(cyberAnalysisApi.updateAsset).toHaveBeenCalledWith('asset-1', { status: 'ARCHIVED' }));
  });

  it('shows real analysis history and lets the user generate an asset-scoped report from the asset detail view', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValue({
      assets: [{ id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'prod.example.com' }],
    });
    cyberAnalysisApi.getAsset.mockResolvedValue({
      asset: { id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', created_at: new Date().toISOString() },
      identifiers: [{ id: 'i1', identifier_type: 'DOMAIN', value: 'prod.example.com' }],
      technologies: [],
      relationships: [],
    });
    cyberAnalysisApi.getAssetSummary.mockResolvedValue({
      summary: { targets: ['prod.example.com'], lastScan: null, findingCount: 0, openFindingCount: 0, priorityBreakdown: {}, riskScore: null },
    });
    cyberAnalysisApi.getAssetHistory.mockResolvedValue({
      history: [{ id: 'h1', scan_job_id: 'job-1', risk_score: 60, open_finding_count: 2, computed_at: new Date().toISOString() }],
    });

    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => screen.getByText('prod-web'));
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));

    await waitFor(() => expect(cyberAnalysisApi.getAssetHistory).toHaveBeenCalledWith('asset-1'));
    await waitFor(() => expect(screen.getByText('60')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Generate EXECUTIVE/i }));
    await waitFor(() => expect(cyberAnalysisApi.generateReport).toHaveBeenCalledWith('EXECUTIVE', { assetId: 'asset-1', language: 'en' }));
  });

  it('never opens a new tab/window anywhere in the tab flow', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Quantum & PQC' }));
    await waitFor(() => expect(cyberAnalysisApi.listQuantumProviders).toHaveBeenCalled());
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('steps through tabs with Previous/Next, disabling at both ends', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(cyberAnalysisApi.listAssets).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Previous/ })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Previous/ }));
    await waitFor(() => screen.getByText('82'));
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled();
  });

  it('steps forward on Enter and back on Esc, working everywhere (no need to click an empty area first)', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));

    // Dashboard has nothing required to fill in, so Enter advances immediately.
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(cyberAnalysisApi.listAssets).toHaveBeenCalled());

    // Esc goes back even while focus is inside a text field.
    const nameInput = screen.getByPlaceholderText('Name');
    fireEvent.keyDown(nameInput, { key: 'Escape' });
    await waitFor(() => screen.getByText('82'));
  });

  it('treats Assets and Scans as navigation views rather than scan-creation steps', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Assets' }));
    await waitFor(() => expect(cyberAnalysisApi.listAssets).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Next/ })).not.toBeDisabled();
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(cyberAnalysisApi.listScans).toHaveBeenCalled());
    expect(screen.queryByText('Start Scan')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start scan' })).not.toBeInTheDocument();
    expect(cyberAnalysisApi.createScan).not.toHaveBeenCalled();
  });

  it('shows the Command Center with real aggregated metrics and a New Analysis CTA that opens the dedicated wizard overlay', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValue({ assets: [{ id: 'a1', name: 'x', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'x.com' }] });
    cyberAnalysisApi.listScans.mockResolvedValue({
      jobs: [{ id: 's1', target: 'x.com', requested_class: 'PASSIVE', status: 'ANALYZING', attempts: 1 }],
    });
    renderContent();
    await waitFor(() => screen.getByText('82'));

    expect(screen.getAllByText(/Command Center/i).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Active Assets')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /New Analysis/i }));
    // The wizard overlay, not the persistent Assets tab -- it has its own
    // Existing/New Asset toggle, distinct from AssetsTab's "Add Asset" panel.
    await waitFor(() => expect(screen.getByRole('button', { name: /Existing Asset/i })).toBeInTheDocument());
  });

  it('never shows Prev/Next on the technical panels (Engines, Quantum & PQC) -- they are not analysis steps', async () => {
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Engines' }));
    await waitFor(() => expect(cyberAnalysisApi.listEngines).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Previous/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next/ })).not.toBeInTheDocument();
  });

  it('renders a scan with NO_COVERAGE status distinctly from COMPLETED, never as a clean zero-finding result', async () => {
    cyberAnalysisApi.listScans.mockResolvedValue({
      jobs: [{ id: 's1', target: 'boldkimya.com.tr', requested_class: 'PASSIVE', status: 'NO_COVERAGE', attempts: 1 }],
    });
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Scans' }));
    await waitFor(() => expect(screen.getByText('No coverage')).toBeInTheDocument());
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('keeps archive and confirmed delete as separate actions for a terminal scan', async () => {
    cyberAnalysisApi.listScans.mockResolvedValue({ jobs: [{ id: 's1', target: 'demo.example', requested_class: 'PASSIVE', status: 'COMPLETED', attempts: 1 }] });
    cyberAnalysisApi.archiveScan.mockResolvedValue({ job: { id: 's1' } });
    cyberAnalysisApi.deleteScan.mockResolvedValue({ job: { id: 's1' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Scans' }));
    await waitFor(() => screen.getByText('demo.example'));
    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(cyberAnalysisApi.deleteScan).toHaveBeenCalledWith('s1'));
    expect(window.confirm).toHaveBeenCalled();
    window.confirm.mockRestore();
  });

  it('groups findings by their real analysis and opens only that analysis findings on Inspect', async () => {
    const analysis = { id: 'scan-1', target: 'one.example', requested_class: 'SAFE_ACTIVE', status: 'COMPLETED', finding_count: 1, created_at: '2026-09-11T10:00:00Z' };
    cyberAnalysisApi.listScans.mockImplementation(async (archived) => ({ jobs: archived ? [] : [analysis] }));
    cyberAnalysisApi.getScanFindings.mockResolvedValue({ findings: [{ id: 'finding-1', title: 'Observed header issue', priority: 'HIGH_PRIORITY', risk_score: 61, status: 'NEW' }] });

    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Findings' }));
    await waitFor(() => expect(screen.getByText('Analyses and findings')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));

    await waitFor(() => expect(cyberAnalysisApi.getScanFindings).toHaveBeenCalledWith('scan-1'));
    expect(await screen.findByText('Observed header issue')).toBeInTheDocument();
  });

  it('opens Controlled Proof history details directly below the selected history row', async () => {
    const historyRun = { id: 'proof-run-1', proofId: 'PROOF-1', normalizedTarget: 'https://proof.example/', status: 'COMPLETED', securityImpact: 'NO_PATH' };
    cyberAnalysisApi.listControlledProofHistory.mockResolvedValue({ runs: [historyRun] });
    cyberAnalysisApi.getControlledProof.mockResolvedValue({ run: { ...historyRun, securityValidator: 'validator-directly-below', securityEvidence: {} } });

    renderContent({ isAdmin: true });
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'CONTROLLED PROOF' }));
    await waitFor(() => screen.getByText('PROOF-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));

    const validator = await screen.findByText('validator-directly-below');
    expect(screen.getByTestId('controlled-proof-history-proof-run-1')).toContainElement(validator);
  });

  it('Reports tab selects Asset -> Analysis for an exact scan report and preserves asset-history scope separately', async () => {
    cyberAnalysisApi.listAssets.mockResolvedValue({
      assets: [{ id: 'asset-1', name: 'prod-web', asset_type: 'DOMAIN', criticality: 'HIGH', status: 'ACTIVE', target: 'prod.example.com' }],
    });
    cyberAnalysisApi.getAsset.mockResolvedValue({ identifiers: [{ identifier_type: 'DOMAIN', value: 'prod.example.com' }] });
    cyberAnalysisApi.listScans.mockImplementation(async (archived) => ({ jobs: archived ? [] : [{ id: 'scan-1', target: 'prod.example.com', requested_class: 'SAFE_ACTIVE', status: 'COMPLETED', created_at: '2026-09-11T10:00:00Z' }] }));
    cyberAnalysisApi.generateReport.mockResolvedValue({ report: { id: 'report-1' } });
    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }));
    await waitFor(() => expect(cyberAnalysisApi.listReports).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Generate Full/i })).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'asset-1' } });
    await waitFor(() => expect(cyberAnalysisApi.getAsset).toHaveBeenCalledWith('asset-1'));
    fireEvent.change(screen.getAllByRole('combobox')[2], { target: { value: 'scan-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate Executive/i }));
    await waitFor(() => expect(cyberAnalysisApi.generateReport).toHaveBeenCalledWith('EXECUTIVE', { assetId: 'asset-1', scanJobId: 'scan-1', language: 'en' }));

    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ASSET_HISTORY' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate Technical/i }));
    await waitFor(() => expect(cyberAnalysisApi.generateReport).toHaveBeenCalledWith('TECHNICAL', { assetId: 'asset-1', language: 'en' }));
  });

  it('keeps report archive and confirmed deletion as separate actions', async () => {
    const report = { id: 'report-1', report_type: 'TECHNICAL', created_at: '2026-09-11T10:00:00Z', bci_version: '0.1.78' };
    cyberAnalysisApi.listReports.mockResolvedValue({ reports: [report] });
    cyberAnalysisApi.archiveReport.mockResolvedValue({ report: { id: report.id } });
    cyberAnalysisApi.deleteReport.mockResolvedValue({ report: { id: report.id } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderContent();
    await waitFor(() => screen.getByText('82'));
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }));
    await waitFor(() => screen.getByText('0.1.78'));

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(cyberAnalysisApi.archiveReport).toHaveBeenCalledWith(report.id));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(cyberAnalysisApi.deleteReport).toHaveBeenCalledWith(report.id));
    expect(window.confirm).toHaveBeenCalled();
    window.confirm.mockRestore();
  });
});
