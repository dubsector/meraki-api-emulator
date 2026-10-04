// Campus gateway clusters (sim/campus.js): the network cluster writes and the
// organization provision call share checkCluster, so every path that changes
// a cluster checks it the same way. Connections, client counts and usage come
// from the AP outage, presence and usage sims, so they agree with the wireless
// views of the same APs and clients.

import { configOf, stored } from '../config.js';
import { arrayParam, badRequest, boolParam, notFound, paginate, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { clusterIn, clusterUrl, clustersOf, encrypted, isCampusGateway, membersOf, mdnsOf, orgClusters, ssidCluster, tunnelableFrom, tunneledClusters, tunnelsFor, tunnelsOf, uptime } from '../sim/campus.js';
import { deviceStatus } from '../sim/outages.js';
import { isOnline, presenceIn } from '../sim/presence.js';
import { clientUsage } from '../sim/usage.js';
import { DAY, HOUR } from '../time.js';
import { inRange, ipInCidr, parseIp } from '../validate.js';
import { collection, netOf, orgOf, requireProduct, round } from './common.js';
import { groupOfNetwork } from './orgnetworks.js';
import { isMask, prefixOf } from './switchsettings.js';
import { ssidOf, wirelessNets } from './wireless.js';
import { ssidId } from './wirelessstats.js';

const LAB = { org: 1 };
const MAX_MEMBERS = 8;
const MAX_CHANNELS = 8;
const UNITS = { KB: ['kilobytes', 1], MB: ['megabytes', 1024], GB: ['gigabytes', 1024 ** 2], TB: ['terabytes', 1024 ** 3] };
const MDNS_SERVICES = 13;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isList = (v) => Array.isArray(v);
const str = (v) => typeof v === 'string';

// The cluster seeded in Lab - Calgary, for sample URLs and bodies.
const seeded = (world) => orgClusters(world.orgs[1])[0];
const campusNet = (world) => seeded(world)?.net.id ?? world.orgs[1].networks[0].id;

// ── Checks ──

// A VLAN list like '1,10-20' or 'all'.
function checkVlanList(v, name) {
  if (!str(v) || !v.trim()) throw badRequest(`'${name}' must be a VLAN list like '1,10-20' or 'all'`);
  if (v.trim() === 'all') return;
  for (const part of v.split(',')) {
    const m = /^\s*(\d{1,4})(?:-(\d{1,4}))?\s*$/.exec(part);
    const [lo, hi] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [0, 0];
    if (!m || lo < 1 || hi > 4094 || lo > hi) throw badRequest(`'${name}' must be a VLAN list like '1,10-20' or 'all'`);
  }
}

function checkIpv4(v, name) {
  if (!str(v) || parseIp(v) == null) throw badRequest(`'${name}' must be an IPv4 address`);
}

function checkStatic(a, name) {
  checkIpv4(a.gateway, `${name}.gateway`);
  if (!str(a.subnetMask) || !isMask(a.subnetMask)) throw badRequest(`'${name}.subnetMask' must be a subnet mask like 255.255.255.0`);
}

// Each item takes what the body leaves out from the stored item of the same key.
const fill = (list, old, key) => list.map((x) => ({ ...(old?.find((o) => x?.[key] != null && o[key] === x[key]) ?? {}), ...Object.fromEntries(Object.entries(x ?? {}).filter(([, v]) => v !== undefined)) }));

function checkUplinks(list) {
  if (!isList(list) || list.length !== 1) throw badRequest("'uplinks' must hold one interface, man1");
  return list.map((u) => {
    if (u.interface !== 'man1') throw badRequest("'uplinks[].interface' must be man1");
    if (u.vlan == null) throw badRequest("'uplinks[].vlan' is required");
    inRange(u.vlan, 1, 4094, 'uplinks[].vlan');
    if (!isList(u.addresses) || u.addresses.length !== 1) throw badRequest("'uplinks[].addresses' must hold one IPv4 address setting");
    const addresses = u.addresses.map((a) => {
      if (a.assignmentMode !== 'dynamic' && a.assignmentMode !== 'static') throw badRequest("'uplinks[].addresses[].assignmentMode' must be dynamic or static");
      if (a.assignmentMode === 'dynamic') return { assignmentMode: 'dynamic', protocol: 'ipv4' };
      checkStatic(a, 'uplinks[].addresses[]');
      return { assignmentMode: 'static', protocol: 'ipv4', gateway: a.gateway, subnetMask: a.subnetMask };
    });
    return { interface: 'man1', vlan: u.vlan, addresses };
  });
}

// A tunnel reuses an uplink, or names tun1 with a VLAN and static address.
function checkTunnels(list, uplinks) {
  if (!isList(list) || list.length !== 1) throw badRequest("'tunnels' must hold one tunnel setting");
  return list.map((t) => {
    if (t.uplink != null) {
      if (t.interface != null) throw badRequest("A tunnel either reuses an uplink or names its own interface, not both");
      if (!uplinks.some((u) => u.interface === t.uplink.interface)) throw badRequest("'tunnels[].uplink.interface' must name one of the cluster's uplinks");
      return { uplink: { interface: t.uplink.interface } };
    }
    if (t.interface !== 'tun1') throw badRequest("'tunnels[].interface' must be tun1 when the tunnel doesn't reuse an uplink");
    if (t.vlan == null) throw badRequest("'tunnels[].vlan' is required when the tunnel has its own interface");
    inRange(t.vlan, 1, 4094, 'tunnels[].vlan');
    if (!isList(t.addresses) || t.addresses.length !== 1) throw badRequest("'tunnels[].addresses' must hold one IPv4 address setting");
    for (const a of t.addresses) checkStatic(a, 'tunnels[].addresses[]');
    return { interface: 'tun1', vlan: t.vlan, addresses: t.addresses.map((a) => ({ protocol: 'ipv4', gateway: a.gateway, subnetMask: a.subnetMask })) };
  });
}

function checkPortChannels(list, self) {
  if (!isList(list) || !list.length || list.length > MAX_CHANNELS) throw badRequest(`'portChannels' must hold 1 to ${MAX_CHANNELS} port channels`);
  const names = new Set();
  return list.map((p) => {
    if (!str(p.name) || !p.name.trim()) throw badRequest("'portChannels[].name' must not be empty");
    if (names.has(p.name)) throw badRequest(`Port channel '${p.name}' appears twice`);
    names.add(p.name);
    if (p.vlan == null) throw badRequest("'portChannels[].vlan' is required");
    inRange(p.vlan, 1, 4094, 'portChannels[].vlan');
    if (p.allowedVlans == null) throw badRequest("'portChannels[].allowedVlans' is required");
    checkVlanList(p.allowedVlans, 'portChannels[].allowedVlans');
    // A given ID has to be one of this cluster's; otherwise one is made.
    if (p.id != null && !self?.portChannels.some((x) => x.id === p.id)) throw badRequest(`Port channel ${p.id} is not in this cluster`);
    return { id: p.id ?? self?.portChannels.find((x) => x.name === p.name)?.id ?? null, name: p.name, vlan: p.vlan, allowedVlans: p.allowedVlans.trim() };
  });
}

// Static addresses for a device's uplink or tunnel interface, inside the
// cluster's subnet for that interface.
function deviceAddresses(list, iface, setting, name, taken) {
  const entry = isList(list) ? list.find((x) => x?.interface === iface) : null;
  if (!entry) throw badRequest(`'devices[].${name}' needs an address for ${iface}`);
  if (!isList(entry.addresses) || entry.addresses.length !== 1) throw badRequest(`'devices[].${name}[].addresses' must hold one IPv4 address`);
  const { address } = entry.addresses[0] ?? {};
  checkIpv4(address, `devices[].${name}[].addresses[].address`);
  if (!ipInCidr(address, `${setting.gateway}/${prefixOf(setting.subnetMask)}`) || address === setting.gateway) throw badRequest(`'${address}' is not a host address in the ${iface} subnet`);
  if (taken.has(address)) throw badRequest(`'${address}' is given to more than one device`);
  taken.add(address);
  return [{ interface: iface, addresses: [{ protocol: 'ipv4', address }] }];
}

function checkMembers(net, list, self, uplinks, tunnels) {
  if (!isList(list)) throw badRequest("'devices' must be a list");
  if (list.length > MAX_MEMBERS) throw badRequest(`Clusters are limited to ${MAX_MEMBERS} campus gateways in the emulator`);
  const serials = new Set();
  const used = new Set();
  const taken = new Set();
  const others = new Map(clustersOf(net).filter((c) => c !== self).flatMap((c) => membersOf(net, c).map((m) => [m.dev, c])));
  const kept = self ? membersOf(net, self) : [];
  const out = list.map((d) => {
    if (!str(d.serial)) throw badRequest("'devices[].serial' is required");
    if (serials.has(d.serial)) throw badRequest(`Device ${d.serial} appears twice`);
    serials.add(d.serial);
    const dev = net.devices.find((x) => x.serial === d.serial);
    if (!dev || !isCampusGateway(dev)) throw badRequest(`Device ${d.serial} is not a campus gateway in this network`);
    if (others.has(dev)) throw badRequest(`Device ${d.serial} is already in cluster '${others.get(dev).name}'`);
    const old = kept.find((m) => m.dev === dev);
    if (old) used.add(old.memberId);
    const uplink = uplinks[0];
    const tunnel = tunnels[0];
    return {
      dev,
      memberId: old?.memberId ?? null,
      uplinks: uplink.addresses[0].assignmentMode === 'static' ? deviceAddresses(d.uplinks ?? old?.uplinks, uplink.interface, uplink.addresses[0], 'uplinks', taken) : [],
      tunnels: tunnel.interface ? deviceAddresses(d.tunnels ?? old?.tunnels, tunnel.interface, tunnel.addresses[0], 'tunnels', taken) : [],
    };
  });
  // New members take the lowest free member numbers.
  let n = 1;
  for (const m of out) {
    if (m.memberId) continue;
    while (used.has(String(n))) n++;
    m.memberId = String(n);
    used.add(m.memberId);
  }
  return out;
}

// The cluster a body makes over the stored one (self, null on create). Lists
// replace the stored ones, each item filled in from the stored item it names.
function checkCluster(ctx, net, b, self) {
  const name = b.name ?? self?.name;
  if (!str(name) || !name.trim()) throw badRequest("'name' must not be empty");
  if (clustersOf(net).some((c) => c !== self && c.name === name)) throw badRequest(`A cluster named '${name}' already exists in this network`);
  if (b.notes != null && (!str(b.notes) || b.notes.length > 511)) throw badRequest("'notes' must be at most 511 characters");
  const uplinks = checkUplinks(b.uplinks ? fill(b.uplinks, self?.uplinks, 'interface') : self.uplinks);
  const tunnels = checkTunnels(b.tunnels ?? self.tunnels, uplinks);
  const ns = b.nameservers ?? self.nameservers;
  const addresses = ns?.addresses ?? [];
  if (!isList(addresses) || addresses.length > 4) throw badRequest("'nameservers.addresses' must hold at most 4 addresses");
  for (const a of addresses) checkIpv4(a, 'nameservers.addresses[]');
  const portChannels = checkPortChannels(b.portChannels ? fill(b.portChannels, self?.portChannels, 'name') : self.portChannels, self);
  const devices = checkMembers(net, b.devices ?? (self ? membersOf(net, self).map((m) => ({ serial: m.dev.serial })) : []), self, uplinks, tunnels);
  return { name, uplinks, tunnels, nameservers: { addresses: [...addresses] }, portChannels, devices, notes: b.notes ?? self?.notes ?? '' };
}

function applyCluster(ctx, net, c, checked) {
  for (const p of checked.portChannels) {
    if (p.id) continue;
    c.channelsMade = (c.channelsMade ?? 0) + 1;
    const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:campusPortChannel:${c.clusterId}:${c.channelsMade}`));
    do p.id = r.digits(13);
    while (checked.portChannels.some((x) => x !== p && x.id === p.id));
  }
  // Members leaving go back to their DHCP address; a static uplink gives the
  // others theirs, which every device view then shows.
  for (const m of membersOf(net, c)) {
    const own = m.dev.managementInterface?.wan1;
    if (!checked.devices.some((x) => x.dev === m.dev)) m.dev.lanIp = own?.usingStaticIp ? own.staticIp : (m.dev.dhcpLanIp ?? m.dev.lanIp);
  }
  for (const m of checked.devices) {
    m.dev.dhcpLanIp ??= m.dev.lanIp;
    m.dev.lanIp = m.uplinks[0]?.addresses[0].address ?? m.dev.dhcpLanIp;
  }
  Object.assign(c, checked);
}

// Failover targets: other clusters of the organization, priority 1 first.
function checkTargets(org, self, list) {
  if (list == null) return null;
  if (!isList(list) || list.length > 1) throw badRequest("'failover.targets' must hold at most one target");
  return list.map((t) => {
    if (t.clusterId == null) throw badRequest("'failover.targets[].clusterId' is required");
    const found = clusterIn(org, t.clusterId);
    if (!found) throw badRequest(`Cluster ${t.clusterId} is not in this organization`);
    if (found.cluster === self) throw badRequest('A cluster cannot be its own failover target');
    if (t.priority != null && t.priority !== 1) throw badRequest("'failover.targets[].priority' must be 1");
    return { clusterId: found.cluster.clusterId, priority: 1 };
  });
}

// ── Answers ──

const allowedVlans = (c) => [...new Set(c.portChannels.map((p) => p.allowedVlans))].join(',');

export function clusterJson(net, c) {
  return {
    clusterId: c.clusterId,
    name: c.name,
    uplinks: structuredClone(c.uplinks),
    tunnels: structuredClone(c.tunnels),
    nameservers: { addresses: [...c.nameservers.addresses] },
    portChannels: c.portChannels.map((p) => ({ ...p })),
    devices: membersOf(net, c).map((m) => ({ serial: m.dev.serial, memberId: m.memberId, uplinks: structuredClone(m.uplinks), tunnels: structuredClone(m.tunnels) })),
    notes: c.notes,
    url: clusterUrl(net, c),
  };
}

// Targets that still exist, with their names and VLANs.
const targetsOf = (org, c) =>
  c.failover.targets.flatMap((t) => {
    const found = clusterIn(org, t.clusterId);
    return found && found.cluster !== c ? [{ clusterId: t.clusterId, name: found.cluster.name, priority: t.priority, allowedVlans: allowedVlans(found.cluster) }] : [];
  });

const modelOf = (net, c) => membersOf(net, c)[0]?.dev.model ?? null;

// ── Network cluster routes ──

const clusters = collection({
  ops: { create: 'createNetworkCampusGatewayCluster', update: 'updateNetworkCampusGatewayCluster', delete: 'deleteNetworkCampusGatewayCluster' },
  path: '/networks/{networkId}/campusGateway/clusters',
  param: 'clusterId',
  key: 'clusterId',
  parent: (ctx) => {
    const net = netOf(ctx);
    requireProduct(net, 'campusGateway');
    return net;
  },
  // Reads and refused writes leave no store behind; create builds it.
  store: (net) => net.campusGatewayClusters ?? { created: 0, list: [] },
  what: 'cluster',
  max: 16,
  required: ['name', 'uplinks', 'tunnels', 'nameservers', 'portChannels'],
  unique: false,
  nextId: (ctx, store, net) => {
    store.created++;
    const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:campusCluster:${net.id}:${store.created}`));
    let id;
    do id = r.digits(13);
    while (id[0] === '0' || clusterIn(net.org, id));
    return id;
  },
  check: (ctx, net, b, self) => checkCluster(ctx, net, b, self),
  blank: () => ({ devices: [], failover: { targets: [] } }),
  apply: (c, b, net, ctx, checked) => applyCluster(ctx, net, c, checked),
  json: (c, net) => clusterJson(net, c),
  inUse: (c, net) => {
    for (const n of net.org.networks) {
      if (!n.productTypes.includes('wireless')) continue;
      const number = configOf(n).ssids.findIndex((s) => ssidCluster(s) === c.clusterId);
      if (number >= 0) return `SSID ${number} of network '${n.name}' tunnels through this cluster`;
    }
  },
});

