// HTTP front end: routing, API key auth, rate limiting, fault injection and
// the bookkeeping around writes.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiLog } from './apilog.js';
import { ApiError } from './http.js';
import { landingPage } from './landing.js';
import admin from './routes/admin.js';
import alerts from './routes/alerts.js';
import appliance from './routes/appliance.js';
import clients from './routes/clients.js';
import devices from './routes/devices.js';
import firmware from './routes/firmware.js';
import floorplans from './routes/floorplans.js';
import licenses from './routes/licenses.js';
import networks from './routes/networks.js';
import orgnetworks from './routes/orgnetworks.js';
import networkwide from './routes/networkwide.js';
import organizations from './routes/organizations.js';
import provisioning from './routes/provisioning.js';
import ssids from './routes/ssids.js';
import stacks from './routes/stacks.js';
import switches from './routes/switch.js';
import templates from './routes/templates.js';
import wireless from './routes/wireless.js';
import { RateLimiter } from './ratelimit.js';
import { recordChange } from './sim/changes.js';
import { parseTime } from './time.js';
import { validateBody } from './validate.js';
import { buildWorld } from './world.js';

export const API_PREFIX = '/api/v1';
export const AUTH_ERROR = 'No valid authentication method found';
export const RESET_PATH = '/_emulator/reset';
const MAX_BODY = 1024 * 1024;

// The Meraki Python SDK only follows Link URLs on meraki.com hosts and glues
// any other one onto its base URL. Both hints point at the README's setup.
const GLUED_URL = new RegExp(`^${API_PREFIX}https?://`, 'i');
export const SDK_HINT = 'This path has a full URL appended to the base URL. The Meraki Python SDK sends that when paging from a host outside meraki.com: use base_url="http://emulator.meraki.com/api/v1" with requests_proxy set to the emulator (see the README)';
export const CONNECT_HINT = 'The emulator speaks plain HTTP, use an http:// base URL';

export const ROUTES = [...organizations, ...orgnetworks, ...admin, ...licenses, ...templates, ...alerts, ...networks, ...provisioning, ...clients, ...networkwide, ...firmware, ...floorplans, ...appliance, ...switches, ...stacks, ...wireless, ...ssids, ...devices].map((r) => ({ method: 'GET', ...r }));

// One entry per path template, holding a route per method.
function compile(routes) {
  const byPath = new Map();
  for (const r of routes) {
    if (!byPath.has(r.path)) {
      const names = [];
      const src = r.path.replace(/\{(\w+)\}/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      });
      byPath.set(r.path, { path: r.path, names, re: new RegExp(`^${src}/?$`), methods: {} });
    }
    byPath.get(r.path).methods[r.method] = r;
  }
  return [...byPath.values()].sort((a, b) => a.names.length - b.names.length); // literal segments win over {params}
}

// The key from X-Cisco-Meraki-API-Key or "Authorization: Bearer <key>". The
// regex classes don't overlap, so it stays linear on hostile headers.
export function apiKeyOf(headers) {
  const key = headers['x-cisco-meraki-api-key'];
  if (key) return String(key).trim();
  const m = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization || '').trim());
  return m ? m[1] : null;
}

export function resolveOptions(o = {}) {
  const num = (v, def, name, min = 0) => {
    if (v == null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new Error(`${name} must be a number >= ${min}`);
    return n;
  };
  const frozen = o.now != null && o.now !== '' ? parseTime(String(o.now)) : null;
  if (Number.isNaN(frozen)) throw new Error('now must be an ISO 8601 timestamp or epoch seconds');
  const faultRate = num(o.faultRate, 0, 'fault-rate');
  if (faultRate > 1) throw new Error('fault-rate must be between 0 and 1');
  return {
    seed: o.seed != null && o.seed !== '' ? String(o.seed) : '1',
    apiKey: o.apiKey || null,
    latency: num(o.latency, 0, 'latency'),
    faultRate,
    now: frozen,
    rateLimit: num(o.rateLimit, 10, 'rate-limit'),
    burst: num(o.burst, 20, 'burst', 1),
    readOnly: o.readOnly === true || o.readOnly === 'true' || o.readOnly === '1',
    log: o.log ?? null,
  };
}

// Collects a request body, refusing more than MAX_BODY bytes.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(new ApiError(413, ['The request body is larger than 1 MB'])) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, ['The request body is not valid JSON']);
  }
}

