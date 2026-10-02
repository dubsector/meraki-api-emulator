// Firmware: per-product upgrade schedules and rollbacks, plus MS staged
// upgrades (groups, their order and one staged event per network). It's all
// config: a scheduled upgrade counts as done once its time passes, but device
// firmware strings never change.

import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { DAY, HOUR, Zone, iso, parseTime, weekday } from '../time.js';
import { validTimeZone } from '../validate.js';
import { netOf, requireProduct } from './common.js';

const BASE = '/networks/{networkId}/firmwareUpgrades';
const GROUPS = `${BASE}/staged/groups`;
const GROUP = `${GROUPS}/{groupId}`;
const EVENTS = `${BASE}/staged/events`;
const MAX_GROUPS = 100;
const STAGE_TIME = HOUR;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MISSING = { groupId: '578149602163689100', status: 404 };

// Firmware trains per product, oldest first: [firmware, short name, release date].
// Networks run the middle one; the last is a beta.
const TRAINS = {
  appliance: [['wired-18-107-12', 'MX 18.107.12', '2025-04-15'], ['wired-18-211-2', 'MX 18.211.2', '2025-11-04'], ['wired-19-1-4', 'MX 19.1.4', '2026-07-21']],
  switch: [['switch-16-9-1', 'MS 16.9.1', '2025-03-11'], ['switch-17-1-4', 'MS 17.1.4', '2025-10-28'], ['switch-17-2-1', 'MS 17.2.1', '2026-08-04']],
  wireless: [['wireless-30-7-1', 'MR 30.7.1', '2025-05-06'], ['wireless-31-1-6', 'MR 31.1.6', '2025-12-09'], ['wireless-32-1-2', 'MR 32.1.2', '2026-08-18']],
  camera: [['camera-6-2', 'MV 6.2', '2025-06-10'], ['camera-6-3', 'MV 6.3', '2026-01-13'], ['camera-6-4', 'MV 6.4', '2026-08-25']],
};
const CURRENT = 1;

function version(p, i) {
  const [firmware, shortName, date] = TRAINS[p][i];
  return { id: String(hashStr(firmware) % 100000), firmware, shortName, releaseType: i === TRAINS[p].length - 1 ? 'beta' : 'stable', releaseDate: `${date}T17:00:00Z` };
}

