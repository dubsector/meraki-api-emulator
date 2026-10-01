// MS switch stacks: membership, plus each stack's layer 3 interfaces (with
// DHCP) and static routes. Networks start with no stacks; writes create them.

import { DEVICE_OUI } from '../catalog.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { ipInCidr, parseCidr, parseIp } from '../validate.js';
import { netOf, requireProduct } from './common.js';

const LIST = '/networks/{networkId}/switch/stacks';
const STACK = `${LIST}/{switchStackId}`;
const IFACES = `${STACK}/routing/interfaces`;
const IFACE = `${IFACES}/{interfaceId}`;
const STATIC = `${STACK}/routing/staticRoutes`;
const ROUTE = `${STATIC}/{staticRouteId}`;
const MAX_MEMBERS = 8;
const MAX_ITEMS = 128;
// Only switches of the same series stack together. MS120 and MS130 can't stack.
const STACKABLE = new Set(['MS210', 'MS225', 'MS250', 'MS350', 'MS355', 'MS390', 'MS410', 'MS425', 'MS450']);
const seriesOf = (dev) => (STACKABLE.has(dev.model.split('-')[0]) ? dev.model.split('-')[0] : null);
const OSPF_DEFAULTS = { area: 'disabled', cost: 1, isPassiveEnabled: false, networkType: 'broadcast' };
const DHCP_SERVER_DEFAULTS = { dhcpLeaseTime: '1 day', dnsNameserversOption: 'googlePublicDns', bootOptionsEnabled: false, dhcpOptions: [], reservedIpRanges: [], fixedIpAssignments: [] };

// Kept on the network, not its config, so copying a network doesn't copy stacks.
function storeOf(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return { net, store: (net.switchStacks ??= { created: 0, list: [] }) };
}

// Members are device objects, so a swapped switch keeps its place and a removed one drops out.
function prune(net, stack) {
  stack.members = stack.members.filter((d) => net.switches.includes(d));
  return stack;
}

function stackOf(ctx) {
  const { net, store } = storeOf(ctx);
  const stack = store.list.find((s) => s.id === ctx.params.switchStackId);
  if (!stack) throw notFound('Switch stack');
  return { net, store, stack: prune(net, stack) };
}

function overlaps(a, b) {
  const [x, xm] = parseCidr(a);
  const [y, ym] = parseCidr(b);
  const size = 2 ** (32 - Math.min(xm, ym));
  return Math.floor(x / size) === Math.floor(y / size);
}