const createRoute = clusters.routes.find((r) => r.method === 'POST');
const createHandler = createRoute.handler;
createRoute.handler = (ctx) => {
  const net = netOf(ctx);
  const fresh = !net.campusGatewayClusters;
  if (fresh && net.productTypes.includes('campusGateway')) net.campusGatewayClusters = { created: 0, list: [] };
  try {
    return createHandler(ctx);
  } catch (e) {
    if (fresh) delete net.campusGatewayClusters;
    throw e;
  }
};

// The org call provisions an existing cluster: the same checks as the
// network update, plus its failover targets.
function provision(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  if (b.clusterId == null) throw badRequest("'clusterId' is required");
  if (b.network?.id == null) throw badRequest("'network.id' is required");
  const net = org.networks.find((n) => n.id === b.network.id);
  if (!net) throw badRequest(`Network ${b.network.id} is not in this organization`);
  requireProduct(net, 'campusGateway');
  const c = clustersOf(net).find((x) => x.clusterId === String(b.clusterId));
  if (!c) throw notFound('Cluster');
  for (const k of ['name', 'uplinks', 'tunnels', 'nameservers', 'portChannels']) if (b[k] == null) throw badRequest(`'${k}' is required`);
  const checked = checkCluster(ctx, net, b, c);
  const targets = checkTargets(org, c, b.failover?.targets);
  applyCluster(ctx, net, c, checked);
  if (targets) c.failover.targets = targets;
  return { ...clusterJson(net, c), failover: { targets: targetsOf(org, c) } };
}

