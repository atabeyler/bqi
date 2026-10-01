import { describe, it, expect, vi } from 'vitest';
import { EvidenceLedger } from '../evidence/ledger.js';
import { ModelRegistry, GovernanceError, createDefaultRegistry, SFRE_MODELS } from '../governance/modelRegistry.js';
import { createRunRecord } from '../governance/runRegistry.js';
import { explainResults, validateNarrative, renderDeterministic, unwrapForAI } from '../ai/firewall.js';
import { buildRetailRiskTable, DIMENSIONS } from '../alerts/retailRiskTable.js';
import { ResearchRegistry, corroborate } from '../research/registry.js';
import { JsonFeedProvider, DuckDuckGoProvider, defaultProviders } from '../research/providers.js';
import { makeEvidenceDoc } from '../research/provider.js';
import { makeResult, STATUS, coverageOf } from '../core/result.js';
import { hhi } from '../engines/concentration.js';
import { MemoryStore, JsonlFileStore } from '../storage/store.js';
import { runPipeline, validateRequest } from '../pipeline.js';
import { randomSystem } from './helpers.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const H = 'a'.repeat(64);
const res = (o = {}) => makeResult({ engine: 'cascade', modelId: 'M10.cascade', status: STATUS.UNCALIBRATED, value: { totalLoss: 1234.5, lossFraction: 0.0812 }, coverage: coverageOf(3, 4), unobserved: ['debt:F3'], parameters: { p: 1 }, ...o });

describe('evidence ledger', () => {
  const clock = () => '2026-01-01T00:00:00Z';
  it('binds CLAIM -> ENGINE_RUN -> MODEL -> PARAMETERS -> INPUT -> SOURCE and explains from the graph', () => {
    const l = new EvidenceLedger({ clock }); const r = res({ inputHashes: ['h1'] });
    const id = l.recordClaim({ claim: 'contagion', result: r, snapshot: { snapshot_id: 's', content_hash: 'c', asOf: '2026-01-01T00:00:00Z', count: 3 }, sources: [{ source: 'official:kap', url: 'https://x', publication_time: '2026-01-01T00:00:00Z', retrieval_time: '2026-01-02T00:00:00Z', hash: 'abc' }] });
    const ex = l.explain(id);
    expect(ex.path.map((n) => n.kind)).toEqual(expect.arrayContaining(['CLAIM', 'ENGINE_RUN', 'MODEL', 'PARAMETERS', 'INPUT', 'SOURCE']));
    expect(ex.path.find((n) => n.kind === 'MODEL').payload.model_id).toBe('M10.cascade'); expect(ex.path.find((n) => n.kind === 'PARAMETERS').payload.parameter_hash).toBe(r.parameter_hash);
    expect(ex.chain_valid).toBe(true); expect(ex.result_hash).toBe(r.result_hash);
  });
  it('detects tampering anywhere in the chain; import re-verifies', () => {
    const l = new EvidenceLedger({ clock }); l.recordClaim({ claim: 'a', result: res() }); l.recordClaim({ claim: 'b', result: res({ value: { totalLoss: 1 } }) });
    expect(l.verify().ok).toBe(true);
    const exp = l.export(); exp[1].payload = { ...exp[1].payload, tampered: true };
    expect(() => EvidenceLedger.import(exp)).toThrow(/failed verification/);
    expect(EvidenceLedger.import(l.export()).verify().ok).toBe(true);
  });
  it('is content-addressed: recording the same result twice does not duplicate nodes; unknown claim -> null', () => {
    const l = new EvidenceLedger({ clock }); const a = l.recordClaim({ claim: 'a', result: res() }); const n = l.length; const b = l.recordClaim({ claim: 'a', result: res() });
    expect(a).toBe(b); expect(l.length).toBe(n); expect(l.explain('claim_nope')).toBeNull();
  });
});

