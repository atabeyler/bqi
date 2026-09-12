import { recordAuditEvent } from './audit.js';
import { classifyTarget, normalizeTargetForExecution } from '../lib/targetMatcher.js';

// Scope authorization is not enforced: every target/class combination is
// ALLOWed without consulting authorized_scopes at all. targetType is a
// best-effort guess from the target string's shape (classifyTarget), since
// there is no scope to draw a real one from -- this is what
// analysisPlanner.js plans engines against downstream.
export async function evaluateScopeAuthorization({ orgId, actorUserId, target, requestedClass }) {
  const normalizedTarget = normalizeTargetForExecution(target);
  const decision = { decision: 'ALLOW', reason: 'scope_enforcement_removed', targetType: classifyTarget(normalizedTarget), normalizedTarget };

  await recordAuditEvent({
    orgId,
    actorUserId,
    action: 'policy.evaluate',
    targetType: 'scope',
    targetId: normalizedTarget,
    result: decision.decision,
    metadata: { requestedClass, reason: decision.reason },
  });

  return decision;
}
