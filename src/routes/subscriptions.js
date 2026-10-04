// Subscription licensing and order claims. Subscriptions wait in the pool
// (world.unclaimed.subscriptions) until a claim key or an order claim puts
// them in an organization (org.subscriptions). Only an organization already on
// subscriptions, or a new empty one, can take them; it then uses subscription
// licensing. Seats are worked out on read from the devices in bound networks.

import { MODELS } from '../catalog.js';
import { ApiError, arrayParam, badRequest, boolParam, notFound, paginate } from '../http.js';
import { smOf } from '../sim/sm.js';
import { DAY, iso, parseTime } from '../time.js';
import { orgOf } from './common.js';

const GRACE = 30 * DAY;

// [sku, name, productType, productClass, featureTier]; add-ons have no tier.
const CATALOG = [
  ['LIC-MR-E', 'MR', 'wireless', 'MR', 'essentials'],
  ['LIC-MR-A', 'MR', 'wireless', 'MR', 'advantage'],
  ['LIC-MS-100-S-E', 'MS 100 Small', 'switch', 'MS 100 Small', 'essentials'],
  ['LIC-MS-100-S-A', 'MS 100 Small', 'switch', 'MS 100 Small', 'advantage'],
  ['LIC-MS-200-M-E', 'MS 200 Medium', 'switch', 'MS 200 Medium', 'essentials'],
  ['LIC-MS-200-M-A', 'MS 200 Medium', 'switch', 'MS 200 Medium', 'advantage'],
  ['LIC-MS-400-L-E', 'MS 400 Large', 'switch', 'MS 400 Large', 'essentials'],
  ['LIC-MS-400-L-A', 'MS 400 Large', 'switch', 'MS 400 Large', 'advantage'],
  ['LIC-MX-S-E', 'MX Small', 'appliance', 'MX Small', 'essentials'],
  ['LIC-MX-S-A', 'MX Small', 'appliance', 'MX Small', 'advantage'],
  ['LIC-MX-M-E', 'MX Medium', 'appliance', 'MX Medium', 'essentials'],
  ['LIC-MX-M-A', 'MX Medium', 'appliance', 'MX Medium', 'advantage'],
  ['LIC-MX-L-E', 'MX Large', 'appliance', 'MX Large', 'essentials'],
  ['LIC-MX-L-A', 'MX Large', 'appliance', 'MX Large', 'advantage'],
  ['LIC-MV-E', 'MV', 'camera', 'MV', 'essentials'],
  ['LIC-MV-A', 'MV', 'camera', 'MV', 'advantage'],
  ['LIC-MT-E', 'MT', 'sensor', 'MT', 'essentials'],
  ['LIC-MG-E', 'MG', 'cellularGateway', 'MG', 'essentials'],
  ['LIC-SM-E', 'SM', 'systemsManager', 'SM', 'essentials'],
  ['LIC-MX-ADD-SDW', 'MX SD-WAN+', 'appliance', 'MX', null],
  ['LIC-MR-ADD-UMB', 'MR Umbrella', 'wireless', 'MR', null],
];
const ENTITLEMENTS = CATALOG.map(([sku, name, productType, productClass, featureTier]) => ({ sku, name, productType, productClass, featureTier, isAddOn: !featureTier, isFree: sku === 'LIC-MT-E' }));
const BY_SKU = new Map(ENTITLEMENTS.map((e) => [e.sku, e]));
const MX_SMALL = /^MX6[78]/;
const MX_MEDIUM = /^(MX75|MX85|VMX-[SM])$/;

// The product class a device takes a seat of, or null for kinds no subscription covers.
function productClass(d) {
  switch (d.productType) {
    case 'wireless':
      return 'MR';
    case 'camera':
      return 'MV';
    case 'sensor':
      return 'MT';
    case 'cellularGateway':
      return 'MG';
    case 'switch': {
      const series = Number(/^MS(\d)/.exec(d.model)?.[1] ?? 1);
      return series >= 3 ? 'MS 400 Large' : series === 2 ? 'MS 200 Medium' : 'MS 100 Small';
    }
    case 'appliance':
      return MX_SMALL.test(d.model) ? 'MX Small' : MX_MEDIUM.test(d.model) ? 'MX Medium' : 'MX Large';
  }
  return null;
}

// The essentials SKU that covers a class, named when seats are missing.
const essentials = (cls) => ENTITLEMENTS.find((e) => e.productClass === cls && e.featureTier === 'essentials').sku;

