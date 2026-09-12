import { Router } from 'express';
import { query } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../lib/rbac.js';

export const observationsRouter = Router();

observationsRouter.use(requireAuth);

// Normalized observations aren't Findings yet (that's Correlation/
// Verification, M7) -- this is a read-only view onto what M6 produced,
// useful for debugging a normalizer without needing DB access.
observationsRouter.get('/', requirePermission('finding:view'), async (req, res) => {
  const { jobId } = req.query;
  const params = [req.auth.orgId];
  let where = 'org_id = $1';
  if (jobId) {
    params.push(jobId);
    where += ` AND job_id = $${params.length}`;
  }

  const { rows } = await query(
    `SELECT id, engine_id, engine_version, rule_id, target, category, title, description,
            engine_severity, cve_ids, cwe_ids, cvss_vector, cvss_score, component,
            component_version, location, "references", detected_at
       FROM normalized_observations
      WHERE ${where}
      ORDER BY detected_at DESC
      LIMIT 200`,
    params
  );
  res.json({ observations: rows });
});
