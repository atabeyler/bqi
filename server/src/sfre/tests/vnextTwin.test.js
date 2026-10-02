import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { runSystemTwin, validateTwin, STAGES, activeModules } from '../engines/systemic/twin.js';
import { FinancialDigitalTwin, FinancialSystemDigitalTwin } from '../engines/digitalTwin.js';
import { runCascade } from '../engines/cascade.js';
import { computeRun, runPipeline, validateRequest, ENGINE_NAMES } from '../pipeline.js';
import { EvidenceLedger } from '../evidence/ledger.js';
import { createDefaultRegistry, SFRE_MODELS } from '../governance/modelRegistry.js';
import { CAPABILITIES, capabilityGaps } from '../capabilities.js';
import { hashOf } from '../core/canonical.js';
import { Rng } from '../core/prng.js';
import { makeSystem, fullScenario, ent } from './vnextFixtures.js';
import { market, base, spoofEpisodes, ASOF } from './vnextSurvFixtures.js';

vi.mock('../../lib/blockedUserCache.js', () => ({ isUserBlocked: async () => false }));
const { createSfreRouter } = await import('../../routes/sfre.js');
const { JWT_SECRET } = await import('../../lib/jwtSecret.js');
const token = (role, userCode = 'U1') => jwt.sign({ userCode, role }, JWT_SECRET);

const T = { uncertainty: { n: 2 } };
const twin = (sys, sc, o = {}, f = null) => runSystemTwin(sys, sc, { seed: 1, ...T, ...o }, f);

describe('M71 Financial System Digital Twin: structure and accounting', () => {
  it('STRUCTURE: all ten stages in the prescribed order; trajectory STATE(t0) -> STATE(t+n); dataflow documented', () => {
    const r = twin(makeSystem(1), fullScenario()); expect(r.value.stages.map((s) => s.stage)).toEqual([...STAGES]); expect(r.value.trajectory[0].label).toBe('STATE(t0)'); expect(r.value.trajectory.at(-1).label).toBe('STATE(t+n)');
    expect([...r.value.activeModules].sort()).toEqual(['ccp', 'climate', 'collateral', 'crowding', 'digital', 'fx', 'nexus', 'opDeps', 'privateCredit']); expect(r.value.dataflow.length).toBeGreaterThan(8); expect(r.value.models.nexus).toBe('M62.sovereign_bank_corporate');
    expect(r.status).toMatch(/UNCALIBRATED|INSUFFICIENT_OBSERVABILITY/); expect(r.calibration).toBe('UNCALIBRATED'); expect(r.uncertainty.method).toBe('LATIN_HYPERCUBE_ASSUMPTION_BAND');
  });
  it('INVARIANT: the loss ledger reconciles exactly (value conservation) for random systems and random module subsets', () => {
    const keys = ['fx', 'sovereign', 'climate', 'privateCredit', 'digital', 'opDeps', 'crowding', 'collateral', 'ccp'];
    for (let seed = 1; seed <= 16; seed++) {
      const r = new Rng(seed * 13); const sys = makeSystem(seed, { equityRatio: 0.03 + 0.1 * r.next() }); const full = fullScenario(); const sc = { priceShocks: { EQ1: 0.25 * r.next() } };
      for (const k of keys) if (r.next() < 0.55) sc[k] = full[k]; if (r.next() < 0.3) { sc.externalShocks = { C1: 0.2 }; sc.sectorShocks = { CORPORATE: 0.1 }; }
      const t = twin(sys, sc); expect(t.value, `seed ${seed}: ${t.error}`).not.toBeNull(); expect(t.value.reconciliation.reconciled, `seed ${seed} ${JSON.stringify(t.value.reconciliation)}`).toBe(true);
      expect(Math.abs(t.value.reconciliation.residual)).toBeLessThanOrEqual(t.value.reconciliation.tolerance); expect(t.status).not.toBe('COMPUTATION_FAILED');
      expect(Object.values(t.value.channels).every(Number.isFinite)).toBe(true); expect(t.value.system.reconciled).toBe(true);
      for (const x of t.value.entities) if (!x.indeterminate) { expect(x.equityFinal).toBeGreaterThanOrEqual(-1e-6); expect(x.liquidityUnmet).toBeGreaterThanOrEqual(0); }
    }
  }, 120000);
  it('PROPERTY: with price shocks only, system loss is monotone in the shock and zero shock gives zero loss (solvent system)', () => {
    for (let seed = 1; seed <= 8; seed++) { const sys = makeSystem(seed, { equityRatio: 0.06 }); let prev = -1; for (const k of [0, 0.05, 0.1, 0.2, 0.35]) { const r = twin(sys, { priceShocks: { EQ1: k, EQ2: k } }); expect(r.value.system.systemLoss, `seed ${seed} k ${k}`).toBeGreaterThanOrEqual(prev - 1e-6); prev = r.value.system.systemLoss; if (k === 0) expect(prev).toBeCloseTo(0, 5); } }
  });
  it('DETERMINISTIC and non-mutating: identical result hash, input untouched', () => {
    const s = makeSystem(2); const h = hashOf(s); const sc = fullScenario(); const a = twin(s, sc); const b = twin(s, sc); expect(a.result_hash).toBe(b.result_hash); expect(hashOf(s)).toBe(h); expect(twin(s, sc, { seed: 9 }).uncertainty.seed).toBe(9); expect(a.input_hashes[0]).toBe(h);
  });
  it('CONVERGENCE is reported honestly: maxRounds=1 with ongoing forced selling -> MODEL_UNCERTAIN, not a silent truncation', () => {
    const s = makeSystem(1, { equityRatio: 0.04 }); const sc = { priceShocks: { EQ1: 0.3, EQ2: 0.3 }, fx: fullScenario().fx, collateral: { volMultiplier: 2 } };
    const full = twin(s, sc); const cut = twin(s, sc, { maxRounds: 1 }); expect(full.value.stages[8].converged).toBe(true); if (full.value.rounds > 1) expect(cut.status).toBe('MODEL_UNCERTAIN');
  });
});

