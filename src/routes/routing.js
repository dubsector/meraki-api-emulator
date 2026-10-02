// Switch layer 3 routing. Interfaces (with DHCP) and static routes work the
// same on a switch stack and a lone switch, so both go through a "router":
// the stack, or the switch's own routing state. Also the network's OSPF and
// multicast settings and its multicast rendezvous points.

import { stored } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { ipInCidr, parseCidr, parseIp } from '../validate.js';
import { devOf, limit, netOf, newId as newItemId, requireModel, requireProduct } from './common.js';

const DEV = '/devices/{serial}/switch/routing';
const IFACES = `${DEV}/interfaces`;
const IFACE = `${IFACES}/{interfaceId}`;
const STATIC = `${DEV}/staticRoutes`;
const ROUTE = `${STATIC}/{staticRouteId}`;
const NET = '/networks/{networkId}/switch/routing';
const RPS = `${NET}/multicast/rendezvousPoints`;
const RP = `${RPS}/{rendezvousPointId}`;
const MAX_ITEMS = 128;
const MAX_AREAS = 64;
const MAX_RPS = 64;
// Series that stack and route. MS120 and MS130 do neither.
const LAYER3 = new Set(['MS210', 'MS225', 'MS250', 'MS350', 'MS355', 'MS390', 'MS410', 'MS425', 'MS450']);
export const seriesOf = (dev) => (LAYER3.has(dev.model.split('-')[0]) ? dev.model.split('-')[0] : null);
const OSPF_DEFAULTS = { area: 'disabled', cost: 1, isPassiveEnabled: false, networkType: 'broadcast' };
const DHCP_SERVER_DEFAULTS = { dhcpLeaseTime: '1 day', dnsNameserversOption: 'googlePublicDns', bootOptionsEnabled: false, dhcpOptions: [], reservedIpRanges: [], fixedIpAssignments: [] };
const VRF_ERROR = 'VRF settings need IOS XE firmware 17.18 or higher';
// SSDP, the group clients join most, stands in for groups an 'Any' RP serves.
const SSDP = '239.255.255.250';

