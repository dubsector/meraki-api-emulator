// PII lookups and requests for a network. Lookups search the network's
// clients and its Systems Manager devices and owners. Requests are jobs kept
// in org.piiRequests; a delete request naming an SM device or owner removes it
// when it is made.

import { badRequest, notFound } from '../http.js';
import { smOf } from '../sim/sm.js';
import { netOf, newId } from './common.js';

const KEYS = ['username', 'email', 'mac', 'serial', 'imei', 'bluetoothMac'];
const MAC = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

// The one identifier a lookup takes, lowercased.
function keyParam(ctx) {
  const given = KEYS.filter((k) => (ctx.query.get(k) ?? '').trim() !== '');
  if (given.length !== 1) throw badRequest(`Exactly one of ${KEYS.join(', ')} is required`);
  return { key: given[0], value: ctx.query.get(given[0]).trim().toLowerCase() };
}

// SM devices and owners for an identifier: a device brings its owner and an
// owner their devices.
function lookup(net, { key, value }) {
  const sm = smOf(net);
  const devices = sm.devices.filter((d) => (key === 'mac' && d.wifiMac === value) || (key === 'serial' && d.serialNumber.toLowerCase() === value) || (key === 'imei' && d.imei === value));
  const users = sm.users.filter((u) => (key === 'email' && u.email === value) || (key === 'username' && u.username.toLowerCase() === value));
  for (const d of devices) if (d.ownerId && !users.some((u) => u.id === d.ownerId)) users.push(...sm.users.filter((u) => u.id === d.ownerId));
  for (const u of [...users]) for (const d of sm.devices) if (d.ownerId === u.id && !devices.includes(d)) devices.push(d);
  const clients = key === 'mac' ? net.clients.filter((c) => c.mac === value) : [];
  return { devices, users, clients };
}

const uniq = (list) => [...new Set(list.filter((v) => v != null && v !== ''))];

function piiKeys(ctx) {
  const net = netOf(ctx);
  const { devices, users, clients } = lookup(net, keyParam(ctx));
  if (!devices.length && !users.length && !clients.length) return {};
  return {
    [net.id]: {
      macs: uniq([...devices.map((d) => d.wifiMac), ...clients.map((c) => c.mac)]),
      emails: uniq(users.map((u) => u.email)),
      usernames: uniq([...users.map((u) => u.username), ...clients.map((c) => c.user)]),
      serials: uniq(devices.map((d) => d.serialNumber)),
      imeis: uniq(devices.map((d) => d.imei)),
      bluetoothMacs: [],
    },
  };
}

function idsFor(ctx, which) {
  const net = netOf(ctx);
  const ids = lookup(net, keyParam(ctx))[which].map((x) => x.id).sort();
  return ids.length ? { [net.id]: ids } : {};
}

// ── Requests ──

const TYPES = ['delete', 'restrict processing'];
// The datasets a delete request can name for each identifier.
const DATASETS = { mac: ['usage', 'events', 'traffic'], email: ['users', 'loginAttempts'], username: ['users', 'loginAttempts'], smDeviceId: ['device'], smUserId: ['user'] };
const REQUEST_SECONDS = 60;
const MAX_REQUESTS = 1000;

function requestJson(r, now) {
  const done = now >= r.end;
  const out = { id: r.id, organizationWide: false, networkId: r.networkId, type: r.type };
  if (r.key === 'mac') out.mac = r.value;
  if (r.datasets) out.datasets = `[${r.datasets.map((d) => `'${d}'`).join(', ')}]`;
  out.status = done ? 'Completed' : 'In progress';
  out.createdAt = r.createdAt;
  if (done) out.completedAt = r.end;
  return out;
}

function checkValue(net, key, v) {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`'${key}' must not be empty`);
  const value = key === 'smDeviceId' || key === 'smUserId' ? v.trim() : v.trim().toLowerCase();
  if (key === 'mac' && !MAC.test(value)) throw badRequest("'mac' must be a MAC address like 00:11:22:33:44:55");
  if (key === 'email' && !/^[^@\s]+@[^@\s]+$/.test(value)) throw badRequest("'email' must be an email address");
  if (key === 'smDeviceId' && !smOf(net).devices.some((d) => d.id === value)) throw badRequest(`'smDeviceId' ${value} is not a Systems Manager device in this network`);
  if (key === 'smUserId' && !smOf(net).users.some((u) => u.id === value)) throw badRequest(`'smUserId' ${value} is not a Systems Manager owner in this network`);
  return value;
}

