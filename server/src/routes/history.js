import express from 'express';
import { and, desc, eq, isNull, or, inArray } from 'drizzle-orm';
import { authMiddleware } from '../middleware/auth.js';
import { getDb, isDbConfigured } from '../db/client.js';
import { getPool } from '../services/database.js';
import { analyses, devices, emergencyLogs, userProfiles } from '../db/schema.js';
import { generateReportDocx } from '../services/docx.js';
import { generateReportPdf } from '../services/pdf.js';
import { getTodayBriefing, getBriefingByDate, listBriefingDates, generateMorningBriefIfNeeded } from '../services/morningBrief.js';
import { classifyData } from '../services/decisionIntelligence.js';
import { canAccessClassification } from '../lib/rbac.js';

const router = express.Router();
const PUBLIC_CLOUD_PROVIDER_LABEL = 'Q CLOUD';

// aiProvider on a row is either a real upstream cloud provider name (set by
// routes/analysis.js's /generate -- always masked to PUBLIC_CLOUD_PROVIDER_LABEL
// before it ever reaches a client, so the actual vendor is never exposed) or
// one of the local-engine's own already-public display labels, written
// as-is by a native device's local Model Manager / offline-extractive path
// (see AnalysisView.jsx's providerLabel and desktop|mobile's createAnalysis)
// and carried through sync unchanged. Only the latter two are ever passed
// through verbatim; anything else falls back to the generic cloud label.
const LOCAL_ENGINE_LABELS = new Set(['Q LOCAL', 'Q LOCAL DATA']);
function engineLabelFor(aiProvider) {
  if (!aiProvider) return null;
  return LOCAL_ENGINE_LABELS.has(aiProvider) ? aiProvider : PUBLIC_CLOUD_PROVIDER_LABEL;
}

// Devices register with the raw platform string their app runtime reports
// (process.platform on desktop, Capacitor.getPlatform() on Android -- see
// routes/devices.js) -- normalized here into the label History actually
// shows next to each report's title.
const PLATFORM_DISPLAY_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS' };
function deviceLabelFor(deviceId, devicePlatform) {
  if (!deviceId || deviceId === 'web') return 'Web';
  return PLATFORM_DISPLAY_LABELS[devicePlatform] || 'Bilinmeyen Cihaz';
}

// The frontend still expects snake_case field names (HistoryView.jsx, HomeView.jsx) —
// Drizzle results (camelCase) are mapped through this to preserve the old API contract.
// `devicePlatform` is only present when the caller joined in the `devices`
// table (see the /list and /:id handlers below); omitted elsewhere.
const toAnalysisJson = (row, devicePlatform) => ({
  id: row.id,
  user_code: row.userCode,
  category: row.category,
  title: row.title,
  content: row.content,
  ai_provider: row.aiProvider ? PUBLIC_CLOUD_PROVIDER_LABEL : null,
  engine_label: engineLabelFor(row.aiProvider),
  device_label: deviceLabelFor(row.deviceId, devicePlatform),
  priority: row.priority,
  depth: row.depth,
  created_at: row.createdAt,
});

