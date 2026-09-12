import { curlFetch } from '../../adapters/nativeHttp.js';
import { getCategory } from '../../adapters/fuzzCatalog.js';
import { buildRecord, errorRecord } from '../recordHelpers.js';

const FAMILY = 'FINDING_REPRODUCIBILITY_VERIFICATION';

// One real mechanism covering several of the requested families at once
// (Nuclei finding verification, Smart Fuzz finding verification, cross-
// engine finding verification, reproducibility validation, false-positive
// elimination, multi-stage finding verification, cross-engine
// correlation): given a REAL prior finding (from any engine, supplied by
// the caller as context.priorFindings -- see bci/src/routes/scans.js's
// engineOptions schema), re-issues the real request that originally
// produced it and checks whether the same signal still reproduces.
// Never fabricates a finding of its own -- it only ever re-confirms or
// walks back a finding that already exists, with a real new observation.
function requestFor(finding) {
  const endpoint = finding.evidence?.endpoint || finding.location;
  if (!endpoint) return null;
  const method = finding.evidence?.method || 'GET';
  const { parameter, category, location } = finding.evidence || {};
  if (parameter && category && getCategory(category)) {
    try {
      const url = new URL(endpoint);
      const value = getCategory(category).value;
      if ((location || 'query') === 'header') return { url: endpoint, method, extraHeader: `${parameter}: ${value}` };
      url.searchParams.set(parameter, value);
      return { url: url.toString(), method };
    } catch {
      return { url: endpoint, method };
    }
  }
  return { url: endpoint, method };
}

export const findingReproducibilityModule = {
  id: 'FINDING_REPRODUCIBILITY_VERIFICATION',
  family: FAMILY,
  name: 'Cross-Engine Finding Reproducibility Verification',
  description: 'Re-issues the real request behind a prior finding (from any engine) and checks whether the same signal reproduces.',
  status: 'IMPLEMENTED',
  requiredIntrusiveness: 'RESTRICTED',
  // Only applicable when the caller actually supplied real prior findings
  // to verify -- there is nothing to re-check otherwise, and this module
  // never invents a finding to go verify.
  isApplicable: (context) => Array.isArray(context.priorFindings) && context.priorFindings.length > 0,

  async run({ target, timeoutMs, headers = [], priorFindings = [], roundNumber = 1 }) {
    const records = [];
    for (const finding of priorFindings) {
      const req = requestFor(finding);
      if (!req) {
        records.push(buildRecord({
          moduleId: this.id, family: FAMILY, target, endpoint: target, testType: 'REPRODUCE_PRIOR_FINDING',
          baseline: null, observed: null, evidence: { findingId: finding.id, reason: 'no re-testable endpoint in this finding\'s evidence' },
          verificationStatus: 'NOT_APPLICABLE', relatedFindingId: finding.id ?? null, roundNumber, anomalous: false,
        }));
        continue;
      }
      try {
        const result = await curlFetch(req.url, {
          method: req.method, timeoutMs,
          headers: req.extraHeader ? [...headers, req.extraHeader] : headers,
        });
        const originalStatus = finding.evidence?.httpStatus ?? null;
        const reflectionMarker = finding.evidence?.category ? getCategory(finding.evidence.category)?.reflectionMarker : null;
        const stillReflected = reflectionMarker ? result.body.includes(reflectionMarker) : null;
        const statusMatches = originalStatus == null || result.status === originalStatus;
        // Reproduced = the same class of signal that originally produced
        // the finding is still observed now (status match, and -- when
        // the original finding was a reflection -- the marker still
        // reflects). A finding that no longer reproduces is real, useful
        // information (fixed, or was environment-specific), not silently
        // dropped.
        const reproduced = reflectionMarker != null ? !!stillReflected : statusMatches;

        records.push(buildRecord({
          moduleId: this.id, family: FAMILY, target, endpoint: req.url, testType: 'REPRODUCE_PRIOR_FINDING',
          baseline: { originalStatus, originallyReflected: reflectionMarker != null ? true : null },
          observed: { status: result.status, stillReflected },
          evidence: { findingId: finding.id ?? null, findingTitle: finding.title ?? null, reproduced },
          verificationStatus: reproduced ? 'VERIFIED' : 'UNVERIFIED',
          relatedFindingId: finding.id ?? null, roundNumber,
          anomalous: reproduced, anomalyReasons: reproduced ? ['prior_finding_reproduced'] : [],
        }));
      } catch (err) {
        records.push(errorRecord({ moduleId: this.id, family: FAMILY, target, endpoint: req.url, testType: 'REPRODUCE_PRIOR_FINDING', error: err, roundNumber }));
      }
    }
    return records;
  },
};