const newRand = (ctx, kind, parent, n) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${parent}:${n}`));

function newId(r, taken) {
  let id;
  do id = r.digits(18);
  while (taken.some((x) => x === id));
  return id;
}

export const newL3 = () => ({ defaultGateway: null, interfaces: { created: 0, list: [] }, routes: { created: 0, list: [] } });

// ── Routers ──

export const stackRouter = (net, stack) => ({ net, l3: stack, what: 'stack', parent: stack.id, kinds: ['stackInterface', 'stackStaticRoute'], serial: stack.members.find((d) => net.switches.includes(d))?.serial ?? null });

const switchRouter = (dev) => ({ net: dev.net, l3: (dev.switchRouting ??= newL3()), what: 'switch', parent: dev.serial, kinds: ['switchInterface', 'switchStaticRoute'], serial: dev.serial, dev });

const stacksOf = (net) => (net.switchStacks?.list ?? []).map((s) => ({ id: s.id, name: s.name, members: s.members.filter((d) => net.switches.includes(d)) }));
const stackHolding = (dev) => (dev.net.switchStacks?.list ?? []).find((s) => s.members.includes(dev));

// Every stack, and every lone switch with layer 3 state, in the network.
function routersOf(net) {
  const stacks = (net.switchStacks?.list ?? []).map((s) => stackRouter(net, s));
  return [...stacks, ...net.switches.filter((d) => d.switchRouting && seriesOf(d) && !stackHolding(d)).map(switchRouter)];
}

// The router a switch belongs to, or null when it can't route.
function routerOfDevice(dev) {
  const stack = stackHolding(dev);
  if (stack) return stackRouter(dev.net, stack);
  return seriesOf(dev) ? switchRouter(dev) : null;
}

function switchOf(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'switch');
  if (!seriesOf(dev)) throw badRequest(`${dev.model} switches do not support layer 3 routing`);
  const stack = stackHolding(dev);
  if (stack) throw badRequest(`Switch '${dev.serial}' is in stack '${stack.name}', so its layer 3 settings are under the switch stack routing endpoints`);
  return switchRouter(dev);
}

// ── Layer 3 interfaces ──

export function ifaceOf(R, id) {
  const iface = R.l3.interfaces.list.find((i) => i.interfaceId === id);
  if (!iface) throw notFound('Layer 3 interface');
  return iface;
}

const ipError = (field) => badRequest(`'${field}' must be a valid IPv4 address`);

function overlaps(a, b) {
  const [x, xm] = parseCidr(a);
  const [y, ym] = parseCidr(b);
  const size = 2 ** (32 - Math.min(xm, ym));
  return Math.floor(x / size) === Math.floor(y / size);
}

const ospfOf = (net) => stored(net, 'switchOspf', ospfDefaults);

// Checks a full interface (old values plus the update) against the router's others.
function checkIface(R, iface, self, gateway) {
  const { l3, what } = R;
  if (iface.vlanId == null || iface.subnet == null || iface.interfaceIp == null) throw badRequest("'vlanId', 'subnet' and 'interfaceIp' are required in 'vlan' mode");
  if (!Number.isInteger(iface.vlanId) || iface.vlanId < 1 || iface.vlanId > 4094) throw badRequest('VLAN must be between 1 and 4094');
  if (!parseCidr(iface.subnet)) throw badRequest("'subnet' must be in CIDR notation (ex. 10.1.1.0/24)");
  if (parseIp(iface.interfaceIp) == null) throw ipError('interfaceIp');
  if (!ipInCidr(iface.interfaceIp, iface.subnet)) throw badRequest(`Interface IP ${iface.interfaceIp} is not in subnet ${iface.subnet}`);
  if (R.dev && iface.interfaceIp === R.dev.lanIp) throw badRequest("'interfaceIp' cannot be the same as the device management IP");
  const others = l3.interfaces.list.filter((i) => i !== self);
  if (others.some((i) => i.vlanId === iface.vlanId)) throw badRequest(`VLAN ${iface.vlanId} already has a layer 3 interface on this ${what}`);
  const clash = others.find((o) => overlaps(o.subnet, iface.subnet));
  if (clash) throw badRequest(`Subnet ${iface.subnet} overlaps with the subnet of interface '${clash.name}'`);
  if (iface.mtu != null && (!Number.isInteger(iface.mtu) || iface.mtu < 1280 || iface.mtu > 9198)) throw badRequest("'mtu' must be between 1280 and 9198");
  const ospf = iface.ospfSettings;
  if (ospf.area !== 'disabled' && !ospfOf(R.net).areas.some((a) => a.areaId === ospf.area)) throw badRequest(`OSPF area '${ospf.area}' does not exist`);
  if (!Number.isInteger(ospf.cost) || ospf.cost < 1 || ospf.cost > 65535) throw badRequest('OSPF cost must be between 1 and 65535');
  if (iface.ipv6) {
    const v6 = iface.ipv6;
    if (!['static', 'eui-64'].includes(v6.assignmentMode)) throw badRequest("IPv6 'assignmentMode' must be 'static' or 'eui-64'");
    if (!v6.prefix) throw badRequest("IPv6 'prefix' is required");
    if (v6.assignmentMode === 'static' && !v6.address) throw badRequest("IPv6 'address' is required when 'assignmentMode' is 'static'");
    if (v6.assignmentMode === 'eui-64' && v6.address) throw badRequest("IPv6 'address' must not be included when 'assignmentMode' is 'eui-64'");
    if (!v6.gateway && !others.some((o) => o.ipv6?.gateway)) throw badRequest("IPv6 'gateway' is required on the first interface with IPv6");
  }
  // The default gateway is router-wide and has to sit in one of the interface subnets.
  if (gateway == null) {
    if (!l3.defaultGateway) throw badRequest("'defaultGateway' is required on the first IPv4 interface");
    if (!others.some((o) => ipInCidr(l3.defaultGateway, o.subnet)) && !ipInCidr(l3.defaultGateway, iface.subnet)) throw badRequest(`Default gateway ${l3.defaultGateway} would no longer be in a layer 3 interface subnet`);
  } else {
    if (parseIp(gateway) == null) throw ipError('defaultGateway');
    if (![...others, iface].some((o) => ipInCidr(gateway, o.subnet))) throw badRequest(`Default gateway ${gateway} must be in the subnet of a layer 3 interface`);
  }
}

export function ifaceJson(R, iface) {
  const { l3 } = R;
  const holdsGateway = !!l3.defaultGateway && ipInCidr(l3.defaultGateway, iface.subnet);
  const out = { interfaceId: iface.interfaceId, name: iface.name, mode: 'vlan', subnet: iface.subnet, interfaceIp: iface.interfaceIp };
  if (iface.mtu != null) out.mtu = iface.mtu;
  if (R.dev) out.serial = R.dev.serial;
  Object.assign(out, { multicastRouting: iface.multicastRouting, vlanId: iface.vlanId, uplinkV4: holdsGateway, uplinkV6: !!iface.ipv6?.gateway, ospfSettings: { ...iface.ospfSettings } });
  if (iface.ipv6) {
    out.ospfV3 = { ...OSPF_DEFAULTS };
    const { assignmentMode, address, prefix, gateway } = iface.ipv6;
    out.ipv6 = { assignmentMode, ...(address && { address }), prefix, ...(gateway && { gateway }) };
  }
  if (holdsGateway) out.defaultGateway = l3.defaultGateway;
  return out;
}

const MODE_ERROR = {
  routed: "'routed' mode needs IOS XE firmware 17.18 or higher, and MS switches don't run IOS XE",
  oob_management: "'oob_management' mode needs IOS XE firmware 26.1.2 or higher, and MS switches don't run IOS XE",
  loopback: "'loopback' mode needs IOS XE firmware, and MS switches don't run IOS XE",
};

function applyIface(R, iface, b, self) {
  if (b.vrf) throw badRequest(VRF_ERROR);
  if (b.switchPortId != null) throw badRequest("'switchPortId' only applies to 'routed' mode");
  const next = { ...iface };
  for (const k of ['name', 'subnet', 'interfaceIp', 'mtu', 'multicastRouting', 'vlanId']) if (b[k] !== undefined) next[k] = b[k];
  next.ospfSettings = { ...iface.ospfSettings, ...b.ospfSettings };
  if (b.ipv6) next.ipv6 = { ...b.ipv6 };
  checkIface(R, next, self, b.defaultGateway);
  if (b.defaultGateway != null) R.l3.defaultGateway = b.defaultGateway;
  return Object.assign(iface, next);
}

export function listIfaces(ctx, R) {
  const mode = ctx.query.get('mode');
  const protocol = ctx.query.get('protocol');
  return R.l3.interfaces.list.filter((i) => (!mode || mode === 'vlan') && (protocol !== 'ipv6' || i.ipv6)).map((i) => ifaceJson(R, i));
}

export function createIface(ctx, R) {
  const b = ctx.body;
  const mode = b.mode ?? 'vlan';
  if (MODE_ERROR[mode]) throw badRequest(MODE_ERROR[mode]);
  const store = R.l3.interfaces;
  if (store.list.length >= MAX_ITEMS) throw badRequest(`${R.what === 'stack' ? 'Stacks' : 'Switches'} are limited to ${MAX_ITEMS} layer 3 interfaces in the emulator`);
  const base = { name: b.name, multicastRouting: 'disabled', ospfSettings: { ...OSPF_DEFAULTS }, dhcp: { dhcpMode: 'dhcpDisabled' } };
  const iface = applyIface(R, base, b, null);
  store.created++;
  iface.interfaceId = newId(newRand(ctx, R.kinds[0], R.parent, store.created), store.list.map((i) => i.interfaceId));
  store.list.push(iface);
  return ifaceJson(R, iface);
}

export function updateIface(ctx, R) {
  const iface = ifaceOf(R, ctx.params.interfaceId);
  return ifaceJson(R, applyIface(R, iface, ctx.body, iface));
}

export function deleteIface(ctx, R) {
  const { l3 } = R;
  const iface = ifaceOf(R, ctx.params.interfaceId);
  const list = l3.interfaces.list;
  const rest = list.filter((i) => i !== iface);
  if (rest.length && l3.defaultGateway && !rest.some((i) => ipInCidr(l3.defaultGateway, i.subnet))) {
    throw badRequest(`Move the default gateway (${l3.defaultGateway}) to another interface's subnet before deleting this interface`);
  }
  list.splice(list.indexOf(iface), 1);
  if (!rest.length) l3.defaultGateway = null;
}