describe('model governance', () => {
  const mk = () => { const r = new ModelRegistry(); r.register({ model_id: 'M', version: '1', spec_ref: 'spec', proposed_by: 'dev' }); return r; };
  const toShadow = (r) => { r.transition('M', '1', 'VALIDATION', { actor: { id: 'dev', kind: 'human' }, evidence: { spec_ref: 's' } }); r.transition('M', '1', 'SHADOW', { actor: { id: 'val', kind: 'human' }, evidence: { validation_report_hash: H, validation_data_kind: 'REAL' } }); };
  it('everything starts at DEVELOPMENT; there is no auto-promotion and edges are enforced', () => {
    const r = createDefaultRegistry(); expect(r.list().every((m) => m.state === 'DEVELOPMENT' && m.calibration === 'UNCALIBRATED')).toBe(true); expect(r.list()).toHaveLength(SFRE_MODELS.length);
    const x = mk(); expect(() => x.transition('M', '1', 'APPROVED', { actor: { id: 'boss', kind: 'human' }, evidence: {} })).toThrow(/not allowed/);
    expect(() => x.transition('M', '1', 'VALIDATION', { actor: { id: 'dev', kind: 'human' }, evidence: {} })).toThrow(/spec_ref/);
  });
  it('SYNTHETIC-only validation cannot advance a model to SHADOW', () => {
    const r = mk(); r.transition('M', '1', 'VALIDATION', { actor: { id: 'dev', kind: 'human' }, evidence: { spec_ref: 's' } });
    expect(() => r.transition('M', '1', 'SHADOW', { actor: { id: 'val', kind: 'human' }, evidence: { validation_report_hash: H, validation_data_kind: 'SYNTHETIC' } })).toThrow(/SYNTHETIC/);
    expect(() => r.transition('M', '1', 'SHADOW', { actor: { id: 'val', kind: 'human' }, evidence: { validation_report_hash: 'short', validation_data_kind: 'REAL' } })).toThrow(/validation_report_hash/);
  });
  it('APPROVED needs a distinct HUMAN approver; system actors cannot approve; ALARMING needs calibration evidence', () => {
    const r = mk(); toShadow(r);
    const ev = { shadow_report_hash: H, approved_use: 'SCENARIO_ANALYSIS' };
    expect(() => r.transition('M', '1', 'APPROVED', { actor: { id: 'ci-bot', kind: 'system' }, evidence: ev })).toThrow(/human/);
    expect(() => r.transition('M', '1', 'APPROVED', { actor: { id: 'dev', kind: 'human' }, evidence: ev })).toThrow(/differ/);
    expect(() => r.transition('M', '1', 'APPROVED', { actor: { id: 'val', kind: 'human' }, evidence: ev })).toThrow(/differ/);
    expect(() => r.transition('M', '1', 'APPROVED', { actor: { id: 'boss', kind: 'human' }, evidence: { shadow_report_hash: H, approved_use: 'ALARMING', positive_events: 5 } })).toThrow(/ALARMING/);
    const ok = r.transition('M', '1', 'APPROVED', { actor: { id: 'boss', kind: 'human' }, evidence: ev });
    expect(ok.state).toBe('APPROVED'); expect(ok.calibration).toBe('UNCALIBRATED'); expect(r.isProductionUse('M', '1', 'SCENARIO_ANALYSIS')).toBe(true); expect(r.isProductionUse('M', '1', 'ALARMING')).toBe(false);
  });
  it('CALIBRATED is assignable only via ALARMING approval with full evidence; leaving APPROVED revokes it; history is hash-chained', () => {
    const r = mk(); toShadow(r);
    const ok = r.transition('M', '1', 'APPROVED', { actor: { id: 'boss', kind: 'human' }, evidence: { shadow_report_hash: H, approved_use: 'ALARMING', calibration_report_hash: H, positive_events: 31, negative_control_passed: true, locked_holdout_evaluated_once: true } });
    expect(ok.calibration).toBe('CALIBRATED');
    const back = r.transition('M', '1', 'SHADOW', { actor: { id: 'boss', kind: 'human' }, evidence: { validation_report_hash: H, validation_data_kind: 'REAL' } }); expect(back.calibration).toBe('UNCALIBRATED'); expect(back.approved_use).toBeNull();
    expect(r.verifyHistory('M', '1')).toBe(true); expect(r.transition('M', '1', 'RETIRED', { actor: { id: 'x', kind: 'human' }, evidence: {} }).state).toBe('RETIRED');
    expect(() => r.transition('M', '1', 'DEVELOPMENT', { actor: { id: 'x', kind: 'human' } })).toThrow(GovernanceError);
  });
});

