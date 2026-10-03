/**
 * Keeps a Render free-plan web service from spinning down: Render stops an instance after ~15 minutes without inbound traffic, and the next
 * visitor then waits 20-60 s for a cold start. The service calls its own PUBLIC url (Render injects RENDER_EXTERNAL_URL), so the request goes
 * through Render's proxy and counts as traffic. No-op anywhere else (local dev, desktop, tests) because the variable is unset.
 * Costs one tiny request every `intervalMs` (default 150 s, well inside the 15-minute window). Note Render's free plan gives ~750 instance hours
 * a month across ALL free services of the workspace: one always-awake service fits (744 h), several do not.
 */
export function startSelfPing({ env = process.env, fetchImpl = globalThis.fetch, intervalMs = 150000, timeoutMs = 20000, log = { warn() {} } } = {}) {
  const base = env.RENDER_EXTERNAL_URL; if (!base || env.SELF_PING === 'off' || typeof fetchImpl !== 'function') return null;
  const url = `${String(base).replace(/\/+$/, '')}/api/health`;
  const timer = setInterval(() => {
    fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' }).catch((err) => log.warn({ err: err?.message }, '[selfPing] ping failed'));
  }, intervalMs);
  timer.unref?.(); // never keeps the process alive on its own
  return { url, stop: () => clearInterval(timer) };
}
