#!/usr/bin/env node
/**
 * BQI lightweight load/stress test tool.
 *
 * Fires concurrent requests at a target endpoint for a fixed duration and
 * reports throughput, latency percentiles and error rate -- zero
 * dependencies (uses global fetch), so it needs nothing beyond Node itself.
 *
 * This script is a TOOL, not a result: it is not run against any deployed
 * environment automatically -- point it at a target explicitly when you
 * want to load-test it.
 *
 * Usage:
 *   node scripts/load-test.js [options]
 *
 * Options (env vars or flags, flags take precedence):
 *   --url <url>            Target URL (default: http://localhost:10000/api/platform/health/live)
 *   --concurrency <n>      Concurrent in-flight requests (default: 20)
 *   --duration <seconds>   How long to run (default: 30)
 *   --method <GET|POST>    HTTP method (default: GET)
 *   --token <jwt>          Bearer token for authenticated endpoints
 *   --body <json>          JSON request body (for POST)
 *
 * Examples:
 *   node scripts/load-test.js --url http://localhost:10000/api/platform/health/live
 *   node scripts/load-test.js --url http://localhost:10000/api/analysis/status --concurrency 50 --duration 60
 *   node scripts/load-test.js --url http://localhost:10000/api/analysis/generate \
 *     --method POST --token "$JWT" --body '{"category":"ekonomi","prompt":"test"}' \
 *     --concurrency 5 --duration 60
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args[key] = value;
      if (value !== 'true') i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const URL_TARGET = args.url || process.env.LOAD_TEST_URL || 'http://localhost:10000/api/platform/health/live';
const CONCURRENCY = Number(args.concurrency || process.env.LOAD_TEST_CONCURRENCY || 20);
const DURATION_MS = Number(args.duration || process.env.LOAD_TEST_DURATION || 30) * 1000;
const METHOD = (args.method || 'GET').toUpperCase();
const TOKEN = args.token || process.env.LOAD_TEST_TOKEN || null;
const BODY = args.body || null;

function percentile(sortedValues, pct) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((pct / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

async function fireOne(durations, statusCounts) {
  const startedAt = Date.now();
  try {
    const res = await fetch(URL_TARGET, {
      method: METHOD,
      headers: {
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(BODY ? { 'content-type': 'application/json' } : {}),
      },
      body: BODY || undefined,
      signal: AbortSignal.timeout(30000),
    });
    await res.arrayBuffer(); // drain the body so the connection can be reused
    durations.push(Date.now() - startedAt);
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
  } catch (err) {
    durations.push(Date.now() - startedAt);
    statusCounts.error = (statusCounts.error || 0) + 1;
    statusCounts.errorMessage = err?.message || String(err);
  }
}

async function worker(deadline, durations, statusCounts) {
  while (Date.now() < deadline) {
    await fireOne(durations, statusCounts);
  }
}

async function main() {
  console.log(`BQI load test`);
  console.log(`  target:      ${METHOD} ${URL_TARGET}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  duration:    ${DURATION_MS / 1000}s`);
  console.log('');

  const durations = [];
  const statusCounts = {};
  const deadline = Date.now() + DURATION_MS;

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(deadline, durations, statusCounts)));
  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const sorted = [...durations].sort((a, b) => a - b);
  const total = durations.length;
  const errors = statusCounts.error || 0;
  const serverErrors = Object.entries(statusCounts)
    .filter(([status]) => status !== 'error' && status !== 'errorMessage' && Number(status) >= 500)
    .reduce((sum, [, count]) => sum + count, 0);

  console.log('Results:');
  console.log(`  total requests:   ${total}`);
  console.log(`  throughput:       ${(total / elapsedSeconds).toFixed(1)} req/s`);
  console.log(`  p50 latency:      ${percentile(sorted, 50)}ms`);
  console.log(`  p95 latency:      ${percentile(sorted, 95)}ms`);
  console.log(`  p99 latency:      ${percentile(sorted, 99)}ms`);
  console.log(`  max latency:      ${sorted.at(-1) || 0}ms`);
  console.log(`  network errors:   ${errors}${statusCounts.errorMessage ? ` (e.g. "${statusCounts.errorMessage}")` : ''}`);
  console.log(`  5xx responses:    ${serverErrors}`);
  console.log('  status breakdown:', JSON.stringify(
    Object.fromEntries(Object.entries(statusCounts).filter(([k]) => k !== 'errorMessage'))
  ));
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
