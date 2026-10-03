// MX wired L3 interfaces, static delegated IPv6 prefixes and the VRF setting.
// L3 interfaces and prefixes are network settings; the device views show the
// static prefixes as delegated and the /64s that IPv6 VLANs take from them.

import { configOf, stored } from '../config.js';
import { arrayParam, badRequest, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso } from '../time.js';
import { ipInCidr, isIpv6, parseCidr, parseIp } from '../validate.js';
import { interfacePorts, localSubnets, overlaps } from './appliance.js';
import { byId, collection, devOf, mxNet, orgOf, requireModel } from './common.js';

const MAX_INTERFACES = 100;
const MAX_PREFIXES = 100;
const MISSING = { staticDelegatedPrefixId: '1284392014819', status: 404 };

const interfacesOf = (net) => stored(net, 'applianceL3Interfaces', () => ({ created: 0, list: [] }));
const staticsOf = (net) => stored(net, 'appliancePrefixStatics', () => ({ created: 0, list: [] }));
const vrfsOf = (org) => (org.applianceVrfs ??= { enabled: false });

// ── IPv6 prefixes ──

// An IPv6 address as a BigInt; the caller has checked it with isIpv6.
function v6Big(addr) {
  let s = addr.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const n = parseIp(dotted[0]);
    s = s.slice(0, dotted.index) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = tail == null ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  return groups.reduce((v, g) => (v << 16n) | BigInt(parseInt(g, 16)), 0n);
}

// The shortest form of an address, as the WHATWG URL parser writes it.
function v6Text(n) {
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - i * 16)) & 0xffffn).toString(16));
  return new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1);
}

// A prefix like 2001:db8::/48 as { net, bits }, or null.
function parsePrefix(v) {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(String(v));
  if (!m || !isIpv6(m[1]) || Number(m[2]) > 128) return null;
  const bits = Number(m[2]);
  const mask = bits ? ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits) : 0n;
  return { net: v6Big(m[1]) & mask, bits };
}

// EUI-64 link-local address from the MX's MAC.
function linkLocal(mac) {
  const b = mac.split(':').map((h) => parseInt(h, 16));
  const id = [b[0] ^ 2, b[1], b[2], 0xff, 0xfe, b[3], b[4], b[5]].reduce((v, x) => (v << 8n) | BigInt(x), 0n);
  return v6Text((0xfe80n << 112n) | id);
}

const solicitedNode = (addr) => v6Text((0xff02n << 112n) | (1n << 32n) | (0xffn << 24n) | (addr & 0xffffffn));

// Statics an uplink delegates: internet prefixes once per interface they
// name, independent prefixes once under 'independent'.
function delegations(net) {
  const rows = [];
  for (const p of staticsOf(net).list) {
    const ifaces = p.origin.type === 'internet' ? p.origin.interfaces : ['independent'];
    for (const iface of ifaces) rows.push({ iface, p, parsed: parsePrefix(p.prefix), taken: 0 });
  }
  return rows;
}

// One row per prefix assignment on each IPv6 VLAN. Autonomous assignments
// take the next /64 of the first static delegated on their origin.
function vlanAssignments(net, rows) {
  const c = configOf(net);
  const out = [];
  if (!c.vlansEnabled || !net.mx) return out;
  const ll = linkLocal(net.mx.mac);
  for (const v of c.vlans) {
    if (v.ipv6?.enabled !== true || !Array.isArray(v.ipv6.prefixAssignments)) continue;
    for (const a of v.ipv6.prefixAssignments) {
      const type = a?.origin?.type === 'independent' ? 'independent' : 'internet';
      const iface = type === 'independent' ? 'independent' : (Array.isArray(a?.origin?.interfaces) && typeof a.origin.interfaces[0] === 'string' ? a.origin.interfaces[0] : 'wan1');
      const row = { vlan: { id: Number(v.id), name: v.name ?? '' }, origin: { interface: iface }, status: 'Not assigned' };
      let prefix = null;
      let from = null;
      if (a?.autonomous === true) {
        from = rows.find((r) => r.iface === iface && r.parsed && r.parsed.bits <= 64 && BigInt(r.taken) < 1n << BigInt(64 - r.parsed.bits));
        if (from) prefix = { net: from.parsed.net + (BigInt(from.taken++) << 64n), bits: 64 };
      } else if (typeof a?.staticPrefix === 'string') {
        prefix = parsePrefix(a.staticPrefix);
        from = prefix && rows.find((r) => r.iface === iface && r.parsed && r.parsed.bits <= prefix.bits && (prefix.net >> BigInt(128 - r.parsed.bits)) === (r.parsed.net >> BigInt(128 - r.parsed.bits)));
      }
      if (from) row.origin.prefix = from.p.prefix;
      if (prefix) {
        const own = typeof a.staticApplianceIp6 === 'string' && isIpv6(a.staticApplianceIp6) ? v6Big(a.staticApplianceIp6) : prefix.net + 1n;
        row.status = 'Active';
        row.ipv6 = { prefix: `${v6Text(prefix.net)}/${prefix.bits}`, address: v6Text(own), linkLocal: { address: ll }, solicitedNodeMulticast: { address: solicitedNode(own) } };
      }
      out.push(row);
    }
  }
  return out;
}

