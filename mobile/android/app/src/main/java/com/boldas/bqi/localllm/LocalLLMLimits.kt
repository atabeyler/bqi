package com.boldas.bqi.localllm

/**
 * Pure, Android-framework-free resource-safety limits, split out of
 * [LocalLLMPlugin] specifically so they're testable with a plain JVM
 * `src/test` unit test (no Robolectric/instrumentation, no device/emulator
 * needed -- see LocalLLMLimitsTest.kt) rather than only via an instrumented
 * test.
 */
internal object LocalLLMLimits {
    /**
     * Hard server-side cap on generated tokens per call, regardless of what
     * the JS layer requests (llmProvider.js already requests 350-600, but
     * the native side is the real resource boundary and must not trust the
     * caller blindly).
     */
    const val MAX_GENERATION_TOKENS = 768

    fun clampMaxTokens(requested: Int): Int = requested.coerceIn(1, MAX_GENERATION_TOKENS)
}
