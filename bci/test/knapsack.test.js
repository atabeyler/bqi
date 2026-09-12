import { describe, it, expect } from 'vitest';
import { solveKnapsackExact, evaluateSelection } from '../src/quantum/knapsack.js';

describe('solveKnapsackExact (pure, classical baseline)', () => {
  it('finds the provably optimal selection for a small hand-checkable instance', () => {
    const items = [
      { id: 'a', value: 10, cost: 5 },
      { id: 'b', value: 6, cost: 3 },
      { id: 'c', value: 8, cost: 4 },
      { id: 'd', value: 3, cost: 2 },
    ];
    // b+c = cost 7, value 14 -- beats a+d (cost 7, value 13) and any single item.
    const { selectedIds, objectiveValue } = solveKnapsackExact(items, 7);
    expect(objectiveValue).toBe(14);
    expect(selectedIds.sort()).toEqual(['b', 'c']);
  });

  it('takes everything when the budget is not binding', () => {
    const items = [{ id: 'a', value: 5, cost: 1 }, { id: 'b', value: 3, cost: 1 }];
    const { selectedIds, objectiveValue } = solveKnapsackExact(items, 100);
    expect(selectedIds.sort()).toEqual(['a', 'b']);
    expect(objectiveValue).toBe(8);
  });

  it('selects nothing when the budget is zero', () => {
    const items = [{ id: 'a', value: 5, cost: 1 }];
    expect(solveKnapsackExact(items, 0)).toEqual({ selectedIds: [], objectiveValue: 0 });
  });

  it('the reconstructed selection actually respects the budget', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, value: (i * 7) % 13, cost: (i % 5) + 1 }));
    const { selectedIds, objectiveValue } = solveKnapsackExact(items, 10);
    const check = evaluateSelection(items, selectedIds, 10);
    expect(check.feasible).toBe(true);
    expect(check.value).toBe(objectiveValue);
  });
});
