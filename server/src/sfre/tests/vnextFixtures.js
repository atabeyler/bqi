import { Rng } from '../core/prng.js';

/**
 * Coherent multi-sector SystemState used by the vNext tests. Values are in arbitrary currency units; every balance sheet
 * is built so that equity = `equityRatio` x assets (externalLiabilities is solved), i.e. the system is solvent before any shock.
 * Entirely SYNTHETIC: tests on it establish internal consistency, not real-world validity.
 */
const sumH = (e, prices) => (e.holdings || []).reduce((s, h) => s + h.shares * prices[h.asset], 0);

export function makeSystem(seed = 1, { equityRatio = 0.08, scale = 1 } = {}) {
  const r = new Rng(seed); const j = (x, s = 0.1) => x * (1 + s * (2 * r.next() - 1)) * scale;
  const assets = [
    { id: 'EQ1', price: 10, illiq: 2e-9, sigma: 0.02, advValue: 5e8, class: 'EQUITY' },
    { id: 'EQ2', price: 20, illiq: 3e-9, sigma: 0.025, advValue: 4e8, class: 'EQUITY' },
    { id: 'GB', price: 100, illiq: 2e-10, sigma: 0.005, advValue: 5e9, duration: 6, convexity: 50, class: 'GOVT_BOND' },
    { id: 'TB', price: 100, illiq: 1e-10, sigma: 0.002, advValue: 1e10, duration: 0.25, class: 'GOVT_BOND' },
  ];
  const prices = Object.fromEntries(assets.map((a) => [a.id, a.price]));
  const bank = (id, extra = {}) => ({ id, sector: 'BANK', cash: j(2e7), holdings: [{ asset: 'GB', shares: j(3e5), book: 'MARKET' }, { asset: 'GB', shares: j(2e5), book: 'HTM' }, { asset: 'EQ1', shares: j(1e5) }], externalAssets: j(2e8), externalLiabilities: 0,
    creditBook: [{ id: `${id}-corp`, amount: j(2e8), pd: 0.03, lgd: 0.45, riskSector: 'CORPORATE', debtToEbitda: 4 }, { id: `${id}-energy`, amount: j(5e7), pd: 0.04, lgd: 0.5, riskSector: 'ENERGY' }],
    bank: { rwa: j(6e8), minCapitalRatio: 0.08, corporateRwaShare: 0.6 }, funding: { runnable: 0, runoff: 0.04, stressRunoff: 0.15, confidenceThreshold: 0.04 }, ...extra });
  const entities = [bank('B1'), bank('B2'), bank('B3'),
    { id: 'F1', sector: 'FUND', cash: j(1e7), holdings: [{ asset: 'EQ1', shares: j(8e5) }, { asset: 'EQ2', shares: j(3e5) }], externalAssets: 0, externalLiabilities: 0, funding: { runnable: 0, runoff: 0.05, stressRunoff: 0.2, confidenceThreshold: 0.05 } },
    { id: 'F2', sector: 'FUND', cash: j(5e6), holdings: [{ asset: 'EQ1', shares: j(6e5) }, { asset: 'EQ2', shares: j(5e5) }, { asset: 'GB', shares: j(1e5) }], externalAssets: 0, externalLiabilities: 0, leverage: { debt: j(3e7), marginRatio: 0.2 }, funding: { runnable: 0, runoff: 0.05, stressRunoff: 0.2, confidenceThreshold: 0.05 } },
    { id: 'INS', sector: 'INSURER', cash: j(1e7), holdings: [{ asset: 'GB', shares: j(6e5), book: 'HTM' }, { asset: 'EQ2', shares: j(1e5) }], externalAssets: j(1e8), externalLiabilities: 0 },
    { id: 'C1', sector: 'CORPORATE', cash: j(1e7), externalAssets: j(1.5e8), externalLiabilities: 0, riskSector: 'ENERGY', corporate: { floatingDebt: j(5e7) } },
    { id: 'C2', sector: 'CORPORATE', cash: j(1e7), externalAssets: j(1.2e8), externalLiabilities: 0, riskSector: 'UTIL', corporate: { floatingDebt: j(4e7) } },
    { id: 'HH', sector: 'HOUSEHOLD', cash: j(2e7), externalAssets: j(5e8), externalLiabilities: 0 },
    { id: 'SOV', sector: 'SOVEREIGN', cash: j(5e7), externalAssets: j(9e8), externalLiabilities: 0 },
    { id: 'FI', sector: 'FOREIGN_INVESTOR', cash: j(1e7), holdings: [{ asset: 'EQ1', shares: j(1e6) }, { asset: 'EQ2', shares: j(4e5) }], externalAssets: 0, externalLiabilities: 0 },
    { id: 'CCP1', sector: 'CCP', cash: j(3e7), externalAssets: j(2e7), externalLiabilities: 0 },
    { id: 'PCF', sector: 'PRIVATE_CREDIT', cash: j(2e7), externalAssets: 0, externalLiabilities: 0,
      creditBook: Array.from({ length: 12 }, (_, i) => ({ id: `L${i}`, amount: j(2e7), pd: 0.04, lgd: 0.5, riskSector: 'CORPORATE', sponsor: `S${i % 4}` })) },
    { id: 'STB', sector: 'STABLECOIN', cash: j(5e7), holdings: [{ asset: 'TB', shares: j(4e5) }], externalAssets: 0, externalLiabilities: 0 },
    { id: 'DEFI', sector: 'DEFI', cash: j(1e7), externalAssets: j(2e7), externalLiabilities: 0 },
  ];
  const exposures = [
    { creditor: 'B1', debtor: 'B2', amount: j(3e7), kind: 'LOAN' }, { creditor: 'B2', debtor: 'B3', amount: j(2.5e7), kind: 'LOAN' }, { creditor: 'B3', debtor: 'B1', amount: j(2e7), kind: 'LOAN' },
    { creditor: 'B1', debtor: 'C1', amount: j(6e7), kind: 'LOAN', currency: 'FCY', fxHedged: 0 }, { creditor: 'B2', debtor: 'C1', amount: j(4e7), kind: 'LOAN' }, { creditor: 'B3', debtor: 'C2', amount: j(5e7), kind: 'LOAN' },
    { creditor: 'HH', debtor: 'B1', amount: j(1.2e8), kind: 'DEPOSIT' }, { creditor: 'HH', debtor: 'B2', amount: j(1.2e8), kind: 'DEPOSIT' }, { creditor: 'HH', debtor: 'B3', amount: j(1e8), kind: 'DEPOSIT' },
    { creditor: 'FI', debtor: 'B1', amount: j(5e7), kind: 'LOAN', currency: 'FCY', crossBorder: true, fxHedged: 0 },
    { creditor: 'B2', debtor: 'PCF', amount: j(6e7), kind: 'LOAN' },
    { creditor: 'STB', debtor: 'B3', amount: j(6e7), kind: 'DEPOSIT' },
    { creditor: 'F1', debtor: 'B2', amount: j(1e7), kind: 'DEPOSIT' },
  ];
  // solve externalLiabilities so that equity = equityRatio * assets (before shocks)
  const claims = (id) => exposures.filter((x) => x.creditor === id).reduce((s, x) => s + x.amount, 0);
  const debts = (id) => exposures.filter((x) => x.debtor === id).reduce((s, x) => s + x.amount, 0);
  for (const e of entities) {
    const a = e.cash + sumH(e, prices) + (e.externalAssets ?? 0) + (e.creditBook || []).reduce((s, c) => s + c.amount, 0) + claims(e.id);
    e.externalLiabilities = Math.max(0, a * (1 - equityRatio) - debts(e.id));
    if (e.funding) { e.funding.runnable = 0.5 * e.externalLiabilities; }
    if (e.leverage) e.leverage.debt = Math.min(e.leverage.debt, e.externalLiabilities * 0.5);
  }
  const byId = Object.fromEntries(entities.map((e) => [e.id, e]));
  // fx.entities lists NON-network FCY positions only: FCY loans that appear in `exposures` (B1->C1, FI->B1) are revalued through the edges and must not be repeated here
  const fx = {
    spot: 30, market: { Y: 1, sigma: 0.012, advValue: 3e8 }, official: { reserves: 4e8, swapLines: 1e8, usableShare: 0.5 },
    entities: {
      B1: { fcyAssets: j(3e7), fcyLiabilities: j(3e7), hedgedFraction: 0.5, fcyShortTermDebt: j(2e7), fcyLiquidAssets: j(1e7), rolloverRate: 0.8 },
      C1: { fcyAssets: j(1e7), fcyLiabilities: j(2e7), hedgedFraction: 0, fcyShortTermDebt: j(1e7), fcyLiquidAssets: j(5e6), rolloverRate: 0.7 },
      C2: { fcyAssets: 0, fcyLiabilities: j(3e7), hedgedFraction: 0.2, fcyShortTermDebt: j(1e7), fcyLiquidAssets: j(2e6), rolloverRate: 0.7 },
    }, pdSensitivity: 1.5,
  };
  const sovereign = { bondAsset: 'GB', debt: 1e9, gdp: 2e9, passThrough: 0.6, pdSensitivity: 0.8, creditCrunchPdSensitivity: 0.5, capitalCostSensitivity: 0.5, spreadPerDebtGdpPp: 5, backstopShare: 0.5, growthSensitivity: 0.3 };
  const collateral = {
    mporDays: 5, confidence: 0.99, haircuts: { GB: 0.05, EQ1: 0.2, EQ2: 0.25 }, eligibility: { CCP: ['GB', 'CASH'], BILATERAL: ['GB', 'CASH'], REPO: ['GB'] },
    nettingSets: [
      { id: 'NS-B1-CCP', party: 'B1', ccp: 'CCP1', positions: [{ asset: 'EQ1', exposure: j(3e7) }, { asset: 'EQ2', exposure: -j(1e7) }] },
      { id: 'NS-F2-CCP', party: 'F2', ccp: 'CCP1', positions: [{ asset: 'EQ2', exposure: j(2e7) }] },
      { id: 'NS-B2-B3', party: 'B2', counterparty: 'B3', positions: [{ asset: 'EQ1', exposure: j(2e7) }] },
    ],
    repo: [{ borrower: 'F1', lender: 'B3', collateralAsset: 'GB', collateralQty: j(8e4), cashBorrowed: j(7e6), haircut: 0.05 }],
    wwr: { B3: { pd: 0.02, rho: 0.4, lgd: 0.6 } },
  };
  const ccps = [{ id: 'CCP1', skinInTheGame: j(5e6), assessmentCap: 1, members: [
    { entity: 'B1', im: j(1.5e7), dfContribution: j(1e7), capital: j(3e7), positions: [{ asset: 'EQ1', exposure: j(3e7) }, { asset: 'EQ2', exposure: -j(1e7) }] },
    { entity: 'B2', im: j(8e6), dfContribution: j(8e6), capital: j(3e7), positions: [{ asset: 'EQ1', exposure: j(1e7) }] },
    { entity: 'F2', im: j(1e7), dfContribution: j(5e6), capital: j(1.5e7), positions: [{ asset: 'EQ2', exposure: j(2e7) }] },
  ] }];
  const privateCredit = { factor: { rhoGlobal: 0.2, rhoSponsor: 0.15 }, funds: [{ entity: 'PCF', facilityLimit: j(9e7), ltvCovenant: 0.5, unfundedCommitments: j(3e7), gateFraction: 0.05, investors: [{ investor: 'INS', stake: 0.3 }, { investor: 'B3', stake: 0.2 }] }] };
  const crowding = { signals: ['momentum', 'sentiment', 'macro'], agents: [
    { id: 'A1', capital: j(5e7), leverage: 3, modelId: 'M-A', dataVendors: ['V1'], loadings: { momentum: 1, sentiment: 0.5 }, assetWeights: { EQ1: 0.6, EQ2: 0.4 }, stopLoss: 0.05, deleverageFraction: 0.5 },
    { id: 'A2', capital: j(4e7), leverage: 3, modelId: 'M-A', dataVendors: ['V1'], loadings: { momentum: 0.9, sentiment: 0.6 }, assetWeights: { EQ1: 0.5, EQ2: 0.5 }, stopLoss: 0.05, deleverageFraction: 0.5 },
    { id: 'A3', capital: j(3e7), leverage: 2, modelId: 'M-B', dataVendors: ['V2'], loadings: { momentum: 0.2, macro: 1 }, assetWeights: { EQ1: 0.3, EQ2: 0.7 }, stopLoss: 0.08, deleverageFraction: 0.5 },
  ] };
  const opDeps = { horizonHours: 24, nodes: [{ id: 'CLOUD1', kind: 'CLOUD' }, { id: 'CLOUD2', kind: 'CLOUD' }, { id: 'PAY', kind: 'PAYMENT' }, { id: 'SETTLE', kind: 'SETTLEMENT' }, { id: 'N-B1', kind: 'INSTITUTION', entity: 'B1' }],
    dependencies: [{ consumer: 'PAY', provider: 'CLOUD1', criticality: 1, alternate: 'CLOUD2', rerouteShare: 0.5, failoverHours: 6 }, { consumer: 'SETTLE', provider: 'CLOUD1', criticality: 0.5 }, { consumer: 'N-B1', provider: 'CLOUD1', criticality: 0.3 }],
    flows: [{ payer: 'B1', payee: 'B2', valuePerDay: j(8e7), via: 'PAY' }, { payer: 'B2', payee: 'B3', valuePerDay: j(6e7), via: 'PAY' }, { payer: 'B3', payee: 'B1', valuePerDay: j(5e7), via: 'SETTLE' }, { payer: 'B1', payee: 'CCP1', valuePerDay: j(1e7), via: 'SETTLE', kind: 'MARGIN' }] };
  const climate = { sectors: { ENERGY: { emissionIntensity: 0.0004, ebitdaMargin: 0.25, physicalAssetShare: 0.5, natureDependency: { water: 0.3 } }, UTIL: { emissionIntensity: 0.0002, ebitdaMargin: 0.3, physicalAssetShare: 0.6, natureDependency: { water: 0.2 } } },
    assetSector: { EQ2: 'ENERGY' }, insurance: { ENERGY: { coverage: 0.4, insuredValue: j(2e8) }, UTIL: { coverage: 0.5, insuredValue: j(1e8) } }, insurers: { INS: { ENERGY: 0.6, UTIL: 0.6 } }, parameters: { valuationPassThrough: 1, pdSensitivity: 1.5 } };
  const digital = {
    stablecoins: [{ entity: 'STB', token: 'USDS', liquidationHaircut: { TB: 0.01 } }],
    pools: [{ id: 'P1', tokenA: 'ETH', tokenB: 'USD', reserveA: 1000, reserveB: 2e6, fee: 0.003 }, { id: 'P2', tokenA: 'ETH', tokenB: 'USD', reserveA: 500, reserveB: 1e6, fee: 0.003 }],
    lending: [{ id: 'L1', entity: 'DEFI', collateralToken: 'ETH', debtToken: 'USD', oraclePool: 'P1', liquidationThreshold: 0.8, liquidationPenalty: 0.05, closeFactor: 0.5, positions: [{ owner: 'a', collateral: 100, debt: 140000 }, { owner: 'b', collateral: 100, debt: 130000 }, { owner: 'c', collateral: 100, debt: 100000 }] }],
    venues: [{ token: 'ETH', pools: ['P1', 'P2'] }],
  };
  void byId;
  return { assets, impact: { model: 'amihud-linear' }, entities, exposures, fx, sovereign, collateral, ccps, privateCredit, crowding, opDeps, climate, digital };
}