// Bound networks still in the organization.
const boundNets = (org, sub, ids = sub.networkIds) => org.networks.filter((n) => ids.includes(n.id));

// Seats needed per class by the devices (and enrolled Systems Manager devices) in the networks.
function seatsNeeded(nets) {
  const need = new Map();
  const add = (cls, n = 1) => cls && need.set(cls, (need.get(cls) ?? 0) + n);
  for (const n of nets) {
    for (const d of n.devices) add(productClass(d));
    add('SM', smOf(n).devices.length);
  }
  return need;
}

// Seats each entitlement gives out, filled in listed order, and the shortfall per class.
function allocate(sub, nets) {
  const need = seatsNeeded(nets);
  const assigned = sub.entitlements.map((e) => {
    const ent = BY_SKU.get(e.sku);
    if (!ent || ent.isAddOn) return 0;
    const n = Math.min(e.limit, need.get(ent.productClass) ?? 0);
    need.set(ent.productClass, (need.get(ent.productClass) ?? 0) - n);
    return n;
  });
  const missing = [...need].filter(([, n]) => n > 0).map(([productClass, quantity]) => ({ productClass, sku: essentials(productClass), quantity }));
  return { assigned, missing };
}

function statusOf(org, sub, now) {
  if (now < sub.startDate) return 'inactive';
  if (now >= sub.endDate) return 'expired';
  if (org && allocate(sub, boundNets(org, sub)).missing.length) return 'out_of_compliance';
  return 'active';
}

function subJson(org, sub, now) {
  const nets = org ? boundNets(org, sub) : [];
  const { assigned } = allocate(sub, nets);
  const seats = sub.entitlements.map((e, i) => ({ assigned: assigned[i], available: e.limit - assigned[i], limit: e.limit }));
  const sum = (k) => seats.reduce((n, s) => n + s[k], 0);
  return {
    subscriptionId: sub.id,
    name: sub.name,
    description: sub.description,
    status: statusOf(org, sub, now),
    startDate: iso(sub.startDate),
    endDate: iso(sub.endDate),
    lastUpdatedAt: iso(sub.lastUpdatedAt),
    webOrderId: sub.webOrderId,
    type: 'termed',
    smartAccount: { status: 'active', account: { ...sub.smartAccount } },
    renewalRequested: false,
    productTypes: [...new Set(sub.entitlements.map((e) => BY_SKU.get(e.sku)?.productType).filter(Boolean))],
    entitlements: sub.entitlements.map((e, i) => ({ sku: e.sku, seats: seats[i] })),
    counts: { seats: { assigned: sum('assigned'), available: sum('available'), limit: sum('limit') }, networks: nets.length, organizations: org ? 1 : 0 },
    enterpriseAgreement: { suites: [] },
  };
}

// An organization takes subscriptions once it uses them, or while it is new and empty.
function takesSubscriptions(org) {
  if (org.licensing === 'subscription') return true;
  return !!org.created && !org.networks.length && !org.devices.length && !org.spares.length && !org.cotermLicenses?.length && !org.licenses?.length;
}

function claimInto(org, sub, now) {
  org.licensing = 'subscription';
  (org.subscriptions ??= []).push(sub);
  sub.lastUpdatedAt = now;
}

// Every claimed subscription with its organization.
const claimed = (world) => world.orgs.flatMap((org) => (org.subscriptions ?? []).map((sub) => ({ org, sub })));

function orgsParam(ctx) {
  const ids = arrayParam(ctx.query, 'organizationIds');
  if (!ids.length) throw badRequest("'organizationIds' is required");
  return ids.map((id) => {
    const org = ctx.world.orgById.get(id);
    if (!org) throw badRequest(`Organization ${id} not found`);
    return org;
  });
}

// startDate=<time> matches exactly; startDate[lt|gt|lte|gte|neq]=<time> compare.
function dateFilters(q, name) {
  const tests = [];
  const ops = { '': (a, b) => a === b, lt: (a, b) => a < b, gt: (a, b) => a > b, lte: (a, b) => a <= b, gte: (a, b) => a >= b, neq: (a, b) => a !== b };
  for (const [op, test] of Object.entries(ops)) {
    const key = op ? `${name}[${op}]` : name;
    for (const v of q.getAll(key)) {
      const t = parseTime(v);
      if (Number.isNaN(t)) throw badRequest(`'${key}' must be an ISO 8601 timestamp`);
      tests.push((x) => test(x, t));
    }
  }
  return (x) => tests.every((f) => f(x));
}

