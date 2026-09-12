import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../src/db/client.js';
import { resetDatabase, createOrg } from './helpers/db.js';
import { storeRawObservation, normalizeStoredObservation } from '../src/services/normalization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trivyFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/normalization/trivy.json'), 'utf8'));

beforeEach(resetDatabase);

async function seedTrivyEngine() {
  await query(
    `INSERT INTO engine_registry (id, name, intrusiveness, license) VALUES ('trivy', 'Trivy', 'PASSIVE', 'Apache-2.0')
     ON CONFLICT (id) DO NOTHING`
  );
  await query(
    `INSERT INTO engine_health (engine_id, status, version) VALUES ('trivy', 'HEALTHY', '0.74.0')
     ON CONFLICT (engine_id) DO UPDATE SET status = 'HEALTHY', version = '0.74.0'`
  );
}

describe('normalization service (raw_observations -> normalized_observations)', () => {
  it('stores a raw observation untouched, then produces normalized rows from it', async () => {
    const orgId = await createOrg();
    await seedTrivyEngine();

    const rawId = await storeRawObservation({
      orgId,
      jobId: null,
      engineId: 'trivy',
      target: '/tmp/trivy-fixture',
      payload: trivyFixture,
    });

    const { rows: rawRows } = await query('SELECT payload FROM raw_observations WHERE id = $1', [rawId]);
    expect(rawRows[0].payload).toEqual(trivyFixture);

    const normalizedIds = await normalizeStoredObservation(rawId);
    expect(normalizedIds.length).toBeGreaterThan(0);

    const { rows } = await query(
      'SELECT * FROM normalized_observations WHERE raw_observation_id = $1',
      [rawId]
    );
    expect(rows.length).toBe(normalizedIds.length);
    expect(rows.every((r) => r.category === 'SCA')).toBe(true);
    expect(rows.every((r) => r.org_id === orgId)).toBe(true);
    expect(rows.every((r) => r.engine_version === '0.74.0')).toBe(true);
    expect(rows.some((r) => r.cve_ids.includes('CVE-2019-10744'))).toBe(true);
  });

  it('rejects normalizing a raw observation id that does not exist', async () => {
    await expect(normalizeStoredObservation('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
