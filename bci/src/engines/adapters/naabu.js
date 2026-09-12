import { runBinary } from '../execFileAsync.js';
import { config } from '../../config.js';
import { resolveNaabuScope, NAABU_PORT_PROFILES } from '../executionProfiles.js';
const BIN = config.engineBins.naabu;
export const naabuAdapter = {
  id: 'naabu', name: 'naabu', license: 'MIT', intrusiveness: 'SAFE_ACTIVE', capabilities: ['NETWORK_DISCOVERY'],
  // Naabu resolves hostnames itself (official CLI examples use -host
  // hackerone.com), so DOMAIN/SUBDOMAIN are genuine supported inputs, not
  // aliases that pretend a source-code engine can scan a web target.
  supportedTargetTypes: ['DOMAIN', 'SUBDOMAIN', 'IP', 'CIDR'], supportedAnalysisTypes: ['NETWORK_DISCOVERY'],
  executionOptions: { portProfiles: [...Object.keys(NAABU_PORT_PROFILES), 'CUSTOM'] },
  // The shared DOMAIN preparation path produces an HTTPS URL for web
  // engines. Naabu's -host flag requires a hostname, not a URL.
  normalizeExecutionTarget(target) {
    try { return new URL(target).hostname; } catch { return target; }
  },
  async healthCheck() { try { const { stdout, stderr } = await runBinary(BIN, ['-version'], { timeoutMs: 10_000 }); const version = (stdout + stderr).match(/[Vv]ersion:?\s+v?(\S+)/)?.[1] || 'unknown'; return { status: 'HEALTHY', version }; } catch (err) { return { status: 'OFFLINE', detail: String(err.message || err) }; } },
  async execute({ target, portProfile = 'TOP_PORTS', customPorts, ports, timeoutMs = 60_000, rateLimit = 100 }) {
    const scope = ports
      ? { portProfile: 'CUSTOM', requested: ports, executed: ports, args: ['-p', ports] }
      : resolveNaabuScope(portProfile, customPorts);
    const { stdout } = await runBinary(BIN, ['-host', target, ...scope.args, '-scan-type', 'connect', '-rate', String(rateLimit), '-json', '-silent'], { timeoutMs, allowedExitCodes: [0] });
    const raw = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { raw, executionMeta: { requestedScope: { portProfile: scope.portProfile, ports: scope.requested, rateLimit }, executedScope: { ports: scope.executed, rateLimit }, resultCount: raw.length } };
  },
};