function mxOf(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'appliance');
  if (!dev.net) throw badRequest('This appliance is not in a network');
  return dev;
}

function delegatedPrefixes(ctx) {
  const net = mxOf(ctx).net;
  const rows = delegations(net);
  vlanAssignments(net, rows);
  return rows.map((r) => ({
    origin: { interface: r.iface },
    prefix: r.p.prefix,
    counts: { assigned: r.taken, available: r.parsed ? Math.max(0, 2 ** (64 - r.parsed.bits) - r.taken) : 0 },
    method: 'manual',
    staticDelegatedPrefixId: r.p.staticDelegatedPrefixId,
    description: r.p.description,
    isPreferred: true,
    expiresAt: null,
  }));
}

const prefixAssignments = (ctx) => {
  const net = mxOf(ctx).net;
  return vlanAssignments(net, delegations(net));
};

// ── Static delegated prefixes ──

function nextPrefixId(ctx, store, net) {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:staticDelegatedPrefix:${net.id}:${store.created}`));
  let id;
  do id = r.digits(13);
  while (store.list.some((x) => x.staticDelegatedPrefixId === id));
  return id;
}

const uplinkNames = (net) => (net.mx ? net.mx.uplinks.map((u) => u.interface) : ['wan1', 'wan2']);

function checkStatic(ctx, net, b, self) {
  const out = {};
  if (b.prefix != null) {
    const p = parsePrefix(b.prefix);
    if (!p) throw badRequest("'prefix' must be an IPv6 prefix such as 2001:db8:3c4d::/48");
    if (p.bits < 48 || p.bits > 64) throw badRequest("'prefix' must be from /48 to /64");
    if (staticsOf(net).list.some((x) => x !== self && parsePrefix(x.prefix).net === p.net && parsePrefix(x.prefix).bits === p.bits)) throw badRequest(`The prefix ${b.prefix} is already in this network`);
    out.prefix = `${v6Text(p.net)}/${p.bits}`;
  }
  if (b.origin != null) {
    const { type, interfaces } = b.origin;
    if (type == null) throw badRequest("'origin.type' is required");
    if (type === 'internet') {
      const names = uplinkNames(net);
      if (!interfaces?.length) throw badRequest("'origin.interfaces' is required when the origin type is internet");
      for (const i of interfaces) if (!names.includes(i)) throw badRequest(`'origin.interfaces' must name uplinks of this network: ${names.join(', ')}`);
      out.origin = { type, interfaces: [...new Set(interfaces)] };
    } else {
      if (interfaces?.length) throw badRequest("'origin.interfaces' only applies when the origin type is internet");
      out.origin = { type, interfaces: [] };
    }
  }
  return out;
}

const statics = collection({
  ops: {
    list: 'getNetworkAppliancePrefixesDelegatedStatics',
    create: 'createNetworkAppliancePrefixesDelegatedStatic',
    get: 'getNetworkAppliancePrefixesDelegatedStatic',
    update: 'updateNetworkAppliancePrefixesDelegatedStatic',
    delete: 'deleteNetworkAppliancePrefixesDelegatedStatic',
  },
  path: '/networks/{networkId}/appliance/prefixes/delegated/statics',
  param: 'staticDelegatedPrefixId',
  key: 'staticDelegatedPrefixId',
  parent: mxNet,
  store: staticsOf,
  what: 'static delegated prefix',
  nextId: nextPrefixId,
  max: MAX_PREFIXES,
  required: ['prefix', 'origin'],
  unique: false,
  check: checkStatic,
  blank: (ctx) => ({ prefix: null, origin: null, description: '', createdAt: iso(ctx.now), updatedAt: iso(ctx.now) }),
  apply: (x, b, net, ctx, checked) => {
    Object.assign(x, checked);
    if (b.description != null) x.description = b.description;
    x.updatedAt = iso(ctx.now);
  },
  json: (x) => ({ staticDelegatedPrefixId: x.staticDelegatedPrefixId, prefix: x.prefix, origin: { type: x.origin.type, interfaces: [...x.origin.interfaces] }, description: x.description, createdAt: x.createdAt, updatedAt: x.updatedAt }),
  missing: MISSING,
});

// ── Wired L3 interfaces ──

// A LAN port of the network's MX, free of other L3 interfaces.
function checkPort(net, port, self) {
  const i = port.interface;
  if (i?.number == null) throw badRequest("'port.interface.number' is required");
  if (!net.mx) throw badRequest('This network has no appliance to hold the interface');
  const found = interfacePorts(net.mx).find((p) => p.interface.number === i.number && p.interface.slot === (i.slot ?? 0) && p.interface.subslot === (i.subslot ?? 0));
  if (!found) throw badRequest(`'port.interface' names no port on ${net.mx.model} ${net.mx.serial}`);
  if (found.personality.mode !== 'lan') throw badRequest(`Port ${found.number} is a WAN port; L3 interfaces sit on LAN ports`);
  const taken = interfacesOf(net).list.find((x) => x !== self && x.port?.number === i.number);
  if (taken) throw badRequest(`Port ${found.number} already holds L3 interface ${taken.interfaceId}`);
  return { name: found.interface.name, slot: found.interface.slot, subslot: found.interface.subslot, number: found.interface.number };
}

function checkInterface(ctx, net, b, self) {
  const out = {};
  if (b.ipv4 != null || !self) {
    const v4 = { ...self?.ipv4, ...b.ipv4 };
    if (v4.subnet == null || !parseCidr(v4.subnet)) throw badRequest("'ipv4.subnet' must be an IPv4 CIDR such as 192.168.1.0/24");
    if (v4.address == null || !ipInCidr(v4.address, v4.subnet)) throw badRequest("'ipv4.address' must be an address inside 'ipv4.subnet'");
    if (parseIp(v4.address) === parseCidr(v4.subnet)[0] && parseCidr(v4.subnet)[1] < 31) throw badRequest("'ipv4.address' can't be the subnet's network address");
    const c = configOf(net);
    if (localSubnets(c).some((s) => parseCidr(s) && overlaps(s, v4.subnet))) throw badRequest("'ipv4.subnet' overlaps a VLAN subnet of this network");
    const other = interfacesOf(net).list.find((x) => x !== self && overlaps(x.ipv4.subnet, v4.subnet));
    if (other) throw badRequest(`'ipv4.subnet' overlaps the subnet of L3 interface ${other.interfaceId}`);
    out.ipv4 = { address: v4.address, subnet: v4.subnet };
  }
  if ('port' in b) out.port = b.port == null ? null : checkPort(net, b.port, self);
  return out;
}

const interfaceJson = (x) => ({ interfaceId: x.interfaceId, ipv4: { ...x.ipv4 }, port: x.port ? { interface: { ...x.port } } : null });

const interfaces = collection({
  ops: { create: 'createNetworkApplianceInterfacesL3', update: 'updateNetworkApplianceInterfacesL3', delete: 'deleteNetworkApplianceInterfacesL3' },
  path: '/networks/{networkId}/appliance/interfaces/l3',
  param: 'interfaceId',
  key: 'interfaceId',
  parent: mxNet,
  store: interfacesOf,
  what: 'L3 interface',
  kind: 'l3Interface',
  max: MAX_INTERFACES,
  required: ['ipv4'],
  unique: false,
  check: checkInterface,
  blank: () => ({ ipv4: null, port: null }),
  apply: (x, b, net, ctx, checked) => Object.assign(x, checked),
  json: interfaceJson,
});

function orgInterfaces(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const rows = org.networks
    .filter((n) => n.productTypes.includes('appliance') && (!ids.length || ids.includes(n.id)))
    .sort(byId)
    .flatMap((n) => (configOf(n).applianceL3Interfaces?.list ?? []).map((x) => ({ x, n })));
  // Network copies and bound networks share interface IDs, so the cursor names the network too.
  return paginateItems(ctx, rows, (r) => `${r.n.id}_${r.x.interfaceId}`, { def: 100, max: 1000 }, ({ x, n }) => ({ ...interfaceJson(x), network: { id: n.id } }));
}

// ── VRFs ──

function updateVrfs(ctx) {
  const s = vrfsOf(orgOf(ctx));
  if (typeof ctx.body.enabled !== 'boolean') throw badRequest("'enabled' must be true or false");
  s.enabled = ctx.body.enabled;
  return { enabled: s.enabled };
}

export default [
  { op: 'getDeviceAppliancePrefixesDelegated', path: '/devices/{serial}/appliance/prefixes/delegated', sample: { serial: 'appliance' }, handler: delegatedPrefixes },
  { op: 'getDeviceAppliancePrefixesDelegatedVlanAssignments', path: '/devices/{serial}/appliance/prefixes/delegated/vlanAssignments', sample: { serial: 'appliance' }, handler: prefixAssignments },
  ...interfaces.routes,
  ...statics.routes,
  { op: 'getOrganizationApplianceDevicesInterfacesL3', path: '/organizations/{organizationId}/appliance/devices/interfaces/l3', handler: orgInterfaces },
  { op: 'getOrganizationApplianceRoutingVrfsSettings', path: '/organizations/{organizationId}/appliance/routing/vrfs/settings', handler: (ctx) => ({ enabled: vrfsOf(orgOf(ctx)).enabled }) },
  { op: 'updateOrganizationApplianceRoutingVrfsSettings', method: 'PUT', path: '/organizations/{organizationId}/appliance/routing/vrfs/settings', handler: updateVrfs },
];
