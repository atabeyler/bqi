import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db/client.js';
import { hashContent } from '../reports/integrity.js';
import { buildExecutiveReport, buildTechnicalReport, buildRemediationReport, buildAuditReport, buildFullReport } from '../reports/builders.js';
import { VERIFICATION_MODEL_VERSION } from './verification.js';
import { CONFIDENCE_MODEL_VERSION } from './confidence.js';
import { RISK_MODEL_VERSION } from './risk.js';
import { SECURITY_SCORE_MODEL_VERSION } from './securityScore.js';
import { COVERAGE_SCORE_MODEL_VERSION } from './coverageScore.js';
import { recordAuditEvent } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BCI_VERSION = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;

const MODEL_VERSIONS = {
  verification: VERIFICATION_MODEL_VERSION,
  confidence: CONFIDENCE_MODEL_VERSION,
  risk: RISK_MODEL_VERSION,
  securityScore: SECURITY_SCORE_MODEL_VERSION,
  coverageScore: COVERAGE_SCORE_MODEL_VERSION,
};

const BUILDERS = {
  EXECUTIVE: buildExecutiveReport,
  TECHNICAL: buildTechnicalReport,
  REMEDIATION: buildRemediationReport,
  AUDIT: buildAuditReport,
  FULL: buildFullReport,
};

const SUPPORTED_LANGUAGES = new Set(['en', 'tr', 'fr', 'de', 'ar']);

const REPORT_PRESENTATION = {
  en: {
    EXECUTIVE: ['Executive Report', 'Leadership-level security posture and material risk summary.'],
    TECHNICAL: ['Technical Report', 'Complete findings, evidence sources, and execution provenance.'],
    REMEDIATION: ['Remediation Report', 'Prioritized corrective actions and remediation lifecycle.'],
    AUDIT: ['Audit Report', 'Audit trail and compliance evidence for the selected period.'],
    FULL: ['Full BCI Report', 'Executive, technical, remediation, and audit sections in one artifact.'],
  },
  tr: {
    EXECUTIVE: ['Yönetici Raporu', 'Yönetim düzeyinde güvenlik duruşu ve önemli risk özeti.'],
    TECHNICAL: ['Teknik Rapor', 'Tüm bulgular, kanıt kaynakları ve çalıştırma kökeni.'],
    REMEDIATION: ['Düzeltme Raporu', 'Öncelikli düzeltici işlemler ve düzeltme yaşam döngüsü.'],
    AUDIT: ['Denetim Raporu', 'Seçilen dönem için denetim izi ve uyumluluk kanıtı.'],
    FULL: ['Tam BCI Raporu', 'Yönetici, teknik, düzeltme ve denetim bölümleri tek raporda.'],
  },
  fr: {
    EXECUTIVE: ['Rapport exécutif', 'Synthèse de la posture de sécurité et des risques majeurs pour la direction.'],
    TECHNICAL: ['Rapport technique', 'Résultats complets, sources de preuve et provenance d’exécution.'],
    REMEDIATION: ['Rapport de remédiation', 'Actions correctives prioritaires et cycle de remédiation.'],
    AUDIT: ['Rapport d’audit', 'Piste d’audit et preuves de conformité pour la période choisie.'],
    FULL: ['Rapport BCI complet', 'Sections exécutive, technique, remédiation et audit dans un même rapport.'],
  },
  de: {
    EXECUTIVE: ['Managementbericht', 'Sicherheitslage und wesentliche Risiken für die Leitungsebene.'],
    TECHNICAL: ['Technischer Bericht', 'Vollständige Befunde, Evidenzquellen und Ausführungsherkunft.'],
    REMEDIATION: ['Behebungsbericht', 'Priorisierte Korrekturmaßnahmen und Behebungslebenszyklus.'],
    AUDIT: ['Auditbericht', 'Auditprotokoll und Compliance-Nachweise für den gewählten Zeitraum.'],
    FULL: ['Vollständiger BCI-Bericht', 'Management-, Technik-, Behebungs- und Auditabschnitte in einem Bericht.'],
  },
  ar: {
    EXECUTIVE: ['التقرير التنفيذي', 'ملخص للإدارة عن الوضع الأمني والمخاطر الجوهرية.'],
    TECHNICAL: ['التقرير التقني', 'جميع النتائج ومصادر الأدلة ومصدر التنفيذ.'],
    REMEDIATION: ['تقرير المعالجة', 'إجراءات التصحيح ذات الأولوية ودورة حياة المعالجة.'],
    AUDIT: ['تقرير التدقيق', 'سجل التدقيق وأدلة الامتثال للفترة المحددة.'],
    FULL: ['تقرير BCI الكامل', 'الأقسام التنفيذي والتقني والمعالجة والتدقيق في تقرير واحد.'],
  },
};

export function addLocalizedPresentation(reportType, content, language) {
  const lang = SUPPORTED_LANGUAGES.has(language) ? language : 'en';
  const [title, description] = REPORT_PRESENTATION[lang][reportType];
  return { language: lang, presentation: { title, description }, ...content };
}

