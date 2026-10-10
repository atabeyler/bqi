export const NUCLEI_TEMPLATES_VERSION = 'v10.4.8';
export const NUCLEI_TEMPLATES_DIR = process.env.BCI_NUCLEI_TEMPLATES_DIR || '/opt/nuclei-templates';

export const NUCLEI_SAFE_CATEGORIES = Object.freeze({
  CVE: 'http/cves',
  MISCONFIGURATION: 'http/misconfiguration',
  EXPOSURE: 'http/exposures',
  VULNERABILITY: 'http/vulnerabilities',
  TECHNOLOGY: 'http/technologies',
  API: 'http',
});

export const NUCLEI_SCAN_PROFILES = Object.freeze({
  BCI_BUNDLED: [],
  STANDARD: ['CVE', 'MISCONFIGURATION', 'EXPOSURE'],
  EXTENDED: ['CVE', 'MISCONFIGURATION', 'EXPOSURE', 'VULNERABILITY', 'TECHNOLOGY'],
  FULL_SAFE: Object.keys(NUCLEI_SAFE_CATEGORIES),
});

export function resolveNucleiScope(profile = 'STANDARD', requestedCategories) {
  if (!Object.hasOwn(NUCLEI_SCAN_PROFILES, profile)) throw new TypeError(`unknown Nuclei scan profile: ${profile}`);
  const categories = requestedCategories === undefined ? NUCLEI_SCAN_PROFILES[profile] : [...new Set(requestedCategories)];
  const invalid = categories.filter((id) => !Object.hasOwn(NUCLEI_SAFE_CATEGORIES, id));
  if (invalid.length) throw new TypeError(`unknown Nuclei template category: ${invalid.join(', ')}`);
  if (profile === 'BCI_BUNDLED' && categories.length) throw new TypeError('BCI_BUNDLED profile cannot select official template categories');
  return { profile, categories, templateVersion: NUCLEI_TEMPLATES_VERSION };
}

export const NAABU_PORT_PROFILES = Object.freeze({
  TOP_PORTS: { args: ['-top-ports', '100'], scope: 'top-100' },
  PORTS_1_1000: { args: ['-p', '1-1000'], scope: '1-1000' },
  FULL_PORTS: { args: ['-p', '-'], scope: '1-65535' },
});

export function validateCustomPorts(value) {
  const input = String(value || '').trim();
  if (!input || !/^[0-9,-]+$/.test(input)) throw new TypeError('CUSTOM ports must be a comma-separated port/range list');
  for (const token of input.split(',')) {
    const parts = token.split('-').map(Number);
    if (parts.length > 2 || parts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || (parts.length === 2 && parts[0] > parts[1])) {
      throw new TypeError(`invalid CUSTOM port token: ${token}`);
    }
  }
  return input;
}

export function resolveNaabuScope(portProfile = 'TOP_PORTS', customPorts) {
  if (portProfile === 'CUSTOM') {
    const ports = validateCustomPorts(customPorts);
    return { portProfile, requested: ports, executed: ports, args: ['-p', ports] };
  }
  const preset = NAABU_PORT_PROFILES[portProfile];
  if (!preset) throw new TypeError(`unknown Naabu port profile: ${portProfile}`);
  return { portProfile, requested: preset.scope, executed: preset.scope, args: [...preset.args] };
}

export const FUZZ_BASE_PROFILES = Object.freeze({ STANDARD: 15, EXTENDED: 50, FULL: null });

export function resolveFuzzBaseScope(baseProfile = 'STANDARD', customMaxParameters) {
  if (baseProfile === 'CUSTOM') {
    if (!Number.isInteger(customMaxParameters) || customMaxParameters < 1) throw new TypeError('CUSTOM fuzz scope requires a positive max parameter count');
    return { baseProfile, maxParameters: customMaxParameters };
  }
  if (!Object.hasOwn(FUZZ_BASE_PROFILES, baseProfile)) throw new TypeError(`unknown fuzz BASE profile: ${baseProfile}`);
  return { baseProfile, maxParameters: FUZZ_BASE_PROFILES[baseProfile] };
}

// Credentials are never persisted in scan_jobs. The persisted value is only
// a profile id; API discovery and the worker independently resolve that id
// from identically named deployment secrets.
export function resolveAuthProfile(profileId, { orgId, target } = {}) {
  if (!profileId) return { headers: [], profileId: null };
  const normalized = String(profileId).trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(normalized)) throw new TypeError('invalid auth profile id');
  if (orgId) {
    if (process.env[`BCI_AUTH_PROFILE_OWNER_${normalized}`] !== orgId) throw new TypeError('auth profile unavailable for tenant');
    const origin = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`).origin;
    if (process.env[`BCI_AUTH_PROFILE_ORIGIN_${normalized}`] !== origin) throw new TypeError('auth profile target mismatch');
  }
  const raw = process.env[`BCI_AUTH_PROFILE_${normalized}`];
  if (!raw) throw new TypeError(`auth profile is not configured: ${normalized}`);
  let headers;
  try { headers = JSON.parse(raw); } catch { headers = [raw]; }
  if (!Array.isArray(headers) || headers.length === 0 || headers.some((header) => typeof header !== 'string' || !/^[A-Za-z0-9-]+:[^\r\n]+$/.test(header))) {
    throw new TypeError(`auth profile has invalid header material: ${normalized}`);
  }
  return { headers, profileId: normalized };
}
