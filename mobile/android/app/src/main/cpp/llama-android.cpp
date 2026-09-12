// JNI bridge between LlamaBridge.kt and llama.cpp's public C API
// (llama.h). Adapted from the structure of llama.cpp's own maintained
// Android sample (examples/llama.android's llama-android.cpp, MIT
// licensed) -- same call sequence (load model -> create context -> apply
// chat template -> tokenize -> decode in batches -> sample loop ->
// detokenize), condensed into one blocking generate() call instead of that
// sample's Kotlin-Flow token-streaming design, since llmRuntime.js's
// plugin.generate() contract (client/src/mobile/localAI/llmRuntime.js)
// returns one final string, not a stream.
//
// Function names/signatures below match llama.cpp's public API as of the
// commit generation this was written against (mid-2025-era llama.cpp; see
// CMakeLists.txt's submodule pinning note). llama.cpp's C API has changed
// function names before
// (e.g. llama_load_model_from_file -> llama_model_load_from_file,
// llama_new_context_with_model -> llama_init_from_model) -- if the pinned
// commit is older or newer than what this was written against, expect to
// need small renames here, not a rewrite; the call *sequence* below is
// stable and has been for a long time.

#include <android/log.h>
#include <jni.h>
#include <chrono>
#include <string>
#include <vector>

#include "llama.h"

#define LOG_TAG "BQILlama"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// One (model, context) pair per loaded handle. A raw pointer cast to a
// jlong is the "opaque handle" LlamaBridge.kt's Kotlin side holds --
// mirrors llama.cpp's own Android sample's approach (it does the same
// pointer<->Long cast for its Llm class' internal state).
struct LlamaSession {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    const llama_vocab *vocab = nullptr;
    int32_t contextSize = 0;
};

bool g_backendInitialized = false;