function listSubscriptions(ctx) {
  const q = ctx.query;
  const orgs = orgsParam(ctx);
  const ids = arrayParam(q, 'subscriptionIds');
  const statuses = arrayParam(q, 'statuses');
  const types = arrayParam(q, 'productTypes');
  const skus = arrayParam(q, 'skus');
  const name = q.get('name')?.toLowerCase();
  const [starts, ends] = [dateFilters(q, 'startDate'), dateFilters(q, 'endDate')];
  const rows = orgs
    .flatMap((org) => (org.subscriptions ?? []).map((sub) => subJson(org, sub, ctx.now)))
    .filter((s) => !ids.length || ids.includes(s.subscriptionId))
    .filter((s) => !statuses.length || statuses.includes(s.status))
    .filter((s) => !types.length || s.productTypes.some((t) => types.includes(t)))
    .filter((s) => !skus.length || s.entitlements.some((e) => skus.includes(e.sku)))
    .filter((s) => !name || s.name.toLowerCase().includes(name))
    .filter((s) => starts(Date.parse(s.startDate) / 1000) && ends(Date.parse(s.endDate) / 1000))
    .sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : 1));
  return paginate(ctx, rows, (s) => s.subscriptionId, { def: 1000, max: 1000 });
}

function complianceStatuses(ctx) {
  const orgs = orgsParam(ctx);
  const ids = arrayParam(ctx.query, 'subscriptionIds');
  return orgs
    .flatMap((org) => (org.subscriptions ?? []).map((sub) => ({ org, sub })))
    .filter(({ sub }) => !ids.length || ids.includes(sub.id))
    .map(({ org, sub }) => ({
      subscription: { id: sub.id, name: sub.name, status: statusOf(org, sub, ctx.now) },
      violations: {
        byProductClass: allocate(sub, boundNets(org, sub)).missing.map((m) => ({
          productClass: m.productClass,
          gracePeriodEndsAt: iso(sub.lastUpdatedAt + GRACE),
          missing: { entitlements: [{ sku: m.sku, quantity: m.quantity }] },
        })),
      },
    }));
}

// The pool's subscription for a claim key, refusing one already claimed.
function byClaimKey(world, key) {
  if (typeof key !== 'string' || !key.trim()) throw badRequest("'claimKey' is required");
  const k = key.trim().toUpperCase();
  const sub = world.unclaimed.subscriptions.find((s) => s.claimKey === k);
  if (sub) return sub;
  if (claimed(world).some(({ sub: s }) => s.claimKey === k)) throw badRequest(`Claim key ${k} has already been claimed`);
  throw badRequest(`Claim key ${k} was not found`);
}

function optionalText(b, name) {
  if (b[name] == null) return undefined;
  if (!String(b[name]).trim()) throw badRequest(`'${name}' must not be empty`);
  return String(b[name]);
}

function claimSubscription(ctx) {
  const b = ctx.body;
  const sub = byClaimKey(ctx.world, b.claimKey);
  const org = ctx.world.orgById.get(b.organizationId);
  if (!org) throw badRequest(`Organization ${b.organizationId} not found`);
  if (!takesSubscriptions(org)) throw badRequest(`Organization ${org.id} does not use subscription licensing`);
  const name = optionalText(b, 'name');
  const description = optionalText(b, 'description');
  const next = { ...sub, name: name ?? sub.name, description: description ?? sub.description };
  if (boolParam(ctx.query, 'validate')) return subJson(org, { ...next, lastUpdatedAt: ctx.now }, ctx.now);
  Object.assign(sub, next);
  ctx.world.unclaimed.subscriptions.splice(ctx.world.unclaimed.subscriptions.indexOf(sub), 1);
  claimInto(org, sub, ctx.now);
  return subJson(org, sub, ctx.now);
}

