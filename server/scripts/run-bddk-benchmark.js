import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import JSZip from 'jszip';
import { confusionMatrix } from '../src/benchmarks/benchmarkMetrics.js';
import { splitFraudConfirmation } from '../src/services/fraudSecondaryFilter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PYTHON = process.env.QISKIT_PYTHON || process.env.PYTHON || 'python';
const DEFAULT_SCRIPT = path.resolve(__dirname, '../quantum/fraud_detection_13q.py');

function parseSimpleCsv(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  headers[0] = headers[0].replace(/^\uFEFF/, '');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (cells[index] ?? '').trim();
    });
    return row;
  });
}

function pickZipEntries(zip) {
  const names = Object.keys(zip.files);
  const blindName = names.find((name) => /blind/i.test(name) && name.toLowerCase().endsWith('.csv'));
  const gtName = names.find((name) => /ground.?truth/i.test(name) && name.toLowerCase().endsWith('.csv'));
  if (!blindName || !gtName) {
    throw new Error('Zip içinde blind ve ground truth CSV dosyaları bulunamadı.');
  }
  return { blindName, gtName };
}

function toTransactions(rows) {
  return rows.map((row) => ({
    id: row['transaction id'],
    amount: Number(row.amount),
    hour: Number(row.hour),
    frequency: Number(row.frequency),
    newCounterparty: Number(row['new counterparty']),
    crossBorder: Number(row['cross border']),
  }));
}

function toLabels(rows) {
  return rows.map((row) => (Number(row.is_anomaly) ? 'illicit' : 'licit'));
}

function buildLabelMap(gtRows) {
  return new Map(gtRows.map((row) => [row['transaction id'], Number(row.is_anomaly) ? 'illicit' : 'licit']));
}

function buildPredictionMap(rows) {
  return new Map(rows.map((row) => [row.id, row.flagged ? 'illicit' : 'licit']));
}

function runFraudWorker(transactions, pythonBin = DEFAULT_PYTHON) {
  const payload = JSON.stringify({ transactions, skipHardware: true });
  const result = spawnSync(pythonBin, [DEFAULT_SCRIPT], {
    input: payload,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const message = result.stderr || result.stdout || `fraud worker failed with code ${result.status}`;
    throw new Error(message);
  }

  return JSON.parse(result.stdout);
}

function summarizePrimary(labels, rows) {
  const cm = confusionMatrix(labels, rows);
  const precision = cm.tp + cm.fp ? cm.tp / (cm.tp + cm.fp) : 0;
  const recall = cm.tp + cm.fn ? cm.tp / (cm.tp + cm.fn) : 0;
  return {
    tp: cm.tp,
    fp: cm.fp,
    tn: cm.tn,
    fn: cm.fn,
    precision,
    recall,
  };
}

function summarizeSecondary(labelMap, rows) {
  const { confirmed } = splitFraudConfirmation(rows);
  const confirmedIds = new Set(confirmed.map((row) => row.id));
  const labels = rows.map((row) => labelMap.get(row.id) || 'licit');
  const predictions = rows.map((row) => (confirmedIds.has(row.id) ? 'illicit' : 'licit'));
  const cm = confusionMatrix(labels, predictions);
  const precision = cm.tp + cm.fp ? cm.tp / (cm.tp + cm.fp) : 0;
  const recall = cm.tp + cm.fn ? cm.tp / (cm.tp + cm.fn) : 0;
  return {
    confirmedCount: confirmed.length,
    tp: cm.tp,
    fp: cm.fp,
    tn: cm.tn,
    fn: cm.fn,
    precision,
    recall,
  };
}

async function scoreZip(zipPath, pythonBin = DEFAULT_PYTHON) {
  const raw = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(raw);
  const { blindName, gtName } = pickZipEntries(zip);
  const blindRows = parseSimpleCsv(await zip.file(blindName).async('string'));
  const gtRows = parseSimpleCsv(await zip.file(gtName).async('string'));
  const transactions = toTransactions(blindRows);
  const workerResult = runFraudWorker(transactions, pythonBin);
  const labelMap = buildLabelMap(gtRows);
  const predictionMap = buildPredictionMap(workerResult.transactions);
  const orderedLabels = blindRows.map((row) => labelMap.get(row['transaction id']) || 'licit');
  const orderedPrimaryPredictions = blindRows.map((row) => predictionMap.get(row['transaction id']) || 'licit');
  const primary = summarizePrimary(orderedLabels, orderedPrimaryPredictions);
  const secondary = summarizeSecondary(labelMap, workerResult.transactions);

  return {
    zipPath,
    blindName,
    gtName,
    records: transactions.length,
    positives: orderedLabels.filter((label) => label === 'illicit').length,
    primary,
    secondary,
  };
}

function printSummary(summary) {
  console.log(`ZIP: ${summary.zipPath}`);
  console.log(`  Records: ${summary.records}`);
  console.log(`  Positives: ${summary.positives}`);
  console.log(`  Primary: recall=${(summary.primary.recall * 100).toFixed(1)}% precision=${(summary.primary.precision * 100).toFixed(1)}% fp=${summary.primary.fp} fn=${summary.primary.fn}`);
  console.log(`  Secondary confirmed: ${summary.secondary.confirmedCount} recall=${(summary.secondary.recall * 100).toFixed(1)}% precision=${(summary.secondary.precision * 100).toFixed(1)}% fp=${summary.secondary.fp} fn=${summary.secondary.fn}`);
}

async function main() {
  const args = process.argv.slice(2);
  const pythonIndex = args.indexOf('--python');
  const pythonBin = pythonIndex !== -1 ? args[pythonIndex + 1] : DEFAULT_PYTHON;
  const zipPaths = args.filter((arg, index) => {
    if (arg === '--python') return false;
    if (index > 0 && args[index - 1] === '--python') return false;
    return arg.toLowerCase().endsWith('.zip');
  });

  if (!zipPaths.length) {
    throw new Error('Kullanım: node scripts/run-bddk-benchmark.js <zip> [<zip> ...] [--python <pythonBin>]');
  }

  const summaries = [];
  for (const zipPath of zipPaths) {
    summaries.push(await scoreZip(zipPath, pythonBin));
  }

  for (const summary of summaries) printSummary(summary);
  console.log(JSON.stringify({ summaries }, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