// DHCP keeps every field ever set and shows the ones the current mode uses.
export function dhcpJson(dhcp) {
  const { dhcpMode } = dhcp;
  if (dhcpMode === 'dhcpRelay') return { dhcpMode, dhcpRelayServerIps: [...dhcp.dhcpRelayServerIps] };
  if (dhcpMode !== 'dhcpServer') return { dhcpMode };
  const d = { ...DHCP_SERVER_DEFAULTS, ...dhcp };
  const out = { dhcpMode, dhcpLeaseTime: d.dhcpLeaseTime, dnsNameserversOption: d.dnsNameserversOption };
  if (d.dnsNameserversOption === 'custom') out.dnsCustomNameservers = [...d.dnsCustomNameservers];
  out.bootOptionsEnabled = d.bootOptionsEnabled;
  if (d.bootOptionsEnabled) Object.assign(out, { bootNextServer: d.bootNextServer, bootFileName: d.bootFileName });
  return { ...out, dhcpOptions: structuredClone(d.dhcpOptions), reservedIpRanges: structuredClone(d.reservedIpRanges), fixedIpAssignments: structuredClone(d.fixedIpAssignments) };
}

export function updateDhcp(ctx, R) {
  const iface = ifaceOf(R, ctx.params.interfaceId);
  const d = { ...iface.dhcp, ...ctx.body };
  const ips = (list, field) => {
    for (const ip of list || []) if (parseIp(ip) == null) throw ipError(field);
  };
  if (d.dhcpMode === 'dhcpRelay') {
    if (!d.dhcpRelayServerIps?.length) throw badRequest("'dhcpRelayServerIps' is required when 'dhcpMode' is 'dhcpRelay'");
    ips(d.dhcpRelayServerIps, 'dhcpRelayServerIps');
  }
  if (d.dhcpMode === 'dhcpServer') {
    if (d.dnsNameserversOption === 'custom' && !d.dnsCustomNameservers?.length) throw badRequest("'dnsCustomNameservers' is required when 'dnsNameserversOption' is 'custom'");
    if (d.bootOptionsEnabled && (!d.bootNextServer || !d.bootFileName)) throw badRequest("'bootNextServer' and 'bootFileName' are required when boot options are enabled");
    for (const r of d.reservedIpRanges || []) {
      if (!ipInCidr(r.start, iface.subnet) || !ipInCidr(r.end, iface.subnet) || parseIp(r.start) > parseIp(r.end)) throw badRequest(`Reserved range ${r.start}-${r.end} must be inside ${iface.subnet}`);
    }
    for (const f of d.fixedIpAssignments || []) if (!ipInCidr(f.ip, iface.subnet)) throw badRequest(`Fixed IP ${f.ip} must be inside ${iface.subnet}`);
  }
  iface.dhcp = d;
  return dhcpJson(d);
}

