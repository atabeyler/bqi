import { query } from '../db/client.js';
import { fetchKevFeed } from '../intelligence/sources/kev.js';
import { fetchEpssForCves } from '../intelligence/sources/epss.js';
import { fetchNvdCve } from '../intelligence/sources/nvd.js';
import { logger } from '../logger.js';

const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function recordUpdate(source, status, itemCount, detail) {
  await query(
    'INSERT INTO intelligence_updates (source, status, item_count, detail) VALUES ($1, $2, $3, $4)',
    [source, status, itemCount ?? null, detail ?? null]
  );
}

// Upsert-merge, never destructive: a field this call doesn't know about
// (e.g. EPSS syncing a row NVD already populated) is preserved via
// COALESCE(new, existing) rather than overwritten with NULL.
export async function upsertVulnerability(record) {
  await query(
    `INSERT INTO vulnerabilities (
       cve_id, description, cwe_ids, cvss_vector, cvss_score, published_at, modified_at,
       kev, kev_date_added, kev_due_date, epss_score, epss_percentile, epss_updated_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (cve_id) DO UPDATE SET
       description     = COALESCE(EXCLUDED.description, vulnerabilities.description),
       cwe_ids         = CASE WHEN array_length(EXCLUDED.cwe_ids, 1) > 0 THEN EXCLUDED.cwe_ids ELSE vulnerabilities.cwe_ids END,
       cvss_vector     = COALESCE(EXCLUDED.cvss_vector, vulnerabilities.cvss_vector),
       cvss_score      = COALESCE(EXCLUDED.cvss_score, vulnerabilities.cvss_score),
       published_at    = COALESCE(EXCLUDED.published_at, vulnerabilities.published_at),
       modified_at     = COALESCE(EXCLUDED.modified_at, vulnerabilities.modified_at),
       kev             = vulnerabilities.kev OR EXCLUDED.kev,
       kev_date_added  = COALESCE(EXCLUDED.kev_date_added, vulnerabilities.kev_date_added),
       kev_due_date    = COALESCE(EXCLUDED.kev_due_date, vulnerabilities.kev_due_date),
       epss_score      = COALESCE(EXCLUDED.epss_score, vulnerabilities.epss_score),
       epss_percentile = COALESCE(EXCLUDED.epss_percentile, vulnerabilities.epss_percentile),
       epss_updated_at = COALESCE(EXCLUDED.epss_updated_at, vulnerabilities.epss_updated_at),
       updated_at      = now()`,
    [
      record.cveId,
      record.description ?? null,
      record.cweIds ?? [],
      record.cvssVector ?? null,
      record.cvssScore ?? null,
      record.publishedAt ?? null,
      record.modifiedAt ?? null,
      record.kev ?? false,
      record.kevDateAdded ?? null,
      record.kevDueDate ?? null,
      record.epssScore ?? null,
      record.epssPercentile ?? null,
      record.epssUpdatedAt ?? null,
    ]
  );
}

// Full bulk sync -- safe to do for KEV specifically because CISA's whole
// catalog is one JSON document (~a few thousand entries), unlike NVD's full
// CVE corpus which would need a proper paginated/incremental sync this
// milestone deliberately doesn't build (spec section 33: match against
// SBOM/asset inventory on demand, don't try to mirror the entire internet's
// vulnerability history up front).
export async function syncKev() {
  try {
    const entries = await fetchKevFeed();
    for (const entry of entries) {
      await upsertVulnerability({
        cveId: entry.cveId,
        kev: true,
        kevDateAdded: entry.dateAdded,
        kevDueDate: entry.dueDate,
        cweIds: entry.cweIds,
      });
    }
    await recordUpdate('kev', 'SUCCESS', entries.length);
    return { status: 'SUCCESS', itemCount: entries.length };
  } catch (err) {
    logger.error({ err }, 'CISA KEV sync failed');
    await recordUpdate('kev', 'FAILED', null, String(err.message || err));
    return { status: 'FAILED', detail: String(err.message || err) };
  }
}

function isStale(row) {
  if (!row) return true;
  return Date.now() - new Date(row.updated_at).getTime() > STALE_AFTER_MS;
}

// Lazy, on-demand enrichment: looks up the local knowledge base first, and
// only reaches out to NVD/EPSS live when the row is missing or stale --
// never a bulk crawl. If the live calls fail, whatever's cached is
// returned rather than erroring the caller (spec section 62: work from the
// last-known-good snapshot, degraded rather than broken).
export async function getOrEnrichVulnerability(cveId) {
  const { rows } = await query('SELECT * FROM vulnerabilities WHERE cve_id = $1', [cveId]);
  const cached = rows[0];

  if (!isStale(cached)) return cached;

  try {
    const nvd = await fetchNvdCve(cveId);
    if (nvd) await upsertVulnerability(nvd);
    await recordUpdate('nvd', 'SUCCESS', 1);
  } catch (err) {
    logger.warn({ err, cveId }, 'NVD enrichment failed, falling back to cached data');
    await recordUpdate('nvd', 'FAILED', null, String(err.message || err));
  }

  try {
    const [epss] = await fetchEpssForCves([cveId]);
    if (epss) await upsertVulnerability(epss);
    await recordUpdate('epss', 'SUCCESS', 1);
  } catch (err) {
    logger.warn({ err, cveId }, 'EPSS enrichment failed, falling back to cached data');
    await recordUpdate('epss', 'FAILED', null, String(err.message || err));
  }

  const { rows: refreshed } = await query('SELECT * FROM vulnerabilities WHERE cve_id = $1', [cveId]);
  return refreshed[0] || cached || null;
}

export async function getFreshness() {
  const { rows } = await query(
    `SELECT DISTINCT ON (source) source, status, item_count, fetched_at
       FROM intelligence_updates
      ORDER BY source, fetched_at DESC`
  );
  return rows;
}
