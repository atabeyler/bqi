import { runBinary } from '../execFileAsync.js';
import { config } from '../../config.js';
const BIN = config.engineBins.osvScanner;
export const osvScannerAdapter = {
  id: 'osv-scanner', name: 'OSV-Scanner', license: 'Apache-2.0', intrusiveness: 'PASSIVE', capabilities: ['SCA', 'SUPPLY_CHAIN'],
  supportedTargetTypes: ['REPOSITORY'], supportedAnalysisTypes: ['SCA', 'SUPPLY_CHAIN'],
  executionOptions: { recursive: true, ecosystems: 'OSV_SCANNER_NATIVE' },
  async healthCheck() { try { const { stdout } = await runBinary(BIN, ['--version'], { timeoutMs: 10_000 }); const version = stdout.match(/osv-scanner version:\s*(\S+)/)?.[1] || 'unknown'; return { status: 'HEALTHY', version }; } catch (err) { return { status: 'OFFLINE', detail: String(err.message || err) }; } },
  async execute({ target, timeoutMs = 120_000 }) {
    const { stdout } = await runBinary(BIN, ['scan', '--format', 'json', '--recursive', target], { timeoutMs, allowedExitCodes: [0, 1] });
    const raw = JSON.parse(stdout);
    const resultCount = (raw.results || []).reduce((sum, result) => sum + (result.packages || []).reduce((n, pkg) => n + (pkg.vulnerabilities || []).length, 0), 0);
    return { raw, executionMeta: { requestedScope: { recursive: true }, executedScope: { recursive: true, ecosystemDetection: 'native' }, resultCount } };
  },
};
