import { defineConfig } from 'vitest/config';

// Pure architecture/normalization checks that do not require PostgreSQL.
// The complete suite remains configured in vitest.config.js.
export default defineConfig({
  test: {
    environment: 'node',
    // The HTTP laboratory tests below exercise the production transport.
    include: ['test/pentest.unit.test.js', 'test/analysisPlanner.test.js', 'test/postureIntelligence.test.js', 'test/decisionIntelligence.test.js', 'test/aiNativeSecurity.test.js', 'test/risk.test.js', 'test/normalize.test.js', 'test/engines.activeScan.test.js', 'test/executionProfiles.test.js', 'test/scanExecution.test.js', 'test/worker.test.js', 'test/intrusiveRegistry.test.js', 'test/resilienceRegistry.test.js', 'test/resilienceLoadEngine.test.js', 'test/resilienceOrchestrator.test.js', 'test/resilienceJobTimeout.test.js', 'test/fuzzDiscovery.test.js', 'test/quantumProviders.test.js', 'test/controlledProof.unit.test.js', 'test/controlledProof.liveEngines.test.js', 'test/reportIntegrity.test.js', 'test/reportLocalization.test.js'],
    fileParallelism: false,
    env: { NODE_ENV: 'test', BCI_JWT_SECRET: 'test-secret', LOG_LEVEL: 'silent' },
  },
});
