import { describe, it, expect } from 'vitest';
import { pumpDumpPattern, STAGES } from '../engines/integrity.js';
import { attentionAnomaly } from '../engines/attention.js';
import { detectCoordination, hypergeomSf } from '../engines/coordination.js';
import { Rng } from '../core/prng.js';

function market(seed, { pump = false, attention = true } = {}) {
  const r = new Rng(seed);
  const refP = [20]; const refV = []; const refA = [];
  for (let i = 0; i < 200; i++) { refP.push(refP.at(-1) * Math.exp(0.01 * r.normal())); refV.push(1e5 * Math.exp(0.2 * r.normal())); refA.push(10 + 2 * r.normal()); }
  refV.push(1e5);
  const P = [refP.at(-1)]; const V = [1e5]; const A = [10];
  for (let d = 1; d <= 40; d++) {
    let ret = 0.01 * r.normal(); let vol = 1e5 * Math.exp(0.2 * r.normal()); let att = 10 + 2 * r.normal();
    if (pump) {
      if (d >= 5 && d < 10) vol *= 4; // accumulation: volume up, price flat
      if (d >= 10 && d < 16) { ret += 0.09; vol *= 6; }
      if (d >= 12 && d < 17) att += 40;
      if (d >= 17 && d < 22) { ret -= 0.04; vol *= 6; }
      if (d >= 22 && d < 26) ret -= 0.12;
    }
    P.push(P.at(-1) * Math.exp(ret)); V.push(vol); A.push(att);
  }
  return { ref: { price: refP, volume: refV, attention: attention ? refA : null }, win: { price: P, volume: V, attention: attention ? A : null } };
}

describe('pump-and-dump pattern similarity', () => {
  it('a staged accumulation -> acceleration -> volume/attention -> distribution -> collapse path is detected, in order', () => {
    const r = pumpDumpPattern(market(1, { pump: true }));
    expect(r.status).toBe('SIGNAL'); expect(r.value.kind).toBe('MARKET_INTEGRITY_ANOMALY'); expect(r.value.orderedChain).toBeGreaterThanOrEqual(4);
    const times = r.value.stages.filter((s) => s.active).map((s) => s.time); expect(times.length).toBeGreaterThanOrEqual(4);
    expect(r.value.disclaimer).toMatch(/not an allegation/);
  });
  it('NEGATIVE CONTROL: ordinary noise -> no signal, kind PATTERN_SIMILARITY', () => {
    let signals = 0; for (let s = 1; s <= 25; s++) if (pumpDumpPattern(market(100 + s)).status === 'SIGNAL') signals++;
    expect(signals).toBeLessThanOrEqual(1);
    expect(pumpDumpPattern(market(7)).value.kind).toBe('PATTERN_SIMILARITY');
  });
  it('missing attention data -> that stage UNOBSERVED and excluded from the denominator (coverage reported)', () => {
    const r = pumpDumpPattern(market(1, { pump: true, attention: false }));
    expect(r.unobserved).toContain('stage.ATTENTION_SURGE'); expect(r.coverage.observed).toBe(STAGES.length - 1); expect(r.value.observableStages).toBe(STAGES.length - 1);
  });
  it('short reference is INSUFFICIENT_DATA; output never contains accusation words', () => {
    const m = market(2, { pump: true }); m.ref.price = m.ref.price.slice(0, 30);
    expect(pumpDumpPattern(m).status).toBe('INSUFFICIENT_DATA');
    expect(JSON.stringify(pumpDumpPattern(market(1, { pump: true }))).toLowerCase()).not.toMatch(/fraud|manipulator|dolandırıcı|manipülatör/);
  });
});

