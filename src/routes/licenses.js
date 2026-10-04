// Licensing and inventory: co-term licenses and their moves, per-device
// licenses with their assignments, queues and moves between organizations, and
// claiming into and releasing from inventory. Neither organization has Systems
// Manager seats, so the seat endpoints only ever refuse.

import { ApiError, badRequest, boolParam, notFound, paginate } from '../http.js';
import { smOf } from '../sim/sm.js';
import { DAY, iso } from '../time.js';
import { moveLicenses, serialTaken, splitLicense } from '../world.js';
import { orgOf } from './common.js';

const EXPIRING = 90 * DAY;

function perDevice(org) {
  if (org.licensing !== 'per-device') throw new ApiError(400, ['Organization does not support per-device licensing']);
  return org;
}

function licenseOf(ctx) {
  const org = perDevice(orgOf(ctx));
  const l = org.licenses.find((x) => x.id === ctx.params.licenseId);
  if (!l) throw notFound('License');
  return { org, l };
}

// A queued license waits on its device until the ones ahead of it run out. One
// taken off its device after it started keeps running, unused.
export function licenseState(l, now) {
  if (l.headLicenseId && l.deviceSerial && l.activationDate > now) return 'recentlyQueued';
  if (!l.activationDate) return 'unused';
  if (l.expirationDate <= now) return 'expired';
  if (!l.deviceSerial) return 'unusedActive';
  return l.expirationDate - now <= EXPIRING ? 'expiring' : 'active';
}

const durationOf = (l) => (l.expirationDate ? Math.round((l.expirationDate - l.activationDate) / DAY) : l.durationInDays);
const queuedBehind = (org, l) => org.licenses.filter((q) => q.headLicenseId === l.id && q.deviceSerial);

function licenseJson(org, l, now) {
  const days = durationOf(l);
  const queued = queuedBehind(org, l);
  return {
    id: l.id,
    licenseType: l.licenseType,
    licenseKey: l.licenseKey,
    orderNumber: l.orderNumber,
    deviceSerial: l.deviceSerial,
    networkId: l.networkId,
    state: licenseState(l, now),
    seatCount: null,
    totalDurationInDays: days + queued.reduce((sum, q) => sum + durationOf(q), 0),
    durationInDays: days,
    permanentlyQueuedLicenses: queued.map((q) => ({ id: q.id, licenseType: q.licenseType, licenseKey: q.licenseKey, orderNumber: q.orderNumber, durationInDays: durationOf(q) })),
    claimDate: iso(l.claimDate),
    activationDate: l.activationDate ? iso(l.activationDate) : null,
    expirationDate: l.expirationDate ? iso(l.expirationDate) : null,
    headLicenseId: l.headLicenseId ?? null,
  };
}

function coterm(org) {
  if (org.licensing !== 'co-term') throw new ApiError(400, ['Organization does not support co-term licensing']);
  return org;
}

const expired = (l, now) => l.startedAt + l.duration * DAY <= now;
const live = (l, now) => !l.invalidatedAt && !expired(l, now);

function cotermJson(org, l, now) {
  return {
    key: l.key,
    organizationId: org.id,
    duration: l.duration,
    mode: l.mode,
    startedAt: iso(l.startedAt),
    claimedAt: iso(l.claimedAt),
    invalidated: !!l.invalidatedAt,
    invalidatedAt: l.invalidatedAt ? iso(l.invalidatedAt) : null,
    expired: expired(l, now),
    editions: l.editions,
    counts: l.counts,
  };
}

