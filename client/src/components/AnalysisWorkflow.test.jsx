import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResultSourceBadge, DecisionPipelinePanel } from './AnalysisWorkflow.jsx';
import { LangProvider } from '../services/langContext.jsx';

function renderWithLang(ui) { return render(<LangProvider>{ui}</LangProvider>); }

describe('ResultSourceBadge', () => {
  it('labels a simulator result', () => {
    renderWithLang(<ResultSourceBadge source="qiskit_aer_simulation" />);
    expect(screen.getByText('SIMULATOR')).toBeInTheDocument();
  });

  it('labels a real-hardware-verified result', () => {
    renderWithLang(<ResultSourceBadge source="ibm_hardware_verified" />);
    expect(screen.getByText('REAL HARDWARE')).toBeInTheDocument();
  });

  it('labels an AI-estimate result', () => {
    renderWithLang(<ResultSourceBadge source="ai_estimate" />);
    expect(screen.getByText('AI ESTIMATE')).toBeInTheDocument();
  });

  it('falls back to AI ESTIMATE for an unrecognized/missing source', () => {
    renderWithLang(<ResultSourceBadge source={undefined} />);
    expect(screen.getByText('AI ESTIMATE')).toBeInTheDocument();
  });
});

describe('DecisionPipelinePanel', () => {
  const baseResult = {
    provider: 'Claude (Anthropic)',
    evidence: [
      { claim: 'ai-narrative', engine: 'ai', source: 'Claude (Anthropic)', verified: false, confidence: null },
      {
        claim: 'top-scenario', engine: 'scenario-quantum', source: 'ai-generated', verified: false,
        method: 'quantum-mixer-circuit (qiskit-aer-simulator)', confidence: 'agrees-with-classical-baseline',
      },
    ],
    decisionFusion: { engineCount: 1, verifiedOnHardwareCount: 0, agreementLevel: 'consistent', summary: '1 kuantum motoru çalıştı, hepsi uyumlu.' },
  };

  it('renders nothing when the result has no evidence', () => {
    const { container } = renderWithLang(<DecisionPipelinePanel result={{ provider: 'Claude' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one node per evidence engine plus the fusion and report nodes', () => {
    renderWithLang(<DecisionPipelinePanel result={baseResult} />);
    expect(screen.getByText('GİRDİ')).toBeInTheDocument();
    expect(screen.getByText('YZ ANALİZİ')).toBeInTheDocument();
    expect(screen.getByText('SENARYO MOTORU')).toBeInTheDocument();
    expect(screen.getByText('KARAR FÜZYONU')).toBeInTheDocument();
    expect(screen.getByText('RAPOR')).toBeInTheDocument();
    expect(screen.queryByText('IBM DOĞRULAMASI')).not.toBeInTheDocument();
  });

  it('shows an IBM verification node when an evidence item was hardware-verified', () => {
    const verified = { ...baseResult, evidence: [baseResult.evidence[0], { ...baseResult.evidence[1], verified: true }] };
    renderWithLang(<DecisionPipelinePanel result={verified} />);
    expect(screen.getByText('IBM DOĞRULAMASI')).toBeInTheDocument();
  });

  it('expands a node detail on click and collapses it on a second click', () => {
    renderWithLang(<DecisionPipelinePanel result={baseResult} />);
    expect(screen.queryByText(/1 kuantum motoru çalıştı/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('KARAR FÜZYONU'));
    expect(screen.getByText(/1 kuantum motoru çalıştı/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('KARAR FÜZYONU'));
    expect(screen.queryByText(/1 kuantum motoru çalıştı/)).not.toBeInTheDocument();
  });
});
