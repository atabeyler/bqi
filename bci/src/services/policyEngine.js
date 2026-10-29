import { recordAuditEvent } from './audit.js';
import { classifyTarget, normalizeTargetForExecution,targetMatchesTyped } from '../lib/targetMatcher.js';
import {query} from '../db/client.js';

// The explicit legacy switch applies only to a live, tenant-bound system
// administrator. Roles are read from the DB, never asserted by the client.
export async function evaluateScopeAuthorization({ orgId, actorUserId, target, requestedClass }) {
  const normalizedTarget = normalizeTargetForExecution(target);
  const decision = { decision: 'DENY', reason: 'no_approved_scope', targetType: classifyTarget(normalizedTarget), normalizedTarget };
  if (process.env.BCI_DISABLE_SCOPE_ENFORCEMENT === 'true' && actorUserId && orgId) {
    const admin = await query(
      `SELECT 1 FROM user_roles ur JOIN users u ON u.id=ur.user_id AND u.org_id=ur.org_id
       WHERE ur.user_id=$1 AND ur.org_id=$2 AND ur.role_id='system_admin' AND u.blocked IS NOT TRUE LIMIT 1`,
      [actorUserId, orgId]
    );
    if (admin.rows.length) {
      decision.decision = 'ALLOW';
      decision.reason = 'system_admin_scope_override';
    }
  }
  if(decision.decision !== 'ALLOW' && process.env.NODE_ENV==='test' && process.env.BCI_ALLOW_UNSCOPED_TESTS==='1'){decision.decision='ALLOW';decision.reason='isolated_legacy_test_harness';}
  else if (decision.decision !== 'ALLOW') {
    const scopes=await query("SELECT id,target,target_type FROM authorized_scopes WHERE org_id=$1 AND status='APPROVED' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND $2=ANY(allowed_scan_classes)",[orgId,requestedClass]);
    let allowed;
    for(const scope of scopes.rows){
      if(!targetMatchesTyped(scope.target_type,scope.target,normalizedTarget))continue;
      const exclusions=await query('SELECT pattern FROM scope_exclusions WHERE scope_id=$1',[scope.id]);
      const excluded=exclusions.rows.some(({pattern})=>{
        if(pattern==='*')return true;
        if(pattern.startsWith('/') && /^https?:/i.test(normalizedTarget)){const p=new URL(normalizedTarget).pathname,base=pattern.replace(/\*$/,'');return p===base || p.startsWith(base.endsWith('/')?base:base+'/');}
        return targetMatchesTyped(scope.target_type,pattern,normalizedTarget);
      });
      if(excluded){decision.reason='target_excluded';allowed=null;break;}
      allowed ||= scope;
    }
    if(allowed){decision.decision='ALLOW';decision.reason='approved_scope';decision.scopeId=allowed.id;}
  }

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
