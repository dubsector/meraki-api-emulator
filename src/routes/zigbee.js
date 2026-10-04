// Zigbee door locks and electronic shelf labels on CW916x access points.
// Network settings and the AP's own state live in sim/zigbee.js stores;
// enrollments and disenrollments are jobs that finish on the clock.

import { arrayParam, badRequest, boolParam, notFound, paginate } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { isDown } from '../sim/outages.js';
import { addDoorLock, iotCapable, lockLive, lockSeen, locksOf } from '../sim/zigbee.js';
import { iso } from '../time.js';
import { isAddress, isHostname } from '../validate.js';
import { bySerial, devOf, orgOf } from './common.js';
import { wirelessNet } from './wireless.js';

// Seconds a gateway listens for a new lock, and how long a disenrollment takes.
const ENROLL_SECONDS = 30;
const DISENROLL_SECONDS = 10;
const MAX_LOCKS = 32;
const MAX_JOBS = 100;

const montreal = (world) => world.orgs[1].networks.find((n) => n.code === 'MTL');
const mtlAp = (world) => montreal(world).devices.find(iotCapable).serial;
const NET_SAMPLE = { org: 1, networkId: (world) => montreal(world).id };
const AP_SAMPLE = { org: 1, serial: mtlAp };

const netRef = (net) => ({ id: net.id, name: net.name });
// The IoT controller, while it is still a CW916x in the network.
const alive = (world, net, dev) => dev && world.deviceBySerial.get(dev.serial) === dev && dev.net === net && iotCapable(dev);
const status = (dev, now) => (isDown(dev, now) ? 'offline' : 'online');

function iotAp(ctx, what) {
  const dev = devOf(ctx);
  if (!iotCapable(dev)) throw badRequest(`${what} is only supported on CW916x access points`);
  return dev;
}

// Enabled with no IoT controller is refused, so the default has neither.
const zigbeeOf = (net) => net.wirelessZigbee ?? { enabled: false, controller: null, lockManagement: { address: null, username: null, password: null }, defaults: { transmitPowerLevel: 10, channel: 'auto' } };
const eslOf = (net) => net.wirelessEsl ?? { enabled: false, hostname: null, mode: 'high frequency' };
const gatewayOf = (ap) => ap.zigbeeGateway ?? { enrolled: false, channel: null };

function checkChannel(v, name) {
  if (v == null) return undefined;
  if (typeof v !== 'string') throw badRequest(`'${name}' must be a string`);
  if (v.toLowerCase() === 'auto') return 'auto';
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < 11 || n > 25) throw badRequest(`'${name}' must be 'auto' or a channel from 11 to 25`);
  return String(n);
}

// ── Network Zigbee settings ──

function zigbeeJson(world, net, now) {
  const z = zigbeeOf(net);
  const ap = alive(world, net, z.controller) ? z.controller : null;
  const lm = z.lockManagement;
  return {
    network: { id: net.id },
    enabled: z.enabled,
    iotController: ap ? { name: ap.name ?? '', mac: ap.mac, serial: ap.serial, status: status(ap, now) } : null,
    lockManagement: { address: lm.address, username: lm.username, status: z.enabled && lm.address && ap && !isDown(ap, now) ? 'online' : 'offline' },
    defaults: { ...z.defaults },
  };
}

