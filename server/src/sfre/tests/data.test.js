import { describe, it, expect } from 'vitest';
import { makeObservation, validateObservation } from '../data/observation.js';
import { PitStore, createSnapshot, verifySnapshot, assertNoFutureData, LookAheadError } from '../data/pitStore.js';
import { obs, T0, DAY, iso } from './helpers.js';

describe('observation contract', () => {
  it('requires all four times + source + revision + hash and rejects bad shapes', () => {
    const o = makeObservation(obs());
    expect(o.hash).toMatch(/^[0-9a-f]{64}$/); expect(validateObservation(o)).toEqual([]);
    expect(() => makeObservation(obs({ available_time: iso(T0 - DAY) }))).toThrow(/available_time precedes/);
    expect(() => makeObservation(obs({ ingested_time: iso(T0 - DAY) }))).toThrow(/ingested_time precedes/);
    expect(() => makeObservation(obs({ event_time: '2025-01-06' }))).toThrow(/ISO-8601/);
    expect(() => makeObservation(obs({ value: NaN }))).toThrow();
    expect(() => makeObservation(obs({ quality_flags: ['MADE_UP'] }))).toThrow();
  });
  it('detects tampering via hash', () => {
    const o = { ...makeObservation(obs()), value: 11 };
    expect(validateObservation(o)).toContain('hash mismatch');
  });
  it('null value is UNOBSERVED, preserved as null (never coerced to 0)', () => {
    const o = makeObservation(obs({ value: null }));
    expect(o.value).toBeNull();
  });
});

describe('look-ahead firewall', () => {
  it('future data cannot leak into an as-of view (available_time governs, not event_time)', () => {
    const s = new PitStore();
    s.add(obs({ t: T0, value: 1 }));
    // event happened at T0+1d but only became available (published late) at T0+10d
    s.add(obs({ t: T0 + DAY, value: 2, published_time: iso(T0 + 10 * DAY), available_time: iso(T0 + 10 * DAY), ingested_time: iso(T0 + 10 * DAY) }));
    expect(s.asOf(T0 + 5 * DAY).series('BIST:AAAA', 'close').map((x) => x.value)).toEqual([1]);
    expect(s.asOf(T0 + 10 * DAY).series('BIST:AAAA', 'close').map((x) => x.value)).toEqual([1, 2]); // ties at T included
  });
  it('REGRESSION: a later restatement never changes an earlier as-of view', () => {
    const s = new PitStore();
    s.add(obs({ value: 100, revision: 0 }));
    s.add(obs({ value: 90, revision: 1, published_time: iso(T0 + 30 * DAY), available_time: iso(T0 + 30 * DAY), ingested_time: iso(T0 + 30 * DAY), quality_flags: ['RESTATED'] }));
    expect(s.asOf(T0 + 29 * DAY).latest('BIST:AAAA', 'close').value).toBe(100);
    expect(s.asOf(T0 + 30 * DAY).latest('BIST:AAAA', 'close').value).toBe(90);
  });
  it('assertNoFutureData throws on a leaking view', () => {
    const leaky = { observations: [makeObservation(obs({ t: T0 + DAY }))], asOfMs: T0 };
    expect(() => assertNoFutureData(leaky, T0)).toThrow(LookAheadError);
    expect(assertNoFutureData(new PitStore().asOf(T0), T0)).toBe(true);
  });
  it('the view is frozen and cannot be widened', () => {
    const v = new PitStore().asOf(T0);
    expect(() => { v.observations.push(1); }).toThrow();
  });
});

describe('immutable snapshots', () => {
  const list = () => [makeObservation(obs({ value: 1 })), makeObservation(obs({ t: T0 + DAY, value: 2 }))];
  it('is content-addressed, order independent and verifiable', () => {
    const a = createSnapshot(list(), { asOf: iso(T0 + 2 * DAY) }); const b = createSnapshot(list().reverse(), { asOf: iso(T0 + 2 * DAY) });
    expect(a.content_hash).toBe(b.content_hash); expect(a.snapshot_id).toBe(b.snapshot_id); expect(verifySnapshot(a)).toBe(true);
  });
  it('is deeply frozen: mutation throws', () => {
    const a = createSnapshot(list(), { asOf: iso(T0 + 2 * DAY) });
    expect(() => { a.observations[0].value = 99; }).toThrow();
    expect(() => { a.count = 0; }).toThrow();
  });
  it('rejects observations available after asOf', () => {
    expect(() => createSnapshot(list(), { asOf: iso(T0) })).toThrow(LookAheadError);
  });
});
