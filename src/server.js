// HTTP front end: routing, API key auth, rate limiting, fault injection and
// the bookkeeping around writes.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { ApiKeys } from './apikeys.js';
import { ApiLog } from './apilog.js';
import { ApiError, badRequest } from './http.js';
import { landingPage } from './landing.js';
import airMarshal from './routes/airmarshal.js';
import actionBatches, { settleBatches, storeOf } from './routes/actionbatches.js';
import adaptivePolicy from './routes/adaptivepolicy.js';
import admin from './routes/admin.js';
import alerts from './routes/alerts.js';
import camera from './routes/camera.js';
import cameraAnalytics from './routes/cameraanalytics.js';
import cameraRoles from './routes/cameraroles.js';
import captures from './routes/captures.js';
import cellular from './routes/cellular.js';
import appliance from './routes/appliance.js';
import shaping from './routes/shaping.js';
import firewall from './routes/firewall.js';
import vpn from './routes/vpn.js';
import clients from './routes/clients.js';
import devices from './routes/devices.js';
import firmware from './routes/firmware.js';
import floorplans from './routes/floorplans.js';
import identities from './routes/identities.js';
import licenses from './routes/licenses.js';
import livetools from './routes/livetools.js';
import networks from './routes/networks.js';
import orgnetworks from './routes/orgnetworks.js';
import networkwide from './routes/networkwide.js';
import organizations from './routes/organizations.js';
import orgwireless from './routes/orgwireless.js';
import orgSecurity from './routes/orgsecurity.js';
import globalFirewall from './routes/globalfirewall.js';
import globalGroups from './routes/globalgroups.js';
import policyObjects from './routes/policyobjects.js';
import provisioning from './routes/provisioning.js';
import ssids from './routes/ssids.js';
import ssidProfiles from './routes/ssidprofiles.js';
import summaries from './routes/summaries.js';
import routing from './routes/routing.js';
import switchPolicies from './routes/switchpolicies.js';
import switchSettings from './routes/switchsettings.js';
import switchDhcp from './routes/switchdhcp.js';
import stacks from './routes/stacks.js';
import switches from './routes/switch.js';
import switchports from './routes/switchports.js';
import templates from './routes/templates.js';
import wireless from './routes/wireless.js';
import wirelessDevices from './routes/wirelessdevices.js';
import wirelessRadio from './routes/wirelessradio.js';
import wirelessLocation from './routes/wirelesslocation.js';
import wirelessstats from './routes/wirelessstats.js';
import webhooks, { testsOf } from './routes/webhooks.js';
import { RateLimiter } from './ratelimit.js';
import { recordChange } from './sim/changes.js';
import { parseTime } from './time.js';
import { validateBody } from './validate.js';
import { callbacksOf, logsOf } from './webhooks.js';
import { buildWorld, copyWorld } from './world.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const API_PREFIX = '/api/v1';
export const AUTH_ERROR = 'No valid authentication method found';
export const RESET_PATH = '/_emulator/reset';
const MAX_BODY = 1024 * 1024;

// The Meraki Python SDK only follows Link URLs on meraki.com hosts and glues
// any other one onto its base URL. Both hints point at the README's setup.
const GLUED_URL = new RegExp(`^${API_PREFIX}https?://`, 'i');
export const SDK_HINT = 'This path has a full URL appended to the base URL. The Meraki Python SDK sends that when paging from a host outside meraki.com: use base_url="http://emulator.meraki.com/api/v1" with requests_proxy set to the emulator (see the README)';
export const CONNECT_HINT = 'The emulator speaks plain HTTP, use an http:// base URL';

export const ROUTES = [...organizations, ...summaries, ...orgnetworks, ...admin, ...orgSecurity, ...licenses, ...templates, ...policyObjects, ...globalFirewall, ...globalGroups, ...adaptivePolicy, ...alerts, ...networks, ...provisioning, ...captures, ...cellular, ...clients, ...networkwide, ...firmware, ...floorplans, ...appliance, ...firewall, ...vpn, ...shaping, ...switches, ...switchports, ...stacks, ...routing, ...switchPolicies, ...switchSettings, ...switchDhcp, ...wireless, ...wirelessstats, ...orgwireless, ...wirelessRadio, ...wirelessLocation, ...airMarshal, ...ssids, ...ssidProfiles, ...wirelessDevices, ...devices, ...camera, ...cameraRoles, ...cameraAnalytics, ...livetools, ...webhooks, ...actionBatches, ...identities].map((r) => ({ method: 'GET', ...r }));

