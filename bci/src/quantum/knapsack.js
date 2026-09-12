// Shared 0/1 knapsack helpers -- the classical, quantum-inspired, and
// quantum-simulator providers all solve the SAME problem instance so their
// results are actually comparable (spec section 8's Benchmark Engine).

export function evaluateSelection(items, selectedIds, budget) {
  const selected = new Set(selectedIds);
  let value = 0;
  let cost = 0;
  for (const item of items) {
    if (selected.has(item.id)) {
      value += item.value;
      cost += item.cost;
    }
  }
  return { value, cost, feasible: cost <= budget };
}

// Exact dynamic-programming solver -- pseudo-polynomial in `budget`, exact
// (provably optimal) for integer costs. This IS the classical baseline the
// spec requires to exist unconditionally (section 11): "Classical baseline
// mutlaka olsun."
export function solveKnapsackExact(items, budget) {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`budget must be a non-negative integer, got ${budget}`);
  }
  const n = items.length;
  // dp[c] = best value achievable with total cost <= c
  const dp = new Array(budget + 1).fill(0);
  const choice = Array.from({ length: n }, () => new Array(budget + 1).fill(false));

  for (let i = 0; i < n; i++) {
    const { cost, value } = items[i];
    for (let c = budget; c >= cost; c--) {
      if (dp[c - cost] + value > dp[c]) {
        dp[c] = dp[c - cost] + value;
        choice[i][c] = true;
      }
    }
  }

  // Reconstruct the selection from the highest-cost row that hit the optimum.
  let bestCost = budget;
  for (let c = 0; c <= budget; c++) {
    if (dp[c] === dp[budget]) { bestCost = c; break; }
  }
  const selectedIds = [];
  let remaining = bestCost;
  for (let i = n - 1; i >= 0; i--) {
    if (choice[i][remaining]) {
      selectedIds.push(items[i].id);
      remaining -= items[i].cost;
    }
  }

  return { selectedIds, objectiveValue: dp[budget] };
}