export function createEmulator(options = {}) {
  const opts = resolveOptions(options);
  const clock = () => opts.now ?? Date.now() / 1000;
  const bootTime = clock();
  let world = buildWorld({ seed: opts.seed, bootTime });
  const routes = compile(ROUTES);
  const limiter = opts.rateLimit > 0 ? new RateLimiter(opts.rateLimit, opts.burst) : null;
  const apiLog = new ApiLog();
  // The request log names each key by a random ID for this run, never the key itself.
  const clientIds = new Map();
  const clientIdOf = (key) => {
    if (!clientIds.has(key)) {
      if (clientIds.size >= 10000) clientIds.clear();
      clientIds.set(key, randomBytes(32).toString('base64url'));
    }
    return clientIds.get(key);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(res, status, body, headers = {}) {
    const text = body === undefined || status === 204 ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : text);
    return status;
  }

  function match(path) {
    for (const entry of routes) {
      const m = entry.re.exec(path);
      if (m) return { entry, values: m.slice(1) };
    }
    return { entry: null, values: [] };
  }

  // The organization and network a call belongs to, for the logs.
  function scopeOf(params) {
    if (params.organizationId) return { org: world.orgById.get(params.organizationId) ?? null, net: null };
    const net = params.networkId ? world.networkById.get(params.networkId) : params.serial ? world.deviceBySerial.get(params.serial)?.net : null;
    return { org: net?.org ?? null, net: net ?? null };
  }

  function authorized(req) {
    const key = apiKeyOf(req.headers);
    return key && (!opts.apiKey || key === opts.apiKey) ? key : null;
  }

  // Authenticated calls are answered, then recorded for the apiRequests endpoints.
  async function api(req, res, url) {
    const key = authorized(req);
    if (!key) return send(res, 401, { errors: [AUTH_ERROR] });

    const { entry, values } = match(url.pathname.slice(API_PREFIX.length) || '/');
    let params = null;
    try {
      params = entry ? Object.fromEntries(entry.names.map((n, i) => [n, decodeURIComponent(values[i])])) : {};
    } catch {}
    const route = entry?.methods[req.method === 'HEAD' ? 'GET' : req.method] ?? null;
    const scope = params ? scopeOf(params) : { org: null, net: null };
    const status = await dispatch(req, res, url, key, entry, route, params, scope);
    apiLog.add({
      ts: clock(),
      orgId: scope.org?.id ?? null,
      adminId: world.apiAdmin.id,
      method: req.method,
      host: req.headers.host || 'localhost',
      path: url.pathname,
      queryString: url.search.slice(1),
      userAgent: req.headers['user-agent'] || '',
      responseCode: status,
      sourceIp: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      version: 1,
      operationId: route ? route.op : null,
      clientId: clientIdOf(key),
    });
    return status;
  }

  async function dispatch(req, res, url, key, entry, route, params, scope) {
    const wait = limiter ? limiter.take(key) : 0;
    if (wait > 0) return send(res, 429, { errors: ['Too many requests'] }, { 'Retry-After': String(Math.max(1, Math.ceil(wait))) });

    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && opts.readOnly) return send(res, 405, { errors: ['The emulator is running read-only. Only GET requests are supported.'] }, { Allow: 'GET, HEAD' });

    if (opts.latency > 0) await sleep(opts.latency * (0.7 + Math.random() * 0.6));
    if (opts.faultRate > 0 && Math.random() < opts.faultRate) {
      const status = [500, 502, 503][Math.floor(Math.random() * 3)];
      return send(res, status, { errors: ['Simulated server error'] });
    }

    if (!entry) return send(res, 404, { errors: ['Not found'] });
    if (!route) {
      const allowed = Object.keys(entry.methods);
      if (allowed.includes('GET')) allowed.push('HEAD');
      return send(res, 405, { errors: [`${req.method} is not supported on this path`] }, { Allow: allowed.join(', ') });
    }
    if (!params) return send(res, 400, { errors: ['Malformed URL encoding'] });

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const ctx = { world, params, query: url.searchParams, now: clock(), url, origin: `${proto}://${req.headers.host || 'localhost'}`, headers: {}, apiLog, body: null };
    try {
      if (write) ctx.body = validateBody(route.op, await parseBody(req));
      // Updates and deletes log what the resource looked like before.
      const get = write && req.method !== 'POST' ? entry.methods.GET : null;
      const before = get ? snapshot(get, ctx) : null;
      const body = route.handler(ctx);
      const status = route.status ?? (req.method === 'POST' ? 201 : req.method === 'DELETE' ? 204 : 200);
      if (write) recordChange(scope, { t: ctx.now, admin: world.apiAdmin, label: `${req.method} ${url.pathname}`, before, after: req.method === 'DELETE' ? null : body, ssidNumber: params.number });
      return send(res, status, body, ctx.headers);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { errors: e.errors }, e.headers);
      console.error(e);
      return send(res, 500, { errors: ['Internal server error'] });
    }
  }

  function snapshot(get, ctx) {
    try {
      return structuredClone(get.handler({ ...ctx, query: new URLSearchParams(), headers: {} }));
    } catch {
      return null;
    }
  }

  async function handle(req, res) {
    const started = performance.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Link, Retry-After');
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      // Paths like "//[" parse as a broken host.
      const status = send(res, 400, { errors: ['Malformed URL'] });
      opts.log?.(`${req.method} ${req.url} ${status} ${Math.round(performance.now() - started)}ms`);
      return;
    }
    let status;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, X-Cisco-Meraki-API-Key, Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      status = 204;
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = landingPage(world, ROUTES, { apiKey: !!opts.apiKey, readOnly: opts.readOnly, now: clock() });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
      status = 200;
    } else if (url.pathname === '/healthz') {
      status = send(res, 200, { status: 'ok' });
    } else if (url.pathname === RESET_PATH) {
      // Throws away every write and starts again from the seed. The request log stays.
      if (!authorized(req)) status = send(res, 401, { errors: [AUTH_ERROR] });
      else if (req.method !== 'POST') status = send(res, 405, { errors: ['Use POST to reset the emulator'] }, { Allow: 'POST' });
      else {
        world = buildWorld({ seed: opts.seed, bootTime });
        status = send(res, 204);
      }
    } else if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + '/')) {
      status = await api(req, res, url);
    } else if (GLUED_URL.test(url.pathname)) {
      status = send(res, 404, { errors: [SDK_HINT] });
    } else {
      status = send(res, 404, { errors: ['Not found'] });
    }
    opts.log?.(`${req.method} ${url.pathname}${url.search} ${status} ${Math.round(performance.now() - started)}ms`);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { errors: ['Internal server error'] });
    });
  });
  // An https:// base URL through the emulator as a proxy arrives as CONNECT.
  // httpx puts the reason phrase in its error message.
  server.on('connect', (req, socket) => {
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 501 ${CONNECT_HINT}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    opts.log?.(`CONNECT ${req.url} 501`);
  });
  return {
    server,
    get world() {
      return world;
    },
    options: opts,
    handle,
    apiLog,
  };
}