// mDNS gateway settings for an SSID and the cluster it tunnels through.
function updateMdns(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'wireless');
  const { number, config } = ssidOf(net, ctx);
  const found = clusterIn(net.org, ssidCluster(config));
  if (!found) throw badRequest(`SSID ${number} does not tunnel through a campus gateway cluster`);
  const b = ctx.body;
  const old = mdnsOf(net, found.cluster.clusterId, number);
  const rules = b.rules ?? old?.rules ?? [];
  if (!isList(rules) || rules.length > 32) throw badRequest("'rules' must hold at most 32 rules");
  for (const r of rules) {
    if (!isList(r?.services) || !r.services.length) throw badRequest("'rules[].services' must name at least one service");
    if (new Set(r.services).size !== r.services.length || r.services.length > MDNS_SERVICES) throw badRequest("'rules[].services' must not repeat a service");
  }
  const row = { clusterId: found.cluster.clusterId, number, enabled: b.enabled ?? old?.enabled ?? false, rules: rules.map((r) => ({ services: [...r.services] })) };
  const store = stored(net, 'wirelessCampusGateway', () => ({ encryption: [], mdns: [] }));
  store.mdns = [...store.mdns.filter((m) => m !== old), row];
  return { enabled: row.enabled, rules: structuredClone(row.rules) };
}

