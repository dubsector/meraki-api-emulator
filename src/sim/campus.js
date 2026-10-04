// Campus gateway clusters. A cluster lives on its campus gateway network
// (net.campusGatewayClusters) and holds its gateways as device objects, so a
// swap keeps them and removed ones drop out on read. SSIDs of any wireless
// network in the organization tunnel through a cluster by its ID
// (ipAssignmentMode 'Campus Gateway'); each AP of that network then keeps a
// tunnel to every gateway in the cluster.

import { configOf } from '../config.js';
import { Rand, hashStr } from '../rng.js';
import { DAY } from '../time.js';
import { eachOutage, isDown } from './outages.js';

export const isCampusGateway = (d) => d.productType === 'campusGateway';
export const clustersOf = (net) => net.campusGatewayClusters?.list ?? [];

// Every cluster in the organization with its network.
export const orgClusters = (org) => org.networks.flatMap((net) => clustersOf(net).map((cluster) => ({ net, cluster })));
export const clusterIn = (org, id) => (id == null ? null : (orgClusters(org).find((x) => x.cluster.clusterId === String(id)) ?? null));

// Gateways still in the cluster's network, by member number.
export const membersOf = (net, cluster) => cluster.devices.filter((m) => net.devices.includes(m.dev));

export const clusterUrl = (net, cluster) => net.url.replace(/manage\/usage\/list$/, `manage/campus_gateways/clusters/${cluster.clusterId}`);

// The cluster an SSID names, whether or not it still exists.
export const ssidCluster = (s) => (s?.ipAssignmentMode === 'Campus Gateway' && s.campusGateway?.cluster?.id != null ? String(s.campusGateway.cluster.id) : null);

// Enabled SSIDs of a wireless network tunneling through a cluster of its
// organization: [{ number, name, net, cluster }], net being the cluster's.
export function tunnelsOf(net) {
  if (!net.productTypes.includes('wireless')) return [];
  const out = [];
  configOf(net).ssids.forEach((s, number) => {
    const found = s.enabled ? clusterIn(net.org, ssidCluster(s)) : null;
    if (found) out.push({ number, name: s.name, ...found });
  });
  return out;
}

// A wireless network tunnels every SSID through clusters of one network:
// the one its other SSIDs already use, unless that SSID is the excluded one.
export function tunnelableFrom(net, exclude) {
  const used = new Set(tunnelsOf(net).filter((t) => t.number !== exclude).map((t) => t.net));
  return orgClusters(net.org).filter((x) => !used.size || used.has(x.net));
}

// The same tunnels grouped by cluster: [{ net, cluster, numbers }].
export function tunneledClusters(net) {
  const by = new Map();
  for (const t of tunnelsOf(net)) {
    const row = by.get(t.cluster) ?? { net: t.net, cluster: t.cluster, numbers: [] };
    row.numbers.push(t.number);
    by.set(t.cluster, row);
  }
  return [...by.values()];
}

// Data plane encryption set for a network's tunnels to one cluster (default off).
const settingsOf = (net) => configOf(net).wirelessCampusGateway;
export const encrypted = (net, clusterId) => settingsOf(net)?.encryption.find((e) => e.clusterId === clusterId)?.enabled ?? false;
export const mdnsOf = (net, clusterId, number) => settingsOf(net)?.mdns.find((m) => m.clusterId === clusterId && m.number === number) ?? null;

// Seconds since a device last came up, looking back 31 days; 0 while down.
export function uptime(dev, now) {
  if (isDown(dev, now)) return 0;
  let up = now - 31 * DAY;
  eachOutage(dev, up, now, (s, e) => (up = Math.max(up, e)));
  return Math.floor(now - up);
}

// An AP's tunnels to a cluster's gateways. APs spread their primary across the
// members by their place in the network, the rest follow in member order.
export function tunnelsFor(ap, cnet, cluster, now) {
  const members = membersOf(cnet, cluster);
  const at = Math.max(0, ap.net.aps.indexOf(ap));
  return members.map((m, j) => {
    const up = !isDown(ap, now) && !isDown(m.dev, now);
    return { gw: m.dev, priority: (j - (at % members.length) + members.length) % members.length, up, uptime: up ? Math.min(uptime(ap, now), uptime(m.dev, now)) : null };
  });
}

// Lab networks with a cluster start with both gateways in it, and every SSID
// tunneling through it. The uplink is static on the management VLAN, and the
// tunnel reuses it.
export function seedCampus(world, net, tpl) {
  if (!tpl.cluster) return;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:lab:${tpl.code}:campus`));
  const gateway = `${net.subnet(1)}.1`;
  const cluster = {
    clusterId: r.digits(13),
    name: tpl.cluster.name,
    uplinks: [{ interface: 'man1', vlan: 1, addresses: [{ assignmentMode: 'static', protocol: 'ipv4', gateway, subnetMask: '255.255.255.0' }] }],
    tunnels: [{ uplink: { interface: 'man1' } }],
    nameservers: { addresses: [gateway, '8.8.8.8'] },
    portChannels: [{ id: r.digits(13), name: 'Port-channel1', vlan: 1, allowedVlans: '1,10,30' }],
    devices: net.devices.filter(isCampusGateway).map((dev, i) => ({ dev, memberId: String(i + 1), uplinks: [{ interface: 'man1', addresses: [{ protocol: 'ipv4', address: dev.lanIp }] }], tunnels: [] })),
    notes: '',
    failover: { targets: [] },
  };
  net.campusGatewayClusters = { created: 1, list: [cluster] };
  for (const s of net.ssids) s.cluster = cluster.clusterId;
}

// Whether moving a network would leave a tunnel or failover target pointing
// across organizations: its SSIDs or clusters name another network's cluster,
// or another network's SSIDs or clusters name one of its own.
export function usesCampusGateway(net) {
  const own = new Set(clustersOf(net).map((c) => c.clusterId));
  const crosses = (n, id) => id != null && clusterIn(net.org, id) && (n === net) !== own.has(id);
  for (const n of net.org.networks) {
    if (n.productTypes.includes('wireless') && configOf(n).ssids.some((s) => crosses(n, ssidCluster(s)))) return true;
    if (clustersOf(n).some((c) => c.failover.targets.some((t) => crosses(n, t.clusterId)))) return true;
  }
  return false;
}

// The cluster a gateway is a member of, with its member entry.
export function memberOf(dev) {
  for (const cluster of clustersOf(dev.net)) {
    const member = membersOf(dev.net, cluster).find((m) => m.dev === dev);
    if (member) return { cluster, member };
  }
  return null;
}

// The management settings a cluster gives its gateways: the uplink's VLAN,
// and with a static uplink the member's address, gateway and nameservers.
export function clusterWan(dev) {
  const found = isCampusGateway(dev) ? memberOf(dev) : null;
  if (!found) return null;
  const u = found.cluster.uplinks[0];
  const a = u.addresses[0];
  if (a.assignmentMode !== 'static') return { usingStaticIp: false, vlan: u.vlan };
  const staticIp = found.member.uplinks[0].addresses[0].address;
  return { usingStaticIp: true, staticIp, staticSubnetMask: a.subnetMask, staticGatewayIp: a.gateway, staticDns: [...found.cluster.nameservers.addresses], vlan: u.vlan };
}
