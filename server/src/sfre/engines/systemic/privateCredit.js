import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { Rng } from '../../core/prng.js';
import { quantile, std } from '../../core/stats.js';
import { isNum, isNonNeg, isFrac, unobs, normalInv, vasicekConditionalPd } from '../../core/numeric.js';
import { hhi } from '../concentration.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';
import { propagate } from './crossSector.js';

const ENGINE = 'privateCredit';
export const MODEL_ID = 'M65.private_credit';
export const MAX_SIM = 20000;

export function validatePrivateCredit(system, scenario) {
  const pc = system.privateCredit;
  if (!pc || typeof pc !== 'object') return 'system.privateCredit required';
  const f = pc.factor ?? {};
  if (!(isNum(f.rhoGlobal) && f.rhoGlobal >= 0 && f.rhoGlobal < 1) || !(isNum(f.rhoSponsor) && f.rhoSponsor >= 0 && f.rhoGlobal + f.rhoSponsor < 1)) return 'privateCredit.factor.rhoGlobal/rhoSponsor must satisfy 0<=rho and rhoGlobal+rhoSponsor<1 (explicit)';
  const byId = new Map(system.entities.map((e) => [e.id, e]));
  if (!Array.isArray(pc.funds) || !pc.funds.length) return 'privateCredit.funds required';
  for (const fd of pc.funds) {
    const e = byId.get(fd.entity);
    if (!e || e.sector !== 'PRIVATE_CREDIT') return `fund ${fd.entity}: must be an entity with sector PRIVATE_CREDIT`;
    if (!(e.creditBook?.length)) return `fund ${fd.entity}: entity.creditBook (loan book) required`;
    for (const c of e.creditBook) if (!c.sponsor) return `fund ${fd.entity}: loan ${c.id} needs a sponsor label`;
    if (!unobs(fd.facilityLimit) && !isNonNeg(fd.facilityLimit)) return `fund ${fd.entity}: facilityLimit must be null or >= 0`;
    if (!unobs(fd.ltvCovenant) && !(isNum(fd.ltvCovenant) && fd.ltvCovenant > 0 && fd.ltvCovenant < 1)) return `fund ${fd.entity}: ltvCovenant must be null or in (0,1)`;
    if (!unobs(fd.unfundedCommitments) && !isNonNeg(fd.unfundedCommitments)) return `fund ${fd.entity}: unfundedCommitments must be null or >= 0`;
    if (!unobs(fd.gateFraction) && !isFrac(fd.gateFraction)) return `fund ${fd.entity}: gateFraction must be null or in [0,1]`;
    let stakes = 0;
    for (const i of fd.investors || []) { if (!byId.has(i.investor) || !isFrac(i.stake)) return `fund ${fd.entity}: invalid investor`; stakes += i.stake; }
    if (stakes > 1 + 1e-9) return `fund ${fd.entity}: investor stakes exceed 100%`;
  }
  const sc = scenario.privateCredit ?? {};
  if (!(isNum(sc.stressFactor) && sc.stressFactor >= -6 && sc.stressFactor <= 6)) return 'scenario.privateCredit.stressFactor must be in [-6,6] (systematic factor realisation; negative = stress)';
  if (sc.liquidationDiscount !== undefined && !(isFrac(sc.liquidationDiscount) && sc.liquidationDiscount < 1)) return 'liquidationDiscount must be in [0,1)';
  for (const [k, v] of Object.entries(sc.redemptionFractions || {})) if (!pc.funds.some((f) => f.entity === k) || !isFrac(v)) return `redemptionFractions.${k} invalid`;
  if (sc.nSim !== undefined && !(Number.isInteger(sc.nSim) && sc.nSim >= 100 && sc.nSim <= MAX_SIM)) return `nSim must be an integer in [100, ${MAX_SIM}]`;
  return null;
}

/** Closed-form expected stressed loss: sum amount*lgd*Phi((Phi^-1(pd) - sqrt(rhoG) g)/sqrt(1-rhoG)). */
export function analyticLoss(loans, rhoG, g) {
  let l = 0; const unobserved = [];
  for (const c of loans) {
    if (unobs(c.pd) || unobs(c.lgd)) { unobserved.push(`loan_inputs:${c.id}`); continue; }
    l += c.amount * c.lgd * vasicekConditionalPd(c.pd, rhoG, g);
  }
  return { loss: l, unobserved };
}

