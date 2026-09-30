// HTTP front end: routing, API key auth, rate limiting and fault injection.

import { createServer } from 'node:http';
import { ApiLog } from './apilog.js';
import { ApiError } from './http.js';
import { landingPage } from './landing.js';
import admin from './routes/admin.js';
import alerts from './routes/alerts.js';
import appliance from './routes/appliance.js';
import devices from './routes/devices.js';
import networks from './routes/networks.js';
import networkwide from './routes/networkwide.js';
import organizations from './routes/organizations.js';
import switches from './routes/switch.js';
import wireless from './routes/wireless.js';
import { RateLimiter } from './ratelimit.js';
import { parseTime } from './time.js';
import { buildWorld } from './world.js';

export const API_PREFIX = '/api/v1';
export const AUTH_ERROR = 'No valid authentication method found';

export const ROUTES = [...organizations, ...admin, ...alerts, ...networks, ...networkwide, ...appliance, ...switches, ...wireless, ...devices];

function compile(routes) {
  return routes
    .map((r) => {
      const names = [];
      const src = r.path.replace(/\{(\w+)\}/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      });
      return { ...r, names, re: new RegExp(`^${src}/?$`) };
    })
    .sort((a, b) => a.names.length - b.names.length); // literal segments win over {params}
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
    log: o.log ?? null,
  };
}

export function createEmulator(options = {}) {
  const opts = resolveOptions(options);
  const clock = () => opts.now ?? Date.now() / 1000;
  const world = buildWorld({ seed: opts.seed, bootTime: clock() });
  const routes = compile(ROUTES);
  const limiter = opts.rateLimit > 0 ? new RateLimiter(opts.rateLimit, opts.burst) : null;
  const apiLog = new ApiLog();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : text);
    return status;
  }

  function match(path) {
    for (const r of routes) {
      const m = r.re.exec(path);
      if (m) return { route: r, values: m.slice(1) };
    }
    return { route: null, values: [] };
  }

  // The organization a call belongs to, for the apiRequests log.
  function orgOfParams(params) {
    if (params.organizationId) return world.orgById.get(params.organizationId)?.id ?? null;
    if (params.networkId) return world.networkById.get(params.networkId)?.org.id ?? null;
    if (params.serial) return world.deviceBySerial.get(params.serial)?.net.org.id ?? null;
    return null;
  }

  // Authenticated calls are answered, then recorded for the apiRequests endpoints.
  async function api(req, res, url) {
    const key = apiKeyOf(req.headers);
    if (!key || (opts.apiKey && key !== opts.apiKey)) return send(res, 401, { errors: [AUTH_ERROR] });

    const { route, values } = match(url.pathname.slice(API_PREFIX.length) || '/');
    let params = null;
    try {
      params = route ? Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(values[i])])) : {};
    } catch {}
    const status = await dispatch(req, res, url, key, route, params);
    apiLog.add({
      ts: clock(),
      orgId: params ? orgOfParams(params) : null,
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
    });
    return status;
  }

  async function dispatch(req, res, url, key, route, params) {
    const wait = limiter ? limiter.take(key) : 0;
    if (wait > 0) return send(res, 429, { errors: ['Too many requests'] }, { 'Retry-After': String(Math.max(1, Math.ceil(wait))) });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { errors: ['The emulator is read-only. Only GET requests are supported.'] }, { Allow: 'GET, HEAD' });
    }

    if (opts.latency > 0) await sleep(opts.latency * (0.7 + Math.random() * 0.6));
    if (opts.faultRate > 0 && Math.random() < opts.faultRate) {
      const status = [500, 502, 503][Math.floor(Math.random() * 3)];
      return send(res, status, { errors: ['Simulated server error'] });
    }

    if (!route) return send(res, 404, { errors: ['Not found'] });
    if (!params) return send(res, 400, { errors: ['Malformed URL encoding'] });

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const ctx = { world, params, query: url.searchParams, now: clock(), url, origin: `${proto}://${req.headers.host || 'localhost'}`, headers: {}, apiLog };
    try {
      const body = route.handler(ctx);
      return send(res, 200, body, ctx.headers);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { errors: e.errors }, e.headers);
      console.error(e);
      return send(res, 500, { errors: ['Internal server error'] });
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
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, X-Cisco-Meraki-API-Key, Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      status = 204;
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = landingPage(world, ROUTES, { apiKey: !!opts.apiKey, now: clock() });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
      status = 200;
    } else if (url.pathname === '/healthz') {
      status = send(res, 200, { status: 'ok' });
    } else if (url.pathname === API_PREFIX || url.pathname.startsWith(API_PREFIX + '/')) {
      status = await api(req, res, url);
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
  return { server, world, options: opts, handle, apiLog };
}
