// Renders a sample situation report from the published breadth trial (real weekly numbers; no FX or coverage sections, no invented data). Usage: node scripts/sfre-sample-report.js <out.html> [asOfDate]
import { readFileSync, writeFileSync } from 'node:fs';
import { buildReport } from '../src/sfre/report/service.js';

const out = process.argv[2]; if (!out) { console.error('usage: node scripts/sfre-sample-report.js <out.html> [YYYY-MM-DD]'); process.exit(2); }
const trial = JSON.parse(readFileSync(new URL('../../docs/sfre/results/breadth-trial-tefas.json', import.meta.url), 'utf8'));
const asOf = process.argv[3] || trial.weeks.at(-1).date; const weeks = trial.weeks.filter((w) => w.date <= asOf);
const { html } = buildReport({ breadth: { ...trial, weeks }, fx: null, now: new Date(`${asOf}T12:00:00Z`), coverage: [], models: [{ id: 'M20', state: 'DEVELOPMENT' }, { id: 'M21', state: 'DEVELOPMENT' }] }, { version: 'örnek' });
writeFileSync(out, html); console.log(`wrote ${out}`);
