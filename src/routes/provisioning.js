// Device provisioning: claiming into and removing from networks, virtual MXs,
// provisioning statuses, Catalyst device details, bulk device swaps and
// migrations to a wireless controller.

import { VMX_SIZES } from '../catalog.js';
import { deviceJson } from '../format.js';
import { ApiError, arrayParam, badRequest, boolParam, hasTags, notFound, paginate, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { MIN, iso } from '../time.js';
import { claimDevice, claimVmx, removeDevice, swapDevice } from '../world.js';
import { bySerial, netOf, orgOf, requireProduct } from './common.js';

// The details claim and bulkUpdate accept, all for Catalyst devices.
const DETAILS = ['device mode', 'username', 'password', 'enable password', 'ap mapping type', 'ap network id'];
const MAX_SWAPS = 100;

function checkDetails(details, at) {
  for (const [i, d] of details.entries()) {
    if (!DETAILS.includes(d.name.toLowerCase())) throw badRequest(`'${at}[${i}].name' must be one of: ${DETAILS.join(', ')}`);
  }
}

// Where a serial stands: in one of this org's networks, in its inventory, or elsewhere.
function locate(world, org, serial) {
  const dev = world.deviceBySerial.get(serial);
  if (dev) return { dev, ours: dev.net.org === org };
  const spare = org.spares.find((s) => s.serial === serial);
  if (spare) return { spare, ours: true };
  return { elsewhere: world.orgs.some((o) => o.spares.some((s) => s.serial === serial)) };
}

function claim(ctx) {
  const net = netOf(ctx);
  const { serials, detailsByDevice = [] } = ctx.body;
  if (!serials.length) throw badRequest("'serials' must not be empty");
  for (const [i, d] of detailsByDevice.entries()) checkDetails(d.details, `detailsByDevice[${i}].details`);
  const atomic = boolParam(ctx.query, 'addAtomically', true);
  const ok = [];
  const errors = [];
  for (const serial of new Set(serials.map((s) => String(s).toUpperCase()))) {
    const at = locate(ctx.world, net.org, serial);
    if (at.dev || at.elsewhere) errors.push({ serial, errors: ['Device already claimed'] });
    else if (!at.spare) errors.push({ serial, errors: ["Device not found in this organization's inventory"] });
    else ok.push(at.spare);
  }
  if (atomic && errors.length) throw new ApiError(400, errors.map((e) => `${e.serial}: ${e.errors.join(', ')}`));
  for (const spare of ok) claimDevice(ctx.world, net, spare);
  return { serials: ok.map((s) => s.serial), errors };
}

function vmx(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'appliance');
  if (net.mx) throw badRequest(`This network already has an appliance (${net.mx.serial})`);
  return deviceJson(claimVmx(ctx.world, net, VMX_SIZES[ctx.body.size], ctx.now));
}

function remove(ctx) {
  const net = netOf(ctx);
  const dev = ctx.world.deviceBySerial.get(String(ctx.body.serial).toUpperCase());
  if (!dev || dev.net !== net) throw notFound('Device');
  removeDevice(ctx.world, dev);
}

// A device in a network is fully provisioned; one still in inventory isn't started.
function provisioningStatuses(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const status = q.get('status');
  if (status && !['unprovisioned', 'incomplete', 'complete'].includes(status)) throw badRequest("'status' must be one of: unprovisioned, incomplete, complete");
  const [networkIds, productTypes, serials, tags] = ['networkIds', 'productTypes', 'serials', 'tags'].map((n) => arrayParam(q, n));
  const mode = q.get('tagsFilterType') || 'withAnyTags';
  const rows = [...org.devices, ...org.spares]
    .map((d) => ({ d, status: d.net ? 'complete' : 'unprovisioned' }))
    .filter(
      ({ d, status: s }) =>
        (!status || s === status) &&
        (!networkIds.length || (d.net && networkIds.includes(d.net.id))) &&
        (!productTypes.length || productTypes.includes(d.productType)) &&
        (!serials.length || serials.includes(d.serial)) &&
        hasTags(d.tags, tags, mode),
    )
    .sort((a, b) => bySerial(a.d, b.d))
    .map(({ d, status: s }) => ({ mac: d.mac, name: d.name, network: d.net ? { id: d.net.id } : null, productType: d.productType, serial: d.serial, status: s, tags: d.tags }));
  return paginate(ctx, rows, (r) => r.serial, { def: 1000, max: 1000 });
}

