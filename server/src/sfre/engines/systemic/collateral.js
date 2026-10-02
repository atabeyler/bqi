import { makeResult, failed, STATUS, CALIBRATION, coverageOf } from '../../core/result.js';
import { hashOf } from '../../core/canonical.js';
import { parameterBand } from '../../core/sensitivity.js';
import { isNum, isNonNeg, isFrac, unobs, normalInv, normalCdfPrecise, normalPdf } from '../../core/numeric.js';
import { priceImpact } from '../impact.js';
import { marginSaleRequired } from '../leverage.js';
import { validateSystemState, indexSystem, sumArr } from './state.js';

const ENGINE = 'collateral';
export const MODEL_ID = 'M63.margin_collateral';
export const MAX_ROUNDS = 50;
export const CORRELATION_MODES = Object.freeze(['NO_OFFSET', 'INDEPENDENT', 'MATRIX']);

export function validateCollateral(system, scenario) {
  const c = system.collateral;
  if (!c || typeof c !== 'object') return 'system.collateral required';
  const eIds = new Set(system.entities.map((e) => e.id)); const aIds = new Set((system.assets ?? []).map((a) => a.id));
  if (!(isNum(c.mporDays) && c.mporDays > 0)) return 'collateral.mporDays must be > 0 (explicit)';
  if (!(isNum(c.confidence) && c.confidence > 0.5 && c.confidence < 1)) return 'collateral.confidence must be in (0.5,1)';
  if (c.correlation !== undefined && !CORRELATION_MODES.includes(c.correlation)) return `collateral.correlation must be ${CORRELATION_MODES.join('|')}`;
  if (c.correlation === 'MATRIX' && !c.correlationMatrix) return 'correlation MATRIX needs collateral.correlationMatrix';
  for (const [a, h] of Object.entries(c.haircuts || {})) if (!aIds.has(a) || !isFrac(h) || h >= 1) return `haircut ${a} invalid`;
  for (const [t, list] of Object.entries(c.eligibility || {})) { if (!['CCP', 'BILATERAL', 'REPO'].includes(t)) return `eligibility key ${t} invalid`; for (const a of list) if (a !== 'CASH' && !aIds.has(a)) return `eligibility ${t}: unknown asset ${a}`; }
  const nsIds = new Set();
  for (const ns of c.nettingSets || []) {
    if (!ns.id || nsIds.has(ns.id)) return 'netting set id missing/duplicate'; nsIds.add(ns.id);
    if (!eIds.has(ns.party)) return `nettingSet ${ns.id}: unknown party`;
    if (ns.counterparty !== null && ns.counterparty !== undefined && !eIds.has(ns.counterparty)) return `nettingSet ${ns.id}: unknown counterparty`;
    if (ns.ccp && !eIds.has(ns.ccp)) return `nettingSet ${ns.id}: unknown ccp`;
    if (!ns.ccp && !ns.counterparty) return `nettingSet ${ns.id}: needs counterparty or ccp`;
    if (!(ns.positions?.length)) return `nettingSet ${ns.id}: positions required`;
    for (const p of ns.positions) { if (!aIds.has(p.asset) || !isNum(p.exposure)) return `nettingSet ${ns.id}: invalid position`; const a = system.assets.find((x) => x.id === p.asset); if (unobs(a.sigma)) return `nettingSet ${ns.id}: asset ${p.asset} needs sigma (daily volatility) for initial margin`; }
    if (!unobs(ns.imPosted) && !isNonNeg(ns.imPosted)) return `nettingSet ${ns.id}: imPosted must be null or >= 0`;
  }
  for (const r of c.repo || []) {
    if (!eIds.has(r.borrower) || !eIds.has(r.lender) || !aIds.has(r.collateralAsset)) return 'repo: unknown borrower/lender/asset';
    if (!isNonNeg(r.collateralQty) || !isNonNeg(r.cashBorrowed) || !isFrac(r.haircut) || r.haircut >= 1) return 'repo: invalid quantities/haircut';
  }
  const sc = scenario.collateral ?? {};
  for (const [k, s] of Object.entries(sc.priceShocks || {})) if (!aIds.has(k) || !isFrac(s)) return `collateral price shock ${k} invalid`;
  for (const [k, s] of Object.entries(sc.haircutAdd || {})) if (!aIds.has(k) || !isFrac(s)) return `haircutAdd ${k} invalid`;
  if (sc.volMultiplier !== undefined && !(isNum(sc.volMultiplier) && sc.volMultiplier >= 1)) return 'volMultiplier must be >= 1';
  for (const [id, w] of Object.entries(c.wwr || {})) if (!eIds.has(id) || (!unobs(w.pd) && !isFrac(w.pd)) || !(isNum(w.rho) && w.rho > -1 && w.rho < 1)) return `wwr.${id} invalid`;
  return null;
}