// Resolves options.assetId (if given) to that asset's real identifier
// values -- the same target strings risk.js/coverageScore.js already match
// findings against -- so a report can be scoped to one asset without any
// builder needing to know about assets at all, only target strings. Joins
// through assets.org_id (never trusting assetId alone) so a caller can
// never scope a report to another org's asset and have its identifiers
// leak into the generated content.
async function resolveTargetsForAsset(orgId, assetId) {
  if (!assetId) return null;
  const { rows } = await query(
    `SELECT ai.value FROM asset_identifiers ai JOIN assets a ON a.id = ai.asset_id
      WHERE ai.asset_id = $1 AND a.org_id = $2`,
    [assetId, orgId]
  );
  return rows.map((r) => r.value);
}

// Wraps a report builder's output with the integrity metadata spec section
// 46 requires: unique id, generation timestamp, BCI version, and the
// versions of every scoring model that could have shaped the content --
// so a report generated today stays reproducible/explainable even after
// those models have since moved to a new version.
export async function generateReport(orgId, actorUserId, reportType, options = {}) {
  const builder = BUILDERS[reportType];
  if (!builder) throw new Error(`Unknown report type: ${reportType}`);

  const targets = await resolveTargetsForAsset(orgId, options.assetId);
  if (options.scanJobId) {
    const { rows: scans } = await query(
      `SELECT id, target FROM scan_jobs WHERE id = $1 AND org_id = $2 AND controlled_proof_run_id IS NULL`,
      [options.scanJobId, orgId]
    );
    if (!scans[0]) throw new Error('scan_job_not_found');
    if (targets && !targets.includes(scans[0].target)) throw new Error('scan_job_asset_mismatch');
  }
  const language = SUPPORTED_LANGUAGES.has(options.language) ? options.language : 'en';
  const builtContent = await builder(orgId, { ...options, targets });
  const content = addLocalizedPresentation(reportType, builtContent, language);
  const contentHash = hashContent(content);

  const { rows } = await query(
    `INSERT INTO reports (org_id, report_type, generated_by, content, content_hash, bci_version, model_versions, asset_id, scan_job_id, language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, report_type, content_hash, bci_version, model_versions, asset_id, scan_job_id, language, created_at`,
    [orgId, reportType, actorUserId, JSON.stringify(content), contentHash, BCI_VERSION, JSON.stringify(MODEL_VERSIONS), options.assetId ?? null, options.scanJobId ?? null, language]
  );

  await recordAuditEvent({
    orgId, actorUserId, action: 'report.generate', targetType: 'report', targetId: rows[0].id, result: 'SUCCESS', metadata: { reportType, assetId: options.assetId ?? null, scanJobId: options.scanJobId ?? null },
  });

  return { ...rows[0], content };
}

export async function getReport(orgId, reportId) {
  const { rows } = await query('SELECT * FROM reports WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [reportId, orgId]);
  const report = rows[0];
  if (!report) return null;

  // Verify on read, not just trust the stored hash -- if content and hash
  // ever diverge (a bug, or someone editing the row directly), that's
  // visible to the caller instead of silently served as if it matched.
  const recomputed = hashContent(report.content);
  return { ...report, integrityValid: recomputed === report.content_hash };
}

export async function listReports(orgId, { assetId } = {}) {
  const { rows } = await query(
    `SELECT id, report_type, generated_by, content_hash, bci_version, asset_id, scan_job_id, language, created_at
       FROM reports WHERE org_id = $1 AND archived_at IS NULL AND deleted_at IS NULL AND ($2::uuid IS NULL OR asset_id = $2)
      ORDER BY created_at DESC`,
    [orgId, assetId ?? null]
  );
  return rows;
}

export async function archiveReport({ orgId, actorUserId, reportId }) {
  const { rows } = await query(
    `UPDATE reports SET archived_at = now()
      WHERE id = $1 AND org_id = $2 AND archived_at IS NULL AND deleted_at IS NULL
      RETURNING id, report_type, archived_at`,
    [reportId, orgId]
  );
  if (!rows[0]) return null;
  await recordAuditEvent({
    orgId, actorUserId, action: 'report.archive', targetType: 'report', targetId: reportId,
    result: 'SUCCESS', metadata: { reportType: rows[0].report_type },
  });
  return rows[0];
}

export async function deleteReport({ orgId, actorUserId, reportId }) {
  const { rows } = await query(
    `UPDATE reports
        SET deleted_at = now(), archived_at = NULL, content = '{}'::jsonb,
            content_hash = '[deleted]', model_versions = '{}'::jsonb
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
      RETURNING id, report_type, deleted_at`,
    [reportId, orgId]
  );
  if (!rows[0]) return null;
  await recordAuditEvent({
    orgId, actorUserId, action: 'report.delete', targetType: 'report', targetId: reportId,
    result: 'SUCCESS', metadata: { reportType: rows[0].report_type, detailsRetained: false },
  });
  return rows[0];
}
