import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const outDir = path.resolve(process.argv[2] || process.env.ELLIPTIC_DATA_DIR || './data/elliptic');
const base = process.env.ELLIPTIC_HF_BASE || 'https://huggingface.co/datasets/yhoma/elliptic-bitcoin-dataset/resolve/main';
const files = ['elliptic_txs_features.csv', 'elliptic_txs_classes.csv', 'elliptic_txs_edgelist.csv'];

await fs.mkdir(outDir, { recursive: true });
for (const file of files) {
  const target = path.join(outDir, file);
  console.log(`Downloading ${file} ...`);
  const response = await fetch(`${base}/${file}?download=true`, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${file}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(target));
  const stat = await fs.stat(target);
  console.log(`Saved ${target} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log('Elliptic dataset ready. Run: npm run benchmark:elliptic');
