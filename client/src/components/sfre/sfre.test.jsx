import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StackedBar, RoundsChart } from './charts.jsx';
import DataPanel from './DataPanel.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import { LangProvider } from '../../services/langContext.jsx';

vi.mock('../../services/api.js', () => ({ sfreApi: { federation: async () => ({ items: [] }), ingests: async () => ({ ingests: [] }), explain: vi.fn(), upload: vi.fn() } }));

const wrap = (ui) => render(<LangProvider>{ui}</LangProvider>);

describe('SFRE charts expose numbers as text (not colour alone)', () => {
  it('StackedBar lists every segment value and share, and has an accessible label', () => {
    render(<StackedBar title="By who" total={100} tableLabel="data table" segments={[{ key: 'a', label: 'Direct', value: 75, color: '#f00' }, { key: 'b', label: 'Own', value: 25, color: '#0f0' }]} />);
    expect(screen.getByRole('img', { name: /By who: Direct 75, Own 25/ })).toBeTruthy(); expect(screen.getAllByText(/75 \(75\.0%\)/).length).toBeGreaterThan(0);
  });
  it('RoundsChart renders one bar per round and a text table fallback', () => {
    const { container } = render(<RoundsChart title="Rounds" rounds={[{ round: 0, sales: 10, loss: 5 }, { round: 1, sales: 2, loss: 1 }]} salesLabel="sales" lossLabel="loss" roundLabel="round" tableLabel="tbl" />);
    expect(container.querySelectorAll('rect').length).toBe(2); expect(container.querySelector('table.sr-only')).toBeTruthy();
  });
});

describe('DataPanel', () => {
  it('non-admins see the notice and cannot pick files or upload', () => {
    wrap(<DataPanel isAdmin={false} />);
    expect(screen.getAllByRole('button', { name: /./ }).every((b) => b.disabled)).toBe(true);
    document.querySelectorAll('input[type=file]').forEach((i) => expect(i.disabled).toBe(true));
    expect(document.querySelectorAll('input[type=file]').length).toBe(4);
  });
});

describe('ResultsPanel', () => {
  const out = {
    run: { run_id: 'run_x', random_seed: 1, result_hash: 'a'.repeat(64) }, production_status: 'NON_PRODUCTION', claims: {}, data: { funds: 2, assets: 3, fundsSkipped: [{ fund: 'FUND:Z', missing: ['cash_ratio'] }] },
    retail_table: { disclaimer: 'not advice', rows: [{ key: 'k', label: 'Liquidity', status: 'INSUFFICIENT_OBSERVABILITY' }] },
    results: [{ engine: 'cascade', model_id: 'M10.cascade', status: 'INSUFFICIENT_OBSERVABILITY', calibration: 'UNCALIBRATED', coverage: null, unobserved: ['debt:F'], result_hash: 'h1', value: { lowerBound: true, rounds: [{ round: 0, sold: { A: 5 }, loss: { A: 2 } }], system: { totalLoss: 100, lossFractionOfNav: 0.01, reconciled: true, byWho: { direct: 90, selfImpact: 10, commonAsset: 0, counterparty: 0 }, byWhy: { direct: 90, liquidity: 10, redemption: 0, margin: 0, counterparty: 0 } } } }],
  };
  it('shows skipped funds with the missing field, the lower-bound warning, NON_PRODUCTION, and never a LOW_RISK label', () => {
    wrap(<ResultsPanel out={out} setError={() => {}} />);
    expect(screen.getByText(/FUND:Z: .*cash_ratio/)).toBeTruthy(); expect(document.body.textContent).toMatch(/Lower bound|Alt sınır/); expect(document.body.textContent).not.toMatch(/LOW_RISK/);
    expect(screen.getAllByText(/INSUFFICIENT_OBSERVABILITY/).length).toBeGreaterThan(0);
  });
});
