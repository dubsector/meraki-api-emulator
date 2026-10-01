// Per-client usage and application history, plus the client policy, splash
// authorization and provisioning writes.

import { APPS } from '../catalog.js';
import { GUEST_POLICY_ID, configOf, stored } from '../config.js';
import { arrayParam, badRequest, intParam, notFound, paginate, timeWindow } from '../http.js';
import { derive, hashStr, unit } from '../rng.js';
import { START, presenceIn, sessions } from '../sim/presence.js';
import { clientApps } from '../sim/traffic.js';
import { clientUsage } from '../sim/usage.js';
import { DAY, iso, isoMicro } from '../time.js';
import { findClient, netOf } from './common.js';

const HISTORY_DAYS = 30;
const CLICK_THROUGH = 'Click-through splash page';
const POLICIES = ['Whitelisted', 'Allowed', 'Blocked', 'Normal', 'Group policy'];
// Provisioning takes other names for two of the policies a GET reports.
const SHOWN_AS = { Allowed: 'Whitelisted', 'Per connection': 'Different policies by SSID' };
const BLOCKED_MESSAGE = 'This device has been blocked by the network administrator.';
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const MINUTES = { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 };

function clientOf(ctx) {
  const c = findClient(netOf(ctx), ctx.params.clientId);
  if (!c) throw notFound('Client');
  return c;
}

// The local days overlapping [a, b), each clipped to it.
function localDays(net, a, b) {
  const out = [];
  for (let d = net.zone.day(a); ; d++) {
    const start = net.zone.midnight(d);
    if (start >= b) break;
    out.push({ day: d, start, lo: Math.max(start, a), hi: Math.min(net.zone.midnight(d + 1), b) });
  }
  return out;
}

function historyStart(net, now) {
  return net.zone.midnight(net.zone.day(now) - HISTORY_DAYS + 1);
}

// KB per local day in [a, b), leaving out days without traffic.
function dailyUsage(c, a, b) {
  const rows = [];
  for (const { start, lo, hi } of localDays(c.net, a, b)) {
    const u = clientUsage(c, lo, hi);
    const sent = Math.round(u.sent);
    const received = Math.round(u.recv);
    if (sent + received > 0) rows.push({ received, sent, ts: isoMicro(start) });
  }
  return rows;
}

// The clients named in ?clients=, keeping only those on ?ssidNumber= when given.
function clientsParam(ctx, net) {
  const ids = arrayParam(ctx.query, 'clients');
  if (!ids.length) throw badRequest("'clients' is required");
  const ssid = intParam(ctx.query, 'ssidNumber', null, { min: 0, max: 14 });
  const out = [];
  for (const id of ids) {
    const c = findClient(net, id);
    if (!c) throw notFound('Client');
    if (!out.includes(c) && (ssid == null || c.ssid?.number === ssid)) out.push(c);
  }
  return out;
}

function clientsWindow(ctx) {
  return timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
}

const idsOf = (c) => ({ clientId: c.id, clientIp: c.ip, clientMac: c.mac });

// ── Policies ──

// Set through the API, by MAC. Provisioned MACs may never have connected.
const policies = (net) => stored(net, 'clientPolicies', () => ({}));
const provisioned = (net) => stored(net, 'provisionedClients', () => ({}));

function policyTarget(ctx) {
  const net = netOf(ctx);
  const id = ctx.params.clientId;
  const c = findClient(net, id);
  if (c) return { net, mac: c.mac, client: c };
  const lower = id.toLowerCase();
  const p = Object.values(provisioned(net)).find((x) => x.clientId === id || x.mac === lower);
  if (!p) throw notFound('Client');
  return { net, mac: p.mac, client: null };
}

// Guest Wi-Fi clients get the Guest group policy until another is set.
function defaultPolicy(net, c) {
  const guest = c?.ssid?.key === 'guest' && configOf(net).groupPolicies.some((g) => g.groupPolicyId === GUEST_POLICY_ID);
  return guest ? { devicePolicy: 'Group policy', groupPolicyId: GUEST_POLICY_ID } : { devicePolicy: 'Normal' };
}

function policyJson(t) {
  return { mac: t.mac, ...structuredClone(policies(t.net)[t.mac] ?? defaultPolicy(t.net, t.client)) };
}

function groupPolicyOf(net, policy, id, at = 'groupPolicyId') {
  if (policy !== 'Group policy') return {};
  if (id == null || id === '') throw badRequest(`'${at}' is required when the policy is 'Group policy'`);
  if (!configOf(net).groupPolicies.some((g) => g.groupPolicyId === String(id))) throw badRequest(`Group policy '${id}' does not exist in this network`);
  return { groupPolicyId: String(id) };
}