const versionIndex = (p, id) => TRAINS[p].findIndex((_, i) => version(p, i).id === String(id));
const productsOf = (net) => net.productTypes.filter((p) => TRAINS[p]);
const newRand = (ctx, kind, parent, n) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${parent}:${n}`));

// Kept on the network, not its config, so copying a network doesn't copy schedules.
const stateOf = (net) => (net.firmware ??= { window: null, timezone: null, products: {}, rollbacks: 0 });
const windowOf = (net) => net.firmware?.window ?? { dayOfWeek: 'sun', hourOfDay: '2:00' };
const zoneOf = (net) => net.firmware?.timezone ?? net.timeZone;

// One product's firmware at time t. Every network upgraded to the current
// release about two weeks after it came out.
function productAt(net, p, t) {
  const s = net.firmware?.products[p] ?? {};
  const upgraded = Date.parse(`${TRAINS[p][CURRENT][2]}T00:00:00Z`) / 1000 + (14 + (net.key % 7)) * DAY + 3 * HOUR;
  let at = s.at ?? CURRENT;
  let last = s.last ?? { time: upgraded, from: CURRENT - 1, to: CURRENT };
  let next = s.next ? { ...s.next } : null;
  if (next && next.time <= t) {
    last = { time: next.time, from: at, to: next.to };
    at = next.to;
    next = null;
  }
  return { at, last, next, beta: s.beta ?? net.tags.includes('lab') };
}

function nextJson(p, next) {
  if (!next) return { time: '', toVersion: {} };
  if (p !== 'wireless') return { time: iso(next.time), toVersion: version(p, next.to) };
  return { time: iso(next.time), strategy: next.strategy, predownload: { enabled: next.predownload }, toVersion: version(p, next.to) };
}

function firmwareJson(net, now) {
  const products = {};
  for (const p of productsOf(net)) {
    const { at, last, next, beta } = productAt(net, p, now);
    const available = TRAINS[p].map((_, i) => i).filter((i) => i > at).map((i) => version(p, i));
    products[p] = {
      currentVersion: version(p, at),
      lastUpgrade: { time: iso(last.time), fromVersion: version(p, last.from), toVersion: version(p, last.to) },
      nextUpgrade: nextJson(p, next),
      isUpgradeAvailable: available.length > 0,
      availableVersions: available,
      participateInNextBetaRelease: beta,
    };
  }
  return { upgradeWindow: { ...windowOf(net) }, timezone: zoneOf(net), products };
}

// The next start of the weekly upgrade window, in the firmware time zone.
function nextWindow(win, tz, now) {
  const zone = new Zone(tz);
  const day = WEEKDAYS.indexOf(win.dayOfWeek);
  const hour = parseInt(win.hourOfDay, 10);
  for (let d = zone.day(now); ; d++) {
    const t = zone.midnight(d) + hour * HOUR;
    if (weekday(d) === day && t > now) return t;
  }
}

function timeOf(v, name) {
  const t = parseTime(v);
  if (Number.isNaN(t)) throw badRequest(`'${name}' must be an ISO 8601 time`);
  return t;
}

// Works out one product's new schedule without storing it, so a bad product
// later in the body leaves everything unchanged.
function planProduct(net, p, body, win, tz, now) {
  if (!productsOf(net).includes(p)) throw badRequest(`This network has no ${p} devices`);
  const cur = productAt(net, p, now);
  const n = body.nextUpgrade;
  if (n) {
    const name = `products.${p}.nextUpgrade`;
    const time = n.time ? timeOf(n.time, `${name}.time`) : null;
    if (time != null && time <= now) throw badRequest(`'${name}.time' must be in the future`);
    const id = n.toVersion?.id;
    if (id != null && id !== '') {
      const to = versionIndex(p, id);
      if (to < 0) throw badRequest(`'${id}' is not one of the ${p} firmware versions`);
      if (cur.next?.to === to) {
        if (time != null) cur.next.time = time;
      } else if (to === cur.at) {
        cur.next = null;
      } else if (to < cur.at) {
        throw badRequest(`'${id}' is older than the current ${p} firmware; use POST ${BASE.replace('{networkId}', net.id)}/rollbacks`);
      } else {
        cur.next = { time: time ?? nextWindow(win, tz, now), to };
        if (p === 'wireless') Object.assign(cur.next, { strategy: 'minimizeUpgradeTime', predownload: false });
      }
    } else if (time != null) {
      if (!cur.next) throw badRequest(`'${name}.toVersion.id' is required to schedule an upgrade`);
      cur.next.time = time;
    }
    if (p === 'wireless' && cur.next) {
      if (n.strategy) cur.next.strategy = n.strategy;
      if (n.predownload?.enabled != null) cur.next.predownload = n.predownload.enabled;
    }
  }
  if (body.participateInNextBetaRelease != null) cur.beta = body.participateInNextBetaRelease;
  return cur;
}

function updateFirmware(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  if (b.timezone != null && !validTimeZone(b.timezone)) throw badRequest(`'${b.timezone}' is not a valid time zone`);
  const win = { ...windowOf(net) };
  if (b.upgradeWindow?.dayOfWeek) win.dayOfWeek = b.upgradeWindow.dayOfWeek.slice(0, 3);
  if (b.upgradeWindow?.hourOfDay) win.hourOfDay = b.upgradeWindow.hourOfDay;
  const tz = b.timezone ?? zoneOf(net);
  const plans = Object.entries(b.products ?? {}).map(([p, body]) => [p, planProduct(net, p, body, win, tz, ctx.now)]);
  const state = stateOf(net);
  state.window = win;
  state.timezone = tz;
  for (const [p, cur] of plans) state.products[p] = cur;
  return firmwareJson(net, ctx.now);
}

function createRollback(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  const products = productsOf(net);
  const p = b.product ?? (products.length === 1 ? products[0] : null);
  if (!p) throw badRequest("'product' is required on a network with more than one product type");
  if (!products.includes(p)) throw badRequest(`This network has no ${p} devices`);
  const cur = productAt(net, p, ctx.now);
  if (cur.at === 0) throw badRequest(`There is no older ${p} firmware to roll back to`);
  let to = cur.at - 1;
  if (b.toVersion?.id != null) {
    to = versionIndex(p, b.toVersion.id);
    if (to < 0 || to >= cur.at) throw badRequest(`'toVersion.id' must be a ${p} firmware version older than the current one`);
  }
  const time = b.time ? timeOf(b.time, 'time') : ctx.now;
  if (time < ctx.now) throw badRequest("'time' must not be in the past");
  const predownload = b.predownload?.enabled ?? false;
  cur.next = { time, to };
  if (p === 'wireless') Object.assign(cur.next, { strategy: 'minimizeUpgradeTime', predownload });
  const state = stateOf(net);
  state.products[p] = cur;
  state.rollbacks++;
  return {
    product: p,
    status: time > ctx.now ? 'pending' : 'completed',
    upgradeBatchId: newRand(ctx, 'firmwareRollback', net.id, state.rollbacks).digits(18),
    time: iso(time),
    toVersion: version(p, to),
    reasons: b.reasons.map(({ category, comment }) => ({ category, comment })),
    predownload: { enabled: predownload },
  };
}

// ── Staged upgrades (MS only) ──

// Kept on the network like switch stacks, so copying a network doesn't copy them.
function stagedOf(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return { net, staged: (net.stagedUpgrades ??= { created: 0, groups: [], event: null }) };
}

// Devices and stacks are objects, so removed ones drop out and renames show up.
function prune(net, g) {
  g.devices = g.devices.filter((d) => net.switches.includes(d));
  g.stacks = g.stacks.filter((s) => net.switchStacks?.list.includes(s));
  return g;
}

function groupOf(net, staged, id) {
  const g = staged.groups.find((x) => x.id === id);
  if (!g) throw notFound('Staged upgrade group');
  return prune(net, g);
}

function groupJson(g) {
  return {
    groupId: g.id,
    name: g.name,
    description: g.description,
    isDefault: g.isDefault,
    assignedDevices: { devices: g.devices.map((d) => ({ serial: d.serial, name: d.name })), switchStacks: g.stacks.map((s) => ({ id: s.id, name: s.name })) },
  };
}

const groupRef = (g) => ({ id: g.id, name: g.name, description: g.description });

function checkText(v, name) {
  if (v.length < 1 || v.length > 255) throw badRequest(`'${name}' must be 1 to 255 characters`);
}

// Devices and stacks named in the body. A switch in a stack goes in through its stack.
function assigned(net, a) {
  const stacks = net.switchStacks?.list ?? [];
  const devices = (a.devices ?? []).map(({ serial }) => {
    const dev = net.switches.find((s) => s.serial === serial);
    if (!dev) throw badRequest(`Switch '${serial}' is not in this network`);
    const stack = stacks.find((s) => s.members.includes(dev));
    if (stack) throw badRequest(`Switch '${serial}' is in stack '${stack.name}'; assign the stack instead`);
    return dev;
  });
  const chosen = (a.switchStacks ?? []).map(({ id }) => {
    const stack = stacks.find((s) => s.id === id);
    if (!stack) throw badRequest(`Switch stack '${id}' is not in this network`);
    return stack;
  });
  if (new Set(devices).size !== devices.length) throw badRequest('Each device can only be listed once');
  if (new Set(chosen).size !== chosen.length) throw badRequest('Each switch stack can only be listed once');
  return { devices, stacks: chosen };
}

// A device or stack belongs to one group, so assigning it moves it. Only one group is the default.
function applyGroup(net, staged, g, b) {
  checkText(b.name, 'name');
  if (b.description != null) checkText(b.description, 'description');
  const a = b.assignedDevices ? assigned(net, b.assignedDevices) : null;
  g.name = b.name;
  if (b.description != null) g.description = b.description;
  g.isDefault = b.isDefault;
  if (a) Object.assign(g, a);
  for (const other of staged.groups) {
    if (other === g) continue;
    if (a) {
      other.devices = other.devices.filter((d) => !a.devices.includes(d));
      other.stacks = other.stacks.filter((s) => !a.stacks.includes(s));
    }
    if (g.isDefault) other.isDefault = false;
  }
  return groupJson(prune(net, g));
}

function createGroup(ctx) {
  const { net, staged } = stagedOf(ctx);
  if (staged.groups.length >= MAX_GROUPS) throw badRequest(`Networks are limited to ${MAX_GROUPS} staged upgrade groups in the emulator`);
  // Seeded from a count that never goes down, so the same calls give the same IDs.
  staged.created++;
  const r = newRand(ctx, 'stagedGroup', net.id, staged.created);
  let id;
  do id = r.digits(18);
  while (staged.groups.some((g) => g.id === id));
  const g = { id, name: '', description: '', isDefault: false, devices: [], stacks: [] };
  const json = applyGroup(net, staged, g, ctx.body);
  staged.groups.push(g);
  return json;
}

function deleteGroup(ctx) {
  const { net, staged } = stagedOf(ctx);
  const g = groupOf(net, staged, ctx.params.groupId);
  if (staged.event?.stages.some((s) => s.group === g && !finished(s, ctx.now))) throw badRequest(`Group '${g.name}' is in a staged upgrade that hasn't finished`);
  staged.groups.splice(staged.groups.indexOf(g), 1);
}

