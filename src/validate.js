// Request body checks against the spec's schemas (src/schemas.json). Unknown
// fields are dropped rather than rejected, so a client can PUT back an object
// it just read. Numbers and numeric strings are accepted for each other, as the
// real API does.

import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { badRequest } from './http.js';

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
let file;

// Loaded on first use, so scripts/schemas.js can import the routes before the file exists.
function specData() {
  if (!file) {
    try {
      file = JSON.parse(readFileSync(new URL('./schemas.json', import.meta.url), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      file = { schemas: {} };
    }
  }
  return file;
}

export function schemaOf(op) {
  return specData().schemas[op];
}

// Every assurance alert type the spec knows, for alert profiles.
export function isAlertType(type) {
  return (specData().alertTypes ?? []).includes(type);
}

function describe(name, schema) {
  const kind = { string: 'a string', integer: 'an integer', number: 'a number', boolean: 'true or false', array: 'an array', object: 'an object' }[schema.type];
  return `'${name}' must be ${kind}`;
}

function check(value, schema, name) {
  if (!schema || value === null) return value;
  let v = value;
  switch (schema.type) {
    case 'string':
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') throw badRequest(describe(name, schema));
      break;
    case 'integer':
    case 'number':
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v) || (schema.type === 'integer' && !Number.isInteger(v))) throw badRequest(describe(name, schema));
      if (schema.minimum != null && v < schema.minimum) throw badRequest(`'${name}' must be at least ${schema.minimum}`);
      if (schema.maximum != null && v > schema.maximum) throw badRequest(`'${name}' must be at most ${schema.maximum}`);
      break;
    case 'boolean':
      if (v === 'true' || v === 'false') v = v === 'true';
      if (typeof v !== 'boolean') throw badRequest(describe(name, schema));
      break;
    case 'array':
      if (!Array.isArray(v)) throw badRequest(describe(name, schema));
      // A null item is never a valid list entry, and handlers don't expect one.
      return v.map((item, i) => {
        if (item == null && schema.items?.type) throw badRequest(describe(`${name}[${i}]`, schema.items));
        return check(item, schema.items, `${name}[${i}]`);
      });
    case 'object':
      if (typeof v !== 'object' || Array.isArray(v)) throw badRequest(describe(name, schema));
      return object(v, schema, name);
    default:
      return v;
  }
  if (schema.enum && !schema.enum.includes(v)) {
    // Case doesn't matter (GET shows the default firewall rule's protocol as "Any"); the spec's spelling is kept.
    const match = typeof v === 'string' ? schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === v.toLowerCase()) : undefined;
    if (match === undefined) throw badRequest(`'${name}' must be one of: ${schema.enum.join(', ')}`);
    return match;
  }
  return v;
}

function object(value, schema, prefix) {
  const out = {};
  const props = schema.properties;
  for (const req of schema.required || []) {
    // A null scalar can mean "clear it" (a floor plan ID); a null list or object can't.
    const t = props?.[req]?.type;
    if (value[req] === undefined || (value[req] === null && (t === 'object' || t === 'array'))) throw badRequest(`'${prefix ? `${prefix}.${req}` : req}' is required`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE.has(k) || v === undefined) continue;
    const name = prefix ? `${prefix}.${k}` : k;
    if (props && Object.hasOwn(props, k)) out[k] = check(v, props[k], name);
    else if (!props || schema.additionalProperties) out[k] = check(v, typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null, name);
  }
  return out;
}

// Validates a parsed body for an operation. Operations without a body schema take nothing.
export function validateBody(op, body) {
  const schema = schemaOf(op);
  if (!schema) return {};
  // A bare array is the same as the spec's _json wrapper, which is what the Python SDK sends.
  if (Array.isArray(body) && schema.properties?._json) body = { _json: body };
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw badRequest('The request body must be a JSON object');
  return object(body, schema, '');
}

// Deep merge for partial updates: objects merge, everything else replaces.
// A null doesn't wipe a settings object that other routes read.
export function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE.has(k)) continue;
    const cur = target[k];
    if (v === null && cur && typeof cur === 'object' && !Array.isArray(cur)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) merge(cur, v);
    else target[k] = structuredClone(v);
  }
  return target;
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Checks an IPv4 CIDR like 10.0.0.0/24 and returns [network, prefix bits], or null.
export function parseCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr));
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) return null;
  return [m.slice(1, 5).reduce((v, o) => v * 256 + Number(o), 0), Number(m[5])];
}

export function parseIp(ip) {
  const c = parseCidr(`${ip}/32`);
  return c ? c[0] : null;
}

export const isIpv6 = (v) => isIP(String(v)) === 6;

export const isAddress = (v) => parseIp(v) != null || parseCidr(v) != null;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
export const isHostname = (v) => HOSTNAME.test(v);

const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
export const isMac = (v) => MAC.test(v);

// A port from 1 to 65535, or a range like 1-1024 when ranges are allowed.
export function isPort(v, ranges = false) {
  const m = (ranges ? /^(\d{1,5})(?:-(\d{1,5}))?$/ : /^(\d{1,5})$/).exec(v);
  return !!m && [m[1], m[2] ?? m[1]].every((p) => p >= 1 && p <= 65535);
}

export function inRange(v, min, max, name) {
  if (v != null && !(Number.isInteger(v) && v >= min && v <= max)) throw badRequest(`'${name}' must be an integer between ${min} and ${max}`);
}

export function ipInCidr(ip, cidr) {
  const n = parseIp(ip);
  const c = parseCidr(cidr);
  if (n == null || !c) return false;
  const size = 2 ** (32 - c[1]);
  return Math.floor(n / size) === Math.floor(c[0] / size);
}