function updateZigbee(ctx) {
  const net = wirelessNet(ctx);
  const b = ctx.body;
  const z = zigbeeOf(net);
  const next = { enabled: b.enabled ?? z.enabled, controller: alive(ctx.world, net, z.controller) ? z.controller : null, lockManagement: { ...z.lockManagement }, defaults: { ...z.defaults } };
  if (b.iotController != null) {
    const serial = b.iotController.serial;
    if (serial == null) throw badRequest("'iotController.serial' is required");
    const ap = ctx.world.deviceBySerial.get(serial);
    if (!ap || ap.net !== net || !iotCapable(ap)) throw badRequest("'iotController.serial' must be a CW916x access point in this network");
    next.controller = ap;
  }
  const lm = b.lockManagement;
  if (lm != null) {
    if (lm.address != null) {
      if (typeof lm.address !== 'string' || !(isAddress(lm.address) || isHostname(lm.address))) throw badRequest("'lockManagement.address' must be a hostname or IP address");
      next.lockManagement.address = lm.address;
    }
    if (lm.username != null) next.lockManagement.username = String(lm.username);
    if (lm.password != null) next.lockManagement.password = String(lm.password);
  }
  const d = b.defaults;
  if (d != null) {
    if (d.transmitPowerLevel != null) {
      if (!Number.isInteger(d.transmitPowerLevel) || d.transmitPowerLevel < 10 || d.transmitPowerLevel > 20) throw badRequest("'defaults.transmitPowerLevel' must be an integer from 10 to 20");
      next.defaults.transmitPowerLevel = d.transmitPowerLevel;
    }
    next.defaults.channel = checkChannel(d.channel, 'defaults.channel') ?? next.defaults.channel;
  }
  if (next.enabled && !next.controller) throw badRequest("Zigbee needs an IoT controller: set 'iotController.serial'");
  net.wirelessZigbee = next;
  return zigbeeJson(ctx.world, net, ctx.now);
}

function zigbeeByNetwork(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const nets = org.networks.filter((n) => n.productTypes.includes('wireless') && (!ids.length || ids.includes(n.id))).sort((a, b) => (a.id < b.id ? -1 : 1));
  return paginate(ctx, nets, (n) => n.id, { def: 50, max: 1000 }).map((n) => zigbeeJson(ctx.world, n, ctx.now));
}

// ── Gateways and door locks ──

const liveLocks = (ap, now) => (ap.zigbeeLocks?.list ?? []).filter((l) => lockLive(l, now));

function gatewayJson(ap, now) {
  const z = zigbeeOf(ap.net);
  const g = gatewayOf(ap);
  const up = !isDown(ap, now);
  const n = liveLocks(ap, now).length;
  return {
    network: netRef(ap.net),
    panId: `0x${((ap.key >>> 8) & 0xffff).toString(16).padStart(4, '0')}`,
    channel: g.channel ?? z.defaults.channel,
    transmitPowerLevel: z.defaults.transmitPowerLevel,
    enrolled: Boolean(g.enrolled),
    status: up ? 'online' : 'offline',
    gateway: { name: ap.name ?? '', mac: ap.mac, serial: ap.serial, tags: [...ap.tags] },
    counts: { doorLocks: { byStatus: { online: up ? n : 0, offline: up ? 0 : n, dormant: 0 } } },
  };
}

const orgGateways = (org) => org.devices.filter((d) => d.net && iotCapable(d)).sort(bySerial);

function listGateways(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const ids = arrayParam(q, 'networkIds');
  const enrolled = q.get('isEnrolled') == null ? null : boolParam(q, 'isEnrolled');
  const search = (q.get('search') ?? '').toLowerCase();
  const list = orgGateways(org).filter(
    (d) =>
      (!ids.length || ids.includes(d.net.id)) &&
      (enrolled == null || Boolean(gatewayOf(d).enrolled) === enrolled) &&
      (!search || [d.name ?? '', d.serial, ...d.tags].some((s) => s.toLowerCase().includes(search))),
  );
  return paginate(ctx, list, (d) => d.serial, { def: 10, max: 1000 }).map((d) => gatewayJson(d, ctx.now));
}

function updateGateway(ctx) {
  const org = orgOf(ctx);
  const ap = orgGateways(org).find((d) => d.serial === ctx.params.id);
  if (!ap) throw notFound('Zigbee device');
  const b = ctx.body;
  if (b.enrolled == null) throw badRequest("'enrolled' is required");
  const channel = checkChannel(b.channel, 'channel');
  ap.zigbeeGateway = { enrolled: b.enrolled, channel: channel ?? gatewayOf(ap).channel };
  return gatewayJson(ap, ctx.now);
}

function lockJson(ap, l, now) {
  return {
    doorLockId: l.doorLockId,
    name: l.name,
    shortId: l.shortId,
    lqi: String(l.lqi),
    rssi: String(l.rssi),
    status: status(ap, now),
    eui64: l.eui64,
    enrolledAt: iso(l.enrolledAt),
    lastSeenAt: iso(lockSeen(l, ap, now)),
    network: netRef(ap.net),
    gateway: { name: ap.name ?? '', serial: ap.serial },
  };
}