// ── Organization views ──

function clustersList(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const rows = orgClusters(org)
    .filter((x) => !ids.length || ids.includes(x.net.id))
    .sort((a, b) => cmp(a.cluster.clusterId, b.cluster.clusterId));
  return paginateItems(ctx, rows, (x) => x.cluster.clusterId, { def: 50, max: 100 }, (x) => ({ network: { id: x.net.id }, ...clusterJson(x.net, x.cluster) }));
}

function clusterRows(ctx) {
  const org = orgOf(ctx);
  const nets = arrayParam(ctx.query, 'networkIds');
  const ids = arrayParam(ctx.query, 'clusterIds');
  return orgClusters(org)
    .filter((x) => (!nets.length || nets.includes(x.net.id)) && (!ids.length || ids.includes(x.cluster.clusterId)))
    .sort((a, b) => cmp(a.cluster.clusterId, b.cluster.clusterId));
}

function failoverTargets(ctx) {
  const org = orgOf(ctx);
  return paginate(ctx, clusterRows(ctx), (x) => x.cluster.clusterId, { def: 50, max: 100 }).map((x) => ({ clusterId: x.cluster.clusterId, network: { id: x.net.id }, failover: { targets: targetsOf(org, x.cluster) } }));
}

// Any other cluster can back one up, unless both have gateways of different models.
function failoverByCluster(ctx) {
  const all = orgClusters(orgOf(ctx));
  return paginateItems(ctx, clusterRows(ctx), (x) => x.cluster.clusterId, { def: 50, max: 100 }, (x) => {
    const model = modelOf(x.net, x.cluster);
    const available = all
      .filter((o) => o.cluster !== x.cluster && (!model || !modelOf(o.net, o.cluster) || modelOf(o.net, o.cluster) === model))
      .sort((a, b) => cmp(a.cluster.clusterId, b.cluster.clusterId))
      .map((o) => ({ clusterId: o.cluster.clusterId, name: o.cluster.name, network: { id: o.net.id }, model: modelOf(o.net, o.cluster), allowedVlans: allowedVlans(o.cluster) }));
    return { clusterId: x.cluster.clusterId, name: x.cluster.name, network: { id: x.net.id }, model, available };
  });
}

