import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { publicActionLimiter } from '../middleware/rateLimit.js';
import https from 'https';
import { parseVoiceIntent } from '../services/ai.js';
import { assertProviderAllowed } from '../services/dataEgressPolicy.js';
import { logger } from '../lib/logger.js';

// /transcribe and /speak talk to OpenAI directly (raw https, not through
// aiGenerate.ts's funnel -- see dataEgressPolicy.js's module comment on why
// every cloud-provider call path must still be gated). Neither endpoint has
// a JSON body to carry a `dataClassification` field (transcribe's body is
// raw audio bytes; speak's is TTS input), so the classification is read
// from a header instead, defaulting to INTERNAL like every other
// unclassified call path in this codebase (see decisionIntelligence.js's
// classifyData default).
function classificationFromHeader(req) {
  return req.headers['x-data-classification'] || 'INTERNAL';
}

const router = express.Router();

function buildMultipart(boundary, fields, fileBuffer, filename, mimeType) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: ' + mimeType + '\r\n\r\n'));
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  return Buffer.concat(parts);
}

function openaiRequest(path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.openai.com', port: 443, path, method: 'POST', headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(body);
    req.end();
  });
}

router.post('/transcribe', authMiddleware, publicActionLimiter, async (req, res) => {
  try {
    assertProviderAllowed(classificationFromHeader(req), 'openai', 'voice.transcribe');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'OpenAI API key tanimli degil' });
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buffer.length) return res.status(400).json({ error: 'Ses verisi bos' });
    const ct = req.headers['content-type'] || 'audio/webm';
    const ext = ct.includes('mp4') ? 'mp4' : ct.includes('wav') ? 'wav' : ct.includes('ogg') ? 'ogg' : 'webm';
    const boundary = 'bqi' + Date.now();
    const multipart = buildMultipart(boundary, { model: 'whisper-1', language: 'tr', response_format: 'json' }, buffer, 'audio.' + ext, ct);
    const result = await openaiRequest('/v1/audio/transcriptions', multipart, {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': multipart.length,
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.body.toString() });
    const data = JSON.parse(result.body.toString());
    return res.json({ text: data.text || '' });
  } catch (err) {
    logger.error({ err }, 'Whisper error');
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

router.post('/speak', authMiddleware, publicActionLimiter, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    assertProviderAllowed(classificationFromHeader(req), 'openai', 'voice.speak');
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.error('[TTS] OPENAI_API_KEY not set — TTS disabled, client will use browser TTS');
      return res.status(503).json({ error: 'OpenAI API key tanimli degil' });
    }
    let body = req.body;
    if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { body = {}; } }
    const { text, voice = 'onyx' } = body;
    if (!text) return res.status(400).json({ error: 'text zorunlu' });
    const payload = Buffer.from(JSON.stringify({ model: 'tts-1', voice, input: text.slice(0, 4000), response_format: 'mp3' }));
    const result = await openaiRequest('/v1/audio/speech', payload, {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    });
    if (result.status !== 200) {
      logger.error({ status: result.status, body: result.body.toString().slice(0, 300) }, '[TTS] OpenAI API error');
      return res.status(result.status).json({ error: result.body.toString() });
    }
    logger.info({ bytes: result.body.length }, '[TTS] Audio generated');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', result.body.length);
    return res.send(result.body);
  } catch (err) {
    logger.error({ err }, '[TTS] Server error');
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

/**
 * POST /api/voice/intent
 * Analyzes the voice command with AI and returns the actions to run.
 * Body: { transcript, context: { page, lang, user }, actions: [...] }
 * Returns: { actions: [{action, params}], speak }
 *
 * NOT CALLED BY THE CLIENT ANY MORE. Voice command interpretation/routing
 * was converted to a fully local, deterministic engine (see
 * client/src/services/voiceAssistantEngine.js and voiceUiCatalog.js) with
 * zero AI/network calls in the interpretation path. This route (and
 * parseVoiceIntent in services/aiGenerate.ts, which nothing else calls) is
 * left in place rather than deleted: nothing else in the codebase was found
 * to depend on it, deleting an Express route/service function carries more
 * blast-radius risk than leaving it dormant, and it costs nothing to keep
 * (it does not run unless explicitly POSTed to, and stays behind the same
 * authMiddleware/rate limiter as every other route here). Safe to remove in
 * a future cleanup once confirmed nothing else has started using it.
 */
router.post('/intent', authMiddleware, publicActionLimiter, express.json({ limit: '512kb' }), async (req, res) => {
  let context = {};
  try {
    // express.raw() applies to voice requests; we parse the JSON body with express.json()
    let body = req.body;
    if (Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString()); } catch { body = {}; }
    }
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const { transcript, actions = [] } = body;
    context = body.context || {};
    if (!transcript?.trim()) return res.status(400).json({ error: 'transcript zorunlu' });

    const langLabel = context.lang === 'tr' ? 'Türkçe' : 'English';
    const langInstr = context.lang === 'tr'
      ? 'Kullanıcı Türkçe konuşuyor. speak alanını Türkçe yaz.'
      : 'User is speaking English. Write the speak field in English.';

    // Real, app-derived enums the model is allowed to pick from -- kept in
    // sync with client/src/services/voiceIntentSchema.js (categories) and
    // routes/analysis.js's VALID_DEPTHS. Grounding the system prompt in the
    // actual option set (instead of letting the model invent one) is what
    // start_analysis's category/depth/quantum params rely on downstream;
    // the client re-validates against the same enums regardless (see
    // voiceIntentSchema.validateActionPlan), so this is guidance, not the
    // only line of defense.
    const CATEGORY_ENUM = ['savunma', 'enerji', 'saldiri', 'ekonomi', 'toplumsal', 'danisma', 'saglik', 'cok-alanli', 'bddk', 'btk'];
    const DEPTH_ENUM = ['hizli', 'standart', 'derin'];

    const systemPrompt = `Sen BQI'nın sesli asistanısın — Bold Quantum Intelligence karar istihbaratı platformu.

Görevin: Kullanıcının sesli komutunu anlayıp sistemi kontrol etmek.

${langInstr}

## GERÇEK SİSTEM SEÇENEKLERİ (yalnızca bunlardan seç)
- Analiz kategorileri (category): ${CATEGORY_ENUM.join(' | ')}
- Analiz derinliği (depth): ${DEPTH_ENUM.join(' | ')} (belirtilmezse standart)
- Kuantum modu (quantum): true | false (belirtilmezse false)
- "actions" alanında yalnızca aşağıdaki "Mevcut aksiyonlar" listesindeki "name" değerlerinden birini kullan. Listede olmayan bir aksiyon adı UYDURMA.

## KURALLAR
1. Kullanıcı NE DERSE DE anlamaya çalış. Kesin kelime eşleştirmesi değil — niyet analizi yap.
2. Bir analiz başlatma isteği (kategori + isteğe bağlı derinlik/kuantum) için "start_analysis" aksiyonunu category/depth/quantum parametreleriyle kullan — category yukarıdaki listeden BİRİ olmalı, kullanıcının söylediği kelimenin çevirisi/eşdeğeri değil.
3. Birden fazla aksiyon gerekiyorsa hepsini mantıksal sırayla dizi içinde döndür.
4. Komut yoksa (sohbet, soru, selam vb.) actions boş bırak, speak ile kısa cevap ver.
5. Parametre değerlerini kullanıcının söylediklerinden çıkart (çeviri yapma, orijinal kullan) — category/depth/quantum hariç, onlar için yukarıdaki sabit değerleri kullan.
6. Emin olmadığında (örn. kategori belirsizse) "actions" alanını BOŞ bırak ve speak ile hangi kategoriyi kastettiğini sor — asla "ui_activate" ile tahmini bir ekran kontrolüne tıklama, özellikle analiz/kuantum/navigasyon gibi kritik isteklerde. ui_activate SADECE hiçbir özel aksiyon uymadığında, kritik olmayan durumlarda kullanılabilir.

## YANIT FORMATI
SADECE geçerli JSON döndür — markdown, açıklama, ek metin YOK:
{"actions":[{"action":"<aksiyon_adı>","params":{}}],"speak":"<${langLabel} yanıt>"}

actions dizisi boş olabilir: {"actions":[],"speak":"..."}`;

    const userMessage = `Aktif sayfa: ${context.page || 'bilinmiyor'}
${context.user ? `Kullanıcı: ${context.user}` : ''}

Mevcut aksiyonlar:
${JSON.stringify(actions)}

Kullanıcı şunu söyledi: "${transcript}"`;

    const parsed = await parseVoiceIntent(systemPrompt, userMessage, context.dataClassification || 'INTERNAL');

    // Defense in depth: even though the client re-validates every action
    // against its own schema before executing anything, never hand back an
    // action name the client didn't advertise as available in this
    // context -- the model occasionally invents a plausible-looking name.
    const allowedNames = new Set(actions.map((a) => a?.name).filter(Boolean));
    const filteredActions = Array.isArray(parsed.actions)
      ? parsed.actions.filter((a) => a && typeof a.action === 'string' && allowedNames.has(a.action))
      : [];
    return res.json({ ...parsed, actions: filteredActions });
  } catch (err) {
    logger.error({ err }, '[VoiceIntent] Error');
    // All providers failed — safe fallback so the client speaks something
    // sensible instead of falling through to the very limited local matcher.
    return res.json({ actions: [], speak: context.lang === 'tr' ? 'Anlayamadım, tekrar söyler misiniz?' : 'Could not understand, please repeat.' });
  }
});

export default router;
