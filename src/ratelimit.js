// Token bucket per API key, refilled continuously. Times are in milliseconds.

export class RateLimiter {
  constructor(rate, burst, maxKeys = 10000) {
    this.rate = rate;
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  get size() {
    return this.buckets.size;
  }

  // Returns 0 when a token was taken, otherwise seconds until one is free.
  take(key, now = performance.now()) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      this.buckets.set(key, (b = { tokens: this.burst, at: now }));
    }
    b.tokens = this.refilled(b, now);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return (1 - b.tokens) / this.rate;
  }

  refilled(b, now) {
    return Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
  }

  // A full bucket is the same as no bucket, so those go first. If most keys
  // are still mid-burst, start over rather than grow without limit.
  prune(now) {
    for (const [key, b] of this.buckets) if (this.refilled(b, now) >= this.burst) this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys / 2) this.buckets.clear();
  }
}