// Wireless networks of the org with what they tunnel, one row per cluster.
function tunnelRows(ctx) {
  const ids = arrayParam(ctx.query, 'clusterIds');
  const rows = [];
  for (const net of wirelessNets(ctx)) {
    for (const t of tunneledClusters(net)) if (!ids.length || ids.includes(t.cluster.clusterId)) rows.push({ wnet: net, ...t });
  }
  return rows;
}

const SORT_ORDER = (ctx) => {
  const order = ctx.query.get('sortOrder') ?? 'asc';
  if (order !== 'asc' && order !== 'desc') throw badRequest("'sortOrder' must be asc or desc");
  return order === 'asc' ? 1 : -1;
};

function sortParam(ctx, allowed, def) {
  const by = ctx.query.get('sortBy') ?? def;
  if (!allowed.includes(by)) throw badRequest(`'sortBy' must be one of: ${allowed.join(', ')}`);
  return by;
}

const onlineClients = (net, numbers, now) => net.clients.filter((c) => !c.wired && c.ap && numbers.includes(c.ssid.number) && isOnline(c, now));

function networkOverviews(ctx) {
  const q = ctx.query;
  const org = orgOf(ctx);
  const sources = arrayParam(q, 'tunnelingSources');
  for (const s of sources) if (s !== 'configured' && s !== 'roaming') throw badRequest("'tunnelingSources' must be configured or roaming");
  const sites = arrayParam(q, 'siteIds');
  const search = q.get('search')?.toLowerCase();
  const by = sortParam(ctx, ['clients', 'clusterId', 'connections', 'name', 'networkId', 'siteName', 'ssids'], 'name');
  const dir = SORT_ORDER(ctx);
  // Nothing roams or fails over here, so every network tunnels as configured.
  const configured = !sources.length || sources.includes('configured') || !arrayParam(q, 'clusterIds').length;
  const rows = [];
  for (const t of configured ? tunnelRows(ctx) : []) {
    const g = groupOfNetwork(org, t.wnet.id);
    if ((sites.length && !sites.includes(g?.groupId)) || (search && !t.wnet.name.toLowerCase().includes(search))) continue;
    const row = {
      networkId: t.wnet.id,
      name: t.wnet.name,
      tunneling: { source: 'configured' },
      url: t.wnet.url,
      counts: { connections: { total: t.wnet.aps.length }, clients: { total: onlineClients(t.wnet, t.numbers, ctx.now).length }, ssids: { total: t.numbers.length } },
      cluster: { id: t.cluster.clusterId, name: t.cluster.name },
    };
    if (g) row.site = { id: g.groupId, name: g.name, url: `https://dashboard.meraki.com/o/${org.slug}/manage/organization/network_groups/${g.groupId}` };
    rows.push(row);
  }
  const keyOf = { clients: (r) => r.counts.clients.total, clusterId: (r) => r.cluster.id, connections: (r) => r.counts.connections.total, name: (r) => r.name, networkId: (r) => r.networkId, siteName: (r) => r.site?.name ?? '', ssids: (r) => r.counts.ssids.total }[by];
  rows.sort((a, b) => dir * cmp(keyOf(a), keyOf(b)) || cmp(a.networkId, b.networkId) || cmp(a.cluster.id, b.cluster.id));
  return paginateItems(ctx, rows, (r) => `${r.networkId}_${r.cluster.id}`, { def: 100, max: 1000 });
}

function ssidsList(ctx) {
  const search = ctx.query.get('search')?.toLowerCase();
  const by = sortParam(ctx, ['clusterId', 'name', 'networkId', 'ssidId'], 'networkId');
  const dir = SORT_ORDER(ctx);
  const ids = arrayParam(ctx.query, 'clusterIds');
  const rows = [];
  for (const net of wirelessNets(ctx)) {
    for (const t of tunnelsOf(net)) {
      if ((ids.length && !ids.includes(t.cluster.clusterId)) || (search && !t.name.toLowerCase().startsWith(search))) continue;
      rows.push({
        number: t.number,
        ssidId: ssidId(net, t.number),
        name: t.name,
        url: net.url.replace(/manage\/usage\/list$/, `manage/configure/ssids/${t.number}`),
        network: { id: net.id },
        cluster: { id: t.cluster.clusterId, name: t.cluster.name },
      });
    }
  }
  const keyOf = { clusterId: (r) => r.cluster.id, name: (r) => r.name, networkId: (r) => r.network.id, ssidId: (r) => r.ssidId }[by];
  rows.sort((a, b) => dir * cmp(keyOf(a), keyOf(b)) || cmp(a.network.id, b.network.id) || a.number - b.number);
  return paginateItems(ctx, rows, (r) => `${r.network.id}_${r.number}`, { def: 100, max: 1000 });
}

