// Hashing and seeded randomness. Simulated values are pure functions of
// (entity key, time index), so the same query always returns the same data.

export function mix32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hashStr(str, seed = 0) {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

// Derive a new 32-bit key from a key and an integer or string salt.
export function derive(key, salt) {
  const s = typeof salt === 'string' ? hashStr(salt) : (salt + 0x9e3779b9) >>> 0;
  return mix32(key ^ mix32(s));
}

// Uniform float in [0, 1).
export function unit(key, i = 0) {
  return mix32(key ^ mix32((i + 0x9e3779b9) >>> 0)) / 4294967296;
}

// Roughly standard normal (Irwin-Hall with 4 terms).
export function gauss(key, i = 0) {
  const k = mix32(key ^ mix32((i + 0x7f4a7c15) >>> 0));
  return (unit(k, 0) + unit(k, 1) + unit(k, 2) + unit(k, 3) - 2) * 1.7320508;
}

// Multiplicative noise with mean 1.
export function lognoise(key, i, sigma) {
  return Math.exp(sigma * gauss(key, i) - (sigma * sigma) / 2);
}

export class Rand {
  constructor(seed) {
    this.a = seed >>> 0;
  }

  next() {
    let a = (this.a = (this.a + 0x6d2b79f5) | 0);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted(items, weightOf) {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = this.next() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r < 0) return it;
    }
    return items[items.length - 1];
  }

  chance(p) {
    return this.next() < p;
  }

  chars(n, alphabet) {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(this.next() * alphabet.length)];
    return s;
  }

  digits(n) {
    return String(this.int(1, 9)) + this.chars(n - 1, '0123456789');
  }

  hex(n) {
    return this.chars(n, '0123456789abcdef');
  }

  key() {
    return Math.floor(this.next() * 4294967296) >>> 0;
  }
}
