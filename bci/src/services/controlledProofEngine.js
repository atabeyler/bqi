import { discoverEndpoints } from '../engines/adapters/fuzzDiscovery.js';
import { curlHealthCheck, isCurlCertificateTrustError } from '../engines/adapters/nativeHttp.js';
import { pool, query } from '../db/client.js';
import { recordAuditEvent } from './audit.js';
import {
  ANALYSIS_RESULT, buildValidationToken, classifyAnalysisResult, CONTROLLED_PROOF_ENGINE_ID, CONTROLLED_PROOF_ENGINE_VERSION,
  generateProofId, normalizeProofTarget, sha256,
} from '../controlledProof/core.js';
import { listProofValidators } from '../controlledProof/validators/registry.js';
import { CONTROLLED_PROOF_EVIDENCE_ENGINES, resolveControlledProofCandidates } from '../controlledProof/candidateResolver.js';
import { resolveCanonicalProofTarget } from '../controlledProof/targetResolver.js';
import {
  activatePublicVisibilityProvider, expirePublicVisibilityProvider,
  publicVisibilityCapabilities, resolvePublicVisibilityProvider,
} from '../controlledProof/publicVisibility/registry.js';
import { discoverPublicVisibilityProviders } from '../controlledProof/publicVisibility/providerDiscovery.js';
import { collectLiveControlledProofEvidence } from '../controlledProof/liveEngineEvidence.js';

const REQUEST_TIMEOUT_MS = 7_000;
const activeRuns = new Map();

function serializeRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    proofId: row.proof_id,
    target: row.target,
    normalizedTarget: row.normalized_target,
    findingId: row.finding_id,
    status: row.status,
    proofType: row.proof_type,
    securityImpact: row.security_impact_status,
    securityValidator: row.security_validator_id,
    securityEvidence: row.security_evidence,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    validationTokenHash: row.validation_token_hash,
    evidenceHash: row.evidence_hash,
    persistentModification: row.persistent_modification,
    failureReason: row.failure_reason,
    archivedAt: row.archived_at,
    publicProofStatus: row.public_proof_status || 'UNAVAILABLE',
    publicValidator: row.public_validator_id,
    publicVisibilityVerified: row.public_visibility_verified || false,
    publicStartedAt: row.public_started_at,
    publicVerifiedAt: row.public_verified_at,
    publicExpiresAt: row.public_expires_at,
    publicEvidence: row.public_evidence,
    publicEvidenceHash: row.public_evidence_hash,
    publicFailureReason: row.public_failure_reason,
    provenance: row.provenance,
    createdAt: row.created_at,
  };
}

async function audit({ orgId, actorUserId, action, runId, target, proofId, validator = null, result, reason = null }) {
  await recordAuditEvent({
    orgId, actorUserId, action, targetType: 'controlled_proof_run', targetId: runId, result,
    metadata: { target, proofId, validator, ...(reason ? { reason } : {}) },
  });
}

async function findExistingFinding(orgId, target, normalizedTarget) {
  const { rows } = await query(
    `SELECT id FROM findings WHERE org_id=$1 AND target IN ($2,$3) ORDER BY updated_at DESC LIMIT 1`,
    [orgId, target, normalizedTarget]
  );
  return rows[0]?.id || null;
}

async function persistDecisionEvidence({ orgId, proofId, target, summary, payload, observedAt }) {
  const { rows } = await query(
    `INSERT INTO decision_evidence (
       org_id, evidence_key, source, engine_id, target, evidence_type, summary,
       redacted_payload, confidence, verification_status, observed_at
     ) VALUES ($1,$2,'CONTROLLED_PROOF',$3,$4,'SECURITY_IMPACT_VALIDATION',$5,$6,100,'OBSERVED',$7)
     ON CONFLICT (org_id, evidence_key) DO UPDATE SET observed_at=EXCLUDED.observed_at
     RETURNING id`,
    [orgId, `controlled-proof-impact:${proofId}`, CONTROLLED_PROOF_ENGINE_ID, target, summary, JSON.stringify(payload), observedAt]
  );
  return rows[0].id;
}