// ── Static routes ──

export function routeOf(R, id) {
  const route = R.l3.routes.list.find((r) => r.staticRouteId === id);
  if (!route) throw notFound('Static route');
  return route;
}

export function routeJson(route) {
  const { staticRouteId, name, subnet, nextHopIp, managementNextHop, advertiseViaOspfEnabled, preferOverOspfRoutesEnabled } = route;
  return { staticRouteId, name, subnet, nextHopIp, ...(managementNextHop && { managementNextHop }), advertiseViaOspfEnabled, preferOverOspfRoutesEnabled };
}

export function applyRoute(R, route, b, self) {
  const { l3 } = R;
  if (b.vrf) throw badRequest(VRF_ERROR);
  const next = { ...route };
  for (const k of ['name', 'subnet', 'nextHopIp', 'managementNextHop', 'advertiseViaOspfEnabled', 'preferOverOspfRoutesEnabled']) if (b[k] !== undefined) next[k] = b[k];
  if (!parseCidr(next.subnet)) throw badRequest("'subnet' must be in CIDR notation (ex. 1.2.3.0/24)");
  if (parseIp(next.nextHopIp) == null) throw ipError('nextHopIp');
  if (!l3.interfaces.list.some((i) => ipInCidr(next.nextHopIp, i.subnet))) throw badRequest(`Next hop ${next.nextHopIp} must be in the subnet of a layer 3 interface on this ${R.what}`);
  if (next.managementNextHop && parseIp(next.managementNextHop) == null) throw ipError('managementNextHop');
  if (l3.routes.list.some((r) => r !== self && r.subnet === next.subnet)) throw badRequest(`A static route for ${next.subnet} already exists`);
  return Object.assign(route, next);
}

