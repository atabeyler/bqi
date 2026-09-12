import { runBinary } from '../execFileAsync.js';
import { config } from '../../config.js';
const BIN = config.engineBins.semgrep;
export const semgrepAdapter = {
  id: 'semgrep', name: 'Semgrep', license: 'LGPL-2.1', intrusiveness: 'PASSIVE', capabilities: ['SAST'],
  supportedTargetTypes: ['REPOSITORY'], supportedAnalysisTypes: ['SAST'],
  executionOptions: { configs: ['auto', 'p/default', 'p/security-audit', 'p/owasp-top-ten'] },
  // Semgrep is a Python application; importing it for the first time in a
  // freshly deployed container can legitimately exceed ten seconds. This is
  // still a real binary check, only with enough time for a cold start.
  async healthCheck() { try { const { stdout, stderr } = await runBinary(BIN, ['--version'], { timeoutMs: 30_000 }); return { status: 'HEALTHY', version: (stdout || stderr).trim() }; } catch (err) { return { status: 'OFFLINE', detail: String(err.message || err) }; } },
  async execute({ target, config: ruleset = 'auto', timeoutMs = 180_000 }) {
    const allowed = this.executionOptions.configs;
    if (!allowed.includes(ruleset)) throw new TypeError(`unsupported Semgrep config: ${ruleset}`);
    const { stdout } = await runBinary(BIN, ['--config', ruleset, '--json', '--quiet', target], { timeoutMs, allowedExitCodes: [0, 1] });
    const raw = JSON.parse(stdout);
    return { raw, executionMeta: { requestedScope: { config: ruleset, recursiveRepository: true }, executedScope: { config: ruleset, recursiveRepository: true }, resultCount: raw.results?.length || 0 } };
  },
};
