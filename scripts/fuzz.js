#!/usr/bin/env node
// Sends broken and edge-case bodies to every write route and junk query values
// to every GET, and reports each one that answers 5xx. Every write route starts
// from a fresh world and every GET sample is read after its bodies, so a write
// that's accepted but leaves something a later read chokes on shows up too.
// Exits 1 when anything answers 5xx, so CI can run it. Takes about 5 minutes.
//
// node scripts/fuzz.js [--only <regex>] [--no-queries]
// --only limits the run to operation IDs matching the regex.

import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { sampleUrl } from '../src/samples.js';
import { ROUTES, createEmulator } from '../src/server.js';
import { schemaOf } from '../src/validate.js';

const NOW = '2026-09-29T18:30:00Z';
const JUNK = [null, '', 'x', -1, 0, 99999999999, 1.5, true, [], [null], {}];
const QUERY_JUNK = ['', 'abc', '-1', '0', '99999999999', '1.5', '2026-13-45', '%ZZ', 'x,y'];
// Query parameters most GETs take one of, so no spec download is needed.
const QUERY_PARAMS = ['t0', 't1', 'timespan', 'perPage', 'startingAfter', 'endingBefore', 'resolution', 'interval', 'networkIds[]', 'serials[]', 'productTypes[]', 'tags[]', 'statuses[]', 'sortOrder'];

const { values } = parseArgs({ options: { only: { type: 'string' }, 'no-queries': { type: 'boolean' } } });
const only = values.only ? new RegExp(values.only) : null;

// Errors the emulator logs while answering 500 are collected, not printed.
const logged = [];
console.error = (...args) => logged.push(args.map((a) => (a instanceof Error ? a.stack.split('\n').slice(0, 3).join(' | ') : String(a))).join(' '));

const emu = createEmulator({ now: NOW, rateLimit: 0 });
const now = Date.parse(NOW) / 1000;
const gets = ROUTES.filter((r) => r.method === 'GET');
const byPath = new Map();
for (const r of ROUTES) byPath.set(r.path, { ...byPath.get(r.path), [r.method]: r });

// Calls the emulator's request handler directly, which is many times faster than a socket.
async function call(method, path, body, json = false) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    method,
    url: path,
    headers: { 'x-cisco-meraki-api-key': 'fuzz', host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status = 0;
  let out = '';
  const res = {
    req,
    headersSent: false,
    setHeader() {},
    writeHead(s) {
      status = s;
      this.headersSent = true;
    },
    end(t) {
      out = t ?? '';
    },
  };
  await emu.handle(req, res);
  if (!json) return status;
  try {
    return { status, body: JSON.parse(out) };
  } catch {
    return { status, body: null };
  }
}

// Strings that pass the usual checks, by field name.
const STRINGS = [[/timeZone/, 'America/Los_Angeles'], [/subnet|cidr/i, '10.200.0.0/24'], [/ip$|Ip$|address/i, '10.200.0.1'], [/mac/i, '00:11:22:33:44:55'], [/email/i, 'fuzz@example.com'], [/url/i, 'https://example.com/fuzz'], [/time$|At$/, '2026-09-30T12:00:00Z']];

// A value of each schema's type, with every property filled in except IDs of
// other things, which would only answer 404.
function full(schema, name = '', depth = 0) {
  if (!schema) return 'x';
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      if (depth > 6) return {};
      const keep = Object.entries(schema.properties ?? {}).filter(([k]) => !/Ids?$/.test(k) || schema.required?.includes(k));
      return Object.fromEntries(keep.map(([k, s]) => [k, full(s, k, depth + 1)]));
    }
    case 'array':
      return depth > 6 ? [] : [full(schema.items, name, depth + 1)];
    case 'integer':
    case 'number':
      return schema.minimum ?? 1;
    case 'boolean':
      return true;
    default:
      return STRINGS.find(([re]) => re.test(name))?.[1] ?? 'x';
  }
}

// The path to every value in a body, objects and lists included.
function paths(v, at = []) {
  if (Array.isArray(v)) return [at, ...v.flatMap((x, i) => paths(x, [...at, i]))];
  if (v && typeof v === 'object') return [at, ...Object.entries(v).flatMap(([k, x]) => paths(x, [...at, k]))];
  return [at];
}

function setAt(body, at, value) {
  if (!at.length) return value;
  const out = structuredClone(body);
  let o = out;
  for (const k of at.slice(0, -1)) o = o[k];
  o[at.at(-1)] = value;
  return out;
}

// A PUT starts from what its GET answers, which it must take back, so a
// broken field is the only thing wrong with each body. Nulls for every field
// go last, so the reads after them see what they left.
async function bodiesFor(route, url) {
  const schema = schemaOf(route.op);
  const out = [undefined, {}, [], null];
  if (!schema) return out;
  let base = schema.properties?._json ? [full(schema.properties._json.items)] : full(schema);
  if (route.method === 'PUT' && byPath.get(route.path)?.GET) {
    const read = await call('GET', url, undefined, true);
    if (read.status === 200 && read.body && typeof read.body === 'object' && !Array.isArray(read.body)) base = read.body;
  }
  out.push(base);
  for (const at of paths(base).slice(1)) for (const j of JUNK) out.push(setAt(base, at, j));
  if (!Array.isArray(base)) out.push(Object.fromEntries(Object.keys(base).map((k) => [k, null])));
  return out;
}

const failures = new Map();
const fail = (op, what) => {
  if (!failures.has(op)) failures.set(op, []);
  if (failures.get(op).length < 3) failures.get(op).push(`${what}${logged.length ? `\n      ${logged.join('\n      ').slice(0, 600)}` : ''}`);
};
const urlOf = (r) => {
  try {
    return '/api/v1' + sampleUrl(r, emu.world, now);
  } catch {
    // A sample that names something an earlier write took away.
    return null;
  }
};

const started = performance.now();
let sent = 0;
for (const route of ROUTES.filter((r) => r.method !== 'GET' && (!only || only.test(r.op)))) {
  await call('POST', '/_emulator/reset');
  const url = urlOf(route);
  if (!url) continue;
  for (const body of await bodiesFor(route, url)) {
    logged.length = 0;
    const status = await call(route.method, url, body);
    sent++;
    if (status >= 500) fail(route.op, `${route.method} ${url} ${JSON.stringify(body)?.slice(0, 200)} -> ${status}`);
  }
  for (const get of gets) {
    const u = urlOf(get);
    if (!u) continue;
    logged.length = 0;
    const status = await call('GET', u);
    sent++;
    if (status >= 500) fail(route.op, `GET ${u} after ${route.op} -> ${status}`);
  }
}

if (!values['no-queries']) {
  await call('POST', '/_emulator/reset');
  for (const get of gets.filter((r) => !only || only.test(r.op))) {
    const url = urlOf(get);
    if (!url) continue;
    for (const name of QUERY_PARAMS) {
      for (const j of QUERY_JUNK) {
        const u = `${url}${url.includes('?') ? '&' : '?'}${name}=${j === '%ZZ' ? j : encodeURIComponent(j)}`;
        logged.length = 0;
        const status = await call('GET', u);
        sent++;
        if (status >= 500) fail(get.op, `GET ${u} -> ${status}`);
      }
    }
  }
}

process.stdout.write(`${sent} requests in ${Math.round((performance.now() - started) / 1000)} s, ${failures.size} operations with 5xx\n`);
for (const [op, list] of failures) process.stdout.write(`${op}\n  ${list.join('\n  ')}\n`);
process.exitCode = failures.size ? 1 : 0;
