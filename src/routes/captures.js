// Packet captures and their schedules. A capture runs on the clock for its
// duration, or until it's stopped, and the organization keeps the newest 10,
// as the real cloud storage does. Schedules are stored and show when they'd
// run next, but never take captures.

import { arrayParam, badRequest, notFound, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr, unit } from '../rng.js';
import { DAY, isoMicro, parseTime } from '../time.js';
import { orgOf } from './common.js';

const CAPTURES = '/organizations/{organizationId}/devices/packetCapture/captures';
const CAPTURE = `${CAPTURES}/{captureId}`;
const SCHEDULES = '/organizations/{organizationId}/devices/packetCapture/schedules';
const KEPT = 10;
const MAX_BULK = 20;
const MAX_SCHEDULES = 100;
const MAX_DURATION = 3600;
const CAPTURABLE = ['appliance', 'switch', 'wireless'];
const DEFAULT_INTERFACE = { appliance: 'wan1', switch: 'wired', wireless: 'wireless' };
const FREQUENCIES = ['minute', 'hour', 'day', 'week', 'month'];
const STEP = { minute: 60, hour: 3600, day: DAY, week: 7 * DAY };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const storeOf = (org) => (org.packetCaptures ??= { created: 0, captures: [], schedulesCreated: 0, schedules: [] });
const adminRef = (ctx) => ({ id: ctx.world.apiAdmin.id, name: ctx.world.apiAdmin.name });

function newId(ctx, org, kind, list, key) {
  const store = storeOf(org);
  const counter = kind === 'packetCapture' ? 'created' : 'schedulesCreated';
  store[counter]++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${org.id}:${store[counter]}`));
  let id;
  do id = r.digits(12);
  while (list.some((x) => x[key] === id));
  return id;
}

// A device in one of the organization's networks that can take a capture.
function capturable(org, serial, at) {
  const dev = org.devices.find((d) => d.serial === serial);
  if (!dev) throw badRequest(`${at}: device ${serial} is not in a network in this organization`);
  if (!CAPTURABLE.includes(dev.productType)) throw badRequest(`${at}: device ${serial} doesn't support packet capture`);
  return dev;
}

// Switch ports as "1, 2" or "1-3, 9", each one a port on the switch.
function switchPorts(dev, ports, at) {
  if (ports == null || ports === '') return null;
  if (dev.productType !== 'switch') throw badRequest(`${at}: ports only apply to switches`);
  for (const part of String(ports).split(',').map((p) => p.trim())) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    const [lo, hi] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [];
    if (!m || lo > hi || hi > dev.ports.length || lo < 1) throw badRequest(`${at}: '${part}' is not a port on ${dev.serial}`);
  }
  return ports;
}

function checkDuration(d) {
  if (d != null && (!Number.isInteger(d) || d < 1 || d > MAX_DURATION)) throw badRequest(`'duration' must be between 1 and ${MAX_DURATION} seconds`);
}

function checkName(name) {
  if (!name?.trim()) throw badRequest("'name' must not be empty");
}

// ── Captures ──

// Each device captures until the duration runs out or it's stopped.
const deviceEnd = (c, serial) => Math.min(c.start + c.duration, c.stops[serial] ?? Infinity);
const endOf = (c) => Math.max(...c.devices.map((d) => deviceEnd(c, d.serial)));
const statusOf = (c, now) => (now < endOf(c) ? 'capturing' : 'completed');

// Packets from a steady rate per device, seeded by the capture.
function packets(c, now) {
  return c.devices.reduce((sum, d, i) => sum + Math.round((20 + 380 * unit(hashStr(c.captureId), i)) * Math.max(0, Math.min(now, deviceEnd(c, d.serial)) - c.start)), 0);
}

function captureJson(c, now) {
  const total = packets(c, now);
  const ref = (d) => ({ name: d.name, serial: d.serial });
  return {
    captureId: c.captureId,
    network: { id: c.net.id, name: c.net.name },
    devices: c.devices.map(ref),
    device: ref(c.devices[0]),
    admin: c.admin,
    client: null,
    details: [],
    name: c.name,
    startTs: isoMicro(c.start),
    ports: c.ports,
    status: statusOf(c, now),
    errorMessage: null,
    destination: c.destination,
    process: 'manual',
    file: { size: total * (90 + Math.round(400 * unit(hashStr(c.captureId), 99))) },
    duration: c.duration,
    filterExpression: c.filterExpression,
    counts: { packets: { total } },
    interface: c.interface,
  };
}

