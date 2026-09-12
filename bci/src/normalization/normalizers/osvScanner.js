export function normalizeOsvScanner(raw) {
  const observations = [];
  for (const result of raw.results || []) {
    for (const pkg of result.packages || []) {
      for (const vuln of pkg.vulnerabilities || []) {
        const cvssEntry = (vuln.severity || []).find((s) => s.type === 'CVSS_V3') || (vuln.severity || [])[0];
        observations.push({
          category: 'SCA',
          capabilityId: 'SCA',
          ruleId: vuln.id,
          title: vuln.summary || vuln.id,
          description: vuln.details,
          engineSeverity: vuln.database_specific?.severity,
          cveIds: (vuln.aliases || []).filter((a) => a.startsWith('CVE-')),
          cweIds: vuln.database_specific?.cwe_ids || [],
          cvssVector: cvssEntry?.score,
          component: pkg.package.name,
          componentVersion: pkg.package.version,
          location: result.source.path,
          evidence: { ecosystem: pkg.package.ecosystem },
          references: (vuln.references || []).map((r) => r.url).filter(Boolean),
        });
      }
    }
  }
  return observations;
}
