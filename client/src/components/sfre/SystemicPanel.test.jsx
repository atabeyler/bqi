import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SystemicPanel from './SystemicPanel.jsx';
import { SYSTEMIC_SAMPLE } from './systemicSample.js';
import { LangProvider } from '../../services/langContext.jsx';

const STAGES = ['STATE(t0)', 'SHOCK', 'BALANCE_SHEET_EFFECT', 'FUNDING_LIQUIDITY', 'MARGIN_COLLATERAL', 'FORCED_ACTION', 'MARKET_IMPACT', 'COUNTERPARTY_NETWORK_CONTAGION', 'SECOND_ROUND', 'STATE(t+n)'];
const run = vi.fn(async () => ({ results: [{ model_id: 'M71.system_twin', status: 'INSUFFICIENT_OBSERVABILITY', calibration: 'UNCALIBRATED', unobserved: ['funding:HH'], value: { system: { systemLoss: 1234.5, defaults: 1 }, rounds: 3, stages: STAGES.map((stage) => ({ stage })), reconciliation: { reconciled: true }, channels: { marketImpact: 12.5, exogenousPriceShocks: 100 }, dataflow: [{ from: 'M61.fx', to: 'funding stage', field: 'entityFcyGap' }] } }] }));
vi.mock('../../services/api.js', () => ({ sfreApi: { capabilities: async () => ({ capabilities: [{ engine: 'systemTwin', title: 'Financial System Digital Twin', summary: 's', models: [{ model_id: 'M71.system_twin', state: 'DEVELOPMENT' }], needs: ['system'], assumptions: ['a1'], limitations: ['UNCALIBRATED scenario model'] }] }), run: (...a) => run(...a) } }));

describe('SystemicPanel', () => {
  it('lists capabilities with their assumptions/limitations and the NON-PRODUCTION label; runs the twin and shows every stage, the ledger and unobserved inputs', async () => {
    render(<LangProvider><SystemicPanel setError={() => {}} /></LangProvider>);
    await waitFor(() => expect(screen.getByText(/Finansal Sistem Dijital İkizi|Financial System Digital Twin/)).toBeTruthy());
    expect(document.body.textContent).toMatch(/NON-PRODUCTION|ÜRETİM DIŞI/); expect(screen.getByText('UNCALIBRATED scenario model')).toBeTruthy(); expect(screen.getByText(/M71.system_twin \(DEVELOPMENT\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('sfre-twin-result')).toBeTruthy());
    expect(run).toHaveBeenCalledWith(SYSTEMIC_SAMPLE);
    for (const s of STAGES) expect(screen.getAllByText(s).length).toBeGreaterThan(0);
    expect(document.body.textContent).toMatch(/funding:HH/); expect(document.body.textContent).toMatch(/entityFcyGap/); expect(document.body.textContent).not.toMatch(/LOW_RISK/);
  });
  it('the sample request is a systemic request for the twin only', () => { expect(SYSTEMIC_SAMPLE.engines).toEqual(['systemTwin']); expect(SYSTEMIC_SAMPLE.systemic.asOf).toMatch(/Z$/); });
});