async function persistPublicEvidence({ orgId, proofId, target, payload, observedAt }) {
  const { rows } = await query(
    `INSERT INTO decision_evidence (
       org_id, evidence_key, source, engine_id, target, evidence_type, summary,
       redacted_payload, confidence, verification_status, observed_at
     ) VALUES ($1,$2,'CONTROLLED_PROOF',$3,$4,'PUBLIC_VISIBILITY_VALIDATION',$5,$6,100,'OBSERVED',$7)
     ON CONFLICT (org_id, evidence_key) DO UPDATE SET observed_at=EXCLUDED.observed_at
     RETURNING id`,
    [orgId, `controlled-proof-public:${proofId}`, CONTROLLED_PROOF_ENGINE_ID, target,
      'Marker observed through independent unauthenticated public requests', JSON.stringify(payload), observedAt]
  );
  return rows[0].id;
}

async function validateSecurityImpact(endpoints, marker, signal, evidenceCandidates = [], hasPotentialSignals = false) {
  const validators = listProofValidators();
  let candidateCount = 0;
  let lastEvidence = null;
  const validatorRejections = [];
  for (const validator of validators) {
    const discoveredCandidates = validator.candidates(endpoints);
    const seededCandidates = validator.id === 'response-reflection' ? evidenceCandidates : [];
    const candidates = [...new Map([...seededCandidates, ...discoveredCandidates]
      .map((candidate) => [`${candidate.endpoint}|${candidate.parameter}`, candidate])).values()];
    candidateCount += candidates.length;
    for (const candidate of candidates) {
      try {
        const validation = await validator.validate({ candidate, marker, timeoutMs: REQUEST_TIMEOUT_MS, signal });
        lastEvidence = validation.evidence;
        if (validation.verified) {
          return {
            status: ANALYSIS_RESULT.VERIFIED_IMPACT_PATH,
            validatorId: validator.id,
            findingId: candidate.findingId || null,
            evidence: { ...validation.evidence, candidateSource: candidate.source, sourceEngine: candidate.engineId || null, sourceFindingId: candidate.findingId || null, candidatesEvaluated: candidateCount },
            validatorRejections,
          };
        }
        validatorRejections.push({
          engineId: candidate.engineId || 'controlled-proof-discovery',
          reason: validation.reason || 'DETERMINISTIC_IMPACT_NOT_VERIFIED',
          validatorId: validator.id,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        lastEvidence = { errorClass: error?.name || 'Error' };
        validatorRejections.push({
          engineId: candidate.engineId || 'controlled-proof-discovery',
          reason: 'VALIDATOR_EXECUTION_FAILED', validatorId: validator.id,
        });
      }
    }
  }
  return {
    status: classifyAnalysisResult({ hasPotentialSignals }),
    validatorId: null,
    evidence: { candidatesEvaluated: candidateCount, lastEvidence },
    validatorRejections,
  };
}

function summarizeRejections(rejections) {
  return Object.values(rejections.reduce((summary, rejection) => {
    const key = `${rejection.engineId}:${rejection.reason}`;
    summary[key] ||= { engineId: rejection.engineId, reason: rejection.reason, count: 0 };
    summary[key].count += 1;
    return summary;
  }, {}));
}

export async function analyzeControlledProofTarget({ orgId, actorUserId, target, resumeRunId = null, workerJobId = null }) {
  const existing = resumeRunId
    ? (await query('SELECT * FROM controlled_proof_runs WHERE id=$1 AND org_id=$2 AND status=\'ANALYZING\'', [resumeRunId, orgId])).rows[0]
    : null;
  if (resumeRunId && !existing) return null;
  const normalizedTarget = existing?.normalized_target || normalizeProofTarget(target);
  const proofId = existing?.proof_id || generateProofId();
  const startedAt = existing?.started_at ? new Date(existing.started_at) : new Date();
  const validationToken = buildValidationToken(proofId, startedAt);
  const validationTokenHash = sha256(validationToken);
  const provenance = {
    engine: CONTROLLED_PROOF_ENGINE_ID,
    version: CONTROLLED_PROOF_ENGINE_VERSION,
    discovery: 'fuzzDiscovery',
    transport: 'nativeHttp/curl+verified-node-tls-fallback',
    validators: listProofValidators().map(({ id, status }) => ({ id, status })),
  };
  const created = existing ? { rows: [existing] } : await query(
    `INSERT INTO controlled_proof_runs (
       org_id, actor_user_id, target, normalized_target, proof_id, proof_type, status,
       started_at, validation_token_hash, persistent_modification, provenance
     ) VALUES ($1,$2,$3,$4,$5,'WEB_CONTENT_IMPACT','ANALYZING',$6,$7,false,$8) RETURNING *`,
    [orgId, actorUserId, target, normalizedTarget, proofId, startedAt, validationTokenHash, JSON.stringify(provenance)]
  );
  const runId = created.rows[0].id;

  // Scanner binaries deliberately live only in the worker image. A new
  // analysis therefore becomes a normal Postgres-backed worker job; the
  // worker resumes this same run (same Proof ID/timestamps) and executes
  // the existing adapters there. No scope-approval record or new RBAC
  // permission is introduced: the route has already enforced system:manage.
  if (!resumeRunId) {
    let job;
    try {
      job = await query(
      `INSERT INTO scan_jobs (
         org_id, requested_by, target, requested_class, scope_id, target_type,
         recommended_engine_ids, selected_engine_ids, recommended_capability_ids,
         selected_capability_ids, engine_options, controlled_proof_run_id
       ) VALUES ($1,$2,$3,'RESTRICTED',NULL,'URL',$4,$4,$5,$5,$6,$7)
       RETURNING id, status, created_at`,
      [orgId, actorUserId, normalizedTarget,
        CONTROLLED_PROOF_EVIDENCE_ENGINES,
        ['WEB', 'FUZZ', 'INTRUSIVE', 'NETWORK_DISCOVERY'],
        JSON.stringify({
          nuclei: { scanProfile: 'STANDARD', rateLimit: 5, timeoutMs: 12 * 60_000 },
          'http-fuzz': { baseProfile: 'STANDARD', timeoutMs: 30_000 },
          'intrusive-validation': { timeoutMs: 30_000 },
          naabu: { portProfile: 'TOP_PORTS', rateLimit: 50, timeoutMs: 60_000 },
        }), runId]
      );
    } catch (error) {
      await query(
        `UPDATE controlled_proof_runs SET status='FAILED', completed_at=now(),
           failure_reason='controlled_proof_worker_queue_failed', updated_at=now()
         WHERE id=$1 AND org_id=$2 AND status='ANALYZING'`,
        [runId, orgId]
      );
      throw error;
    }
    const queued = { ...created.rows[0], scan_job_id: job.rows[0].id };
    await audit({ orgId, actorUserId, action: 'controlled_proof.target_analyzed', runId, target: normalizedTarget, proofId, result: 'SUCCESS', reason: 'worker_job_queued' });
    return serializeRun(queued);
  }
  const controller = new AbortController();
  activeRuns.set(runId, controller);

  try {
    await audit({ orgId, actorUserId, action: 'controlled_proof.worker_analysis_started', runId, target: normalizedTarget, proofId, result: 'SUCCESS' });
    const transportHealth = await curlHealthCheck();
    if (transportHealth.status !== 'HEALTHY') throw new Error('controlled_proof_transport_unavailable');
    const canonical = await resolveCanonicalProofTarget(normalizedTarget, { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal });
    const canonicalTarget = canonical.target;
    const providerDiscovery = await discoverPublicVisibilityProviders(canonicalTarget, canonical.response?.headers || {});
    const liveEngineEvidence = await collectLiveControlledProofEvidence(canonicalTarget, { signal: controller.signal });
    const evidenceCandidates = await resolveControlledProofCandidates(
      orgId, [new URL(normalizedTarget), new URL(canonicalTarget)],
      { additionalRows: liveEngineEvidence.rows, providerIds: providerDiscovery.candidates.map((candidate) => candidate.providerId) }
    );
    const discovery = await discoverEndpoints(canonicalTarget, { timeoutMs: REQUEST_TIMEOUT_MS, followRedirects: false, signal: controller.signal });
    const impact = await validateSecurityImpact(
      discovery.endpoints, validationToken, controller.signal, evidenceCandidates.candidates,
      evidenceCandidates.impactSignalsMatched > 0
    );
    const candidateRejections = [...evidenceCandidates.rejections, ...(impact.validatorRejections || [])];
    const findingId = impact.findingId || evidenceCandidates.candidates.find((candidate) => candidate.findingId)?.findingId
      || await findExistingFinding(orgId, target, canonicalTarget);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const securityEvidence = {
      proofId,
      workerJobId,
      target: normalizedTarget,
      canonicalTarget,
      redirectChain: canonical.redirects,
      result: impact.status,
      validator: impact.validatorId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      validationTokenHash,
      endpointsDiscovered: discovery.endpoints.length,
      openapiSource: discovery.openapiSource,
      evidenceEnginesConsulted: CONTROLLED_PROOF_EVIDENCE_ENGINES,
      evidenceEngineCoverage: evidenceCandidates.engineCoverage,
      evidenceObservationsMatched: evidenceCandidates.observationsMatched,
      evidenceImpactSignalsMatched: evidenceCandidates.impactSignalsMatched,
      evidenceCandidatesResolved: impact.evidence?.candidatesEvaluated ?? evidenceCandidates.candidates.length,
      existingEvidenceCandidatesResolved: evidenceCandidates.candidates.length,
      candidateRejections: candidateRejections.slice(0, 50),
      candidateRejectionSummary: summarizeRejections(candidateRejections),
      securityObservationTotal: evidenceCandidates.observationSummaries.length,
      securityObservations: evidenceCandidates.observationSummaries.slice(0, 100),
      liveEngineExecutions: liveEngineEvidence.executions,
      liveEngineCoverage: {
        nativeHttp: { executed: true, transportVersion: transportHealth.version, requestTransport: canonical.response?.transport || 'curl' },
        fuzzDiscovery: { executed: true, endpointsDiscovered: discovery.endpoints.length, openapiSource: discovery.openapiSource },
      },
      deliveryProviderDiscovery: providerDiscovery,
      responseEvidence: impact.evidence,
      engine: CONTROLLED_PROOF_ENGINE_ID,
      engineVersion: CONTROLLED_PROOF_ENGINE_VERSION,
      transportVersion: transportHealth.version,
      persistentModification: false,
      provenance,
    };
    const publicCapabilities = publicVisibilityCapabilities(canonicalTarget);
    const publicProvider = impact.status === ANALYSIS_RESULT.VERIFIED_IMPACT_PATH
      ? resolvePublicVisibilityProvider(canonicalTarget, providerDiscovery) : null;
    securityEvidence.publicVisibilityCapabilities = publicCapabilities;
    securityEvidence.publicVisibilitySelection = impact.status !== ANALYSIS_RESULT.VERIFIED_IMPACT_PATH
      ? { status: 'NOT_APPLICABLE', providerId: null, reason: 'security_impact_not_verified' }
      : publicProvider
        ? { status: 'CONFIGURED', providerId: publicProvider.id, infrastructureProvider: publicProvider.infrastructureProvider }
        : {
            status: 'NOT_CONFIGURED', providerId: null,
            reason: publicCapabilities.some((capability) => capability.available)
              ? 'configured_adapter_does_not_match_detected_infrastructure'
              : 'no_configured_adapter_for_detected_provider',
          };
    const evidenceHash = sha256(securityEvidence);
    const { rows } = await query(
      `UPDATE controlled_proof_runs
          SET status='READY', finding_id=$1, security_impact_status=$2,
              security_validator_id=$3, security_evidence=$4, completed_at=$5, duration_ms=$6,
              evidence_hash=$7, public_proof_status=$10, public_validator_id=$11, updated_at=now()
        WHERE id=$8 AND org_id=$9 AND status='ANALYZING' RETURNING *`,
      [findingId, impact.status, impact.validatorId, JSON.stringify(securityEvidence),
        completedAt, durationMs, evidenceHash, runId, orgId,
        publicProvider ? 'AVAILABLE' : 'UNAVAILABLE', publicProvider?.id || null]
    );
    if (rows.length === 0) return getControlledProofRun(orgId, runId);
    if (impact.status === ANALYSIS_RESULT.VERIFIED_IMPACT_PATH) {
      const impactEvidenceId = await persistDecisionEvidence({
        orgId, proofId, target: normalizedTarget,
        summary: `Verified response impact path via ${impact.validatorId}`,
        payload: { ...securityEvidence, evidenceHash }, observedAt: completedAt,
      });
      await query(
        `UPDATE controlled_proof_runs SET impact_evidence_id=$1, updated_at=now()
          WHERE id=$2 AND org_id=$3 AND status='READY'`,
        [impactEvidenceId, runId, orgId]
      );
      rows[0].impact_evidence_id = impactEvidenceId;
    }
    await audit({
      orgId, actorUserId, action: 'controlled_proof.security_impact_result', runId, target: normalizedTarget,
      proofId, validator: impact.validatorId,
      result: impact.status === ANALYSIS_RESULT.VERIFIED_IMPACT_PATH ? 'SUCCESS' : 'REJECTED', reason: impact.status,
    });
    if (impact.status !== ANALYSIS_RESULT.NO_PATH) {
      await audit({ orgId, actorUserId, action: 'controlled_proof.candidate_discovered', runId, target: normalizedTarget, proofId, validator: impact.validatorId, result: 'SUCCESS', reason: impact.status });
    }
    if (impact.status === ANALYSIS_RESULT.POTENTIAL) {
      await audit({ orgId, actorUserId, action: 'controlled_proof.validator_rejected', runId, target: normalizedTarget, proofId, result: 'REJECTED', reason: 'deterministic_impact_not_verified' });
    }
    await audit({ orgId, actorUserId, action: 'controlled_proof.completed', runId, target: normalizedTarget, proofId, validator: impact.validatorId, result: 'SUCCESS', reason: impact.status });
    return serializeRun(rows[0]);
  } catch (error) {
    const current = await getControlledProofRun(orgId, runId);
    if (error?.name === 'AbortError' || current?.status === 'CANCELLED') return current;
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const reason = isCurlCertificateTrustError(error)
      ? 'tls_certificate_validation_failed'
      : String(error?.message || error).slice(0, 240);
    const failureEvidence = { proofId, target: normalizedTarget, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), durationMs, validationTokenHash, result: 'FAILED', reason, persistentModification: false, provenance };
    const evidenceHash = sha256(failureEvidence);
    const { rows } = await query(
      `UPDATE controlled_proof_runs SET status='FAILED', security_evidence=$1, completed_at=$2,
          duration_ms=$3, evidence_hash=$4, failure_reason=$5, updated_at=now()
        WHERE id=$6 AND org_id=$7 RETURNING *`,
      [JSON.stringify(failureEvidence), completedAt, durationMs, evidenceHash, reason, runId, orgId]
    );
    await audit({ orgId, actorUserId, action: 'controlled_proof.analysis_failed', runId, target: normalizedTarget, proofId, result: 'FAILURE', reason });
    return serializeRun(rows[0]);
  } finally {
    activeRuns.delete(runId);
  }
}

export async function getControlledProofRun(orgId, id) {
  const { rows } = await query('SELECT * FROM controlled_proof_runs WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL', [id, orgId]);
  const run = serializeRun(rows[0]);
  if (run?.publicProofStatus === 'ACTIVE' && run.publicExpiresAt && new Date(run.publicExpiresAt) <= new Date()) {
    return expirePublicVisibilityProof({ orgId, runId: id });
  }
  return run;
}

async function expirePublicVisibilityProof({ orgId, runId, actorUserId = null }) {
  const { rows } = await query('SELECT * FROM controlled_proof_runs WHERE id=$1 AND org_id=$2', [runId, orgId]);
  const row = rows[0];
  if (!row || !['ACTIVE', 'VERIFIED'].includes(row.public_proof_status)) return serializeRun(row);
  const marker = buildValidationToken(row.proof_id, new Date(row.started_at));
  const previousEvidence = row.public_evidence || {};
  let expiry;
  try {
    expiry = await expirePublicVisibilityProvider(row.public_validator_id, {
      target: previousEvidence.canonicalTarget || row.normalized_target, marker, resources: previousEvidence.resources,
    });
  } catch (error) {
    expiry = { removed: false, reason: String(error?.message || error).slice(0, 160) };
  }
  const publicEvidence = { ...previousEvidence, expiry };
  const publicEvidenceHash = sha256(publicEvidence);
  const nextStatus = expiry.removed ? 'EXPIRED' : 'FAILED';
  const updated = await query(
    `UPDATE controlled_proof_runs SET public_proof_status=$1, public_evidence=$2,
       public_evidence_hash=$3, updated_at=now()
     WHERE id=$4 AND org_id=$5 AND public_proof_status IN ('ACTIVE','VERIFIED') RETURNING *`,
    [nextStatus, JSON.stringify(publicEvidence), publicEvidenceHash, runId, orgId]
  );
  if (updated.rows[0]) await audit({ orgId, actorUserId: actorUserId || row.actor_user_id, action: expiry.removed ? 'controlled_proof.public_expired' : 'controlled_proof.public_expiry_failed', runId, target: row.normalized_target, proofId: row.proof_id, validator: row.public_validator_id, result: expiry.removed ? 'SUCCESS' : 'FAILURE', reason: expiry.reason || null });
  return serializeRun(updated.rows[0] || row);
}

export async function stopPublicVisibilityProof({ orgId, actorUserId, runId }) {
  const { rows } = await query('SELECT public_proof_status FROM controlled_proof_runs WHERE id=$1 AND org_id=$2', [runId, orgId]);
  if (rows[0]?.public_proof_status !== 'ACTIVE') return null;
  return expirePublicVisibilityProof({ orgId, actorUserId, runId });
}

export async function startPublicVisibilityProof({ orgId, actorUserId, runId, durationSeconds }) {
  const claimed = await query(
    `UPDATE controlled_proof_runs SET public_proof_status='ACTIVATING', updated_at=now()
     WHERE id=$1 AND org_id=$2 AND status='READY' AND security_impact_status='VERIFIED_IMPACT_PATH'
       AND public_proof_status='AVAILABLE' RETURNING *`,
    [runId, orgId]
  );
  const row = claimed.rows[0];
  if (!row) return null;
  const target = row.security_evidence?.canonicalTarget || row.normalized_target;
  const provider = resolvePublicVisibilityProvider(target, row.security_evidence?.deliveryProviderDiscovery);
  const marker = buildValidationToken(row.proof_id, new Date(row.started_at));
  let activation = null;
  try {
    if (!provider || provider.id !== row.public_validator_id) throw new Error('public_visibility_provider_unavailable');
    await audit({ orgId, actorUserId, action: 'controlled_proof.public_started', runId, target, proofId: row.proof_id, validator: provider.id, result: 'SUCCESS' });
    activation = await activatePublicVisibilityProvider(provider.id, { target, marker, proofId: row.proof_id, durationSeconds });
    const { startedAt, expiresAt } = activation;
    const publicEvidence = {
      proofId: row.proof_id, canonicalTarget: target, providerId: provider.id,
      mode: 'LIVE', durationSeconds, startedAt: startedAt.toISOString(), expiresAt: expiresAt.toISOString(),
      markerHash: sha256(marker), observations: activation.observations, resources: activation.resources,
      publicVisibilityVerified: true, originModified: false,
    };
    const publicEvidenceHash = sha256(publicEvidence);
    await persistPublicEvidence({ orgId, proofId: row.proof_id, target, payload: { ...publicEvidence, publicEvidenceHash }, observedAt: new Date() });
    const { rows } = await query(
      `UPDATE controlled_proof_runs SET public_proof_status='ACTIVE', public_visibility_verified=true, public_failure_reason=NULL,
         public_started_at=$1, public_verified_at=now(), public_expires_at=$2,
         public_evidence=$3, public_evidence_hash=$4, updated_at=now()
       WHERE id=$5 AND org_id=$6 AND public_proof_status='ACTIVATING' RETURNING *`,
      [startedAt, expiresAt, JSON.stringify(publicEvidence), publicEvidenceHash, runId, orgId]
    );
    await audit({ orgId, actorUserId, action: 'controlled_proof.public_verified', runId, target, proofId: row.proof_id, validator: provider.id, result: 'SUCCESS' });
    const timer = setTimeout(() => expirePublicVisibilityProof({ orgId, runId, actorUserId }).catch(() => {}), durationSeconds * 1000 + 250);
    timer.unref?.();
    return serializeRun(rows[0]);
  } catch (error) {
    const reason = String(error?.message || error).slice(0, 240);
    if (activation?.resources && provider) {
      await expirePublicVisibilityProvider(provider.id, { target, marker, resources: activation.resources }).catch(() => {});
    }
    const { rows } = await query(
      `UPDATE controlled_proof_runs SET public_proof_status='FAILED', public_failure_reason=$1, updated_at=now()
       WHERE id=$2 AND org_id=$3 AND public_proof_status='ACTIVATING' RETURNING *`,
      [reason, runId, orgId]
    );
    await audit({ orgId, actorUserId, action: 'controlled_proof.public_failed', runId, target, proofId: row.proof_id, validator: row.public_validator_id, result: 'FAILURE', reason });
    return serializeRun(rows[0]);
  }
}

export async function listControlledProofRuns(orgId, { archivedOnly = false, limit = 50 } = {}) {
  const { rows } = await query(
    `SELECT * FROM controlled_proof_runs WHERE org_id=$1 AND deleted_at IS NULL AND archived_at IS ${archivedOnly ? 'NOT NULL' : 'NULL'} ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows.map(serializeRun);
}

export async function cancelControlledProofRun({ orgId, actorUserId, runId }) {
  const { rows } = await query(
    `UPDATE controlled_proof_runs SET status='CANCELLED', completed_at=now(), failure_reason='cancelled_by_user', updated_at=now()
      WHERE id=$1 AND org_id=$2 AND status='ANALYZING' RETURNING *`,
    [runId, orgId]
  );
  if (rows.length === 0) return null;
  await query(
    `UPDATE scan_jobs SET status='CANCELLED', locked_by=NULL, updated_at=now()
      WHERE controlled_proof_run_id=$1 AND org_id=$2
        AND status NOT IN ('COMPLETED','FAILED','CANCELLED','TIMED_OUT')`,
    [runId, orgId]
  );
  activeRuns.get(runId)?.abort();
  await audit({ orgId, actorUserId, action: 'controlled_proof.cancelled', runId, target: rows[0].normalized_target, proofId: rows[0].proof_id, result: 'SUCCESS', reason: 'cancelled_by_user' });
  return serializeRun(rows[0]);
}

export async function archiveControlledProofRun({ orgId, actorUserId, runId }) {
  const { rows } = await query(
    `UPDATE controlled_proof_runs SET archived_at=now(), updated_at=now()
      WHERE id=$1 AND org_id=$2 AND archived_at IS NULL AND deleted_at IS NULL RETURNING *`,
    [runId, orgId]
  );
  if (rows.length === 0) return null;
  await audit({ orgId, actorUserId, action: 'controlled_proof.archived', runId, target: rows[0].normalized_target, proofId: rows[0].proof_id, result: 'SUCCESS' });
  return serializeRun(rows[0]);
}

export async function unarchiveControlledProofRun({ orgId, actorUserId, runId }) {
  const { rows } = await query(
    `UPDATE controlled_proof_runs SET archived_at=NULL, updated_at=now()
      WHERE id=$1 AND org_id=$2 AND archived_at IS NOT NULL AND deleted_at IS NULL RETURNING *`,
    [runId, orgId]
  );
  if (rows.length === 0) return null;
  await audit({ orgId, actorUserId, action: 'controlled_proof.unarchived', runId, target: rows[0].normalized_target, proofId: rows[0].proof_id, result: 'SUCCESS' });
  return serializeRun(rows[0]);
}

export async function deleteControlledProofRun({ orgId, actorUserId, runId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE controlled_proof_runs
          SET deleted_at=now(), archived_at=NULL, target='[deleted]', normalized_target='[deleted]',
              security_evidence='{}'::jsonb, evidence_hash=NULL, validation_token_hash=NULL,
              failure_reason=NULL, provenance='{}'::jsonb, updated_at=now()
        WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL AND status IN ('READY','FAILED','CANCELLED')
        RETURNING id, status, deleted_at`,
      [runId, orgId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `UPDATE scan_jobs
          SET deleted_at=now(), archived_at=NULL, target='[deleted]', result=NULL, error=NULL, updated_at=now()
        WHERE controlled_proof_run_id=$1 AND org_id=$2`,
      [runId, orgId]
    );
    await client.query(
      `INSERT INTO audit_events (org_id, actor_user_id, action, target_type, target_id, result, metadata)
       VALUES ($1,$2,'controlled_proof.deleted','controlled_proof_run',$3,'SUCCESS',$4)`,
      [orgId, actorUserId, runId, JSON.stringify({ detailsRetained: false })]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
