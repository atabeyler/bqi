import { curlFetch } from '../../adapters/nativeHttp.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'PATH_NORMALIZATION_VALIDATION';

// Real path-normalization variants of the same URL -- a well-known class
// of access-control-bypass bug where a reverse proxy/WAF normalizes one
// way and the backend application another. Bounded to non-destructive GET
// variants; never attempts to actually exploit a discovered bypass.
// Deliberately excludes a "/path/." (trailing dot-segment) variant: both
// the WHATWG URL parser and curl itself (RFC 3986 dot-segment removal,
// on by default -- verified against a real curl binary) collapse that
// back to "/path/" before the request is ever sent, so it can never
// actually reach the target as a distinct literal path without curl's
// --path-as-is flag, which nativeHttp.js's curlFetch doesn't expose
// today. Shipping a variant that silently never executes as designed
// would be dishonest; the three kept here (double slash, percent-encoded
// slash, case) all verified to survive both layers unchanged.
function pathVariants(target) {
  const url = new URL(target);
  const base = url.pathname || '/';
  const variants = [
    { label: 'double_slash', pathname: `/${base.replace(/^\/+/, '')}//`.replace(/\/{3,}/, '//') },
    { label: 'encoded_slash', pathname: `${base.replace(/\/$/, '')}%2f` },
    { label: 'uppercase', pathname: base.toUpperCase() },
  ];
  return variants.map((v) => {
    const variantUrl = new URL(url.toString());
    variantUrl.pathname = v.pathname;
    return { label: v.label, url: variantUrl.toString() };
  });
}

export const pathNormalizationModule = {
  id: 'PATH_NORMALIZATION_VALIDATION',
  family: FAMILY,
  name: 'Path / Route Normalization Validation',
  description: 'Compares real responses for path-normalization variants (double slash, percent-encoded slash, case) against the baseline path.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  isApplicable: () => true,

  async run({ target, timeoutMs, headers = [], roundNumber = 1 }) {
    let baseline;
    try {
      baseline = await curlFetch(target, { method: 'GET', headers, timeoutMs });
    } catch (err) {
      return [errorRecord({ moduleId: this.id, family: FAMILY, target, testType: 'PATH_VARIANT_ACCESS_DIFFERENTIAL', error: err, roundNumber })];
    }

    const records = [];
    const RESTRICTIVE = new Set([401, 403, 404]);
    for (const variant of pathVariants(target)) {
      try {
        const result = await curlFetch(variant.url, { method: 'GET', headers, timeoutMs });
        // A variant that becomes LESS restrictive than the baseline (the
        // real path was 401/403/404, the normalized variant is 200) is
        // the real, well-known bypass signal -- the reverse case (variant
        // more restrictive) is not anomalous, just a different route.
        const bypass = RESTRICTIVE.has(baseline.status) && result.status === 200;
        records.push(buildRecord({
          moduleId: this.id, family: FAMILY, target, endpoint: variant.url, testType: `PATH_VARIANT_${variant.label.toUpperCase()}`,
          baseline: { status: baseline.status }, observed: { status: result.status },
          evidence: { variant: variant.label, baselineStatus: baseline.status, variantStatus: result.status },
          verificationStatus: 'VERIFIED', roundNumber,
          anomalous: bypass, anomalyReasons: bypass ? ['path_normalization_access_bypass'] : [],
        }));
      } catch (err) {
        records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, endpoint: variant.url, testType: `PATH_VARIANT_${variant.label.toUpperCase()}`, error: err, roundNumber }));
      }
    }
    return records;
  },
};
