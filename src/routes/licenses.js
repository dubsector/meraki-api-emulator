// Licensing: the co-term overview, and per-device licenses with their
// assignments, queues and moves between organizations. Neither organization
// has Systems Manager seats, so the seat endpoints only ever refuse.

import { ApiError, badRequest, notFound, paginate } from '../http.js';
import { DAY, iso } from '../time.js';
import { moveLicenses } from '../world.js';
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

function licensesOverview(org, now) {
  const devices = [...org.devices, ...org.spares];
  if (org.licensing === 'co-term') {
    const counts = {};
    for (const d of devices) {
      const key = d.productType === 'wireless' ? 'MR' : d.productType === 'camera' ? 'MV' : d.model;
      counts[key] = (counts[key] || 0) + 1;
    }
    const date = new Date(org.cotermExpires * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return { status: 'OK', expirationDate: `${date} UTC`, licensedDeviceCounts: counts };
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
    systemsManager: { counts: { totalSeats: 0, activeSeats: 0, unassignedSeats: 0, orgwideEnrolledDevices: 0 } },
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
];