function newCapture(ctx, org, devices, b, entry = {}) {
  const store = storeOf(org);
  const c = {
    captureId: newId(ctx, org, 'packetCapture', store.captures, 'captureId'),
    net: devices[0].net,
    devices,
    admin: adminRef(ctx),
    name: b.name,
    notes: b.notes ?? null,
    start: ctx.now,
    stops: {},
    ports: entry.ports ?? null,
    destination: b.destination ?? 'upload_to_cloud',
    duration: b.duration ?? 60,
    filterExpression: b.filterExpression ?? null,
    interface: entry.interface ?? DEFAULT_INTERFACE[devices[0].productType],
  };
  store.captures.push(c);
  store.captures.splice(0, Math.max(0, store.captures.length - KEPT));
  return c;
}

// One network per capture, and one switch or MX at a time; several APs can share one.
function createCapture(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  checkName(b.name);
  checkDuration(b.duration);
  const serials = [...new Set(b.serials ?? [])];
  if (!serials.length) throw badRequest("'serials' must not be empty");
  const devices = serials.map((s, i) => capturable(org, s, `serials[${i}]`));
  if (devices.some((d) => d.net !== devices[0].net)) throw badRequest('All devices in a capture must be in the same network');
  if (devices.length > 1 && devices.some((d) => d.productType !== 'wireless')) throw badRequest('Only one switch or security appliance can be captured per request; several access points can');
  const ports = switchPorts(devices[0], b.ports, 'ports');
  return captureJson(newCapture(ctx, org, devices, b, { ports, interface: b.interface }), ctx.now);
}

function bulkCreate(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  checkName(b.name);
  checkDuration(b.duration);
  const list = b.devices ?? [];
  if (!list.length) throw badRequest("'devices' must not be empty");
  if (list.length > MAX_BULK) throw badRequest(`'devices' can list at most ${MAX_BULK} devices`);
  const planned = list.map((d, i) => {
    const dev = capturable(org, d?.serial, `devices[${i}]`);
    return [dev, { ports: switchPorts(dev, d.switchports, `devices[${i}]`), interface: d.interface }];
  });
  return { items: planned.map(([dev, entry]) => captureJson(newCapture(ctx, org, [dev], b, entry), ctx.now)) };
}

function captureOf(ctx) {
  const org = orgOf(ctx);
  const c = storeOf(org).captures.find((x) => x.captureId === ctx.params.captureId);
  if (!c) throw notFound('Packet capture');
  return { org, c };
}

function listCaptures(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 365 * DAY, defaultSpan: 365 * DAY, lookback: 365 * DAY });
  const order = q.get('sortOrder') ?? 'descending';
  if (!['ascending', 'descending'].includes(order)) throw badRequest("'sortOrder' must be one of: ascending, descending");
  const [ids, networkIds, serials, processes, statuses, names, macs] = ['captureIds', 'networkIds', 'serials', 'process', 'captureStatus', 'name', 'clientMac'].map((n) => arrayParam(q, n));
  const like = (value, name) => !q.get(name) || (value ?? '').toLowerCase().includes(q.get(name).toLowerCase());
  const rows = storeOf(org)
    .captures.filter(
      (c) =>
        c.start >= t0 &&
        c.start <= t1 &&
        (!ids.length || ids.includes(c.captureId)) &&
        (!networkIds.length || networkIds.includes(c.net.id)) &&
        (!serials.length || c.devices.some((d) => serials.includes(d.serial))) &&
        (!processes.length || processes.includes('manual')) &&
        (!statuses.length || statuses.includes(statusOf(c, ctx.now))) &&
        (!names.length || names.includes(c.name)) &&
        !macs.length &&
        like(c.notes, 'notes') &&
        like(c.admin.name, 'adminName') &&
        (!q.get('deviceName') || c.devices.some((d) => like(d.name, 'deviceName'))),
    )
    // Newest first by default; captures from the same second keep the order they were made in.
    .sort((a, b) => a.start - b.start);
  if (order === 'descending') rows.reverse();
  return paginateItems(ctx, rows, (c) => c.captureId, { def: 10, max: 100 }, (c) => captureJson(c, ctx.now));
}

