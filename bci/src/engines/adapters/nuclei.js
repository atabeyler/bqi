import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBinary } from '../execFileAsync.js';
import { config } from '../../config.js';
import {
  NUCLEI_SAFE_CATEGORIES, NUCLEI_SCAN_PROFILES, NUCLEI_TEMPLATES_DIR,
  NUCLEI_TEMPLATES_VERSION, resolveNucleiScope,
} from '../executionProfiles.js';
const BIN = config.engineBins.nuclei;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'nuclei');
const PROFILE_TIMEOUT_MS = Object.freeze({
  BCI_BUNDLED: 120_000,
  STANDARD: 10 * 60_000,
  EXTENDED: 20 * 60_000,
  FULL_SAFE: 30 * 60_000,
});
export const nucleiAdapter = {
  id: 'nuclei', name: 'Nuclei', license: 'MIT', intrusiveness: 'SAFE_ACTIVE', capabilities: ['WEB', 'API'],
  supportedTargetTypes: ['DOMAIN', 'SUBDOMAIN', 'URL', 'API'], supportedAnalysisTypes: ['WEB', 'API'],
  capabilitiesByTargetType: { DOMAIN: ['WEB'], SUBDOMAIN: ['WEB'], URL: ['WEB'], API: ['API'] },
  executionOptions: {
    scanProfiles: Object.keys(NUCLEI_SCAN_PROFILES),
    templateCategories: Object.keys(NUCLEI_SAFE_CATEGORIES),
    officialTemplateVersion: NUCLEI_TEMPLATES_VERSION,
    bundledTemplates: true,
    excludedTags: ['dos', 'fuzz', 'intrusive', 'bruteforce', 'default-login', 'token-spray', 'credential-stuffing'],
  },
  async healthCheck() { try { const { stdout, stderr } = await runBinary(BIN, ['-version'], { timeoutMs: 15_000 }); const version = (stdout + stderr).match(/Nuclei Engine Version:\s*(\S+)/)?.[1] || 'unknown'; return { status: 'HEALTHY', version }; } catch (err) { return { status: 'OFFLINE', detail: String(err.message || err) }; } },
  async execute({ target, timeoutMs, rateLimit = 10, scanProfile = 'STANDARD', templateCategories, templatesDir, templateId }) {
    const scope = templateId
      ? { profile: 'BCI_BUNDLED', categories: [], templateVersion: 'BCI_BUNDLED' }
      : resolveNucleiScope(scanProfile, templateCategories);
    const effectiveTimeoutMs = timeoutMs ?? PROFILE_TIMEOUT_MS[scope.profile];
    const excludedTags = this.executionOptions.excludedTags.join(',');
    const invocations = [];
    const baseArgs = ['-target', target, '-jsonl', '-silent', '-etags', excludedTags, '-rate-limit', String(rateLimit), '-no-interactsh', '-disable-update-check'];
    const bundledArgs = [...baseArgs, '-templates', templatesDir || BUNDLED_TEMPLATES_DIR];
    if (templateId) bundledArgs.push('-template-id', templateId);
    invocations.push({ source: 'BCI_BUNDLED', categories: ['BCI_BUNDLED'], args: bundledArgs });

    if (!templateId && scope.categories.length) {
      const directoryCategories = scope.categories.filter((id) => id !== 'API');
      if (directoryCategories.length) {
        invocations.push({
          source: NUCLEI_TEMPLATES_VERSION,
          categories: directoryCategories,
          args: [...baseArgs, ...directoryCategories.flatMap((id) => ['-templates', path.join(NUCLEI_TEMPLATES_DIR, NUCLEI_SAFE_CATEGORIES[id])])],
        });
      }
      if (scope.categories.includes('API')) {
        invocations.push({
          source: NUCLEI_TEMPLATES_VERSION,
          categories: ['API'],
          args: [...baseArgs, '-templates', path.join(NUCLEI_TEMPLATES_DIR, NUCLEI_SAFE_CATEGORIES.API), '-tags', 'api'],
        });
      }
    }

    const findings = [];
    for (const invocation of invocations) {
      const { stdout } = await runBinary(BIN, invocation.args, { timeoutMs: effectiveTimeoutMs, allowedExitCodes: [0] });
      for (const line of stdout.split('\n').filter(Boolean)) {
        const finding = JSON.parse(line);
        findings.push({ ...finding, 'bci-template-source': invocation.source, 'bci-template-categories': invocation.categories });
      }
    }
    const unique = [...new Map(findings.map((finding) => [`${finding['template-id']}|${finding['matched-at'] || finding.url}`, finding])).values()];
    return {
      raw: unique,
      executionMeta: {
        requestedScope: { scanProfile: scope.profile, templateCategories: scope.categories, rateLimit },
        executedScope: { bundledTemplates: true, officialTemplateVersion: scope.templateVersion, templateCategories: scope.categories, excludedTags: this.executionOptions.excludedTags },
        resultCount: unique.length,
      },
    };
  },
};