export function createRoute(ctx, R) {
  const store = R.l3.routes;
  if (store.list.length >= MAX_ITEMS) throw badRequest(`${R.what === 'stack' ? 'Stacks' : 'Switches'} are limited to ${MAX_ITEMS} static routes in the emulator`);
  const route = applyRoute(R, { name: null, advertiseViaOspfEnabled: false, preferOverOspfRoutesEnabled: false }, ctx.body, null);
  store.created++;
  route.staticRouteId = newId(newRand(ctx, R.kinds[1], R.parent, store.created), store.list.map((r) => r.staticRouteId));
  store.list.push(route);
  return routeJson(route);
}

export function deleteRoute(ctx, R) {
  const list = R.l3.routes.list;
  list.splice(list.indexOf(routeOf(R, ctx.params.staticRouteId)), 1);
}

// ── OSPF ──

const BACKBONE = { areaId: '0', areaName: 'Backbone', areaType: 'normal' };
function ospfDefaults() {
  const base = { enabled: false, helloTimerInSeconds: 10, deadTimerInSeconds: 40, areas: [{ ...BACKBONE }] };
  return { ...base, v3: structuredClone(base), md5AuthenticationEnabled: false, md5AuthenticationKey: null };
}

function switchNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return net;
}

function ospfNet(ctx) {
  if (ctx.query.has('vrf')) throw badRequest(VRF_ERROR);
  return switchNet(ctx);
}

function ospfJson(o) {
  const { md5AuthenticationKey, ...out } = structuredClone(o);
  if (o.md5AuthenticationEnabled) out.md5AuthenticationKey = { ...md5AuthenticationKey };
  return out;
}

function inRange(v, min, max, name) {
  if (v != null && (!Number.isInteger(v) || v < min || v > max)) throw badRequest(`'${name}' must be between ${min} and ${max}`);
}

function checkAreas(areas, at) {
  limit(areas, MAX_AREAS, 'OSPF areas');
  const seen = new Set();
  for (const [i, a] of areas.entries()) {
    if (!/^\d{1,10}$/.test(a.areaId) || Number(a.areaId) > 4294967295) throw badRequest(`'${at}[${i}].areaId' must be a number from 0 to 4294967295`);
    if (!a.areaName?.trim()) throw badRequest(`'${at}[${i}].areaName' must not be empty`);
    if (seen.has(a.areaId)) throw badRequest(`OSPF area '${a.areaId}' is listed more than once`);
    seen.add(a.areaId);
  }
  return areas.map(({ areaId, areaName, areaType }) => ({ areaId, areaName, areaType }));
}

function updateOspf(ctx) {
  const net = ospfNet(ctx);
  const o = ospfOf(net);
  const b = ctx.body;
  const next = structuredClone(o);
  for (const k of ['enabled', 'helloTimerInSeconds', 'deadTimerInSeconds', 'md5AuthenticationEnabled']) if (b[k] != null) next[k] = b[k];
  if (b.areas) next.areas = checkAreas(b.areas, 'areas');
  if (b.v3) {
    for (const k of ['enabled', 'helloTimerInSeconds', 'deadTimerInSeconds']) if (b.v3[k] != null) next.v3[k] = b.v3[k];
    if (b.v3.areas) next.v3.areas = checkAreas(b.v3.areas, 'v3.areas');
  }
  if (b.md5AuthenticationKey) next.md5AuthenticationKey = { ...next.md5AuthenticationKey, ...b.md5AuthenticationKey };
  for (const [x, at] of [[next, ''], [next.v3, 'v3.']]) {
    inRange(x.helloTimerInSeconds, 1, 255, `${at}helloTimerInSeconds`);
    inRange(x.deadTimerInSeconds, 1, 65535, `${at}deadTimerInSeconds`);
  }
  if (next.md5AuthenticationEnabled) {
    const key = next.md5AuthenticationKey;
    if (key?.id == null || !key.passphrase) throw badRequest("'md5AuthenticationKey' needs an 'id' and a 'passphrase' when MD5 authentication is enabled");
    inRange(key.id, 1, 255, 'md5AuthenticationKey.id');
  }
  // An area can't go while an interface still uses it.
  for (const R of routersOf(net)) {
    const used = R.l3.interfaces.list.find((i) => i.ospfSettings.area !== 'disabled' && !next.areas.some((a) => a.areaId === i.ospfSettings.area));
    if (used) throw badRequest(`OSPF area '${used.ospfSettings.area}' is used by layer 3 interface '${used.name}'`);
  }
  Object.assign(o, next);
  return ospfJson(o);
}

