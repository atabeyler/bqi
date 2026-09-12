import { query } from '../db/client.js';
import { findReachableAssets } from './securityGraph.js';
import { runBenchmark } from '../quantum/benchmark.js';

const OPEN_STATUSES = ['NEW', 'CONFIRMED', 'ASSIGNED', 'IN_REMEDIATION', 'READY_FOR_VERIFICATION', 'DEFERRED'];

// Remediation effort is a documented HEURISTIC by finding category, not a
// precise cost model BCI has no basis to claim (spec section 27: don't
// overclaim). A code-level fix (SAST/SCA/SECRETS/IAC) genuinely tends to
// cost more engineering time than a config-level one (a missing header, an
// open port) -- this is enough variation to make remediation selection a
// real (non-trivial) constrained optimization problem rather than a plain
// top-K sort, which is the whole point of exercising the Benchmark Engine.
const EFFORT_BY_CATEGORY = { SAST: 2, SCA: 2, SECRETS: 2, IAC: 2, WEB: 1, API: 1, NETWORK_DISCOVERY: 1 };
function estimateEffort(category) {
  return EFFORT_BY_CATEGORY[category] ?? 1;
}

// BCI Quantum Risk/Remediation Optimizer (spec section 10-11): an advisory
// layer ON TOP OF the deterministic Risk Score (M9) -- it never changes a
// Finding's own risk_score, it only proposes an order/subset to work on
// under a stated effort budget. Blast radius (how many CRITICAL/HIGH assets
// a finding's asset can reach, from the Security Graph, M10) multiplies a
// finding's value here, so a medium-risk finding on a heavily-connected
// asset can outrank a higher-risk but isolated one.
export async function buildRemediationProblem(orgId, { findingIds } = {}) {
  const { rows: findings } = await query(
    `SELECT f.id, f.title, f.category, f.target, f.risk_score
       FROM findings f
      WHERE f.org_id = $1 AND f.status = ANY($2) AND f.risk_score IS NOT NULL
        ${findingIds?.length ? 'AND f.id = ANY($3)' : ''}`,
    findingIds?.length ? [orgId, OPEN_STATUSES, findingIds] : [orgId, OPEN_STATUSES]
  );

  const items = [];
  for (const finding of findings) {
    const { rows: assetRows } = await query(
      `SELECT a.id, a.criticality FROM assets a JOIN asset_identifiers ai ON ai.asset_id = a.id
        WHERE a.org_id = $1 AND ai.value = $2 LIMIT 1`,
      [orgId, finding.target]
    );
    let blastRadiusMultiplier = 1;
    if (assetRows[0]) {
      const reachable = await findReachableAssets(orgId, assetRows[0].id);
      const criticalCount = reachable.filter((r) => r.criticality === 'CRITICAL' || r.criticality === 'HIGH').length;
      blastRadiusMultiplier = 1 + 0.1 * criticalCount;
    }

    items.push({
      id: finding.id,
      value: Math.round(finding.risk_score * blastRadiusMultiplier),
      cost: estimateEffort(finding.category),
      title: finding.title,
    });
  }

  return items;
}

// findingIds (optional) scopes the optimization problem to one scan job's
// real results (spec flow: TARAMA -> BULGULAR/RİSK -> seçilen Quantum
// yöntemi -> OPTİMİZASYON) instead of every open finding org-wide -- the
// existing QuantumTab call (no findingIds) keeps optimizing org-wide,
// unchanged. preferredMode is the wizard's real per-run compute-method
// choice, passed straight through to the real fallback chain
// (executionPolicy.js) -- never bypassing it.
export async function optimizeRemediation({ orgId, actorUserId, effortBudget, dataClassification = 'INTERNAL', findingIds, preferredMode, scanJobId }) {
  const items = await buildRemediationProblem(orgId, { findingIds });
  if (items.length === 0) {
    // Distinct from NO_QUANTUM_ADVANTAGE_DEMONSTRATED: there was no
    // optimization problem to run at all, not a benchmark that ran and
    // came back even/worse than classical. No quantum_benchmarks row is
    // written -- there was nothing to benchmark.
    let recommendedMode = null;
    let selectedMode = preferredMode ?? null;
    if (scanJobId) {
      const { rows } = await query(
        `SELECT recommended_compute_mode, selected_compute_mode
           FROM scan_jobs WHERE id = $1 AND org_id = $2`,
        [scanJobId, orgId]
      );
      recommendedMode = rows[0]?.recommended_compute_mode ?? null;
      selectedMode = rows[0]?.selected_compute_mode ?? selectedMode;
    }
    return {
      benchmarkId: null,
      verdict: 'NOT_APPLICABLE',
      // Selection provenance still exists even though no compute actually
      // ran. Keep recommended/selected visible and leave only actualMode
      // null; otherwise the result UI misleadingly renders three dashes.
      recommendedMode,
      selectedMode,
      actualMode: null,
      fallbackReason: null,
      selectedFindingIds: [],
      optimizationObjective: 0,
      note: findingIds?.length ? 'no risk-scored open findings in this scan\'s results' : 'no open findings with a computed risk score',
    };
  }

  const problem = { items: items.map(({ title: _title, ...rest }) => rest), budget: effortBudget };
  const benchmark = await runBenchmark({ orgId, actorUserId, workloadSource: 'remediation_optimizer', problem, dataClassification, preferredMode, scanJobId });

  const titleById = new Map(items.map((i) => [i.id, i.title]));
  const selection = benchmark.best
    ? benchmark.best.selectedIds.map((id) => ({ findingId: id, title: titleById.get(id) }))
    : [];

  return {
    benchmarkId: benchmark.benchmarkId,
    verdict: benchmark.verdict,
    executionMode: benchmark.executionMode,
    recommendedMode: benchmark.recommendedMode,
    selectedMode: benchmark.selectedMode,
    actualMode: benchmark.actualMode,
    fallbackReason: benchmark.fallbackReason,
    selectedFindingIds: selection.map((s) => s.findingId),
    selection,
    // The knapsack's summed value (risk_score x blast-radius multiplier) of
    // the selected findings -- the optimizer's own objective function, NOT
    // a measured or validated real-world enterprise risk reduction. Named
    // for what it actually is; see spec section 10's terminology note.
    optimizationObjective: benchmark.best?.objectiveValue ?? 0,
    results: benchmark.results,
  };
}