export function fullScenario() {
  return {
    priceShocks: { EQ1: 0.08 },
    fx: { depreciation: 0.05, capitalFlow: { FI: 0.3 } },
    sovereign: { spreadShockBps: 250 },
    climate: { transition: { carbonPrice: 100, passThrough: 0.3, abatement: 0.1 }, physical: { damageRatio: { ENERGY: 0.05 } }, nature: { degradation: { water: 0.3 } } },
    privateCredit: { stressFactor: -2.2, redemptionFractions: { PCF: 0.15 }, unfundedDrawRate: 0.5, nSim: 1000, liquidationDiscount: 0.12 },
    digital: { stablecoinRedemptions: { STB: 0.5 }, poolShocks: { P1: 0.12 }, fragmentationSell: { ETH: 50 }, oracleDeviation: { L1: -0.03 } },
    opDeps: { outages: [{ node: 'CLOUD1', durationHours: 8 }] },
    crowding: { responseScale: 1, signalShocks: { momentum: -0.4, sentiment: -0.3 } },
    collateral: { volMultiplier: 1.8, haircutAdd: { GB: 0.03 } },
    ccp: {},
  };
}

// ---- independent Python reference bridge (stdlib only)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REF_SYS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sfre/crosscheck/reference_systemic.py');
export const pySys = (op, args) => {
  const r = spawnSync(process.env.PYTHON_BIN || 'python3', [REF_SYS], { input: JSON.stringify({ op, args }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python reference failed: ${r.stderr}`);
  return JSON.parse(r.stdout).result;
};

/** Minimal solvent entity for hand-computable tests. */
export const ent = (id, sector = 'BANK', over = {}) => ({ id, sector, cash: 0, externalAssets: 0, externalLiabilities: 0, ...over });