function bulkDetails(ctx) {
  const org = orgOf(ctx);
  const { serials, details } = ctx.body;
  checkDetails(details, 'details');
  for (const s of serials) {
    const at = locate(ctx.world, org, String(s).toUpperCase());
    if (!at.ours || !(at.dev || at.spare)) throw badRequest(`Device ${s} is not in this organization`);
  }
  return { serials };
}

function deviceRef(d) {
  return { mac: d.mac, serial: d.serial, model: d.model, name: d.name ?? d.mac };
}

// Swaps run as soon as they're asked for. The response still says pending,
// like the real API's, and the job reads as complete from then on.
function swaps(ctx) {
  const org = orgOf(ctx);
  const list = ctx.body.swaps;
  if (!list.length) throw badRequest("'swaps' must not be empty");
  if (list.length > MAX_SWAPS) throw badRequest(`At most ${MAX_SWAPS} swaps can be sent at once`);
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:swap:${org.id}:${(org.swapJobs ??= new Map()).size}`));
  const jobId = r.digits(13);
  const createdAt = iso(ctx.now);
  const out = [];
  for (const [i, s] of list.entries()) {
    const oldSerial = String(s.devices.old).toUpperCase();
    const newSerial = String(s.devices.new).toUpperCase();
    const from = locate(ctx.world, org, oldSerial);
    const to = locate(ctx.world, org, newSerial);
    const errors = [];
    if (!from.dev || !from.ours) errors.push(`Device ${oldSerial} is not in a network in this organization`);
    if (!to.spare) errors.push(to.dev && to.ours ? `Device ${newSerial} is already in a network` : `Device ${newSerial} is not in this organization's inventory`);
    // Swaps run in order, so a device an earlier swap used is no longer free.
    const oldDev = from.dev && from.ours ? from.dev : null;
    if (oldDev && to.spare && !errors.length) {
      if (oldDev.productType !== to.spare.productType) errors.push(`Device ${newSerial} is a ${to.spare.productType} device and ${oldSerial} is a ${oldDev.productType} device`);
      else if (oldDev.productType === 'switch' && oldDev.model !== to.spare.model) errors.push(`Switches can only be swapped for the same model (${oldDev.model})`);
    }
    const id = i === 0 ? jobId : r.digits(13);
    const old = oldDev ? deviceRef(oldDev) : { mac: null, serial: oldSerial, model: null, name: null };
    const neu = to.spare ? deviceRef(to.spare) : { mac: null, serial: newSerial, model: null, name: null };
    if (errors.length) {
      out.push({ id, devices: { old, new: neu }, status: 'failed', afterAction: s.afterAction, createdAt, completedAt: createdAt, errors });
      continue;
    }
    swapDevice(ctx.world, oldDev, to.spare, s.afterAction);
    neu.name = oldDev.name ?? neu.mac;
    out.push({ id, devices: { old, new: neu }, status: 'complete', afterAction: s.afterAction, createdAt, completedAt: createdAt, errors: [] });
  }
  const job = { jobId, swaps: out };
  org.swapJobs.set(jobId, job);
  const pending = (x) => (x.status === 'complete' ? { ...x, status: 'pending', completedAt: null } : x);
  return { jobId, swaps: out.map(pending) };
}