function tunnelable(ctx) {
  const org = orgOf(ctx);
  const from = arrayParam(ctx.query, 'fromNetworkIds');
  if (!from.length) throw badRequest("'fromNetworkIds' is required");
  const exclude = arrayParam(ctx.query, 'excludeSsidNumbers');
  if (exclude.length > from.length) throw badRequest("'excludeSsidNumbers' takes at most one SSID number per network in 'fromNetworkIds'");
  const rows = [];
  from.forEach((id, i) => {
    const net = org.networks.find((n) => n.id === id);
    if (!net || !net.productTypes.includes('wireless')) throw badRequest(`Network ${id} is not a wireless network in this organization`);
    let skip = null;
    if (exclude[i] != null && exclude[i] !== '') {
      skip = Number(exclude[i]);
      if (!Number.isInteger(skip) || skip < 0 || skip > 15) throw badRequest("'excludeSsidNumbers' must be SSID numbers from 0 to 15");
    }
    for (const x of tunnelableFrom(net, skip).sort((a, b) => cmp(a.cluster.clusterId, b.cluster.clusterId))) {
      rows.push({ clusterId: x.cluster.clusterId, name: x.cluster.name, url: clusterUrl(x.net, x.cluster), network: { id: x.net.id, name: x.net.name }, source: { network: { id: net.id } } });
    }
  });
  return paginateItems(ctx, rows, (r) => `${r.source.network.id}_${r.clusterId}`, { def: 200, max: 200 });
}

// Network tunnel settings: every network tunneling to a cluster, and any set
// by the batch update for a cluster that still exists.
function tunnelSettings(ctx) {
  const ids = arrayParam(ctx.query, 'clusterIds');
  const want = ctx.query.has('dataEncryptionEnabled') ? boolParam(ctx.query, 'dataEncryptionEnabled') : null;
  const rows = [];
  for (const net of wirelessNets(ctx)) {
    const seen = new Set(tunneledClusters(net).map((t) => t.cluster));
    for (const e of configOf(net).wirelessCampusGateway?.encryption ?? []) {
      const found = clusterIn(net.org, e.clusterId);
      if (found) seen.add(found.cluster);
    }
    for (const c of seen) {
      const enabled = encrypted(net, c.clusterId);
      if ((ids.length && !ids.includes(c.clusterId)) || (want != null && enabled !== want)) continue;
      rows.push({ cluster: { id: c.clusterId, name: c.name }, network: { id: net.id, name: net.name }, data: { encryption: { enabled } } });
    }
  }
  rows.sort((a, b) => cmp(a.cluster.id, b.cluster.id) || cmp(a.network.id, b.network.id));
  return paginateItems(ctx, rows, (r) => `${r.cluster.id}_${r.network.id}`, { def: 50, max: 100 });
}

function batchTunneling(ctx) {
  const org = orgOf(ctx);
  const items = ctx.body.items;
  if (!isList(items) || !items.length || items.length > 100) throw badRequest("'items' must hold 1 to 100 settings");
  const checked = items.map((x) => {
    const found = clusterIn(org, x.cluster?.id);
    if (!found) throw badRequest(`Cluster ${x.cluster?.id} is not in this organization`);
    const net = org.networks.find((n) => n.id === x.network?.id);
    if (!net || !net.productTypes.includes('wireless')) throw badRequest(`Network ${x.network?.id} is not a wireless network in this organization`);
    if (net.template) throw badRequest(`Network ${net.id} is bound to a configuration template, so its tunnel settings come from the template`);
    if (typeof x.data?.encryption?.enabled !== 'boolean') throw badRequest("'items[].data.encryption.enabled' must be true or false");
    return { net, clusterId: found.cluster.clusterId, enabled: x.data.encryption.enabled };
  });
  for (const { net, clusterId, enabled } of checked) {
    const store = stored(net, 'wirelessCampusGateway', () => ({ encryption: [], mdns: [] }));
    store.encryption = [...store.encryption.filter((e) => e.clusterId !== clusterId), { clusterId, enabled }];
  }
  return { items: checked.map((x) => ({ cluster: { id: x.clusterId }, network: { id: x.net.id }, data: { encryption: { enabled: x.enabled } } })) };
}

// ── Connections ──

const cumulative = (tunnels) => (tunnels.every((t) => t.up) ? 'up' : tunnels.some((t) => t.up) ? 'up/down' : 'down');