/** sigma of a netting set's delta-equivalent exposure vector (daily), under the chosen correlation assumption. */
export function nettingSigma(positions, sigmaOf, mode, matrix = null) {
  if (mode === 'INDEPENDENT') return Math.sqrt(sumArr(positions.map((p) => (p.exposure * sigmaOf(p.asset)) ** 2)));
  if (mode === 'MATRIX') {
    let v = 0;
    for (const a of positions) for (const b of positions) v += a.exposure * b.exposure * sigmaOf(a.asset) * sigmaOf(b.asset) * (a.asset === b.asset ? 1 : (matrix[a.asset]?.[b.asset] ?? matrix[b.asset]?.[a.asset] ?? NaN));
    return Math.sqrt(Math.max(0, v));
  }
  return sumArr(positions.map((p) => Math.abs(p.exposure) * sigmaOf(p.asset))); // NO_OFFSET: no hedge/diversification benefit (conservative)
}

/** Parametric IM = z_q * sigma * sqrt(MPOR). */
export const initialMargin = (sigmaNs, confidence, mpor) => normalInv(confidence) * sigmaNs * Math.sqrt(mpor);

/**
 * E[max(0, a + b x)] with x ~ N(0,1) = a Phi(a/b) + b phi(a/b)  (b>0).  Closed form (independence benchmark).
 */
export const expectedPositiveExposure = (a, b) => (b > 0 ? a * normalCdfPrecise(a / b) + b * normalPdf(a / b) : Math.max(0, a));

/**
 * Expected loss  integral E(x) * LGD * P(D|x) phi(x) dx  with E(x)=max(0,a+bx), P(D|x)=Phi((Phi^-1(pd) + sqrt(rho) x)/sqrt(1-rho))
 * (rho>0 wrong-way, rho<0 right-way, rho=0 independence). Simpson on both sides of the kink x*=-a/b, 20000 panels.
 */
export function wrongWayExpectedLoss(a, b, pd, lgd, rho) {
  if (!(b > 0)) return lgd * pd * Math.max(0, a);
  if (!(pd > 0 && pd < 1)) return lgd * (pd >= 1 ? 1 : 0) * expectedPositiveExposure(a, b);
  const cp = normalInv(pd); const sr = Math.sqrt(Math.abs(rho)) * Math.sign(rho); const den = Math.sqrt(1 - rho);
  const f = (x) => Math.max(0, a + b * x) * normalCdfPrecise((cp + sr * x) / den) * normalPdf(x);
  const lo = Math.max(-12, -a / b); const hi = 12;
  if (lo >= hi) return 0;
  const N = 20000; const h = (hi - lo) / N; let s = f(lo) + f(hi);
  for (let i = 1; i < N; i++) s += f(lo + i * h) * (i % 2 ? 4 : 2);
  return lgd * (s * h) / 3;
}

/** Core multi-round margin/collateral spiral. Returns plain data (used by the engine, the twin and the CCP stage). */
/**
 * `work` (optional) is the Digital Twin's live state {price[], cash[], q[][], enc[][], defaulted[]}: calls are computed on it,
 * cash/encumbrance/defaults are mutated in place and netting/repo state is cached on it (work.ns, work.repo) so that
 * margin already paid is never called twice. With p.applyImpact === false the call does ONE round and returns the sales
 * (value + shares) for the twin to aggregate with all other sellers before applying a single market impact.
 */