// ── Multicast ──

const multicastDefaults = () => ({ defaultSettings: { igmpSnoopingEnabled: true, floodUnknownMulticastTrafficEnabled: true }, overrides: [] });
const multicastOf = (net) => stored(net, 'switchMulticast', multicastDefaults);
const profilesOf = (net) => net.template?.profiles ?? [];

// Switches, stacks and profiles that left the network drop out of their override.
function multicastJson(net) {
  const m = multicastOf(net);
  const stackIds = stacksOf(net).map((s) => s.id);
  const keep = { switches: (s) => net.switches.some((d) => d.serial === s), stacks: (id) => stackIds.includes(id), switchProfiles: (id) => profilesOf(net).some((p) => p.switchProfileId === id) };
  const overrides = [];
  for (const o of m.overrides) {
    const [key, ids] = Object.entries(o).find(([k]) => k in keep);
    const left = ids.filter(keep[key]);
    if (left.length) overrides.push({ [key]: left, igmpSnoopingEnabled: o.igmpSnoopingEnabled, floodUnknownMulticastTrafficEnabled: o.floodUnknownMulticastTrafficEnabled });
  }
  return { defaultSettings: { ...m.defaultSettings }, overrides };
}

function checkOverride(net, o, i, seen) {
  const lists = ['switches', 'stacks', 'switchProfiles'].filter((k) => o[k]?.length);
  if (lists.length !== 1) throw badRequest(`'overrides[${i}]' needs exactly one of 'switches', 'stacks' or 'switchProfiles'`);
  const [key] = lists;
  const bound = !!net.template;
  if (bound !== (key === 'switchProfiles')) throw badRequest(bound ? "A network bound to a config template takes 'switchProfiles' overrides only" : "'switchProfiles' only applies to networks bound to a config template");
  const stacks = stacksOf(net);
  for (const id of o[key]) {
    if (seen.has(id)) throw badRequest(`'${id}' is in more than one override`);
    seen.add(id);
    if (key === 'switches') {
      const dev = net.switches.find((d) => d.serial === id);
      if (!dev) throw badRequest(`Switch '${id}' is not in this network`);
      const stack = stacks.find((s) => s.members.includes(dev));
      if (stack) throw badRequest(`Switch '${id}' is in stack '${stack.name}', so list the stack instead`);
    } else if (key === 'stacks') {
      if (!stacks.some((s) => s.id === id)) throw badRequest(`Switch stack '${id}' does not exist in this network`);
    } else if (!profilesOf(net).some((p) => p.switchProfileId === id)) throw badRequest(`Switch profile '${id}' is not in this network's config template`);
  }
  return { [key]: [...o[key]], igmpSnoopingEnabled: o.igmpSnoopingEnabled, floodUnknownMulticastTrafficEnabled: o.floodUnknownMulticastTrafficEnabled };
}

function updateMulticast(ctx) {
  const net = switchNet(ctx);
  const m = multicastOf(net);
  const b = ctx.body;
  const seen = new Set();
  const overrides = b.overrides ? limit(b.overrides, MAX_ITEMS, 'Multicast overrides').map((o, i) => checkOverride(net, o, i, seen)) : null;
  if (b.defaultSettings) for (const k of ['igmpSnoopingEnabled', 'floodUnknownMulticastTrafficEnabled']) if (b.defaultSettings[k] != null) m.defaultSettings[k] = b.defaultSettings[k];
  if (overrides) m.overrides = overrides;
  return multicastJson(net);
}

// ── Rendezvous points ──

// Kept on the network, not its config, since each names one of its interfaces.
const rpsOf = (net) => (net.switchRendezvousPoints ??= { created: 0, list: [] });

// The router holding an interface, or null once the interface is gone.
function holderOf(net, iface) {
  return routersOf(net).find((R) => R.l3.interfaces.list.includes(iface)) ?? null;
}

