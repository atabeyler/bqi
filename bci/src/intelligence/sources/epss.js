const EPSS_URL = 'https://api.first.org/data/v1/epss';
const BATCH_SIZE = 100; // FIRST's documented practical limit per request

export function parseEpssResponse(json) {
  return (json.data || []).map((row) => ({
    cveId: row.cve,
    epssScore: Number(row.epss),
    epssPercentile: Number(row.percentile),
    epssUpdatedAt: row.date,
  }));
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

export async function fetchEpssForCves(cveIds) {
  const results = [];
  for (const batch of chunk(cveIds, BATCH_SIZE)) {
    const res = await fetch(`${EPSS_URL}?cve=${batch.join(',')}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`EPSS fetch failed: HTTP ${res.status}`);
    results.push(...parseEpssResponse(await res.json()));
  }
  return results;
}
