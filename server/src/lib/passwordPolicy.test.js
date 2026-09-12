import { describe, it, expect } from 'vitest';
import { validatePassword } from './passwordPolicy.js';

describe('validatePassword', () => {
  it('accepts a password meeting every requirement', () => {
    expect(validatePassword('Gvenlik!42')).toBeNull();
  });

  it('rejects a password under 8 characters', () => {
    expect(validatePassword('Ab1!')).toMatch(/en az 8 karakter/);
  });

  it('rejects a password with no lowercase letter', () => {
    expect(validatePassword('GUVENLIK1!')).toMatch(/küçük harf/);
  });

  it('rejects a password with no uppercase letter', () => {
    expect(validatePassword('guvenlik1!')).toMatch(/büyük harf/);
  });

  it('rejects a password with no digit', () => {
    expect(validatePassword('Guvenlik!!')).toMatch(/rakam/);
  });

  it('rejects a password with no special character', () => {
    expect(validatePassword('Guvenlik142')).toMatch(/özel karakter/);
  });

  it('rejects a purely numeric password (the previous, weaker policy would have accepted this)', () => {
    expect(validatePassword('12345678')).not.toBeNull();
  });

  it('rejects a pathologically long password instead of hashing it', () => {
    expect(validatePassword(`Gvenlik!42${'a'.repeat(200)}`)).toMatch(/en fazla 128 karakter/);
  });
});