function bindSubscription(ctx) {
  const found = claimed(ctx.world).find(({ sub }) => sub.id === ctx.params.subscriptionId);
  if (!found) throw notFound('Subscription');
  const { org, sub } = found;
  const ids = [...new Set(ctx.body.networkIds ?? [])];
  if (!ids.length) throw badRequest("'networkIds' must not be empty");
  const nets = ids.map((id) => {
    const n = org.networks.find((x) => x.id === id);
    if (!n) throw badRequest(`Network ${id} is not in the subscription's organization`);
    return n;
  });
  if (ctx.now >= sub.endDate) throw badRequest(`Subscription ${sub.id} has expired`);
  const after = [...new Set([...boundNets(org, sub).map((n) => n.id), ...ids])];
  // Only what the new networks add counts, so a shortfall already there doesn't block them.
  const before = new Map(allocate(sub, boundNets(org, sub)).missing.map((m) => [m.sku, m.quantity]));
  const short = allocate(sub, boundNets(org, sub, after))
    .missing.map(({ sku, quantity }) => ({ sku, quantity: quantity - (before.get(sku) ?? 0) }))
    .filter((m) => m.quantity > 0);
  const out = { subscriptionId: sub.id, networks: nets.map((n) => ({ id: n.id, name: n.name })), errors: short.length ? ['Insufficient licenses'] : [], insufficientEntitlements: short };
  if (boolParam(ctx.query, 'validate')) return out;
  if (short.length) throw new ApiError(400, [`Insufficient licenses: ${short.map((s) => `${s.quantity} x ${s.sku}`).join(', ')}`]);
  // A network is bound to one subscription at a time, so binding moves it.
  for (const other of org.subscriptions) if (other !== sub && other.networkIds.some((id) => ids.includes(id))) other.networkIds = other.networkIds.filter((id) => !ids.includes(id));
  sub.networkIds = after;
  sub.lastUpdatedAt = ctx.now;
  return out;
}

// ── Order claims ──

const DESCRIPTION = { wireless: 'Cloud Managed AP', switch: 'Cloud Managed Switch', appliance: 'Secure Router', camera: 'Cloud Managed Camera' };
const deviceLine = (model, quantity) => ({ quantity, sku: `${model}-HW`, description: `${MODELS[model].secureRouter ? 'Cisco' : 'Meraki'} ${model} ${DESCRIPTION[MODELS[model].productType] ?? 'Device'}` });

function orderOf(ctx) {
  const id = ctx.body.claimId;
  if (typeof id !== 'string' || !id.trim()) throw badRequest("'claimId' is required");
  const order = ctx.world.unclaimed.orders.find((o) => o.claimId === id.trim().toUpperCase());
  if (!order) throw badRequest(`Order claim ID ${id} was not found`);
  return order;
}

// The order's subscriptions, wherever they are now.
function orderSubs(world, order) {
  const pool = world.unclaimed.subscriptions.filter((s) => s.orderClaimId === order.claimId).map((sub) => ({ sub, isClaimed: false }));
  return [...pool, ...claimed(world).filter(({ sub }) => sub.orderClaimId === order.claimId).map(({ sub }) => ({ sub, isClaimed: true }))].sort((a, b) => (a.sub.id < b.sub.id ? -1 : 1));
}

const orderSubJson = ({ sub, isClaimed }) => ({
  subscriptionId: sub.id,
  name: sub.name,
  description: sub.description,
  startDate: iso(sub.startDate),
  endDate: iso(sub.endDate),
  isClaimed,
  counts: { seats: { limit: sub.entitlements.reduce((n, e) => n + e.limit, 0) } },
});

const shippedLeft = (world, order) => world.unclaimed.devices.filter((d) => order.serials.includes(d.serial));

function previewOrder(ctx) {
  orgOf(ctx);
  const order = orderOf(ctx);
  const byModel = new Map();
  for (const serial of order.serials) {
    const model = ctx.world.unclaimed.devices.find((d) => d.serial === serial)?.model ?? ctx.world.deviceBySerial.get(serial)?.model ?? ctx.world.orgs.flatMap((o) => o.spares).find((s) => s.serial === serial)?.model;
    if (model) byModel.set(model, (byModel.get(model) ?? 0) + 1);
  }
  return {
    claimId: order.claimId,
    resolution: { submissionStrategy: 'sync_order_claim', supportsSubscriptionSelection: true, claimableShippedDeviceCount: shippedLeft(ctx.world, order).length },
    number: order.number,
    shipping: {
      shipments: [{ shippedAt: iso(order.shippedAt), number: 1, devices: [...byModel].map(([model, n]) => deviceLine(model, n)) }],
      pending: { devices: order.pending.map((p) => deviceLine(p.model, p.quantity)) },
    },
    subscriptions: orderSubs(ctx.world, order).map(orderSubJson),
  };
}

