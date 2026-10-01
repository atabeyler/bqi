import { runCascade } from './cascade.js';
import { makeResult, failed, STATUS, CALIBRATION } from '../core/result.js';
import { deepClone } from '../core/canonical.js';

const ENGINE = 'counterfactual';

/** Removes common-asset overlap by giving every fund private copies of each asset (same price/liquidity parameters). */
export function disjointify(system) {
  const s = deepClone(system);
  const assets = [];
  for (const f of s.funds) {
    f.holdings = (f.holdings || []).map((h) => ({ ...h, asset: `${h.asset}::${f.id}` }));
  }
  for (const f of s.funds) for (const h of f.holdings) {
    const base = system.assets.find((a) => a.id === h.asset.split('::')[0]);
    assets.push({ ...base, id: h.asset });
  }
  s.assets = assets;
  return s;
}

const outcome = (res) => ({ lossFraction: res.value.system.lossFractionOfNav, totalLoss: res.value.system.totalLoss, failedFunds: res.value.system.failedFunds.length, forcedSales: res.value.system.totalForcedSales });

/**
 * Structural, model-based counterfactuals on the SAME snapshot and parameters.
 * NOT causal identification from observational data: it states what the model implies.
 */
export function counterfactuals(system, scenario, options = {}) {
  const base = runCascade(system, scenario, options);
  if (!base.value) return failed(ENGINE, 'M15.counterfactual', base.error || 'baseline failed');
  const b = outcome(base);
  const variants = {};
  const add = (name, res) => { variants[name] = res.value ? { ...outcome(res), delta: { lossFraction: outcome(res).lossFraction - b.lossFraction, failedFunds: outcome(res).failedFunds - b.failedFunds }, status: res.status } : { error: res.error }; };
  add('no_margin_channel', runCascade(system, scenario, { ...options, channels: { ...(options.channels || {}), margin: false } }));
  add('no_secondary_redemption', runCascade(system, scenario, { ...options, channels: { ...(options.channels || {}), secondary: false } }));
  add('no_counterparty_channel', runCascade(system, scenario, { ...options, channels: { ...(options.channels || {}), counterparty: false } }));
  add('no_common_asset_overlap', runCascade(disjointify(system), { ...scenario, priceShocks: expandShocks(scenario.priceShocks, system) }, options));
  add('impact_halved', runCascade({ ...system, impact: { ...system.impact, scale: (system.impact.scale ?? 1) * 0.5 } }, scenario, options));
  const gated = { ...scenario, redemptions: Object.fromEntries(Object.entries(scenario.redemptions || {}).map(([k, v]) => [k, typeof v === 'number' ? v * 0.5 : v.fraction !== undefined ? { fraction: v.fraction * 0.5 } : { amount: v.amount * 0.5 }])) };
  add('redemption_gate_50pct', runCascade(system, gated, options));
  return makeResult({
    engine: ENGINE, modelId: 'M15.counterfactual', status: base.status === STATUS.COMPUTATION_FAILED ? STATUS.COMPUTATION_FAILED : STATUS.UNCALIBRATED,
    value: { baseline: b, variants }, calibration: CALIBRATION.UNCALIBRATED, unobserved: base.unobserved, parameters: { options, scenario },
    notes: ['model-based structural counterfactuals; not causal identification from data'],
  });
}

function expandShocks(shocks = {}, system) {
  const out = {};
  for (const [asset, s] of Object.entries(shocks)) for (const f of system.funds) if ((f.holdings || []).some((h) => h.asset === asset)) out[`${asset}::${f.id}`] = s;
  return out;
}
