package com.boldas.bqi.localllm

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Plain JVM unit test (Robolectric/instrumentation NOT required -- this
 * class has zero android.* imports) for the resource-safety token cap.
 * Runs via `./gradlew :app:testDebugUnitTest`.
 */
class LocalLLMLimitsTest {

    @Test
    fun `clamps a request below the floor up to 1`() {
        assertEquals(1, LocalLLMLimits.clampMaxTokens(0))
        assertEquals(1, LocalLLMLimits.clampMaxTokens(-5))
    }

    @Test
    fun `passes through a request within range unchanged`() {
        assertEquals(350, LocalLLMLimits.clampMaxTokens(350))
        assertEquals(600, LocalLLMLimits.clampMaxTokens(600))
    }

    @Test
    fun `clamps a request above the cap down to MAX_GENERATION_TOKENS`() {
        assertEquals(LocalLLMLimits.MAX_GENERATION_TOKENS, LocalLLMLimits.clampMaxTokens(100000))
    }
}
