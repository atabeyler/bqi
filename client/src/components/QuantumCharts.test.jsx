import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScenarioComparisonChart, FraudRiskChart, OptimizerChart } from './QuantumCharts.jsx';
import { LangProvider } from '../services/langContext.jsx';

function renderWithLang(ui) {
  return render(<LangProvider>{ui}</LangProvider>);
}

describe('ScenarioComparisonChart', () => {
  const scenarios = [
    { id: 'A', title: 'Senaryo A', llmEstimate: 42, quantumProbability: 45.5, quantumRangeLow: 44, quantumRangeHigh: 47 },
    { id: 'B', title: 'Senaryo B', llmEstimate: 31 }, // no quantumProbability -- should be filtered out
  ];

  it('renders nothing when no scenario has a quantum result', () => {
    const { container } = renderWithLang(<ScenarioComparisonChart scenarios={[{ id: 'X', llmEstimate: 10 }]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an empty/missing scenarios prop', () => {
    const { container } = renderWithLang(<ScenarioComparisonChart scenarios={[]} />);
    expect(container).toBeEmptyDOMElement();
    const { container: container2 } = renderWithLang(<ScenarioComparisonChart />);
    expect(container2).toBeEmptyDOMElement();
  });

  it('only plots scenarios that have a quantumProbability', () => {
    const { container } = renderWithLang(<ScenarioComparisonChart scenarios={scenarios} />);
    expect(container.querySelectorAll('svg g[key], svg > g').length).toBeGreaterThan(0);
    expect(screen.getByText('Senaryo A')).toBeInTheDocument();
    expect(screen.queryByText('Senaryo B')).not.toBeInTheDocument();
  });

  it('toggles between chart and table view', () => {
    renderWithLang(<ScenarioComparisonChart scenarios={scenarios} />);
    expect(document.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Tablo gorunumu'));
    expect(document.querySelector('table')).toBeInTheDocument();
    expect(document.querySelector('svg')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Grafik gorunumu'));
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('shows a tooltip on bar hover and hides it on mouse leave', () => {
    const { container } = renderWithLang(<ScenarioComparisonChart scenarios={scenarios} />);
    const bar = container.querySelector('path');
    fireEvent.mouseMove(bar, { clientX: 10, clientY: 10 });
    expect(screen.getByText(/YZ Tahmini: %42/)).toBeInTheDocument();
    fireEvent.mouseLeave(bar);
    expect(screen.queryByText(/YZ Tahmini: %42/)).not.toBeInTheDocument();
  });
});

describe('FraudRiskChart', () => {
  const transactions = [
    { id: 'TXN-1', amount: 1000, riskScore: 80, flagged: true },
    { id: 'TXN-2', amount: 200, riskScore: 20, flagged: false },
  ];

  it('renders nothing for an empty transaction list', () => {
    const { container } = renderWithLang(<FraudRiskChart transactions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one bar per transaction and a table with the same rows', () => {
    renderWithLang(<FraudRiskChart transactions={transactions} />);
    fireEvent.click(screen.getByText('Tablo gorunumu'));
    expect(screen.getByText('TXN-1')).toBeInTheDocument();
    expect(screen.getByText('TXN-2')).toBeInTheDocument();
    expect(screen.getByText('⚠ Isaretlendi')).toBeInTheDocument();
  });
});

describe('OptimizerChart', () => {
  const items = [
    { id: 'Proje-A', value: 35, cost: 30, selected: true },
    { id: 'Proje-B', value: 28, cost: 25, selected: false },
  ];

  it('renders nothing for an empty item list', () => {
    const { container } = renderWithLang(<OptimizerChart items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows selected/unselected status in the table view', () => {
    renderWithLang(<OptimizerChart items={items} />);
    fireEvent.click(screen.getByText('Tablo gorunumu'));
    expect(screen.getByText('✓ Secildi')).toBeInTheDocument();
    expect(screen.getByText('Proje-A')).toBeInTheDocument();
    expect(screen.getByText('Proje-B')).toBeInTheDocument();
  });
});