describe('M71: engine outputs feed other engines (data flow, not parallel silos)', () => {
  it('climate losses on banks enlarge the sovereign-bank loop (nexus sees them as pre-applied losses)', () => {
    const s = makeSystem(1, { equityRatio: 0.045 }); const sov = { sovereign: { spreadShockBps: 250 } };
    const a = twin(s, sov); const b = twin(s, { ...sov, climate: { transition: { carbonPrice: 400, passThrough: 0.1, abatement: 0 }, physical: { damageRatio: { ENERGY: 0.3 } } } });
    const na = a.value.stages[1].modules.find((m) => m.module.startsWith('M62')); const nb = b.value.stages[1].modules.find((m) => m.module.startsWith('M62'));
    expect(nb.spreadBpsFinal).toBeGreaterThan(na.spreadBpsFinal); expect(b.value.dataflow.some((d) => d.to === 'M62.nexus')).toBe(true);
  });
  it('a sovereign-bond shock alone (no explicit price shock) produces variation-margin calls on bond-referencing netting sets', () => {
    const s = makeSystem(2); s.collateral.nettingSets.push({ id: 'NS-B3-GB', party: 'B3', ccp: 'CCP1', positions: [{ asset: 'GB', exposure: 8e7 }] });
    const r = twin(s, { sovereign: { spreadShockBps: 400 }, collateral: {}, ccp: {} }); const m = r.value.stages[4].perRound[0]; expect(m.called).toBeGreaterThan(0);
    const none = twin(s, { collateral: {}, ccp: {} }); expect(none.value.stages[4].perRound[0].called).toBeCloseTo(0, 6);
  });
  it('FX roll-over gaps -> funding stage -> forced sales -> market impact -> lower prices (second round priced in)', () => {
    const s = makeSystem(1); s.entities[0].cash = 0; s.entities[1].cash = 0; const sc = { fx: { depreciation: 0.0, rolloverRates: { B1: 0, C1: 0, C2: 0 } } };
    const r = twin(s, sc); expect(r.value.stages[3].perRound[0].totalNeed).toBeGreaterThan(0); expect(r.value.stages[5].totalSold).toBeGreaterThan(0); expect(Object.keys(r.value.stages[6].finalPriceDeclines).length).toBeGreaterThan(0);
    expect(r.value.dataflow.some((d) => d.field === 'entityFcyGap')).toBe(true);
  });
  it('CCP charges from a defaulted member reduce survivors\' equity compared with a run without the CCP module', () => {
    const s = makeSystem(3, { equityRatio: 0.2 }); s.ccps[0].skinInTheGame = 1e5; s.ccps[0].members[0].im = 1e5; s.ccps[0].members[0].dfContribution = 1e5; const base0 = { priceShocks: { EQ1: 0.08, EQ2: 0.08 } }; const a = twin(s, { ...base0 }); const b = twin(s, { ...base0, ccp: { defaulters: ['B1'] } });
    const eq = (r, id) => r.value.entities.find((e) => e.id === id).equityFinal; expect(eq(b, 'B2') + eq(b, 'F2')).toBeLessThan(eq(a, 'B2') + eq(a, 'F2')); expect(b.value.channels.ccpCharges).toBeGreaterThan(0);
  });
  it('crowding: stop-loss deleveraging adds sell flows in later rounds, lowering prices below the first-round move', () => {
    const s = makeSystem(2); s.crowding.agents.forEach((a) => { a.stopLoss = 0.0005; }); const r = twin(s, { crowding: { responseScale: 1, signalShocks: { momentum: -0.6, sentiment: -0.4 } } });
    const rounds = r.value.stages[6].perRound; expect(rounds[0].sellers.external).toBeGreaterThan(0); expect(rounds.length).toBeGreaterThan(1); expect(rounds[1].sellers.crowding).toBeGreaterThan(0); expect(r.value.stages[6].finalPriceDeclines.EQ1).toBeGreaterThan(rounds[0].priceDeclines.EQ1);
  });
  it('digital: stablecoin reserve sales execute on the live holdings of the issuer and hit the shared price vector', () => {
    const r = twin(makeSystem(1), { digital: { stablecoinRedemptions: { STB: 0.9 } } }); expect(r.value.stages[6].perRound[0].salesByAsset.TB).toBeGreaterThan(0); expect(r.value.stages[6].finalPriceDeclines.TB).toBeGreaterThan(0); expect(r.value.channels['assets:digital']).toBeDefined();
  });
  it('operational outage -> liquidity gap -> funding stage need (entities with little cash must sell)', () => {
    const s = makeSystem(1); s.entities[0].cash = 0; s.entities[1].cash = 0; s.entities[2].cash = 0; const r = twin(s, { opDeps: { outages: [{ node: 'CLOUD1', durationHours: 24 }] } });
    expect(r.value.stages[3].perRound[0].totalNeed).toBeGreaterThan(0); expect(r.value.dataflow.some((d) => d.from === 'M67.operational')).toBe(true);
  });
  it('the existing fund cascade (M10) keeps running inside the twin: with no other sellers prices equal the standalone cascade', () => {
    const fund = { assets: [{ id: 'A', price: 10, illiq: 2e-8 }], impact: { model: 'amihud-linear' }, funds: [{ id: 'FX1', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }], claims: [] }, { id: 'FX2', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'A', shares: 2e6 }], claims: [] }] };
    const sys = { assets: [{ id: 'A', price: 10, illiq: 2e-8 }], impact: { model: 'amihud-linear' }, entities: [ent('H', 'HOUSEHOLD', { cash: 5, externalAssets: 10 })], exposures: [] };
    const sc = { priceShocks: { A: 0.1 }, redemptions: { FX1: 3e6 } }; const ref = runCascade(fund, sc);
    const r = runSystemTwin(sys, sc, { seed: 1, uncertainty: { n: 2 } }, fund); expect(r.value.finalPrices.A).toBeCloseTo(ref.value.finalPrices.A, 12); expect(r.value.fundCascade.totalLoss).toBeCloseTo(ref.value.system.totalLoss, 6);     expect(r.input_hashes.length).toBe(2); expect(r.value.channels.fundCascadePriceEffect).toBeDefined(); expect(r.value.reconciliation.reconciled).toBe(true);
  });
});

