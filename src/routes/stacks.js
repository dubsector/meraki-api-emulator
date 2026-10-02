// MS switch stacks: membership, plus each stack's layer 3 interfaces (with
// DHCP) and static routes, which share their code with a lone switch's in
// routing.js. Networks start with no stacks; writes create them.

import { DEVICE_OUI } from '../catalog.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { netOf, requireProduct } from './common.js';
import { applyRoute, createIface, createRoute, deleteIface, deleteRoute, dhcpJson, ifaceJson, ifaceOf, listIfaces, newL3, routeJson, routeOf, seriesOf, stackRouter, updateDhcp, updateIface } from './routing.js';

const LIST = '/networks/{networkId}/switch/stacks';
const STACK = `${LIST}/{switchStackId}`;
const IFACES = `${STACK}/routing/interfaces`;
const IFACE = `${IFACES}/{interfaceId}`;
const STATIC = `${STACK}/routing/staticRoutes`;
const ROUTE = `${STATIC}/{staticRouteId}`;
const MAX_MEMBERS = 8;

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

const routerOf = (ctx) => {
  const { net, stack } = stackOf(ctx);
  return stackRouter(net, stack);
};

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
    if (dev.switchRouting?.interfaces.list.length) throw badRequest(`Delete the layer 3 interfaces on switch '${serial}' before adding it to a stack`);
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
    ...newL3(),
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
  { op: 'getNetworkSwitchStackRoutingInterfaces', path: IFACES, sample: MISSING, handler: (ctx) => listIfaces(ctx, routerOf(ctx)) },
  { op: 'createNetworkSwitchStackRoutingInterface', method: 'POST', path: IFACES, handler: (ctx) => createIface(ctx, routerOf(ctx)) },
  {
    op: 'getNetworkSwitchStackRoutingInterface',
    path: IFACE,
    sample: MISSING,
    handler: (ctx) => {
      const R = routerOf(ctx);
      return ifaceJson(R, ifaceOf(R, ctx.params.interfaceId));
    },
  },
  {
    op: 'updateNetworkSwitchStackRoutingInterface',
    method: 'PUT',
    path: IFACE,
    handler: (ctx) => {
      // The spec's stack update response has no defaultGateway, unlike create and get.
      const { defaultGateway, ...out } = updateIface(ctx, routerOf(ctx));
      return out;
    },
  },
  { op: 'deleteNetworkSwitchStackRoutingInterface', method: 'DELETE', path: IFACE, handler: (ctx) => deleteIface(ctx, routerOf(ctx)) },
  { op: 'getNetworkSwitchStackRoutingInterfaceDhcp', path: `${IFACE}/dhcp`, sample: MISSING, handler: (ctx) => dhcpJson(ifaceOf(routerOf(ctx), ctx.params.interfaceId).dhcp) },
  { op: 'updateNetworkSwitchStackRoutingInterfaceDhcp', method: 'PUT', path: `${IFACE}/dhcp`, handler: (ctx) => updateDhcp(ctx, routerOf(ctx)) },
  { op: 'getNetworkSwitchStackRoutingStaticRoutes', path: STATIC, sample: MISSING, handler: (ctx) => routerOf(ctx).l3.routes.list.map(routeJson) },
  { op: 'createNetworkSwitchStackRoutingStaticRoute', method: 'POST', path: STATIC, handler: (ctx) => createRoute(ctx, routerOf(ctx)) },
  { op: 'getNetworkSwitchStackRoutingStaticRoute', path: ROUTE, sample: MISSING, handler: (ctx) => routeJson(routeOf(routerOf(ctx), ctx.params.staticRouteId)) },
  {
    op: 'updateNetworkSwitchStackRoutingStaticRoute',
    method: 'PUT',
    path: ROUTE,
    handler: (ctx) => {
      const R = routerOf(ctx);
      const route = routeOf(R, ctx.params.staticRouteId);
      return routeJson(applyRoute(R, route, ctx.body, route));
    },
  },
  { op: 'deleteNetworkSwitchStackRoutingStaticRoute', method: 'DELETE', path: ROUTE, handler: (ctx) => deleteRoute(ctx, routerOf(ctx)) },
];
