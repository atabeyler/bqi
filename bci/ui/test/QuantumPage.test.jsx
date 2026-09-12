import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LangProvider } from '../src/i18n/LangContext.jsx';

const mockApi = {
  listQuantumProviders: vi.fn(),
  getQuantumPolicy: vi.fn(),
  listQuantumBenchmarks: vi.fn(),
  listQuantumJobs: vi.fn(),
  listCryptoInventory: vi.fn(),
  getPqcReadiness: vi.fn(),
  getCbom: vi.fn(),
  runRemediationOptimize: vi.fn(),
  discoverCrypto: vi.fn(),
  discoverJwtCrypto: vi.fn(),
  setQuantumPolicy: vi.fn(),
};
vi.mock('../src/api.js', () => ({ api: mockApi }));

const authValue = { hasPermission: vi.fn() };
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => authValue }));

const { default: QuantumPage } = await import('../src/pages/QuantumPage.jsx');

beforeEach(() => {
  Object.values(mockApi).forEach((fn) => fn.mockReset());
  mockApi.listQuantumProviders.mockResolvedValue({
    providers: [
      { id: 'classical', status: 'AVAILABLE' },
      { id: 'ibm_quantum', status: 'NOT_CONFIGURED', detail: 'BCI_IBM_QUANTUM_TOKEN not set' },
    ],
  });
  mockApi.getQuantumPolicy.mockResolvedValue({
    policy: { allowQuantumSimulator: false, allowQuantumHardware: false, maxExternalDataClassification: 'PUBLIC' },
  });
  mockApi.listQuantumBenchmarks.mockResolvedValue({ benchmarks: [] });
  mockApi.listQuantumJobs.mockResolvedValue({ jobs: [] });
  mockApi.listCryptoInventory.mockResolvedValue({
    findings: [{ id: 'f1', target: 'example.com', algorithm_id: 'RSA', key_size_bits: 2048, quantum_vulnerable: true, discovered_at: new Date().toISOString() }],
  });
  mockApi.getPqcReadiness.mockResolvedValue({ readinessScore: 40, quantumVulnerableCount: 1, unclassifiedCount: 0, roadmap: [] });
  mockApi.getCbom.mockResolvedValue({ componentCount: 1, components: [] });
  authValue.hasPermission.mockReset();
});

function renderPage() {
  return render(<LangProvider><QuantumPage /></LangProvider>);
}

describe('QuantumPage', () => {
  it('renders provider health, PQC readiness, and crypto inventory without exposing marketing claims', async () => {
    authValue.hasPermission.mockReturnValue(false);
    renderPage();

    expect(await screen.findByText('classical')).toBeInTheDocument();
    expect(screen.getByText('NOT_CONFIGURED')).toBeInTheDocument();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getByText('RSA')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.queryByText(/quantum.?powered/i)).not.toBeInTheDocument();
  });

  it('hides the discovery and optimizer forms for a user without the right permissions', async () => {
    authValue.hasPermission.mockReturnValue(false);
    renderPage();
    await screen.findByText('classical');
    expect(screen.queryByRole('button', { name: /discover crypto/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run optimizer/i })).not.toBeInTheDocument();
  });

  it('shows the discovery form for a user with scan:create', async () => {
    authValue.hasPermission.mockImplementation((perm) => perm === 'scan:create');
    renderPage();
    expect(await screen.findByRole('button', { name: /discover crypto/i })).toBeInTheDocument();
  });
});