// Listed groups move to the front in the order given; the rest keep their order after them.
function updateStages(ctx) {
  const { net, staged } = stagedOf(ctx);
  const listed = (ctx.body._json ?? []).map(({ group }) => {
    const g = staged.groups.find((x) => x.id === group.id);
    if (!g) throw badRequest(`Staged upgrade group '${group.id}' is not in this network`);
    return g;
  });
  if (new Set(listed).size !== listed.length) throw badRequest('Each group can only be listed once');
  staged.groups = [...listed, ...staged.groups.filter((g) => !listed.includes(g))];
  return staged.groups.map((g) => ({ group: groupRef(prune(net, g)) }));
}

// Each stage takes STAGE_TIME once it starts. A canceled stage never started.
const started = (s, now) => s.canceledAt == null && s.time <= now;
const finished = (s, now) => s.canceledAt != null || now >= s.time + STAGE_TIME;

function stageJson(s, now) {
  const done = s.canceledAt == null && now >= s.time + STAGE_TIME;
  return {
    group: groupRef(s.group),
    milestones: {
      scheduledFor: iso(s.time),
      startedAt: started(s, now) ? iso(s.time) : null,
      completedAt: done ? iso(s.time + STAGE_TIME) : null,
      canceledAt: s.canceledAt != null ? iso(s.canceledAt) : null,
    },
    status: s.canceledAt != null ? 'Canceled' : done ? 'Completed' : started(s, now) ? 'In Progress' : 'Scheduled',
  };
}

