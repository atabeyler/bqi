package com.boldas.bqi.localllm

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.StatFs
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.security.MessageDigest

/**
 * Capacitor plugin backing `window.Capacitor.Plugins.LocalLLM`, the exact
 * seam client/src/mobile/localAI/llmRuntime.js already calls. Method
 * names/params/return shapes below were matched against that file (and
 * llmProvider.js, which is llmRuntime.js's only real caller) rather than
 * invented independently:
 *
 *   - load({modelPath, contextSize, systemPrompt}) -> {} on success
 *   - generate({prompt, maxTokens, temperature}) -> {text}
 *   - unload() -> {}
 *   - getDeviceInfo() -> {totalMemBytes, freeDiskBytes, lowRamDevice}   (new;
 *     added for task spec point 4's real RAM-based tiering -- llmRuntime.js's
 *     getNativeDeviceInfo() calls this)
 *
 * Capacitor (v3+, including the v8 this project pins per
 * mobile/android/app/capacitor.build.gradle's dependency versions) already
 * dispatches each @PluginMethod call on a background thread by default, so
 * the blocking, potentially multi-second nativeGenerate() JNI call below
 * does not need its own thread/executor -- it must simply never be invoked
 * from the main thread by any *other* future caller in this file.
 *
 * Registered manually in MainActivity.java (Capacitor's documented pattern
 * for a plugin that lives inside the app module itself rather than being
 * published as a separate npm package under node_modules -- this project
 * has no prior custom-plugin precedent to follow, so this establishes it).
 */
@CapacitorPlugin(name = "LocalLLM")
class LocalLLMPlugin : Plugin() {

    // Resource-safety idle-unload (task spec point 8). This lives here
    // (native), not in the JS layer, deliberately: client/src/mobile/localAI/
    // llmProvider.js's createLLMQuery() -- see its comment -- is recreated
    // fresh on every single query() call by registry.js/provider.js (that's
    // the existing, already-committed desktop-mirroring design; not changed
    // here), so there is no persistent JS object across requests for a JS
    // timer to live on. This plugin instance, in contrast, is bound to the
    // Capacitor Bridge/Activity and genuinely persists across every JS call
    // for the app's lifetime -- it is the only thing that CAN own an idle
    // timer that means anything. load() below is also made idempotent for
    // the same reason: without it, every single chat/analysis request would
    // reload the entire GGUF model from scratch.
    private val idleHandler = Handler(Looper.getMainLooper())
    private val idleUnloadRunnable = Runnable { unloadLocked("idle_timeout") }
    private val lock = Any()

    private var handle: Long = 0L
    private var loadedPath: String? = null
    private var loadedContextSize: Int = 0
    // llmRuntime.js sends systemPrompt only in load()'s payload, never in
    // generate()'s (see createLlamaRuntime() in
    // client/src/mobile/localAI/llmRuntime.js) -- stored here so generate()
    // still has it to fold into the chat template on every call.
    private var loadedSystemPrompt: String = ""

    companion object {
        private const val IDLE_UNLOAD_MS = 5 * 60 * 1000L // 5 minutes, mirrors the "unload after idle" requirement
        private const val DEFAULT_THREAD_COUNT = 4
    }

