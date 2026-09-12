import { describe, it, expect, vi } from 'vitest';
import { isRuntimeInstallable, createLlamaRuntime, getNativeDeviceInfo } from './llmRuntime.js';

function fakePluginGlobal(plugin) {
  return { Plugins: { LocalLLM: plugin } };
}

describe('isRuntimeInstallable', () => {
  it('is false when no LocalLLM plugin is registered', () => {
    expect(isRuntimeInstallable({ capacitorGlobal: { Plugins: {} } })).toBe(false);
  });

  it('is true once the native plugin is present', () => {
    expect(isRuntimeInstallable({ capacitorGlobal: fakePluginGlobal({}) })).toBe(true);
  });
});

describe('createLlamaRuntime', () => {
  it('throws a clear sentinel error when the native plugin is missing', async () => {
    await expect(createLlamaRuntime({ modelPath: 'x.gguf', capacitorGlobal: { Plugins: {} } }))
      .rejects.toThrow('android_native_llm_plugin_missing');
  });

  it('loads via the plugin and generate()/dispose() delegate to it', async () => {
    const load = vi.fn(async () => {});
    const generate = vi.fn(async () => ({ text: 'merhaba' }));
    const unload = vi.fn(async () => {});
    const plugin = { load, generate, unload };

    const runtime = await createLlamaRuntime({ modelPath: 'x.gguf', contextSize: 2048, systemPrompt: 'sp', capacitorGlobal: fakePluginGlobal(plugin) });
    expect(load).toHaveBeenCalledWith({ modelPath: 'x.gguf', contextSize: 2048, systemPrompt: 'sp' });

    const text = await runtime.generate('soru', { maxTokens: 100, temperature: 0.2 });
    expect(text).toBe('merhaba');
    expect(generate).toHaveBeenCalledWith({ prompt: 'soru', maxTokens: 100, temperature: 0.2 });

    await runtime.dispose();
    expect(unload).toHaveBeenCalled();
  });
});

describe('getNativeDeviceInfo', () => {
  it('returns null when the plugin is missing', async () => {
    expect(await getNativeDeviceInfo({ capacitorGlobal: { Plugins: {} } })).toBeNull();
  });

  it('returns null when the plugin has no getDeviceInfo method', async () => {
    expect(await getNativeDeviceInfo({ capacitorGlobal: fakePluginGlobal({}) })).toBeNull();
  });

  it('returns null (never throws) when the native call rejects', async () => {
    const plugin = { getDeviceInfo: vi.fn(async () => { throw new Error('boom'); }) };
    expect(await getNativeDeviceInfo({ capacitorGlobal: fakePluginGlobal(plugin) })).toBeNull();
  });

  it('passes through a real reading', async () => {
    const plugin = { getDeviceInfo: vi.fn(async () => ({ totalMemBytes: 8 * 1024 ** 3, freeDiskBytes: 4 * 1024 ** 3 })) };
    const info = await getNativeDeviceInfo({ capacitorGlobal: fakePluginGlobal(plugin) });
    expect(info.totalMemBytes).toBe(8 * 1024 ** 3);
  });
});
