# Builds `libbqi_llama.so`, the native library LlamaBridge.kt loads
# (System.loadLibrary("bqi_llama")).
#
# ---------------------------------------------------------------------------
# llama.cpp is vendored as a real git submodule at
# mobile/android/app/src/main/cpp/llama.cpp, pinned to a specific commit
# (749f688fcaa4c472ec034b08cb8a907c45cfaa02, ggml-org/llama.cpp's default
# branch tip as of 2026-08-21) rather than a moving branch, so a future
# `git submodule update --remote` can't silently change the JNI ABI this
# file's llama-android.cpp was written against. llama.cpp is MIT licensed
# (github.com/ggml-org/llama.cpp/blob/master/LICENSE) -- compatible with
# this app's own licensing, no copyleft obligations.
#
# A checkout of this repo needs the submodule populated for this to build --
# `git clone --recurse-submodules ...`, or `git submodule update --init`
# after a plain clone. android-release.yml's checkout step already passes
# `submodules: true`. Without it, the else() branch below skips the native
# target with a warning instead of failing the build (see its comment).
#
# The else() branch's graceful skip also still matters locally: a clone
# without `--recurse-submodules` degrades to extractive Q LOCAL DATA at
# runtime instead of breaking the build.
#
# Why vendor-via-submodule instead of a prebuilt AAR: as of the research
# behind this change (2026-08-20), there is no actively maintained,
# permissively-licensed *plain Android AAR* for llama.cpp that this app can
# just add as a Gradle dependency -- the closest widely-used package,
# llama.rn (github.com/mybigday/llama.rn), bundles llama.cpp's Android JNI
# code but ships it as a React Native turbo-module (a `.aar` built for RN's
# bridge, with RN's own native module registration baked in), which this
# Capacitor app cannot consume as-is without either depending on the RN
# runtime or extracting/re-wrapping its JNI layer -- at which point it is
# no longer meaningfully simpler than building directly against upstream
# llama.cpp. llama.cpp's own repo ships a real, maintained Android example
# (examples/llama.android, MIT, Kotlin + JNI + CMake) that this plugin's
# structure deliberately mirrors -- same shape (a Kotlin wrapper class over
# `external fun` JNI declarations, backed by a small hand-written JNI .cpp
# that calls llama.cpp's public C API), so upgrading against a newer
# llama.cpp release later stays a small diff instead of a rewrite.
# ---------------------------------------------------------------------------

cmake_minimum_required(VERSION 3.22.1)
project(bqi_llama)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Only the llama.cpp targets actually needed (llama + its ggml backends),
# not its own examples/tests/server -- keeps the .so and build time down.
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE) # no network fetch capability baked into the native lib (spec point 5/9)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE) # avoid an extra runtime dependency on Android; NEON/CPU backend is enough for a phone

if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/CMakeLists.txt")
    add_subdirectory(llama.cpp llama.cpp-build)

    add_library(bqi_llama SHARED
        llama-android.cpp
    )

    target_link_libraries(bqi_llama
        llama
        ggml
        android
        log
    )

    target_include_directories(bqi_llama PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/include
        ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp/ggml/include
    )
else()
    # Do NOT hard-fail the configure step here: this CMakeLists.txt is invoked
    # by every Gradle build of the Android app (including the automated
    # android-release.yml CI pipeline), and until the llama.cpp submodule
    # (see the header comment above) is actually added on a real dev machine,
    # `bqi_llama.so` simply doesn't exist. LlamaBridge.kt's
    # `System.loadLibrary("bqi_llama")` then throws UnsatisfiedLinkError,
    # which LocalLLMPlugin.kt already catches as `Throwable` around every
    # LlamaBridge call and reports as a plugin-call failure -- the same
    # "local LLM unavailable" path the JS registry already falls back from to
    # extractive Q LOCAL DATA. So a missing submodule degrades this one
    # feature at runtime instead of breaking the Gradle/CI build.
    message(WARNING
        "llama.cpp source not found at ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp -- "
        "skipping the bqi_llama native target for this build (see this "
        "file's header comment for the required `git submodule add` step). "
        "The app will still build; the Android local LLM feature will report "
        "itself unavailable at runtime until the submodule is added.")
endif()