// A client key for a MAC the network hasn't seen, stable for the network and MAC.
function newClientId(world, net, mac) {
  const taken = new Set(Object.values(provisioned(net)).map((p) => p.clientId));
  for (let i = 0; ; i++) {
    const id = 'k' + (derive(hashStr(net.id + mac), i) & 0xffffff).toString(16).padStart(6, '0');
    if (!world.clientById.has(id) && !taken.has(id)) return id;
  }
}

function provision(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  if (!b.clients.length) throw badRequest("'clients' must not be empty");
  const list = b.clients.map((x, i) => {
    const mac = String(x.mac ?? '').toLowerCase();
    if (!MAC.test(mac)) throw badRequest(`'clients[${i}].mac' must be a MAC address like 00:11:22:33:44:55`);
    return { mac, name: x.name };
  });
  const policy = { devicePolicy: SHOWN_AS[b.devicePolicy] ?? b.devicePolicy, ...groupPolicyOf(net, b.devicePolicy, b.groupPolicyId) };
  if (b.devicePolicy === 'Per connection') {
    const bySsid = Object.entries(b.policiesBySsid ?? {});
    if (!bySsid.length) throw badRequest("'policiesBySsid' is required when devicePolicy is 'Per connection'");
    policy.policiesBySsid = bySsid.map(([n, p]) => {
      if (!p?.devicePolicy) throw badRequest(`'policiesBySsid.${n}.devicePolicy' is required`);
      return { ssidNumber: Number(n), devicePolicy: p.devicePolicy, ...groupPolicyOf(net, p.devicePolicy, p.groupPolicyId, `policiesBySsid.${n}.groupPolicyId`) };
    });
  }
  const prov = provisioned(net);
  const rows = list.map(({ mac, name }) => {
    const c = net.clients.find((x) => x.mac === mac);
    const rec = (prov[mac] ??= { mac, clientId: c?.id ?? newClientId(ctx.world, net, mac) });
    if (name != null) rec.name = name;
    policies(net)[mac] = structuredClone(policy);
    const row = { mac, clientId: rec.clientId, name: rec.name ?? c?.description ?? null };
    if (b.devicePolicy === 'Blocked') row.message = BLOCKED_MESSAGE;
    return row;
  });
  return { clients: rows, devicePolicy: b.devicePolicy, ...(policy.groupPolicyId ? { groupPolicyId: policy.groupPolicyId } : {}) };
}

// ── Splash authorization ──

const splashAuth = (net) => stored(net, 'splashAuthorizations', () => ({}));

function timeoutSeconds(timeout) {
  const m = /^(\d+)\s*(minute|hour|day|week|month)/i.exec(String(timeout ?? ''));
  return (m ? Number(m[1]) * MINUTES[m[2].toLowerCase()] : 1440) * 60;
}

// The splash_auth event of the client's latest session, the same instant the event log shows.
function lastSplash(c, now) {
  const today = c.net.zone.day(now);
  for (let d = today; d > today - 31; d--) {
    let last = null;
    for (const [s, , flags] of sessions(c, d)) {
      const t = s + 0.6 + unit(c.key, Math.floor(s) + 4);
      if (flags & START && t <= now) last = Math.max(last ?? t, t);
    }
    if (last != null) return last;
  }
  return null;
}

// Only enabled click-through SSIDs the client joined, or was authorized on through the API.
function splashJson(net, c, now) {
  const cfg = configOf(net).ssids;
  const set = splashAuth(net)[c.id] ?? {};
  const numbers = new Set(Object.keys(set).map(Number));
  if (c.ssid) numbers.add(c.ssid.number);
  const ssids = {};
  for (const n of [...numbers].sort((x, y) => x - y)) {
    const s = cfg[n];
    if (!s.enabled || s.splashPage !== CLICK_THROUGH) continue;
    const signedOn = c.ssid?.number === n ? lastSplash(c, now) : null;
    // Whichever happened last wins: a sign-on after an API change authorizes again.
    const o = set[n];
    const at = o && (signedOn == null || o.at >= signedOn) ? (o.authorized ? o.at : null) : signedOn;
    const expires = at == null ? null : at + timeoutSeconds(s.splashTimeout);
    ssids[n] = expires > now ? { isAuthorized: true, authorizedAt: iso(at), expiresAt: iso(expires) } : { isAuthorized: false, authorizedAt: null, expiresAt: null };
  }
  return { ssids };
}

function updateSplash(ctx) {
  const net = netOf(ctx);
  const c = clientOf(ctx);
  const cfg = configOf(net).ssids;
  const entries = Object.entries(ctx.body.ssids).filter(([, v]) => v?.isAuthorized != null);
  for (const [n] of entries) {
    if (!cfg[n].enabled || cfg[n].splashPage !== CLICK_THROUGH) throw badRequest(`SSID ${n} must be enabled and use a click-through splash page`);
  }
  const set = (splashAuth(net)[c.id] ??= {});
  for (const [n, v] of entries) set[n] = { at: ctx.now, authorized: v.isAuthorized };
  return splashJson(net, c, ctx.now);
}

