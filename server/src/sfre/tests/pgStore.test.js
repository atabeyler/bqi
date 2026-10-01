import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PgStore } from '../storage/pgStore.js';
import { makeObservation } from '../data/observation.js';
import { EvidenceLedger } from '../evidence/ledger.js';
import { ModelRegistry, createDefaultRegistry, GovernanceError } from '../governance/modelRegistry.js';
import { makeResult, STATUS, coverageOf } from '../core/result.js';
import { obs, T0, DAY, iso } from './helpers.js';

const URL = process.env.SFRE_TEST_DATABASE_URL;
const d = URL ? describe : describe.skip; // needs a real PostgreSQL (CI provides one; locally set SFRE_TEST_DATABASE_URL)

d('PgStore on real PostgreSQL', () => {
  let pool; let store;
  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: URL });
    await admin.query('DROP SCHEMA IF EXISTS sfre_pg_test CASCADE; CREATE SCHEMA sfre_pg_test'); await admin.end(); // own schema: test files run in parallel
    pool = new pg.Pool({ connectionString: URL, options: '-c search_path=sfre_pg_test' });
    store = new PgStore((t, p) => pool.query(t, p));
    await store.ensureSchema(); await store.ensureSchema(); // idempotent
  });
  afterAll(async () => { await pool.end(); });

  it('observations: validated bulk insert, duplicates ignored, tampered rows rejected, PIT-filtered load', async () => {
    const list = [0, 1, 2].map((i) => makeObservation(obs({ t: T0 + i * DAY, value: i, available_time: iso(T0 + i * DAY + DAY) , ingested_time: iso(T0 + i * DAY + DAY) })));
    const tampered = { ...list[0], value: 99 };
    const r = await store.addObservations([...list, tampered]);
    expect(r.inserted).toBe(3); expect(r.rejected).toHaveLength(1);
    expect((await store.addObservations(list)).duplicates).toBe(3);
    const loaded = await store.loadPitStore({ asOfMax: iso(T0 + 2 * DAY) });
    expect(loaded.size).toBe(2); // third obs becomes available at T0+3d
    expect(loaded.asOf(T0 + 2 * DAY).series('BIST:AAAA', 'close').map((x) => x.value)).toEqual([0, 1]);
    const all = await store.loadPitStore({ asOfMax: iso(T0 + 10 * DAY) }); expect(all.size).toBe(3);
    // round trip preserves hash validity (store.add re-validates)
    expect(all.asOf(T0 + 10 * DAY).latest('BIST:AAAA', 'close').hash).toBe(list[2].hash);
  });
  it('append-only: UPDATE/DELETE on observations, records and ledger are rejected by the database', async () => {
    await store.append('runs', { id: 'r1', a: 1 });
    await expect(pool.query("UPDATE sfre_records SET record='{}'")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM sfre_observations')).rejects.toThrow(/append-only/);
  });
  it('records: insert-once semantics, get/list', async () => {
    await store.append('runs', { id: 'r2', a: 1 }); await store.append('runs', { id: 'r2', a: 2 });
    expect((await store.get('runs', 'r2')).a).toBe(1); expect((await store.list('runs')).length).toBeGreaterThanOrEqual(2); expect(await store.get('runs', 'zzz')).toBeNull();
  });
  it('ledger survives a restart: save, reload, verify chain, explain; DB refuses to alter it; tampering is detected on load', async () => {
    const clock = () => '2026-01-01T00:00:00Z'; const l = new EvidenceLedger({ clock });
    const res = makeResult({ engine: 'e', modelId: 'm', status: STATUS.MEASURED, value: { x: 1 }, coverage: coverageOf(1, 1) });
    const claim = l.recordClaim({ claim: 'c', result: res });
    await store.saveLedger(l); await store.saveLedger(l); // idempotent
    const re = await store.loadLedger({ clock });
    expect(re.verify().ok).toBe(true); expect(re.explain(claim).result_hash).toBe(res.result_hash);
    await expect(pool.query("UPDATE sfre_ledger SET hash = repeat('0',64)")).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM sfre_ledger')).rejects.toThrow(/append-only/);
    // simulate a privileged tamper (trigger disabled) and prove load refuses it
    await pool.query('ALTER TABLE sfre_ledger DISABLE TRIGGER sfre_ledger_ro');
    await pool.query("UPDATE sfre_ledger SET entry = jsonb_set(entry,'{payload,claim}','\"forged\"') WHERE seq = (SELECT max(seq) FROM sfre_ledger)");
    await pool.query('ALTER TABLE sfre_ledger ENABLE TRIGGER sfre_ledger_ro');
    await expect(store.loadLedger({ clock })).rejects.toThrow(/failed verification/);
  });
  it('governance state persists across restarts with verified history; forged history is refused', async () => {
    const reg = createDefaultRegistry();
    reg.transition('M10.cascade', '1.0.0', 'VALIDATION', { actor: { id: 'dev', kind: 'human' }, evidence: { spec_ref: 's' } });
    await store.saveModels(reg);
    const restored = new ModelRegistry().loadState(await store.loadModels());
    expect(restored.get('M10.cascade', '1.0.0').state).toBe('VALIDATION'); expect(restored.verifyHistory('M10.cascade', '1.0.0')).toBe(true);
    const forged = await store.loadModels(); forged.find((m) => m.model_id === 'M10.cascade').history[1].to = 'APPROVED';
    expect(() => new ModelRegistry().loadState(forged)).toThrow(GovernanceError);
  });
});