function livePoints(net) {
  return rpsOf(net)
    .list.map((rp) => ({ rp, R: holderOf(net, rp.iface) }))
    .filter((x) => x.R);
}

const rpJson = ({ rp, R }) => ({ rendezvousPointId: rp.id, serial: R.serial, interfaceName: rp.iface.name, interfaceIp: rp.iface.interfaceIp, multicastGroup: rp.multicastGroup });

function rpOf(ctx) {
  const net = switchNet(ctx);
  const found = livePoints(net).find((x) => x.rp.id === ctx.params.rendezvousPointId);
  if (!found) throw notFound('Rendezvous point');
  return { net, ...found };
}

function applyRp(net, rp, b) {
  if (b.vrf) throw badRequest(VRF_ERROR);
  if (parseIp(b.interfaceIp) == null) throw ipError('interfaceIp');
  const group = b.multicastGroup;
  if (group !== 'Any' && !ipInCidr(group, '224.0.0.0/4')) throw badRequest("'multicastGroup' must be 'Any' or a multicast IP address (224.0.0.0 to 239.255.255.255)");
  const iface = routersOf(net)
    .flatMap((R) => R.l3.interfaces.list)
    .find((i) => i.interfaceIp === b.interfaceIp);
  if (!iface) throw badRequest(`No layer 3 interface in this network has the IP ${b.interfaceIp}`);
  if (livePoints(net).some((x) => x.rp !== rp && x.rp.multicastGroup === group)) throw badRequest(`A rendezvous point for multicast group '${group}' already exists`);
  return Object.assign(rp, { iface, multicastGroup: group });
}

function createRp(ctx) {
  const net = switchNet(ctx);
  const store = rpsOf(net);
  if (livePoints(net).length >= MAX_RPS) throw badRequest(`Rendezvous points are limited to ${MAX_RPS} in the emulator`);
  const rp = applyRp(net, {}, ctx.body);
  rp.id = newItemId(ctx, store, 'rendezvousPoint', net.id);
  store.list = store.list.filter((x) => holderOf(net, x.iface));
  store.list.push(rp);
  return rpJson({ rp, R: holderOf(net, rp.iface) });
}

// ── Multicast routing live tool ──

const pimOf = (R) => R.l3.interfaces.list.filter((i) => i.multicastRouting === 'enabled');

// PIM interfaces and multicast routes on a switch, from the routing settings.
// Both are empty until an interface on the switch (or its stack) runs PIM.
export function multicastState(dev) {
  const R = routerOfDevice(dev);
  const pim = R ? pimOf(R) : [];
  if (!pim.length) return { interfaces: [], routes: [] };
  const name = (i) => `Vlan${i.vlanId}`;
  const peers = routersOf(dev.net)
    .filter((o) => o.l3 !== R.l3)
    .flatMap(pimOf);
  const interfaces = pim.map((i) => {
    const neighbors = peers.filter((p) => ipInCidr(p.interfaceIp, i.subnet)).map((p) => p.interfaceIp);
    const flags = ['PIM'];
    if (!neighbors.length) flags.push('NO-NBR');
    if (neighbors.every((n) => parseIp(n) < parseIp(i.interfaceIp))) flags.push('DR');
    return { ip: i.interfaceIp, name: name(i), subnet: i.subnet, flags, neighbors };
  });
  const routes = livePoints(dev.net).map(({ rp, R: holder }) => {
    const local = holder.l3 === R.l3;
    const incoming = local ? null : pim.find((i) => ipInCidr(rp.iface.interfaceIp, i.subnet));
    const outgoing = pim.filter((i) => i !== incoming).map(name);
    const flags = ['WC'];
    if (local) flags.push('RP');
    if (!outgoing.length) flags.push('NULL_OIF');
    const group = rp.multicastGroup === 'Any' ? SSDP : rp.multicastGroup;
    return { source: 'Any', group, rendezvousPoint: rp.iface.interfaceIp, incomingInterfaceName: incoming ? name(incoming) : 'Null', outgoingInterfaceNames: outgoing, flags };
  });
  return { interfaces, routes };
}

// Sample IDs for the single-item GETs; switches start with no interfaces or routes.
const MISSING = { interfaceId: '578149602163689001', staticRouteId: '578149602163689002', rendezvousPointId: '578149602163689003', status: 404 };