function eventJson(staged, now) {
  const e = staged.event;
  if (!e) return { products: {}, stages: [], reasons: [] };
  const { id, shortName } = version('switch', e.to);
  return { products: { switch: { nextUpgrade: { toVersion: { id, shortName } } } }, stages: e.stages.map((s) => stageJson(s, now)), reasons: e.reasons.map((r) => ({ ...r })) };
}

// Times without an offset are in the network's time zone, as the spec says.
function localTime(v, tz, name) {
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(v) || /^\d+(\.\d+)?$/.test(v)) return timeOf(v, name);
  const u = Date.parse(`${v}Z`) / 1000;
  if (Number.isNaN(u)) throw badRequest(`'${name}' must be an ISO 8601 time`);
  const zone = new Zone(tz);
  return u - zone.offset(u - zone.offset(u));
}

function parseStages(net, staged, list) {
  const stages = list.map((s, i) => {
    const g = staged.groups.find((x) => x.id === s.group?.id);
    if (!g) throw badRequest(`Staged upgrade group '${s.group?.id}' is not in this network`);
    if (!s.milestones?.scheduledFor) throw badRequest(`'stages[${i}].milestones.scheduledFor' is required`);
    return { group: g, time: localTime(s.milestones.scheduledFor, zoneOf(net), `stages[${i}].milestones.scheduledFor`), canceledAt: null };
  });
  if (!stages.length) throw badRequest('At least one stage is required');
  if (new Set(stages.map((s) => s.group)).size !== stages.length) throw badRequest('Each group can only be listed once');
  return stages;
}

function eventOf(staged) {
  if (!staged.event) throw badRequest('This network has no staged upgrade event');
  return staged.event;
}

function noCatalyst(b) {
  if (b.products?.switchCatalyst) throw badRequest('This network has no Catalyst switches');
}

function createEvent(ctx) {
  const { net, staged } = stagedOf(ctx);
  const b = ctx.body;
  noCatalyst(b);
  if (staged.event?.stages.some((s) => !finished(s, ctx.now))) throw badRequest('This network already has a staged upgrade that hasn\'t finished; update, defer or roll it back instead');
  const id = b.products?.switch?.nextUpgrade?.toVersion?.id;
  if (id == null) throw badRequest("'products.switch.nextUpgrade.toVersion.id' is required");
  const to = versionIndex('switch', id);
  if (to < 0) throw badRequest(`'${id}' is not one of the switch firmware versions`);
  if (to <= productAt(net, 'switch', ctx.now).at) throw badRequest(`'${id}' is not newer than the switch firmware this network runs`);
  staged.event = { to, reasons: [], stages: parseStages(net, staged, b.stages) };
  return eventJson(staged, ctx.now);
}

// The body lists every stage. Stages that have started must stay as they are.
function updateEvent(ctx) {
  const { net, staged } = stagedOf(ctx);
  noCatalyst(ctx.body);
  const e = eventOf(staged);
  const stages = parseStages(net, staged, ctx.body.stages);
  for (const old of e.stages.filter((s) => started(s, ctx.now))) {
    const same = stages.find((s) => s.group === old.group);
    if (!same || same.time !== old.time) throw badRequest(`The stage for group '${old.group.name}' has started, so it can't be moved or removed`);
  }
  e.stages = stages;
  return eventJson(staged, ctx.now);
}