describe('AI firewall', () => {
  const results = [res()];
  const good = `Bu çıktı yatırım tavsiyesi değildir. ${results[0].model_id}: durum ${results[0].status}; toplam kayıp 1234.5, kayıp oranı %8.12; debt:F3 UNOBSERVED.`;
  it('accepts a narrative that uses only result numbers and states the status', () => { expect(validateNarrative(good, results)).toEqual({ ok: true, violations: [] }); });
  it('rejects invented numbers, missing status labels, advice, accusations and certainty upgrades', () => {
    const rules = (t) => validateNarrative(t, results).violations.map((v) => v.rule);
    expect(rules(`${results[0].status} kayıp 999999`)).toContain('NUMBER_NOT_IN_RESULTS');
    expect(rules('kayıp 1234.5')).toContain('STATUS_NOT_STATED');
    expect(rules(`${results[0].status} fon için SAT önerilir`)).toContain('INVESTMENT_ADVICE');
    expect(rules(`${results[0].status} yönetici dolandırıcı`)).toContain('ACCUSATION');
    expect(rules(`${results[0].status} this proves a crisis`)).toContain('CERTAINTY_UPGRADE');
    expect(rules(`${results[0].status} ortak satışı açıklandı`)).not.toContain('INVESTMENT_ADVICE'); // 'satışı' is not advice
  });
  it('invalid LLM output is discarded for a deterministic fallback that itself passes validation', async () => {
    const out = await explainResults({ results, llm: async () => `${results[0].status} güvenle AL, kayıp 77777` });
    expect(out.source).toBe('DETERMINISTIC_FALLBACK'); expect(out.violations.length).toBeGreaterThan(0); expect(validateNarrative(out.text, results).ok).toBe(true); expect(out.text).toContain('UNOBSERVED');
  });
  it('LLM failure -> fallback; valid LLM output -> accepted; results are never modified; AI sees only typed results', async () => {
    expect((await explainResults({ results, llm: async () => { throw new Error('down'); } })).source).toBe('DETERMINISTIC_FALLBACK');
    const seen = vi.fn(async ({ user }) => { expect(JSON.parse(user)[0]).not.toHaveProperty('result_hash'); return good; });
    const before = results[0].result_hash; const ok = await explainResults({ results, llm: seen });
    expect(ok.source).toBe('LLM_VALIDATED'); expect(results[0].result_hash).toBe(before); expect(Object.isFrozen(results[0])).toBe(true);
    expect(unwrapForAI(results)[0]).not.toHaveProperty('parameters'); expect(renderDeterministic(results)).toContain('coverage 3/4');
  });
});

