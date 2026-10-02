import { normalCdfPrecise, normalInv, normalPdf, isNum, unobs, cmp } from '../../core/numeric.js';
import { parseTime } from '../../data/observation.js';
import { sumArr } from './state.js';

/**
 * Central Credit Risk Shock Aggregator. Engines never mutate a borrower's PD: each emits `creditShockContribution`s and this module is the
 * ONLY place where PDs are stressed and expected-credit-loss is derived from them.
 *
 * Latent (probit) space, per creditBook row with base PD p0 (z0 = Phi^-1(p0)):
 *     z_pre   = z0 + sum_{k in dedup(PROBIT_SHIFT)} delta_k                (shifts add in latent space)
 *     z_final = f_m( ... f_1(z_pre) ),  f(z) = (z - sqrt(rho) g) / sqrt(1 - rho)     for FACTOR contributions, applied in shockId order
 *     PD      = Phi(z_final)  in [0,1] by construction;   dEL = EAD * LGD * (PD - p0)
 * Aumann-Shapley attribution of dEL to contributions (exact, order independent): a_k = delta_k * (dEL / S), S = z_final - z0 = sum delta_k
 * (S -> 0 limit: delta_k * EAD * LGD * phi(z0)).
 * Dedupe: contributions with the same (book, shockId) are ONE economic shock; the one with the largest |magnitude| is applied (ties by source name).
 * Missing: an UNOBSERVED contribution (observed:false) is never a zero; a real "no shock" is an observed contribution with magnitude 0.
 */
export const KINDS = Object.freeze(['PROBIT_SHIFT', 'FACTOR']);

const key = (entity, book) => `${entity}|${book}`;

/** Observed probit-space shift. `magnitude` in latent (standard-normal) units; positive worsens credit. */
export const probitContribution = ({ source, shockId, entity, book, magnitude, transformation, inputs = null, availableAt = null }) => ({ source, shockId, entity, book, kind: 'PROBIT_SHIFT', observed: true, magnitude, transformation, inputs, availableAt });
/** Observed systematic-factor transform (Vasicek-type) with asset correlation rho and factor realisation g (negative = stress). */
export const factorContribution = ({ source, shockId, entity, book, rho, g, transformation, inputs = null, availableAt = null }) => ({ source, shockId, entity, book, kind: 'FACTOR', observed: true, rho, g, magnitude: g, transformation, inputs, availableAt });
export const unobservedContribution = ({ source, shockId, entity, book, reason }) => ({ source, shockId, entity, book, kind: 'UNOBSERVED', observed: false, reason });

function check(c, asOf) {
  if (!c || !c.source || !c.shockId || !c.entity || !c.book) throw new Error('creditShock: source, shockId, entity and book are required');
  if (c.observed === false) return;
  if (c.kind === 'PROBIT_SHIFT') { if (!isNum(c.magnitude)) throw new Error(`creditShock ${c.shockId}: magnitude must be finite`); }
  else if (c.kind === 'FACTOR') { if (!(isNum(c.rho) && c.rho >= 0 && c.rho < 1) || !isNum(c.g)) throw new Error(`creditShock ${c.shockId}: FACTOR needs rho in [0,1) and finite g`); }
  else throw new Error(`creditShock ${c.shockId}: unknown kind ${c.kind}`);
  if (asOf !== null && c.availableAt !== null && c.availableAt !== undefined) {
    const t = typeof c.availableAt === 'number' ? c.availableAt : parseTime(c.availableAt);
    if (Number.isNaN(t)) throw new Error(`creditShock ${c.shockId}: availableAt invalid`);
    if (t > asOf) throw new Error(`look-ahead guard: credit shock ${c.shockId} from ${c.source} is available at ${new Date(t).toISOString()}, after asOf ${new Date(asOf).toISOString()}`);
  }
}

/**
 * ix: indexed system (entities with creditBook). contributions: array (any order). opts.asOf (ISO|ms|null), opts.excludeBooks: Set of "entity|book"
 * whose EL is booked elsewhere (e.g. by the private-credit engine) -- their PDs and provenance are still produced.
 */
