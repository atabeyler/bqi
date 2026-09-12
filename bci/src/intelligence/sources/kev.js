const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

// Pure: parsing is separate from fetching so it can be unit-tested against
// a captured real response with no network involved.
export function parseKevFeed(json) {
  return (json.vulnerabilities || []).map((v) => ({
    cveId: v.cveID,
    vulnerabilityName: v.vulnerabilityName,
    dateAdded: v.dateAdded,
    dueDate: v.dueDate,
    cweIds: v.cwes || [],
  }));
}

export async function fetchKevFeed() {
  const res = await fetch(KEV_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`CISA KEV fetch failed: HTTP ${res.status}`);
  return parseKevFeed(await res.json());
}