const guestClient = (world) => world.orgs[0].networks[0].clients.find((c) => c.kindName === 'guest').id;
const someClients = (world) => `clients=${world.orgs[0].networks[0].clients.slice(0, 3).map((c) => c.id).join(',')}`;

export default [
  {
    op: 'getNetworkClientsApplicationUsage',
    path: '/networks/{networkId}/clients/applicationUsage',
    sample: { query: someClients },
    handler: (ctx) => {
      const net = netOf(ctx);
      const clients = clientsParam(ctx, net);
      const { t0, t1 } = clientsWindow(ctx);
      const day = Math.floor(t1 / DAY);
      const rows = clients.map((c) => {
        const u = clientUsage(c, t0, t1);
        const apps = clientApps(c, u.sent, u.recv, day).map((r) => ({ application: r.app.application, received: Math.round(r.recv), sent: Math.round(r.sent) }));
        return { ...idsOf(c), applicationUsage: apps };
      });
      return paginate(ctx, rows, (r) => r.clientId, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getNetworkClientsUsageHistories',
    path: '/networks/{networkId}/clients/usageHistories',
    sample: { query: someClients },
    handler: (ctx) => {
      const net = netOf(ctx);
      const clients = clientsParam(ctx, net);
      const { t0, t1 } = clientsWindow(ctx);
      const rows = clients.map((c) => ({ ...idsOf(c), usageHistory: dailyUsage(c, t0, t1) }));
      return paginate(ctx, rows, (r) => r.clientId, { def: 1000, max: 1000 });
    },
  },
  { op: 'provisionNetworkClients', method: 'POST', path: '/networks/{networkId}/clients/provision', handler: provision },
  {
    op: 'getNetworkClientUsageHistory',
    path: '/networks/{networkId}/clients/{clientId}/usageHistory',
    handler: (ctx) => {
      const c = clientOf(ctx);
      return dailyUsage(c, historyStart(c.net, ctx.now), ctx.now);
    },
  },
  {
    op: 'getNetworkClientTrafficHistory',
    path: '/networks/{networkId}/clients/{clientId}/trafficHistory',
    handler: (ctx) => {
      const c = clientOf(ctx);
      const rows = [];
      for (const { day, start, lo, hi } of localDays(c.net, historyStart(c.net, ctx.now), ctx.now)) {
        const u = clientUsage(c, lo, hi);
        const seconds = presenceIn(c, lo, hi)?.seconds ?? 0;
        for (const r of clientApps(c, u.sent, u.recv, day)) {
          const { application, destination, protocol, port } = r.app;
          rows.push({
            ts: isoMicro(start),
            application,
            destination,
            protocol,
            port,
            recv: Math.round(r.recv),
            sent: Math.round(r.sent),
            numFlows: Math.max(1, Math.round((r.sent + r.recv) / 90)),
            activeSeconds: Math.round(seconds * r.share),
          });
        }
      }
      // Cursors are the day plus the application's place in the catalog.
      return paginate(ctx, rows, (r) => `${r.ts}-${APPS.findIndex((a) => a.application === r.application)}`, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getNetworkClientPolicy',
    path: '/networks/{networkId}/clients/{clientId}/policy',
    sample: { clientId: guestClient },
    handler: (ctx) => policyJson(policyTarget(ctx)),
  },
  {
    op: 'updateNetworkClientPolicy',
    method: 'PUT',
    path: '/networks/{networkId}/clients/{clientId}/policy',
    handler: (ctx) => {
      const t = policyTarget(ctx);
      const want = String(ctx.body.devicePolicy).toLowerCase();
      const policy = POLICIES.find((p) => p.toLowerCase() === want);
      if (!policy) throw badRequest("'devicePolicy' must be one of: Whitelisted, Blocked, Normal, Group policy");
      policies(t.net)[t.mac] = { devicePolicy: SHOWN_AS[policy] ?? policy, ...groupPolicyOf(t.net, policy, ctx.body.groupPolicyId) };
      return policyJson(t);
    },
  },
  {
    op: 'getNetworkClientSplashAuthorizationStatus',
    path: '/networks/{networkId}/clients/{clientId}/splashAuthorizationStatus',
    sample: { clientId: guestClient },
    handler: (ctx) => splashJson(netOf(ctx), clientOf(ctx), ctx.now),
  },
  { op: 'updateNetworkClientSplashAuthorizationStatus', method: 'PUT', path: '/networks/{networkId}/clients/{clientId}/splashAuthorizationStatus', handler: updateSplash },
];