void ensureBackendInitialized() {
    if (!g_backendInitialized) {
        llama_backend_init();
        g_backendInitialized = true;
    }
}

} // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_boldas_bqi_localllm_LlamaBridge_nativeLoad(
        JNIEnv *env, jobject /* thiz */,
        jstring jModelPath, jint jContextSize, jint jThreadCount) {
    ensureBackendInitialized();

    const char *modelPathChars = env->GetStringUTFChars(jModelPath, nullptr);
    std::string modelPath(modelPathChars);
    env->ReleaseStringUTFChars(jModelPath, modelPathChars);

    llama_model_params modelParams = llama_model_default_params();
    // CPU-only on purpose: no GPU/NNAPI backend is assumed present or
    // reliable across the wide range of Android GPUs/drivers this app
    // targets -- ggml's CPU backend (NEON on arm64) is the only path
    // validated by llama.cpp's own Android sample. n_gpu_layers stays 0.
    modelParams.n_gpu_layers = 0;

    llama_model *model = llama_model_load_from_file(modelPath.c_str(), modelParams);
    if (model == nullptr) {
        LOGE("llama_model_load_from_file failed for %s", modelPath.c_str());
        // Thrown (not just a 0 return) so LocalLLMPlugin.kt's surrounding
        // try/catch(Throwable) folds this specific reason into its
        // "local_llm_native_load_failed: <message>" rejection instead of
        // the previous bare "local_llm_native_load_failed" -- collapsing
        // "model file rejected by llama.cpp" and "context alloc failed"
        // (below) into one indistinguishable outcome was the last blocker
        // to diagnosing a real on-device load failure any further than
        // "it failed somewhere in native code".
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "llama_model_load_from_file returned null (bad/unsupported GGUF, or out of memory)");
        return 0;
    }

    llama_context_params ctxParams = llama_context_default_params();
    ctxParams.n_ctx = static_cast<uint32_t>(jContextSize);
    ctxParams.n_batch = static_cast<uint32_t>(jContextSize);
    ctxParams.n_threads = jThreadCount;
    ctxParams.n_threads_batch = jThreadCount;

    llama_context *ctx = llama_init_from_model(model, ctxParams);
    if (ctx == nullptr) {
        LOGE("llama_init_from_model failed");
        llama_model_free(model);
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "llama_init_from_model returned null (KV-cache/context allocation failed, likely out of memory)");
        return 0;
    }

    auto *session = new LlamaSession();
    session->model = model;
    session->ctx = ctx;
    session->vocab = llama_model_get_vocab(model);
    session->contextSize = jContextSize;

    LOGI("Model loaded: %s (contextSize=%d)", modelPath.c_str(), jContextSize);
    return reinterpret_cast<jlong>(session);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_boldas_bqi_localllm_LlamaBridge_nativeGenerate(
        JNIEnv *env, jobject /* thiz */,
        jlong jHandle, jstring jSystemPrompt, jstring jPrompt,
        jint jMaxTokens, jfloat jTemperature) {
    auto *session = reinterpret_cast<LlamaSession *>(jHandle);
    if (session == nullptr || session->ctx == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "session not loaded");
        return nullptr;
    }

    const char *systemPromptChars = env->GetStringUTFChars(jSystemPrompt, nullptr);
    const char *userPromptChars = env->GetStringUTFChars(jPrompt, nullptr);
    std::string systemPrompt(systemPromptChars);
    std::string userPrompt(userPromptChars);
    env->ReleaseStringUTFChars(jSystemPrompt, systemPromptChars);
    env->ReleaseStringUTFChars(jPrompt, userPromptChars);

    // --- 1. Apply the model's own chat template (system + user turn) ---
    // A chat-tuned model (Qwen2.5-Instruct) expects its own special
    // tokens/role markers, not a raw text blob -- see LlamaBridge.kt's
    // comment on why this was verified to matter on desktop's
    // node-llama-cpp runtime. At this pinned llama.cpp commit,
    // llama_chat_apply_template() no longer takes a model pointer (it just
    // defaults an unset/unknown tmpl to "chatml" -- see src/llama.cpp) so
    // the model's own template must be fetched explicitly first via
    // llama_model_chat_template() (reads the GGUF's tokenizer.chat_template
    // metadata) and passed in; nullptr from that call (no template in the
    // GGUF) still falls through to llama_chat_apply_template's own "chatml"
    // default, which happens to be correct for Qwen2.5-Instruct anyway.
    const char *modelTmpl = llama_model_chat_template(session->model, /* name */ nullptr);
    llama_chat_message chatMessages[2];
    chatMessages[0] = {"system", systemPrompt.c_str()};
    chatMessages[1] = {"user", userPrompt.c_str()};

    std::vector<char> formattedBuf(userPrompt.size() + systemPrompt.size() + 1024);
    int32_t formattedLen = llama_chat_apply_template(
            modelTmpl, chatMessages, 2, /* add_ass */ true,
            formattedBuf.data(), static_cast<int32_t>(formattedBuf.size()));
    if (formattedLen > static_cast<int32_t>(formattedBuf.size())) {
        // Buffer was too small -- grow and retry once, as llama.cpp's own
        // examples do (the first call also reports the required size).
        formattedBuf.resize(formattedLen);
        formattedLen = llama_chat_apply_template(
                modelTmpl, chatMessages, 2, true,
                formattedBuf.data(), static_cast<int32_t>(formattedBuf.size()));
    }
    std::string formattedPrompt = (formattedLen > 0)
            ? std::string(formattedBuf.data(), formattedLen)
            // Fails safe to a plain concatenation if the GGUF has no chat
            // template metadata at all, rather than failing the whole call.
            : (systemPrompt + "\n" + userPrompt);

    // --- 2. Tokenize ---
    const int32_t maxPromptTokens = session->contextSize; // generous upper bound for sizing
    std::vector<llama_token> promptTokens(maxPromptTokens);
    int32_t nPromptTokens = llama_tokenize(
            session->vocab, formattedPrompt.c_str(), static_cast<int32_t>(formattedPrompt.size()),
            promptTokens.data(), maxPromptTokens, /* add_special */ true, /* parse_special */ true);
    if (nPromptTokens < 0) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "tokenize failed (prompt too long for context)");
        return nullptr;
    }
    promptTokens.resize(nPromptTokens);

    // Leave room for generation within the fixed context window -- a
    // resource-safety guard mirrored from the JS-side MAX_INPUT_CHARS cap
    // in llmProvider.js, enforced again here since this native call is the
    // actual hard boundary (task spec point 8).
    int32_t maxNewTokens = jMaxTokens;
    if (nPromptTokens + maxNewTokens > session->contextSize) {
        maxNewTokens = session->contextSize - nPromptTokens;
    }
    if (maxNewTokens <= 0) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "prompt too long for the configured context size");
        return nullptr;
    }

    // --- 3. Decode the prompt in one batch ---
    llama_batch batch = llama_batch_get_one(promptTokens.data(), nPromptTokens);
    if (llama_decode(session->ctx, batch) != 0) {
        env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "llama_decode failed on prompt");
        return nullptr;
    }

    // --- 4. Sampler chain (greedy-ish temperature sampling) ---
    llama_sampler_chain_params samplerParams = llama_sampler_chain_default_params();
    llama_sampler *sampler = llama_sampler_chain_init(samplerParams);
    llama_sampler_chain_add(sampler, llama_sampler_init_top_k(40));
    llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9f, 1));
    // Repetition penalty -- observed firsthand on a real device: without
    // this, the small MID-tier model repeated an entire phrase back to back
    // ("Sıper/GÖKDENİZ Katmanlı Savunma" twice in a row) in real output.
    // Added after top_k/top_p per llama_sampler_init_penalties' own doc
    // comment (applying it against the full vocabulary first is slow --
    // narrow the candidate set with top_k/top_p first). penalty_last_n=64
    // covers recent repetition without being expensive to scan on a slow
    // CPU; penalty_repeat=1.15 is llama.cpp's own commonly-used default.
    llama_sampler_chain_add(sampler, llama_sampler_init_penalties(
            llama_vocab_n_tokens(session->vocab), /* penalty_last_n */ 64,
            /* penalty_repeat */ 1.15f, /* penalty_freq */ 0.0f, /* penalty_present */ 0.0f));
    // DRY (Don't Repeat Yourself) -- a different failure mode than the
    // single-phrase repeat penalties above already caught: a weak/small
    // model settling into a "broken-record" loop, repeating an entire
    // *sentence* verbatim for the rest of its output (observed firsthand on
    // desktop's node-llama-cpp path with the same underlying llama.cpp
    // engine -- see desktop/localAI/llmRuntime.js's dryRepeatPenalty
    // comment for that incident; Android's own classic penalty above
    // narrows single-token repeats but doesn't make a longer verbatim
    // sequence repeat impossible the way DRY does). Same 0.8
    // multiplier/strength node-llama-cpp documents as its recommended
    // value, same 64-token window as the penalty above (bounded for a
    // slow CPU, not the whole context). Default sequence breakers so
    // repeating a list marker or line break is never penalized.
    {
        static const char *drySeqBreakers[] = {"\n", ":", "\"", "*"};
        llama_sampler_chain_add(sampler, llama_sampler_init_dry(
                session->vocab, /* dry_multiplier */ 0.8f, /* dry_base */ 1.75f,
                /* dry_allowed_length */ 2, /* dry_penalty_last_n */ 64,
                drySeqBreakers, /* num_breakers */ 4));
    }
    llama_sampler_chain_add(sampler, llama_sampler_init_temp(jTemperature > 0.0f ? jTemperature : 0.1f));
    llama_sampler_chain_add(sampler, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));

    // --- 5. Generation loop ---
    std::string output;
    output.reserve(maxNewTokens * 4);
    int32_t nCur = nPromptTokens;
    char pieceBuf[256];

    // Wall-clock generation budget -- observed firsthand on a real device
    // (12GB RAM, MID/1.5B tier): a slow/thermal-throttled CPU generating at
    // well under 1 token/sec ran the full maxNewTokens=600 budget for
    // ~10 minutes of sustained max-thread native compute, after which the
    // whole app process was killed by the OS (thermal/OOM watchdog) with no
    // JS-visible error at all -- LocalLLMPlugin.kt's try/catch can't save a
    // process that's already gone. maxNewTokens alone is not a safety bound
    // on a slow/throttling device; wall-clock time is.
    //
    // Raised from 90s to 240s at the owner's explicit request, targeting a
    // "very powerful" device that should comfortably finish well inside
    // this window -- 240s is still a real ceiling, not removed entirely:
    // this is a blocking JNI call the JS side awaits with no timeout of its
    // own (llmProvider.js), so if this genuinely never returned, the
    // "Yeni Analiz" request would hang forever with zero feedback rather
    // than degrading into the offline-extractive fallback the way every
    // other local-llm failure mode already does. 240s is comfortably past
    // the ~90s a HIGH/3B-tier device should need, while still nowhere near
    // the ~10 minutes that reproduced the original OS-kill crash.
    constexpr auto kGenerationDeadline = std::chrono::seconds(240);
    const auto startTime = std::chrono::steady_clock::now();

    // Nothing below enforced a *minimum* length -- the model is free to
    // sample its own end-of-turn token on the very first step, and the loop
    // just accepted that as "normal completion". Observed firsthand on a
    // real device: a few-word non-answer ("Özcevap: Sınır hareketi,
    // 08.08.2026") saved as the entire report. llama_sampler_sample() reads
    // logits fresh via llama_get_logits_ith() on every call (see
    // llama-sampler.cpp's llama_sampler_sample) -- forcing eos/eot's own
    // logit to -inf for the first kMinNewTokens steps makes early
    // termination *impossible* during that window, rather than just
    // unlikely, without needing a separate resample-and-retry path.
    // Raised from 48 alongside the loosened deadline/token budget above --
    // GENERATE_INSTRUCTION now asks for a couple of headed sections, which
    // needs more guaranteed runway than a bare few-sentence answer did.
    constexpr int32_t kMinNewTokens = 96;
    const llama_token eosToken = llama_vocab_eos(session->vocab);
    const llama_token eotToken = llama_vocab_eot(session->vocab);
    const int32_t nVocab = llama_vocab_n_tokens(session->vocab);

    for (int32_t i = 0; i < maxNewTokens; i++) {
        if (std::chrono::steady_clock::now() - startTime > kGenerationDeadline) {
            LOGE("generation deadline exceeded at token %d, returning partial output", i);
            break;
        }

        if (i < kMinNewTokens) {
            float *logits = llama_get_logits_ith(session->ctx, -1);
            if (logits != nullptr) {
                if (eosToken >= 0 && eosToken < nVocab) logits[eosToken] = -INFINITY;
                if (eotToken >= 0 && eotToken < nVocab) logits[eotToken] = -INFINITY;
            }
        }

        llama_token newToken = llama_sampler_sample(sampler, session->ctx, -1);
        if (llama_vocab_is_eog(session->vocab, newToken)) {
            break; // model signaled end-of-turn -- normal completion, not an error
        }
        llama_sampler_accept(sampler, newToken);

        int32_t pieceLen = llama_token_to_piece(session->vocab, newToken, pieceBuf, sizeof(pieceBuf), 0, true);
        if (pieceLen > 0) {
            output.append(pieceBuf, pieceLen);
        }

        llama_token nextTokenArr[1] = {newToken};
        llama_batch nextBatch = llama_batch_get_one(nextTokenArr, 1);
        if (llama_decode(session->ctx, nextBatch) != 0) {
            LOGE("llama_decode failed mid-generation at token %d", i);
            break; // return whatever was generated so far rather than losing the whole answer
        }
        nCur++;
    }

    llama_sampler_free(sampler);

    return env->NewStringUTF(output.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_boldas_bqi_localllm_LlamaBridge_nativeFree(
        JNIEnv * /* env */, jobject /* thiz */, jlong jHandle) {
    auto *session = reinterpret_cast<LlamaSession *>(jHandle);
    if (session == nullptr) return;
    if (session->ctx != nullptr) llama_free(session->ctx);
    if (session->model != nullptr) llama_model_free(session->model);
    delete session;
}
