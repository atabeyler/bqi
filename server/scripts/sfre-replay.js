// Blind replay of TR-FUND-2026-001 on the PIT data in PostgreSQL.
//   node scripts/sfre-replay.js <confirmed-facts.json>
// confirmed-facts.json (YOU provide it from the SPK primary document): {"event_time":"...Z","event_entities":["FUND:XXX",...],"source_url":"...","confirmed_by":"name"}
import { getPool } from '../src/services/database.js';
import { PgStore } from '../src/sfre/storage/pgStore.js';
import { loadConfirmedFacts, runRealReplay } from '../src/sfre/validation/realReplay.js';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }
const confirmed = loadConfirmedFacts(process.argv[2]);
const store = new PgStore((t, p) => getPool().query(t, p));
await store.ensureSchema();
try {
  const pit = await store.loadPitStore({ asOfMax: confirmed.event_time });
  const res = runRealReplay({ store: pit, confirmed });
  await store.append('golden_replays', { id: `TR-FUND-2026-001@${new Date().toISOString()}`, result: res });
  console.log(JSON.stringify(res, null, 2));
} finally { await getPool().end(); }
