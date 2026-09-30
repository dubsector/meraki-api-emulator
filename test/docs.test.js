import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { endpointsMarkdown } from '../scripts/endpoints.js';
import { ROUTES } from '../src/server.js';

test('ENDPOINTS.md lists every route (run npm run docs to update it)', () => {
  assert.equal(readFileSync(new URL('../ENDPOINTS.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), endpointsMarkdown());
});

test('every route has a unique operation ID', () => {
  const ops = ROUTES.map((r) => r.op);
  assert.ok(ops.every(Boolean));
  assert.equal(new Set(ops).size, ops.length);
});
