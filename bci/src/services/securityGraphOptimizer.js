import { loadStructuralGraph } from './securityGraph.js';

// Defense only (spec section 9): every function here reads the graph and
// ranks/recommends -- none of them ever attempts exploitation, and none of
// them mutate the graph. Inputs are exactly what syncSecurityGraph already
// derived from real assets/relationships/findings; nothing here invents a
// path that isn't backed by a real structural edge.
const CRITICAL_CRITICALITIES = new Set(['CRITICAL', 'HIGH']);

function bfsWithParents(adjacency, startNodeId) {
  const visited = new Set([startNodeId]);
  const parent = new Map();
  const queue = [startNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, current);
        queue.push(next);
      }
    }
  }
  return { visited, parent };
}

function reconstructPath(parent, startNodeId, targetNodeId) {
  const path = [targetNodeId];
  let current = targetNodeId;
  while (current !== startNodeId) {
    current = parent.get(current);
    path.push(current);
  }
  path.reverse();
  return path;
}

// Attack-path prioritization: for every vulnerability with a real
// AFFECTED_BY edge to an asset, how far could an attacker who compromised
// that asset actually reach, and how much of that reach is critical/high
// systems? priorityScore is a documented heuristic (risk score weighted by
// how many critical/high assets are reachable), not a calibrated
// probability -- the same honesty standard applied to the Risk Score and
// the Remediation Optimizer's cost model.
export async function computeAttackPathPriorities(orgId) {
  const { nodesById, adjacency, vulnEdges } = await loadStructuralGraph(orgId);

  const results = vulnEdges.map((edge) => {
    const originNode = nodesById.get(edge.asset_node_id);
    if (!originNode) return null;

    const { visited } = bfsWithParents(adjacency, edge.asset_node_id);
    visited.delete(edge.asset_node_id);
    const reachableNodes = [...visited].map((id) => nodesById.get(id)).filter(Boolean);
    const criticalReachable = reachableNodes.filter((n) => CRITICAL_CRITICALITIES.has(n.criticality));

    const riskScore = edge.risk_score != null ? Number(edge.risk_score) : 0;
    const priorityScore = riskScore * (1 + criticalReachable.length);

    return {
      cveId: edge.cve_id,
      originAssetId: originNode.asset_id,
      originAssetLabel: originNode.label,
      riskScore,
      blastRadiusCount: reachableNodes.length,
      criticalBlastRadiusCount: criticalReachable.length,
      criticalAssetsAtRisk: criticalReachable.map((n) => ({ assetId: n.asset_id, label: n.label, criticality: n.criticality })),
      priorityScore,
    };
  }).filter(Boolean);

  results.sort((a, b) => b.priorityScore - a.priorityScore);
  return results;
}

// Patch ordering (spec section 9): the same attack-path analysis, presented
// as a ranked remediation sequence with an explicit, readable reason per
// item rather than a bare score.
export async function computePatchOrder(orgId) {
  const priorities = await computeAttackPathPriorities(orgId);
  return priorities.map((p, index) => ({
    rank: index + 1,
    cveId: p.cveId,
    originAssetLabel: p.originAssetLabel,
    reason:
      p.criticalBlastRadiusCount > 0
        ? `reachable from a compromised ${p.originAssetLabel} to ${p.criticalBlastRadiusCount} critical/high-criticality asset(s) within the security graph`
        : `affects ${p.originAssetLabel}; no critical/high-criticality asset reachable from it in the current graph`,
    priorityScore: p.priorityScore,
  }));
}

// Defensive control placement (spec section 9): which structural nodes sit
// on the most real shortest paths between a vulnerable entry point and a
// critical/high-criticality asset? A control (segmentation boundary,
// monitoring, WAF, jump host hardening) placed at a high-scoring node
// protects multiple attack paths at once -- this is a graph-centrality
// heuristic (path pass-through count), not a claim that the control is
// sufficient or that these are the only paths that will ever exist.
export async function identifyDefensiveControlPlacements(orgId, topN = 5) {
  const { nodesById, adjacency, vulnEdges } = await loadStructuralGraph(orgId);

  const passThroughCount = new Map(); // nodeId -> count
  const protectsCriticalAssets = new Map(); // nodeId -> Set(assetId)

  for (const edge of vulnEdges) {
    if (!nodesById.has(edge.asset_node_id)) continue;
    const { visited, parent } = bfsWithParents(adjacency, edge.asset_node_id);
    for (const targetNodeId of visited) {
      if (targetNodeId === edge.asset_node_id) continue;
      const targetNode = nodesById.get(targetNodeId);
      if (!targetNode || !CRITICAL_CRITICALITIES.has(targetNode.criticality)) continue;

      const path = reconstructPath(parent, edge.asset_node_id, targetNodeId);
      // Intermediate hops only -- the vulnerable entry point and the
      // critical destination are the two ends of the path being protected,
      // not themselves "placement" candidates for a control between them.
      for (const hopId of path.slice(1, -1)) {
        passThroughCount.set(hopId, (passThroughCount.get(hopId) || 0) + 1);
        if (!protectsCriticalAssets.has(hopId)) protectsCriticalAssets.set(hopId, new Set());
        protectsCriticalAssets.get(hopId).add(targetNode.asset_id);
      }
    }
  }

  const ranked = [...passThroughCount.entries()]
    .map(([nodeId, count]) => {
      const node = nodesById.get(nodeId);
      return {
        assetId: node.asset_id,
        label: node.label,
        criticality: node.criticality,
        attackPathsThrough: count,
        protectsCriticalAssetCount: protectsCriticalAssets.get(nodeId).size,
      };
    })
    .sort((a, b) => b.attackPathsThrough - a.attackPathsThrough)
    .slice(0, topN);

  return ranked;
}
