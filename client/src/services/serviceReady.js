// Only safe readiness GETs are retried. Credentials and mutating requests
// must be submitted once, after the API and its database are ready.
export async function waitForService(url, { timeoutMs = 120000, pollMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10000, deadline - Date.now()));
    try {
      const response = await fetchImpl(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (response.ok && String(body?.status).toLowerCase() === 'ok') return;
      if ([401, 403, 404].includes(response.status)) {
        const error = new Error('Service readiness endpoint unavailable');
        error.code = 'SERVICE_NOT_READY';
        throw error;
      }
    } catch (error) {
      // A real network failure still reaches the native offline-login path.
      if (error.name !== 'AbortError') throw error;
    } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
  const error = new Error('Service startup timed out');
  error.code = 'SERVICE_NOT_READY';
  throw error;
}
