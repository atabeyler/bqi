import { query } from '../db/client.js';
import { recordAuditEvent } from './audit.js';
import { nucleiAdapter } from '../engines/adapters/nuclei.js';
import { naabuAdapter } from '../engines/adapters/naabu.js';

// BCI Verify (spec section 35): re-check one specific Finding, not the
// whole system. Only re-checkable when the original detection was itself a
// live probe (WEB via nuclei, NETWORK_DISCOVERY via naabu) -- a static
// SAST/SCA/SECRETS finding has no live signal to re-observe without a
// fresh source checkout this milestone doesn't have, so it's honestly
// INCONCLUSIVE rather than guessed at.
async function loadFindingWithSources(orgId, findingId) {
  const { rows } = await query('SELECT * FROM findings WHERE id = $1 AND org_id = $2', [findingId, orgId]);
  const finding = rows[0];
  if (!finding) return null;

  const { rows: sources } = await query(
    `SELECT fs.engine_id, no.rule_id, no.location
       FROM finding_sources fs JOIN normalized_observations no ON no.id = fs.normalized_observation_id
      WHERE fs.finding_id = $1`,
    [findingId]
  );
  return { finding, sources };
}

async function recordVerificationRun({ orgId, actorUserId, findingId, result, detail }) {
  await query(
    'INSERT INTO verification_runs (org_id, finding_id, triggered_by, result, detail) VALUES ($1,$2,$3,$4,$5)',
    [orgId, findingId, actorUserId, result, detail ?? null]
  );
  await recordAuditEvent({
    orgId, actorUserId, action: 'finding.verify_fix', targetType: 'finding', targetId: findingId, result, metadata: { detail },
  });
  if (result === 'FIX_VERIFIED') {
    await query("UPDATE findings SET status = 'VERIFIED_FIXED', updated_at = now() WHERE id = $1", [findingId]);
  }
}

async function verifyWebFinding({ finding, source }) {
  const { raw } = await nucleiAdapter.execute({ target: finding.target, templateId: source.rule_id });
  const stillMatches = raw.some((r) => r['template-id'] === source.rule_id && r['matcher-status']);
  return stillMatches
    ? { result: 'VULNERABILITY_REMAINS', detail: 'the original template still matches' }
    : { result: 'FIX_VERIFIED', detail: 'the original template no longer matches' };
}

async function verifyNetworkFinding({ source }) {
  const [host, portStr] = source.location.split(':');
  const port = Number(portStr);
  if (!host || !port) return { result: 'INCONCLUSIVE', detail: 'could not parse host:port from location' };

  const { raw } = await naabuAdapter.execute({ target: host, ports: String(port) });
  const stillOpen = raw.some((r) => r.port === port);
  return stillOpen
    ? { result: 'VULNERABILITY_REMAINS', detail: `port ${port} is still open` }
    : { result: 'FIX_VERIFIED', detail: `port ${port} is no longer open` };
}

export async function verifyFix(orgId, actorUserId, findingId) {
  const loaded = await loadFindingWithSources(orgId, findingId);
  if (!loaded) return null;
  const { finding, sources } = loaded;

  let outcome;
  const nucleiSource = sources.find((s) => s.engine_id === 'nuclei' && s.rule_id);
  const naabuSource = sources.find((s) => s.engine_id === 'naabu');

  try {
    if (nucleiSource) {
      outcome = await verifyWebFinding({ orgId, actorUserId, finding, source: nucleiSource });
    } else if (naabuSource) {
      outcome = await verifyNetworkFinding({ orgId, actorUserId, finding, source: naabuSource });
    } else {
      outcome = { result: 'INCONCLUSIVE', detail: 'no live-recheckable source (static finding needs a fresh scan)' };
    }
  } catch (err) {
    outcome = { result: 'INCONCLUSIVE', detail: `re-check failed: ${String(err.message || err)}` };
  }

  await recordVerificationRun({ orgId, actorUserId, findingId, ...outcome });
  return outcome;
}
