// Renders a sample situation report from the published breadth trial (real weekly numbers; no FX or coverage sections, no invented data).
// Usage: node scripts/sfre-sample-report.js <out.html|out.pdf|out.docx> [YYYY-MM-DD] [tr|en|de|fr|ar]
import { readFileSync, writeFileSync } from 'node:fs';
import { buildReport } from '../src/sfre/report/service.js';
import { renderReportPdf, renderReportDocx } from '../src/sfre/report/exportFiles.js';

const lang = process.argv[4] || 'tr'; const out = process.argv[2]; if (!out) { console.error('usage: node scripts/sfre-sample-report.js <out.html|pdf|docx> [YYYY-MM-DD] [tr|en|de|fr|ar]'); process.exit(2); }
const trial = JSON.parse(readFileSync(new URL('../../docs/sfre/results/breadth-trial-tefas.json', import.meta.url), 'utf8'));
const asOf = process.argv[3] || trial.weeks.at(-1).date; const weeks = trial.weeks.filter((w) => w.date <= asOf);
const r = buildReport({ breadth: { ...trial, weeks }, fx: null, now: new Date(`${asOf}T12:00:00Z`), coverage: [], models: [{ id: 'M20', state: 'DEVELOPMENT' }, { id: 'M21', state: 'DEVELOPMENT' }] }, { version: 'örnek', lang });
writeFileSync(out, out.endsWith('.pdf') ? await renderReportPdf(r.model) : out.endsWith('.docx') ? await renderReportDocx(r.model) : r.html); console.log(`wrote ${out}`);
