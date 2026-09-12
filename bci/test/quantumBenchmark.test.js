import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg, createUser } from './helpers/db.js';
import { runBenchmark } from '../src/quantum/benchmark.js';

beforeEach(resetDatabase);

const PROBLEM = {
  items: [
    { id: 'a', value: 10, cost: 5 },
    { id: 'b', value: 6, cost: 3 },
    { id: 'c', value: 8, cost: 4 },
    { id: 'd', value: 3, cost: 2 },
  ],
  budget: 7,
};

describe('runBenchmark (integration) — spec section 8', () => {
  it('always runs classical and quantum-inspired, and reports NO_QUANTUM_ADVANTAGE for an instance classical already solves exactly', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const benchmark = await runBenchmark({ orgId, actorUserId: userId, workloadSource: 'test', problem: PROBLEM });

    expect(benchmark.results.classical).toBeDefined();
    expect(benchmark.results.quantum_inspired).toBeDefined();
    expect(benchmark.results.classical.objectiveValue).toBe(14);
    // Classical is exact for a knapsack -- nothing can beat 14, so the
    // verdict must never claim an advantage here, regardless of what
    // quantum-inspired happened to sample.
    expect(benchmark.verdict).toBe('NO_QUANTUM_ADVANTAGE_DEMONSTRATED');
  });

  it('never attempts quantum_simulator or ibm_quantum when org policy denies quantum (the default)', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const benchmark = await runBenchmark({ orgId, actorUserId: userId, workloadSource: 'test', problem: PROBLEM });
    expect(benchmark.results.quantum_simulator).toBeUndefined();
    expect(benchmark.results.ibm_quantum).toBeUndefined();
    expect(benchmark.executionMode).toBe('CLASSICAL');
  });

  it('records one quantum_jobs row per provider attempt and one quantum_benchmarks row', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const benchmark = await runBenchmark({ orgId, actorUserId: userId, workloadSource: 'test', problem: PROBLEM });

    const { rows: jobs } = await query('SELECT provider, status, input_hash FROM quantum_jobs WHERE benchmark_id = $1', [benchmark.benchmarkId]);
    expect(jobs.map((j) => j.provider).sort()).toEqual(['classical', 'quantum_inspired']);
    expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);
    expect(new Set(jobs.map((j) => j.input_hash)).size).toBe(1); // same problem instance for both attempts

    const { rows: benchmarks } = await query('SELECT verdict FROM quantum_benchmarks WHERE id = $1', [benchmark.benchmarkId]);
    expect(benchmarks).toHaveLength(1);
  });

  it('a failed provider attempt is recorded as FAILED, not silently dropped', async () => {
    const orgId = await createOrg();
    const userId = await createUser(orgId, { roleId: 'operator' });

    const badProblem = { items: PROBLEM.items, budget: -1 };
    const benchmark = await runBenchmark({ orgId, actorUserId: userId, workloadSource: 'test', problem: badProblem });
    expect(benchmark.results.classical.error).toBeDefined();

    const { rows: jobs } = await query(
      "SELECT status, fallback_reason FROM quantum_jobs WHERE benchmark_id = $1 AND provider = 'classical'",
      [benchmark.benchmarkId]
    );
    expect(jobs[0].status).toBe('FAILED');
    expect(jobs[0].fallback_reason).toMatch(/non-negative integer/);
  });
});