// Every live lock in the organization with its gateway, by lock ID.
const orgLocks = (org, now) =>
  orgGateways(org)
    .flatMap((ap) => liveLocks(ap, now).map((l) => [ap, l]))
    .sort(([, a], [, b]) => (a.doorLockId < b.doorLockId ? -1 : 1));

function listLocks(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const serial = ctx.query.get('serial');
  const rows = orgLocks(org, ctx.now).filter(([ap]) => (!ids.length || ids.includes(ap.net.id)) && (!serial || ap.serial === serial));
  return paginate(ctx, rows, ([, l]) => l.doorLockId, { def: 50, max: 500 }).map(([ap, l]) => lockJson(ap, l, ctx.now));
}

function updateLock(ctx) {
  const row = orgLocks(orgOf(ctx), ctx.now).find(([, l]) => l.doorLockId === ctx.params.doorLockId);
  if (!row) throw notFound('Door lock');
  const name = ctx.body.name;
  if (name != null) {
    if (typeof name !== 'string' || !name.trim()) throw badRequest("'name' must not be empty");
    row[1].name = name;
  }
  return lockJson(row[0], row[1], ctx.now);
}

// ── Enrollment jobs ──

function jobStatus(job, now) {
  if (now < job.end) return 'pending';
  return job.failed ? 'failed' : 'complete';
}

function newJobId(world, store, kind, parent) {
  store.created++;
  return new Rand(hashStr(`meraki-api-emulator:${world.seed}:${kind}:${parent}:${store.created}`)).digits(13);
}

const enrollmentsOf = (ap) => (ap.zigbeeEnrollments ??= { created: 0, list: [] });

function enrollmentJson(ap, e, now) {
  return { enrollmentId: e.enrollmentId, url: `/devices/${ap.serial}/wireless/zigbee/enrollments/${e.enrollmentId}`, request: { serial: ap.serial }, status: jobStatus(e, now) };
}

// The gateway listens for a while and pairs one new lock, unless it was down.
function createEnrollment(ctx) {
  const ap = iotAp(ctx, 'Zigbee');
  if (!zigbeeOf(ap.net).enabled) throw badRequest('Zigbee is not enabled on this network');
  const store = locksOf(ap);
  store.list = store.list.filter((l) => !(l.removedAt != null && l.removedAt <= ctx.now));
  if (store.list.length >= MAX_LOCKS) throw badRequest(`A gateway pairs at most ${MAX_LOCKS} door locks`);
  const jobs = enrollmentsOf(ap);
  const now = Math.floor(ctx.now);
  const end = ctx.frozen ? now : now + ENROLL_SECONDS;
  const e = { enrollmentId: newJobId(ctx.world, jobs, 'zigbeeEnrollment', ap.serial), start: now, end, failed: isDown(ap, now), doorLockIds: [] };
  if (!e.failed) e.doorLockIds.push(addDoorLock(ctx.world, ap, end).doorLockId);
  jobs.list.push(e);
  if (jobs.list.length > MAX_JOBS) jobs.list.shift();
  return enrollmentJson(ap, e, ctx.now);
}

function getEnrollment(ctx) {
  const ap = iotAp(ctx, 'Zigbee');
  const e = enrollmentsOf(ap).list.find((x) => x.enrollmentId === ctx.params.enrollmentId);
  if (!e) throw notFound('Enrollment');
  const done = jobStatus(e, ctx.now) === 'complete';
  const locks = done ? liveLocks(ap, ctx.now).filter((l) => e.doorLockIds.includes(l.doorLockId)) : [];
  return { ...enrollmentJson(ap, e, ctx.now), enrollmentStartedAt: iso(e.start), doorLocks: locks.map((l) => lockJson(ap, l, ctx.now)) };
}

const disenrollmentsOf = (org) => (org.wirelessZigbeeDisenrollments ??= { created: 0, list: [] });

function disenrollmentJson(org, d, now) {
  return { disenrollmentId: d.disenrollmentId, url: `/organizations/${org.id}/wireless/zigbee/disenrollments/${d.disenrollmentId}`, request: { doorLockIds: [...d.doorLockIds] }, status: jobStatus(d, now) };
}