export function collateralStress(system, scenario, p, ix = indexSystem(system), work = null) {
  const c = system.collateral; const sc = scenario.collateral ?? {};
  const { E, n, nA } = ix; const A = ix.A;
  const unobserved = []; const lb = new Set();
  const mode = c.correlation ?? 'NO_OFFSET';
  const price0 = A.map((a) => a.price);
  const W = work ?? { price: price0.map((v, k) => v * (1 - (sc.priceShocks?.[A[k].id] ?? 0))), cash: E.map((e) => e.cash), q: ix.q.map((r) => r.slice()), enc: E.map(() => new Array(nA).fill(0)), defaulted: new Array(n).fill(false) };
  const price = W.price; const applyImpact = p.applyImpact !== false;
  const hairc = (a, extra = 0) => Math.min(0.999, (c.haircuts?.[a] ?? 0) + extra + (sc.haircutAdd?.[a] ?? 0));
  const sigmaOf = (id) => A[ix.aIdx.get(id)].sigma;
  // ---- netting sets
  const buildNs = () => (c.nettingSets || []).map((ns) => {
    const sig = nettingSigma(ns.positions, sigmaOf, mode, c.correlationMatrix);
    const imBase = initialMargin(sig, p.confidence, p.mporDays);
    const imReq = imBase * p.volMultiplier;
    let imPosted0 = ns.imPosted;
    if (unobs(imPosted0)) { imPosted0 = imBase; unobserved.push(`im_posted:${ns.id}`); lb.add('IM posted unobserved: baseline IM assumed posted at the model level (ASSUMED)'); }
    return { ns, sigma: sig, imBase, imReq, cumVM: 0, vmNet: 0, posted: {}, postedCash: imPosted0, imPosted0, type: ns.ccp ? 'CCP' : 'BILATERAL', i: ix.eIdx.get(ns.party) };
  });
  const nsList = W.ns ?? (W.ns = buildNs());
  for (const st of nsList) st.imReq = st.imBase * p.volMultiplier;
  // inventories (live arrays when a twin supplies them)
  const cash = W.cash; const q = W.q; const enc = W.enc;
  const calls = E.map(() => ({ vm: 0, im: 0, repo: 0, marginLoan: 0 })); const receipts = new Array(n).fill(0);
  const sold = E.map(() => new Array(nA).fill(0)); const defaulted = W.defaulted; const unmet = new Array(n).fill(0);
  const repoState = W.repo ?? (W.repo = (c.repo || []).map((r) => ({ r, paid: 0, seized: false })));
  const fireSalesCollateral = {}; const rounds = [];
  const eligible = (type) => (c.eligibility?.[type] ?? ['CASH']);
  const order = (type) => { const el = eligible(type).filter((x) => x !== 'CASH'); const so = c.substitutionOrder; return so ? so.filter((x) => el.includes(x)).concat(el.filter((x) => !so.includes(x))) : el.slice().sort(); };
  const unenc = (i, k) => Math.max(0, q[i][k] - enc[i][k] - sold[i][k]);
  const postedValue = (st) => sumArr(Object.entries(st.posted).map(([a, qty]) => qty * price[ix.aIdx.get(a)] * (1 - hairc(a)))) + st.postedCash;

  // raise cash by selling unencumbered holdings pro-rata; returns shortfall left
  const raiseCash = (i, need) => {
    const vals = []; let tot = 0;
    for (let k = 0; k < nA; k++) { const v = unenc(i, k) * price[k]; vals.push(v); tot += v; }
    const take = Math.min(need, tot);
    if (take > 0) for (let k = 0; k < nA; k++) if (vals[k] > 0) { const sh = (vals[k] / tot) * take / price[k]; sold[i][k] += sh; const v = sh * price[k]; roundSales[k] += v; cash[i] += v; }
    return need - take;
  };
  let roundSales = new Array(nA).fill(0);
  let totalCalled = 0; let converged = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    roundSales = new Array(nA).fill(0); const rec = { round, called: 0, sold: 0, shortfall: 0 };
    // calls per entity this round
    const callCash = new Array(n).fill(0); const callIm = nsList.map(() => 0);
    for (const st of nsList) {
      const mtmChange = -sumArr(st.ns.positions.map((pp) => pp.exposure * (1 - price[ix.aIdx.get(pp.asset)] / price0[ix.aIdx.get(pp.asset)])));
      const cum = -mtmChange; const delta = cum - st.vmNet; // >0: party must pay more VM; <0: receives
      st.vmNet = cum;
      if (delta > 0) { callCash[st.i] += delta; calls[st.i].vm += delta; } else if (delta < 0) { receipts[st.i] += -delta; cash[st.i] += -delta; }
    }
    // IM top-up requirements (value of posted collateral moves with prices and haircuts)
    nsList.forEach((st, j) => { const need = st.imReq - postedValue(st); callIm[j] = Math.max(0, need); });
    // repo haircut/price margin calls
    for (const rs of repoState) {
      if (rs.seized) continue;
      const a = ix.aIdx.get(rs.r.collateralAsset); const V = rs.r.collateralQty * price[a];
      const deficit = Math.max(0, rs.r.cashBorrowed - V * (1 - Math.min(0.999, rs.r.haircut + (sc.haircutAdd?.[rs.r.collateralAsset] ?? 0)))) - rs.paid;
      if (deficit > 1e-12) { const b = ix.eIdx.get(rs.r.borrower); callCash[b] += deficit; calls[b].repo += deficit; rs.pending = deficit; rs.b = b; } else rs.pending = 0;
    }
    // margin loans (leveraged entities): reuse M06 marginSaleRequired
    const loanCall = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const lev = E[i].leverage; if (!lev || defaulted[i]) continue;
      if (unobs(lev.debt) || unobs(lev.marginRatio)) { if (round === 0) { unobserved.push(`margin_loan_inputs:${E[i].id}`); lb.add('margin-loan inputs unobserved: channel excluded'); } continue; }
      let ga = cash[i]; for (let k = 0; k < nA; k++) ga += (unenc(i, k) + enc[i][k]) * price[k];
      const need = marginSaleRequired({ grossAssets: ga, debt: lev.debt, marginRatio: lev.marginRatio });
      if (need > 1e-9) { loanCall[i] = Math.min(need, lev.debt); callCash[i] += loanCall[i]; calls[i].marginLoan += loanCall[i]; }
    }
    // satisfy calls: IM top-ups in eligible collateral (substitution order) first, rest and VM/repo/loan calls in cash, then fire sales of unencumbered holdings
    for (let i = 0; i < n; i++) {
      if (defaulted[i]) continue;
      let remaining = callCash[i];
      nsList.forEach((st, j) => {
        if (st.i !== i || !(callIm[j] > 0)) return;
        calls[i].im += callIm[j]; rec.called += callIm[j];
        let need = callIm[j];
        for (const a of order(st.type)) {
          const k = ix.aIdx.get(a); const unit = price[k] * (1 - hairc(a)); if (!(unit > 0)) continue;
          const take = Math.min(unenc(i, k), need / unit);
          if (take > 0) { enc[i][k] += take; st.posted[a] = (st.posted[a] || 0) + take; need -= take * unit; }
          if (need <= 1e-12) break;
        }
        remaining += need; st.pendingCashIm = need;
      });
      rec.called += callCash[i];
      const fromCash = Math.min(cash[i], remaining); cash[i] -= fromCash; remaining -= fromCash;
      if (remaining > 1e-12) {
        const left = raiseCash(i, remaining); cash[i] -= remaining - left; remaining = left; // proceeds are paid out immediately
        if (remaining > 1e-9) { defaulted[i] = true; unmet[i] += remaining; rec.shortfall += remaining; }
      }
      if (!defaulted[i] && loanCall[i] > 0) E[i].leverage.debt -= loanCall[i];
    }
    for (const rs of repoState) { if (rs.pending > 0) { if (defaulted[rs.b]) { rs.seized = true; const a = ix.aIdx.get(rs.r.collateralAsset); const v = rs.r.collateralQty * price[a]; roundSales[a] += v; fireSalesCollateral[rs.r.collateralAsset] = (fireSalesCollateral[rs.r.collateralAsset] || 0) + v; } else rs.paid += rs.pending; } }
    for (const st of nsList) { if (st.pendingCashIm > 0) { if (!defaulted[st.i]) st.postedCash += st.pendingCashIm; st.pendingCashIm = 0; } }
    // market impact of this round's forced sales
    let totalSold = 0; const dRound = {};
    for (let k = 0; k < nA; k++) {
      if (!(roundSales[k] > 0)) continue; totalSold += roundSales[k];
      if (!applyImpact) continue;
      const imp = priceImpact(system.impact ?? { model: 'amihud-linear' }, A[k], roundSales[k]);
      if (imp === null) { unobserved.push(`impact_inputs:${A[k].id}`); lb.add('price impact unobserved for sold collateral assets: impact excluded (not zero); lower bound'); continue; }
      price[k] *= 1 - imp; dRound[A[k].id] = imp;
    }
    rec.sold = totalSold; rec.priceDeclines = dRound; rec.salesByAsset = Object.fromEntries(A.map((a, k) => [a.id, roundSales[k]]).filter((x) => x[1] > 0)); rounds.push(rec);
    if (!applyImpact) { converged = true; break; }
    totalCalled += rec.called;
    if (totalSold <= 1e-9 * Math.max(1, sumArr(E.map((e) => e.cash)))) { converged = true; break; }
  }
  // ---- counterparty exposure & wrong-way risk at the final state
  const cpty = [];
  for (const st of nsList) {
    if (!st.ns.counterparty) continue;
    const w = c.wwr?.[st.ns.counterparty];
    const b = st.sigma * Math.sqrt(p.mporDays); const a = -postedValue(st);
    const ee = expectedPositiveExposure(a, b);
    if (!w || unobs(w.pd)) { unobserved.push(`counterparty_pd:${st.ns.counterparty}`); cpty.push({ netting_set: st.ns.id, counterparty: st.ns.counterparty, expectedPositiveExposure: ee, independentEL: null, wrongWayEL: null, wrongWayMultiplier: null }); continue; }
    const lgd = w.lgd ?? 0.6;
    const ind = lgd * w.pd * ee; const wwr = wrongWayExpectedLoss(a, b, w.pd, lgd, w.rho);
    cpty.push({ netting_set: st.ns.id, counterparty: st.ns.counterparty, expectedPositiveExposure: ee, independentEL: ind, wrongWayEL: wwr, wrongWayMultiplier: ind > 0 ? wwr / ind : null, rho: w.rho });
  }
  // losses to counterparties of defaulted parties (unpaid call beyond IM held)
  const repoLosses = repoState.filter((rs) => rs.seized).map((rs) => ({ repo: `${rs.r.borrower}->${rs.r.lender}`, lender: rs.r.lender, loss: Math.max(0, rs.r.cashBorrowed - rs.r.collateralQty * price[ix.aIdx.get(rs.r.collateralAsset)]) }));
  const defaultLosses = nsList.filter((st) => defaulted[st.i]).map((st) => ({ netting_set: st.ns.id, defaulter: st.ns.party, counterparty: st.ns.counterparty ?? st.ns.ccp, unpaidCall: unmet[st.i], imHeld: postedValue(st), loss: Math.max(0, unmet[st.i] - postedValue(st)) }));
  const forcedSales = {}; // value sold by entity by asset (at the marks at the time of sale, approximated by final-round marks only for reporting)
  E.forEach((e, i) => { const row = {}; for (let k = 0; k < nA; k++) if (sold[i][k] > 0) row[A[k].id] = sold[i][k]; if (Object.keys(row).length) forcedSales[e.id] = row; });
  return {
    converged, rounds, netting: nsList.map((st) => ({ id: st.ns.id, party: st.ns.party, type: st.type, sigma: st.sigma, imBase: st.imBase, imRequired: st.imReq, imPostedBaseline: st.imPosted0, imPostedValueFinal: postedValue(st), variationMarginNet: st.vmNet })),
    entityCalls: E.map((e, i) => ({ id: e.id, ...calls[i], receipts: receipts[i], unmet: unmet[i], defaulted: defaulted[i], cashFinal: cash[i] })).filter((x) => x.vm || x.im || x.repo || x.marginLoan || x.receipts || x.defaulted),
    forcedSales, soldShares: Object.fromEntries(E.map((e, i) => [e.id, Object.fromEntries(A.map((a, k) => [a.id, sold[i][k]]).filter((x) => x[1] > 0))]).filter((x) => Object.keys(x[1]).length)), roundSalesByAsset: rounds.map((r) => r.salesByAsset ?? {}), work: W, collateralFireSales: fireSalesCollateral, finalPrices: Object.fromEntries(A.map((a, k) => [a.id, price[k]])), priceDeclines: Object.fromEntries(A.map((a, k) => [a.id, 1 - price[k] / price0[k]])),
    counterpartyExposure: cpty, defaultLosses, repoLosses, defaultedEntities: E.filter((_, i) => defaulted[i]).map((e) => e.id),
    totals: { margin: totalCalled, forcedSalesValue: sumArr(rounds.map((r) => r.sold)), unmet: sumArr(unmet) }, unobserved: [...new Set(unobserved)], lowerBoundReasons: [...lb],
  };
}