export default [
  { op: 'getDeviceSwitchRoutingInterfaces', path: IFACES, handler: (ctx) => listIfaces(ctx, switchOf(ctx)) },
  { op: 'createDeviceSwitchRoutingInterface', method: 'POST', path: IFACES, handler: (ctx) => createIface(ctx, switchOf(ctx)) },
  {
    op: 'getDeviceSwitchRoutingInterface',
    path: IFACE,
    sample: MISSING,
    handler: (ctx) => {
      const R = switchOf(ctx);
      return ifaceJson(R, ifaceOf(R, ctx.params.interfaceId));
    },
  },
  { op: 'updateDeviceSwitchRoutingInterface', method: 'PUT', path: IFACE, handler: (ctx) => updateIface(ctx, switchOf(ctx)) },
  { op: 'deleteDeviceSwitchRoutingInterface', method: 'DELETE', path: IFACE, handler: (ctx) => deleteIface(ctx, switchOf(ctx)) },
  { op: 'getDeviceSwitchRoutingInterfaceDhcp', path: `${IFACE}/dhcp`, sample: MISSING, handler: (ctx) => dhcpJson(ifaceOf(switchOf(ctx), ctx.params.interfaceId).dhcp) },
  { op: 'updateDeviceSwitchRoutingInterfaceDhcp', method: 'PUT', path: `${IFACE}/dhcp`, handler: (ctx) => updateDhcp(ctx, switchOf(ctx)) },
  { op: 'getDeviceSwitchRoutingStaticRoutes', path: STATIC, handler: (ctx) => switchOf(ctx).l3.routes.list.map(routeJson) },
  // The spec answers this create with 200 and the update with 201.
  { op: 'createDeviceSwitchRoutingStaticRoute', method: 'POST', path: STATIC, status: 200, handler: (ctx) => createRoute(ctx, switchOf(ctx)) },
  { op: 'getDeviceSwitchRoutingStaticRoute', path: ROUTE, sample: MISSING, handler: (ctx) => routeJson(routeOf(switchOf(ctx), ctx.params.staticRouteId)) },
  {
    op: 'updateDeviceSwitchRoutingStaticRoute',
    method: 'PUT',
    path: ROUTE,
    status: 201,
    handler: (ctx) => {
      const R = switchOf(ctx);
      const route = routeOf(R, ctx.params.staticRouteId);
      return routeJson(applyRoute(R, route, ctx.body, route));
    },
  },
  { op: 'deleteDeviceSwitchRoutingStaticRoute', method: 'DELETE', path: ROUTE, handler: (ctx) => deleteRoute(ctx, switchOf(ctx)) },
  { op: 'getNetworkSwitchRoutingOspf', path: `${NET}/ospf`, handler: (ctx) => ospfJson(ospfOf(ospfNet(ctx))) },
  { op: 'updateNetworkSwitchRoutingOspf', method: 'PUT', path: `${NET}/ospf`, handler: updateOspf },
  { op: 'getNetworkSwitchRoutingMulticast', path: `${NET}/multicast`, handler: (ctx) => multicastJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchRoutingMulticast', method: 'PUT', path: `${NET}/multicast`, handler: updateMulticast },
  { op: 'getNetworkSwitchRoutingMulticastRendezvousPoints', path: RPS, handler: (ctx) => livePoints(switchNet(ctx)).map(rpJson) },
  { op: 'createNetworkSwitchRoutingMulticastRendezvousPoint', method: 'POST', path: RPS, handler: createRp },
  { op: 'getNetworkSwitchRoutingMulticastRendezvousPoint', path: RP, sample: MISSING, handler: (ctx) => rpJson(rpOf(ctx)) },
  {
    op: 'updateNetworkSwitchRoutingMulticastRendezvousPoint',
    method: 'PUT',
    path: RP,
    handler: (ctx) => {
      const { net, rp } = rpOf(ctx);
      applyRp(net, rp, ctx.body);
      return rpJson({ rp, R: holderOf(net, rp.iface) });
    },
  },
  {
    op: 'deleteNetworkSwitchRoutingMulticastRendezvousPoint',
    method: 'DELETE',
    path: RP,
    handler: (ctx) => {
      const { net, rp } = rpOf(ctx);
      const list = rpsOf(net).list;
      list.splice(list.indexOf(rp), 1);
    },
  },
];