function stopCapture(ctx) {
  const { c } = captureOf(ctx);
  const serials = [...new Set(ctx.body.serials ?? [])];
  if (!serials.length) throw badRequest("'serials' must not be empty");
  for (const s of serials) {
    if (!c.devices.some((d) => d.serial === s)) throw badRequest(`Device ${s} is not part of capture ${c.captureId}`);
    if (deviceEnd(c, s) <= ctx.now) throw badRequest(`The capture on ${s} has already finished`);
  }
  for (const s of serials) c.stops[s] = ctx.now;
  return captureJson(c, ctx.now);
}

// ── Schedules ──

// The first run at or after now, or null once the schedule has ended.
function nextRun(s, now) {
  const { start, end, frequency, recurrence, weekdays } = s.schedule;
  const days = weekdays.map((w) => WEEKDAYS.indexOf(w));
  const dayOk = (t) => !days.length || days.includes(new Date(t * 1000).getUTCDay());
  let at;
  if (frequency === 'month') {
    const d = new Date(start * 1000);
    const months = (y, m) => Date.UTC(y, m, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
    const n = new Date(Math.max(now, start) * 1000);
    let k = Math.max(0, (n.getUTCFullYear() - d.getUTCFullYear()) * 12 + n.getUTCMonth() - d.getUTCMonth() - 1);
    k -= k % recurrence;
    for (let i = 0; i < 1000 && at == null; i++, k += recurrence) {
      const t = months(d.getUTCFullYear(), d.getUTCMonth() + k);
      if (t >= now && dayOk(t)) at = t;
    }
  } else {
    // A weekly schedule with weekdays runs on each of those days, every recurrence weeks.
    const weekly = frequency === 'week' && days.length;
    const step = weekly ? DAY : STEP[frequency] * recurrence;
    let t = start + Math.max(0, Math.ceil((now - start) / step)) * step;
    for (let i = 0; i < 20000 && at == null; i++, t += step) {
      if (dayOk(t) && (!weekly || Math.floor((t - start) / STEP.week) % recurrence === 0)) at = t;
    }
  }
  return at == null || (end != null && at > end) ? null : at;
}

function scheduleJson(org, s, now) {
  const store = storeOf(org);
  const next = s.enabled ? nextRun(s, now) : null;
  const clashes = store.schedules.filter((o) => o !== s && o.enabled && next != null && nextRun(o, now) === next && o.devices.some((d) => s.devices.some((x) => x.serial === d.serial)));
  return {
    scheduleId: s.scheduleId,
    devices: s.devices.map((d) => ({ device: { serial: d.serial, switchports: d.switchports, interface: d.interface } })),
    name: s.name,
    admin: s.admin,
    notes: s.notes,
    duration: s.duration,
    filterExpression: s.filterExpression,
    createdAt: isoMicro(s.createdAt),
    updatedAt: isoMicro(s.updatedAt),
    captureCount: 0,
    lastCaptureId: null,
    enabled: s.enabled,
    priority: store.schedules.indexOf(s) + 1,
    schedule: {
      name: s.schedule.name,
      startTs: isoMicro(s.schedule.start),
      endTs: s.schedule.end == null ? null : isoMicro(s.schedule.end),
      frequency: s.schedule.frequency,
      weekdays: s.schedule.weekdays,
      recurrence: s.schedule.recurrence,
      nextCaptureTs: next == null ? null : isoMicro(next),
    },
    warnings: clashes.map((o) => `This schedule conflicts with the schedule ${o.name ?? o.scheduleId} at the time ${isoMicro(next)}`),
  };
}

function scheduleDevices(org, list) {
  if (!list?.length) throw badRequest("'devices' must not be empty");
  return list.map((d, i) => {
    const dev = capturable(org, d?.serial, `devices[${i}]`);
    return { serial: dev.serial, switchports: switchPorts(dev, d.switchports, `devices[${i}]`), interface: d.interface ?? DEFAULT_INTERFACE[dev.productType] };
  });
}

// The recurrence, with what's left out kept from before (or the defaults).
function recurrence(given = {}, before, now) {
  const time = (v, name) => {
    const t = parseTime(v);
    if (Number.isNaN(t)) throw badRequest(`'schedule.${name}' must be an ISO 8601 timestamp`);
    return t;
  };
  const s = { name: null, start: now, end: null, frequency: 'day', weekdays: [], recurrence: 1, ...before };
  if (given.name !== undefined) s.name = given.name;
  if (given.startTs != null) s.start = time(given.startTs, 'startTs');
  if (given.endTs !== undefined) s.end = given.endTs == null ? null : time(given.endTs, 'endTs');
  if (given.frequency != null) {
    if (!FREQUENCIES.includes(given.frequency)) throw badRequest(`'schedule.frequency' must be one of: ${FREQUENCIES.join(', ')}`);
    s.frequency = given.frequency;
  }
  if (given.weekdays != null) {
    s.weekdays = given.weekdays.map((w) => {
      const day = WEEKDAYS.find((x) => x.toLowerCase() === String(w).toLowerCase());
      if (!day) throw badRequest(`'schedule.weekdays' must name days of the week, like Monday`);
      return day;
    });
  }
  if (given.recurrence != null) {
    if (!Number.isInteger(given.recurrence) || given.recurrence < 1) throw badRequest("'schedule.recurrence' must be a positive integer");
    s.recurrence = given.recurrence;
  }
  if (s.end != null && s.end <= s.start) throw badRequest("'schedule.endTs' must be after 'schedule.startTs'");
  return s;
}

function scheduleOf(ctx) {
  const org = orgOf(ctx);
  const s = storeOf(org).schedules.find((x) => x.scheduleId === ctx.params.scheduleId);
  if (!s) throw notFound('Packet capture schedule');
  return { org, s };
}

function createSchedule(ctx) {
  const org = orgOf(ctx);
  const store = storeOf(org);
  const b = ctx.body;
  checkDuration(b.duration);
  if (store.schedules.length >= MAX_SCHEDULES) throw badRequest(`Organizations are limited to ${MAX_SCHEDULES} packet capture schedules in the emulator`);
  const s = {
    scheduleId: null,
    devices: scheduleDevices(org, b.devices),
    name: b.name ?? null,
    admin: adminRef(ctx),
    notes: b.notes ?? null,
    duration: b.duration ?? 60,
    filterExpression: b.filterExpression ?? null,
    enabled: b.enabled ?? true,
    schedule: recurrence(b.schedule, null, ctx.now),
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  s.scheduleId = newId(ctx, org, 'packetCaptureSchedule', store.schedules, 'scheduleId');
  store.schedules.push(s);
  return scheduleJson(org, s, ctx.now);
}

function updateSchedule(ctx) {
  const { org, s } = scheduleOf(ctx);
  const b = ctx.body;
  checkDuration(b.duration);
  const devices = b.devices !== undefined ? scheduleDevices(org, b.devices) : s.devices;
  const schedule = b.schedule ? recurrence(b.schedule, s.schedule, ctx.now) : s.schedule;
  Object.assign(s, { devices, schedule, updatedAt: ctx.now });
  for (const k of ['name', 'notes', 'duration', 'filterExpression', 'enabled']) if (b[k] !== undefined) s[k] = b[k];
  return scheduleJson(org, s, ctx.now);
}

// Each schedule named moves to its priority, in the order given; the rest keep their order.
function reorder(ctx) {
  const org = orgOf(ctx);
  const list = storeOf(org).schedules;
  const order = ctx.body.order ?? [];
  if (!order.length) throw badRequest("'order' must not be empty");
  const moves = order.map((o, i) => {
    const s = list.find((x) => x.scheduleId === o?.scheduleId);
    if (!s) throw badRequest(`order[${i}]: schedule ${o?.scheduleId} not found`);
    if (!Number.isInteger(o.priority) || o.priority < 1 || o.priority > list.length) throw badRequest(`order[${i}]: 'priority' must be between 1 and ${list.length}`);
    return [s, o.priority];
  });
  if (new Set(moves.map(([s]) => s)).size < moves.length) throw badRequest('Each schedule can only appear once in the order');
  for (const [s, priority] of moves) {
    list.splice(list.indexOf(s), 1);
    list.splice(priority - 1, 0, s);
  }
  return { updatedPriorities: list.map((s, i) => ({ scheduleId: s.scheduleId, priority: i + 1 })) };
}

export default [
  { op: 'getOrganizationDevicesPacketCaptureCaptures', path: CAPTURES, handler: listCaptures },
  { op: 'createOrganizationDevicesPacketCaptureCapture', method: 'POST', path: CAPTURES, handler: createCapture },
  {
    op: 'deleteOrganizationDevicesPacketCaptureCapture',
    method: 'DELETE',
    path: CAPTURE,
    handler: (ctx) => {
      const { org, c } = captureOf(ctx);
      const list = storeOf(org).captures;
      list.splice(list.indexOf(c), 1);
    },
  },
  {
    op: 'generateOrganizationDevicesPacketCaptureCaptureDownloadUrl',
    method: 'POST',
    path: `${CAPTURE}/downloadUrl/generate`,
    status: 200,
    handler: (ctx) => {
      const { c } = captureOf(ctx);
      if (statusOf(c, ctx.now) !== 'completed') throw badRequest(`Capture ${c.captureId} is still capturing`);
      const url = `https://pcap.example.com/captures/${c.captureId}.pcap`;
      return { captureId: c.captureId, downloadUrl: url, url };
    },
  },
  { op: 'stopOrganizationDevicesPacketCaptureCapture', method: 'POST', path: `${CAPTURE}/stop`, handler: stopCapture },
  { op: 'bulkOrganizationDevicesPacketCaptureCapturesCreate', method: 'POST', path: `${CAPTURES}/bulkCreate`, handler: bulkCreate },
  {
    op: 'bulkOrganizationDevicesPacketCaptureCapturesDelete',
    method: 'POST',
    path: `${CAPTURES}/bulkDelete`,
    status: 204,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const store = storeOf(org);
      const ids = [...new Set(ctx.body.captureIds ?? [])];
      if (!ids.length) throw badRequest("'captureIds' must not be empty");
      for (const id of ids) if (!store.captures.some((c) => c.captureId === id)) throw badRequest(`Packet capture ${id} not found`);
      store.captures = store.captures.filter((c) => !ids.includes(c.captureId));
    },
  },
  {
    op: 'getOrganizationDevicesPacketCaptureSchedules',
    path: SCHEDULES,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const [ids, networkIds, deviceIds] = ['scheduleIds', 'networkIds', 'deviceIds'].map((n) => arrayParam(ctx.query, n));
      const netOfSerial = (serial) => org.devices.find((d) => d.serial === serial)?.net.id;
      const items = storeOf(org)
        .schedules.filter(
          (s) =>
            (!ids.length || ids.includes(s.scheduleId)) &&
            (!networkIds.length || s.devices.some((d) => networkIds.includes(netOfSerial(d.serial)))) &&
            (!deviceIds.length || s.devices.some((d) => deviceIds.includes(d.serial))),
        )
        .map((s) => scheduleJson(org, s, ctx.now));
      return { items, meta: { counts: { items: { total: items.length } } } };
    },
  },
  { op: 'createOrganizationDevicesPacketCaptureSchedule', method: 'POST', path: SCHEDULES, handler: createSchedule },
  { op: 'updateOrganizationDevicesPacketCaptureSchedule', method: 'PUT', path: `${SCHEDULES}/{scheduleId}`, handler: updateSchedule },
  {
    op: 'deleteOrganizationDevicesPacketCaptureSchedule',
    method: 'DELETE',
    path: `${SCHEDULES}/{scheduleId}`,
    handler: (ctx) => {
      const { org, s } = scheduleOf(ctx);
      if (ctx.body.scheduleId != null && ctx.body.scheduleId !== s.scheduleId) throw badRequest("'scheduleId' must match the schedule in the path");
      const list = storeOf(org).schedules;
      list.splice(list.indexOf(s), 1);
    },
  },
  { op: 'reorderOrganizationDevicesPacketCaptureSchedules', method: 'POST', path: `${SCHEDULES}/reorder`, status: 200, handler: reorder },
];
