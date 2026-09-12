import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockApi = {
  getDigitalTwin: vi.fn(),
  getKnowledgeGraph: vi.fn(),
  getComplianceAssessment: vi.fn(),
  getAiSecurity: vi.fn(),
  runCyberDecision: vi.fn(),
  runWhatIfSimulation: vi.fn(),
};

vi.mock('../src/api.js', () => ({ api: mockApi }));
vi.mock('../src/AuthContext.jsx', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
vi.mock('../src/i18n/LangContext.jsx', () => ({ useLang: () => ({ t: (key) => key }) }));

const { default: DecisionPage } = await import('../src/pages/DecisionPage.jsx');

beforeEach(() => {
  Object.values(mockApi).forEach((mock) => mock.mockReset());
  mockApi.getDigitalTwin.mockResolvedValue({ findings: [{ id: 'f1' }] });
  mockApi.getKnowledgeGraph.mockResolvedValue({ nodes: [{}, {}], edges: [{}] });
  mockApi.getComplianceAssessment.mockResolvedValue({
    note: 'evidence only',
    frameworks: { CIS: { nonCompliantCount: 1 }, NIST: { nonCompliantCount: 1 }, ISO27001: { nonCompliantCount: 0 } },
  });
  mockApi.getAiSecurity.mockResolvedValue({ findings: [{ id: 'af1' }], atlasMappings: [{ techniqueId: 'AML.T0051' }] });
});

describe('DecisionPage', () => {
  it('shows graph/twin evidence and runs the deterministic recommendation', async () => {
    mockApi.runCyberDecision.mockResolvedValue({
      estimatedRiskReduction: 40,
      recommendations: [{ findingId: 'f1', title: 'Patch issue', estimatedRiskReduction: 40, action: { type: 'PATCH_CVE' } }],
    });
    render(<DecisionPage />);

    expect(await screen.findByText('decisionTitle')).toBeInTheDocument();
    await waitFor(() => expect(mockApi.getKnowledgeGraph).toHaveBeenCalled());
    expect(screen.getByText('decisionAiFindings')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'decisionRecommend' }));
    expect(await screen.findByText(/Patch issue/)).toBeInTheDocument();
    expect(mockApi.runCyberDecision).toHaveBeenCalledWith(5);
  });

  it('submits a patch scenario to the digital twin', async () => {
    mockApi.runWhatIfSimulation.mockResolvedValue({ riskBefore: 90, estimatedRiskAfter: 0, closedAttackPathEdges: [], assumptions: ['snapshot only'] });
    render(<DecisionPage />);
    await screen.findByText('decisionTitle');
    await userEvent.type(screen.getByLabelText('decisionPatchCve'), 'CVE-2026-12345');
    await userEvent.click(screen.getByRole('button', { name: 'decisionSimulate' }));
    expect(await screen.findByText(/90 → 0/)).toBeInTheDocument();
    expect(mockApi.runWhatIfSimulation).toHaveBeenCalledWith({ type: 'PATCH_CVE', cveId: 'CVE-2026-12345' });
  });
});
