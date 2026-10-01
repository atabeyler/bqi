import { describe, it, expect } from 'vitest';
import pg from 'pg';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PgStore } from '../storage/pgStore.js';
import { generateWorld } from '../validation/syntheticWorld.js';
import { runRealReplay, loadConfirmedFacts } from '../validation/realReplay.js';
import { loadGoldenCase } from '../validation/goldenCase.js';

const URL = process.env.SFRE_TEST_DATABASE_URL;
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

describe('confirmed-facts loader', () => {
  it('requires primary-source attribution; rejects incomplete facts', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sfre-')); const f = path.join(dir, 'c.json');
    writeFileSync(f, JSON.stringify({ event_time: 'x', event_entities: [] })); expect(() => loadConfirmedFacts(f)).toThrow(/invalid confirmed facts/);
    writeFileSync(f, JSON.stringify({ event_time: '2026-09-17T00:00:00Z', event_entities: ['FUND:ABC'], source_url: 'https://spk', confirmed_by: 'x' })); expect(loadConfirmedFacts(f).event_entities).toEqual(['FUND:ABC']);
  });
});

(URL ? describe : describe.skip)('end-to-end on PostgreSQL: ingest -> PIT load -> blind replay', () => {
  it('observations written to the DB and re-loaded drive the replay; real golden spec is BLOCKED without free-float data; synthetic never PASSED', async () => {
    const admin = new pg.Pool({ connectionString: URL }); await admin.query('DROP SCHEMA IF EXISTS sfre_e2e_test CASCADE; CREATE SCHEMA sfre_e2e_test'); await admin.end();
    const pool = new pg.Pool({ connectionString: URL, options: '-c search_path=sfre_e2e_test' });
    const store = new PgStore((t, p) => pool.query(t, p)); await store.ensureSchema();
    const world = generateWorld({ seed: 11, nFunds: 60, nAssets: 24, days: 460, nEvents: 2, fundsPerEvent: 2, firstEventDay: 380, lastEventDay: 420 });
    const all = world.store.asOf(world.startMs + 10000 * DAY).observations;
    const r = await store.addObservations(all); expect(r.inserted).toBe(all.length); expect(r.rejected).toHaveLength(0);
    const ev = world.events[0]; const confirmed = { event_time: iso(ev.event_time), event_entities: ev.entities, source_url: 'synthetic', confirmed_by: 'test' };
    const pit = await store.loadPitStore({ asOfMax: confirmed.event_time });
    expect(pit.size).toBeLessThan(all.length); // nothing at or after the event leaks into the loaded store
    // real golden spec requires free_float_shares + adv: the synthetic store has no free float -> gated, not guessed
    const gated = runRealReplay({ store: pit, confirmed, dataKind: 'SYNTHETIC' }); expect(gated.verdict).toBe('BLOCKED_NO_DATA'); expect(gated.reason).toBe('INSUFFICIENT_PRECURSOR_COVERAGE');
    // synthetic-appropriate precursor requirements: the machinery runs end to end
    const spec = loadGoldenCase('TR-FUND-2026-001'); spec.evaluation = { ...spec.evaluation, healthy_controls: { min_count: 20 }, required_precursors: [{ field: 'close', entity_prefix: 'BIST:', min_observations: 30, lookback_days: 120 }, { field: 'holdings', entity_prefix: 'FUND:', min_observations: 2, lookback_days: 120 }] };
    const res = runRealReplay({ store: pit, confirmed, spec, dataKind: 'SYNTHETIC' });
    expect(['SYNTHETIC_HARNESS_PASS', 'RELEASE_FAILURE', 'FALSE_ALARM_BUDGET_EXCEEDED']).toContain(res.verdict); expect(res.verdict).not.toBe('PASSED');
    expect(res.rule.fittedOn).toMatch(/unlabelled/); expect(res.controlFalseAlarmRate.n).toBeGreaterThanOrEqual(20); expect(res.dataKind).toBe('SYNTHETIC');
    await pool.end();
  }, 180000);
});