describe('retail risk table', () => {
  it('REGRESSION: missing engine results are INSUFFICIENT_OBSERVABILITY, never LOW_RISK; no composite score; no recommendation', () => {
    const t = buildRetailRiskTable({});
    expect(t.rows).toHaveLength(DIMENSIONS.length); expect(t.rows.find((r) => r.key === 'liquidity').status).toBe('INSUFFICIENT_OBSERVABILITY');
    expect(t.rows.some((r) => r.status === 'LOW_RISK')).toBe(false); expect(t.composite_score).toBeNull(); expect(t.recommendation).toBeNull(); expect(t.disclaimer).toMatch(/yatırım tavsiyesi değildir/);
    expect(JSON.stringify(t)).not.toMatch(/"(buy|sell|al|sat)"/i);
  });
  it('surfaces disagreement, coverage and uncertainty explicitly', () => {
    const dis = makeResult({ engine: 'anomaly', modelId: 'M20.anomaly_ensemble', status: STATUS.MODEL_DISAGREEMENT, coverage: coverageOf(6, 6) });
    const t = buildRetailRiskTable({ price_anomaly: dis, contagion: res() }, { contagion: 'claim_x' });
    expect(t.rows.find((r) => r.key === 'model_disagreement').status).toBe('MODEL_DISAGREEMENT'); expect(t.rows.find((r) => r.key === 'data_coverage').measurement.minimumCoverage).toBe(0.75);
    expect(t.rows.find((r) => r.key === 'contagion').claim_id).toBe('claim_x'); expect(t.rows.find((r) => r.key === 'uncertainty').measurement.uncalibratedEngines).toBe(2);
  });
});

describe('research providers', () => {
  const now = () => '2026-02-01T00:00:00Z';
  it('unconfigured official providers are honestly UNAVAILABLE; CONFIDENTIAL queries never leave (BLOCKED_BY_POLICY)', async () => {
    const reg = new ResearchRegistry(defaultProviders({}, vi.fn()).filter((p) => p.id !== 'web:duckduckgo'));
    const r = await reg.research('q', { now }); expect(r.providerStatus.every((s) => s.status === 'UNAVAILABLE')).toBe(true); expect(r.coverage.hasPrimary).toBe(false);
    const ddg = vi.fn(async () => []); const reg2 = new ResearchRegistry([new DuckDuckGoProvider({ researchFn: ddg })]);
    expect((await reg2.research('secret', { classification: 'RESTRICTED', now })).providerStatus[0].status).toBe('BLOCKED_BY_POLICY'); expect(ddg).not.toHaveBeenCalled();
  });
  it('JSON-feed provider yields evidence docs with source, publication_time, retrieval_time, hash; invalid publication_time becomes null (not invented)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ items: [{ url: 'https://www.kap.org.tr/a', title: 'T', publication_time: '2026-01-05T08:00:00Z', claim_key: 'k' }, { url: 'https://kap.org.tr/b', title: 'U', publication_time: 'yesterday', claim_key: 'k' }] }) }));
    const p = new JsonFeedProvider({ id: 'official:kap', tier: 'OFFICIAL_REGULATOR', endpoint: 'https://gw.example/feed', fetchImpl });
    const docs = await p.search('q', { now }); expect(docs[0]).toMatchObject({ source: 'official:kap', publication_time: '2026-01-05T08:00:00Z', retrieval_time: now() }); expect(docs[0].content_hash).toMatch(/^[0-9a-f]{64}$/); expect(docs[1].publication_time).toBeNull();
    expect(fetchImpl.mock.calls[0][0]).toContain('q=q');
  });
  it('provider errors are isolated; DuckDuckGo is one low-trust provider (NEWS_UNVERIFIED), never primary', async () => {
    const bad = new JsonFeedProvider({ id: 'official:spk', tier: 'OFFICIAL_REGULATOR', endpoint: 'https://x', fetchImpl: async () => ({ ok: false, status: 503 }) });
    const ddg = new DuckDuckGoProvider({ researchFn: async () => [{ url: 'https://news.example/a', title: 'n', snippet: 's' }] });
    const r = await new ResearchRegistry([ddg, bad]).research('q', { now });
    expect(r.providerStatus.map((s) => s.status).sort()).toEqual(['ERROR', 'OK']); expect(r.coverage.hasPrimary).toBe(false); expect(r.docs[0].tier).toBe('NEWS_UNVERIFIED'); expect(r.docs[0].publication_time).toBeNull();
  });
  it('corroboration requires >=2 independent publishers incl. one primary; same publisher / syndicated copies count once', () => {
    const d = (url, tier, title) => makeEvidenceDoc({ providerId: 'p', tier, url, title, retrieval_time: now(), claim_key: 'k' });
    expect(corroborate([d('https://kap.org.tr/1', 'OFFICIAL_REGULATOR', 'a'), d('https://reuters.com/1', 'NEWS_RELIABLE', 'b')])[0].level).toBe('CORROBORATED');
    expect(corroborate([d('https://a.com/1', 'NEWS_RELIABLE', 'a'), d('https://b.com/1', 'NEWS_RELIABLE', 'b')])[0].level).toBe('MULTI_SOURCE_NO_PRIMARY');
    expect(corroborate([d('https://a.com/1', 'NEWS_RELIABLE', 'a'), d('https://a.com/2', 'NEWS_RELIABLE', 'b')])[0].independentPublishers).toBe(1);
    expect(corroborate([d('https://a.com/1', 'NEWS_RELIABLE', 'same'), d('https://b.com/1', 'NEWS_RELIABLE', 'same')])[0].independentPublishers).toBe(1);
    expect(corroborate([d('https://kap.org.tr/1', 'OFFICIAL_REGULATOR', 'a')])[0].level).toBe('SINGLE_PRIMARY_SOURCE');
    expect(() => makeEvidenceDoc({ providerId: 'p', tier: 'NOPE', url: 'https://x', retrieval_time: now() })).toThrow();
  });
});

