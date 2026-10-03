// MX local and split DNS: organization-wide profiles, local DNS records, and
// assignments mapping networks with an MX to one profile of each kind. Stored
// only; DNS answers in the sim don't change.

import { arrayParam, badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { isHostname, parseIp } from '../validate.js';
import { collection, orgOf } from './common.js';

const DNS = '/organizations/{organizationId}/appliance/dns';
const MAX_PROFILES = 1000;
const MAX_RECORDS = 10000;
const MAX_HOSTNAMES = 100;
const MAX_ASSIGN = 1000;

// IDs count up from a seeded start, so creation order is ID order.
function nextId(ctx, store, org, kind) {
  const start = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${org.id}`)).int(100000, 899999);
  return String(start + ++store.created);
}

const KINDS = {
  local: { what: 'local DNS profile', profiles: 'applianceDnsLocalProfiles', assignments: 'applianceDnsLocalAssignments' },
  split: { what: 'split DNS profile', profiles: 'applianceDnsSplitProfiles', assignments: 'applianceDnsSplitAssignments' },
};
const profilesOf = (org, kind) => (org[KINDS[kind].profiles] ??= { created: 0, list: [] });
const recordsOf = (org) => (org.applianceDnsLocalRecords ??= { created: 0, list: [] });
const assignmentsOf = (org, kind) => (org[KINDS[kind].assignments] ??= { created: 0, list: [] });

// Rows whose network was deleted drop out on read.
const liveRows = (org, kind) => assignmentsOf(org, kind).list.filter((a) => org.networks.some((n) => n.id === a.networkId));
const byProfile = (ctx, list) => {
  const ids = arrayParam(ctx.query, 'profileIds');
  return ids.length ? list.filter((x) => ids.includes(x.profileId)) : list;
};

function profileInUse(org, kind, p) {
  if (liveRows(org, kind).some((a) => a.profileId === p.profileId)) return `The ${KINDS[kind].what} '${p.name}' is assigned to a network`;
  if (kind === 'local' && recordsOf(org).list.some((r) => r.profileId === p.profileId)) return `The ${KINDS[kind].what} '${p.name}' still has DNS records`;
}

// ── Split DNS profile fields ──

// Hostname patterns are hostnames, optionally starting with a '*.' wildcard.
function checkSplit(b, self) {
  if (b.hostnames != null) {
    if (!b.hostnames.length) throw badRequest("'hostnames' must hold at least one hostname");
    if (b.hostnames.length > MAX_HOSTNAMES) throw badRequest(`'hostnames' is limited to ${MAX_HOSTNAMES} entries in the emulator`);
    for (const h of b.hostnames) if (!isHostname(h.startsWith('*.') ? h.slice(2) : h)) throw badRequest(`'${h}' is not a valid hostname pattern`);
  }
  if (b.nameservers != null || !self) {
    const addrs = b.nameservers?.addresses;
    if (addrs == null || !addrs.length) throw badRequest("'nameservers.addresses' must hold one address");
    if (addrs.length > 1) throw badRequest("'nameservers.addresses' supports a maximum of one address");
    if (parseIp(addrs[0]) == null) throw badRequest(`'${addrs[0]}' is not a valid IPv4 address`);
  }
}

function profileJson(kind, p) {
  if (kind === 'local') return { profileId: p.profileId, name: p.name };
  return { profileId: p.profileId, name: p.name, hostnames: [...p.hostnames], nameservers: { addresses: [...p.nameservers.addresses] } };
}

function profiles(kind) {
  const split = kind === 'split';
  const Kind = kind[0].toUpperCase() + kind.slice(1);
  return collection({
    ops: { create: `createOrganizationApplianceDns${Kind}Profile`, update: `updateOrganizationApplianceDns${Kind}Profile`, delete: `deleteOrganizationApplianceDns${Kind}Profile` },
    path: `${DNS}/${kind}/profiles`,
    param: 'profileId',
    key: 'profileId',
    parent: orgOf,
    store: (org) => profilesOf(org, kind),
    scope: 'organization',
    what: KINDS[kind].what,
    nextId: (ctx, store, org) => nextId(ctx, store, org, `dns${Kind}Profile`),
    max: MAX_PROFILES,
    required: split ? ['name', 'hostnames', 'nameservers'] : ['name'],
    check: split ? (ctx, org, b, self) => checkSplit(b, self) : undefined,
    blank: () => (split ? { name: null, hostnames: [], nameservers: { addresses: [] } } : { name: null }),
    apply: (p, b) => {
      if (b.name != null) p.name = b.name;
      if (split && b.hostnames != null) p.hostnames = [...b.hostnames];
      if (split && b.nameservers?.addresses != null) p.nameservers = { addresses: [...b.nameservers.addresses] };
    },
    json: (p) => profileJson(kind, p),
    inUse: (p, org) => profileInUse(org, kind, p),
  });
}

// ── Local DNS records ──

function checkRecord(org, b, self) {
  if (b.hostname != null && !isHostname(b.hostname)) throw badRequest(`'${b.hostname}' is not a valid hostname`);
  if (b.address != null && parseIp(b.address) == null) throw badRequest(`'${b.address}' is not a valid IPv4 address`);
  if (b.profile != null || !self) {
    const id = b.profile?.id;
    if (id == null) throw badRequest("'profile.id' is required");
    if (!profilesOf(org, 'local').list.some((p) => p.profileId === String(id))) throw badRequest(`Local DNS profile ${id} does not exist in this organization`);
  }
  const hostname = (b.hostname ?? self?.hostname).toLowerCase();
  const profileId = b.profile?.id != null ? String(b.profile.id) : self.profileId;
  if (recordsOf(org).list.some((r) => r !== self && r.profileId === profileId && r.hostname.toLowerCase() === hostname)) throw badRequest(`A DNS record for '${hostname}' already exists in local DNS profile ${profileId}`);
}

const records = collection({
  ops: { create: 'createOrganizationApplianceDnsLocalRecord', update: 'updateOrganizationApplianceDnsLocalRecord', delete: 'deleteOrganizationApplianceDnsLocalRecord' },
  path: `${DNS}/local/records`,
  param: 'recordId',
  key: 'recordId',
  parent: orgOf,
  store: recordsOf,
  scope: 'organization',
  unique: false,
  what: 'local DNS record',
  nextId: (ctx, store, org) => nextId(ctx, store, org, 'dnsLocalRecord'),
  max: MAX_RECORDS,
  required: ['hostname', 'address', 'profile'],
  check: (ctx, org, b, self) => checkRecord(org, b, self),
  blank: () => ({ hostname: null, address: null, profileId: null }),
  apply: (r, b) => {
    if (b.hostname != null) r.hostname = b.hostname;
    if (b.address != null) r.address = b.address;
    if (b.profile?.id != null) r.profileId = String(b.profile.id);
  },
  json: recordJson,
});

function recordJson(r) {
  return { recordId: r.recordId, hostname: r.hostname, address: r.address, profile: { id: r.profileId } };
}

// ── Assignments ──

const assignmentJson = (a) => ({ assignmentId: a.assignmentId, network: { id: a.networkId }, profile: { id: a.profileId } });

function listAssignments(kind) {
  return (ctx) => {
    const org = orgOf(ctx);
    const nets = arrayParam(ctx.query, 'networkIds');
    const rows = byProfile(ctx, liveRows(org, kind)).filter((a) => !nets.length || nets.includes(a.networkId));
    return { items: rows.map(assignmentJson), meta: { counts: { items: { total: rows.length, remaining: 0 } } } };
  };
}

// Each network with an MX takes one profile of each kind. A network that
// already has one is refused, as is one named twice in the same request.
function bulkCreate(kind) {
  return (ctx) => {
    const org = orgOf(ctx);
    const items = ctx.body.items;
    if (!items.length) throw badRequest("'items' must hold at least one assignment");
    if (items.length > MAX_ASSIGN) throw badRequest(`'items' is limited to ${MAX_ASSIGN} entries in the emulator`);
    const rows = liveRows(org, kind);
    const seen = new Set();
    const wanted = items.map((x) => {
      const netId = x.network?.id;
      const profileId = x.profile?.id;
      if (netId == null) throw badRequest("'items[].network.id' is required");
      if (profileId == null) throw badRequest("'items[].profile.id' is required");
      const net = org.networks.find((n) => n.id === netId);
      if (!net) throw badRequest(`Network ${netId} does not exist in this organization`);
      if (!net.productTypes.includes('appliance')) throw badRequest(`Network ${netId} has no appliance`);
      if (!profilesOf(org, kind).list.some((p) => p.profileId === String(profileId))) throw badRequest(`The ${KINDS[kind].what} ${profileId} does not exist in this organization`);
      if (seen.has(netId)) throw badRequest(`Network ${netId} is named more than once`);
      if (rows.some((a) => a.networkId === netId)) throw badRequest(`Network ${netId} already has a ${KINDS[kind].what} assigned`);
      seen.add(netId);
      return { networkId: netId, profileId: String(profileId) };
    });
    const store = assignmentsOf(org, kind);
    const made = wanted.map((w) => ({ assignmentId: nextId(ctx, store, org, `dns${kind}Assignment`), ...w }));
    store.list.push(...made);
    return { items: made.map(assignmentJson) };
  };
}

function bulkDelete(kind) {
  return (ctx) => {
    const org = orgOf(ctx);
    const store = assignmentsOf(org, kind);
    if (!ctx.body.items.length) throw badRequest("'items' must hold at least one assignment");
    // Rows of deleted networks are gone as far as reads go.
    const rows = liveRows(org, kind);
    const gone = ctx.body.items.map((x) => {
      if (x.assignmentId == null) throw badRequest("'items[].assignmentId' is required");
      const a = rows.find((r) => r.assignmentId === String(x.assignmentId));
      if (!a) throw badRequest(`Assignment ${x.assignmentId} does not exist in this organization`);
      return a;
    });
    store.list = store.list.filter((a) => !gone.includes(a));
    return { items: [...new Set(gone)].map(assignmentJson) };
  };
}

const local = profiles('local');
const split = profiles('split');
const listProfiles = (kind) => (ctx) => byProfile(ctx, profilesOf(orgOf(ctx), kind).list).map((p) => profileJson(kind, p));

function assignmentRoutes(kind, createOp, deleteOp) {
  const base = `${DNS}/${kind}/profiles/assignments`;
  const Kind = kind[0].toUpperCase() + kind.slice(1);
  return [
    { op: `getOrganizationApplianceDns${Kind}ProfilesAssignments`, path: base, handler: listAssignments(kind) },
    { op: createOp, method: 'POST', path: `${base}/bulkCreate`, status: 200, handler: bulkCreate(kind) },
    { op: deleteOp, method: 'POST', path: `${base}/bulkDelete`, status: 200, handler: bulkDelete(kind) },
  ];
}

export default [
  { op: 'getOrganizationApplianceDnsLocalProfiles', path: `${DNS}/local/profiles`, handler: listProfiles('local') },
  ...local.routes,
  ...assignmentRoutes('local', 'bulkOrganizationApplianceDnsLocalProfilesAssignmentsCreate', 'createOrganizationApplianceDnsLocalProfilesAssignmentsBulkDelete'),
  { op: 'getOrganizationApplianceDnsLocalRecords', path: `${DNS}/local/records`, handler: (ctx) => byProfile(ctx, recordsOf(orgOf(ctx)).list).map(recordJson) },
  ...records.routes,
  { op: 'getOrganizationApplianceDnsSplitProfiles', path: `${DNS}/split/profiles`, handler: listProfiles('split') },
  ...split.routes,
  ...assignmentRoutes('split', 'createOrganizationApplianceDnsSplitProfilesAssignmentsBulkCreate', 'createOrganizationApplianceDnsSplitProfilesAssignmentsBulkDelete'),
];