// Network settings that come from the config template a network is bound to.
// Warm spare names the network's own MXes, so it stays local, as do switch
// link aggregations, the switch and wireless alternate management interfaces,
// AP port profiles (their assignments name APs) and multicast rendezvous points.
const TEMPLATED = /^\/networks\/\{networkId\}\/(appliance(?!\/warmSpare)|wireless(?!\/alternateManagementInterface|\/ethernet)|switch\/(?:settings|accessControlLists|accessPolicies|qosRules|dscpToCosMappings|routing\/(?:ospf|multicast(?!\/rendezvousPoints))|stp|mtu|stormControl|dhcpServerPolicy|portSchedules)|groupPolicies|syslogServers|devices\/syslog|snmp|alerts|webhooks\/(?:httpServers|payloadTemplates)|settings)\b/;

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

// Action batch operations other than these are a POST to `resource/operation`.
const BATCH_METHODS = { create: 'POST', update: 'PUT', destroy: 'DELETE' };
// Records of things that already happened, kept when a failed batch puts back
// the world from before it: [property, the accessor that makes it]. Each is made
// on the failed world first, so a delivery still running there writes to the shared record.
const CARRIED = {
  org: [['actionBatches', storeOf], ['webhookLogs', logsOf], ['webhookCallbacks', callbacksOf], ['webhookIds']],
  net: [['webhookTests', testsOf]],
};

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
    webhooks: o.webhooks === true || o.webhooks === 'true' || o.webhooks === '1',
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
  // Live tools and reboot also have per-device limits, one bucket per operation and device.
  const deviceLimiters = new Map();
  const deviceWait = (route, serial) => {
    if (!limiter || !route.perDevice || !serial) return 0;
    const [seconds, burst] = route.perDevice;
    if (!deviceLimiters.has(route.op)) deviceLimiters.set(route.op, new RateLimiter(1 / seconds, burst));
    return deviceLimiters.get(route.op).take(serial);
  };
  const apiLog = new ApiLog();
  const keys = new ApiKeys();
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
  function scopeOf(params, w = world) {
    if (params.organizationId) return { org: w.orgById.get(params.organizationId) ?? null, net: null };
    const net = params.networkId ? w.networkById.get(params.networkId) : params.serial ? w.deviceBySerial.get(params.serial)?.net : null;
    return { org: net?.org ?? null, net: net ?? null };
  }

  function authorized(req) {
    const key = apiKeyOf(req.headers);
    if (!key || keys.isRevoked(key)) return null;
    return !opts.apiKey || key === opts.apiKey || keys.isGenerated(key) ? key : null;
  }

  // Authenticated calls are answered, then recorded for the apiRequests endpoints.
  async function api(req, res, url) {
    const key = authorized(req);
    if (!key) return send(res, 401, { errors: [AUTH_ERROR] });
    keys.seen(key, clock());

    const { entry, values } = match(url.pathname.slice(API_PREFIX.length) || '/');
    let params = null;
    try {
      params = entry ? Object.fromEntries(entry.names.map((n, i) => [n, decodeURIComponent(values[i])])) : {};
    } catch {}
    const route = entry?.methods[req.method === 'HEAD' ? 'GET' : req.method] ?? null;
    const scope = params ? scopeOf(params) : { org: null, net: null };
    const status = await dispatch(req, res, url, key, entry, route, params);
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

  async function dispatch(req, res, url, key, entry, route, params) {
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
    const deviceBusy = deviceWait(route, params.serial);
    if (deviceBusy > 0) return send(res, 429, { errors: ['Too many requests for this device'] }, { 'Retry-After': String(Math.max(1, Math.ceil(deviceBusy))) });

    const proto = req.headers['x-forwarded-proto'] || 'http';
    try {
      const given = write ? await parseBody(req) : null;
      const now = clock();
      settle(now);
      const ctx = { ...baseCtx(now), params, query: url.searchParams, url, origin: `${proto}://${req.headers.host || 'localhost'}` };
      if (write) ctx.body = validateBody(route.op, given);
      const body = execute(route, entry, ctx);
      const status = route.status ?? (req.method === 'POST' ? 201 : req.method === 'DELETE' ? 204 : 200);
      return send(res, status, body, ctx.headers);
    } catch (e) {
      if (e instanceof ApiError) return send(res, e.status, { errors: e.errors }, e.headers);
      console.error(e);
      return send(res, 500, { errors: ['Internal server error'] });
    }
  }

  function baseCtx(now) {
    return { world, now, clock, frozen: opts.now != null, webhooks: opts.webhooks, log: opts.log, headers: {}, apiLog, keys, body: null, actions: { check: resolveActions, run: runActions }, settle: (at = 0) => settle(Math.max(clock(), at)) };
  }

  // Runs a handler with the checks every call gets. Writes go in the change
  // log, and updates and deletes log what the resource looked like before.
  function execute(route, entry, ctx) {
    const write = route.method !== 'GET';
    if (write && TEMPLATED.test(route.path) && ctx.world.networkById.get(ctx.params.networkId)?.template) {
      throw badRequest('This network is bound to a config template, so its settings can only be changed on the template');
    }
    const logged = write && route.logged !== false;
    const scope = logged ? scopeOf(ctx.params, ctx.world) : null;
    const get = logged && route.method !== 'POST' ? entry.methods.GET : null;
    const before = get ? snapshot(get, ctx) : null;
    const body = route.handler(ctx);
    if (logged) recordChange(scope, { t: ctx.now, admin: ctx.world.apiAdmin, label: `${route.method} ${ctx.url.pathname}`, before, after: route.method === 'DELETE' ? null : body, ssidNumber: ctx.params.number });
    return body;
  }

  // A copy of the world taken before a batch runs, with each organization and
  // network paired with its copy, since the batch may delete some of them.
  function saveWorld() {
    const { world: copy, copyOf } = copyWorld(world);
    return { copy, held: [...world.orgs.map((o) => ['org', o, copyOf(o)]), ...world.networks.map((n) => ['net', n, copyOf(n)])] };
  }

  // Puts back the world from before a failed batch, keeping what already happened.
  function restore({ copy, held }) {
    for (const [kind, was, x] of held) {
      for (const [k, make] of CARRIED[kind]) {
        make?.(was);
        if (k in was) x[k] = was[k];
      }
    }
    world = copy;
  }

  // Checks a batch's actions against the routes before any of them runs and
  // throws a 400 listing every bad one.
  function resolveActions(org, actions) {
    const errors = [];
    const list = actions.map((a, i) => {
      const fail = (why) => errors.push(`Action ${i + 1}: ${why}`) && null;
      const method = BATCH_METHODS[a.operation] ?? 'POST';
      if (typeof a.resource !== 'string') return fail("'resource' is required");
      let path = a.resource.startsWith(API_PREFIX + '/') ? a.resource.slice(API_PREFIX.length) : a.resource;
      path = path.replace(/\/+$/, '');
      if (!path.startsWith('/') || /[?#]/.test(path)) return fail(`'${a.resource}' is not a resource path`);
      if (!BATCH_METHODS[a.operation]) {
        if (!/^[A-Za-z]+$/.test(a.operation)) return fail(`'${a.operation}' is not an operation`);
        path += `/${a.operation}`;
      }
      const { entry, values } = match(path);
      const route = entry?.methods[method];
      if (!route || route.logged === false || route.batch === false || route.perDevice) return fail(`'${a.operation}' is not supported on ${a.resource}`);
      let params;
      try {
        params = Object.fromEntries(entry.names.map((n, j) => [n, decodeURIComponent(values[j])]));
      } catch {
        return fail(`'${a.resource}' has malformed URL encoding`);
      }
      const scope = scopeOf(params);
      if ((params.organizationId != null && params.organizationId !== org.id) || (scope.org && scope.org !== org)) return fail(`${a.resource} is not in this organization`);
      try {
        validateBody(route.op, a.body ?? {});
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        return fail(e.errors.join(', '));
      }
      return { ...a, method, path, route, entry, params };
    });
    if (errors.length) throw new ApiError(400, errors);
    return list;
  }

  // Runs a batch's actions in order. The first failure puts the world back as
  // it was before the batch, so a batch applies all of its actions or none.
  function runActions(ctx, org, actions) {
    let list;
    try {
      list = resolveActions(org, actions);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return { error: e.errors.join(' ') };
    }
    const saved = saveWorld();
    const done = [];
    for (const [i, a] of list.entries()) {
      const actx = { ...ctx, params: a.params, query: new URLSearchParams(), url: new URL(API_PREFIX + a.path, ctx.origin), headers: {}, body: null };
      try {
        actx.body = validateBody(a.route.op, a.body ?? {});
        done.push(execute(a.route, a.entry, actx));
      } catch (err) {
        if (!(err instanceof ApiError)) console.error(err);
        restore(saved);
        ctx.world = world;
        return { error: `Action ${i + 1} (${a.operation} ${a.resource}) failed: ${err instanceof ApiError ? err.errors.join(', ') : 'Internal server error'}` };
      }
    }
    return { results: done.map((body, i) => ({ body, params: list[i].params })) };
  }

  // Runs confirmed asynchronous batches whose time has come.
  function settle(now) {
    settleBatches({ ...baseCtx(now) });
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
      const html = landingPage(world, ROUTES, { apiKey: !!opts.apiKey, readOnly: opts.readOnly, now: clock(), version: VERSION });
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