// One row per AP tunneling an SSID, before the query's filters.
function connections(ctx) {
  const rows = [];
  for (const net of wirelessNets(ctx)) {
    const tunnels = tunneledClusters(net);
    if (!tunnels.length) continue;
    const numbers = tunnels.flatMap((t) => t.numbers);
    for (const ap of net.aps) {
      const gws = tunnels.flatMap((t) => {
        const enc = encrypted(net, t.cluster.clusterId);
        return tunnelsFor(ap, t.net, t.cluster, ctx.now).map((x) => ({ ...x, cnet: t.net, cluster: t.cluster, enc }));
      });
      if (!gws.length) continue;
      rows.push({ ap, net, gws, status: deviceStatus(ap, ctx.now), tunnelStatus: cumulative(gws), clients: net.clients.filter((c) => c.ap === ap && !c.wired && numbers.includes(c.ssid.number) && isOnline(c, ctx.now)).length });
    }
  }
  return rows;
}

function connectionFilter(ctx) {
  const q = ctx.query;
  const serials = arrayParam(q, 'serials');
  const gwSerials = arrayParam(q, 'campusGatewaySerials');
  const clusterIds = arrayParam(q, 'campusGatewayClusterIds');
  const statuses = arrayParam(q, 'campusGatewayTunnelStatuses');
  const models = arrayParam(q, 'models');
  const enc = arrayParam(q, 'dataEncryptionStatuses');
  for (const e of enc) if (e !== 'up' && e !== 'down') throw badRequest("'dataEncryptionStatuses' must be up or down");
  const search = q.get('search')?.toLowerCase();
  return (r) =>
    (!serials.length || serials.includes(r.ap.serial)) &&
    (!gwSerials.length || r.gws.some((g) => gwSerials.includes(g.gw.serial))) &&
    (!clusterIds.length || r.gws.some((g) => clusterIds.includes(g.cluster.clusterId))) &&
    (!statuses.length || statuses.includes(r.tunnelStatus)) &&
    (!models.length || models.includes(r.ap.model)) &&
    (!enc.length || r.gws.some((g) => enc.includes(g.enc && g.up ? 'up' : 'down'))) &&
    (!search || [r.ap.name, r.ap.serial, r.ap.mac, r.net.name, r.ap.lanIp ?? ''].some((v) => String(v).toLowerCase().includes(search)));
}

function connectionJson(r, now) {
  const ap = r.ap;
  return {
    name: ap.name,
    serial: ap.serial,
    mac: ap.mac,
    model: ap.model,
    uptime: uptime(ap, now),
    status: r.status,
    tunnelStatus: r.tunnelStatus,
    tunnelAdmin: { enabled: true },
    tunnelSchedule: { enabled: false },
    interfaces: ap.lanIp ? [ap.lanIp] : [],
    url: ap.net.url.replace(/manage\/usage\/list$/, `manage/nodes/new_list/${ap.mac.replaceAll(':', '')}`),
    network: { id: r.net.id, name: r.net.name, url: r.net.url },
    counts: { clients: { total: r.clients } },
    campusGateways: r.gws
      .sort((a, b) => a.priority - b.priority || cmp(a.gw.serial, b.gw.serial))
      .map((g) => ({
        name: g.gw.name,
        priority: g.priority,
        serial: g.gw.serial,
        mac: g.gw.mac,
        tunnel: g.up ? { status: 'up', uptime: g.uptime } : { status: 'down' },
        data: { encryption: { status: g.enc && g.up ? 'up' : 'down' } },
        url: g.cnet.url.replace(/manage\/usage\/list$/, `manage/nodes/new_list/${g.gw.mac.replaceAll(':', '')}`),
        cluster: { id: g.cluster.clusterId, name: g.cluster.name },
      })),
  };
}

function connectionsList(ctx) {
  const by = sortParam(ctx, ['clients', 'dataEncryption', 'interfaces', 'name', 'networkName', 'serial', 'status'], 'serial');
  const dir = SORT_ORDER(ctx);
  const rows = connections(ctx).filter(connectionFilter(ctx));
  const keyOf = {
    clients: (r) => r.clients,
    dataEncryption: (r) => (r.gws.some((g) => g.enc && g.up) ? 'up' : 'down'),
    interfaces: (r) => r.ap.lanIp ?? '',
    name: (r) => r.ap.name,
    networkName: (r) => r.net.name,
    serial: (r) => r.ap.serial,
    status: (r) => r.status,
  }[by];
  rows.sort((a, b) => dir * cmp(keyOf(a), keyOf(b)) || cmp(a.ap.serial, b.ap.serial));
  return paginateItems(ctx, rows, (r) => r.ap.serial, { def: 100, max: 1000 }, (r) => connectionJson(r, ctx.now));
}

// An AP with any tunnel up counts as up.
function connectionsOverview(ctx) {
  const rows = connections(ctx).filter(connectionFilter(ctx));
  const down = rows.filter((r) => r.tunnelStatus === 'down').length;
  return { counts: { byTunnelStatus: { up: rows.length - down, down }, total: rows.length } };
}

// ── Client usage ──

