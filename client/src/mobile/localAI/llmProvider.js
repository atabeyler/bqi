import { retrieveContext, buildPrompt, SYSTEM_PROMPT } from './rag.js';
import { createLlamaRuntime } from './llmRuntime.js';
import { cleanReportOutput, getReportFormat, isPromptEcho } from './reportFormats.js';

const CHAT_INSTRUCTION =
  'Kullanıcının sorusuna, aşağıdaki bağlamı kullanarak Türkçe ve öz bir şekilde cevap ver. ' +
  'Bağlamda yeterli bilgi yoksa bunu açıkça belirt, bilgi uydurma.';

// Owner explicitly opted into a much larger budget for this instruction
// (HIGH tier upgraded to 7B, generation deadline raised to 240s in
// llama-android.cpp, targeting "a very powerful device") -- this replaces
// the earlier, deliberately tiny "3-4 sentences" version that was sized
// for a 1.5B model with a 90s ceiling. A structured, headed skeleton (not
// category-specific -- one generic shape shared by every analysis
// category, savunma/ekonomi/bddk/... alike, rather than 9 separately
// tuned prompts nobody can field-test individually) mirrors the shape of
// the cloud's report output (server/src/services/aiPrompts.ts's own
// "## basliklar" convention) without that prompt's full institutional
// knowledge base, which is many times larger than this model's entire
// 2048-token context window.
const GENERATE_INSTRUCTION =
  'Kullanıcı için istenen konuda, kategoriye özel rapor iskeletini aynen izleyerek yapılandırılmış bir analiz raporu yaz. Cevaba talimat, iskelet, soru/istek veya bağlam etiketlerini kopyalama. ' +
  'İskelette olmayan, konu dışı bölüm açma. Her başlık altında en az 2 dolu cümle yaz; yarım bırakma, tek kelimeyle cevap verme. ' +
  'Eski raporlardan veya örneklerden kişi, kurum, olay, banka, proje, silah sistemi veya ülke adını yeni rapora taşıma. ' +
  'Özellikle kullanıcı konusu toplumsal olay ise OPTİMİZASYON PROBLEMİ, QAOA, banka, bütçe, füze, savunma platformu veya kaynak tahsisi bölümü yazma. ' +
  'Kesin veri yoksa varsayım olduğunu belirt. ' +
  // A small on-device model's failure mode observed firsthand: instead of
  // writing new prose, it echoed the context block's own "[1] "Başlık"
  // (kategori, tarih)" labels back verbatim as fragmented, ungrammatical
  // output. Explicit against that -- the model otherwise defaults to the
  // easiest continuation, which is copying nearby text.
  'Bağlamdaki başlık, kategori veya tarih etiketlerini olduğu gibi kopyalama; kendi cümlelerinle, tam ve anlamlı şekilde yaz.';

// Resource-safety context cap (task spec point 8). Phone-class contextSize
// is 1536-2048 tokens (modelSpec.js); roughly budgeting ~4 chars/token for
// Turkish/English mixed text, this leaves headroom for the instruction +
// RAG context block + the requested maxTokens output after the user's own
// text is truncated to this length. Truncating here (not just trusting the
// UI to keep input short) means a pasted wall of text can't blow the
// context window and force llama.cpp to either error or silently drop
// context on the native side.
const MAX_INPUT_CHARS = 2000;

function capInput(text) {
  return String(text || '').slice(0, MAX_INPUT_CHARS);
}

