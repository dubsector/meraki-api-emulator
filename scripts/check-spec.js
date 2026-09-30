#!/usr/bin/env node
// Compares the emulator against the official Meraki OpenAPI spec: every route
// must exist with the same operationId, and each sample response is checked
// for fields the spec's example has but we don't send, and fields we send
// that the spec doesn't define. Write routes are checked for path and operationId.
//
// node scripts/check-spec.js [path/to/spec3.json]   (downloads the spec if no path)

import { readFileSync } from 'node:fs';
import { ROUTES, createEmulator } from '../src/server.js';
import { sampleUrl } from '../src/samples.js';

const SPEC_URL = 'https://raw.githubusercontent.com/meraki/openapi/master/openapi/spec3.json';
const spec = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await (await fetch(SPEC_URL)).json();

// Walks the example and schema alongside our response, collecting key differences.
function compare(ours, example, schema, at, out) {
  if (Array.isArray(ours)) {
    if (ours.length && Array.isArray(example) && example.length) compare(ours[0], example[0], schema?.items, `${at}[]`, out);
    return;
  }
  if (!ours || typeof ours !== 'object' || !example || typeof example !== 'object' || Array.isArray(example)) return;
  const props = schema?.properties || {};
  const free = schema?.additionalProperties;
  for (const k of Object.keys(example)) if (!(k in ours) && !free) out.missing.push(`${at}.${k}`);
  for (const k of Object.keys(ours)) {
    if (!(k in example) && !(k in props) && !free) out.extra.push(`${at}.${k}`);
    else compare(ours[k], example[k] ?? null, props[k], `${at}.${k}`, out);
  }
}

const emulator = createEmulator({ rateLimit: 0 });
await new Promise((r) => emulator.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${emulator.server.address().port}/api/v1`;
let problems = 0;
for (const route of ROUTES) {
  const op = spec.paths[route.path]?.[route.method.toLowerCase()];
  if (!op) {
    console.log(`${route.method} ${route.path}: not in the spec`);
    problems++;
    continue;
  }
  if (op.operationId !== route.op) {
    console.log(`${route.method} ${route.path}: operationId is ${op.operationId}, not ${route.op}`);
    problems++;
  }
  // Writes change state, so only reads get their responses compared.
  if (route.method !== 'GET') continue;
  const expected = route.sample?.status ?? 200;
  const url = sampleUrl(route, emulator.world, Date.now() / 1000);
  const res = await fetch(base + url, { headers: { 'X-Cisco-Meraki-API-Key': 'spec-check' } });
  if (res.status !== expected) {
    console.log(`${route.op}: sample ${url} answered ${res.status}`);
    problems++;
    continue;
  }
  if (res.status !== 200) continue;
  const content = (op.responses['200'] || op.responses['201'])?.content?.['application/json'];
  const out = { missing: [], extra: [] };
  compare(await res.json(), content?.example, content?.schema, '', out);
  if (out.missing.length || out.extra.length) {
    console.log(`${route.op}`);
    if (out.missing.length) console.log(`  missing: ${out.missing.join(', ')}`);
    if (out.extra.length) console.log(`  not in spec: ${out.extra.join(', ')}`);
  }
}
emulator.server.close();
console.log(`${ROUTES.length} routes checked against spec ${spec.info.version}, ${problems} broken`);
process.exitCode = problems ? 1 : 0;