describe('stores', () => {
  it('memory and JSONL stores are append-only and round-trip', () => {
    for (const s of [new MemoryStore(), new JsonlFileStore(fs.mkdtempSync(path.join(os.tmpdir(), 'sfre-')))]) {
      s.append('runs', { run_id: 'r1', x: 1 }); s.append('runs', { run_id: 'r2', x: 2 });
      expect(s.list('runs')).toHaveLength(2); expect(s.get('runs', 'r2').x).toBe(2); expect(s.get('runs', 'nope')).toBeNull();
    }
    expect(() => new JsonlFileStore(os.tmpdir()).append('../evil', { id: 1 })).toThrow(/bad collection/);
  });
});

describe('pipeline & reproducibility', () => {
  const req = (o = {}) => ({ seed: 11, engines: ['cascade', 'concentration', 'overlap', 'counterfactual'], fundSystem: randomSystem(3), scenario: { priceShocks: { A0: 0.1 }, redemptions: { F0: { fraction: 0.3 } } }, ...o });
  const run = (r) => runPipeline(r, { ledger: new EvidenceLedger({ clock: () => '2026-01-01T00:00:00Z' }), registry: createDefaultRegistry() });
  it('same snapshot/model/seed -> same result hash and run id; wall-clock excluded', () => {
    const a = run(req()); const b = run(req());
    expect(a.run.result_hash).toBe(b.run.result_hash); expect(a.run.run_id).toBe(b.run.run_id);
    expect(a.run.random_seed).toBe(11); expect(a.run.model_versions.length).toBeGreaterThan(0); expect(a.run.parameter_hash).toMatch(/^[0-9a-f]{64}$/); expect(a.run.dependency_versions.node).toBe(process.version); expect(a.run).toHaveProperty('git_commit');
  });
  it('a different input or seed (stochastic engine) changes the result hash', () => {
    expect(run(req({ scenario: { priceShocks: { A0: 0.2 } } })).run.result_hash).not.toBe(run(req()).run.result_hash);
  });
  it('every result is bound to a ledger claim; models not APPROVED are labelled NON_PRODUCTION', () => {
    const ledger = new EvidenceLedger({ clock: () => '2026-01-01T00:00:00Z' }); const out = runPipeline(req(), { ledger, registry: createDefaultRegistry() });
    expect(out.production_status).toBe('NON_PRODUCTION'); expect(out.non_production_models).toContain('M10.cascade');
    for (const r of out.results) expect(ledger.explain(out.claims[r.result_hash]).result_hash).toBe(r.result_hash);
  });
  it('look-ahead in the pipeline: observations available after asOf never enter the snapshot', () => {
    const o = (v, avail) => ({ entity: 'E', field: 'f', value: v, unit: null, event_time: '2026-01-01T00:00:00Z', published_time: avail, available_time: avail, ingested_time: avail, source: 't', revision: v, quality_flags: [] });
    const out = run({ seed: 1, engines: ['concentration'], fundSystem: randomSystem(1), asOf: '2026-02-01T00:00:00Z', observations: [o(0, '2026-01-05T00:00:00Z'), o(1, '2026-03-01T00:00:00Z')] });
    expect(out.snapshot.count).toBe(1);
  });
  it('missing sections yield INSUFFICIENT_OBSERVABILITY (never a made-up result); engine exceptions become COMPUTATION_FAILED', () => {
    const out = run({ seed: 1, engines: ['tailRisk', 'fundamentals'] }); expect(out.results.map((r) => r.status)).toEqual(['INSUFFICIENT_OBSERVABILITY', 'INSUFFICIENT_OBSERVABILITY']);
    const bad = run({ seed: 1, engines: ['fundamentals'], statements: {} }); expect(bad.results[0].status).toBe('COMPUTATION_FAILED');
  });
  it('request validation', () => {
    expect(validateRequest({ engines: ['cascade'] })).toMatch(/seed/); expect(validateRequest({ seed: 1, engines: ['nope'] })).toMatch(/engines/);
    expect(validateRequest({ seed: 1, engines: ['cascade'], observations: [{}] })).toMatch(/asOf/); expect(validateRequest(null)).toMatch(/body/);
    expect(validateRequest({ seed: 1, engines: ['cascade'], fundSystem: { assets: [], funds: [{ id: 'a', cash: -1 }] } })).toMatch(/fundSystem/);
    expect(() => run({ seed: 'x', engines: ['cascade'] })).toThrow(/seed/);
  });
  it('run record is content-addressed and ignores started_at', () => {
    const results = [res()]; const a = createRunRecord({ snapshot: null, models: [], parameters: {}, seed: 1, results, startedAt: 'a', commit: 'c', deps: {} }); const b = createRunRecord({ snapshot: null, models: [], parameters: {}, seed: 1, results, startedAt: 'b', commit: 'c', deps: {} });
    expect(a.run_id).toBe(b.run_id); expect(hhi([{ id: 'x', w: 1 }]).status).toBe('MEASURED');
  });
});

