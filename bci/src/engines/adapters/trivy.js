import { runBinary } from '../execFileAsync.js';
import { config } from '../../config.js';

const BIN = config.engineBins.trivy;

export const trivyAdapter = {
  id: 'trivy',
  name: 'Trivy',
  license: 'Apache-2.0',
  intrusiveness: 'PASSIVE',
  capabilities: ['SCA', 'SECRETS', 'IAC', 'CONFIG'],
  supportedTargetTypes: ['REPOSITORY', 'CONTAINER'],
  supportedAnalysisTypes: ['SCA', 'SECRETS', 'IAC', 'CONFIG'],
  capabilitiesByTargetType: {
    REPOSITORY: ['SCA', 'SECRETS', 'IAC', 'CONFIG'],
    CONTAINER: ['SCA', 'SECRETS', 'CONFIG'],
  },
  executionOptions: { scannersByCapability: { SCA: 'vuln', SECRETS: 'secret', IAC: 'misconfig', CONFIG: 'misconfig' } },

  async healthCheck() {
    try {
      const { stdout } = await runBinary(BIN, ['--version'], { timeoutMs: 10_000 });
      const version = stdout.match(/Version:\s*(\S+)/)?.[1] || 'unknown';
      return { status: 'HEALTHY', version };
    } catch (err) {
      return { status: 'OFFLINE', detail: String(err.message || err) };
    }
  },

  async execute({ target, mode = 'fs', capabilities = this.capabilities, timeoutMs = 120_000 }) {
    const subcommand = mode === 'image' ? 'image' : 'fs';
    const scanners = [];
    if (capabilities.includes('SCA')) scanners.push('vuln');
    if (capabilities.includes('SECRETS')) scanners.push('secret');
    if (capabilities.includes('IAC') || capabilities.includes('CONFIG')) scanners.push('misconfig');
    const { stdout } = await runBinary(BIN, [subcommand, '--scanners', [...new Set(scanners)].join(','), '--format', 'json', '--quiet', target], { timeoutMs, allowedExitCodes: [0, 1] });
    const raw = JSON.parse(stdout);
    const resultCount = (raw.Results || []).reduce((sum, result) => sum + (result.Vulnerabilities?.length || 0) + (result.Secrets?.length || 0) + (result.Misconfigurations?.length || 0), 0);
    return { raw, executionMeta: { requestedScope: { mode, capabilities }, executedScope: { subcommand, capabilities, scanners: [...new Set(scanners)] }, resultCount } };
  },
};