/** Seeded Monte-Carlo of the two-level factor model given the systematic factor g: sponsor clusters create default clustering. */
export function simulateLoss(loans, { rhoGlobal, rhoSponsor }, g, nSim, rng) {
  const obs = loans.filter((c) => !unobs(c.pd) && !unobs(c.lgd));
  const sponsors = [...new Set(obs.map((c) => c.sponsor))].sort(); const sIdx = new Map(sponsors.map((s, i) => [s, i]));
  const thr = obs.map((c) => (c.pd <= 0 ? -Infinity : c.pd >= 1 ? Infinity : normalInv(c.pd)));
  const a = Math.sqrt(rhoGlobal) * g; const b = Math.sqrt(rhoSponsor); const idio = Math.sqrt(1 - rhoGlobal - rhoSponsor);
  const out = new Array(nSim);
  for (let s = 0; s < nSim; s++) {
    const sf = sponsors.map(() => rng.normal()); let loss = 0;
    for (let i = 0; i < obs.length; i++) { const x = a + b * sf[sIdx.get(obs[i].sponsor)] + idio * rng.normal(); if (x < thr[i]) loss += obs[i].amount * obs[i].lgd; }
    out[s] = loss;
  }
  return out;
}

function fundStep(system, ix, pc, fd, sc, params) {
  const e = system.entities.find((x) => x.id === fd.entity); const ei = ix.eIdx.get(fd.entity);
  const unobserved = []; const lb = new Set();
  const loans = e.creditBook; const loans0 = sumArr(loans.map((c) => c.amount));
  const { loss: creditLoss, unobserved: u1 } = analyticLoss(loans, pc.factor.rhoGlobal, sc.stressFactor);
  u1.forEach((x) => { unobserved.push(x); lb.add('loans with unobserved pd/lgd are excluded from credit loss'); });
  const mc = simulateLoss(loans, pc.factor, sc.stressFactor, sc.nSim ?? 2000, new Rng(params.seed).child(`pc:${fd.entity}`));
  // debt = bank facilities (network edges into this fund)
  const into = []; let debt0 = 0; let debtKnown = true;
  ix.edges.forEach((x, k) => { if (x.d === ei) { if (x.amount === null) { debtKnown = false; unobserved.push(`exposure:${ix.E[x.c].id}->${fd.entity}`); } else { debt0 += x.amount; into.push({ k, c: x.c, amount: x.amount }); } } });
  if (!debtKnown) lb.add('facility drawn amount partly unobserved: covenant/headroom channels use observed part only (lower bound)');
  const cash0 = e.cash; const extLiab = e.externalLiabilities ?? 0;
  if (unobs(e.externalLiabilities)) { unobserved.push(`externalLiabilities:${fd.entity}`); lb.add('fund other liabilities unobserved: NAV is gross of them'); }
  const nav0 = cash0 + loans0 - debt0 - extLiab;
  const delta = params.liquidationDiscount;
  // (1) credit loss (carried loans fall by expected stressed loss)
  let loansV = loans0 - creditLoss; let cash = cash0; let debt = debt0; let liqLoss = 0; let repaid = 0;
  // (2) covenant deleveraging
  let covenant = { tested: false, breached: false, repay: 0 };
  if (!unobs(fd.ltvCovenant) && debt > 0 && debtKnown) {
    const cov = fd.ltvCovenant; const A = loansV + cash; covenant = { tested: true, breached: debt > cov * A, repay: 0, ltv: debt / A };
    if (covenant.breached) {
      const denom = 1 - cov / (1 - delta);
      if (denom > 1e-12) {
        let rep = (debt - cov * A) / denom; rep = Math.min(rep, debt); const S = Math.min(loansV, rep / (1 - delta));
        const got = S * (1 - delta); loansV -= S; liqLoss += S - got; debt -= got; repaid = got; covenant.repay = got;
      } else { covenant.infeasible = true; const S = loansV; const got = S * (1 - delta); loansV = 0; liqLoss += S - got; const pay = Math.min(debt, got + cash); cash = got + cash - pay; debt -= pay; repaid = pay; covenant.repay = pay; }
    }
  } else if (unobs(fd.ltvCovenant)) { unobserved.push(`ltv_covenant:${fd.entity}`); lb.add('covenant unobserved: forced deleveraging channel excluded'); }
  // (3) redemptions, unfunded draws, gating
  const navAfter = Math.max(0, cash + loansV - debt - extLiab);
  const r = sc.redemptionFractions?.[fd.entity] ?? 0; const requested = r * navAfter;
  const gateCap = unobs(fd.gateFraction) ? null : fd.gateFraction * navAfter;
  if (unobs(fd.gateFraction) && r > 0) { unobserved.push(`gate_fraction:${fd.entity}`); lb.add('gate terms unobserved: redemptions assumed ungated (liquidity stress upper side, flagged)'); }
  const payable = gateCap === null ? requested : Math.min(requested, gateCap);
  const unfundedDraw = unobs(fd.unfundedCommitments) ? 0 : fd.unfundedCommitments * (sc.unfundedDrawRate ?? 0);
  if (unobs(fd.unfundedCommitments)) { unobserved.push(`unfunded_commitments:${fd.entity}`); lb.add('unfunded commitments unobserved: draw-down liquidity need excluded'); }
  const covOk = !covenant.breached || covenant.repay > 0 && !covenant.infeasible;
  const headroom = unobs(fd.facilityLimit) || !covOk ? 0 : Math.max(0, fd.facilityLimit - debt);
  if (unobs(fd.facilityLimit)) { unobserved.push(`facility_limit:${fd.entity}`); lb.add('facility limit unobserved: undrawn headroom excluded'); }
  const need = payable + unfundedDraw; let fromCash = Math.min(Math.max(0, cash), need); let rem = need - fromCash;
  const drawn = Math.min(headroom, rem); rem -= drawn;
  let S2 = 0; let paidOut = payable;
  if (rem > 1e-12) { S2 = Math.min(loansV, rem / (1 - delta)); const got = S2 * (1 - delta); liqLoss += S2 - got; rem -= got; loansV -= S2; }
  let shortfallAfter = Math.max(0, rem);
  if (shortfallAfter > 1e-9) { paidOut = Math.max(0, payable - shortfallAfter); }
  cash = cash - fromCash + 0; debt += drawn;
  // loans increase by unfunded draws (par), cash decreases: balance-sheet neutral for equity; payout leaves the fund
  loansV += Math.min(unfundedDraw, need - shortfallAfter);
  const gated = requested - paidOut;
  const ext1 = cash + loansV; const ext0 = cash0 + loans0;
  const equityLoss = Math.min(Math.max(0, nav0), creditLoss + liqLoss);
  const hl = hhi(loans.map((c) => ({ id: c.id, w: c.amount / loans0 })), { entity: fd.entity }).value;
  const bySponsor = {}; for (const c of loans) bySponsor[c.sponsor] = (bySponsor[c.sponsor] || 0) + c.amount / loans0;
  const sp = hhi(Object.entries(bySponsor).map(([id, w]) => ({ id, w })), { entity: fd.entity }).value;
  const q = (arr, p) => quantile(arr, p); const mean = sumArr(mc) / mc.length;
  return {
    fund: fd.entity, nav0, loans0, cash0, debt0, creditLoss, liquidationLoss: liqLoss, equityLoss, navFinal: cash + loansV - debt - extLiab,
    leverage0: nav0 > 0 ? debt0 / nav0 : null, covenant, redemption: { requested, payable, paidOut, gated, drawnOnFacility: drawn, unfundedDraw, loansSold: S2, liquiditySurplusAfter: Math.max(0, -shortfallAfter) },
    stressedLossDistribution: { n: mc.length, mean, se: std(mc) / Math.sqrt(mc.length), analyticMean: creditLoss, p05: q(mc, 0.05), p50: q(mc, 0.5), p95: q(mc, 0.95), probLossExceedsNav: mc.filter((x) => x > nav0).length / mc.length },
    concentration: { borrower: hl, sponsor: sp }, deltaExt: ext1 - ext0, repaidToLenders: repaid, drawn, into, debtFinal: debt, unobserved, lb: [...lb],
  };
}

