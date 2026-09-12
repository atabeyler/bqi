const metrics = new Map();

// Test-only: clears all recorded metrics so tests that depend on this
// module's ordering (e.g. aiProviders.ts's pickProviderOrder) don't leak
// state between `it()` blocks that share the same module instance.
export function resetRequestMetrics() {
  metrics.clear();
}

export function recordRequestMetric(name, durationMs, statusCode = 200) {
  const entry = metrics.get(name) || { count: 0, errors: 0, durations: [] };
  entry.count += 1;
  if (statusCode >= 500) entry.errors += 1;
  entry.durations.push(Math.max(0, Number(durationMs) || 0));
  if (entry.durations.length > 500) entry.durations.splice(0, entry.durations.length - 500);
  metrics.set(name, entry);
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

export function getMetricsSnapshot() {
  return Array.from(metrics.entries()).map(([name, entry]) => ({
    name,
    count: entry.count,
    errors: entry.errors,
    errorRate: entry.count ? Math.round((entry.errors / entry.count) * 1000) / 10 : 0,
    p50Ms: percentile(entry.durations, 50),
    p95Ms: percentile(entry.durations, 95),
    maxMs: entry.durations.length ? Math.max(...entry.durations) : 0,
  }));
}

export function requestMetricsMiddleware(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const routeName = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path || ''}`;
    recordRequestMetric(routeName, Date.now() - started, res.statusCode);
  });
  next();
}
