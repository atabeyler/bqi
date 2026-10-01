// SFRE synthetic validation runner (machinery check; SYNTHETIC data only).
// Usage: node scripts/sfre-validate.js 2 3 4   -> writes docs/sfre/results/synthetic-seed-<n>.json
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSyntheticValidation } from '../src/sfre/validation/runSynthetic.js';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/sfre/results');
mkdirSync(outDir, { recursive: true });
const seeds = process.argv.slice(2).map(Number).filter(Number.isInteger);
for (const seed of seeds.length ? seeds : [2]) {
  const r = runSyntheticValidation({ seed });
  writeFileSync(path.join(outDir, `synthetic-seed-${seed}.json`), `${JSON.stringify(r, null, 2)}\n`);
  console.log(`seed ${seed}: done in ${r.elapsedMs}ms result_hash=${r.result_hash}`);
}