/** Balance-sheet/liquidity effects of the stress on every fund, as hand-off deltas for the shared network (used by M65 and the twin). */
export function privateCreditEffects(system, scenario, params, ix = indexSystem(system)) {
  const pc = system.privateCredit; const sc = scenario.privateCredit;
  const rows = pc.funds.map((fd) => fundStep(system, ix, pc, fd, sc, params));
  const n = ix.n; const dA = new Array(n).fill(0); const dT = new Array(n).fill(0); const amounts = ix.edges.map((x) => x.amount);
  const bankOutflow = {}; const inflowLost = {};
  for (const r of rows) {
    const fi = ix.eIdx.get(r.fund); dA[fi] += r.deltaExt;
    const fd = pc.funds.find((f) => f.entity === r.fund);
    for (const inv of fd.investors || []) {
      const ii = ix.eIdx.get(inv.investor); dT[ii] -= inv.stake * r.equityLoss; // a TRANSFER: the fund's assets already lost this value
      if (r.redemption.gated > 0) inflowLost[inv.investor] = (inflowLost[inv.investor] || 0) + inv.stake * r.redemption.gated;
    }
    const net = r.debtFinal - r.debt0; // draws increase, repayments decrease the lenders' claim pro-rata
    for (const l of r.into) { const share = r.debt0 > 0 ? l.amount / r.debt0 : 0; amounts[l.k] = l.amount + net * share; dA[l.c] -= net * share; if (net > 0) bankOutflow[ix.E[l.c].id] = (bankOutflow[ix.E[l.c].id] || 0) + net * share; }
  }
  return { rows, dA, dT, amounts, bankOutflow, inflowLost };
}

