package com.boldas.bqi.localllm

import android.app.ActivityManager
import android.content.Context
import android.os.StatFs
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented test -- needs a real device or emulator to run, via
 * `./gradlew :app:connectedDebugAndroidTest`.
 *
 * Exercises the same ActivityManager.MemoryInfo/StatFs reads
 * LocalLLMPlugin.getDeviceInfo() uses, directly against the instrumentation
 * target context, as a sanity check that the real API calls return
 * plausible values on the actual device/emulator this runs on -- it does
 * NOT go through the Capacitor PluginCall/Bridge machinery (that needs a
 * running Activity with a registered Bridge, which is exercised instead by
 * manual testing on a real device).
 */
@RunWith(AndroidJUnit4::class)
class LocalLLMPluginDeviceInfoTest {

    @Test
    fun readsPlausibleMemoryAndDiskFigures() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        am.getMemoryInfo(memInfo)

        val stat = StatFs(context.filesDir.absolutePath)

        // Loose sanity bounds only -- this is a real device/emulator read,
        // not a fixed fixture, so the assertion just guards against an
        // obviously broken (zero/negative) reading rather than an exact
        // value.
        assertTrue("totalMem should be a plausible positive RAM figure", memInfo.totalMem > 256L * 1024 * 1024)
        assertTrue("availableBytes should be non-negative", stat.availableBytes >= 0)
    }
}
