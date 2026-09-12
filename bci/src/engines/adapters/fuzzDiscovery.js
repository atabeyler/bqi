import { curlFetch } from './nativeHttp.js';

const MAX_LINKS = 10;
const MAX_FORMS = 8;
const MAX_OPENAPI_OPERATIONS = 20;
const MAX_CHILD_SITEMAPS = 3;
const OPENAPI_CANDIDATE_PATHS = [
  '/openapi.json', '/v3/api-docs', '/swagger.json', '/swagger/v1/swagger.json', '/api-docs', '/api/openapi.json',
];

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('discovery cancelled');
  error.name = 'AbortError';
  throw error;
}

// Real, bounded, same-origin discovery of the surface BCI Smart Fuzz will
// actually test -- no invented endpoints or parameters. Every piece here
// (endpoints, parameters, whether an operation is safe to execute at
// SAFE_ACTIVE) is either read directly off the target's own HTML/robots.txt/
// OpenAPI document, or the single query string the caller's own target URL
// already contained. Anything that can't be reached or parsed is silently
// skipped -- discovery degrading to "just the target URL itself" is a real,
// honest outcome (spec: never let one optional step fail the whole probe),
// not an error.
export async function discoverEndpoints(targetUrl, { timeoutMs = 7_000, headers = [], followRedirects = true, signal } = {}) {
  throwIfAborted(signal);
  const origin = new URL(targetUrl).origin;
  const endpoints = new Map(); // key: `${method} ${absoluteUrl}` -> { method, url, params: [{name, location, type}], source, executable }

  addEndpointFromUrl(endpoints, targetUrl, 'target');

  const [page, robots] = await Promise.allSettled([
    curlFetch(targetUrl, { timeoutMs, headers, followRedirects, signal }),
    curlFetch(`${origin}/robots.txt`, { timeoutMs, headers, followRedirects, signal }),
  ]);
  throwIfAborted(signal);

  if (page.status === 'fulfilled' && page.value.status < 400 && page.value.body) {
    extractLinks(page.value.body, origin).slice(0, MAX_LINKS).forEach((href) => addEndpointFromUrl(endpoints, href, 'html_link'));
    extractForms(page.value.body).slice(0, MAX_FORMS).forEach((form) => addEndpointFromForm(endpoints, origin, targetUrl, form));
  }

  if (robots.status === 'fulfilled' && robots.value.status < 400 && robots.value.body) {
    const { paths, sitemaps } = parseRobots(robots.value.body);
    paths.slice(0, MAX_LINKS).forEach((p) => addEndpointFromUrl(endpoints, new URL(p, origin).toString(), 'robots_txt', origin));
    for (const rawSitemapUrl of sitemaps.slice(0, 1)) {
      throwIfAborted(signal);
      try {
        const sitemapUrl = new URL(rawSitemapUrl, origin);
        if (sitemapUrl.origin !== origin) continue;
        const sm = await curlFetch(sitemapUrl.toString(), { timeoutMs, headers, followRedirects, signal });
        if (sm.status < 400 && sm.body) {
          const sitemapBodies = isSitemapIndex(sm.body)
            ? await fetchChildSitemaps(sm.body, origin, { timeoutMs, headers, followRedirects, signal })
            : [sm.body];
          const locations = sitemapBodies.flatMap(extractSitemapLocs).slice(0, MAX_LINKS);
          // A sitemap index contains child XML documents, not application
          // endpoints. Read a bounded number of those documents and fuzz the
          // actual same-origin page URLs they contain instead.
          locations.forEach((loc) => {
            try { addEndpointFromUrl(endpoints, new URL(loc, origin).toString(), 'sitemap', origin); } catch { /* unparsable, skip */ }
          });
        }
      } catch { /* optional, never fatal */ }
    }
  }

  const openapi = await discoverOpenApi(origin, { timeoutMs, headers, followRedirects, signal });
  if (openapi) {
    for (const op of openapi.operations.slice(0, MAX_OPENAPI_OPERATIONS)) {
      const key = `${op.method} ${op.url}`;
      endpoints.set(key, { method: op.method, url: op.url, params: op.params, source: 'openapi', executable: op.method === 'GET' });
    }
  }

  return { endpoints: [...endpoints.values()], openapiSource: openapi?.sourcePath ?? null, openapiSpec: openapi?.spec ?? null };
}

function addEndpointFromUrl(endpoints, rawUrl, source, expectedOrigin = null) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (expectedOrigin && url.origin !== expectedOrigin) return;
  const params = [...url.searchParams.keys()].map((name) => ({ name, location: 'query', type: 'string' }));
  const key = `GET ${url.origin}${url.pathname}`;
  const existing = endpoints.get(key);
  if (existing) {
    const known = new Set(existing.params.map((p) => p.name));
    params.forEach((p) => { if (!known.has(p.name)) existing.params.push(p); });
    return;
  }
  endpoints.set(key, { method: 'GET', url: `${url.origin}${url.pathname}${url.search}`, params, source, executable: true });
}

