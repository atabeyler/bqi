-- Rename the "quantum wins" verdict from QUANTUM_BENEFIT_OBSERVED to
-- QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD: a single knapsack instance
-- beating the classical baseline is a workload-scoped observation, never a
-- general scientific claim of "quantum advantage" -- the old name read too
-- close to that claim.
UPDATE quantum_benchmarks SET verdict = 'QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD' WHERE verdict = 'QUANTUM_BENEFIT_OBSERVED';

ALTER TABLE quantum_benchmarks DROP CONSTRAINT quantum_benchmarks_verdict_check;
ALTER TABLE quantum_benchmarks ADD CONSTRAINT quantum_benchmarks_verdict_check
  CHECK (verdict IN ('QUANTUM_BENEFIT_OBSERVED_FOR_THIS_WORKLOAD', 'NO_QUANTUM_ADVANTAGE_DEMONSTRATED'));
