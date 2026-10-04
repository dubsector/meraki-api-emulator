// Cellular gateways and their data management profiles. The MG cellular
// gateways are the only cellular devices: the org reads list them, and their
// SIMs, band masks and geolocation are kept on the device.

import { firmwareName } from './firmware.js';
import { deviceUrl } from '../format.js';
import { arrayParam, badRequest, boolParam, intParam, notFound, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { BANDS, REFRESH, SLOT, isGateway, locationAt, primarySlot, simOf, simSettings, slotsOf, towerOf, usageBetween } from '../sim/cellular.js';
import { buckets } from '../sim/usage.js';
import { lastReportedAt } from '../sim/outages.js';
import { DAY, iso, weekday } from '../time.js';
import { bySerial, devOf, orgOf } from './common.js';

const BASE = '/organizations/{organizationId}/devices/cellular';
const PROFILES = `${BASE}/data/profiles`;
const SLOTS = ['sim1', 'sim2', 'esim'];
const INTERVALS = [300, 1200, 14400, 86400];
const MAX_PROFILES = 100;
const MAX_ASSIGNMENTS = 100;
// Which start value goes with each reset term.
const STARTS = { daily: 'hourOfDay', weekly: 'dayOfWeek', monthly: 'dayOfMonth' };

const storeOf = (org) => (org.cellularData ??= { created: 0, rulesCreated: 0, assignmentsCreated: 0, profiles: [], assignments: [] });
const isCellular = isGateway;

// The cellular devices an endpoint reports on, by serial.
function cellularDevices(ctx, org, max = 1000) {
  const serials = arrayParam(ctx.query, 'serials');
  if (serials.length > max) throw badRequest(`'serials' can list at most ${max} serials`);
  return org.devices.filter((d) => isCellular(d) && (!serials.length || serials.includes(d.serial))).sort(bySerial);
}

const pageOf = (ctx, devices, opts, map) => paginateItems(ctx, devices, (d) => d.serial, opts, map);

// A cellular device the route is about.
function gatewayOf(ctx) {
  const dev = devOf(ctx);
  if (!isCellular(dev)) throw badRequest('This endpoint is only supported for MG cellular gateways');
  return dev;
}

const assignmentOf = (org, dev) => storeOf(org).assignments.find((a) => a.dev === dev);

// The usage term a device's profile sets for a slot, or the calendar month.
// Returns [start, end) and the rule's cap in bytes, if any.
function termOf(org, dev, slot, now) {
  const rule = assignmentOf(org, dev)?.profile.rules.find((r) => r.slot === slot);
  const day = Math.floor(now / DAY);
  const d = new Date(now * 1000);
  const monthStart = (y, m, dom) => Date.UTC(y, m, Math.min(dom, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / 1000;
  const starts = rule?.cap.term.starts ?? { dayOfMonth: 1 };
  let start;
  let end;
  if (starts.hourOfDay != null) {
    start = day * DAY + starts.hourOfDay * 3600;
    if (start > now) start -= DAY;
    end = start + DAY;
  } else if (starts.dayOfWeek != null) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(starts.dayOfWeek.toLowerCase());
    start = (day - ((weekday(day) - want + 7) % 7)) * DAY;
    end = start + 7 * DAY;
  } else {
    const [y, m] = [d.getUTCFullYear(), d.getUTCMonth()];
    start = monthStart(y, m, starts.dayOfMonth);
    if (start > now) start = monthStart(y, m - 1, starts.dayOfMonth);
    const next = new Date(start * 1000);
    end = monthStart(next.getUTCFullYear(), next.getUTCMonth() + 1, starts.dayOfMonth);
  }
  return { start, end, cap: rule ? rule.cap.value * 1048576 : null };
}

// Each slot with its band masks: supported bands for every signal type the
// modem has, minus those masked.
export function bandsOf(dev) {
  const masks = dev.cellularBandMasks ?? {};
  return slotsOf(dev).map((slot) => ({
    slot,
    bySignalType: dev.info.signalTypes.map((type) => {
      const masked = masks[slot]?.[type] ?? [];
      const supported = BANDS[type];
      return { type, masked, enabled: masked.includes('all') ? [] : supported.filter((b) => !masked.includes(b)), supported };
    }),
  }));
}

const geolocationOf = (dev) => dev.cellularGeolocation ?? { enabled: true };

function apnJson(a) {
  const auth = { type: a.authentication.type };
  if (a.authentication.type !== 'none') Object.assign(auth, { username: a.authentication.username, password: a.authentication.password ?? null });
  return { name: a.name, allowedIpTypes: a.allowedIpTypes, authentication: auth };
}

function simsJson(dev) {
  const s = simSettings(dev);
  return {
    sims: slotsOf(dev).map((slot) => {
      const sim = simOf(dev, slot);
      return { slot, iccid: sim.iccid, imsi: sim.imsi, msisdn: sim.msisdn, isPrimary: slot === s.order[0], status: slot === s.order[0] ? 'active' : 'standby', apns: (s.apns[slot] ?? []).map(apnJson) };
    }),
    simOrdering: s.order,
    simFailover: s.failover,
  };
}

// APNs for one slot, replacing what it had. A password left out keeps the
// one stored for the APN of that name.
function checkApns(apns, old, at) {
  if (apns.length > 3) throw badRequest(`'${at}.apns' can have at most 3 APNs`);
  const names = new Set();
  return apns.map((a, i) => {
    const where = `${at}.apns[${i}]`;
    if (typeof a.name !== 'string' || !a.name.trim()) throw badRequest(`'${where}.name' must not be empty`);
    if (names.has(a.name)) throw badRequest(`APN '${a.name}' is listed twice`);
    names.add(a.name);
    const types = a.allowedIpTypes ?? [];
    if (!types.length || types.some((t) => t !== 'ipv4' && t !== 'ipv6') || new Set(types).size !== types.length) throw badRequest(`'${where}.allowedIpTypes' must list ipv4, ipv6 or both`);
    const type = a.authentication?.type ?? 'none';
    const authentication = { type };
    if (type !== 'none') {
      const username = a.authentication.username;
      if (typeof username !== 'string' || !username) throw badRequest(`'${where}.authentication.username' is required for ${type} authentication`);
      const prev = old.find((o) => o.name === a.name)?.authentication;
      Object.assign(authentication, { username, password: a.authentication.password ?? (prev?.type !== 'none' ? prev?.password : undefined) ?? null });
    }
    return { name: a.name, allowedIpTypes: [...types], authentication };
  });
}

function updateSims(ctx) {
  const dev = gatewayOf(ctx);
  const b = ctx.body;
  const slots = slotsOf(dev);
  const cur = simSettings(dev);
  const sims = b.sims ?? [];
  const seen = new Set();
  for (const [i, x] of sims.entries()) {
    if (!slots.includes(x.slot)) throw badRequest(`'sims[${i}].slot' must be one of ${slots.join(', ')} on a ${dev.model}`);
    if (seen.has(x.slot)) throw badRequest(`SIM slot ${x.slot} is listed twice`);
    seen.add(x.slot);
    if (x.simOrder != null && !(Number.isInteger(x.simOrder) && x.simOrder >= 1 && x.simOrder <= slots.length)) throw badRequest(`'sims[${i}].simOrder' must be between 1 and ${slots.length}`);
  }
  const primaries = sims.filter((x) => x.isPrimary === true).map((x) => x.slot);
  if (primaries.length > 1) throw badRequest('Only one SIM can be primary');
  if (slots.length === 1 && sims.some((x) => x.isPrimary === false)) throw badRequest(`'isPrimary' must be true on single-SIM devices`);
  let order = cur.order;
  if (b.simOrdering != null) {
    if (b.simOrdering.length !== slots.length || slots.some((x) => !b.simOrdering.includes(x))) throw badRequest(`'simOrdering' must list each of ${slots.join(', ')} once`);
    if (primaries.length && primaries[0] !== b.simOrdering[0]) throw badRequest(`'simOrdering' must start with the primary SIM ${primaries[0]}`);
    order = [...b.simOrdering];
  } else if (sims.some((x) => x.simOrder != null)) {
    const ranks = sims.filter((x) => x.simOrder != null);
    if (new Set(ranks.map((x) => x.simOrder)).size !== ranks.length) throw badRequest("'simOrder' must be unique for each SIM");
    const rest = order.filter((x) => !ranks.some((r) => r.slot === x));
    order = [];
    for (let n = 1; n <= slots.length; n++) order.push(ranks.find((r) => r.simOrder === n)?.slot ?? rest.shift());
    if (primaries.length && primaries[0] !== order[0]) throw badRequest(`'simOrder' 1 must be the primary SIM ${primaries[0]}`);
  } else if (primaries.length) {
    order = [primaries[0], ...order.filter((x) => x !== primaries[0])];
  } else if (slots.length > 1 && sims.length) {
    throw badRequest("'isPrimary' is required on dual-SIM devices unless 'simOrdering' is given");
  }
  const apns = { ...cur.apns };
  for (const [i, x] of sims.entries()) if (x.apns != null) apns[x.slot] = checkApns(x.apns, cur.apns[x.slot] ?? [], `sims[${i}]`);
  const failover = { ...cur.failover };
  if (b.simFailover != null) {
    const { enabled, timeout } = b.simFailover;
    if (timeout != null && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600)) throw badRequest("'simFailover.timeout' must be between 1 and 3600 seconds");
    if (enabled === true && slots.length < 2) throw badRequest('SIM failover needs a device with two SIMs');
    if (enabled != null) failover.enabled = enabled;
    if (timeout != null) failover.timeout = timeout;
  }
  dev.cellularSims = { order, apns, failover };
  return simsJson(dev);
}

function updateBandMasks(ctx) {
  const dev = gatewayOf(ctx);
  const { slot, type, masked } = ctx.body;
  if (!slotsOf(dev).includes(slot)) throw badRequest(`'slot' must be one of ${slotsOf(dev).join(', ')} on a ${dev.model}`);
  if (!dev.info.signalTypes.includes(type)) throw badRequest(`'type' must be one of ${dev.info.signalTypes.join(', ')} on a ${dev.model}`);
  if (!Array.isArray(masked)) throw badRequest("'masked' must be a list of bands");
  if (masked.length > 256) throw badRequest("'masked' can list at most 256 bands");
  const list = [...new Set(masked)];
  if (list.includes('all') && list.length > 1) throw badRequest("'all' can't be combined with other bands");
  const bad = list.find((x) => x !== 'all' && !BANDS[type].includes(x));
  if (bad != null) throw badRequest(`Band '${bad}' is not supported for ${type} on a ${dev.model}`);
  const masks = (dev.cellularBandMasks ??= {});
  masks[slot] = { ...masks[slot], [type]: list.sort((x, y) => BANDS[type].indexOf(x) - BANDS[type].indexOf(y)) };
  return { bySlot: bandsOf(dev) };
}

// Data devices filters: force-included serials come back even when other
// filters drop them, and force-excluded ones never do.
function dataDevices(ctx, org) {
  const q = ctx.query;
  const slots = arrayParam(q, 'slots');
  if (slots.some((s) => !SLOTS.includes(s))) throw badRequest(`'slots' must be one or more of: ${SLOTS.join(', ')}`);
  const included = arrayParam(q, 'includedSerials');
  const excluded = arrayParam(q, 'excludedSerials');
  const profiles = arrayParam(q, 'includedProfileIds');
  const noProfiles = arrayParam(q, 'excludedProfileIds');
  const types = arrayParam(q, 'deviceTypes').map((t) => t.toLowerCase());
  const name = q.get('name')?.toLowerCase();
  const withAssigned = boolParam(q, 'includeAssigned', true);
  const all = org.devices.filter(isCellular).sort(bySerial);
  const matches = new Set(cellularDevices(ctx, org));
  return all.filter((d) => {
    if (excluded.includes(d.serial)) return false;
    if (included.includes(d.serial)) return true;
    const p = assignmentOf(org, d)?.profile;
    return (
      matches.has(d) &&
      (withAssigned || !p) &&
      (!profiles.length || (p && profiles.includes(p.profileId))) &&
      (!p || !noProfiles.includes(p.profileId)) &&
      (!types.length || types.includes(d.model.toLowerCase()) || types.includes(d.productType.toLowerCase())) &&
      slots.every((s) => slotsOf(d).includes(s)) &&
      (!name || (d.name ?? '').toLowerCase().includes(name))
    );
  });
}

function dataDeviceJson(org, d, now) {
  const p = assignmentOf(org, d)?.profile;
  return {
    serial: d.serial,
    name: d.name,
    url: deviceUrl(d),
    model: d.model.toLowerCase(),
    software: { currentVersion: { shortName: firmwareName(d, now) } },
    modems: [{ index: 0, sims: slotsOf(d).map((slot) => ({ slot, type: 'sim', active: true })) }],
    profile: { assigned: !!p, id: p?.profileId ?? null, name: p?.name ?? null },
    network: { name: d.net.name, id: d.net.id },
  };
}

// Usage per slot over the current term: only the primary SIM carries data.
function usageJson(org, d, now) {
  const primary = primarySlot(d);
  const last = Math.min(Math.floor(now / SLOT) * SLOT, lastReportedAt(d, now));
  return {
    serial: d.serial,
    bySlot: slotsOf(d).map((slot) => {
      const { start, end, cap } = termOf(org, d, slot, now);
      return { slot, isActive: true, total: String(slot === primary ? usageBetween(d, start, end, now) : 0), lastUpdatedAt: iso(last), startTs: iso(start), endTs: iso(end - 1), limit: cap == null ? null : String(cap) };
    }),
  };
}

function usageHistory(d, t0, t1, interval, now) {
  const primary = primarySlot(d);
  return {
    serial: d.serial,
    intervals: buckets(t0, t1, interval).map(([s, e]) => {
      const total = usageBetween(d, Math.max(s, t0), Math.min(e, t1), now);
      return { startTs: iso(s), endTs: iso(e), usage: { total, bySim: slotsOf(d).map((name) => ({ name, total: name === primary ? total : 0 })) } };
    }),
  };
}

// Telemetry as of the last 90 minute refresh the device was up for.
const telemetryAt = (d, now) => Math.min(Math.floor(now / REFRESH) * REFRESH, lastReportedAt(d, now));

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
    sample: { org: 1 },
    handler: (ctx) => {
      const org = orgOf(ctx);
      return pageOf(ctx, dataDevices(ctx, org), { def: 100, max: 1000 }, (d) => dataDeviceJson(org, d, ctx.now));
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
    sample: { org: 1 },
    handler: (ctx) => {
      const org = orgOf(ctx);
      return pageOf(ctx, cellularDevices(ctx, org), { def: 100, max: 1000 }, (d) => usageJson(org, d, ctx.now));
    },
  },
  {
    op: 'getOrganizationDevicesCellularDataUsageHistoryByDeviceByInterval',
    path: `${BASE}/data/usage/history/byDevice/byInterval`,
    sample: { org: 1, query: (world) => `serials[]=${world.orgs[1].devices.filter(isCellular).map((d) => d.serial).join(',')}` },
    handler: (ctx) => {
      const org = orgOf(ctx);
      if (!arrayParam(ctx.query, 'serials').length) throw badRequest("'serials' is required");
      const devices = cellularDevices(ctx, org, 10);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: DAY, lookback: 366 * DAY });
      const interval = intParam(ctx.query, 'interval', 86400);
      if (!INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
      return pageOf(ctx, devices, { def: 5, max: 10 }, (d) => usageHistory(d, t0, t1, interval, ctx.now));
    },
  },
  {
    op: 'getOrganizationDevicesCellularGeolocations',
    path: `${BASE}/geolocations`,
    sample: { org: 1 },
    handler: (ctx) => {
      return pageOf(ctx, cellularDevices(ctx, orgOf(ctx)), { def: 100, max: 1000 }, (d) => {
        const at = telemetryAt(d, ctx.now);
        const on = geolocationOf(d).enabled;
        return { serial: d.serial, geolocation: { enabled: on, ...(on ? locationAt(d, at) : { latitude: null, longitude: null }), lastReportedAt: on ? iso(at) : null } };
      });
    },
  },
  {
    op: 'getOrganizationDevicesCellularUplinksBandsByDevice',
    path: `${BASE}/uplinks/bands/byDevice`,
    sample: { org: 1 },
    handler: (ctx) => pageOf(ctx, cellularDevices(ctx, orgOf(ctx)), { def: 100, max: 1000 }, (d) => ({ serial: d.serial, bySlot: bandsOf(d) })),
  },
  {
    op: 'getOrganizationDevicesCellularUplinksTowersByDevice',
    path: `${BASE}/uplinks/towers/byDevice`,
    sample: { org: 1 },
    handler: (ctx) => pageOf(ctx, cellularDevices(ctx, orgOf(ctx)), { def: 100, max: 1000 }, (d) => ({ serial: d.serial, connection: towerOf(d) })),
  },
  {
    op: 'updateDeviceCellularGeolocations',
    method: 'PUT',
    path: '/devices/{serial}/cellular/geolocations',
    sample: { org: 1, serial: 'cellularGateway' },
    handler: (ctx) => {
      const dev = gatewayOf(ctx);
      if (typeof ctx.body.enabled !== 'boolean') throw badRequest("'enabled' must be true or false");
      dev.cellularGeolocation = { enabled: ctx.body.enabled };
      return { enabled: ctx.body.enabled };
    },
  },
  { op: 'getDeviceCellularSims', path: '/devices/{serial}/cellular/sims', sample: { org: 1, serial: 'cellularGateway' }, handler: (ctx) => simsJson(gatewayOf(ctx)) },
  { op: 'updateDeviceCellularSims', method: 'PUT', path: '/devices/{serial}/cellular/sims', sample: { org: 1, serial: 'cellularGateway' }, handler: updateSims },
  {
    op: 'createDeviceCellularUplinksBandsMasksUpdate',
    method: 'POST',
    path: '/devices/{serial}/cellular/uplinks/bands/masks/update',
    status: 200,
    sample: { org: 1, serial: 'cellularGateway' },
    handler: updateBandMasks,
  },
];