describe('M71: missing data, validation and class contract', () => {
  it('MISSING DATA: unobserved balance-sheet items / funding / impact inputs are flagged; status is never LOW_RISK; bounds are declared', () => {
    const s = makeSystem(1); s.entities[0].externalAssets = null; s.entities[1].funding.runnable = null; s.assets[0].illiq = null; const r = twin(s, { priceShocks: { EQ1: 0.2 }, fx: { depreciation: 0.1, rolloverRates: { B1: 0 } } });
    expect(r.unobserved).toContain('externalAssets:B1'); expect(r.unobserved).toContain('funding:B2'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.value.lowerBound).toBe(true); expect(r.status).not.toBe('LOW_RISK'); expect(r.coverage.fraction).toBeLessThan(1);
    const s2 = makeSystem(1); s2.entities[2].cash = 0; s2.entities[2].holdings = [{ asset: 'EQ1', shares: 1e5 }]; s2.assets[0].illiq = null; const r2 = twin(s2, { fx: { rolloverRates: { B1: 0, C1: 0, C2: 0 } } }); expect(r2.unobserved.some((x) => x.startsWith('impact_inputs'))).toBe(true);
  });
  it('FAILS LOUDLY: unknown/mis-wired scenario keys, invalid shocks, missing impact model, invalid options, colliding fund ids', () => {
    const s = makeSystem(1); expect(runSystemTwin(s, { priceShock: { EQ1: 0.1 } }, {}).error).toMatch(/unknown scenario key/);
    const t = makeSystem(1); delete t.fx; expect(runSystemTwin(t, { fx: { depreciation: 0.1 } }, {}).error).toMatch(/system.fx is missing/);
    expect(runSystemTwin(s, { priceShocks: { EQ1: 1.5 } }, {}).status).toBe('COMPUTATION_FAILED'); expect(runSystemTwin(s, { externalShocks: { ZZ: 0.1 } }, {}).error).toMatch(/unknown entity/);
    const u = makeSystem(1); delete u.impact; expect(runSystemTwin(u, {}, {}).error).toMatch(/impact/); expect(runSystemTwin(s, {}, { maxRounds: 0 }).error).toMatch(/maxRounds/); expect(runSystemTwin(s, {}, { maxRounds: 500 }).status).toBe('COMPUTATION_FAILED');
    const fund = { assets: [{ id: 'EQ1', price: 10, illiq: 1e-9 }], impact: { model: 'amihud-linear' }, funds: [{ id: 'B1', cash: 1, debt: 0, marginRatio: null, beta: null, holdings: [], claims: [] }] }; expect(runSystemTwin(s, {}, {}, fund).error).toMatch(/collides/);
    const w = makeSystem(1); w.funding = 1; const bad = makeSystem(1); bad.entities[0].funding.runoff = 2; expect(validateTwin(bad, {})).toMatch(/runoff/); expect(validateTwin(w, {})).toBeNull();
    expect(activeModules(s, { fx: {}, collateral: {} })).toEqual(['fx', 'collateral']);
  });
  it('CLASS CONTRACT: FinancialSystemDigitalTwin extends the existing twin, keeps its fund-level run() unchanged, freezes and re-hashes the snapshot', () => {
    const fund = { assets: [{ id: 'EQ1', price: 10, illiq: 2e-9 }], impact: { model: 'amihud-linear' }, funds: [{ id: 'F', cash: 1e6, debt: 0, marginRatio: null, beta: null, holdings: [{ asset: 'EQ1', shares: 2e6 }] }] };
    const sys = makeSystem(2); const t = new FinancialSystemDigitalTwin({ system: sys, fundSystem: fund }); expect(t).toBeInstanceOf(FinancialDigitalTwin);
    const a = t.run({ redemptions: { F: 3e6 } }); const b = new FinancialDigitalTwin(fund).run({ redemptions: { F: 3e6 } }); expect(a.result.result_hash).toBe(b.result.result_hash); expect(a.stages.map((x) => x.stage)).toEqual(b.stages.map((x) => x.stage));
    const out = t.runSystem(fullScenario(), { seed: 1 }); expect(out.stages.length).toBe(10); expect(out.reconciliation.reconciled).toBe(true); expect(t.assertSnapshotUnchanged()).toBe(true); expect(t.systemSnapshotHash).toBe(hashOf(sys));
    expect(() => { 'use strict'; t.systemState.entities[0].cash = 1; }).toThrow(); expect(() => t.runSystem({ priceShock: {} })).toThrow(/unknown scenario key/);
  });
});

