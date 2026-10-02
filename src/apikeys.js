// The API keys of this run. Any key is accepted unless --api-key is set, so
// every key that has authenticated counts as one of the API admin's keys,
// alongside the ones generated through the API. A revoked key answers 401.
// Keys live for the run like the request log and survive a reset.

import { randomBytes } from 'node:crypto';

const MAX_KEYS = 10000;

export class ApiKeys {
  constructor() {
    this.keys = new Map(); // key -> { createdAt, generated }
    this.revoked = new Set();
  }

  // Remembers a key the first time it authenticates.
  seen(key, now) {
    if (this.keys.has(key)) return;
    if (this.keys.size >= MAX_KEYS) this.keys.delete(this.keys.keys().next().value);
    this.keys.set(key, { createdAt: now, generated: false });
  }

  isRevoked(key) {
    return this.revoked.has(key);
  }

  isGenerated(key) {
    return this.keys.get(key)?.generated === true;
  }

  list() {
    return [...this.keys].map(([key, k]) => ({ suffix: key.slice(-4), createdAt: k.createdAt }));
  }

  generate(now) {
    const key = randomBytes(20).toString('hex');
    if (this.keys.size >= MAX_KEYS) this.keys.delete(this.keys.keys().next().value);
    this.keys.set(key, { createdAt: now, generated: true });
    return key;
  }

  // Revokes every key ending in `suffix` and says whether there was one.
  revoke(suffix) {
    const gone = [...this.keys.keys()].filter((key) => key.slice(-4) === suffix);
    for (const key of gone) {
      this.keys.delete(key);
      if (this.revoked.size >= MAX_KEYS) this.revoked.delete(this.revoked.values().next().value);
      this.revoked.add(key);
    }
    return gone.length > 0;
  }
}