function deferEvent(ctx) {
  const { staged } = stagedOf(ctx);
  const e = eventOf(staged);
  for (const s of e.stages) if (s.canceledAt == null && s.time > ctx.now) s.time += 7 * DAY;
  return eventJson(staged, ctx.now);
}

// Started stages get new times to go back to the version the network ran
// before; pending stages are canceled.
function rollbackEvent(ctx) {
  const { net, staged } = stagedOf(ctx);
  const e = eventOf(staged);
  const begun = e.stages.filter((s) => started(s, ctx.now));
  if (!begun.length) throw badRequest('No stage has started yet, so there is nothing to roll back');
  const stages = parseStages(net, staged, ctx.body.stages);
  for (const s of stages) {
    if (!begun.some((b) => b.group === s.group)) throw badRequest(`Group '${s.group.name}' has no completed or in-progress stage to roll back`);
  }
  for (const b of begun) {
    if (!stages.some((s) => s.group === b.group)) throw badRequest(`The stage for group '${b.group.name}' has started, so it must be listed`);
  }
  const canceled = e.stages.filter((s) => s.canceledAt == null && s.time > ctx.now).map((s) => ({ ...s, canceledAt: ctx.now }));
  const reasons = (ctx.body.reasons ?? []).map(({ category, comment }) => ({ category, comment }));
  staged.event = { to: productAt(net, 'switch', ctx.now).at, reasons, stages: [...stages, ...canceled] };
  return eventJson(staged, ctx.now);
}

export default [
  { op: 'getNetworkFirmwareUpgrades', path: BASE, handler: (ctx) => firmwareJson(netOf(ctx), ctx.now) },
  { op: 'updateNetworkFirmwareUpgrades', method: 'PUT', path: BASE, handler: updateFirmware },
  { op: 'createNetworkFirmwareUpgradesRollback', method: 'POST', path: `${BASE}/rollbacks`, status: 200, handler: createRollback },
  { op: 'getNetworkFirmwareUpgradesStagedEvents', path: EVENTS, handler: (ctx) => eventJson(stagedOf(ctx).staged, ctx.now) },
  { op: 'createNetworkFirmwareUpgradesStagedEvent', method: 'POST', path: EVENTS, status: 200, handler: createEvent },
  { op: 'updateNetworkFirmwareUpgradesStagedEvents', method: 'PUT', path: EVENTS, handler: updateEvent },
  { op: 'deferNetworkFirmwareUpgradesStagedEvents', method: 'POST', path: `${EVENTS}/defer`, status: 200, handler: deferEvent },
  { op: 'rollbacksNetworkFirmwareUpgradesStagedEvents', method: 'POST', path: `${EVENTS}/rollbacks`, status: 200, handler: rollbackEvent },
  {
    op: 'getNetworkFirmwareUpgradesStagedGroups',
    path: GROUPS,
    handler: (ctx) => {
      const { net, staged } = stagedOf(ctx);
      return staged.groups.map((g) => groupJson(prune(net, g)));
    },
  },
  { op: 'createNetworkFirmwareUpgradesStagedGroup', method: 'POST', path: GROUPS, status: 200, handler: createGroup },
  {
    op: 'getNetworkFirmwareUpgradesStagedGroup',
    path: GROUP,
    sample: MISSING,
    handler: (ctx) => {
      const { net, staged } = stagedOf(ctx);
      return groupJson(groupOf(net, staged, ctx.params.groupId));
    },
  },
  {
    op: 'updateNetworkFirmwareUpgradesStagedGroup',
    method: 'PUT',
    path: GROUP,
    handler: (ctx) => {
      const { net, staged } = stagedOf(ctx);
      return applyGroup(net, staged, groupOf(net, staged, ctx.params.groupId), ctx.body);
    },
  },
  { op: 'deleteNetworkFirmwareUpgradesStagedGroup', method: 'DELETE', path: GROUP, handler: deleteGroup },
  {
    op: 'getNetworkFirmwareUpgradesStagedStages',
    path: `${BASE}/staged/stages`,
    handler: (ctx) => {
      const { net, staged } = stagedOf(ctx);
      return staged.groups.map((g) => ({ group: groupRef(prune(net, g)) }));
    },
  },
  { op: 'updateNetworkFirmwareUpgradesStagedStages', method: 'PUT', path: `${BASE}/staged/stages`, handler: updateStages },
];