router.get('/morning-brief/today', authMiddleware, async (req, res) => {
  try {
    const briefing = await getTodayBriefing();
    if (!briefing) return res.json({ exists: false });
    res.json({
      exists: true,
      date: briefing.briefing_date,
      generatedAt: briefing.generated_at,
      timezone: briefing.timezone,
      sources: briefing.sources_json || [],
      items: briefing.items_json || [],
      summary: briefing.summary_text || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/morning-brief/list', authMiddleware, async (req, res) => {
  try {
    const dates = await listBriefingDates(30);
    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/morning-brief/date/:date', authMiddleware, async (req, res) => {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
      return res.status(400).json({ error: 'Geçersiz tarih formatı' });
    }
    const briefing = await getBriefingByDate(req.params.date);
    if (!briefing) return res.json({ exists: false });
    res.json({
      exists: true,
      date: briefing.briefing_date,
      generatedAt: briefing.generated_at,
      timezone: briefing.timezone,
      sources: briefing.sources_json || [],
      items: briefing.items_json || [],
      summary: briefing.summary_text || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/morning-brief/refresh', authMiddleware, async (req, res) => {
  try {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Yetkisiz' });
    await generateMorningBriefIfNeeded(true);
    const briefing = await getTodayBriefing();
    if (!briefing) return res.json({ success: false, exists: false });
    res.json({
      success: true,
      exists: true,
      date: briefing.briefing_date,
      generatedAt: briefing.generated_at,
      timezone: briefing.timezone,
      sources: briefing.sources_json || [],
      items: briefing.items_json || [],
      summary: briefing.summary_text || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// item 16 (RBAC -> ABAC): before this, visibility was strictly binary --
// isAdmin saw every analysis in the system, anyone else saw only their own,
// with nothing in between. That forced a false choice for ordinary
// case/unit collaboration: either grant a teammate full admin rights just
// so they can see a shared case, or keep every non-admin siloed to their
// own reports even when they're working the same unit's caseload. This
// adds one real attribute-based rule on top of the existing role/
// classification checks: a teammate in the same organizational unit
// (user_profiles.unit) may VIEW another member's analysis, but only up to
// INTERNAL -- CONFIDENTIAL/RESTRICTED stays visible to its owner and
// admins only, same as before. Deleting a teammate's report is
// deliberately NOT extended by this rule (see DELETE /:id below, unchanged).
const UNIT_SHARE_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL'];

async function getUserUnit(userCode) {
  if (!isDbConfigured() || !userCode) return null;
  const [row] = await getDb().select({ unit: userProfiles.unit }).from(userProfiles).where(eq(userProfiles.userCode, userCode));
  return row?.unit || null;
}

function canViewAsUnitMate(row, requesterUnit, ownerUnit) {
  if (!requesterUnit || !ownerUnit || requesterUnit !== ownerUnit) return false;
  const classification = row.dataClassification || classifyData(row.category);
  return UNIT_SHARE_CLASSIFICATIONS.includes(classification);
}

router.get('/list', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.json([]);

    // Left-joined so a row whose device was never registered (or was later
    // revoked) still comes back -- deviceLabelFor() falls back to
    // "Bilinmeyen Cihaz" rather than the row silently vanishing.
    const selection = { analysis: analyses, devicePlatform: devices.platform };
    let scoped;
    if (req.user?.isAdmin) {
      scoped = getDb().select(selection).from(analyses).leftJoin(devices, eq(analyses.deviceId, devices.deviceId)).where(isNull(analyses.deletedAt)).orderBy(desc(analyses.createdAt)).limit(100);
    } else {
      const requesterUnit = await getUserUnit(req.user.userCode);
      const visibility = requesterUnit
        ? or(
            eq(analyses.userCode, req.user.userCode),
            and(eq(userProfiles.unit, requesterUnit), inArray(analyses.dataClassification, UNIT_SHARE_CLASSIFICATIONS))
          )
        : eq(analyses.userCode, req.user.userCode);
      scoped = getDb()
        .select(selection)
        .from(analyses)
        .leftJoin(devices, eq(analyses.deviceId, devices.deviceId))
        .leftJoin(userProfiles, eq(analyses.userCode, userProfiles.userCode))
        .where(and(visibility, isNull(analyses.deletedAt)))
        .orderBy(desc(analyses.createdAt))
        .limit(100);
    }

    const rows = await scoped;

    // A row's own classification can only ever get stricter over time (see
    // classifyData/maxLevel's never-downgrade rule), and a user's own role
    // can be downgraded independently of that -- previously only GET /:id
    // (and the two download routes) checked this; a report that used to be
    // visible could still surface here in the list/preview after either
    // change. Applied uniformly (including the admin branch above) since
    // canAccessClassification(admin, *) is always true, so this is a no-op
    // for admins and the only real gate for everyone else.
    const visibleRows = rows.filter(({ analysis }) => !blockedByClassification(req, analysis));

    res.json(
      visibleRows.map(({ analysis, devicePlatform }) => ({ ...toAnalysisJson(analysis, devicePlatform), preview: (analysis.content || '').slice(0, 200) }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/feed -- recent system activity
router.get('/feed', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.json([]);

    const db = getDb();
    const isAdmin = !!req.user?.isAdmin;
    const [analysisRowsRaw, emergencyRows] = await Promise.all([
      isAdmin
        ? db.select().from(analyses).where(isNull(analyses.deletedAt)).orderBy(desc(analyses.createdAt)).limit(15)
        : db
            .select()
            .from(analyses)
            .where(and(eq(analyses.userCode, req.user.userCode), isNull(analyses.deletedAt)))
            .orderBy(desc(analyses.createdAt))
            .limit(15),
      isAdmin
        ? db.select().from(emergencyLogs).orderBy(desc(emergencyLogs.createdAt)).limit(10)
        : db
            .select()
            .from(emergencyLogs)
            .where(eq(emergencyLogs.userCode, req.user.userCode))
            .orderBy(desc(emergencyLogs.createdAt))
            .limit(10),
    ]);

    // Same rationale as GET /list above -- a row visible when created isn't
    // necessarily still visible to this user now.
    const analysisRows = analysisRowsRaw.filter((r) => !blockedByClassification(req, r));

    const rows = [
      ...analysisRows.map((r) => ({
        type: 'analysis',
        id: r.id,
        user_code: r.userCode,
        category: r.category,
        title: r.title,
        message: null,
        target: null,
        created_at: r.createdAt,
      })),
      ...emergencyRows.map((r) => ({
        type: 'emergency',
        id: r.id,
        user_code: r.userCode,
        category: null,
        title: null,
        message: r.message,
        target: r.target,
        created_at: r.createdAt,
      })),
    ]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 20);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Prefer the classification stored at generation time (row.dataClassification
// -- see routes/analysis.js's /generate, which now persists classifyData()'s
// result instead of only computing it transiently). Only re-derive from
// category for rows written before that column existed (NULL) -- otherwise
// a report explicitly raised above its category floor (e.g. to RESTRICTED)
// would silently read back at the lower floor every time history is viewed,
// which is exactly the downgrade this stored column exists to prevent.
function blockedByClassification(req, row) {
  const classification = row.dataClassification || classifyData(row.category);
  return !canAccessClassification(req.user, classification);
}

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.status(404).json({ error: 'DB yok' });

    const [row] = await getDb()
      .select({ analysis: analyses, devicePlatform: devices.platform })
      .from(analyses)
      .leftJoin(devices, eq(analyses.deviceId, devices.deviceId))
      .where(eq(analyses.id, Number(req.params.id)));
    if (!row || row.analysis.deletedAt) return res.status(404).json({ error: 'Bulunamadi' });
    if (!req.user?.isAdmin && row.analysis.userCode !== req.user.userCode) {
      const requesterUnit = await getUserUnit(req.user.userCode);
      const ownerUnit = await getUserUnit(row.analysis.userCode);
      if (!canViewAsUnitMate(row.analysis, requesterUnit, ownerUnit)) {
        return res.status(404).json({ error: 'Bulunamadi' });
      }
    }
    if (blockedByClassification(req, row.analysis)) {
      return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
    }
    res.json(toAnalysisJson(row.analysis, row.devicePlatform));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/history/:id -- soft-delete (tombstone), symmetric with the
// existing native-only path (desktop/mobile's analyses:remove IPC/bridge
// call -> local deleteAnalysis() -> sync_queue 'delete' op -> this same
// analyses.deleted_at column, just reached over /api/sync/push instead).
// This is the only delete path a plain web session has, since it has no
// local device/sync_queue of its own to route through -- so it must bump
// sync_revision itself here, the same way sync.js's applyOperation's
// 'delete' branch does, or a native device would never learn the row is
// gone on its next pull and it would silently reappear there forever.
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.status(404).json({ error: 'DB yok' });

    const [row] = await getDb().select().from(analyses).where(eq(analyses.id, Number(req.params.id)));
    if (!row || row.deletedAt) return res.status(404).json({ error: 'Bulunamadi' });
    if (!req.user?.isAdmin && row.userCode !== req.user.userCode) {
      return res.status(404).json({ error: 'Bulunamadi' });
    }

    await getPool().query(
      `UPDATE analyses SET deleted_at = NOW(), sync_revision = nextval('analyses_sync_revision_seq') WHERE id = $1`,
      [row.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/download', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.status(404).json({ error: 'DB yok' });

    const [row] = await getDb().select().from(analyses).where(eq(analyses.id, Number(req.params.id)));
    if (!row || row.deletedAt) return res.status(404).json({ error: 'Bulunamadi' });
    if (!req.user?.isAdmin && row.userCode !== req.user.userCode) {
      const requesterUnit = await getUserUnit(req.user.userCode);
      const ownerUnit = await getUserUnit(row.userCode);
      if (!canViewAsUnitMate(row, requesterUnit, ownerUnit)) {
        return res.status(404).json({ error: 'Bulunamadi' });
      }
    }
    if (blockedByClassification(req, row)) {
      return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
    }

    const buf = await generateReportDocx({
      category: row.category,
      title: row.title,
      content: row.content,
      userCode: row.userCode,
      aiProvider: row.aiProvider ? PUBLIC_CLOUD_PROVIDER_LABEL : null
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="BQI_${row.category}_${row.id}.docx"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/download-pdf', authMiddleware, async (req, res) => {
  try {
    if (!isDbConfigured()) return res.status(404).json({ error: 'DB yok' });

    const [row] = await getDb().select().from(analyses).where(eq(analyses.id, Number(req.params.id)));
    if (!row || row.deletedAt) return res.status(404).json({ error: 'Bulunamadi' });
    if (!req.user?.isAdmin && row.userCode !== req.user.userCode) {
      const requesterUnit = await getUserUnit(req.user.userCode);
      const ownerUnit = await getUserUnit(row.userCode);
      if (!canViewAsUnitMate(row, requesterUnit, ownerUnit)) {
        return res.status(404).json({ error: 'Bulunamadi' });
      }
    }
    if (blockedByClassification(req, row)) {
      return res.status(403).json({ error: 'Bu veri sınıfına erişim yetkiniz yok' });
    }

    const buf = await generateReportPdf({
      category: row.category,
      title: row.title,
      content: row.content,
      userCode: row.userCode,
      aiProvider: row.aiProvider ? PUBLIC_CLOUD_PROVIDER_LABEL : null
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="BQI_${row.category}_${row.id}.pdf"`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
