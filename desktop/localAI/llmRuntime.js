// Thin wrapper around node-llama-cpp (MIT license, prebuilt bindings for
// Windows/macOS/Linux). Isolated in its own module, behind a factory, so:
//   1. llmProvider.js and its tests never import node-llama-cpp directly
//      -- they take a `runtime` object shaped exactly like what this
//      factory returns, and tests inject a fake one. This is the same
//      dependency-injection seam pattern already used by
//      registry.js/provider.js (see their comments).
//   2. A machine where node-llama-cpp isn't installed/buildable (no GPU,
//      or missing build tools for that platform's prebuild) degrades to
//      "runtime unavailable" instead of crashing at import time -- the
//      dynamic import below is wrapped in try/catch.
//
// node-llama-cpp is intentionally NOT a hard dependency in package.json's
// "dependencies" (it's a large native addon with per-platform prebuilds);
// see package.json's optionalDependencies.
let cachedModule = null;
let cachedModuleError = null;

async function loadNodeLlamaCpp() {
  if (cachedModule) return cachedModule;
  if (cachedModuleError) throw cachedModuleError;
  try {
    // eslint-disable-next-line import/no-unresolved -- optional dependency, see above
    cachedModule = await import('node-llama-cpp');
    return cachedModule;
  } catch (err) {
    cachedModuleError = err;
    throw err;
  }
}

export async function isRuntimeInstallable() {
  try {
    await loadNodeLlamaCpp();
    return true;
  } catch {
    return false;
  }
}

// Real factory: loads node-llama-cpp, loads the given GGUF file, and
// returns a small { generate, dispose } surface. Never called directly by
// llmProvider.js in tests -- only by the production wiring in
// desktop/main.js / registry.js's default provider construction.
export async function createLlamaRuntime({ modelPath, contextSize = 4096, systemPrompt } = {}) {
  const { getLlama, LlamaChatSession } = await loadNodeLlamaCpp();
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  // 0 asks llama.cpp to use the maximum evaluation threads supported by
  // the machine. The default can be limited to physical math cores and was
  // needlessly slow on 4-logical-core laptops during the real smoke test.
  const context = await model.createContext({ contextSize, threads: 0 });
  // Passing the instruction as the chat session's systemPrompt (rather
  // than concatenating it into the user-turn text) was verified to matter
  // a lot for a chat-tuned model like Qwen2.5-Instruct -- concatenating it
  // into one big user message made the model narrate about the prompt
  // instead of answering it; a real systemPrompt gave a direct,
  // correctly-grounded answer in the same smoke test.
  const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });

  return {
    async generate(prompt, { maxTokens = 512, temperature = 0.3, timeoutMs = 60_000 } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await session.prompt(prompt, {
          maxTokens,
          temperature,
          signal: controller.signal,
          stopOnAbortSignal: true,
          // Real-device failure: a small/weak model can settle into a
          // "broken-record" loop, repeating the exact same sentence
          // verbatim for the rest of its token budget instead of finishing
          // the report (observed firsthand -- see llmProvider.js's
          // isTooShort/isPromptEcho neighbors, this is the same family of
          // "generation technically succeeded but the content is garbage"
          // failure, just not caught by either of those). node-llama-cpp's
          // DRY (Don't Repeat Yourself) penalty exists specifically for
          // this: it makes exact-token-sequence repetition impossible
          // rather than just less likely, without needing us to detect and
          // reject the output after the fact. Disabled by default; 0.8 is
          // node-llama-cpp's own documented recommended strength.
          dryRepeatPenalty: { strength: 0.8 },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          const timeoutError = new Error('local_llm_timeout');
          timeoutError.cause = err;
          throw timeoutError;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose() {
      await context.dispose?.();
      await model.dispose?.();
    },
  };
}
