import { resolveCname, resolveNs } from 'node:dns/promises';
import { PUBLIC_VISIBILITY_SUPPORT, publicVisibilitySupport } from './supportCatalog.js';

const DNS_TIMEOUT_MS = 3_000;

const PROVIDERS = Object.freeze([
  { id: 'cloudflare', ns: ['ns.cloudflare.com'], cname: ['cloudflare.net'], headers: ['cf-ray', 'cf-cache-status'], values: ['cloudflare'] },
  { id: 'wix', ns: ['wixdns.net'], cname: ['wixdns.net', 'wixsite.com'], headers: ['x-wix-request-id'], values: ['parastorage.com', 'wixstatic.com'] },
  { id: 'fastly', ns: [], cname: ['fastly.net', 'fastlylb.net'], headers: ['x-served-by'], values: ['fastly'] },
  { id: 'aws-cloudfront', ns: [], cname: ['cloudfront.net'], headers: ['x-amz-cf-id', 'x-amz-cf-pop'], values: ['cloudfront'] },
  // Amplify commonly uses CloudFront, so x-amz-cf-* alone is not specific
  // enough to claim Amplify. Only an Amplify hostname/value is accepted.
  { id: 'aws-amplify', ns: [], cname: ['amplifyapp.com'], headers: [], values: ['amplify'] },
  { id: 'akamai', ns: [], cname: ['edgekey.net', 'edgesuite.net', 'akamaiedge.net'], headers: ['x-akamai-transformed'], values: ['akamai'] },
  { id: 'microsoft-iis', ns: [], cname: [], headers: [], values: ['microsoft-iis', 'asp.net'] },
  { id: 'nginx', ns: [], cname: [], headers: [], values: ['nginx'] },
  { id: 'apache-httpd', ns: [], cname: [], headers: [], values: ['apache'] },
  { id: 'kubernetes-ingress', ns: [], cname: [], headers: ['x-kubernetes-pf-flowschema-uid'], values: ['ingress-nginx'] },
  { id: 'azure-front-door', ns: [], cname: ['azurefd.net'], headers: ['x-azure-ref'], values: ['azure front door'] },
  { id: 'azure-static-web-apps', ns: [], cname: ['azurestaticapps.net'], headers: [], values: ['azure static web apps'] },
  { id: 'google-cloud', ns: [], cname: ['googlehosted.com', 'web.app', 'firebaseapp.com'], headers: ['x-cloud-trace-context'], values: ['google frontend', 'firebase'] },
  { id: 'vercel', ns: [], cname: ['vercel-dns.com', 'vercel.app'], headers: ['x-vercel-id'], values: ['vercel'] },
  { id: 'netlify', ns: [], cname: ['netlify.app', 'netlifyglobalcdn.com'], headers: ['x-nf-request-id'], values: ['netlify'] },
  { id: 'wordpress', ns: [], cname: [], headers: [], values: ['wp-json', 'wordpress'] },
  { id: 'drupal', ns: [], cname: [], headers: [], values: ['drupal'] },
]);

function withTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('dns_timeout')), DNS_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

async function discoverNameservers(hostname) {
  const labels = hostname.split('.');
  for (let index = 0; index <= Math.max(0, labels.length - 2); index += 1) {
    const candidate = labels.slice(index).join('.');
    try {
      const nameservers = await withTimeout(resolveNs(candidate));
      if (nameservers.length) return { domain: candidate, nameservers: nameservers.map((item) => item.toLowerCase()).sort() };
    } catch {
      // Continue towards the registrable parent; discovery is evidence-only.
    }
  }
  return { domain: null, nameservers: [] };
}

async function discoverCnames(hostname) {
  try {
    return (await withTimeout(resolveCname(hostname))).map((item) => item.toLowerCase()).sort();
  } catch {
    return [];
  }
}

function endsWithAny(value, suffixes) {
  return suffixes.some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

function headerEvidence(headers, provider) {
  const evidence = [];
  for (const header of provider.headers) {
    if (Object.hasOwn(headers, header)) evidence.push({ source: 'HTTP_HEADER', signal: header });
  }
  const safeValues = Object.entries(headers)
    .filter(([name]) => ['server', 'via', 'link', 'x-powered-by', 'x-generator'].includes(name))
    .map(([name, value]) => ({ name, value: String(value).toLowerCase() }));
  for (const expected of provider.values) {
    const match = safeValues.find(({ value }) => value.includes(expected));
    if (match) evidence.push({ source: 'HTTP_HEADER_VALUE', signal: `${match.name}:${expected}` });
  }
  return evidence;
}

export function classifyPublicVisibilityProviders({ nameservers = [], cnames = [], responseHeaders = {} }) {
  const headers = Object.fromEntries(Object.entries(responseHeaders).map(([key, value]) => [key.toLowerCase(), value]));
  const candidates = PROVIDERS.map((provider) => {
    const support = publicVisibilitySupport(provider.id);
    const evidence = headerEvidence(headers, provider);
    for (const nameserver of nameservers) {
      if (endsWithAny(nameserver, provider.ns)) evidence.push({ source: 'AUTHORITATIVE_NS', signal: provider.id });
    }
    for (const cname of cnames) {
      if (endsWithAny(cname, provider.cname)) evidence.push({ source: 'DNS_CNAME', signal: provider.id });
    }
    const score = Math.min(100, evidence.reduce((total, item) => total + (item.source === 'AUTHORITATIVE_NS' || item.source === 'DNS_CNAME' ? 60 : 25), 0));
    return {
      providerId: provider.id,
      providerLabel: support.label,
      adapterId: support.adapterId,
      adapterStatus: support.adapterStatus,
      blockingReason: support.blockingReason || null,
      confidence: score >= 75 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW',
      score,
      evidence,
    };
  }).filter((candidate) => candidate.evidence.length > 0).sort((left, right) => right.score - left.score);

  return candidates;
}

export async function discoverPublicVisibilityProviders(target, responseHeaders = {}) {
  const hostname = new URL(target).hostname.toLowerCase();
  const [dns, cnames] = await Promise.all([discoverNameservers(hostname), discoverCnames(hostname)]);
  return {
    hostname,
    observedAt: new Date().toISOString(),
    authoritativeDomain: dns.domain,
    nameservers: dns.nameservers,
    cnames,
    candidates: classifyPublicVisibilityProviders({ nameservers: dns.nameservers, cnames, responseHeaders }),
    supportMatrix: PUBLIC_VISIBILITY_SUPPORT.map((provider) => ({ ...provider })),
  };
}