// Each named lock leaves its gateway when the job ends; unknown IDs fail.
function createDisenrollment(ctx) {
  const org = orgOf(ctx);
  const ids = ctx.body.doorLockIds;
  if (ids == null || !ids.length) throw badRequest("'doorLockIds' must name at least one door lock");
  const wanted = [...new Set(ids)];
  const now = Math.floor(ctx.now);
  const end = ctx.frozen ? now : now + DISENROLL_SECONDS;
  const locks = new Map(orgLocks(org, now).map(([, l]) => [l.doorLockId, l]));
  const results = wanted.map((id) => ({ doorLockId: id, status: locks.has(id) && locks.get(id).removedAt == null ? 'success' : 'failure' }));
  for (const r of results) if (r.status === 'success') locks.get(r.doorLockId).removedAt = end;
  const store = disenrollmentsOf(org);
  const d = { disenrollmentId: newJobId(ctx.world, store, 'zigbeeDisenrollment', org.id), start: now, end, failed: false, doorLockIds: wanted, results };
  store.list.push(d);
  if (store.list.length > MAX_JOBS) store.list.shift();
  return disenrollmentJson(org, d, ctx.now);
}

function getDisenrollment(ctx) {
  const org = orgOf(ctx);
  const d = disenrollmentsOf(org).list.find((x) => x.disenrollmentId === ctx.params.disenrollmentId);
  if (!d) throw notFound('Disenrollment');
  const done = jobStatus(d, ctx.now) === 'complete';
  return { ...disenrollmentJson(org, d, ctx.now), doorLocks: done ? d.results.map((r) => ({ ...r })) : [] };
}

// ── Electronic shelf labels ──

const provider = (esl) => (esl.mode === 'Bluetooth' ? 'sepioo' : 'imagotag');
const deviceEslOf = (ap) => ap.wirelessEsl ?? { enabled: false, channel: 'Auto' };