describe('vNext pipeline, governance, ledger and API integration', () => {
  const sysReq = (over = {}) => ({ seed: 7, engines: ['crossSector', 'fxContagion', 'sovNexus', 'collateral', 'ccp', 'privateCredit', 'aiCrowding', 'opContagion', 'climate', 'digitalAssets', 'systemTwin'], systemic: { asOf: '2025-03-01T00:00:00Z', system: makeSystem(1), scenario: fullScenario(), options: { uncertainty: { n: 2 } } }, ...over });
  it('computeRun executes every new engine, labels outputs NON_PRODUCTION, binds claims to the evidence ledger and is reproducible', () => {
    const ledger = new EvidenceLedger({ clock: () => '2025-01-01T00:00:00Z' }); const registry = createDefaultRegistry(); const clock = () => '2025-01-01T00:00:00Z';
    const out = runPipeline(sysReq(), { ledger, registry, clock }); expect(out.results.length).toBe(11); expect(out.production_status).toBe('NON_PRODUCTION'); expect(out.non_production_models).toEqual(expect.arrayContaining(['M71.system_twin', 'M60.cross_sector', 'M69.digital_assets']));
    expect(out.results.every((r) => r.status !== 'LOW_RISK' && r.calibration === 'UNCALIBRATED')).toBe(true); const tw = out.results.find((r) => r.model_id === 'M71.system_twin'); const ex = ledger.explain(out.claims[tw.result_hash]); expect(ex.chain_valid).toBe(true); expect(ex.path.map((n) => n.kind)).toEqual(expect.arrayContaining(['CLAIM', 'ENGINE_RUN', 'MODEL', 'PARAMETERS', 'INPUT']));
    expect(out.run.parameters ?? out.run).toBeTruthy(); const again = computeRun(sysReq(), { registryStates: null, clock }); const again2 = computeRun(sysReq(), { registryStates: null, clock }); expect(again.run.result_hash).toBe(again2.run.result_hash);
  });
  it('surveillance and the twin run last; surveillance corroborates M50/M51/M52/M20 results of the same run', () => {
    const m = market(2); const out = computeRun({ seed: 3, engines: ['surveillance', 'systemTwin', 'crossSector'], systemic: sysReq().systemic, surveillance: base(m, spoofEpisodes('P7', 9)) }, { clock: () => '2025-01-01T00:00:00Z' });
    expect(out.results[0].engine).toBe('crossSector'); expect(out.results.at(-1).model_id).toBe('M70.surveillance_summary'); expect(out.results.find((r) => r.model_id === 'M70.spoofing').status).toBe('SIGNAL');
  });
  it('request validation: systemic/surveillance PIT guards, size and schema', () => {
    expect(validateRequest(sysReq({ systemic: { system: makeSystem(1) } }))).toMatch(/asOf/); expect(validateRequest(sysReq({ asOf: '2026-01-01T00:00:00Z', observations: [] }))).toBeNull();
    expect(validateRequest(sysReq({ asOf: '2024-01-01T00:00:00Z' }))).toMatch(/look-ahead guard: systemic.asOf/);
    expect(validateRequest(sysReq({ asOf: '2024-01-01T00:00:00Z', observations: [{ entity: 'x', field: 'y', value: 1, unit: null, event_time: '2024-01-01T00:00:00Z', published_time: '2024-01-01T00:00:00Z', available_time: '2024-01-01T00:00:00Z', ingested_time: '2024-01-01T00:00:00Z', source: 's', revision: 0, quality_flags: [] }] }))).toMatch(/look-ahead guard: systemic.asOf/);
    const bad = sysReq(); bad.systemic.system.entities[0].sector = 'NOPE'; expect(validateRequest(bad)).toMatch(/systemic.system/); expect(validateRequest({ seed: 1, engines: ['surveillance'], surveillance: { asOf: ASOF, events: [] } })).toMatch(/surveillance/);
    expect(validateRequest({ seed: 1, engines: ['systemTwin'] })).toBeNull(); const out = computeRun({ seed: 1, engines: ['systemTwin'] }, {}); expect(out.results[0].status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(ENGINE_NAMES).toEqual(expect.arrayContaining(['crossSector', 'systemTwin', 'surveillance']));
    expect(validateRequest({ seed: 1, engines: ['surveillance'], surveillance: { ...base(market(2)), asOf: new Date(Date.parse(ASOF) + 1).toISOString() }, asOf: '2000-01-01T00:00:00Z' })).toMatch(/look-ahead/);
  });
  it('model registry: every vNext model is registered at DEVELOPMENT/UNCALIBRATED with a spec reference; capabilities cover every new engine and model', () => {
    const reg = createDefaultRegistry(); for (const id of SFRE_MODELS.filter((x) => /^M(6\d|7\d)\./.test(x))) { const m = reg.get(id, '1.0.0'); expect(m.state).toBe('DEVELOPMENT'); expect(m.calibration).toBe('UNCALIBRATED'); expect(m.spec_ref).toContain('VNEXT_SYSTEMIC.md'); }
    expect(capabilityGaps()).toEqual([]); const covered = new Set(CAPABILITIES.flatMap((c) => c.models)); for (const id of SFRE_MODELS.filter((x) => /^M(6\d|7\d)\./.test(x))) expect(covered.has(id), id).toBe(true);
    expect(CAPABILITIES.every((c) => c.limitations.length > 0 && c.assumptions.length > 0)).toBe(true);
  });
  it('API: GET /capabilities (RBAC-protected) and POST /runs with the twin through the worker path', async () => {
    const a = express(); a.use(express.json({ limit: '10mb' })); a.use('/api/sfre', createSfreRouter()); const analyst = { Authorization: `Bearer ${token('analyst')}` };
    expect((await request(a).get('/api/sfre/capabilities')).status).toBe(401);
    const c = await request(a).get('/api/sfre/capabilities').set(analyst); expect(c.status).toBe(200); expect(c.body.capabilities.length).toBe(CAPABILITIES.length); expect(c.body.capabilities.flatMap((x) => x.models).every((m) => m.state === 'DEVELOPMENT' && m.production === false)).toBe(true); expect(c.body.note).toMatch(/UNCALIBRATED/);
    const r = await request(a).post('/api/sfre/runs').set(analyst).send(sysReq({ engines: ['systemTwin', 'crossSector'] })); expect(r.status).toBe(201); expect(r.body.production_status).toBe('NON_PRODUCTION'); const tw = r.body.results.find((x) => x.model_id === 'M71.system_twin'); expect(tw.value.reconciliation.reconciled).toBe(true);
    const ex = await request(a).get(`/api/sfre/claims/${r.body.claims[tw.result_hash]}/explain`).set(analyst); expect(ex.status).toBe(200); expect(ex.body.chain_valid).toBe(true);
    const bad = await request(a).post('/api/sfre/runs').set(analyst).send(sysReq({ systemic: { asOf: 'nope', system: makeSystem(1) } })); expect(bad.status).toBe(400);
    const viewer = await request(a).post('/api/sfre/runs').set({ Authorization: `Bearer ${token('viewer')}` }).send(sysReq()); expect(viewer.status).toBe(403);
  }, 60000);
});