// Clients seen on SSIDs tunneling through each cluster, counted like the
// wireless client usage views.
function usageByCluster(ctx) {
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 7 * DAY, minSpan: HOUR, defaultSpan: 2 * HOUR, lookback: 8 * DAY });
  const units = q.get('usageUnits') ?? 'MB';
  if (!UNITS[units]) throw badRequest("'usageUnits' must be one of: GB, KB, MB, TB");
  const d = UNITS[units][1];
  const rows = [];
  for (const t of tunnelRows(ctx)) {
    let n = 0;
    let sent = 0;
    let recv = 0;
    for (const c of t.wnet.clients) {
      if (c.wired || !c.ap || !t.numbers.includes(c.ssid.number) || !presenceIn(c, t0, t1)) continue;
      const u = clientUsage(c, t0, t1);
      n++;
      sent += u.sent;
      recv += u.recv;
    }
    rows.push({
      network: { id: t.wnet.id, name: t.wnet.name },
      cluster: { id: t.cluster.clusterId, name: t.cluster.name },
      clients: { total: n },
      devices: { byProductType: { campusGateway: membersOf(t.net, t.cluster).length }, tunneled: { byProductType: { wireless: t.wnet.aps.length } } },
      usage: { total: round((sent + recv) / d, 2), upstream: round(sent / d, 2), downstream: round(recv / d, 2) },
    });
  }
  rows.sort((a, b) => b.usage.total - a.usage.total || cmp(a.network.id, b.network.id) || cmp(a.cluster.id, b.cluster.id));
  const out = paginateItems(ctx, rows, (r) => `${r.network.id}_${r.cluster.id}`, { def: 100, max: 1000 });
  out.meta.units = { usage: { name: UNITS[units][0], symbol: units } };
  return out;
}

// Nothing is configured on the gateways themselves, so there are no overrides.
function localOverrides(ctx) {
  orgOf(ctx);
  return paginateItems(ctx, [], (r) => r.serial, { def: 1000, max: 1000 });
}

export default [
  // A delete takes the newest cluster, so one made at runtime can go.
  ...clusters.routes.map((r) => ({ ...r, sample: { ...LAB, networkId: campusNet, clusterId: (w) => (r.method === 'DELETE' ? orgClusters(w.orgs[1]).at(-1) : seeded(w))?.cluster.clusterId ?? '0' } })),
  {
    op: 'updateNetworkCampusGatewaySsidMdns',
    method: 'PUT',
    path: '/networks/{networkId}/campusGateway/ssids/{number}/mdns',
    sample: { ...LAB, networkId: campusNet, number: '0' },
    handler: updateMdns,
  },
  { op: 'getOrganizationCampusGatewayClientsUsageByNetworkByCluster', path: '/organizations/{organizationId}/campusGateway/clients/usage/byNetwork/byCluster', sample: LAB, handler: usageByCluster },
  { op: 'getOrganizationCampusGatewayClusters', path: '/organizations/{organizationId}/campusGateway/clusters', sample: LAB, handler: clustersList },
  { op: 'getOrganizationCampusGatewayClustersFailoverTargets', path: '/organizations/{organizationId}/campusGateway/clusters/failover/targets', sample: LAB, handler: failoverTargets },
  { op: 'getOrganizationCampusGatewayClustersFailoverTargetsByCluster', path: '/organizations/{organizationId}/campusGateway/clusters/failover/targets/byCluster', sample: LAB, handler: failoverByCluster },
  { op: 'getOrganizationCampusGatewayClustersNetworksOverviews', path: '/organizations/{organizationId}/campusGateway/clusters/networks/overviews', sample: LAB, handler: networkOverviews },
  {
    op: 'provisionOrganizationCampusGatewayClusters',
    method: 'POST',
    path: '/organizations/{organizationId}/campusGateway/clusters/provision',
    status: 202,
    sample: LAB,
    handler: provision,
  },
  { op: 'getOrganizationCampusGatewayClustersSsids', path: '/organizations/{organizationId}/campusGateway/clusters/ssids', sample: LAB, handler: ssidsList },
  {
    op: 'getOrganizationCampusGatewayClustersTunnelable',
    path: '/organizations/{organizationId}/campusGateway/clusters/tunnelable',
    sample: { ...LAB, query: (w) => `fromNetworkIds[]=${campusNet(w)}` },
    handler: tunnelable,
  },
  {
    op: 'batchOrganizationCampusGatewayClustersTunnelingUpdate',
    method: 'POST',
    path: '/organizations/{organizationId}/campusGateway/clusters/tunneling/batchUpdate',
    status: 200,
    sample: LAB,
    handler: batchTunneling,
  },
  { op: 'getOrganizationCampusGatewayClustersTunnelingByClusterByNetwork', path: '/organizations/{organizationId}/campusGateway/clusters/tunneling/byCluster/byNetwork', sample: LAB, handler: tunnelSettings },
  { op: 'getOrganizationCampusGatewayConnections', path: '/organizations/{organizationId}/campusGateway/connections', sample: LAB, handler: connectionsList },
  { op: 'getOrganizationCampusGatewayConnectionsOverview', path: '/organizations/{organizationId}/campusGateway/connections/overview', sample: LAB, handler: connectionsOverview },
  { op: 'getOrganizationCampusGatewayDevicesUplinksLocalOverridesByDevice', path: '/organizations/{organizationId}/campusGateway/devices/uplinks/localOverrides/byDevice', sample: LAB, handler: localOverrides },
];
