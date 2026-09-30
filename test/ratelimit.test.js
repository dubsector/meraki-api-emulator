import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RateLimiter } from '../src/ratelimit.js';

describe('rate limiter', () => {
  test('spends the burst, then refills at the rate', () => {
    const l = new RateLimiter(2, 2);
    assert.equal(l.take('a', 0), 0);
    assert.equal(l.take('a', 0), 0);
    assert.equal(l.take('a', 0), 0.5);
    assert.equal(l.take('a', 500), 0);
    assert.equal(l.take('b', 500), 0, 'keys have their own buckets');
  });

  test('forgets idle keys instead of growing forever', () => {
    const l = new RateLimiter(10, 20, 100);
    for (let i = 0; i < 1000; i++) l.take(`idle-${i}`, i * 1000);
    assert.ok(l.size <= 100, `${l.size} keys`);
  });

  test('starts over when every key is busy', () => {
    const l = new RateLimiter(10, 20, 100);
    for (let i = 0; i < 1000; i++) l.take(`busy-${i}`, 0);
    assert.ok(l.size <= 100, `${l.size} keys`);
  });
});