// The licensed counts come from the live co-term licenses, keyed the way the
// devices they cover are: MR, MV, or the MX or MS model.
function licensesOverview(org, now) {
  const devices = [...org.devices, ...org.spares];
  if (org.licensing === 'co-term') {
    const have = {};
    for (const d of devices) {
      const key = d.productType === 'wireless' ? 'MR' : d.productType === 'camera' ? 'MV' : d.productType === 'sensor' ? 'MT' : d.model;
      have[key] = (have[key] || 0) + 1;
    }
    const licensed = {};
    for (const l of org.cotermLicenses.filter((x) => live(x, now))) {
      for (const c of l.counts) {
        const key = c.model.replace(/ Enterprise$/, '');
        licensed[key] = (licensed[key] || 0) + c.count;
      }
    }
    const counts = {};
    for (const key of new Set([...Object.keys(have), ...Object.keys(licensed)])) if (licensed[key]) counts[key] = licensed[key];
    const covered = Object.entries(have).every(([key, n]) => n <= (licensed[key] ?? 0));
    const date = new Date(org.cotermExpires * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return { status: covered ? 'OK' : 'License Required', expirationDate: `${date} UTC`, licensedDeviceCounts: counts };
  }
  const states = org.licenses.map((l) => licenseState(l, now));
  const count = (s) => states.filter((x) => x === s).length;
  const expiring = org.licenses.filter((l, i) => states[i] === 'expiring');
  const within = (days) => expiring.filter((l) => l.expirationDate - now <= days * DAY).length;
  const unused = org.licenses.filter((l, i) => states[i] === 'unused');
  const unusedActive = org.licenses.filter((l, i) => states[i] === 'unusedActive');
  const oldest = Math.min(...unusedActive.map((l) => l.activationDate));
  return {
    licenseCount: org.licenses.length,
    states: {
      active: { count: count('active') },
      expired: { count: count('expired') },
      expiring: { count: expiring.length, critical: { thresholdInDays: 14, expiringCount: within(14) }, warning: { thresholdInDays: 90, expiringCount: within(90) - within(14) } },
      recentlyQueued: { count: count('recentlyQueued') },
      unused: { count: unused.length, soonestActivation: { activationDate: null, toActivateCount: 0 } },
      unusedActive: {
        count: unusedActive.length,
        oldestActivation: { activationDate: unusedActive.length ? iso(oldest) : null, activeCount: unusedActive.filter((l) => l.activationDate === oldest).length },
      },
    },
    licenseTypes: [{ licenseType: 'ENT', counts: { unassigned: unused.length } }],
    systemsManager: { counts: { totalSeats: 0, activeSeats: 0, unassignedSeats: 0, orgwideEnrolledDevices: org.networks.reduce((n, net) => n + smOf(net).devices.length, 0) } },
  };
}

// The license the inventory reports for a device: the one at the head of its queue.
export function deviceLicense(org, serial) {
  if (org.licensing !== 'per-device') return null;
  return org.licenses.find((l) => l.deviceSerial === serial && !l.headLicenseId) ?? org.licenses.find((l) => l.deviceSerial === serial) ?? null;
}

// Taking a license off its device. One that has started keeps running; a
// queued one that hasn't goes back to unused.
function unassign(org, l, now) {
  if (!l.deviceSerial) return;
  if (queuedBehind(org, l).length) throw badRequest(`License ${l.id} has licenses queued behind it; unassign those first`);
  if (licenseState(l, now) === 'recentlyQueued') Object.assign(l, { activationDate: null, expirationDate: null, durationInDays: durationOf(l), headLicenseId: null });
  Object.assign(l, { deviceSerial: null, networkId: null });
}

// A device that already has a running license queues a new one behind it.
// An unused license starts the day it's assigned.
function assign(org, l, serial, now) {
  const dev = org.devices.find((d) => d.serial === serial) ?? org.spares.find((d) => d.serial === serial);
  if (!dev) throw badRequest(`Device ${serial} is not in this organization`);
  if (l.deviceSerial === serial) return;
  if (licenseState(l, now) === 'expired') throw badRequest(`License ${l.id} has expired`);
  unassign(org, l, now);
  const ahead = org.licenses.filter((x) => x.deviceSerial === serial && licenseState(x, now) !== 'expired');
  if (ahead.length) {
    if (l.activationDate) throw badRequest(`Device ${serial} already has an active license, and license ${l.id} has already started`);
    const start = Math.max(...ahead.map((x) => x.expirationDate));
    const head = ahead.find((x) => !x.headLicenseId) ?? ahead[0];
    Object.assign(l, { headLicenseId: head.id, activationDate: start, expirationDate: start + l.durationInDays * DAY });
  } else if (!l.activationDate) {
    Object.assign(l, { activationDate: now, expirationDate: now + l.durationInDays * DAY });
  }
  Object.assign(l, { deviceSerial: serial, networkId: dev.net?.id ?? null });
}

// Neither organization has Systems Manager licenses, so every seat request
// names a license that can't hold seats.
function smLicense(org, id) {
  const l = (org.licenses ?? []).find((x) => x.id === id);
  if (!l) throw badRequest(`License ${id} is not in this organization`);
  if (!/^SM/.test(l.licenseType)) throw badRequest(`License ${id} is not a Systems Manager license`);
  return l;
}

function seatCount(n) {
  if (!Number.isInteger(n) || n < 1) throw badRequest("'seatCount' must be a positive integer");
}

// An organization made through the API with nothing in it yet takes on
// per-device licensing with the first licenses moved in.
function takesLicenses(org) {
  return org.licensing === 'per-device' || (org.created && !org.networks.length && !org.devices.length && !org.spares.length);
}

function moveLicensesTo(ctx) {
  const org = perDevice(orgOf(ctx));
  const { destOrganizationId: destId, licenseIds } = ctx.body;
  const dest = ctx.world.orgById.get(destId);
  if (!dest) throw badRequest(`Organization ${destId} not found`);
  if (dest === org) throw badRequest('The destination organization must be a different organization');
  if (!takesLicenses(dest)) throw badRequest(`Organization ${destId} does not support per-device licensing`);
  const ids = [...new Set(licenseIds)];
  if (!ids.length) throw badRequest("'licenseIds' must not be empty");
  const moving = [];
  for (const id of ids) {
    const l = org.licenses.find((x) => x.id === id);
    if (!l) throw badRequest(`License ${id} is not in this organization`);
    moving.push(l);
  }
  // Devices move with their licenses, so every license on them has to go too.
  const serials = new Set(moving.map((l) => l.deviceSerial).filter(Boolean));
  for (const l of org.licenses) if (serials.has(l.deviceSerial) && !moving.includes(l)) throw badRequest(`License ${l.id} is also on device ${l.deviceSerial} and must move with it`);
  moveLicenses(ctx.world, org, dest, moving);
  return { destOrganizationId: dest.id, licenseIds: ids };
}

function cotermLicenses(ctx) {
  const org = coterm(orgOf(ctx));
  const q = ctx.query;
  const flag = (name) => (q.get(name) == null ? null : boolParam(q, name));
  const [invalidated, isExpired] = [flag('invalidated'), flag('expired')];
  const rows = org.cotermLicenses
    .filter((l) => (invalidated == null || !!l.invalidatedAt === invalidated) && (isExpired == null || expired(l, ctx.now) === isExpired))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((l) => cotermJson(org, l, ctx.now));
  return paginate(ctx, rows, (l) => l.key, { def: 1000, max: 1000 });
}

// A renewal pushes the co-term date out by its term. Added devices raise the
// counts and leave the date alone.
function claimCoterm(org, l, mode, now) {
  const { orderNumber, ...license } = l;
  org.cotermLicenses.push({ ...license, mode, claimedAt: now });
  if (mode === 'renew') org.cotermExpires += l.duration * DAY;
}

// Moving counts invalidates the license and makes two new ones: the moved
// counts in the destination and, when some are left, the rest in the source.
function moveCoterm(ctx) {
  const org = coterm(orgOf(ctx));
  const { destination, licenses } = ctx.body;
  const destId = destination.organizationId;
  if (destId == null) throw badRequest("'destination.organizationId' is required");
  const dest = ctx.world.orgById.get(destId);
  if (!dest) throw badRequest(`Organization ${destId} not found`);
  if (dest === org) throw badRequest('The destination organization must be a different organization');
  if (dest.licensing !== 'co-term') throw badRequest(`Organization ${destId} does not use co-term licensing`);
  if (!licenses.length) throw badRequest("'licenses' must not be empty");
  const mode = destination.mode ?? 'addDevices';
  const plans = [];
  for (const [i, m] of licenses.entries()) {
    const l = org.cotermLicenses.find((x) => x.key === m.key);
    if (!l || !live(l, ctx.now)) throw badRequest(`License ${m.key} is not an active license in this organization`);
    if (plans.some((p) => p.l === l)) throw badRequest(`License ${m.key} is listed more than once`);
    if (!m.counts.length) throw badRequest(`'licenses[${i}].counts' must not be empty`);
    const left = new Map(l.counts.map((c) => [c.model, c.count]));
    for (const c of m.counts) {
      if (!left.has(c.model)) throw badRequest(`License ${m.key} has no ${c.model} counts`);
      if (!Number.isInteger(c.count) || c.count < 1 || c.count > left.get(c.model)) throw badRequest(`'count' for ${c.model} must be between 1 and ${left.get(c.model)}`);
      left.set(c.model, left.get(c.model) - c.count);
    }
    plans.push({ l, moved: m.counts.map((c) => ({ model: c.model, count: c.count })), left });
  }
  const remainderLicenses = [];
  const movedLicenses = [];
  for (const { l, moved, left } of plans) {
    l.invalidatedAt = ctx.now;
    const rest = l.counts.map((c) => ({ model: c.model, count: left.get(c.model) })).filter((c) => c.count > 0);
    if (rest.length) {
      const r = splitLicense(ctx.world, l, rest);
      org.cotermLicenses.push(r);
      remainderLicenses.push(cotermJson(org, r, ctx.now));
    }
    const m = splitLicense(ctx.world, l, moved);
    claimCoterm(dest, m, mode, ctx.now);
    movedLicenses.push(cotermJson(dest, dest.cotermLicenses.at(-1), ctx.now));
  }
  return { remainderLicenses, movedLicenses };
}

// Inventory claims come from the unclaimed pool: devices by serial or order,
// co-term license keys by key or order. Nothing changes unless all of it can.
function claimInventory(ctx) {
  const org = orgOf(ctx);
  const pool = ctx.world.unclaimed;
  const b = ctx.body;
  const orders = [...new Set(b.orders ?? [])];
  const serials = [...new Set((b.serials ?? []).map((s) => String(s).toUpperCase()))];
  const keys = b.licenses ?? [];
  if (!orders.length && !serials.length && !keys.length) throw badRequest("At least one of 'orders', 'serials' or 'licenses' is required");
  for (const o of orders) {
    if (!pool.devices.some((d) => d.orderNumber === o) && !pool.licenses.some((l) => l.orderNumber === o)) throw badRequest(`Order ${o} was not found or has already been claimed`);
  }
  for (const serial of serials) {
    if (pool.devices.some((d) => d.serial === serial)) continue;
    if (serialTaken(ctx.world, serial)) throw badRequest(`Device ${serial} has already been claimed`);
    throw badRequest(`Device ${serial} was not found`);
  }
  const modes = keys.map((l) => l.mode ?? 'addDevices');
  if (new Set(modes).size > 1) throw badRequest('All licenses must be claimed with the same mode');
  if (modes.filter((m) => m === 'renew').length > 1) throw badRequest('At most one renewal can be claimed at a time');
  const licenses = [];
  for (const { key } of keys) {
    const l = pool.licenses.find((x) => x.key === key);
    if (!l) throw badRequest(`License ${key} was not found or has already been claimed`);
    if (licenses.includes(l)) throw badRequest(`License ${key} is listed more than once`);
    licenses.push(l);
  }
  const ordered = pool.licenses.filter((l) => orders.includes(l.orderNumber));
  if ([...licenses, ...ordered].length && org.licensing !== 'co-term') throw badRequest('Co-term licenses cannot be claimed into an organization that uses per-device licensing');

  const devices = pool.devices.filter((d) => serials.includes(d.serial) || orders.includes(d.orderNumber));
  pool.devices = pool.devices.filter((d) => !devices.includes(d));
  for (const d of devices) org.spares.push({ ...d, claimedAt: ctx.now });
  pool.licenses = pool.licenses.filter((l) => !licenses.includes(l) && !ordered.includes(l));
  for (const l of licenses) claimCoterm(org, l, modes[0], ctx.now);
  for (const l of ordered.filter((x) => !licenses.includes(x))) claimCoterm(org, l, 'addDevices', ctx.now);
  return { orders, serials, licenses: keys.map((l, i) => ({ key: l.key, mode: modes[i] })) };
}

// Released devices go back to the unclaimed pool, and any per-device license
// on them comes off.
function releaseInventory(ctx) {
  const org = orgOf(ctx);
  const serials = [...new Set((ctx.body.serials ?? []).map((s) => String(s).toUpperCase()))];
  if (!serials.length) throw badRequest("'serials' must not be empty");
  const spares = serials.map((serial) => {
    const dev = ctx.world.deviceBySerial.get(serial);
    if (dev?.net.org === org) throw badRequest(`Device ${serial} is in network ${dev.net.id}; remove it from the network first`);
    const spare = org.spares.find((s) => s.serial === serial);
    if (!spare) throw badRequest(`Device ${serial} is not in this organization's inventory`);
    return spare;
  });
  org.spares = org.spares.filter((s) => !spares.includes(s));
  for (const l of org.licenses ?? []) if (serials.includes(l.deviceSerial)) Object.assign(l, { deviceSerial: null, networkId: null });
  for (const s of spares) ctx.world.unclaimed.devices.push({ ...s, claimedAt: null, tags: [], name: null });
  return { serials };
}

export default [
  {
    op: 'getOrganizationLicensesOverview',
    path: '/organizations/{organizationId}/licenses/overview',
    handler: (ctx) => licensesOverview(orgOf(ctx), ctx.now),
  },
  {
    op: 'getOrganizationLicenses',
    path: '/organizations/{organizationId}/licenses',
    sample: { org: 1 },
    handler: (ctx) => {
      const org = perDevice(orgOf(ctx));
      const q = ctx.query;
      const state = q.get('state');
      const rows = org.licenses
        .map((l) => licenseJson(org, l, ctx.now))
        .filter((l) => (!q.get('deviceSerial') || l.deviceSerial === q.get('deviceSerial')) && (!q.get('networkId') || l.networkId === q.get('networkId')) && (!state || l.state === state));
      return paginate(ctx, rows, (l) => l.id, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationLicense',
    path: '/organizations/{organizationId}/licenses/{licenseId}',
    sample: { org: 1, licenseId: (world) => world.orgs[1].licenses[0].id },
    handler: (ctx) => {
      const { org, l } = licenseOf(ctx);
      return licenseJson(org, l, ctx.now);
    },
  },
  {
    op: 'updateOrganizationLicense',
    method: 'PUT',
    path: '/organizations/{organizationId}/licenses/{licenseId}',
    handler: (ctx) => {
      const { org, l } = licenseOf(ctx);
      const serial = ctx.body.deviceSerial;
      if (serial === null) unassign(org, l, ctx.now);
      else if (serial !== undefined) assign(org, l, serial, ctx.now);
      return licenseJson(org, l, ctx.now);
    },
  },
  {
    op: 'moveOrganizationLicenses',
    method: 'POST',
    path: '/organizations/{organizationId}/licenses/move',
    status: 200,
    handler: moveLicensesTo,
  },
  {
    op: 'assignOrganizationLicensesSeats',
    method: 'POST',
    path: '/organizations/{organizationId}/licenses/assignSeats',
    status: 200,
    handler: (ctx) => {
      const org = orgOf(ctx);
      seatCount(ctx.body.seatCount);
      smLicense(org, ctx.body.licenseId);
    },
  },
  {
    op: 'moveOrganizationLicensesSeats',
    method: 'POST',
    path: '/organizations/{organizationId}/licenses/moveSeats',
    status: 200,
    handler: (ctx) => {
      const org = orgOf(ctx);
      if (!ctx.world.orgById.has(ctx.body.destOrganizationId)) throw badRequest(`Organization ${ctx.body.destOrganizationId} not found`);
      seatCount(ctx.body.seatCount);
      smLicense(org, ctx.body.licenseId);
    },
  },
  {
    op: 'renewOrganizationLicensesSeats',
    method: 'POST',
    path: '/organizations/{organizationId}/licenses/renewSeats',
    status: 200,
    handler: (ctx) => {
      const org = orgOf(ctx);
      smLicense(org, ctx.body.licenseIdToRenew);
      smLicense(org, ctx.body.unusedLicenseId);
    },
  },
  {
    op: 'getOrganizationLicensingCotermLicenses',
    path: '/organizations/{organizationId}/licensing/coterm/licenses',
    handler: cotermLicenses,
  },
  {
    op: 'moveOrganizationLicensingCotermLicenses',
    method: 'POST',
    path: '/organizations/{organizationId}/licensing/coterm/licenses/move',
    status: 200,
    handler: moveCoterm,
  },
  {
    op: 'claimIntoOrganizationInventory',
    method: 'POST',
    path: '/organizations/{organizationId}/inventory/claim',
    status: 200,
    handler: claimInventory,
  },
  {
    op: 'releaseFromOrganizationInventory',
    method: 'POST',
    path: '/organizations/{organizationId}/inventory/release',
    status: 200,
    handler: releaseInventory,
  },
];