/** M65 Private credit / shadow banking: two-level factor model, covenant & liquidity mismatch, bank/insurer/PE-sponsor transmission through the shared network. */
export function runPrivateCredit(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validatePrivateCredit(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const ix = indexSystem(system); const pc = system.privateCredit; const sc = scenario.privateCredit;
  const params = { liquidationDiscount: sc.liquidationDiscount ?? 0.15, seed: options.seed ?? 1 };
  const run = (pp) => {
    const e = privateCreditEffects(system, scenario, pp, ix);
    const prop = propagate(system, {}, { alpha: 1, beta: 1, maxIter: 50000 }, { ix, extAssetsDelta: e.dA, transferDelta: e.dT, edgeAmounts: e.amounts });
    return { ...e, prop };
  };
  const out = run(params);
  const unobserved = [...new Set([...out.rows.flatMap((r) => r.unobserved), ...out.prop.unobserved])];
  let status = STATUS.UNCALIBRATED; const notes = ['Two-level Vasicek factor model with caller-supplied correlations; stressed losses are scenario outputs, UNCALIBRATED. Private-credit PD/LGD data are typically unobserved.'];
  if (!out.prop.system.converged) status = STATUS.MODEL_UNCERTAIN; else if (!out.prop.system.reconciled) status = STATUS.COMPUTATION_FAILED;
  else if (unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs excluded: lower bound'); }
  const total = out.rows.map((r) => r.stressedLossDistribution);
  const uncertainty = {
    method: 'SEEDED_MONTE_CARLO', seed: params.seed, nSim: total[0].n,
    perFund: out.rows.map((r) => ({ fund: r.fund, mean: r.stressedLossDistribution.mean, ci95: [r.stressedLossDistribution.mean - 1.96 * r.stressedLossDistribution.se, r.stressedLossDistribution.mean + 1.96 * r.stressedLossDistribution.se], p05: r.stressedLossDistribution.p05, p95: r.stressedLossDistribution.p95 })),
    note: 'Monte-Carlo dispersion of the stressed credit loss given the stress factor and ASSUMED correlations; not a real-world confidence interval',
  };
  const contagion = out.prop;
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status,
    value: { funds: out.rows.map((r) => { const c = { ...r }; delete c.into; return c; }), contagion, lowerBound: unobserved.length > 0, handoff: { extAssetsDelta: out.dA, transferDelta: out.dT, edgeAmounts: out.amounts, bankLiquidityOutflow: out.bankOutflow, investorInflowLost: out.inflowLost } },
    uncertainty, coverage: coverageOf(out.prop.entities.filter((x) => !x.indeterminate).length, system.entities.length), unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { factor: pc.factor, stressFactor: sc.stressFactor, liquidationDiscount: params.liquidationDiscount, unfundedDrawRate: sc.unfundedDrawRate ?? 0, nSim: total[0].n, redemptions: sc.redemptionFractions ?? {}, sequence: ['credit loss', 'covenant deleveraging', 'unfunded draws + redemptions with gating'] },
    inputHashes: [hashOf(system)], notes,
  });
}