describe('attention / promotion divergence', () => {
  const rng = new Rng(3); const ref = Array.from({ length: 60 }, () => 10 + 2 * rng.normal());
  it('PROMOTION_MARKET_DIVERGENCE needs attention+price+volume anomalies AND observed unsupportive fundamentals', () => {
    expect(attentionAnomaly({ attentionRef: ref, attentionEval: [60, 70], returnZ: 6, volumeZ: 7, fundamentalsSupport: 'NOT_SUPPORTED' }).value.label).toBe('PROMOTION_MARKET_DIVERGENCE');
    expect(attentionAnomaly({ attentionRef: ref, attentionEval: [60], returnZ: 6, volumeZ: 7, fundamentalsSupport: 'SUPPORTED' }).status).toBe('NO_SIGNAL');
  });
  it('unknown fundamentals are NOT treated as unsupportive -> weaker label + INSUFFICIENT_OBSERVABILITY', () => {
    const r = attentionAnomaly({ attentionRef: ref, attentionEval: [60], returnZ: 6, volumeZ: 7, fundamentalsSupport: null });
    expect(r.value.label).toBe('ATTENTION_PRICE_VOLUME_CO_ANOMALY'); expect(r.status).toBe('INSUFFICIENT_OBSERVABILITY'); expect(r.unobserved).toContain('fundamentalsSupport');
  });
  it('attention alone, short history, and flat history are handled distinctly', () => {
    expect(attentionAnomaly({ attentionRef: ref, attentionEval: [60], returnZ: 0.2, volumeZ: 0.1, fundamentalsSupport: 'NOT_SUPPORTED' }).value.label).toBe('ATTENTION_ANOMALY_ONLY');
    expect(attentionAnomaly({ attentionRef: ref.slice(0, 5), attentionEval: [1] }).status).toBe('INSUFFICIENT_DATA');
    expect(attentionAnomaly({ attentionRef: new Array(40).fill(3), attentionEval: [9] }).status).toBe('MODEL_UNCERTAIN');
  });
});

describe('coordinated activity', () => {
  const T = Date.UTC(2026, 0, 1); const H = 3600000; const M = 60000;
  function build(coordinated) {
    const r = new Rng(5); const referencePosts = [];
    for (let h = 0; h < 72; h++) for (let k = 0; k < 3; k++) referencePosts.push({ author_key: `u${r.int(50)}`, time: T + h * H + r.int(H), text: `normal chatter ${r.int(1e6)} about market ${r.int(1e6)}` });
    const E = T + 100 * H; const evalPosts = [];
    for (let h = 0; h < 12; h++) for (let k = 0; k < 3; k++) evalPosts.push({ author_key: `u${r.int(50)}`, time: E + h * H + r.int(H), text: `organic message ${r.int(1e6)} text ${r.int(1e6)}` });
    if (coordinated) for (let wave = 0; wave < 4; wave++) for (let b = 0; b < 12; b++) evalPosts.push({ author_key: `bot${b}`, time: E + (3 + wave * 2) * H + 5 * M + b * 15000, text: 'HISSE X UCUYOR HERKES ALSIN SON FIRSAT YARIN TAVAN OLACAK' });
    return { referencePosts, evalPosts };
  }
  it('detects a planted burst of near-identical, co-timed posts from a cluster of accounts; outputs hashed, cluster-level ids', () => {
    const r = detectCoordination(build(true));
    expect(r.value.label).toBe('COORDINATED_ACTIVITY_SUSPECTED'); expect(r.status).toBe('SIGNAL');
    expect(r.value.clusters.some((c) => c.size >= 6)).toBe(true); expect(r.value.bursts.length).toBeGreaterThan(0);
    const dump = JSON.stringify(r.value); expect(dump).not.toMatch(/bot\d/); expect(r.value.disclaimer).toMatch(/does not establish intent/);
  });
  it('NEGATIVE CONTROL: purely organic activity is not flagged', () => {
    expect(detectCoordination(build(false)).value.label).toBe('NO_COORDINATION_PATTERN');
  });
  it('rejects identity fields (no personal profiling)', () => {
    const b = build(false); b.evalPosts[0].email = 'a@b.c';
    const r = detectCoordination(b); expect(r.status).toBe('COMPUTATION_FAILED'); expect(r.error).toMatch(/does not profile individuals/);
  });
  it('look-ahead guard: reference posts must strictly precede evaluation posts', () => {
    const b = build(false); b.referencePosts.push({ author_key: 'x', time: b.evalPosts[0].time + 1, text: 'late' });
    expect(detectCoordination(b).status).toBe('COMPUTATION_FAILED');
  });
  it('hypergeometric tail sanity', () => {
    expect(hypergeomSf(0, 10, 3, 4)).toBeCloseTo(1, 12);
    expect(hypergeomSf(3, 10, 3, 3)).toBeCloseTo(1 / 120, 12);
  });
});