function addEndpointFromForm(endpoints, origin, pageUrl, form) {
  let actionUrl;
  try {
    actionUrl = new URL(form.action || pageUrl, pageUrl);
  } catch {
    return;
  }
  if (actionUrl.origin !== origin) return; // never fuzz a third-party form target
  const method = (form.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const params = form.inputs.map((input) => ({
    name: input.name,
    location: method === 'GET' ? 'query' : 'body',
    type: input.type === 'number' ? 'integer' : 'string',
  }));
  const key = `${method} ${actionUrl.origin}${actionUrl.pathname}`;
  endpoints.set(key, {
    method,
    url: `${actionUrl.origin}${actionUrl.pathname}`,
    params,
    source: 'html_form',
    // POST/PUT/PATCH/DELETE forms are real, honest DISCOVERY only -- BCI
    // Smart Fuzz stays SAFE_ACTIVE and never sends a mutating request to a
    // real target, so these are reported but not executed (see httpFuzz.js).
    executable: method === 'GET',
  });
}

function extractLinks(html, origin) {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const out = [];
  for (const href of hrefs) {
    try {
      const url = new URL(href, origin);
      if (url.origin === origin) out.push(url.toString());
    } catch { /* ignore unparsable href */ }
  }
  return [...new Set(out)];
}

function extractForms(html) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  return forms.map(([, attrs, body]) => ({
    action: attrs.match(/action\s*=\s*["']([^"']*)["']/i)?.[1] || '',
    method: attrs.match(/method\s*=\s*["']([^"']*)["']/i)?.[1] || 'GET',
    inputs: [...body.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gi)]
      .map(([, inputAttrs]) => ({
        name: inputAttrs.match(/name\s*=\s*["']([^"']*)["']/i)?.[1],
        type: inputAttrs.match(/type\s*=\s*["']([^"']*)["']/i)?.[1] || 'text',
      }))
      .filter((input) => input.name),
  }));
}

export function parseRobots(text) {
  // Disallow supports wildcard rules. They describe match patterns and are
  // not literal URLs; executing `/foo*` would test a made-up endpoint.
  const paths = [...text.matchAll(/^\s*Disallow:\s*(\S+)/gim)]
    .map((m) => m[1])
    .filter((p) => p && p !== '/' && !/[*$]/.test(p));
  const sitemaps = [...text.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  return { paths: [...new Set(paths)], sitemaps: [...new Set(sitemaps)] };
}

export function extractSitemapLocs(xml) {
  return [...new Set([...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]))];
}

export function isSitemapIndex(xml) {
  return /<sitemapindex\b/i.test(xml);
}

async function fetchChildSitemaps(indexXml, origin, { timeoutMs, headers, followRedirects, signal }) {
  const childUrls = extractSitemapLocs(indexXml).slice(0, MAX_CHILD_SITEMAPS);
  const results = await Promise.allSettled(childUrls.map(async (rawUrl) => {
    const url = new URL(rawUrl, origin);
    if (url.origin !== origin) return null;
    const response = await curlFetch(url.toString(), { timeoutMs, headers, followRedirects, signal });
    return response.status < 400 && response.body ? response.body : null;
  }));
  throwIfAborted(signal);
  return results.filter((result) => result.status === 'fulfilled' && result.value).map((result) => result.value);
}

async function discoverOpenApi(origin, { timeoutMs, headers = [], followRedirects = true, signal }) {
  for (const candidatePath of OPENAPI_CANDIDATE_PATHS) {
    throwIfAborted(signal);
    let res;
    try {
      res = await curlFetch(`${origin}${candidatePath}`, { timeoutMs, headers, followRedirects, signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      continue;
    }
    if (res.status >= 400 || !res.body) continue;
    let spec;
    try {
      spec = JSON.parse(res.body);
    } catch {
      continue;
    }
    if (!spec || typeof spec !== 'object' || !spec.paths || typeof spec.paths !== 'object') continue;
    return { sourcePath: candidatePath, operations: extractOpenApiOperations(spec, origin), spec };
  }
  return null;
}

function resolveSchemaType(schema, spec) {
  if (!schema) return 'string';
  if (schema.$ref && typeof schema.$ref === 'string') {
    const refName = schema.$ref.split('/').pop();
    schema = spec.components?.schemas?.[refName] || spec.definitions?.[refName] || {};
  }
  return schema.type === 'integer' || schema.type === 'number' ? schema.type : 'string';
}

function extractOpenApiOperations(spec, origin) {
  const basePath = typeof spec.basePath === 'string' ? spec.basePath : '';
  const operations = [];
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    // Path parameters (e.g. {id}) have no concrete value to substitute
    // without inventing one -- skip those templates rather than guess.
    if (/\{[^}]+\}/.test(pathTemplate)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const params = [];
      for (const p of [...(pathItem.parameters || []), ...(op.parameters || [])]) {
        if (!p?.name || !['query', 'header'].includes(p.in)) continue;
        params.push({ name: p.name, location: p.in, type: resolveSchemaType(p.schema || p, spec) });
      }
      const bodySchema = op.requestBody?.content?.['application/json']?.schema
        || (Array.isArray(op.parameters) ? op.parameters.find((p) => p.in === 'body')?.schema : null);
      if (bodySchema) {
        const resolved = bodySchema.$ref
          ? (spec.components?.schemas?.[bodySchema.$ref.split('/').pop()] || spec.definitions?.[bodySchema.$ref.split('/').pop()])
          : bodySchema;
        for (const propName of Object.keys(resolved?.properties || {})) {
          params.push({ name: propName, location: 'body', type: resolveSchemaType(resolved.properties[propName], spec) });
        }
      }
      operations.push({ method: method.toUpperCase(), url: `${origin}${basePath}${pathTemplate}`, params });
    }
  }
  return operations;
}
