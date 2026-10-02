import { isNum, isNonNeg, isFrac, unobs } from '../../core/numeric.js';
import { validateImpactModel } from '../impact.js';

/**
 * Shared SystemState vocabulary for every vNext systemic engine and the Financial System Digital Twin.
 * One entity/exposure network; engines add their own sections but never their own entity schemas.
 *
 *  system = { assets[], impact?, entities[], exposures[], ...engine sections }
 *  asset  = { id, price>0, class?, illiq?, sigma?, advValue?, duration?, convexity?, riskSector? }   (extends the M10 asset)
 *  entity = { id, sector, cash>=0, holdings?:[{asset, shares, book?:'MARKET'|'HTM'}],
 *             creditBook?:[{id, amount>=0, pd|null, lgd|null, riskSector?, fcy?}],
 *             externalAssets: number|null, externalLiabilities: number|null, ...engine attributes }
 *  exposure = { creditor, debtor, amount>=0|null, kind?, currency?:'LCY'|'FCY', crossBorder?:bool }
 *
 * null (or omitted) externalAssets / externalLiabilities / amounts / pd / lgd == UNOBSERVED, never zero.
 */
export const SECTORS = Object.freeze(['BANK', 'FUND', 'INSURER', 'CORPORATE', 'SOVEREIGN', 'HOUSEHOLD', 'FOREIGN_INVESTOR', 'CCP', 'PRIVATE_CREDIT', 'STABLECOIN', 'DEFI', 'SERVICE_PROVIDER', 'OTHER']);
export const SECTOR_SET = new Set(SECTORS);
export const LIMITS_SYSTEMIC = Object.freeze({ entities: 400, exposures: 20000, assets: 2000, creditBook: 200, holdings: 500 });

/** Returns an error string or null. `requireImpact` for engines that sell assets. */
export function validateSystemState(system, { requireImpact = false } = {}) {
  if (!system || typeof system !== 'object') return 'system required';
  if (!Array.isArray(system.entities) || !system.entities.length) return 'system.entities (non-empty array) required';
  if (system.entities.length > LIMITS_SYSTEMIC.entities) return `system.entities exceeds ${LIMITS_SYSTEMIC.entities}`;
  const assets = system.assets ?? [];
  if (!Array.isArray(assets) || assets.length > LIMITS_SYSTEMIC.assets) return 'system.assets must be an array within limits';
  const aids = new Set();
  for (const a of assets) {
    if (!a || !a.id || aids.has(a.id)) return `duplicate/missing asset id ${a?.id}`;
    aids.add(a.id);
    if (!(isNum(a.price) && a.price > 0)) return `asset ${a.id}: price must be > 0`;
    for (const k of ['illiq', 'sigma', 'advValue', 'duration', 'convexity']) if (!unobs(a[k]) && !(isNum(a[k]) && a[k] >= 0)) return `asset ${a.id}: ${k} must be null or >= 0`;
  }
  if (requireImpact || system.impact) { const e = validateImpactModel(system.impact); if (e) return e; }
  const ids = new Set();
  for (const e of system.entities) {
    if (!e || !e.id || ids.has(e.id)) return `duplicate/missing entity id ${e?.id}`;
    ids.add(e.id);
    if (!SECTOR_SET.has(e.sector)) return `entity ${e.id}: unknown sector ${e.sector}`;
    if (!isNonNeg(e.cash)) return `entity ${e.id}: cash must be a finite number >= 0 (explicit)`;
    for (const k of ['externalAssets', 'externalLiabilities']) if (!unobs(e[k]) && !isNonNeg(e[k])) return `entity ${e.id}: ${k} must be null (unobserved) or >= 0`;
    if ((e.holdings?.length ?? 0) > LIMITS_SYSTEMIC.holdings || (e.creditBook?.length ?? 0) > LIMITS_SYSTEMIC.creditBook) return `entity ${e.id}: holdings/creditBook exceed limits`;
    for (const h of e.holdings || []) {
      if (!aids.has(h.asset)) return `entity ${e.id}: unknown asset ${h.asset}`;
      if (!isNonNeg(h.shares)) return `entity ${e.id}: negative/invalid shares`;
      if (h.book !== undefined && !['MARKET', 'HTM'].includes(h.book)) return `entity ${e.id}: holding book must be MARKET|HTM`;
    }
    const cb = new Set();
    for (const c of e.creditBook || []) {
      if (!c.id || cb.has(c.id)) return `entity ${e.id}: duplicate/missing creditBook id`;
      cb.add(c.id);
      if (!isNonNeg(c.amount)) return `entity ${e.id}: creditBook ${c.id} amount must be >= 0`;
      if (!unobs(c.pd) && !isFrac(c.pd)) return `entity ${e.id}: creditBook ${c.id} pd must be null or in [0,1]`;
      if (!unobs(c.lgd) && !isFrac(c.lgd)) return `entity ${e.id}: creditBook ${c.id} lgd must be null or in [0,1]`;
    }
  }
  const ex = system.exposures ?? [];
  if (!Array.isArray(ex) || ex.length > LIMITS_SYSTEMIC.exposures) return 'system.exposures must be an array within limits';
  for (const x of ex) {
    if (!ids.has(x.creditor) || !ids.has(x.debtor)) return `exposure ${x.creditor}->${x.debtor}: unknown entity`;
    if (x.creditor === x.debtor) return `exposure ${x.creditor}: self-exposure not allowed`;
    if (!unobs(x.amount) && !isNonNeg(x.amount)) return `exposure ${x.creditor}->${x.debtor}: amount must be null or >= 0`;
    if (x.currency !== undefined && !['LCY', 'FCY'].includes(x.currency)) return 'exposure currency must be LCY|FCY';
  }
  return null;
}

/** Indexed, numeric view of a validated system (arrays, no mutation of input). */
export function indexSystem(system) {
  const E = system.entities; const A = system.assets ?? [];
  const eIdx = new Map(E.map((e, i) => [e.id, i]));
  const aIdx = new Map(A.map((a, i) => [a.id, i]));
  const n = E.length; const nA = A.length;
  const q = E.map((e) => { const row = new Array(nA).fill(0); for (const h of e.holdings || []) row[aIdx.get(h.asset)] += h.shares; return row; });
  const htm = E.map((e) => { const row = new Array(nA).fill(0); for (const h of e.holdings || []) if (h.book === 'HTM') row[aIdx.get(h.asset)] += h.shares; return row; });
  const edges = (system.exposures ?? []).map((x) => ({ c: eIdx.get(x.creditor), d: eIdx.get(x.debtor), amount: unobs(x.amount) ? null : x.amount, raw: x }));
  return { E, A, eIdx, aIdx, n, nA, q, htm, edges, price: A.map((a) => a.price) };
}

/** Marked (MARKET-book) value of an entity's holdings; HTM holdings are carried at cost price0 (not marked) and reported separately. */
export function holdingsValue(ix, i, price) {
  let market = 0; let htmCarry = 0; let htmMark = 0;
  for (let k = 0; k < ix.nA; k++) {
    const total = ix.q[i][k]; if (!total) continue;
    const h = ix.htm[i][k];
    market += (total - h) * price[k];
    htmCarry += h * ix.A[k].price;
    htmMark += h * price[k];
  }
  return { market, htmCarry, htmMark, carried: market + htmCarry };
}

export const sumArr = (a) => a.reduce((s, x) => s + x, 0);

/** Largest-remainder-free proportional split helper: returns weights summing to 1 (or null when total is 0). */
export function proportions(values) {
  const t = sumArr(values);
  return t > 0 ? values.map((v) => v / t) : null;
}
