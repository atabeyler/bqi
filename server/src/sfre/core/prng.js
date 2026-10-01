/**
 * Seeded PRNG (xoshiro128**, state seeded by splitmix32). Deterministic across
 * platforms: only 32-bit integer ops. No Math.random anywhere in SFRE.
 */
function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}

export class Rng {
  constructor(seed) {
    if (!Number.isInteger(seed)) throw new Error('Rng: integer seed required');
    this.seed = seed;
    const sm = splitmix32(seed);
    this.s = [sm(), sm(), sm(), sm()];
    this._spare = null;
  }

  _u32() {
    const s = this.s;
    const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3];
    s[2] ^= t; s[3] = rotl(s[3], 11);
    for (let i = 0; i < 4; i++) s[i] >>>= 0;
    return result;
  }

  /** float in [0,1) with 32-bit resolution */
  next() { return this._u32() / 4294967296; }

  /** integer in [0, n) */
  int(n) { return Math.floor(this.next() * n); }

  /** standard normal (Box–Muller, deterministic) */
  normal() {
    if (this._spare !== null) { const v = this._spare; this._spare = null; return v; }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this._spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** independent child stream; stable for a given (seed, label) */
  child(label) {
    let h = this.seed >>> 0;
    for (const ch of String(label)) h = (Math.imul(h ^ ch.charCodeAt(0), 0x01000193)) >>> 0;
    return new Rng(h | 0);
  }
}
