package com.boldas.bqi.localllm

/**
 * Thin Kotlin wrapper around the JNI bridge to llama.cpp
 * (src/main/cpp/llama-android.cpp). Every method here is a direct 1:1 call
 * into native code -- no business logic lives in this file, that's
 * [LocalLLMPlugin]'s job (idle-unload timer, request shaping, error
 * mapping to the shape llmRuntime.js expects).
 *
 * The native method signatures below must match the `extern "C" JNIEXPORT`
 * functions in llama-android.cpp exactly (JNI resolves by
 * package+class+method+signature); if either side is edited, edit both.
 */
internal object LlamaBridge {
    init {
        // Must match CMakeLists.txt's `add_library(bqi_llama ...)` name.
        System.loadLibrary("bqi_llama")
    }

    /**
     * Loads a GGUF model from an absolute filesystem path and creates an
     * inference context sized to [contextSize] tokens.
     *
     * @return an opaque non-zero native handle on success, or 0 on failure
     *   (bad file, OOM, unsupported GGUF version, ...) -- callers must
     *   never dereference 0 as a handle.
     */
    external fun nativeLoad(modelAbsolutePath: String, contextSize: Int, threadCount: Int): Long

    /**
     * Runs one blocking generation turn against an already-loaded handle.
     * [systemPrompt] is applied via llama.cpp's chat-template formatting
     * (see llama-android.cpp) so a chat-tuned model (Qwen2.5-Instruct) gets
     * a real system turn, not text concatenated into the user turn --
     * desktop/localAI/llmRuntime.js's comment documents why that distinction
     * mattered when this was verified against node-llama-cpp; the Android
     * JNI bridge applies the same chat template approach for parity.
     *
     * @return the generated completion text (never null; throws
     *   IllegalStateException on a native-side failure, mapped by
     *   LocalLLMPlugin into the plugin call's reject()).
     */
    external fun nativeGenerate(handle: Long, systemPrompt: String, prompt: String, maxTokens: Int, temperature: Float): String

    /** Frees the context + model behind [handle]. Safe to call once; a second call on an already-freed handle is a no-op on the native side. */
    external fun nativeFree(handle: Long)
}