function createRequest(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  if (b.type == null) throw badRequest("'type' is required");
  if (!TYPES.includes(b.type)) throw badRequest(`'type' must be one of ${TYPES.join(', ')}`);
  const given = Object.keys(DATASETS).filter((k) => b[k] != null);
  if (given.length !== 1) throw badRequest(`Name exactly one of ${Object.keys(DATASETS).join(', ')}`);
  const [key] = given;
  const restrict = b.type === 'restrict processing';
  if (restrict && (key === 'email' || key === 'username')) throw badRequest(`'${key}' only applies to delete requests`);
  if (restrict && b.datasets != null) throw badRequest("'datasets' only applies to delete requests");
  const value = checkValue(net, key, b[key]);
  let datasets = null;
  if (!restrict) {
    if (b.datasets == null || !b.datasets.length) throw badRequest("'datasets' is required for delete requests");
    const allowed = DATASETS[key];
    const bad = b.datasets.filter((d) => d !== 'all' && !allowed.includes(d));
    if (bad.length) throw badRequest(`'datasets' for '${key}' must be from all, ${allowed.join(', ')}`);
    datasets = b.datasets.includes('all') ? allowed : allowed.filter((d) => b.datasets.includes(d));
  }
  const store = (net.org.piiRequests ??= { created: 0, list: [] });
  const now = Math.floor(ctx.now);
  const r = { id: newId(ctx, store, 'piiRequest', net.id), networkId: net.id, type: b.type, key, value, datasets, createdAt: now, end: ctx.frozen ? now : now + REQUEST_SECONDS };
  store.list.push(r);
  if (store.list.length > MAX_REQUESTS) store.list.shift();
  if (datasets?.includes('device')) {
    const sm = net.sm;
    sm.devices.splice(sm.devices.findIndex((d) => d.id === value), 1);
    if (sm.userAccessDevices) sm.userAccessDevices = sm.userAccessDevices.filter((u) => u.deviceId !== value);
  }
  if (datasets?.includes('user')) {
    const sm = net.sm;
    const [user] = sm.users.splice(sm.users.findIndex((u) => u.id === value), 1);
    if (sm.userAccessDevices) sm.userAccessDevices = sm.userAccessDevices.filter((u) => u.email !== user.email);
    for (const d of sm.devices) if (d.ownerId === value) d.ownerId = null;
  }
  return requestJson(r, ctx.now);
}

function requestOf(ctx) {
  const net = netOf(ctx);
  const r = net.org.piiRequests?.list.find((x) => x.id === ctx.params.requestId && x.networkId === net.id);
  if (!r) throw notFound('PII request');
  return { net, r };
}

const SM_SAMPLE = { org: 1, networkId: (world) => world.orgs[1].networks.find((n) => n.sm).id };
const SM_KEY = { ...SM_SAMPLE, query: (world) => `mac=${world.orgs[1].networks.find((n) => n.sm).sm.devices.find((d) => d.ownerId).wifiMac}` };

export default [
  { op: 'getNetworkPiiPiiKeys', path: '/networks/{networkId}/pii/piiKeys', sample: SM_KEY, handler: piiKeys },
  { op: 'getNetworkPiiSmDevicesForKey', path: '/networks/{networkId}/pii/smDevicesForKey', sample: SM_KEY, handler: (ctx) => idsFor(ctx, 'devices') },
  { op: 'getNetworkPiiSmOwnersForKey', path: '/networks/{networkId}/pii/smOwnersForKey', sample: SM_KEY, handler: (ctx) => idsFor(ctx, 'users') },
  {
    op: 'getNetworkPiiRequests',
    path: '/networks/{networkId}/pii/requests',
    handler: (ctx) => {
      const net = netOf(ctx);
      return (net.org.piiRequests?.list ?? []).filter((r) => r.networkId === net.id).map((r) => requestJson(r, ctx.now));
    },
  },
  { op: 'createNetworkPiiRequest', method: 'POST', path: '/networks/{networkId}/pii/requests', handler: createRequest },
  { op: 'getNetworkPiiRequest', path: '/networks/{networkId}/pii/requests/{requestId}', sample: { requestId: '1234', status: 404 }, handler: (ctx) => requestJson(requestOf(ctx).r, ctx.now) },
  {
    op: 'deleteNetworkPiiRequest',
    method: 'DELETE',
    path: '/networks/{networkId}/pii/requests/{requestId}',
    // A restrict processing request made at runtime, when there is one.
    sample: { requestId: (world) => world.orgs[0].piiRequests?.list.find((r) => r.type === 'restrict processing' && r.networkId === world.orgs[0].networks[0].id)?.id ?? '1234' },
    handler: (ctx) => {
      const { net, r } = requestOf(ctx);
      if (r.type !== 'restrict processing') throw badRequest('Only restrict processing requests can be deleted');
      const list = net.org.piiRequests.list;
      list.splice(list.indexOf(r), 1);
    },
  },
];
