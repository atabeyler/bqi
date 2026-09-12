package com.boldas.bqi.localllm

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Instrumented test that proves the real thing this project has never
 * actually verified: that the JNI bridge to llama.cpp (LlamaBridge.kt ->
 * llama-android.cpp -> the vendored llama.cpp submodule) genuinely loads a
 * real GGUF model and produces real generated text on real emulator
 * hardware -- not just that it cross-compiles cleanly in CI (which is all
 * android-release.yml has ever checked).
 *
 * What this DOES prove, if green: `libbqi_llama.so` links and loads
 * via System.loadLibrary on an x86_64 Android emulator, `nativeLoad` can
 * parse a real Qwen2.5 GGUF file and construct a working llama.cpp context,
 * and `nativeGenerate` produces non-garbage text through that context
 * end-to-end (tokenize -> chat-template -> sample -> detokenize) without
 * crashing, and `nativeFree` releases it cleanly.
 *
 * What this does NOT prove: real ARM64 phone behavior. x86_64 and
 * arm64-v8a are different compiled code paths (different ggml backend
 * kernels -- NEON on arm64-v8a vs. the generic/AVX path on x86_64), so
 * output quality, performance, and even latent bugs on one ABI can differ
 * from the other. This is deliberately the same tradeoff
 * app/build.gradle's own abiFilters comment documents: x86_64 exists
 * specifically so this can run on an ordinary GitHub Actions emulator,
 * standing in for arm64-v8a because real ARM hardware/emulation is not
 * available in a standard GitHub-hosted runner. Nor does this test
 * anything about the Capacitor PluginCall plumbing in LocalLLMPlugin.kt
 * (idle-unload timer, error-message mapping, JS-facing payload shapes) --
 * it calls LlamaBridge directly, deliberately bypassing that layer, which
 * is plumbing already covered by the JS-side tests.
 *
 * Runs against the real "low" tier model from
 * client/src/mobile/localAI/modelSpec.js (Qwen2.5-0.5B-Instruct-Q4_K_M,
 * ~469MB) -- the smallest of the three tiers, chosen here purely to keep
 * CI download time and emulator inference time down; it is not otherwise
 * special.
 */
@RunWith(AndroidJUnit4::class)
class LocalLLMInferenceInstrumentedTest {

    companion object {
        private const val MODEL_URL =
            "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf"
        private const val MODEL_FILENAME = "qwen2.5-0.5b-instruct-q4_k_m.gguf"

        // Must match client/src/mobile/localAI/modelSpec.js's LOW tier's
        // `sha256` field exactly. Duplicated here (rather than shared
        // across the JS/Kotlin boundary) deliberately -- see the class
        // comment; if modelSpec.js's LOW tier is ever repinned to a
        // different file/checksum, update this constant too.
        private const val MODEL_SHA256 =
            "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db"

        // Matches modelSpec.js's LOW tier's contextSize.
        private const val CONTEXT_SIZE = 1536
        private const val THREAD_COUNT = 4

        private const val PROMPT = "What is the capital of France? Answer in one short sentence."
        private const val SYSTEM_PROMPT = "You are a helpful assistant. Answer briefly and factually."
        private const val MAX_TOKENS = 32
        private const val TEMPERATURE = 0.2f

        // Generous: real network download of a ~469MB file over a CI
        // runner's network, plus first-time model load and CPU-only
        // inference on emulator hardware, can plausibly take a few
        // minutes. This is a correctness/crash smoke test, not a
        // performance benchmark, so err on the side of not flaking on a
        // slow-but-healthy run.
        private const val TEST_TIMEOUT_MS = 10 * 60 * 1000L
    }

    @Test(timeout = TEST_TIMEOUT_MS)
    fun loadsRealModelAndGeneratesRealText() {
        // Force LlamaBridge's static init (which calls
        // System.loadLibrary("bqi_llama")) up front, before spending
        // CI minutes downloading a ~469MB model that would go to waste if
        // the native lib isn't present for this ABI/build at all. Mirrors
        // LocalLLMPlugin.kt's own catch-Throwable-including-
        // UnsatisfiedLinkError judgement (see its load() method), but
        // narrowed to UnsatisfiedLinkError specifically: that error means
        // "native lib genuinely isn't built for this ABI", a real, distinct
        // precondition failure this test should skip on rather than fail
        // on -- any other exception/assertion failure below is a genuine
        // bug and must still fail the test normally.
        try {
            @Suppress("UNUSED_EXPRESSION")
            LlamaBridge
        } catch (missingLib: UnsatisfiedLinkError) {
            Assume.assumeNoException(
                "bqi_llama native library is not present for this build/ABI -- skipping " +
                    "(this is expected only if the .so genuinely wasn't built for this ABI, " +
                    "which should not happen on the x86_64 CI emulator job)",
                missingLib,
            )
            return
        }

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val modelFile = File(context.filesDir, MODEL_FILENAME)

        downloadModel(MODEL_URL, modelFile)

        val actualSha256 = sha256Hex(modelFile)
        assertEquals(
            "Downloaded model's SHA-256 must match the pinned checksum " +
                "(client/src/mobile/localAI/modelSpec.js's LOW tier)",
            MODEL_SHA256,
            actualSha256,
        )

        val handle = LlamaBridge.nativeLoad(modelFile.absolutePath, CONTEXT_SIZE, THREAD_COUNT)
        assertTrue("nativeLoad should return a non-zero handle on success", handle != 0L)

        try {
            val output = LlamaBridge.nativeGenerate(handle, SYSTEM_PROMPT, PROMPT, MAX_TOKENS, TEMPERATURE)
            // Deliberately not asserting on exact wording -- models aren't
            // that deterministic across hardware/quantization/sampling.
            // The point is proving real tokens came back through the full
            // native pipeline, not grading output quality.
            assertTrue("generated text should be non-empty", output.isNotEmpty())
            assertTrue(
                "generated text should look like real text (at least one letter)",
                output.any { it.isLetter() },
            )
        } finally {
            // Proving nativeFree doesn't crash on cleanup is itself part
            // of what this test asserts (task spec point 5) -- letting
            // any exception here propagate (rather than swallowing it)
            // is what makes that a real assertion.
            LlamaBridge.nativeFree(handle)
        }
    }

    private fun downloadModel(urlString: String, destination: File) {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.connectTimeout = 30_000
        connection.readTimeout = 60_000
        connection.instanceFollowRedirects = true
        try {
            connection.connect()
            val responseCode = connection.responseCode
            check(responseCode in 200..299) {
                "Unexpected HTTP $responseCode downloading model from $urlString"
            }
            connection.inputStream.use { input ->
                FileOutputStream(destination).use { output ->
                    input.copyTo(output, bufferSize = 1 shl 20)
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            var bytesRead: Int
            while (input.read(buffer).also { bytesRead = it } != -1) {
                digest.update(buffer, 0, bytesRead)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