// Shipped devices still in the pool go to the organization's inventory, and
// the subscriptions listed are claimed with their new names. Nothing changes
// unless all of it can.
function claimOrder(ctx) {
  const org = orgOf(ctx);
  const order = orderOf(ctx);
  const subs = orderSubs(ctx.world, order);
  const picks = (ctx.body.subscriptions ?? []).map((p, i) => {
    const found = subs.find((s) => s.sub.id === p.subscriptionId);
    if (!found) throw badRequest(`'subscriptions[${i}].subscriptionId' ${p.subscriptionId} is not part of this order`);
    if (found.isClaimed) throw badRequest(`Subscription ${p.subscriptionId} has already been claimed`);
    return { sub: found.sub, name: optionalText(p, 'name'), description: optionalText(p, 'description') };
  });
  if (new Set(picks.map((p) => p.sub)).size < picks.length) throw badRequest('A subscription is listed more than once');
  const devices = shippedLeft(ctx.world, order);
  if (!devices.length && !picks.length) throw badRequest(`Order ${order.number} has already been claimed`);
  if (picks.length && !takesSubscriptions(org)) throw badRequest(`Organization ${org.id} does not use subscription licensing`);

  const pool = ctx.world.unclaimed;
  pool.devices = pool.devices.filter((d) => !devices.includes(d));
  for (const d of devices) org.spares.push({ ...d, claimedAt: ctx.now });
  for (const { sub, name, description } of picks) {
    Object.assign(sub, { name: name ?? sub.name, description: description ?? sub.description });
    pool.subscriptions.splice(pool.subscriptions.indexOf(sub), 1);
    claimInto(org, sub, ctx.now);
  }
  return { claimId: order.claimId, number: order.number, serials: devices.map((d) => d.serial), subscriptions: picks.map(({ sub }) => orderSubJson({ sub, isClaimed: true })) };
}

export default [
  {
    op: 'getAdministeredLicensingSubscriptionEntitlements',
    path: '/administered/licensing/subscription/entitlements',
    handler: (ctx) => {
      const skus = arrayParam(ctx.query, 'skus');
      const type = ctx.query.get('subscriptionType');
      if (type != null && !['termed', 'unified'].includes(type)) throw badRequest("'subscriptionType' must be one of termed, unified");
      // Add-ons are only sold on termed subscriptions.
      return ENTITLEMENTS.filter((e) => (!skus.length || skus.includes(e.sku)) && (type !== 'unified' || !e.isAddOn)).map((e) => ({ ...e }));
    },
  },
  {
    op: 'getAdministeredLicensingSubscriptionSubscriptions',
    path: '/administered/licensing/subscription/subscriptions',
    sample: { query: (world) => `organizationIds[]=${world.orgs[1].id}` },
    handler: listSubscriptions,
  },
  {
    op: 'claimAdministeredLicensingSubscriptionSubscriptions',
    method: 'POST',
    path: '/administered/licensing/subscription/subscriptions/claim',
    status: 200,
    handler: claimSubscription,
  },
  {
    op: 'validateAdministeredLicensingSubscriptionSubscriptionsClaimKey',
    method: 'POST',
    path: '/administered/licensing/subscription/subscriptions/claimKey/validate',
    status: 200,
    handler: (ctx) => subJson(null, byClaimKey(ctx.world, ctx.body.claimKey), ctx.now),
  },
  {
    op: 'getAdministeredLicensingSubscriptionSubscriptionsComplianceStatuses',
    path: '/administered/licensing/subscription/subscriptions/compliance/statuses',
    sample: { query: (world) => `organizationIds[]=${world.orgs[1].id}` },
    handler: complianceStatuses,
  },
  {
    op: 'bindAdministeredLicensingSubscriptionSubscription',
    method: 'POST',
    path: '/administered/licensing/subscription/subscriptions/{subscriptionId}/bind',
    status: 200,
    // A claimed one when there is one, else one still waiting for its key.
    sample: { subscriptionId: (world) => (claimed(world)[0]?.sub ?? world.unclaimed.subscriptions[0]).id },
    handler: bindSubscription,
  },
  {
    op: 'claimOrganizationInventoryOrders',
    method: 'POST',
    path: '/organizations/{organizationId}/inventory/orders/claim',
    status: 200,
    handler: claimOrder,
  },
  {
    op: 'previewOrganizationInventoryOrders',
    method: 'POST',
    path: '/organizations/{organizationId}/inventory/orders/preview',
    status: 200,
    handler: previewOrder,
  },
];