// An AP starts its move to the controller a few minutes after it's asked to.
// The migration is a record only: the AP stays in its network.
const MIGRATION_DELAY = 5 * MIN;
const migrationsOf = (org) => (org.controllerMigrations ??= []);
const migrationJson = (m, now) => ({ serial: m.serial, target: m.target, createdAt: iso(m.createdAt), migratedAt: now >= m.createdAt + MIGRATION_DELAY ? iso(m.createdAt + MIGRATION_DELAY) : null });

function migrate(ctx) {
  const org = orgOf(ctx);
  const { serials = [], target } = ctx.body;
  const unique = [...new Set(serials ?? [])];
  if (!unique.length) throw badRequest("'serials' must not be empty");
  const list = migrationsOf(org);
  for (const serial of unique) {
    const dev = org.devices.find((d) => d.serial === serial);
    if (!dev) throw badRequest(`Device ${serial} is not in a network in this organization`);
    if (dev.productType !== 'wireless') throw badRequest(`Device ${serial} is not an access point; only access points can move to a wireless controller`);
    if (list.some((m) => m.serial === serial && m.target === target)) throw badRequest(`Device ${serial} is already migrating to ${target}`);
  }
  const made = unique.map((serial) => ({ serial, target, createdAt: ctx.now }));
  list.push(...made);
  return made.map((m) => migrationJson(m, ctx.now));
}

function migrations(ctx) {
  const org = orgOf(ctx);
  const [serials, networkIds] = ['serials', 'networkIds'].map((n) => arrayParam(ctx.query, n));
  const target = ctx.query.get('target');
  const netOfSerial = (serial) => org.devices.find((d) => d.serial === serial)?.net.id;
  const rows = migrationsOf(org)
    .filter((m) => (!serials.length || serials.includes(m.serial)) && (!networkIds.length || networkIds.includes(netOfSerial(m.serial))) && (!target || m.target === target))
    .sort((a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0));
  return paginateItems(ctx, rows, (m) => m.serial, { def: 100, max: 1000 }, (m) => migrationJson(m, ctx.now));
}

export default [
  {
    op: 'claimNetworkDevices',
    method: 'POST',
    status: 200,
    path: '/networks/{networkId}/devices/claim',
    handler: claim,
  },
  {
    op: 'vmxNetworkDevicesClaim',
    method: 'POST',
    status: 200,
    path: '/networks/{networkId}/devices/claim/vmx',
    handler: vmx,
  },
  {
    op: 'removeNetworkDevices',
    method: 'POST',
    status: 204,
    path: '/networks/{networkId}/devices/remove',
    handler: remove,
  },
  {
    op: 'getOrganizationDevicesProvisioningStatuses',
    path: '/organizations/{organizationId}/devices/provisioning/statuses',
    handler: provisioningStatuses,
  },
  {
    op: 'bulkUpdateOrganizationDevicesDetails',
    method: 'POST',
    status: 200,
    path: '/organizations/{organizationId}/devices/details/bulkUpdate',
    handler: bulkDetails,
  },
  {
    op: 'createOrganizationInventoryDevicesSwapsBulk',
    method: 'POST',
    status: 207,
    path: '/organizations/{organizationId}/inventory/devices/swaps/bulk',
    handler: swaps,
  },
  {
    op: 'getOrganizationInventoryDevicesSwapsBulk',
    path: '/organizations/{organizationId}/inventory/devices/swaps/bulk/{id}',
    sample: { id: '1284392014819', status: 404 },
    handler: (ctx) => {
      const job = orgOf(ctx).swapJobs?.get(ctx.params.id);
      if (!job) throw notFound('Swap job');
      return structuredClone(job);
    },
  },
  {
    op: 'createOrganizationDevicesControllerMigration',
    method: 'POST',
    path: '/organizations/{organizationId}/devices/controller/migrations',
    handler: migrate,
  },
  {
    op: 'getOrganizationDevicesControllerMigrations',
    path: '/organizations/{organizationId}/devices/controller/migrations',
    handler: migrations,
  },
];
