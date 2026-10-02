// Cellular gateways and their data management profiles. The catalog has no
// cellular gateways or MX models with a modem, so the device reads are empty
// lists and assignments refuse every serial. Profiles are still stored.

import { arrayParam, badRequest, intParam, notFound, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { DAY, iso } from '../time.js';
import { orgOf } from './common.js';

const BASE = '/organizations/{organizationId}/devices/cellular';
const PROFILES = `${BASE}/data/profiles`;
const SLOTS = ['sim1', 'sim2', 'esim'];
const INTERVALS = [300, 1200, 14400, 86400];
const MAX_PROFILES = 100;
const MAX_ASSIGNMENTS = 100;
// Which start value goes with each reset term.
const STARTS = { daily: 'hourOfDay', weekly: 'dayOfWeek', monthly: 'dayOfMonth' };

const storeOf = (org) => (org.cellularData ??= { created: 0, rulesCreated: 0, assignmentsCreated: 0, profiles: [], assignments: [] });
const isCellular = (d) => d.productType === 'cellularGateway';

// The cellular devices an endpoint reports on: none, so far.
function cellularDevices(ctx, org, max = 1000) {
  const serials = arrayParam(ctx.query, 'serials');
  if (serials.length > max) throw badRequest(`'serials' can list at most ${max} serials`);
  return org.devices.filter((d) => isCellular(d) && (!serials.length || serials.includes(d.serial)));
}

const empty = (ctx, opts) => paginateItems(ctx, [], (d) => d.serial, opts);

function nextId(ctx, org, kind) {
  const store = storeOf(org);
  const counter = { cellularProfile: 'created', cellularRule: 'rulesCreated', cellularAssignment: 'assignmentsCreated' }[kind];
  store[counter]++;
  return new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${org.id}:${store[counter]}`)).digits(8);
}

// One or two rules, on different SIM slots and priorities, each starting its
// term at the value that matches how often it resets.
function checkRules(rules) {
  if (!rules?.length || rules.length > 2) throw badRequest("'rules' must have one or two rules");
  for (const [i, r] of rules.entries()) {
    const at = `rules[${i}]`;
    if (r == null || r.uplink == null || r.cap?.term?.starts == null) throw badRequest(`'${at}' needs a slot, uplink and cap with its term`);
    const want = STARTS[r.cap.term.resets];
    const set = Object.values(STARTS).filter((k) => r.cap.term.starts[k] != null);
    if (set.length !== 1 || set[0] !== want) throw badRequest(`'${at}.cap.term.starts' must set only '${want}' for a ${r.cap.term.resets} term`);
    if ((r.actions?.length ?? 0) > 2) throw badRequest(`'${at}.actions' can have at most two actions`);
  }
  if (rules.length === 2) {
    if (rules[0].slot === rules[1].slot) throw badRequest('The two rules must be on different SIM slots');
    if (rules[0].uplink.priority === rules[1].uplink.priority) throw badRequest('The two rules must have different uplink priorities');
  }
}

function storeRules(ctx, org, rules) {
  return rules.map((r) => ({
    ruleId: nextId(ctx, org, 'cellularRule'),
    slot: r.slot,
    uplink: { priority: r.uplink.priority, isPreferred: r.uplink.isPreferred },
    cap: { value: r.cap.value, threshold: r.cap.threshold ?? null, term: { resets: r.cap.term.resets, starts: { [STARTS[r.cap.term.resets]]: r.cap.term.starts[STARTS[r.cap.term.resets]] } } },
    actions: (r.actions ?? []).map((a) => ({ type: a.type })),
  }));
}

const profileJson = (p) => ({ profileId: p.profileId, lastUpdatedAt: iso(p.updatedAt), name: p.name, description: p.description, rules: p.rules });

function profileOf(ctx) {
  const org = orgOf(ctx);
  const p = storeOf(org).profiles.find((x) => x.profileId === ctx.params.profileId);
  if (!p) throw notFound('Cellular data profile');
  return { org, p };
}

function createProfile(ctx) {
  const org = orgOf(ctx);
  const store = storeOf(org);
  const b = ctx.body;
  if (!b.name?.trim()) throw badRequest("'name' must not be empty");
  if (store.profiles.some((p) => p.name === b.name)) throw badRequest('Name has already been taken');
  if (store.profiles.length >= MAX_PROFILES) throw badRequest(`Organizations are limited to ${MAX_PROFILES} cellular data profiles in the emulator`);
  checkRules(b.rules);
  const p = { profileId: nextId(ctx, org, 'cellularProfile'), name: b.name, description: b.description ?? '', rules: storeRules(ctx, org, b.rules), updatedAt: ctx.now };
  store.profiles.push(p);
  return profileJson(p);
}

// An update replaces the rules whole, as the spec says.
function updateProfile(ctx) {
  const { org, p } = profileOf(ctx);
  const b = ctx.body;
  if (b.profileId != null && b.profileId !== p.profileId) throw badRequest("'profileId' must match the profile in the path");
  checkRules(b.rules);
  Object.assign(p, { rules: storeRules(ctx, org, b.rules), updatedAt: ctx.now });
  if (b.description != null) p.description = b.description;
  return profileJson(p);
}

// Each item names a profile in the organization and one of its devices,
// which would have to be a cellular one.
function assignmentItems(org, items) {
  if (!items?.length) throw badRequest("'items' must not be empty");
  if (items.length > MAX_ASSIGNMENTS) throw badRequest(`'items' can list at most ${MAX_ASSIGNMENTS} assignments`);
  const store = storeOf(org);
  return items.map((it, i) => {
    const profile = store.profiles.find((p) => p.profileId === it?.profile?.id);
    if (!profile) throw badRequest(`items[${i}]: profile ${it?.profile?.id} not found`);
    const dev = org.devices.find((d) => d.serial === it.device?.serial);
    if (!dev) throw badRequest(`items[${i}]: device ${it.device?.serial} is not in a network in this organization`);
    if (!isCellular(dev)) throw badRequest(`items[${i}]: device ${dev.serial} is not a cellular device`);
    return { profile, dev };
  });
}

export default [
  {
    op: 'getOrganizationDevicesCellularDataDevices',
    path: `${BASE}/data/devices`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const slots = arrayParam(ctx.query, 'slots');
      if (slots.some((s) => !SLOTS.includes(s))) throw badRequest(`'slots' must be one or more of: ${SLOTS.join(', ')}`);
      cellularDevices(ctx, org);
      return empty(ctx, { def: 100, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesCellularDataProfiles',
    path: PROFILES,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const store = storeOf(org);
      const ids = arrayParam(ctx.query, 'profileIds');
      const serials = arrayParam(ctx.query, 'serials');
      const assigned = (p) => store.assignments.filter((a) => a.profile === p);
      const rows = store.profiles.filter((p) => (!ids.length || ids.includes(p.profileId)) && (!serials.length || assigned(p).some((a) => serials.includes(a.dev.serial))));
      return paginateItems(ctx, rows, (p) => p.profileId, { def: 100, max: 1000 }, (p) => {
        const { rules, ...rest } = profileJson(p);
        return { ...rest, counts: { devices: { assigned: assigned(p).length } }, rules };
      });
    },
  },
  { op: 'createOrganizationDevicesCellularDataProfile', method: 'POST', path: PROFILES, status: 200, handler: createProfile },
  { op: 'updateOrganizationDevicesCellularDataProfile', method: 'PUT', path: `${PROFILES}/{profileId}`, handler: updateProfile },
  {
    op: 'deleteOrganizationDevicesCellularDataProfile',
    method: 'DELETE',
    path: `${PROFILES}/{profileId}`,
    handler: (ctx) => {
      const { org, p } = profileOf(ctx);
      const store = storeOf(org);
      store.profiles.splice(store.profiles.indexOf(p), 1);
      store.assignments = store.assignments.filter((a) => a.profile !== p);
    },
  },
  {
    op: 'getOrganizationDevicesCellularDataProfilesAssignments',
    path: `${PROFILES}/assignments`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const ids = arrayParam(ctx.query, 'profileIds');
      const serials = arrayParam(ctx.query, 'serials');
      const rows = storeOf(org).assignments.filter((a) => (!ids.length || ids.includes(a.profile.profileId)) && (!serials.length || serials.includes(a.dev.serial)));
      return paginateItems(ctx, rows, (a) => a.assignmentId, { def: 100, max: 1000 }, (a) => ({ assignmentId: a.assignmentId, profile: { id: a.profile.profileId }, device: { serial: a.dev.serial } }));
    },
  },
  {
    op: 'batchOrganizationDevicesCellularDataProfilesAssignmentsCreate',
    method: 'POST',
    path: `${PROFILES}/assignments/batchCreate`,
    status: 200,
    // A device has one profile at most, so assigning it again moves it.
    handler: (ctx) => {
      const org = orgOf(ctx);
      const store = storeOf(org);
      const made = assignmentItems(org, ctx.body.items).map(({ profile, dev }) => {
        store.assignments = store.assignments.filter((a) => a.dev !== dev);
        const a = { assignmentId: nextId(ctx, org, 'cellularAssignment'), profile, dev };
        store.assignments.push(a);
        return { assignmentId: a.assignmentId, profile: { id: profile.profileId }, device: { serial: dev.serial } };
      });
      return { items: made };
    },
  },
  {
    op: 'bulkOrganizationDevicesCellularDataProfilesAssignmentsDelete',
    method: 'POST',
    path: `${PROFILES}/assignments/bulkDelete`,
    status: 204,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const store = storeOf(org);
      const gone = assignmentItems(org, ctx.body.items).map(({ profile, dev }, i) => {
        const a = store.assignments.find((x) => x.profile === profile && x.dev === dev);
        if (!a) throw badRequest(`items[${i}]: device ${dev.serial} is not assigned to profile ${profile.profileId}`);
        return a;
      });
      store.assignments = store.assignments.filter((a) => !gone.includes(a));
    },
  },
  {
    op: 'getOrganizationDevicesCellularDataUsageByDevice',
    path: `${BASE}/data/usage/byDevice`,
    handler: (ctx) => {
      cellularDevices(ctx, orgOf(ctx));
      return empty(ctx, { def: 100, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval',
    path: `${BASE}/data/usage/history/byDevice/byInterval`,
    sample: { query: (world) => `serials[]=${world.orgs[0].devices[0].serial}` },
    handler: (ctx) => {
      const org = orgOf(ctx);
      if (!arrayParam(ctx.query, 'serials').length) throw badRequest("'serials' is required");
      cellularDevices(ctx, org, 10);
      timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 31 * DAY, lookback: 366 * DAY });
      const interval = intParam(ctx.query, 'interval', 86400);
      if (!INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
      return empty(ctx, { def: 5, max: 10 });
    },
  },
  {
    op: 'getOrganizationDevicesCellularGeolocations',
    path: `${BASE}/geolocations`,
    handler: (ctx) => {
      cellularDevices(ctx, orgOf(ctx));
      return empty(ctx, { def: 100, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesCellularUplinksBandsByDevice',
    path: `${BASE}/uplinks/bands/byDevice`,
    handler: (ctx) => {
      cellularDevices(ctx, orgOf(ctx));
      return empty(ctx, { def: 100, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesCellularUplinksTowersByDevice',
    path: `${BASE}/uplinks/towers/byDevice`,
    handler: (ctx) => {
      cellularDevices(ctx, orgOf(ctx));
      return empty(ctx, { def: 100, max: 1000 });
    },
  },
];