export function aggregateCredit(ix, contributions, { asOf = null, excludeBooks = new Set() } = {}) {
  const asOfMs = asOf === null ? null : (typeof asOf === 'number' ? asOf : parseTime(asOf));
  if (asOf !== null && Number.isNaN(asOfMs)) throw new Error('aggregateCredit: asOf invalid');
  contributions.forEach((c) => check(c, asOfMs));
  const rows = new Map(); for (const e of ix.E) for (const b of e.creditBook || []) rows.set(key(e.id, b.id), { e, b });
  const byBook = new Map();
  for (const c of contributions) {
    const k = key(c.entity, c.book); if (!rows.has(k)) throw new Error(`creditShock ${c.shockId}: unknown creditBook row ${k}`);
    if (!byBook.has(k)) byBook.set(k, []); byBook.get(k).push(c);
  }
  const n = ix.n; const lossByEntity = new Array(n).fill(0); const lossBySource = {}; const lossBySourceEntity = {};
  const books = []; const unobserved = [];
  for (const k of [...byBook.keys()].sort(cmp)) {
    const { e, b } = rows.get(k); const list = byBook.get(k);
    const rec = { entity: e.id, book: b.id, amount: b.amount, lgd: b.lgd ?? null, pd0: b.pd ?? null, observed: !(unobs(b.pd) || unobs(b.lgd)), contributions: [], unobserved: [], excludedFromBooking: excludeBooks.has(k) };
    // dedupe by shockId
    const ids = [...new Set(list.map((c) => c.shockId))].sort(cmp); const applied = [];
    for (const id of ids) {
      const group = list.filter((c) => c.shockId === id);
      const obs = group.filter((c) => c.observed).sort((a, c2) => Math.abs(c2.magnitude) - Math.abs(a.magnitude) || cmp(a.source, c2.source) || cmp(a.kind, c2.kind));
      if (obs.length) {
        applied.push(obs[0]);
        rec.contributions.push({ source: obs[0].source, shockId: id, kind: obs[0].kind, magnitude: obs[0].magnitude, ...(obs[0].kind === 'FACTOR' ? { rho: obs[0].rho, g: obs[0].g } : {}), transformation: obs[0].transformation, inputs: obs[0].inputs ?? null, applied: true });
        for (const d of obs.slice(1)) rec.contributions.push({ source: d.source, shockId: id, kind: d.kind, magnitude: d.magnitude, transformation: d.transformation, applied: false, deduplicatedInto: obs[0].source });
        for (const u of group.filter((c) => !c.observed)) rec.contributions.push({ source: u.source, shockId: id, kind: 'UNOBSERVED', applied: false, deduplicatedInto: obs[0].source, reason: u.reason });
      } else {
        for (const u of group.slice().sort((a, c2) => cmp(a.source, c2.source))) { rec.unobserved.push({ source: u.source, shockId: id, reason: u.reason }); rec.contributions.push({ source: u.source, shockId: id, kind: 'UNOBSERVED', applied: false, reason: u.reason }); unobserved.push(`credit_shock:${u.source}:${e.id}:${b.id}`); }
      }
    }
    rec.incomplete = rec.unobserved.length > 0;
    if (!rec.observed) { rec.pdFinal = null; rec.pdPre = null; rec.loss = null; unobserved.push(`credit_book_inputs:${e.id}:${b.id}`); books.push(rec); continue; }
    const p0 = b.pd; const degenerate = !(p0 > 0 && p0 < 1);
    let z0 = null; let z = null; let zPre = null;
    if (!degenerate) {
      z0 = normalInv(p0); zPre = z0 + sumArr(applied.filter((c) => c.kind === 'PROBIT_SHIFT').map((c) => c.magnitude)); z = zPre;
      for (const f of applied.filter((c) => c.kind === 'FACTOR').sort((a, c2) => cmp(a.shockId, c2.shockId))) z = (z - Math.sqrt(f.rho) * f.g) / Math.sqrt(1 - f.rho);
      if (!Number.isFinite(z)) throw new Error(`creditShock aggregation for ${k} is not finite`);
    }
    rec.pdPre = degenerate ? p0 : Math.min(1, Math.max(0, normalCdfPrecise(zPre)));
    rec.pdFinal = degenerate ? p0 : Math.min(1, Math.max(0, normalCdfPrecise(z)));
    rec.z0 = z0; rec.zFinal = z; rec.probitShiftTotal = degenerate ? 0 : z - z0;
    if (degenerate) rec.contributions.forEach((c) => { if (c.applied) { c.applied = false; c.reason = 'DEGENERATE_BASE_PD (0 or 1): latent shift undefined, PD unchanged'; } });
    rec.loss = b.amount * b.lgd * (rec.pdFinal - p0);
    // Aumann-Shapley attribution along the straight path z0 -> z_final
    rec.lossBySource = {};
    if (!degenerate) {
      const S = z - z0; const grad = Math.abs(S) > 1e-12 ? rec.loss / S : b.amount * b.lgd * normalPdf(z0);
      // equivalent latent shift of each applied contribution (a FACTOR's equivalent shift is its state-dependent increment)
      let zc = zPre; const eq = new Map(); for (const c of applied.filter((x) => x.kind === 'PROBIT_SHIFT')) eq.set(c, c.magnitude);
      for (const f of applied.filter((c) => c.kind === 'FACTOR').sort((a, c2) => cmp(a.shockId, c2.shockId))) { const nz = (zc - Math.sqrt(f.rho) * f.g) / Math.sqrt(1 - f.rho); eq.set(f, nz - zc); zc = nz; }
      for (const [c, d] of eq) { const a = d * grad; rec.lossBySource[c.source] = (rec.lossBySource[c.source] || 0) + a; const row = rec.contributions.find((x) => x.shockId === c.shockId && x.applied); if (row) row.equivalentProbitShift = d; }
    }
    if (!rec.excludedFromBooking) {
      const i = ix.eIdx.get(e.id); lossByEntity[i] += rec.loss;
      for (const [s, a] of Object.entries(rec.lossBySource)) { lossBySource[s] = (lossBySource[s] || 0) + a; (lossBySourceEntity[s] ||= new Array(n).fill(0))[i] += a; }
    }
    books.push(rec);
  }
  return { books, lossByEntity, lossBySource, lossBySourceEntity, totalLoss: sumArr(lossByEntity), unobserved: [...new Set(unobserved)].sort(cmp) };
}
