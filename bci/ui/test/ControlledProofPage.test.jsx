import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LangProvider } from '../src/i18n/LangContext.jsx';

const mockApi = {
  listControlledProofHistory: vi.fn(), analyzeControlledProof: vi.fn(), getControlledProof: vi.fn(),
  startControlledPublicProof: vi.fn(),
  stopControlledPublicProof: vi.fn(),
  cancelControlledProof: vi.fn(), archiveControlledProof: vi.fn(), unarchiveControlledProof: vi.fn(), deleteControlledProof: vi.fn(),
};
const authValue = { user: { email: 'admin@test.local' }, logout: vi.fn(), hasPermission: vi.fn() };
vi.mock('../src/api.js', () => ({ api: mockApi }));
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => authValue }));

const { default: ControlledProofPage } = await import('../src/pages/ControlledProofPage.jsx');
const { default: Layout } = await import('../src/components/Layout.jsx');

beforeEach(() => {
  Object.values(mockApi).forEach((fn) => fn.mockReset());
  authValue.hasPermission.mockReset();
  authValue.logout.mockReset();
  mockApi.listControlledProofHistory.mockResolvedValue({ runs: [] });
  mockApi.getControlledProof.mockResolvedValue({ run: {} });
  mockApi.cancelControlledProof.mockResolvedValue({ run: {} });
  mockApi.archiveControlledProof.mockResolvedValue({ run: {} });
  mockApi.unarchiveControlledProof.mockResolvedValue({ run: {} });
  mockApi.deleteControlledProof.mockResolvedValue({ run: {} });
});

describe('Controlled Proof UI', () => {
  it('shows a locked restricted page to non-admin users', () => {
    authValue.hasPermission.mockReturnValue(false);
    render(<ControlledProofPage />);
    expect(screen.getByText('RESTRICTED ADMIN MODULE')).toBeInTheDocument();
    expect(screen.getByText(/System Administrator access required/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ANALYZE TARGET' })).not.toBeInTheDocument();
    expect(mockApi.listControlledProofHistory).not.toHaveBeenCalled();
  });

  it('renders red active navigation for admin and grey locked navigation otherwise', () => {
    const renderLayout = () => render(
      <LangProvider><MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={<Layout />}><Route index element={<div>Home</div>} /></Route></Routes></MemoryRouter></LangProvider>
    );
    authValue.hasPermission.mockReturnValue(false);
    const locked = renderLayout();
    expect(screen.getByText(/CONTROLLED PROOF · LOCKED/)).toHaveAttribute('title', 'System Administrator access required');
    locked.unmount();
    authValue.hasPermission.mockReturnValue(true);
    renderLayout();
    expect(screen.getByRole('link', { name: 'CONTROLLED PROOF' })).toHaveClass('controlled-proof-link');
  });

  it('keeps impact and customer-visible proof separate and starts only an available public validator', async () => {
    authValue.hasPermission.mockReturnValue(true);
    mockApi.analyzeControlledProof.mockResolvedValue({ run: {
      id: 'r1', proofId: 'A'.repeat(32), target: 'https://customer.example', normalizedTarget: 'https://customer.example/', status: 'READY',
      securityImpact: 'VERIFIED_IMPACT_PATH', securityValidator: 'response-reflection', evidenceHash: 'b'.repeat(64),
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), persistentModification: false, createdAt: new Date().toISOString(),
      publicProofStatus: 'AVAILABLE', publicValidator: 'cloudflare-edge-worker',
      securityEvidence: {
        securityObservations: [{ observationId: 'o1', engineId: 'intrusive-validation', ruleId: 'BCI-INTRUSIVE-CORS_VALIDATION', title: 'CORS reflects an untrusted Origin', severity: 'HIGH', location: 'https://customer.example/api', verificationStatus: 'CONFIRMED', proofEligibility: 'NOT_WEB_CONTENT_IMPACT_SIGNAL', evidenceHash: 'abc123', technicalEvidence: 'Origin was reflected.', possibleImpact: 'Cross-origin exposure.', technology: 'Microsoft IIS', remediation: 'Restrict origins.', revalidation: 'Repeat the check.' }],
        deliveryProviderDiscovery: {
          candidates: [{ providerId: 'microsoft-iis', providerLabel: 'Microsoft IIS', confidence: 'MEDIUM', adapterStatus: 'BLOCKED', blockingReason: 'origin_change_has_no_safe_self_expiry' }],
          supportMatrix: [{ id: 'cloudflare', label: 'Cloudflare', adapterId: 'cloudflare-edge-worker', adapterStatus: 'IMPLEMENTED' }],
        },
      },
    } });
    mockApi.startControlledPublicProof.mockResolvedValue({ run: {
      id: 'r1', proofId: 'A'.repeat(32), status: 'READY', securityImpact: 'VERIFIED_IMPACT_PATH',
      publicProofStatus: 'ACTIVE', publicValidator: 'cloudflare-edge-worker', publicVisibilityVerified: true,
      publicExpiresAt: new Date(Date.now() + 30_000).toISOString(), publicEvidenceHash: 'c'.repeat(64),
    } });
    render(<ControlledProofPage />);
    await userEvent.type(screen.getByLabelText('Target URL'), 'https://customer.example');
    await userEvent.click(screen.getByRole('button', { name: 'ANALYZE TARGET' }));
    expect((await screen.findAllByText('VERIFIED IMPACT PATH')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('A'.repeat(32)).length).toBeGreaterThan(0);
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText('CORS reflects an untrusted Origin')).toBeInTheDocument();
    expect(screen.getByText(/Origin was reflected/)).toBeInTheDocument();
    expect(screen.getByText(/Restrict origins/)).toBeInTheDocument();
    expect(screen.getByText(/Microsoft IIS \(MEDIUM · BLOCKED/)).toBeInTheDocument();
    expect(screen.getByText('Public visibility support matrix')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'START PUBLIC PROOF' }));
    expect(mockApi.startControlledPublicProof).toHaveBeenCalledWith('r1', 30);
    expect(await screen.findByText(/PROOF ACTIVE/)).toBeInTheDocument();
    expect(screen.getByText('c'.repeat(64))).toBeInTheDocument();
  });
});
