import { describe, it, expect } from 'vitest';
import { classifyCategory } from './classification.js';

describe('classifyCategory', () => {
  it('floors high-sensitivity categories to CONFIDENTIAL', () => {
    for (const cat of ['savunma', 'saldiri', 'bddk', 'btk', 'cok-alanli']) {
      expect(classifyCategory(cat)).toBe('CONFIDENTIAL');
    }
  });

  it('defaults an ordinary category to INTERNAL', () => {
    expect(classifyCategory('ekonomi')).toBe('INTERNAL');
  });

  it('returns null when there is no category yet', () => {
    expect(classifyCategory(null)).toBeNull();
    expect(classifyCategory('')).toBeNull();
  });
});
