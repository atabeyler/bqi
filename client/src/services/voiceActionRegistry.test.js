import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerActions, unregisterActions, getActionsForAI, executeAction } from './voiceActionRegistry.js';

describe('voiceActionRegistry', () => {
  beforeEach(() => {
    unregisterActions('test-scope');
    unregisterActions('test-scope-2');
  });

  it('returns registered actions as an AI schema (handler excluded)', () => {
    registerActions('test-scope', [
      { name: 'do_thing', description: 'do a thing', params: { value: 'string' }, handler: () => {} },
    ]);
    const actions = getActionsForAI();
    const found = actions.find((a) => a.name === 'do_thing');
    expect(found).toEqual({ name: 'do_thing', description: 'do a thing', params: { value: 'string' } });
    expect(found.handler).toBeUndefined();
  });

  it('executeAction calls the matching handler and returns true', () => {
    const handler = vi.fn();
    registerActions('test-scope', [{ name: 'do_thing', description: '', params: {}, handler }]);
    const result = executeAction('do_thing', { value: 42 });
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it('returns false for an unknown action without throwing', () => {
    expect(executeAction('no_such_action')).toBe(false);
  });

  it('still returns true when the handler throws (the error is swallowed)', () => {
    registerActions('test-scope', [
      { name: 'explode', description: '', params: {}, handler: () => { throw new Error('boom'); } },
    ]);
    expect(executeAction('explode')).toBe(true);
  });

  it('no longer finds an action after unregisterActions', () => {
    registerActions('test-scope', [{ name: 'temp', description: '', params: {}, handler: () => {} }]);
    unregisterActions('test-scope');
    expect(executeAction('temp')).toBe(false);
  });
});
