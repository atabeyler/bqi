// Small, self-consistent SYNTHETIC system used by the "Systemic" tab to demonstrate the Digital Twin stages. Not real data.
export const SYSTEMIC_SAMPLE = {
  seed: 1, engines: ['systemTwin'],
  systemic: {
    asOf: '2025-01-06T00:00:00Z',
    system: {
      assets: [{ id: 'EQ', price: 10, illiq: 2e-9 }], impact: { model: 'amihud-linear' },
      entities: [
        { id: 'B1', sector: 'BANK', cash: 1e7, holdings: [{ asset: 'EQ', shares: 2e6 }], externalAssets: 1e8, externalLiabilities: 1.8e7, funding: { runnable: 1.8e7, runoff: 0.8, stressRunoff: 0.9, confidenceThreshold: 0.05 } },
        { id: 'F1', sector: 'FUND', cash: 2e6, holdings: [{ asset: 'EQ', shares: 1e6 }], externalAssets: 0, externalLiabilities: 1.1e7, funding: { runnable: 5e6, runoff: 0.2, stressRunoff: 0.5, confidenceThreshold: 0.05 } },
        { id: 'HH', sector: 'HOUSEHOLD', cash: 1e6, externalAssets: 2e7, externalLiabilities: 0 },
      ],
      exposures: [{ creditor: 'HH', debtor: 'B1', amount: 1e8, kind: 'DEPOSIT' }],
    },
    scenario: { priceShocks: { EQ: 0.1 } },
    options: { uncertainty: { n: 4 } },
  },
};
