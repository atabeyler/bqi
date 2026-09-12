import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'TECHNOLOGY_SPECIFIC_VALIDATION';
const FINGERPRINTS = [
  ['WordPress', /wp-(?:content|includes)|<meta[^>]+generator[^>]+wordpress/i],
  ['Django', /csrftoken|__admin_media_prefix__/i],
  ['Spring', /whitelabel error page|x-application-context/i],
  ['ASP.NET', /asp\.net|__viewstate/i],
  ['PHP', /x-powered-by:\s*php/i],
];

export const technologySpecificValidationModule = {
  id: 'TECHNOLOGY_SPECIFIC_VALIDATION', family: FAMILY, name: 'Technology-Specific Validation',
  description: 'Fingerprints technology from real headers/body and verifies exact version disclosure without guessing a framework.',
  status: 'IMPLEMENTED', requiredIntrusiveness: 'RESTRICTED', isApplicable: () => true,
  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    try {
      const result = await curlFetch(target, { headers, timeoutMs });
      const material = `${Object.entries(result.headers).map(([key, value]) => `${key}: ${value}`).join('\n')}\n${result.body.slice(0, 100_000)}`;
      const technologies = FINGERPRINTS.filter(([, pattern]) => pattern.test(material)).map(([name]) => name);
      const banners = [result.headers.server, result.headers['x-powered-by']].filter(Boolean);
      const versionedBanners = banners.filter((banner) => /\d+\.\d+/.test(banner));
      return [buildRecord({
        moduleId: this.id, family: FAMILY, target, testType: 'TECHNOLOGY_FINGERPRINT_AND_VERSION_DISCLOSURE',
        baseline: null, observed: { technologies, banners }, evidence: { technologies, versionedBanners },
        verificationStatus: 'VERIFIED', roundNumber, anomalous: versionedBanners.length > 0,
        anomalyReasons: versionedBanners.length ? ['technology_exact_version_disclosed'] : [],
      })];
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'TECHNOLOGY_FINGERPRINT_AND_VERSION_DISCLOSURE', error: err, roundNumber })];
    }
  },
};
