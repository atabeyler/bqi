import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptField, decryptField, isEncrypted } from './fieldCrypto.js';

// BQI-002 adversarial coverage for the AES-256-GCM field crypto primitive
// itself -- tampering, truncation, and reuse attacks an attacker with
// filesystem access to the SQLite file (but not the OS keychain-protected
// key) could attempt against an encrypted title/content column.

const KEY = crypto.randomBytes(32).toString('hex');
const OTHER_KEY = crypto.randomBytes(32).toString('hex');

describe('tamper resistance (AES-GCM authentication)', () => {
  it('rejects ciphertext with a flipped byte (GCM auth tag fails closed)', () => {
    const enc = encryptField('gizli icerik', KEY);
    const [prefix, ivHex, tagHex, dataHex] = [enc.slice(0, 9), ...enc.slice(9).split(':')];
    void prefix;
    const tampered = Buffer.from(dataHex, 'hex');
    tampered[0] ^= 0xff;
    const corrupted = `aqenc:v1:${ivHex}:${tagHex}:${tampered.toString('hex')}`;
    expect(() => decryptField(corrupted, KEY)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const enc = encryptField('gizli icerik', KEY);
    const [ivHex, tagHex, dataHex] = enc.slice('aqenc:v1:'.length).split(':');
    const tag = Buffer.from(tagHex, 'hex');
    tag[0] ^= 0xff;
    const corrupted = `aqenc:v1:${ivHex}:${tag.toString('hex')}:${dataHex}`;
    expect(() => decryptField(corrupted, KEY)).toThrow();
  });

  it('rejects a ciphertext block swapped from a DIFFERENT encrypted value under the same key (no cross-field replay)', () => {
    const encA = encryptField('rapor A - gizli', KEY);
    const encB = encryptField('rapor B - gizli', KEY);
    const [ivA, tagA] = encA.slice('aqenc:v1:'.length).split(':');
    const [, , dataB] = encB.slice('aqenc:v1:'.length).split(':');
    const swapped = `aqenc:v1:${ivA}:${tagA}:${dataB}`;
    expect(() => decryptField(swapped, KEY)).toThrow();
  });

  it('rejects truncated ciphertext', () => {
    const enc = encryptField('gizli icerik', KEY);
    const truncated = enc.slice(0, enc.length - 10);
    expect(() => decryptField(truncated, KEY)).toThrow();
  });
});

describe('key isolation', () => {
  it('a value encrypted on one device is unreadable with a different device key (no cross-device silent leakage)', () => {
    const enc = encryptField('cok gizli', KEY);
    expect(() => decryptField(enc, OTHER_KEY)).toThrow();
  });

  it('never leaks the plaintext in the thrown error message on a wrong-key attempt', () => {
    const secret = 'ASLA_GORULMEMESI_GEREKEN_METIN';
    const enc = encryptField(secret, KEY);
    try {
      decryptField(enc, OTHER_KEY);
      throw new Error('expected decryptField to throw');
    } catch (err) {
      expect(String(err.message)).not.toContain(secret);
    }
  });
});

describe('IV/nonce hygiene', () => {
  it('never reuses the same IV for two encryptions of the same plaintext under the same key', () => {
    const encryptions = Array.from({ length: 20 }, () => encryptField('ayni metin', KEY));
    const ivs = encryptions.map((e) => e.slice('aqenc:v1:'.length).split(':')[0]);
    expect(new Set(ivs).size).toBe(ivs.length);
  });

  it('produces different ciphertext each time even for identical plaintext (no ECB-style determinism)', () => {
    const encryptions = new Set(Array.from({ length: 10 }, () => encryptField('ayni metin', KEY)));
    expect(encryptions.size).toBe(10);
  });
});

describe('format confusion', () => {
  it('does not misclassify a plaintext value that merely starts with the encryption prefix text as ciphertext-shaped garbage without throwing predictably', () => {
    // A user could legitimately type a title starting with "aqenc:v1:" --
    // isEncrypted() would treat it as ciphertext (by design, matching the
    // module's documented trade-off), so decrypting it must fail closed
    // rather than silently returning corrupted/wrong data.
    const lookalike = 'aqenc:v1:not-actually-encrypted';
    expect(isEncrypted(lookalike)).toBe(true);
    expect(() => decryptField(lookalike, KEY)).toThrow();
  });

  it('a short single-character plaintext round-trips correctly and is distinguishable from ciphertext', () => {
    const enc = encryptField('x', KEY);
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptField(enc, KEY)).toBe('x');
  });
});
