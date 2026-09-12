import { config } from '../../config.js';
import { sha256 } from '../core.js';

const PROVIDER_ID = 'cloudflare-edge-worker';
const API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function targetConfig(target) {
  const url = new URL(target);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search) return null;
  const hostname = url.hostname.toLowerCase();
  const genericEntry = Object.hasOwn(config.controlledProof.publicTargets, hostname)
    ? config.controlledProof.publicTargets[hostname] : null;
  const legacyEntry = Object.hasOwn(config.controlledProof.cloudflareTargets, hostname)
    ? config.controlledProof.cloudflareTargets[hostname] : null;
  const entry = genericEntry?.provider === PROVIDER_ID ? genericEntry : legacyEntry;
  if (!entry || !config.controlledProof.cloudflareApiToken
    || !/^[a-zA-Z0-9_-]{8,}$/.test(entry.accountId || '')
    || !/^[a-zA-Z0-9_-]{8,}$/.test(entry.zoneId || '')) return null;
  return { ...entry, hostname };
}

async function api(path, { method = 'GET', body, contentType = 'application/json' } = {}) {
  const headers = { Authorization: `Bearer ${config.controlledProof.cloudflareApiToken}` };
  if (contentType) headers['content-type'] = contentType;
  const response = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body && contentType === 'application/json' ? JSON.stringify(body) : body,
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const error = new Error(`cloudflare_api_${response.status}`);
    error.code = payload.errors?.[0]?.code || response.status;
    throw error;
  }
  return payload.result;
}

export function cloudflareRoutePattern(target) {
  const url = new URL(target);
  return `${url.hostname}${url.pathname || '/'}`;
}

export function buildCloudflareWorkerSource({ marker, target, expiresAt }) {
  const expected = new URL(target);
  return `export default { async fetch(request) {
  const response = await fetch(request);
  const url = new URL(request.url);
  if (Date.now() >= ${expiresAt.getTime()} || request.method !== 'GET' || url.hostname !== ${JSON.stringify(expected.hostname)} || url.pathname !== ${JSON.stringify(expected.pathname || '/')}) return response;
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store, max-age=0');
  const transformed = new HTMLRewriter().on('body', { element(body) { body.prepend(${JSON.stringify(`<div id="bci-controlled-proof" role="status" style="position:fixed;z-index:2147483647;left:16px;right:16px;top:16px;padding:14px 18px;background:#7f1d1d;color:#fff;border:2px solid #fecaca;border-radius:8px;font:700 16px/1.3 system-ui;text-align:center">${marker}</div>`)}, { html: true }); } }).transform(response);
  return new Response(transformed.body, { status: transformed.status, statusText: transformed.statusText, headers });
} };`;
}

async function readBoundedText(response) {
  if (!response.body?.getReader) return (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_RESPONSE_BYTES - total;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  if (total >= MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new globalThis.TextDecoder().decode(bytes);
}

async function observe(target, marker) {
  const response = await fetch(target, {
    method: 'GET', redirect: 'manual', headers: { 'cache-control': 'no-cache', pragma: 'no-cache', 'user-agent': 'BCI-Controlled-Proof/1.2' },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await readBoundedText(response);
  return {
    visible: response.ok && body.includes(marker),
    status: response.status,
    contentType: response.headers.get('content-type'),
    bodyHash: sha256(body),
    markerHash: sha256(marker),
    observedAt: new Date().toISOString(),
};
}

async function uploadScript(accountId, scriptName, source) {
  const form = new globalThis.FormData();
  form.set('metadata', new globalThis.Blob([JSON.stringify({ main_module: 'worker.js' })], { type: 'application/json' }), 'metadata.json');
  form.set('worker.js', new globalThis.Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  return api(`/accounts/${encodeURIComponent(accountId)}/workers/scripts/${scriptName}`, { method: 'PUT', body: form, contentType: null });
}

function routeConflicts(routes, hostname, pattern) {
  return routes.some((route) => {
    const existing = String(route.pattern || '').replace(/^https?:\/\//, '');
    return existing === pattern || existing === `${hostname}/*` || existing === `*.${hostname}/*`;
  });
}

export const cloudflareEdgePublicVisibility = {
  id: PROVIDER_ID,
  infrastructureProvider: 'cloudflare',

  capability(target) {
    const entry = targetConfig(target);
    return entry
      ? { available: true, providerId: PROVIDER_ID, infrastructureProvider: 'cloudflare', status: 'CONFIGURED' }
      : { available: false, providerId: PROVIDER_ID, infrastructureProvider: 'cloudflare', status: 'NOT_CONFIGURED', reason: 'provider_not_configured_for_target' };
  },

  async activate({ target, marker, proofId, durationSeconds }) {
    const entry = targetConfig(target);
    if (!entry) throw new Error('public_visibility_provider_unavailable');
    const pattern = cloudflareRoutePattern(target);
    const routes = await api(`/zones/${encodeURIComponent(entry.zoneId)}/workers/routes`);
    if (routeConflicts(routes, entry.hostname, pattern)) throw new Error('public_visibility_route_conflict');

    const scriptName = `bci-proof-${proofId.toLowerCase()}`;
    await uploadScript(entry.accountId, scriptName, 'export default { fetch(request) { return fetch(request); } };');
    let route;
    try {
      route = await api(`/zones/${encodeURIComponent(entry.zoneId)}/workers/routes`, { method: 'POST', body: { pattern, script: scriptName } });
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationSeconds * 1000);
      await uploadScript(entry.accountId, scriptName, buildCloudflareWorkerSource({ marker, target, expiresAt }));
      const observations = [await observe(target, marker), await observe(target, marker)];
      if (!observations.every((item) => item.visible)) throw new Error('public_marker_not_observed');
      return { providerId: PROVIDER_ID, startedAt, expiresAt, resources: { accountId: entry.accountId, zoneId: entry.zoneId, routeId: route.id, scriptName, pattern }, observations };
    } catch (error) {
      if (route?.id) await api(`/zones/${encodeURIComponent(entry.zoneId)}/workers/routes/${encodeURIComponent(route.id)}`, { method: 'DELETE' }).catch(() => {});
      await api(`/accounts/${encodeURIComponent(entry.accountId)}/workers/scripts/${scriptName}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  },

  async expire({ target, marker, resources }) {
    if (resources?.routeId) await api(`/zones/${encodeURIComponent(resources.zoneId)}/workers/routes/${encodeURIComponent(resources.routeId)}`, { method: 'DELETE' }).catch(() => {});
    if (resources?.scriptName) await api(`/accounts/${encodeURIComponent(resources.accountId)}/workers/scripts/${encodeURIComponent(resources.scriptName)}`, { method: 'DELETE' }).catch(() => {});
    const observation = await observe(target, marker);
    return { removed: !observation.visible, observation };
  },
};
