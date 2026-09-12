const NVD_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

function pickCvss(metrics) {
  // Prefer the newest CVSS version NVD provides; fall back down the chain.
  const primary =
    metrics?.cvssMetricV31?.find((m) => m.type === 'Primary') ||
    metrics?.cvssMetricV31?.[0] ||
    metrics?.cvssMetricV30?.[0] ||
    metrics?.cvssMetricV2?.[0];
  if (!primary) return {};
  return { cvssVector: primary.cvssData.vectorString, cvssScore: primary.cvssData.baseScore };
}

export function parseNvdCve(json) {
  const entry = json.vulnerabilities?.[0]?.cve;
  if (!entry) return null;

  const { cvssVector, cvssScore } = pickCvss(entry.metrics);
  const cweIds = (entry.weaknesses || [])
    .flatMap((w) => w.description || [])
    .map((d) => d.value)
    .filter((v) => v?.startsWith('CWE-'));

  return {
    cveId: entry.id,
    description: entry.descriptions?.find((d) => d.lang === 'en')?.value,
    cweIds: [...new Set(cweIds)],
    cvssVector,
    cvssScore,
    publishedAt: entry.published,
    modifiedAt: entry.lastModified,
  };
}

// NVD's unauthenticated rate limit is strict (5 requests / rolling 30s
// window) -- this is a single on-demand lookup, not a bulk sync, and
// callers (services/intelligence.js) only hit it lazily per CVE, not in a
// loop over an entire feed.
export async function fetchNvdCve(cveId) {
  const res = await fetch(`${NVD_URL}?cveId=${encodeURIComponent(cveId)}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`NVD fetch failed for ${cveId}: HTTP ${res.status}`);
  return parseNvdCve(await res.json());
}
