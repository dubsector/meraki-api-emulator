#!/usr/bin/env node
// Times every GET route's sample URL, plus the longest timespan each route
// accepts, against a fresh emulator. Run it after adding an endpoint or
// changing the simulation; the slowest rows are the ones to look at.
//
// node scripts/bench.js [--runs 5] [--top 20] [--seed 1] [--now <time>]
// --top 0 lists every row. The clock is frozen at --now, or at the start time.

import { parseArgs } from 'node:util';
import { ROUTES, createEmulator } from '../src/server.js';
import { sampleUrl } from '../src/samples.js';

const DAY = 86400;
// Longest first: the first one a route accepts is its long case.
const SPANS = [186 * DAY, 31 * DAY, 30 * DAY, 7 * DAY];

const { values } = parseArgs({
  options: {
    runs: { type: 'string', default: '5' },
    top: { type: 'string', default: '20' },
    seed: { type: 'string' },
    now: { type: 'string' },
  },
});
const runs = Math.max(1, Number(values.runs) || 1);
const top = Number(values.top) || Infinity;
const now = values.now ?? new Date().toISOString().slice(0, 19) + 'Z';

const emu = createEmulator({ seed: values.seed, now, rateLimit: 0 });
await new Promise((resolve) => emu.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${emu.server.address().port}/api/v1`;
const started = performance.now();

async function hit(path) {
  const t = performance.now();
  const res = await fetch(base + path, { headers: { 'X-Cisco-Meraki-API-Key': 'bench' } });
  const body = await res.text();
  return { ms: performance.now() - t, status: res.status, body };
}

// Cold is the first call, which fills the per-day caches; warm is the median of the rest.
async function measure(path, first) {
  first ??= await hit(path);
  const warm = [];
  for (let i = 0; i < runs; i++) warm.push((await hit(path)).ms);
  warm.sort((a, b) => a - b);
  return { path, status: first.status, cold: first.ms, warm: warm[Math.floor(warm.length / 2)] };
}

function withSpan(path, span) {
  const url = new URL(base + path);
  url.searchParams.delete('t0');
  url.searchParams.delete('t1');
  url.searchParams.set('timespan', String(span));
  return url.pathname.slice(new URL(base).pathname.length) + url.search;
}

const rows = [];
let long = 0;
const gets = ROUTES.filter((r) => r.method === 'GET');
for (const route of gets) {
  const path = sampleUrl(route, emu.world, Date.parse(now) / 1000);
  const sample = await hit(path);
  rows.push(await measure(path, sample));
  if (sample.status !== 200) continue;
  for (const span of SPANS) {
    const p = withSpan(path, span);
    const first = await hit(p);
    if (first.status !== 200) continue;
    // Routes that ignore timespan answer the same as the sample.
    if (first.body !== sample.body) {
      rows.push(await measure(p, first));
      long++;
    }
    break;
  }
}
emu.server.close();

const fmt = (ms) => ms.toFixed(1).padStart(8);
const byWarm = [...rows].sort((a, b) => b.warm - a.warm);
const warm = rows.map((r) => r.warm).sort((a, b) => a - b);
const pct = (p) => warm[Math.min(warm.length - 1, Math.floor(warm.length * p))];

console.log(`${gets.length} GET routes, ${long} with a longer timespan, now ${now}, median of ${runs} warm runs\n`);
console.log(' warm ms  cold ms  status  path');
for (const r of byWarm.slice(0, top)) console.log(`${fmt(r.warm)} ${fmt(r.cold)}  ${String(r.status).padStart(6)}  ${r.path}`);
const mb = (n) => Math.round(n / 1048576);
const mem = process.memoryUsage();
console.log(`\nWarm: median ${pct(0.5).toFixed(2)} ms, p90 ${pct(0.9).toFixed(2)} ms, max ${pct(1).toFixed(1)} ms. Total ${((performance.now() - started) / 1000).toFixed(1)} s.`);
console.log(`Memory after the run: heap ${mb(mem.heapUsed)} MB, RSS ${mb(mem.rss)} MB.`);