    /**
     * item 7 (path traversal): modelPath is a string the JS layer sends
     * verbatim (registry.js/modelSpec.js's own filenames today, but this
     * plugin has no way to know that at runtime -- it's an untrusted
     * cross-boundary argument like any other Capacitor call). `File(parent,
     * child)` does NOT confine `child` to `parent`: a `child` starting with
     * "/" replaces the parent entirely, and a relative "../../.." climbs out
     * of it -- either way this used to let a compromised/malicious webview
     * context read (sha256File) or mmap (load) arbitrary files the app
     * process can access, not just files inside filesDir/models. Resolving
     * to a canonical path and checking it's still inside filesDir closes
     * both variants; symlink-based escapes are also caught since
     * canonicalFile resolves symlinks before the prefix check.
     */
    private fun resolveConfinedFile(modelPath: String): File? {
        val root = context.filesDir.canonicalFile
        val candidate = File(root, modelPath).canonicalFile
        if (candidate != root && !candidate.path.startsWith(root.path + File.separator)) {
            return null
        }
        return candidate
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val modelPath = call.getString("modelPath")
        if (modelPath.isNullOrBlank()) {
            call.reject("modelPath is required")
            return
        }
        val contextSize = call.getInt("contextSize", 2048) ?: 2048
        val systemPrompt = call.getString("systemPrompt") ?: ""

        val modelFile = resolveConfinedFile(modelPath)
        if (modelFile == null) {
            call.reject("local_llm_invalid_model_path")
            return
        }
        if (!modelFile.exists()) {
            call.reject("local_llm_model_file_missing: ${modelFile.absolutePath}")
            return
        }

        synchronized(lock) {
            resetIdleTimer()
            // Idempotent: the exact same model+contextSize is already
            // resident, so this is a no-op reload -- see the class-level
            // comment on why this matters given the JS layer calls load()
            // on every request.
            if (handle != 0L && loadedPath == modelFile.absolutePath && loadedContextSize == contextSize) {
                loadedSystemPrompt = systemPrompt
                call.resolve()
                return
            }
            // A different model (e.g. the tier changed after a RAM re-read,
            // or the user re-installed a different tier) is being swapped
            // in -- free the old one first so native memory is never leaked
            // by an overwritten handle.
            if (handle != 0L) {
                LlamaBridge.nativeFree(handle)
                handle = 0L
                loadedPath = null
            }
            try {
                val newHandle = LlamaBridge.nativeLoad(modelFile.absolutePath, contextSize, DEFAULT_THREAD_COUNT)
                if (newHandle == 0L) {
                    call.reject("local_llm_native_load_failed")
                    return
                }
                handle = newHandle
                loadedPath = modelFile.absolutePath
                loadedContextSize = contextSize
                loadedSystemPrompt = systemPrompt
                call.resolve()
            } catch (t: Throwable) {
                // t is caught as Throwable deliberately (see class comment --
                // must also catch UnsatisfiedLinkError, an Error, not an
                // Exception, when bqi_llama.so isn't built yet), but
                // PluginCall.reject()'s (String, Throwable) overload only
                // accepts Exception -- pass the message instead of the
                // Throwable itself so this compiles regardless of t's type.
                call.reject("local_llm_native_load_failed: ${t.message}", t.toString())
            }
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val prompt = call.getString("prompt")
        if (prompt.isNullOrEmpty()) {
            call.reject("prompt is required")
            return
        }
        val requestedMaxTokens = call.getInt("maxTokens", 350) ?: 350
        val maxTokens = LocalLLMLimits.clampMaxTokens(requestedMaxTokens)
        val temperature = (call.getDouble("temperature") ?: 0.3).toFloat()

        val activeHandle: Long
        val systemPrompt: String
        synchronized(lock) {
            if (handle == 0L) {
                call.reject("local_llm_unavailable: model not loaded")
                return
            }
            resetIdleTimer()
            activeHandle = handle
            systemPrompt = loadedSystemPrompt
        }

        try {
            // Blocking JNI call -- fine here, Capacitor already runs
            // @PluginMethod calls off the main thread (see class comment).
            val text = LlamaBridge.nativeGenerate(activeHandle, systemPrompt, prompt, maxTokens, temperature)
            synchronized(lock) { resetIdleTimer() } // count generation time itself as activity, not just the call start
            val ret = JSObject()
            ret.put("text", text)
            call.resolve(ret)
        } catch (t: Throwable) {
            call.reject("local_llm_generate_failed: ${t.message}", t.toString())
        }
    }

    @PluginMethod
    fun unload(call: PluginCall) {
        synchronized(lock) { unloadLocked("explicit_call") }
        call.resolve()
    }

    /**
     * Real RAM/disk reading (task spec point 4) -- ActivityManager.MemoryInfo
     * for total RAM (more reliable across OEM skins than getMemoryClass(),
     * which reports the *per-app heap ceiling*, not device RAM) and StatFs
     * for free disk on the same volume the model downloads to.
     */
    @PluginMethod
    fun getDeviceInfo(call: PluginCall) {
        try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val memInfo = ActivityManager.MemoryInfo()
            am.getMemoryInfo(memInfo)

            val stat = StatFs(context.filesDir.absolutePath)
            val freeDiskBytes = stat.availableBytes

            val ret = JSObject()
            ret.put("totalMemBytes", memInfo.totalMem)
            ret.put("freeDiskBytes", freeDiskBytes)
            ret.put("lowRamDevice", am.isLowRamDevice)
            call.resolve(ret)
        } catch (t: Throwable) {
            call.reject("local_llm_device_info_failed: ${t.message}", t.toString())
        }
    }

    @PluginMethod
    fun sha256File(call: PluginCall) {
        val modelPath = call.getString("modelPath")
        if (modelPath.isNullOrBlank()) {
            call.reject("modelPath is required")
            return
        }
        val file = resolveConfinedFile(modelPath)
        if (file == null) {
            call.reject("local_llm_invalid_model_path")
            return
        }
        if (!file.exists()) {
            call.reject("local_llm_model_file_missing: ${file.absolutePath}")
            return
        }
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(1 shl 16)
                var bytesRead: Int
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    digest.update(buffer, 0, bytesRead)
                }
            }
            val ret = JSObject()
            ret.put("sha256", digest.digest().joinToString("") { "%02x".format(it) })
            call.resolve(ret)
        } catch (t: Throwable) {
            call.reject("local_llm_sha256_failed: ${t.message}", t.toString())
        }
    }

    override fun handleOnDestroy() {
        synchronized(lock) { unloadLocked("activity_destroyed") }
        super.handleOnDestroy()
    }

    private fun resetIdleTimer() {
        idleHandler.removeCallbacks(idleUnloadRunnable)
        idleHandler.postDelayed(idleUnloadRunnable, IDLE_UNLOAD_MS)
    }

    private fun unloadLocked(@Suppress("UNUSED_PARAMETER") reason: String) {
        idleHandler.removeCallbacks(idleUnloadRunnable)
        if (handle != 0L) {
            LlamaBridge.nativeFree(handle)
            handle = 0L
            loadedPath = null
        }
    }
}