describe('security: request budgets', () => {
  it('oversized / abusive requests are rejected before any computation', () => {
    const big = Array.from({ length: 1001 }, (_, i) => ({ id: `F${i}`, cash: 1, holdings: [] }));
    expect(validateRequest({ seed: 1, engines: ['cascade'], fundSystem: { assets: [{ id: 'A', price: 1 }], funds: big, impact: { model: 'amihud-linear' } } })).toMatch(/exceeds/);
    expect(validateRequest({ seed: 1, engines: ['tailRisk'], tail: { N: 1e9 } })).toMatch(/size limits/);
    expect(validateRequest({ seed: 1, engines: ['reverseStress'], reverseStress: { nStarts: 1e6 } })).toMatch(/budget/);
    expect(validateRequest({ seed: 1, engines: ['disclosure'], disclosures: [{ title: 'x'.repeat(30000) }] })).toMatch(/size limits/);
    expect(validateRequest({ seed: 1, engines: ['anomaly'], anomaly: { reference: new Array(10001).fill(0), evaluation: [] } })).toMatch(/size limit/);
  });
  it('regex-heavy disclosure text is bounded in time (ReDoS hardening)', async () => {
    const { classifyDisclosure } = await import('../engines/disclosure.js');
    const t = Date.now(); classifyDisclosure({ id: 'x', published_time: '2026-01-01T00:00:00Z', title: `ortak ${'a '.repeat(200000)}`, body: 'satış' });
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