function eslJson(esl, enabled = esl.enabled) {
  return { hostname: esl.hostname, enabled, mode: esl.mode, sepioo: { hostname: esl.mode === 'Bluetooth' ? esl.hostname : null } };
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

// A hostname (a single label like localhost too) or IP address, with an optional port.
function checkHost(v, name) {
  if (typeof v !== 'string') throw badRequest(`'${name}' must be a string`);
  if (isAddress(v) || isHostname(v) || LABEL.test(v)) return v;
  const i = v.lastIndexOf(':');
  const host = v.slice(0, i);
  const port = v.slice(i + 1);
  if (i < 0 || !(isHostname(host) || LABEL.test(host) || isAddress(host)) || !/^\d{1,5}$/.test(port) || Number(port) > 65535) throw badRequest(`'${name}' must be a hostname or IP address, optionally with a port`);
  return v;
}

function updateNetworkEsl(ctx) {
  const net = wirelessNet(ctx);
  const b = ctx.body;
  const esl = { ...eslOf(net) };
  if (b.mode != null) {
    if (b.mode !== 'Bluetooth' && b.mode !== 'high frequency') throw badRequest("'mode' must be 'Bluetooth' or 'high frequency'");
    esl.mode = b.mode;
  }
  if (b.hostname !== undefined) esl.hostname = b.hostname == null || b.hostname === '' ? null : checkHost(b.hostname, 'hostname');
  if (b.enabled != null) esl.enabled = b.enabled;
  net.wirelessEsl = esl;
  return eslJson(esl);
}

function deviceEslJson(ap) {
  const esl = eslOf(ap.net);
  const own = deviceEslOf(ap);
  return { apEslId: ap.key & 0xffffff, serial: ap.serial, channel: own.channel, enabled: own.enabled, networkId: ap.net.id, hostname: esl.hostname, provider: provider(esl) };
}

function updateDeviceEsl(ctx) {
  const ap = iotAp(ctx, 'ESL');
  const b = ctx.body;
  const own = { ...deviceEslOf(ap) };
  if (b.channel != null) {
    if (typeof b.channel !== 'string') throw badRequest("'channel' must be a string");
    const n = Number(b.channel);
    if (b.channel.toLowerCase() === 'auto') own.channel = 'Auto';
    else if (/^\d+$/.test(b.channel) && n >= 1 && n <= 11) own.channel = String(n);
    else throw badRequest("'channel' must be 'Auto' or a channel from 1 to 11");
  }
  if (b.enabled != null) own.enabled = b.enabled;
  ap.wirelessEsl = own;
  return deviceEslJson(ap);
}

function configuredDevices(ctx) {
  const net = wirelessNet(ctx);
  const esl = eslOf(net);
  return net.devices.filter(iotCapable).sort(bySerial).map((ap) => eslJson(esl, deviceEslOf(ap).enabled));
}

export default [
  { op: 'getDeviceWirelessElectronicShelfLabel', path: '/devices/{serial}/wireless/electronicShelfLabel', sample: AP_SAMPLE, handler: (ctx) => deviceEslJson(iotAp(ctx, 'ESL')) },
  { op: 'updateDeviceWirelessElectronicShelfLabel', method: 'PUT', path: '/devices/{serial}/wireless/electronicShelfLabel', sample: AP_SAMPLE, handler: updateDeviceEsl },
  { op: 'createDeviceWirelessZigbeeEnrollment', method: 'POST', path: '/devices/{serial}/wireless/zigbee/enrollments', sample: AP_SAMPLE, handler: createEnrollment },
  { op: 'getDeviceWirelessZigbeeEnrollment', path: '/devices/{serial}/wireless/zigbee/enrollments/{enrollmentId}', sample: { ...AP_SAMPLE, enrollmentId: '1234', status: 404 }, handler: getEnrollment },
  { op: 'getNetworkWirelessElectronicShelfLabel', path: '/networks/{networkId}/wireless/electronicShelfLabel', sample: NET_SAMPLE, handler: (ctx) => eslJson(eslOf(wirelessNet(ctx))) },
  { op: 'updateNetworkWirelessElectronicShelfLabel', method: 'PUT', path: '/networks/{networkId}/wireless/electronicShelfLabel', sample: NET_SAMPLE, handler: updateNetworkEsl },
  { op: 'getNetworkWirelessElectronicShelfLabelConfiguredDevices', path: '/networks/{networkId}/wireless/electronicShelfLabel/configuredDevices', sample: NET_SAMPLE, handler: configuredDevices },
  { op: 'updateNetworkWirelessZigbee', method: 'PUT', path: '/networks/{networkId}/wireless/zigbee', status: 201, sample: NET_SAMPLE, handler: updateZigbee },
  { op: 'getOrganizationWirelessZigbeeByNetwork', path: '/organizations/{organizationId}/wireless/zigbee/byNetwork', sample: { org: 1 }, handler: zigbeeByNetwork },
  { op: 'getOrganizationWirelessZigbeeDevices', path: '/organizations/{organizationId}/wireless/zigbee/devices', sample: { org: 1 }, handler: listGateways },
  { op: 'updateOrganizationWirelessZigbeeDevice', method: 'PUT', path: '/organizations/{organizationId}/wireless/zigbee/devices/{id}', status: 201, sample: { org: 1, id: mtlAp }, handler: updateGateway },
  { op: 'createOrganizationWirelessZigbeeDisenrollment', method: 'POST', path: '/organizations/{organizationId}/wireless/zigbee/disenrollments', sample: { org: 1 }, handler: createDisenrollment },
  { op: 'getOrganizationWirelessZigbeeDisenrollment', path: '/organizations/{organizationId}/wireless/zigbee/disenrollments/{disenrollmentId}', sample: { org: 1, disenrollmentId: '1234', status: 404 }, handler: getDisenrollment },
  { op: 'getOrganizationWirelessZigbeeDoorLocks', path: '/organizations/{organizationId}/wireless/zigbee/doorLocks', sample: { org: 1 }, handler: listLocks },
  // Lock IDs come from the seed, so the sample takes Montreal's first.
  { op: 'updateOrganizationWirelessZigbeeDoorLock', method: 'PUT', path: '/organizations/{organizationId}/wireless/zigbee/doorLocks/{doorLockId}', status: 201, sample: { org: 1, doorLockId: (world) => montreal(world).devices.find(iotCapable).zigbeeLocks?.list[0]?.doorLockId ?? '1' }, handler: updateLock },
];
