function pickCvss(cvssMap) {
  if (!cvssMap) return {};
  const preferred = cvssMap.nvd || cvssMap.redhat || Object.values(cvssMap)[0];
  if (!preferred) return {};
  return { cvssVector: preferred.V3Vector || preferred.V2Vector, cvssScore: preferred.V3Score ?? preferred.V2Score };
}

// Trivy's JSON groups findings under Results[], each with its own Class
// (lang-pkgs -> vulnerabilities, secret -> Secrets[], config -> Misconfigurations[]).
export function normalizeTrivy(raw) {
  const observations = [];
  for (const result of raw.Results || []) {
    for (const vuln of result.Vulnerabilities || []) {
      const { cvssVector, cvssScore } = pickCvss(vuln.CVSS);
      observations.push({
        category: 'SCA',
        capabilityId: 'SCA',
        ruleId: vuln.VulnerabilityID,
        title: vuln.Title || vuln.VulnerabilityID,
        description: vuln.Description,
        engineSeverity: vuln.Severity,
        cveIds: vuln.VulnerabilityID?.startsWith('CVE-') ? [vuln.VulnerabilityID] : [],
        cweIds: vuln.CweIDs || [],
        cvssVector,
        cvssScore,
        component: vuln.PkgName,
        componentVersion: vuln.InstalledVersion,
        location: result.Target,
        evidence: { fixedVersion: vuln.FixedVersion, status: vuln.Status },
        references: [vuln.PrimaryURL].filter(Boolean),
      });
    }
    for (const secret of result.Secrets || []) {
      observations.push({
        category: 'SECRETS',
        capabilityId: 'SECRETS',
        ruleId: secret.RuleID,
        title: secret.Title || secret.RuleID,
        description: `Possible secret (${secret.Category}) detected`,
        engineSeverity: secret.Severity,
        location: `${result.Target}:${secret.StartLine}`,
        evidence: { match: '[REDACTED]' }, // never store the matched secret text itself
        references: [],
      });
    }
    for (const misconfig of result.Misconfigurations || []) {
      observations.push({
        category: 'IAC',
        capabilityId: 'IAC',
        ruleId: misconfig.ID,
        title: misconfig.Title || misconfig.ID,
        description: misconfig.Description,
        engineSeverity: misconfig.Severity,
        location: `${result.Target}${misconfig.CauseMetadata?.StartLine ? ':' + misconfig.CauseMetadata.StartLine : ''}`,
        evidence: { resolution: misconfig.Resolution },
        references: misconfig.References || [],
      });
    }
  }
  return observations;
}
