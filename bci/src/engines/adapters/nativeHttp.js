import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runBinary } from '../execFileAsync.js';

export const CURL_DISCARD_PATH = os.devNull;

export async function curlHealthCheck() {
  try {
    const { stdout } = await runBinary('curl', ['--version'], { timeoutMs: 10_000 });
    const version = stdout.match(/^curl\s+(\S+)/)?.[1];
    if (!version) return { status: 'DEGRADED', detail: 'curl returned an unexpected version response' };
    return { status: 'HEALTHY', version };
  } catch (err) {
    return { status: 'OFFLINE', detail: String(err.message || err) };
  }
}

export function parseHttpStatus(value) {
  const status = Number(String(value).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error(`unexpected HTTP status output: ${value}`);
  return status;
}

export function assertHttpTarget(target) {
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`unsupported URL protocol: ${url.protocol}`);
  return url.toString();
}

const MAX_BODY_BYTES = 512 * 1024; // real page/spec bodies only -- never a bulk download

export function isCurlCertificateTrustError(error) {
  const details = `${String(error?.message || error)} ${String(error?.cause?.message || '')} ${String(error?.cause?.code || '')}`;
  return /(?:curl exited 60|ssl certificate problem|unable to get local issuer certificate|unable_to_verify_leaf_signature|self_signed_cert|cert_has_expired|unable_to_get_issuer_cert)/i.test(details);
}

async function readBoundedResponseBody(stream) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.from(value);
    const remaining = MAX_BODY_BYTES - total;
    chunks.push(chunk.subarray(0, remaining));
    total += Math.min(chunk.length, remaining);
    if (total >= MAX_BODY_BYTES) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks);
}

function requestOnce(url, { method, headers, signal, ca, connectAddress = null }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const requestHeaders = Object.fromEntries(headers.map((header) => {
      const separator = header.indexOf(':');
      if (separator <= 0) throw new TypeError('invalid HTTP header');
      return [header.slice(0, separator).trim(), header.slice(separator + 1).trim()];
    }));
    if (connectAddress) requestHeaders.Host = url.host;
    const request = client.request({
      protocol: url.protocol,
      hostname: connectAddress || url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: requestHeaders,
      signal,
      ...(url.protocol === 'https:' ? { servername: url.hostname, rejectUnauthorized: true, ...(ca ? { ca } : {}) } : {}),
    }, resolve);
    request.on('error', reject);
    request.end();
  });
}

function isPublicIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return !(value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb'));
  }
  return false;
}

async function publicAddressFor(hostname) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) throw new Error('certificate issuer endpoint is not public');
  return addresses[0].address;
}

async function peerLeafCertificate(url, signal) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port) || 443, servername: url.hostname, rejectUnauthorized: false });
    const abort = () => socket.destroy(Object.assign(new Error('TLS inspection cancelled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer?.raw) throw new Error('target did not provide a leaf certificate');
        resolve(new X509Certificate(peer.raw));
      } catch (error) {
        reject(error);
      } finally {
        signal?.removeEventListener('abort', abort);
        socket.destroy();
      }
    });
    socket.once('error', reject);
  });
}