const newRand = (ctx, kind, parent, n) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${parent}:${n}`));

function newId(r, taken) {
  let id;
  do id = r.digits(18);
  while (taken.some((x) => x === id));
  return id;
}

function checkMembers(net, store, serials, self) {
  if (serials.length < 2) throw badRequest('A switch stack needs at least 2 switches');
  if (serials.length > MAX_MEMBERS) throw badRequest(`A switch stack can have at most ${MAX_MEMBERS} switches`);
  if (new Set(serials).size !== serials.length) throw badRequest('Each switch can only be listed once');
  const devs = serials.map((serial) => {
    const dev = net.switches.find((s) => s.serial === serial);
    if (!dev) throw badRequest(`Switch '${serial}' is not in this network`);
    if (!seriesOf(dev)) throw badRequest(`${dev.model} switches do not support stacking`);
    const other = store.list.find((s) => s !== self && s.members.includes(dev));
    if (other) throw badRequest(`Switch '${serial}' is already in stack '${other.name}'`);
    return dev;
  });
  if (new Set(devs.map(seriesOf)).size > 1) throw badRequest('Switches in a stack must all be the same series');
  return devs;
}

function stackJson(stack) {
  return {
    id: stack.id,
    name: stack.name,
    serials: stack.members.map((d) => d.serial),
    isMonitorOnly: false,
    virtualMac: stack.virtualMac,
    members: stack.members.map((d, i) => ({ serial: d.serial, name: d.name, model: d.model, mac: d.mac, role: i === 0 ? 'active' : i === 1 ? 'standby' : 'member' })),
  };
}

function createStack(ctx) {
  const { net, store } = storeOf(ctx);
  const members = checkMembers(net, store, ctx.body.serials, null);
  // Seeded from a count that never goes down, so the same calls give the same IDs.
  store.created++;
  const r = newRand(ctx, 'switchStack', net.id, store.created);
  const id = newId(r, store.list.map((s) => s.id));
  const stack = {
    id,
    name: ctx.body.name,
    members,
    virtualMac: `${DEVICE_OUI.switch}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`,
    workflowId: r.digits(18),
    defaultGateway: null,
    interfaces: { created: 0, list: [] },
    routes: { created: 0, list: [] },
  };
  store.list.push(stack);
  return { id, name: stack.name, serials: members.map((d) => d.serial), workflowId: stack.workflowId };
}

function updateStack(ctx) {
  const { net, store, stack } = stackOf(ctx);
  const { name, members } = ctx.body;
  if (name == null && members == null) throw badRequest("At least one of 'name' or 'members' must be provided");
  if (members != null) stack.members = checkMembers(net, store, members.map((m) => m.serial), stack);
  if (name != null) stack.name = name;
  return stackJson(stack);
}

function addToStack(ctx) {
  const { net, store, stack } = stackOf(ctx);
  const { serial } = ctx.body;
  if (stack.members.some((d) => d.serial === serial)) throw badRequest(`Switch '${serial}' is already in this stack`);
  stack.members = checkMembers(net, store, [...stack.members.map((d) => d.serial), serial], stack);
  return stackJson(stack);
}

function removeFromStack(ctx) {
  const { stack } = stackOf(ctx);
  const { serial } = ctx.body;
  if (!stack.members.some((d) => d.serial === serial)) throw badRequest(`Switch '${serial}' is not in this stack`);
  if (stack.members.length <= 2) throw badRequest('A switch stack needs at least 2 switches');
  stack.members = stack.members.filter((d) => d.serial !== serial);
  return stackJson(stack);
}

// Layer 3 interfaces

function ifaceOf(stack, id) {
  const iface = stack.interfaces.list.find((i) => i.interfaceId === id);
  if (!iface) throw notFound('Layer 3 interface');
  return iface;
}

const ipError = (field) => badRequest(`'${field}' must be a valid IPv4 address`);

// Checks a full interface (old values plus the update) against the stack's others.
function checkIface(stack, iface, self, gateway) {
  if (iface.vlanId == null || iface.subnet == null || iface.interfaceIp == null) throw badRequest("'vlanId', 'subnet' and 'interfaceIp' are required in 'vlan' mode");
  if (!Number.isInteger(iface.vlanId) || iface.vlanId < 1 || iface.vlanId > 4094) throw badRequest('VLAN must be between 1 and 4094');
  if (!parseCidr(iface.subnet)) throw badRequest("'subnet' must be in CIDR notation (ex. 10.1.1.0/24)");
  if (parseIp(iface.interfaceIp) == null) throw ipError('interfaceIp');
  if (!ipInCidr(iface.interfaceIp, iface.subnet)) throw badRequest(`Interface IP ${iface.interfaceIp} is not in subnet ${iface.subnet}`);
  const others = stack.interfaces.list.filter((i) => i !== self);
  if (others.some((i) => i.vlanId === iface.vlanId)) throw badRequest(`VLAN ${iface.vlanId} already has a layer 3 interface on this stack`);
  const clash = others.find((o) => overlaps(o.subnet, iface.subnet));
  if (clash) throw badRequest(`Subnet ${iface.subnet} overlaps with the subnet of interface '${clash.name}'`);
  if (iface.mtu != null && (!Number.isInteger(iface.mtu) || iface.mtu < 1280 || iface.mtu > 9198)) throw badRequest("'mtu' must be between 1280 and 9198");
  const ospf = iface.ospfSettings;
  if (ospf.area !== 'disabled' && ospf.area !== '0') throw badRequest(`OSPF area '${ospf.area}' does not exist`);
  if (!Number.isInteger(ospf.cost) || ospf.cost < 1 || ospf.cost > 65535) throw badRequest('OSPF cost must be between 1 and 65535');
  if (iface.ipv6) {
    const v6 = iface.ipv6;
    if (!['static', 'eui-64'].includes(v6.assignmentMode)) throw badRequest("IPv6 'assignmentMode' must be 'static' or 'eui-64'");
    if (!v6.prefix) throw badRequest("IPv6 'prefix' is required");
    if (v6.assignmentMode === 'static' && !v6.address) throw badRequest("IPv6 'address' is required when 'assignmentMode' is 'static'");
    if (v6.assignmentMode === 'eui-64' && v6.address) throw badRequest("IPv6 'address' must not be included when 'assignmentMode' is 'eui-64'");
    if (!v6.gateway && !others.some((o) => o.ipv6?.gateway)) throw badRequest("IPv6 'gateway' is required on the first interface with IPv6");
  }
  // The default gateway is stack-wide and has to sit in one of the interface subnets.
  if (gateway == null) {
    if (!stack.defaultGateway) throw badRequest("'defaultGateway' is required on the first IPv4 interface");
    if (!others.some((o) => ipInCidr(stack.defaultGateway, o.subnet)) && !ipInCidr(stack.defaultGateway, iface.subnet)) throw badRequest(`Default gateway ${stack.defaultGateway} would no longer be in a layer 3 interface subnet`);
  } else {
    if (parseIp(gateway) == null) throw ipError('defaultGateway');
    if (![...others, iface].some((o) => ipInCidr(gateway, o.subnet))) throw badRequest(`Default gateway ${gateway} must be in the subnet of a layer 3 interface`);
  }
}

function ifaceJson(stack, iface) {
  const holdsGateway = !!stack.defaultGateway && ipInCidr(stack.defaultGateway, iface.subnet);
  const out = { interfaceId: iface.interfaceId, name: iface.name, mode: 'vlan', subnet: iface.subnet, interfaceIp: iface.interfaceIp };
  if (iface.mtu != null) out.mtu = iface.mtu;
  Object.assign(out, { multicastRouting: iface.multicastRouting, vlanId: iface.vlanId, uplinkV4: holdsGateway, uplinkV6: !!iface.ipv6?.gateway, ospfSettings: { ...iface.ospfSettings } });
  if (iface.ipv6) {
    out.ospfV3 = { ...OSPF_DEFAULTS };
    const { assignmentMode, address, prefix, gateway } = iface.ipv6;
    out.ipv6 = { assignmentMode, ...(address && { address }), prefix, ...(gateway && { gateway }) };
  }
  if (holdsGateway) out.defaultGateway = stack.defaultGateway;
  return out;
}

const MODE_ERROR = {
  routed: "'routed' mode needs IOS XE firmware 17.18 or higher, and MS switches don't run IOS XE",
  oob_management: "'oob_management' mode needs IOS XE firmware 26.1.2 or higher, and MS switches don't run IOS XE",
  loopback: "'loopback' mode needs IOS XE firmware, and MS switches don't run IOS XE",
};

function applyIface(stack, iface, b, self) {
  if (b.vrf) throw badRequest('VRF settings need IOS XE firmware 17.18 or higher');
  if (b.switchPortId != null) throw badRequest("'switchPortId' only applies to 'routed' mode");
  const next = { ...iface };
  for (const k of ['name', 'subnet', 'interfaceIp', 'mtu', 'multicastRouting', 'vlanId']) if (b[k] !== undefined) next[k] = b[k];
  next.ospfSettings = { ...iface.ospfSettings, ...b.ospfSettings };
  if (b.ipv6) next.ipv6 = { ...b.ipv6 };
  checkIface(stack, next, self, b.defaultGateway);
  if (b.defaultGateway != null) stack.defaultGateway = b.defaultGateway;
  return Object.assign(iface, next);
}

function createIface(ctx) {
  const { stack } = stackOf(ctx);
  const b = ctx.body;
  const mode = b.mode ?? 'vlan';
  if (MODE_ERROR[mode]) throw badRequest(MODE_ERROR[mode]);
  const store = stack.interfaces;
  if (store.list.length >= MAX_ITEMS) throw badRequest(`Stacks are limited to ${MAX_ITEMS} layer 3 interfaces in the emulator`);
  const base = { name: b.name, multicastRouting: 'disabled', ospfSettings: { ...OSPF_DEFAULTS }, dhcp: { dhcpMode: 'dhcpDisabled' } };
  const iface = applyIface(stack, base, b, null);
  store.created++;
  iface.interfaceId = newId(newRand(ctx, 'stackInterface', stack.id, store.created), store.list.map((i) => i.interfaceId));
  store.list.push(iface);
  return ifaceJson(stack, iface);
}

function updateIface(ctx) {
  const { stack } = stackOf(ctx);
  const iface = ifaceOf(stack, ctx.params.interfaceId);
  // The spec's update response has no defaultGateway, unlike create and get.
  const { defaultGateway, ...out } = ifaceJson(stack, applyIface(stack, iface, ctx.body, iface));
  return out;
}

function deleteIface(ctx) {
  const { stack } = stackOf(ctx);
  const iface = ifaceOf(stack, ctx.params.interfaceId);
  const list = stack.interfaces.list;
  const rest = list.filter((i) => i !== iface);
  if (rest.length && stack.defaultGateway && !rest.some((i) => ipInCidr(stack.defaultGateway, i.subnet))) {
    throw badRequest(`Move the default gateway (${stack.defaultGateway}) to another interface's subnet before deleting this interface`);
  }
  list.splice(list.indexOf(iface), 1);
  if (!rest.length) stack.defaultGateway = null;
}

