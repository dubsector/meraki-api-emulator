// Cisco Secure Routers: appliances whose model has `secureRouter` in MODELS.
// Their SFP+ ports report digital optical monitoring (DOM) readings, every
// interface keeps packet counters, and the routing table is worked out from
// the network's VLANs, L3 interfaces, static routes, uplinks and VPN peers.

import { configOf, exportedSubnets } from '../config.js';
import { derive, gauss, hashStr, unit } from '../rng.js';
import { ipInCidr } from '../validate.js';
import { isDown, uplinkUp } from './outages.js';
import { uplinkBytes } from './traffic.js';

// DOM readings are sampled on this grid, and an interval aggregates them.
export const DOM_SLOT = 300;

export const isSecureRouter = (dev) => !!dev?.info?.secureRouter;

// The interface name of physical port n, as the port views show it.
export function portInterface(mx, n) {
  const kind = mx.info.sfp?.includes(n) ? 'TenGigabitEthernet' : 'GigabitEthernet';
  return { name: `${kind}0/0/${n}`, slot: 0, subslot: 0, number: n };
}

// Every physical port: the WAN ports, then the LAN range.
export function physicalPorts(mx) {
  const last = Math.max(mx.uplinks.length, mx.info.lan.at(-1) ?? 0);
  return Array.from({ length: last }, (_, i) => i + 1);
}

// Ports with an optic seated, which are the ones reporting DOM.
export function opticPorts(mx) {
  return Object.keys(mx.info.optics ?? {})
    .map(Number)
    .sort((a, b) => a - b);
}

// A WAN port has light while its uplink is up; a LAN optic has nothing on the far end.
function linkUp(mx, n, t) {
  const u = mx.uplinks[n - 1];
  return !!u && uplinkUp(mx, u, t);
}

// One DOM sample for port n at t, or null while the router is down.
export function domSample(mx, n, t) {
  if (isDown(mx, t)) return null;
  const key = derive(mx.key, `dom${n}`);
  const longReach = /-LR/.test(mx.info.optics[n]);
  const slot = Math.floor(t / DOM_SLOT);
  const day = Math.sin((2 * Math.PI * (t % 86400)) / 86400);
  const celsius = 34 + (key % 60) / 10 + 2.5 * day + gauss(derive(key, 'temp'), slot) * 0.3;
  return {
    celsius,
    voltage: 3.28 + gauss(derive(key, 'volt'), slot) * 0.012,
    transmit: (longReach ? -1.4 : -2.6) + gauss(derive(key, 'tx'), slot) * 0.08,
    receive: linkUp(mx, n, t) ? (longReach ? -4.9 : -3.1) + gauss(derive(key, 'rx'), slot) * 0.15 : -40,
    bias: (longReach ? 37 : 7) + gauss(derive(key, 'bias'), slot) * (longReach ? 0.5 : 0.15),
  };
}

// Packet types the overview reports, the three kinds first and their sum after.
export const PACKET_TYPES = ['broadcast', 'multicast', 'unicast', 'broadcast unicast multicast', 'CRC errors', 'collisions', 'fragments', 'jabbers', 'oversize', 'undersize'];

// Bytes a WAN port carried over [a, b), turned into packets by type. LAN
// ports have nothing cabled in the lab, so they count nothing.
export function packetCounts(mx, n, a, b) {
  const counts = Object.fromEntries(PACKET_TYPES.map((t) => [t, { sent: 0, recv: 0 }]));
  const u = mx.uplinks[n - 1];
  if (!u) return counts;
  const bytes = uplinkBytes(mx.net, a, b)[u.interface];
  const key = derive(mx.key, `pkts${n}`);
  // Average packet sizes differ a little per port and direction.
  const sentSize = 620 + (key % 180);
  const recvSize = 880 + (derive(key, 'recv') % 240);
  const share = (k, x) => Math.round(x * (0.8 + 0.4 * unit(key, hashStr(k))));
  const sent = bytes.sent / sentSize;
  const recv = bytes.received / recvSize;
  counts.unicast = { sent: share('us', sent * 0.97), recv: share('ur', recv * 0.96) };
  counts.multicast = { sent: share('ms', sent * 0.02), recv: share('mr', recv * 0.03) };
  counts.broadcast = { sent: share('bs', sent * 0.005), recv: share('br', recv * 0.01) };
  const all = counts['broadcast unicast multicast'];
  for (const t of ['broadcast', 'multicast', 'unicast']) {
    all.sent += counts[t].sent;
    all.recv += counts[t].recv;
  }
  return counts;
}

// The router's routing table, in the default VRF. Directly connected
// subnets come from the VLANs (or the single LAN) and L3 interfaces, then
// static routes, VPN peers' exported subnets and the default route out the
// uplinks in priority order.
export function routingEntries(mx) {
  const net = mx.net;
  const c = configOf(net);
  const vrf = { name: 'default' };
  const out = [];
  const route = (type, subnet, nextHops) => out.push({ type, subnet, nextHops: nextHops.map((h, number) => ({ number, ...h })), ipVersion: 'ipv4', vrf });
  if (c.vlansEnabled) {
    for (const v of c.vlans) route('direct', v.subnet, [{ address: v.applianceIp, vlan: { id: String(v.id), name: v.name } }]);
  } else {
    route('direct', c.singleLan.subnet, [{ address: c.singleLan.applianceIp }]);
  }
  for (const x of c.applianceL3Interfaces?.list ?? []) {
    if (x.ipv4?.subnet) route('direct', x.ipv4.subnet, [{ address: x.ipv4.address ?? x.ipv4.subnet.split('/')[0] }]);
  }
  for (const r of c.staticRoutes) {
    if (r.enabled === false) continue;
    const v = c.vlansEnabled ? (c.vlans.find((x) => String(x.id) === String(r.gatewayVlanId)) ?? c.vlans.find((x) => ipInCidr(r.gatewayIp, x.subnet))) : null;
    route('static', r.subnet, [{ address: r.gatewayIp, ...(v ? { vlan: { id: String(v.id), name: v.name } } : {}) }]);
  }
  for (const peer of vpnPeers(net)) {
    for (const s of exportedSubnets(peer)) route('BGP', s.subnet, [{ vpn: { peer: { id: peer.id, name: peer.name } } }]);
  }
  route(
    'default WAN',
    '0.0.0.0/0',
    mx.uplinks.map((u) => ({ address: u.gateway })),
  );
  return out;
}

// AutoVPN peers as the VPN status view pairs them: a hub with its spokes.
export function vpnPeers(net) {
  const org = net.org;
  if (!net.mx || !org.hub || configOf(net).siteToSite.mode === 'none') return [];
  const peers = net.vpn === 'hub' ? org.networks.filter((n) => n.vpn === 'spoke') : [org.hub];
  return peers.filter((n) => n !== net && n.mx && configOf(n).siteToSite.mode !== 'none');
}