export function collateralParams(system, scenario, options = {}) {
  const c = system.collateral; const sc = scenario.collateral ?? {};
  return { mporDays: options.mporDays ?? c.mporDays, confidence: options.confidence ?? c.confidence, volMultiplier: sc.volMultiplier ?? 1 };
}

/** M63: Initial/variation margin, repo haircuts, eligibility/substitution, margin-call spiral with collateral fire sales, counterparty exposure and wrong-way risk. */
export function runCollateral(system, scenario = {}, options = {}) {
  const err = validateSystemState(system) || validateCollateral(system, scenario);
  if (err) return failed(ENGINE, MODEL_ID, err);
  const fresh = () => { const c = JSON.parse(JSON.stringify(system)); return [c, indexSystem(c)]; }; // the spiral mutates leveraged-debt bookkeeping: always on a copy
  const p = collateralParams(system, scenario, options);
  const [sysC, ix] = fresh();
  const out = collateralStress(sysC, scenario, p, ix);
  let status = STATUS.UNCALIBRATED; const notes = ['Margin/collateral spiral under stated assumptions (parametric IM, no calibration to CCP/bilateral margin models): UNCALIBRATED.'];
  if (!out.converged) { status = STATUS.MODEL_UNCERTAIN; notes.push('margin spiral did not converge'); } else if (out.unobserved.length) { status = STATUS.INSUFFICIENT_OBSERVABILITY; notes.push('unobserved inputs excluded: lower bound'); }
  const u = options.uncertainty ?? {};
  const uncertainty = parameterBand({ evaluate: (pp) => { const [cs, ci] = fresh(); return collateralStress(cs, scenario, { ...p, ...pp }, ci).totals.margin; }, params: p, keys: ['mporDays', 'volMultiplier'], ranges: u.ranges ?? {}, n: u.n ?? 16, seed: options.seed ?? 1, label: ENGINE });
  return makeResult({
    engine: ENGINE, modelId: MODEL_ID, status, value: { ...out, lowerBound: out.unobserved.length > 0, handoff: { forcedSales: out.forcedSales, priceDeclines: out.priceDeclines, defaultLosses: out.defaultLosses, defaultedEntities: out.defaultedEntities } },
    uncertainty, coverage: coverageOf(out.netting.length - out.unobserved.filter((x) => x.startsWith('im_posted')).length, Math.max(1, out.netting.length)), unobserved: out.unobserved, calibration: CALIBRATION.UNCALIBRATED,
    parameters: { ...p, correlation: system.collateral.correlation ?? 'NO_OFFSET', correlationBasis: system.collateral.correlation ? 'CALLER' : 'ASSUMED_NO_OFFSET_CONSERVATIVE', haircutScenario: scenario.collateral?.haircutAdd ?? {}, shocks: scenario.collateral?.priceShocks ?? {}, substitution: 'caller order, else non-cash eligible assets ascending by id, cash last (ASSUMED)', lgdDefault: 0.6 },
    inputHashes: [hashOf(system)], notes,
  });
}