// DHCP keeps every field ever set and shows the ones the current mode uses.
function dhcpJson(dhcp) {
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

function updateDhcp(ctx) {
  const { stack } = stackOf(ctx);
  const iface = ifaceOf(stack, ctx.params.interfaceId);
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

// Static routes

function routeOf(stack, id) {
  const route = stack.routes.list.find((r) => r.staticRouteId === id);
  if (!route) throw notFound('Static route');
  return route;
}

function routeJson(route) {
  const { staticRouteId, name, subnet, nextHopIp, managementNextHop, advertiseViaOspfEnabled, preferOverOspfRoutesEnabled } = route;
  return { staticRouteId, name, subnet, nextHopIp, ...(managementNextHop && { managementNextHop }), advertiseViaOspfEnabled, preferOverOspfRoutesEnabled };
}

function applyRoute(stack, route, b, self) {
  if (b.vrf) throw badRequest('VRF settings need IOS XE firmware 17.18 or higher');
  const next = { ...route };
  for (const k of ['name', 'subnet', 'nextHopIp', 'managementNextHop', 'advertiseViaOspfEnabled', 'preferOverOspfRoutesEnabled']) if (b[k] !== undefined) next[k] = b[k];
  if (!parseCidr(next.subnet)) throw badRequest("'subnet' must be in CIDR notation (ex. 1.2.3.0/24)");
  if (parseIp(next.nextHopIp) == null) throw ipError('nextHopIp');
  if (!stack.interfaces.list.some((i) => ipInCidr(next.nextHopIp, i.subnet))) throw badRequest(`Next hop ${next.nextHopIp} must be in the subnet of a layer 3 interface on this stack`);
  if (next.managementNextHop && parseIp(next.managementNextHop) == null) throw ipError('managementNextHop');
  if (stack.routes.list.some((r) => r !== self && r.subnet === next.subnet)) throw badRequest(`A static route for ${next.subnet} already exists`);
  return Object.assign(route, next);
}

function createRoute(ctx) {
  const { stack } = stackOf(ctx);
  const store = stack.routes;
  if (store.list.length >= MAX_ITEMS) throw badRequest(`Stacks are limited to ${MAX_ITEMS} static routes in the emulator`);
  const route = applyRoute(stack, { name: null, advertiseViaOspfEnabled: false, preferOverOspfRoutesEnabled: false }, ctx.body, null);
  store.created++;
  route.staticRouteId = newId(newRand(ctx, 'stackStaticRoute', stack.id, store.created), store.list.map((r) => r.staticRouteId));
  store.list.push(route);
  return routeJson(route);
}

// Sample IDs for the single-item GETs; no stack exists until one is created.
const MISSING = { switchStackId: '578149602163689000', interfaceId: '578149602163689001', staticRouteId: '578149602163689002', status: 404 };

export default [
  {
    op: 'getNetworkSwitchStacks',
    path: LIST,
    handler: (ctx) => {
      const { net, store } = storeOf(ctx);
      return store.list.map((s) => stackJson(prune(net, s)));
    },
  },
  { op: 'createNetworkSwitchStack', method: 'POST', path: LIST, status: 200, handler: createStack },
  { op: 'getNetworkSwitchStack', path: STACK, sample: MISSING, handler: (ctx) => stackJson(stackOf(ctx).stack) },
  { op: 'updateNetworkSwitchStack', method: 'PUT', path: STACK, handler: updateStack },
  {
    op: 'deleteNetworkSwitchStack',
    method: 'DELETE',
    path: STACK,
    handler: (ctx) => {
      const { store, stack } = stackOf(ctx);
      store.list.splice(store.list.indexOf(stack), 1);
    },
  },
  { op: 'addNetworkSwitchStack', method: 'POST', path: `${STACK}/add`, status: 200, handler: addToStack },
  { op: 'removeNetworkSwitchStack', method: 'POST', path: `${STACK}/remove`, status: 200, handler: removeFromStack },
  {
    op: 'getNetworkSwitchStackRoutingInterfaces',
    path: IFACES,
    sample: MISSING,
    handler: (ctx) => {
      const { stack } = stackOf(ctx);
      const mode = ctx.query.get('mode');
      const protocol = ctx.query.get('protocol');
      return stack.interfaces.list
        .filter((i) => (!mode || mode === 'vlan') && (protocol !== 'ipv6' || i.ipv6))
        .map((i) => ifaceJson(stack, i));
    },
  },
  { op: 'createNetworkSwitchStackRoutingInterface', method: 'POST', path: IFACES, handler: createIface },
  {
    op: 'getNetworkSwitchStackRoutingInterface',
    path: IFACE,
    sample: MISSING,
    handler: (ctx) => {
      const { stack } = stackOf(ctx);
      return ifaceJson(stack, ifaceOf(stack, ctx.params.interfaceId));
    },
  },
  { op: 'updateNetworkSwitchStackRoutingInterface', method: 'PUT', path: IFACE, handler: updateIface },
  { op: 'deleteNetworkSwitchStackRoutingInterface', method: 'DELETE', path: IFACE, handler: deleteIface },
  {
    op: 'getNetworkSwitchStackRoutingInterfaceDhcp',
    path: `${IFACE}/dhcp`,
    sample: MISSING,
    handler: (ctx) => {
      const { stack } = stackOf(ctx);
      return dhcpJson(ifaceOf(stack, ctx.params.interfaceId).dhcp);
    },
  },
  { op: 'updateNetworkSwitchStackRoutingInterfaceDhcp', method: 'PUT', path: `${IFACE}/dhcp`, handler: updateDhcp },
  {
    op: 'getNetworkSwitchStackRoutingStaticRoutes',
    path: STATIC,
    sample: MISSING,
    handler: (ctx) => stackOf(ctx).stack.routes.list.map(routeJson),
  },
  { op: 'createNetworkSwitchStackRoutingStaticRoute', method: 'POST', path: STATIC, handler: createRoute },
  {
    op: 'getNetworkSwitchStackRoutingStaticRoute',
    path: ROUTE,
    sample: MISSING,
    handler: (ctx) => routeJson(routeOf(stackOf(ctx).stack, ctx.params.staticRouteId)),
  },
  {
    op: 'updateNetworkSwitchStackRoutingStaticRoute',
    method: 'PUT',
    path: ROUTE,
    handler: (ctx) => {
      const { stack } = stackOf(ctx);
      const route = routeOf(stack, ctx.params.staticRouteId);
      return routeJson(applyRoute(stack, route, ctx.body, route));
    },
  },
  {
    op: 'deleteNetworkSwitchStackRoutingStaticRoute',
    method: 'DELETE',
    path: ROUTE,
    handler: (ctx) => {
      const { stack } = stackOf(ctx);
      const list = stack.routes.list;
      list.splice(list.indexOf(routeOf(stack, ctx.params.staticRouteId)), 1);
    },
  },
];