async function downloadIssuerCertificate(issuerUrl, signal) {
  const url = new URL(issuerUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported certificate issuer protocol');
  const address = await publicAddressFor(url.hostname);
  const response = await requestOnce(url, { method: 'GET', headers: [], signal, connectAddress: address });
  if (response.statusCode !== 200) throw new Error(`certificate issuer returned HTTP ${response.statusCode}`);
  const contentLength = Number(response.headers['content-length']);
  if (contentLength > 128 * 1024) throw new Error('certificate issuer response is too large');
  const body = await readBoundedResponseBody(response);
  if (body.length > 128 * 1024) throw new Error('certificate issuer response is too large');
  return new X509Certificate(body).toString();
}

async function aiaIssuerFor(url, signal) {
  const leaf = await peerLeafCertificate(url, signal);
  const issuerUrl = leaf.infoAccess?.match(/CA Issuers - URI:(\S+)/)?.[1];
  if (!issuerUrl) throw new Error('target certificate does not provide a CA issuer URL');
  return downloadIssuerCertificate(issuerUrl, signal);
}

// Secure fallback for a target that omits its intermediate certificate. The
// unverified handshake is used only to read the leaf's public AIA metadata; no
// response content is accepted from it. The issuer is downloaded from a
// DNS-checked public endpoint, then a second request must pass normal hostname,
// validity and root-chain verification with the supplied intermediate. There is
// no rejectUnauthorized=false content request or curl --insecure equivalent.
export async function secureNodeTlsFetch(url, { method = 'GET', headers = [], followRedirects = true, timeoutMs = 7_000, signal } = {}) {
  if (!['GET', 'HEAD'].includes(method) || signal?.aborted) {
    if (signal?.aborted) throw Object.assign(new Error('fetch cancelled'), { name: 'AbortError' });
    throw new TypeError('secure TLS fallback supports only GET and HEAD');
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const started = Date.now();
  let current = new URL(url);
  if (!['http:', 'https:'].includes(current.protocol)) throw new TypeError('unsupported URL protocol');
  const additionalCa = current.protocol === 'https:' ? await aiaIssuerFor(current, combinedSignal) : null;
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await requestOnce(current, { method, headers, signal: combinedSignal, ca: additionalCa ? [...tls.rootCertificates, additionalCa] : null });
    const location = response.headers.location;
    if (!followRedirects || response.statusCode < 300 || response.statusCode >= 400 || !location) break;
    response.destroy();
    if (redirects === 3) throw new Error('maximum redirects exceeded');
    current = new URL(location, current);
    if (!['http:', 'https:'].includes(current.protocol)) throw new TypeError('unsupported redirect protocol');
  }
  const responseBody = method === 'HEAD' ? Buffer.alloc(0) : await readBoundedResponseBody(response);
  return {
    status: response.statusCode,
    sizeBytes: Number(response.headers['content-length']) || responseBody.length,
    timeMs: Date.now() - started,
    body: responseBody.toString('utf8'),
    headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
    transport: 'node-aia-verified-tls-fallback',
  };
}

// A real HTTP request via curl that also captures the response BODY (not
// just status, unlike curlHealthCheck/the original httpFuzz probes) --
// needed for endpoint/parameter discovery (HTML forms/links, OpenAPI/
// Swagger documents) and for behavioral diffing (body size, reflected
// payload check). Body goes to a real temp file via --output (never
// stdout, which --write-out also uses) and is read back bounded at
// MAX_BODY_BYTES; the temp file is always removed, success or failure.
// GET-only by default -- callers that need another method pass it
// explicitly, and this never mutates BCI's own filesystem state beyond
// its own scratch directory.
function parseResponseHeaders(raw) {
  // --dump-header captures every response in the redirect chain when
  // --location follows one; only the FINAL response's header block (the
  // one after the last blank-line-separated HTTP status line) reflects
  // what the caller actually ended up looking at.
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => /^HTTP\/\d/.test(b.trim()));
  const lastBlock = blocks[blocks.length - 1] || '';
  const headers = {};
  for (const line of lastBlock.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// A real HTTP request via curl that also captures the response BODY (not
// just status, unlike curlHealthCheck/the original httpFuzz probes) --
// needed for endpoint/parameter discovery (HTML forms/links, OpenAPI/
// Swagger documents), behavioral diffing (body size, reflected payload
// check), and response-HEADER-based validation (CORS, security headers,
// content negotiation -- see bci/src/engines/intrusive/modules/*.js).
// Body and headers each go to their own real temp file (never stdout,
// which --write-out also uses), read back bounded, and the whole temp
// directory is always removed, success or failure. GET-only by default --
// callers that need another method pass it explicitly, and this never
// mutates BCI's own filesystem state beyond its own scratch directory.
export async function curlFetch(url, { method = 'GET', headers = [], body = null, followRedirects = true, timeoutMs = 7_000, allowedExitCodes = [0], signal } = {}) {
  if (body != null && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 4096)) {
    throw new TypeError('HTTP request body must be a string no larger than 4096 bytes');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bci-fuzz-'));
  const bodyPath = path.join(dir, 'body');
  const headerPath = path.join(dir, 'headers');
  try {
    const headerArgs = headers.flatMap((h) => ['--header', h]);
    const redirectArgs = followRedirects ? ['--location', '--max-redirs', '3'] : [];
    const bodyArgs = body == null ? [] : ['--data-binary', body];
    let stdout;
    try {
      ({ stdout } = await runBinary('curl', [
        '--silent', '--show-error', ...redirectArgs,
        '--output', bodyPath, '--dump-header', headerPath, '--write-out', '%{http_code} %{size_download} %{time_total}',
        '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))),
        '--request', method, ...headerArgs, ...bodyArgs, url,
      ], { timeoutMs, allowedExitCodes, signal }));
    } catch (error) {
      if (body == null && ['GET', 'HEAD'].includes(method) && isCurlCertificateTrustError(error)) {
        return secureNodeTlsFetch(url, { method, headers, followRedirects, timeoutMs, signal });
      }
      throw error;
    }

    const [statusRaw, sizeRaw, timeRaw] = stdout.trim().split(/\s+/);
    const status = parseHttpStatus(statusRaw);
    const sizeBytes = Number(sizeRaw) || 0;
    const timeMs = Math.round((Number(timeRaw) || 0) * 1000);

    let responseBody = '';
    try {
      const st = await stat(bodyPath);
      if (st.size > 0) {
        const buf = await readFile(bodyPath);
        responseBody = buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
      }
    } catch {
      // No body captured (e.g. HEAD-like response) -- not an error.
    }

    let responseHeaders = {};
    try {
      responseHeaders = parseResponseHeaders(await readFile(headerPath, 'utf8'));
    } catch {
      // No header dump captured -- not an error, callers get {}.
    }

    return { status, sizeBytes, timeMs, body: responseBody, headers: responseHeaders, transport: 'curl' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