// Mirrors desktop/localAI/llmProvider.js -- same request/response shapes,
// same runtimeFactory injection seam, only the underlying runtime differs
// (llmRuntime.js here calls a native Capacitor plugin instead of
// node-llama-cpp).
export function createLLMQuery({ db, userId, modelManager, isInstalled, runtimeFactory = createLlamaRuntime } = {}) {
  let runtimePromise = null;

  function getRuntime() {
    if (!runtimePromise) {
      // A resolvable-on-disk relative path (modelManager's own
      // MODELS_SUBDIR/filename), not just the bare filename -- see
      // modelManager.js's relativePath comment for why. The native plugin
      // resolves this against the app's private storage root itself.
      runtimePromise = runtimeFactory({ modelPath: modelManager.relativePath, contextSize: modelManager.spec.contextSize, systemPrompt: SYSTEM_PROMPT });
    }
    return runtimePromise;
  }

  async function run(request = {}) {
    const {
      mode = 'chat',
      text: rawText = '',
      entityIds = [],
      category = '',
      title = '',
      prompt: rawPrompt = '',
      attachmentContext = '',
      priority = 'normal',
      depth = 'standart',
      quantumRequested = false,
      lang = 'tr',
    } = request;
    const text = capInput(rawText);
    const prompt = capInput(rawPrompt);
    const boundedAttachment = String(attachmentContext || '').slice(0, 4000);

    if (!modelManager.isAvailableSync(isInstalled)) {
      throw new Error('local_llm_unavailable');
    }

    const runtime = await getRuntime();

    if (mode === 'generate') {
      // Do not inject prior reports into fresh generation by default: a
      // malformed same-category local draft can otherwise poison the next
      // report. Archive retrieval remains available for chat mode below.
      const contextDocs = [];
      const reportFormat = getReportFormat(category);
      const options = `Öncelik: ${priority}\nAnaliz derinliği: ${depth}` +
        (quantumRequested ? '\nKuantum modu istendi; çevrimdışı kuantum doğrulaması yapılamadığı için yalnızca veriye dayalı klasik analiz üret.' : '');
      const userText = boundedAttachment
        ? `${reportFormat}\n\nKullanıcının verdiği konu:\n${prompt || title}\n\n${options}\n\nAnalizde kullanılacak yerel dosya/veri içeriği:\n${boundedAttachment}`
        : `${reportFormat}\n\nKullanıcının verdiği konu:\n${prompt || title}\n\n${options}`;
      const fullPrompt = buildPrompt({ instruction: GENERATE_INSTRUCTION, contextDocs, userText, lang });
      // Raised from 220 alongside GENERATE_INSTRUCTION's 3-section format
      // and llama-android.cpp's 240s deadline -- a 3-heading report needs
      // real room. Still well short of contextSize (2048): MAX_INPUT_CHARS
      // (2000 chars, ~500 tokens) + the RAG context block + this
      // instruction leaves comfortable headroom for a 700-token reply.
      const rawContent = await runtime.generate(fullPrompt, { maxTokens: 700, temperature: 0.4 });
      const content = cleanReportOutput(rawContent, category);
      // A weak/low-tier model can under-follow instructions badly enough to
      // echo the prompt itself back as its "report" (see reportFormats.js's
      // isPromptEcho) instead of failing outright. The 'local_llm_' prefix
      // matches provider.js's isRecoverableLocalLLMError, routing this
      // through the existing fallback to offline-extractive instead of
      // handing back the prompt as a "report".
      if (isPromptEcho(content)) {
        throw new Error('local_llm_prompt_echo');
      }
      return {
        type: 'analysis',
        result: {
          title: title || `${category} analizi`,
          content,
          sources: contextDocs.map((d) => ({ id: d.id, title: d.title })),
          quantumRequested,
          quantumVerified: false,
        },
      };
    }

    const queryText = text || (entityIds.length ? `Rapor ${entityIds.join(', ')} hakkında` : '');
    const contextDocs = await retrieveContext(db, userId, queryText);
    const chatText = boundedAttachment ? `${text}\n\nKullanıcının eklediği yerel dosya içeriği:\n${boundedAttachment}` : text;
    const fullPrompt = buildPrompt({ instruction: CHAT_INSTRUCTION, contextDocs, userText: chatText, lang });
    const answer = await runtime.generate(fullPrompt, { maxTokens: 350, temperature: 0.3 });
    return { type: 'generated', text: answer, sources: contextDocs.map((d) => ({ id: d.id, title: d.title })) };
  }

  run.dispose = async () => {
    if (!runtimePromise) return;
    const runtime = await runtimePromise;
    runtimePromise = null;
    await runtime.dispose?.();
  };

  return run;
}
