import { describe, it, expect } from 'vitest';
import { hashContent } from '../src/reports/integrity.js';

describe('report integrity hashing (pure)', () => {
  it('is stable regardless of key insertion order', () => {
    const a = { b: 2, a: 1, nested: { y: 2, x: 1 } };
    const b = { a: 1, b: 2, nested: { x: 1, y: 2 } };
    expect(hashContent(a)).toBe(hashContent(b));
  });

  it('changes when content actually changes', () => {
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });

  it('is stable for arrays (order preserved, not sorted)', () => {
    const arr = [{ b: 1, a: 2 }, { d: 3, c: 4 }];
    expect(hashContent(arr)).toBe(hashContent(JSON.parse(JSON.stringify(arr))));
  });

  it('matches the persisted JSON representation of Date values', () => {
    const live = { createdAt: new Date('2026-09-11T08:00:00.000Z') };
    const persisted = JSON.parse(JSON.stringify(live));
    expect(hashContent(live)).toBe(hashContent(persisted));
  });
});
