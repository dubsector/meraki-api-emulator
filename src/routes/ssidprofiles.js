// Org-wide SSID profiles and their assignments to network SSIDs, the L2
// isolation allowlist and the OpenRoaming view by network. An assignment is
// recorded only: the SSID keeps answering with its own settings.

import { configOf } from '../config.js';
import { arrayParam, badRequest, boolParam, paginate, paginateItems } from '../http.js';
import { iso } from '../time.js';
import { inRange, isAddress, isHostname, merge } from '../validate.js';
import { checkHttpUrl } from '../webhooks.js';
import { collection, orgOf } from './common.js';
import { groupOfNetwork } from './orgnetworks.js';
import { wirelessNets } from './wireless.js';
import { wirelessNetIn } from './wirelesslocation.js';
import { ssidId } from './wirelessstats.js';

const PAGE = { def: 1000, max: 1000 };
const MAX_PROFILES = 100;
const MAX_ENTRIES = 1000;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const WPA3 = /^WPA3/;

// Drops nulls inside objects, so a null leaves a profile field as it was.
function clean(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (x === null ? [] : [[k, clean(x)]])));
}

const isWirelessNet = (n) => n.productTypes.includes('wireless');
const encryptedId = (net) => net.url.match(/\/n\/([^/]+)\//)[1];
const ssidName = (net, number) => configOf(net).ssids[number].name;

// ── Profiles ──

// Assignments live with the profiles; rows of a network that is gone drop out.
function profilesOf(org) {
  const store = (org.wirelessSsidProfiles ??= { created: 0, list: [], assignments: [] });
  if (store.assignments.some((a) => !org.networks.some((n) => n.id === a.networkId))) store.assignments = store.assignments.filter((a) => org.networks.some((n) => n.id === a.networkId));
  return store;
}

function blankSsid(name) {
  return {
    name,
    advertisement: { enabled: true },
    security: { mode: 'open', protocol: 'WPA2 only', encryption: { ciphers: [], akms: [] }, dhcp: { mandatory: { enabled: false } } },
    radius: {
      servers: [],
      accounting: { enabled: false, updateInterval: 60 },
      policies: { failover: { mode: 'deny' }, loadBalancing: { mode: 'priority' }, fallback: { enabled: false }, attribute: 'Filter-Id', timeout: 5, numAttempts: 3 },
      proxy: { enabled: false },
      testing: { enabled: true },
      identifiers: { calledStation: '1', nas: '' },
      das: { coa: { enabled: false } },
      eapTimers: { timeout: 5, maxRetries: 2, identity: { timeout: 5, maxRetries: 5 }, eapolKey: { maxRetries: 2, timeoutInMs: 5000 } },
    },
    addressing: {
      mode: 'Bridge mode',
      adultContentFiltering: { enabled: false },
      dnsRewrite: { enabled: false, dnsCustomNameservers: [] },
      bonjourForwarding: { enabled: false, rules: [] },
      mdns: { enabled: false, rules: [] },
      radius: { guest: { vlan: { enabled: false } }, overrideVlanTag: false },
    },
    splash: {
      mode: 'disabled',
      captivePortal: { provider: 'hosted', external: { url: '' }, hosted: { theme: { id: '' }, language: { code: 'EN' }, consent: { required: false, message: '' } } },
      redirect: { override: { enabled: false, url: '' } },
      timeout: 1440,
      auth: { simultaneousLogins: { enabled: false }, oauth: { domains: [] } },
      controllerUnreachable: { mode: 'default' },
      preAccess: { mode: 'block-all', walledGarden: { enabled: false, ranges: [] } },
    },
  };
}

// Write-only settings the profile keeps but never shows.
const blankHidden = () => ({ passphrase: null, dot11w: { enabled: false, required: false }, dot11r: { enabled: false, adaptive: false }, identityPassphrase: { personalNetwork: { enabled: false } } });

const isGarden = (v) => isAddress(v) || isHostname(String(v).replace(/^\*\./, ''));

// Works out a profile's next state from the body and checks all of it.
function checkProfile(ctx, org, b, self) {
  const next = self ? structuredClone({ precedence: self.precedence, ssid: self.ssid, hidden: self.hidden }) : { precedence: { radius: 'network' }, ssid: blankSsid(b.name), hidden: blankHidden() };
  const body = clean(b);
  if (body.precedence) merge(next.precedence, body.precedence);
  const s = body.ssid ?? {};
  const { encryption = {}, identityPassphrase, ...security } = s.security ?? {};
  const { passphrase, dot11w, dot11r, ...enc } = encryption;
  if (s.name !== undefined && !String(s.name).trim()) throw badRequest("'ssid.name' must not be empty");
  if (s.radius?.servers?.length) throw badRequest(`RADIUS server '${s.radius.servers[0].id}' does not exist in this organization`);
  if (passphrase !== undefined && (passphrase.length < 8 || passphrase.length > 63)) throw badRequest("'ssid.security.encryption.passphrase' must be 8 to 63 characters");
  const rules = s.addressing?.bonjourForwarding?.rules;
  rules?.forEach((r, i) => {
    if (!Number.isInteger(r.vlan?.id) || r.vlan.id < 1 || r.vlan.id > 4094) throw badRequest(`'ssid.addressing.bonjourForwarding.rules[${i}].vlan.id' must be a VLAN ID from 1 to 4094`);
    if (!r.services?.length) throw badRequest(`'ssid.addressing.bonjourForwarding.rules[${i}].services' needs at least one service`);
  });
  s.addressing?.mdns?.rules?.forEach((r, i) => {
    if (!r.services?.length) throw badRequest(`'ssid.addressing.mdns.rules[${i}].services' needs at least one service`);
  });
  const r = s.radius ?? {};
  if (r.accounting?.updateInterval != null) inRange(r.accounting.updateInterval, 1, 86400, 'ssid.radius.accounting.updateInterval');
  const t = r.eapTimers ?? {};
  for (const [v, name] of [
    [t.timeout, 'timeout'],
    [t.maxRetries, 'maxRetries'],
    [t.identity?.timeout, 'identity.timeout'],
    [t.identity?.maxRetries, 'identity.maxRetries'],
    [t.eapolKey?.maxRetries, 'eapolKey.maxRetries'],
    [t.eapolKey?.timeoutInMs, 'eapolKey.timeoutInMs'],
  ])
    if (v != null && v < 0) throw badRequest(`'ssid.radius.eapTimers.${name}' must not be negative`);
  const portal = s.splash?.captivePortal;
  if (portal?.external?.url) checkHttpUrl(portal.external.url, 'ssid.splash.captivePortal.external.url');
  if (s.splash?.redirect?.override?.url) checkHttpUrl(s.splash.redirect.override.url, 'ssid.splash.redirect.override.url');
  const bad = (s.splash?.auth?.oauth?.domains ?? []).find((d) => !isHostname(d));
  if (bad !== undefined) throw badRequest(`'ssid.splash.auth.oauth.domains' has an invalid domain: ${bad}`);
  const garden = (s.splash?.preAccess?.walledGarden?.ranges ?? []).find((x) => !isGarden(x));
  if (garden !== undefined) throw badRequest(`'ssid.splash.preAccess.walledGarden.ranges' has an invalid range or domain: ${garden}`);

  const { security: _s, radius: _r, ...rest } = s;
  merge(next.ssid, rest);
  merge(next.ssid.security, { ...security, encryption: enc });
  const { servers, ...radius } = r;
  merge(next.ssid.radius, radius);
  if (rules) next.ssid.addressing.bonjourForwarding.rules = rules.map((x) => ({ description: x.description ?? '', vlan: { id: x.vlan.id }, services: x.services }));
  if (s.addressing?.mdns?.rules) next.ssid.addressing.mdns.rules = s.addressing.mdns.rules.map((x) => ({ services: x.services }));
  merge(next.hidden, clean({ passphrase: passphrase ?? null, dot11w: dot11w ?? null, dot11r: dot11r ?? null, identityPassphrase: identityPassphrase ?? null }));

  const sec = next.ssid.security;
  if (sec.mode === 'psk' && !next.hidden.passphrase) throw badRequest("'ssid.security.encryption.passphrase' is required in 'psk' mode");
  if ((sec.encryption.ciphers.length || sec.encryption.akms.length) && !WPA3.test(sec.protocol)) throw badRequest("'ssid.security.encryption' ciphers and akms only apply to WPA3 protocols");
  return next;
}

const profileJson = (p) => ({ id: p.id, name: p.name, precedence: p.precedence, ssid: p.ssid });

const profiles = collection({
  ops: { create: 'createOrganizationWirelessSsidsProfile', update: 'updateOrganizationWirelessSsidsProfile', delete: 'deleteOrganizationWirelessSsidsProfile' },
  path: '/organizations/{organizationId}/wireless/ssids/profiles',
  param: 'id',
  parent: orgOf,
  store: profilesOf,
  scope: 'organization',
  what: 'SSID profile',
  kind: 'ssidProfile',
  max: MAX_PROFILES,
  required: ['name', 'ssid'],
  check: checkProfile,
  blank: () => ({ name: null }),
  apply: (p, b, org, ctx, next) => {
    if (b.name != null) p.name = b.name;
    Object.assign(p, next);
  },
  json: profileJson,
  inUse: (p, org) => {
    const n = profilesOf(org).assignments.filter((a) => a.profileId === p.id).length;
    if (n) return `SSID profile '${p.name}' is assigned to ${n} SSID${n === 1 ? '' : 's'}; unassign it first`;
  },
});

// Profiles sorted by name, filtered by name and profileIds.
function listProfiles(ctx) {
  const org = orgOf(ctx);
  const name = ctx.query.get('name')?.toLowerCase();
  const ids = arrayParam(ctx.query, 'profileIds');
  const sortBy = ctx.query.get('sortBy') ?? 'name';
  if (sortBy !== 'name') throw badRequest("'sortBy' must be name");
  const order = sortOrder(ctx);
  const list = profilesOf(org)
    .list.filter((p) => (!name || p.name.toLowerCase().includes(name)) && (!ids.length || ids.includes(p.id)))
    .sort((a, b) => order * (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return paginate(ctx, list, (p) => p.id, PAGE).map(profileJson);
}

function sortOrder(ctx) {
  const v = ctx.query.get('sortOrder') ?? 'asc';
  if (v !== 'asc' && v !== 'desc') throw badRequest("'sortOrder' must be one of: asc, desc");
  return v === 'asc' ? 1 : -1;
}

// ── Assignments ──

// The SSID a body names, by ID (any wireless network in the org, or the one
// given) or by number in the given network.
function ssidTarget(org, b) {
  const id = b.ssid?.id;
  const number = b.ssid?.number;
  const netId = b.network?.id;
  if (id == null && number == null) throw badRequest("'ssid.id' or 'ssid.number' is required");
  const net = netId == null ? null : wirelessNetIn(org, netId);
  if (id != null) {
    for (const n of net ? [net] : org.networks.filter(isWirelessNet)) {
      const i = configOf(n).ssids.findIndex((s, k) => ssidId(n, k) === id);
      if (i < 0) continue;
      if (number != null && number !== i) throw badRequest("'ssid.id' and 'ssid.number' name different SSIDs");
      return { net: n, number: i };
    }
    throw badRequest(`SSID '${id}' does not exist in this organization`);
  }
  if (!net) throw badRequest("'network.id' is required when the SSID is given by number");
  if (!Number.isInteger(number) || number < 0 || number > 14) throw badRequest("'ssid.number' must be from 0 to 14");
  return { net, number };
}

const ssidRef = (net, number) => ({ id: ssidId(net, number), number, name: ssidName(net, number) });

function assignmentJson(org, a) {
  const net = org.networks.find((n) => n.id === a.networkId);
  const p = profilesOf(org).list.find((x) => x.id === a.profileId);
  return { ssid: ssidRef(net, a.number), profile: { id: p.id, name: p.name }, network: { id: net.id, encryptedId: encryptedId(net), name: net.name } };
}

// Assigning a profile to an SSID that has one replaces it.
function assign(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const store = profilesOf(org);
  if (b.profile.id == null) throw badRequest("'profile.id' is required");
  const p = store.list.find((x) => x.id === b.profile.id);
  if (!p) throw badRequest(`SSID profile '${b.profile.id}' does not exist in this organization`);
  const { net, number } = ssidTarget(org, b);
  const row = { profileId: p.id, networkId: net.id, number };
  const i = store.assignments.findIndex((a) => a.networkId === net.id && a.number === number);
  if (i >= 0) store.assignments[i] = row;
  else store.assignments.push(row);
  return assignmentJson(org, row);
}

function unassign(ctx) {
  const org = orgOf(ctx);
  const store = profilesOf(org);
  const { net, number } = ssidTarget(org, ctx.body);
  const i = store.assignments.findIndex((a) => a.networkId === net.id && a.number === number);
  if (i < 0) throw badRequest(`SSID ${number} in network '${net.id}' has no SSID profile assigned`);
  store.assignments.splice(i, 1);
}

function listAssignments(ctx) {
  const org = orgOf(ctx);
  const nets = arrayParam(ctx.query, 'networkIds');
  const ssids = arrayParam(ctx.query, 'ssidIds');
  const ids = arrayParam(ctx.query, 'profileIds');
  const list = profilesOf(org).assignments.filter((a) => {
    const net = org.networks.find((n) => n.id === a.networkId);
    return (!nets.length || nets.includes(a.networkId)) && (!ssids.length || ssids.includes(ssidId(net, a.number))) && (!ids.length || ids.includes(a.profileId));
  });
  return paginateItems(ctx, list, (a) => `${a.networkId}:${a.number}`, PAGE, (a) => assignmentJson(org, a));
}

// Networks with their assignments; includeAllNetworks keeps those without any.
function assignmentsByNetwork(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const nets = arrayParam(q, 'networkIds');
  const groups = arrayParam(q, 'networkGroupIds');
  const ids = arrayParam(q, 'profileIds');
  const excluded = arrayParam(q, 'excludeProfileIds');
  const all = boolParam(q, 'includeAllNetworks', false);
  const search = q.get('search')?.toLowerCase();
  const sortBy = q.get('sortBy') ?? 'network';
  if (sortBy !== 'network' && sortBy !== 'group') throw badRequest("'sortBy' must be one of: group, network");
  const order = sortOrder(ctx);
  const store = profilesOf(org);
  const rows = [];
  for (const net of org.networks) {
    const group = groupOfNetwork(org, net.id);
    if (nets.length && !nets.includes(net.id)) continue;
    if (groups.length && !groups.includes(group?.groupId)) continue;
    if (search && !net.name.toLowerCase().includes(search) && !group?.name.toLowerCase().includes(search)) continue;
    const mine = store.assignments.filter((a) => a.networkId === net.id && (!ids.length || ids.includes(a.profileId)) && !excluded.includes(a.profileId));
    if (!mine.length && !all) continue;
    rows.push({ net, group, mine });
  }
  const key = (r) => (sortBy === 'group' ? [r.group?.name ?? '', r.net.name] : [r.net.name, '']);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => order * (cmp(key(a)[0], key(b)[0]) || cmp(key(a)[1], key(b)[1])) || cmp(a.net.id, b.net.id));
  return paginate(ctx, rows, (r) => r.net.id, PAGE).map(({ net, group, mine }) => ({
    id: net.id,
    name: net.name,
    ...(group ? { group: { id: group.groupId, name: group.name } } : {}),
    clientsUrl: net.url.replace('/usage/list', '/clients'),
    assignments: mine
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((a) => {
        const p = store.list.find((x) => x.id === a.profileId);
        return { profile: { id: p.id, name: p.name }, ssid: ssidRef(net, a.number) };
      }),
  }));
}

// ── L2 isolation allowlist ──

function entriesOf(org) {
  const store = (org.wirelessIsolationAllowlist ??= { created: 0, list: [] });
  if (store.list.some((e) => !org.networks.some((n) => n.id === e.networkId))) store.list = store.list.filter((e) => org.networks.some((n) => n.id === e.networkId));
  return store;
}

function entryJson(e, org) {
  const net = org.networks.find((n) => n.id === e.networkId);
  return { entryId: e.entryId, createdAt: e.createdAt, lastUpdatedAt: e.lastUpdatedAt, description: e.description, client: { mac: e.mac }, ssid: ssidRef(net, e.number), network: { id: net.id, name: net.name } };
}

function checkEntry(ctx, org, b, self) {
  const mac = b.client?.mac;
  if (!self && mac == null) throw badRequest("'client.mac' is required");
  if (mac != null && !MAC_RE.test(mac)) throw badRequest("'client.mac' must be a MAC address like 00:11:22:33:44:55");
  let net = null;
  let number = self?.number;
  if (!self) {
    if (b.network.id == null) throw badRequest("'network.id' is required");
    net = wirelessNetIn(org, b.network.id);
    number = b.ssid.number;
    if (!Number.isInteger(number) || number < 0 || number > 14) throw badRequest("'ssid.number' must be from 0 to 14");
  }
  const networkId = net?.id ?? self.networkId;
  const next = (mac ?? self.mac).toLowerCase();
  if (entriesOf(org).list.some((e) => e !== self && e.mac === next && e.networkId === networkId && e.number === number)) throw badRequest(`${next} is already on the allowlist of SSID ${number} in this network`);
  return { mac: next, networkId, number };
}

const entries = collection({
  ops: {
    create: 'createOrganizationWirelessSsidsFirewallIsolationAllowlistEntry',
    update: 'updateOrganizationWirelessSsidsFirewallIsolationAllowlistEntry',
    delete: 'deleteOrganizationWirelessSsidsFirewallIsolationAllowlistEntry',
  },
  path: '/organizations/{organizationId}/wireless/ssids/firewall/isolation/allowlist/entries',
  param: 'entryId',
  parent: orgOf,
  store: entriesOf,
  scope: 'organization',
  unique: false,
  what: 'allowlist entry',
  plural: 'allowlist entries',
  key: 'entryId',
  nextId: (ctx, store) => String(++store.created),
  max: MAX_ENTRIES,
  required: ['client', 'ssid', 'network'],
  check: checkEntry,
  blank: (ctx) => ({ createdAt: iso(ctx.now), lastUpdatedAt: null, description: '', mac: null, networkId: null, number: null }),
  apply: (e, b, org, ctx, checked) => {
    Object.assign(e, checked);
    if (b.description != null) e.description = b.description;
    e.lastUpdatedAt = iso(ctx.now);
  },
  json: entryJson,
});

function listEntries(ctx) {
  const org = orgOf(ctx);
  const nets = arrayParam(ctx.query, 'networkIds');
  const ssids = arrayParam(ctx.query, 'ssids').map(Number);
  const list = entriesOf(org).list.filter((e) => (!nets.length || nets.includes(e.networkId)) && (!ssids.length || ssids.includes(e.number)));
  return paginateItems(ctx, list, (e) => e.entryId, PAGE, (e) => entryJson(e, org));
}

// ── OpenRoaming ──

// Reads what updateNetworkWirelessSsidOpenRoaming stores; disabled SSIDs only on request.
function openRoamingByNetwork(ctx) {
  const disabled = boolParam(ctx.query, 'includeDisabledSsids', false);
  const nets = wirelessNets(ctx);
  return paginateItems(ctx, nets, (n) => n.id, PAGE, (net) => {
    const c = configOf(net);
    return {
      networkId: net.id,
      networkName: net.name,
      ssid: c.ssids
        .map((s, number) => ({ s, number }))
        .filter(({ s }) => disabled || s.enabled)
        .map(({ s, number }) => ({ name: s.name, number, enabled: s.enabled, openRoaming: { ...(c.ssidOpenRoaming?.[number] ?? { enabled: false, tenantId: null }) } })),
    };
  });
}

const ORG = '/organizations/{organizationId}/wireless/ssids';

export default [
  { op: 'getOrganizationWirelessSsidsFirewallIsolationAllowlistEntries', path: `${ORG}/firewall/isolation/allowlist/entries`, handler: listEntries },
  ...entries.routes,
  { op: 'getOrganizationWirelessSsidsOpenRoamingByNetwork', path: `${ORG}/openRoaming/byNetwork`, handler: openRoamingByNetwork },
  { op: 'getOrganizationWirelessSsidsProfiles', path: `${ORG}/profiles`, handler: listProfiles },
  { op: 'getOrganizationWirelessSsidsProfilesOverviews', path: `${ORG}/profiles/overviews`, handler: listProfiles },
  ...profiles.routes.map((r) => (r.method === 'POST' ? { ...r, status: 200 } : r)),
  { op: 'getOrganizationWirelessSsidsProfilesAssignments', path: `${ORG}/profiles/assignments`, handler: listAssignments },
  { op: 'createOrganizationWirelessSsidsProfilesAssignment', method: 'POST', path: `${ORG}/profiles/assignments`, handler: assign },
  { op: 'deleteOrganizationWirelessSsidsProfilesAssignments', method: 'DELETE', path: `${ORG}/profiles/assignments`, handler: unassign },
  { op: 'getOrganizationWirelessSsidsProfilesAssignmentsByNetwork', path: `${ORG}/profiles/assignments/byNetwork`, handler: assignmentsByNetwork },
];
