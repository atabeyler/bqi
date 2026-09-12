const HEADER_RULES = Object.freeze({
  'bci-web-missing-hsts': {
    header: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
    impact: 'Browsers are not instructed to require HTTPS on future visits, increasing downgrade and SSL-stripping exposure.',
  },
  'bci-web-missing-content-type-options': {
    header: 'X-Content-Type-Options',
    value: 'nosniff',
    impact: 'A browser may MIME-sniff a response as a different content type, which can increase script or content interpretation risk.',
  },
  'bci-web-missing-permissions-policy': {
    header: 'Permissions-Policy',
    value: 'geolocation=(), camera=(), microphone=()',
    impact: 'Browser features are not centrally restricted; embedded or compromised content may receive more browser capability than intended.',
  },
  'bci-web-missing-content-security-policy': {
    header: 'Content-Security-Policy',
    value: "default-src 'self'; object-src 'none'; base-uri 'self'",
    impact: 'The browser has no declared content-source restrictions to reduce the impact of content injection vulnerabilities.',
  },
  'bci-web-missing-referrer-policy': {
    header: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
    impact: 'Navigation may disclose more originating URL information than the application intends.',
  },
});

function detectedTechnology(providerIds = []) {
  if (providerIds.includes('microsoft-iis')) return 'Microsoft IIS';
  if (providerIds.includes('nginx') || providerIds.includes('kubernetes-ingress')) return 'Nginx';
  if (providerIds.includes('apache-httpd')) return 'Apache HTTP Server';
  return 'Web server / reverse proxy';
}

function remediationFor(technology, header, value) {
  if (technology === 'Microsoft IIS') {
    return `After validating application compatibility, configure the ${header} response header in IIS HTTP Response Headers or web.config with value: ${value}`;
  }
  if (technology === 'Nginx') {
    return `After validating application compatibility, add an Nginx 'add_header ${header} "${value}" always;' directive at the applicable server/location level.`;
  }
  if (technology === 'Apache HTTP Server') {
    return `After validating application compatibility, enable mod_headers and add 'Header always set ${header} "${value}"' in the applicable virtual host.`;
  }
  return `After validating application compatibility, configure ${header} at the authoritative web server or reverse proxy with value: ${value}`;
}

function responseStatus(evidence) {
  const firstLine = String(evidence?.response || '').split(/\r?\n/, 1)[0];
  const match = firstLine.match(/^HTTP\/\S+\s+(\d{3})/i);
  return match?.[1] || null;
}

// Produces a bounded, secret-free explanation of Finding Evidence. It never
// upgrades verification and never copies request/response bodies into the
// report. Controlled Proof eligibility remains a separate field and decision.
export function findingGuidance(row, providerIds = []) {
  const rule = HEADER_RULES[String(row.rule_id || '').toLowerCase()];
  const technology = detectedTechnology(providerIds);
  if (rule) {
    const status = responseStatus(row.evidence);
    return {
      technology,
      technicalEvidence: `${rule.header} was absent from the observed${status ? ` HTTP ${status}` : ''} response headers.`,
      possibleImpact: rule.impact,
      remediation: remediationFor(technology, rule.header, rule.value),
      revalidation: `Repeat a fresh header check after deployment and confirm ${rule.header} is present with the intended value on the target URL and redirect chain.`,
    };
  }
  return {
    technology,
    technicalEvidence: 'A normalized engine observation was recorded; its Evidence Hash identifies the redacted source evidence.',
    possibleImpact: 'Impact depends on successful reproduction and has not been inferred from the observation alone.',
    remediation: 'Review the engine rule and redacted evidence, remediate the authoritative component, and avoid treating this observation as verified impact without deterministic validation.',
    revalidation: 'Run the same engine against the same normalized target after remediation and compare the new evidence and verification status.',
  };
}
