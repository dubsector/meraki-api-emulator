// Network-wide switch settings: STP, MTU, storm control, the alternate
// management interface and link aggregations, plus a routing switch's warm
// spare. None of them change what the sim reports.

import { configOf, stored } from '../config.js';
import { badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { inRange, ipInCidr, parseIp } from '../validate.js';
import { collection, devOf, limit, netOf, requireModel, requireProduct } from './common.js';
import { seriesOf } from './routing.js';
import { boundProfile } from './switch.js';

const NET = '/networks/{networkId}/switch';
const MAX_ENTRIES = 64;
const MAX_AGGREGATIONS = 64;
const MTU_MIN = 1280;
const MTU_MAX = 9578;
const PROTOCOLS = ['radius', 'snmp', 'syslog'];
const TRAFFIC_TYPES = ['broadcast', 'multicast', 'unknownUnicast'];
const THRESHOLDS = { broadcast: 'broadcastThreshold', multicast: 'multicastThreshold', unknownUnicast: 'unknownUnicastThreshold' };

function switchNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return net;
}

const stacksOf = (net) => (net.switchStacks?.list ?? []).map((s) => ({ id: s.id, name: s.name, members: s.members.filter((d) => net.switches.includes(d)) }));
const profilesOf = (net) => net.template?.profiles ?? [];
const switchIn = (net, serial) => net.switches.find((d) => d.serial === serial);

// Switches, stacks and profiles that left the network drop out of an entry,
// and an entry left with none of them drops out of the list.
function liveEntries(net, entries, rest) {
  const stackIds = stacksOf(net).map((s) => s.id);
  const keep = { switches: (s) => !!switchIn(net, s), stacks: (id) => stackIds.includes(id), switchProfiles: (id) => profilesOf(net).some((p) => p.switchProfileId === id) };
  const out = [];
  for (const e of entries) {
    const lists = {};
    for (const k of Object.keys(keep)) if (e[k]) lists[k] = e[k].filter(keep[k]);
    if (Object.values(lists).some((l) => l.length)) out.push({ ...lists, ...rest(e) });
  }
  return out;
}

// Each switch, stack or profile sits in one entry. A stacked switch is listed by
// its stack where the setting takes stacks; profiles only apply to template networks.
function checkEntries(net, entries, keys, what) {
  const seen = new Set();
  const stacks = stacksOf(net);
  limit(entries, MAX_ENTRIES, what);
  return entries.map((e, i) => {
    const at = `${what}[${i}]`;
    if (!keys.some((k) => e[k]?.length)) throw badRequest(`'${at}' needs at least one of ${keys.map((k) => `'${k}'`).join(', ')}`);
    if (e.switchProfiles?.length) throw badRequest("'switchProfiles' only applies to config template networks");
    const out = {};
    for (const k of keys) {
      if (!e[k]?.length) continue;
      for (const id of e[k]) {
        if (typeof id !== 'string') throw badRequest(`'${at}.${k}' must be a list of strings`);
        if (seen.has(id)) throw badRequest(`'${id}' is in more than one entry of '${what}'`);
        seen.add(id);
        if (k === 'switches') {
          const dev = switchIn(net, id);
          if (!dev) throw badRequest(`Switch '${id}' is not in this network`);
          const stack = keys.includes('stacks') && stacks.find((s) => s.members.includes(dev));
          if (stack) throw badRequest(`Switch '${id}' is in stack '${stack.name}', so list the stack instead`);
        } else if (k === 'stacks' && !stacks.some((s) => s.id === id)) throw badRequest(`Switch stack '${id}' does not exist in this network`);
      }
      out[k] = [...e[k]];
    }
    return out;
  });
}

// ── STP ──

const stpOf = (net) => stored(net, 'switchStp', () => ({ rstpEnabled: true, stpBridgePriority: [] }));

function stpJson(net) {
  const s = stpOf(net);
  return { rstpEnabled: s.rstpEnabled, stpBridgePriority: liveEntries(net, s.stpBridgePriority, (e) => ({ stpPriority: e.stpPriority })) };
}

function updateStp(ctx) {
  const net = switchNet(ctx);
  const b = ctx.body;
  let entries = null;
  if (b.stpBridgePriority) {
    entries = checkEntries(net, b.stpBridgePriority, ['switches', 'stacks', 'switchProfiles'], 'stpBridgePriority');
    b.stpBridgePriority.forEach((e, i) => {
      const p = e.stpPriority;
      if (!Number.isInteger(p) || p < 0 || p > 61440 || p % 4096) throw badRequest(`'stpBridgePriority[${i}].stpPriority' must be a multiple of 4096 from 0 to 61440`);
      entries[i].stpPriority = p;
    });
  }
  const s = stpOf(net);
  if (b.rstpEnabled != null) s.rstpEnabled = b.rstpEnabled;
  if (entries) s.stpBridgePriority = entries;
  return stpJson(net);
}

// ── MTU ──

const mtuOf = (net) => stored(net, 'switchMtu', () => ({ defaultMtuSize: MTU_MAX, overrides: [] }));

function mtuJson(net) {
  const m = mtuOf(net);
  return { defaultMtuSize: m.defaultMtuSize, overrides: liveEntries(net, m.overrides, (e) => ({ mtuSize: e.mtuSize })) };
}

function updateMtu(ctx) {
  const net = switchNet(ctx);
  const b = ctx.body;
  inRange(b.defaultMtuSize, MTU_MIN, MTU_MAX, 'defaultMtuSize');
  let overrides = null;
  if (b.overrides) {
    overrides = checkEntries(net, b.overrides, ['switches', 'switchProfiles'], 'overrides');
    b.overrides.forEach((o, i) => {
      if (o.mtuSize == null) throw badRequest(`'overrides[${i}].mtuSize' is required`);
      inRange(o.mtuSize, MTU_MIN, MTU_MAX, `overrides[${i}].mtuSize`);
      overrides[i].mtuSize = o.mtuSize;
    });
  }
  const m = mtuOf(net);
  if (b.defaultMtuSize != null) m.defaultMtuSize = b.defaultMtuSize;
  if (overrides) m.overrides = overrides;
  return mtuJson(net);
}

// ── Storm control ──

// 100 percent means no limit, which is where every threshold starts.
const stormOf = (net) => stored(net, 'switchStormControl', () => ({ broadcastThreshold: 100, multicastThreshold: 100, unknownUnicastThreshold: 100, treatTheseTrafficTypesAsOneThreshold: [] }));

function updateStorm(ctx) {
  const net = switchNet(ctx);
  const b = ctx.body;
  const s = stormOf(net);
  const next = { ...s, treatTheseTrafficTypesAsOneThreshold: [...s.treatTheseTrafficTypesAsOneThreshold] };
  for (const k of Object.values(THRESHOLDS)) {
    if (b[k] == null) continue;
    inRange(b[k], 1, 100, k);
    next[k] = b[k];
  }
  const grouped = b.treatTheseTrafficTypesAsOneThreshold;
  if (grouped) {
    const bad = grouped.find((t) => !TRAFFIC_TYPES.includes(t));
    if (bad !== undefined) throw badRequest(`'treatTheseTrafficTypesAsOneThreshold' must only hold ${TRAFFIC_TYPES.join(', ')}`);
    if (new Set(grouped).size !== grouped.length) throw badRequest("'treatTheseTrafficTypesAsOneThreshold' lists a traffic type more than once");
    if (grouped.length === 1) throw badRequest("'treatTheseTrafficTypesAsOneThreshold' needs at least two traffic types");
    next.treatTheseTrafficTypesAsOneThreshold = [...grouped];
  }
  // Grouped traffic types share one threshold.
  const values = new Set(next.treatTheseTrafficTypesAsOneThreshold.map((t) => next[THRESHOLDS[t]]));
  if (values.size > 1) throw badRequest(`Traffic types treated as one (${next.treatTheseTrafficTypesAsOneThreshold.join(', ')}) must have the same threshold`);
  Object.assign(s, next);
  return structuredClone(s);
}

// ── Alternate management interface ──

// Kept on the network, not its config, since it gives the network's own switches addresses.
const amiOf = (net) => (net.switchAlternateManagement ??= { enabled: false, vlanId: null, protocols: [], switches: [] });

function amiJson(net) {
  const a = amiOf(net);
  const switches = a.switches.filter((s) => net.switches.includes(s.dev)).map((s) => ({ serial: s.dev.serial, alternateManagementIp: s.ip, subnetMask: s.subnetMask, gateway: s.gateway }));
  return { enabled: a.enabled, useOobMgmt: false, vlanId: a.vlanId, protocols: [...a.protocols], switches };
}

// A dotted mask with its ones first, like 255.255.255.0.
function isMask(v) {
  const n = parseIp(v);
  if (n == null) return false;
  const inv = 2 ** 32 - 1 - n;
  return ((inv + 1) & inv) === 0 && n !== 0;
}

const prefixOf = (mask) => 32 - Math.log2(2 ** 32 - parseIp(mask));

// When the MX holds the VLAN, addresses have to sit in its subnet.
function checkSwitches(net, list, vlanId) {
  const vlan = configOf(net).vlansEnabled ? configOf(net).vlans.find((v) => v.id === String(vlanId)) : null;
  const seen = new Set();
  const ips = new Set();
  return list.flatMap((s, i) => {
    const at = `switches[${i}]`;
    if (typeof s.serial !== 'string' || typeof s.alternateManagementIp !== 'string') throw badRequest(`'${at}' needs 'serial' and 'alternateManagementIp'`);
    const dev = switchIn(net, s.serial);
    if (!dev) throw badRequest(`Switch '${s.serial}' is not in this network`);
    if (seen.has(dev)) throw badRequest(`Switch '${s.serial}' is listed more than once`);
    seen.add(dev);
    // An empty address removes the switch's assignment.
    if (s.alternateManagementIp === '') return [];
    if (parseIp(s.alternateManagementIp) == null) throw badRequest(`'${at}.alternateManagementIp' must be an IPv4 address`);
    if (ips.has(s.alternateManagementIp)) throw badRequest(`${s.alternateManagementIp} is given to more than one switch`);
    ips.add(s.alternateManagementIp);
    const user = net.devices.find((d) => d.lanIp === s.alternateManagementIp);
    if (user) throw badRequest(`${s.alternateManagementIp} is the LAN address of ${user.name}`);
    if (s.subnetMask && !isMask(s.subnetMask)) throw badRequest(`'${at}.subnetMask' must be a subnet mask like 255.255.255.0`);
    if (s.gateway && parseIp(s.gateway) == null) throw badRequest(`'${at}.gateway' must be an IPv4 address`);
    if (seriesOf(dev) === 'MS390' && (!s.subnetMask || !s.gateway)) throw badRequest(`${dev.model} switches need 'subnetMask' and 'gateway' with a static alternate management IP`);
    if (s.subnetMask && s.gateway) {
      const cidr = `${s.alternateManagementIp}/${prefixOf(s.subnetMask)}`;
      if (!ipInCidr(s.gateway, cidr)) throw badRequest(`'${at}.gateway' must be in the same subnet as ${s.alternateManagementIp}`);
      if (s.gateway === s.alternateManagementIp) throw badRequest(`'${at}.gateway' must not be the switch's own address`);
    }
    if (vlan) {
      if (!ipInCidr(s.alternateManagementIp, vlan.subnet)) throw badRequest(`'${at}.alternateManagementIp' must be in VLAN ${vlan.id}'s subnet ${vlan.subnet}`);
      if (s.alternateManagementIp === vlan.applianceIp) throw badRequest(`'${at}.alternateManagementIp' is the MX's address on VLAN ${vlan.id}`);
    }
    return [{ dev, ip: s.alternateManagementIp, subnetMask: s.subnetMask || null, gateway: s.gateway || null }];
  });
}

function updateAmi(ctx) {
  const net = switchNet(ctx);
  const b = ctx.body;
  const a = amiOf(net);
  inRange(b.vlanId, 1, 4094, 'vlanId');
  const vlanId = b.vlanId ?? a.vlanId;
  let protocols = a.protocols;
  if (b.protocols) {
    if (new Set(b.protocols).size !== b.protocols.length) throw badRequest("'protocols' lists a protocol more than once");
    protocols = PROTOCOLS.filter((p) => b.protocols.includes(p));
  }
  const enabled = b.enabled ?? a.enabled;
  if (enabled && (vlanId == null || !protocols.length)) throw badRequest("'vlanId' and 'protocols' must be set to enable the alternate management interface");
  // Kept addresses are checked again, since the VLAN may have changed.
  const given = b.switches ?? amiJson(net).switches;
  const switches = checkSwitches(net, given, vlanId);
  Object.assign(a, { enabled, vlanId, protocols: [...protocols], switches });
  return amiJson(net);
}

// ── Link aggregations ──

// Kept on the network, not its config, since they name its own switch ports.
// Ports hold device objects, so a switch that leaves takes its ports along and
// a group left with fewer than two ports splits.
function aggregationsOf(net) {
  const store = (net.switchLinkAggregations ??= { created: 0, list: [] });
  for (const g of store.list) g.ports = g.ports.filter((p) => net.switches.includes(p.dev));
  store.list = store.list.filter((g) => g.ports.length >= 2);
  return store;
}

// 2 to 8 ports of one switch or stack, none of them an uplink to the MX or in another group.
function portsOf(net, b, self) {
  const lists = ['switchPorts', 'switchProfilePorts'].filter((k) => b[k] != null);
  if (lists.length !== 1) throw badRequest("Give exactly one of 'switchPorts' or 'switchProfilePorts'");
  if (b.switchProfilePorts) throw badRequest("'switchProfilePorts' only applies to config template networks");
  const given = b.switchPorts;
  if (given.length < 2 || given.length > 8) throw badRequest('A link aggregation needs 2 to 8 ports');
  const taken = aggregationsOf(net).list.filter((g) => g !== self).flatMap((g) => g.ports);
  const stacks = stacksOf(net);
  const ports = given.map((p, i) => {
    if (typeof p.serial !== 'string' || typeof p.portId !== 'string') throw badRequest(`'switchPorts[${i}]' needs 'serial' and 'portId'`);
    const dev = switchIn(net, p.serial);
    if (!dev) throw badRequest(`Switch '${p.serial}' is not in this network`);
    if (boundProfile(dev)) throw badRequest(`Switch '${p.serial}' is bound to a switch profile; aggregate the ports on the profile instead`);
    const port = dev.ports.find((x) => x.portId === p.portId);
    if (!port) throw badRequest(`Port '${p.portId}' does not exist on switch '${p.serial}'`);
    if (port.peer?.device.productType === 'appliance') throw badRequest(`Port '${p.portId}' on switch '${p.serial}' is the uplink to the MX and can't be aggregated`);
    if (taken.some((t) => t.dev === dev && t.portId === p.portId)) throw badRequest(`Port '${p.portId}' on switch '${p.serial}' is already in a link aggregation`);
    return { dev, portId: p.portId };
  });
  if (new Set(ports.map((p) => `${p.dev.serial}/${p.portId}`)).size !== ports.length) throw badRequest('Each port can only be listed once');
  const devs = [...new Set(ports.map((p) => p.dev))];
  if (devs.length > 1) {
    const stack = stacks.find((s) => s.members.includes(devs[0]));
    if (!stack || !devs.every((d) => stack.members.includes(d))) throw badRequest('The ports of a link aggregation must all be on one switch or one switch stack');
  }
  return ports;
}

// IDs look like the API's: base64 of digits and underscores, so never '+' or '/'.
function nextAggregationId(ctx, store, net) {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:linkAggregation:${net.id}:${store.created}`));
  let id;
  do id = Buffer.from(`${r.digits(4)}_${store.created}_${r.digits(2)}`).toString('base64');
  while (store.list.some((g) => g.id === id));
  return id;
}

const linkAggregations = collection({
  ops: { list: 'getNetworkSwitchLinkAggregations', create: 'createNetworkSwitchLinkAggregation', update: 'updateNetworkSwitchLinkAggregation', delete: 'deleteNetworkSwitchLinkAggregation' },
  path: `${NET}/linkAggregations`,
  param: 'linkAggregationId',
  parent: switchNet,
  store: aggregationsOf,
  what: 'link aggregation',
  nextId: nextAggregationId,
  max: MAX_AGGREGATIONS,
  unique: false,
  check: (ctx, net, b, self) => portsOf(net, b, self),
  blank: () => ({ ports: [] }),
  apply: (g, b, net) => {
    g.ports = portsOf(net, b, g);
  },
  json: (g) => ({ id: g.id, switchPorts: g.ports.map((p) => ({ serial: p.dev.serial, portId: p.portId })) }),
});

// ── Warm spare ──

// Kept on the primary as a device reference. The pair only counts while both
// switches are lone routing switches of one model in the same network. Stacks
// and layer 3 writes check it too.
export function warmSparePair(dev) {
  const net = dev.net;
  const ok = (d) => net.switches.includes(d) && seriesOf(d) && !stacksOf(net).some((s) => s.members.includes(d));
  const live = (p) => p.switchWarmSpare?.enabled && ok(p) && ok(p.switchWarmSpare.spare) && p.switchWarmSpare.spare !== p && p.switchWarmSpare.spare.model === p.model;
  if (live(dev)) return { primary: dev, spare: dev.switchWarmSpare.spare };
  const primary = net.switches.find((p) => p !== dev && p.switchWarmSpare?.spare === dev && live(p));
  return primary ? { primary, spare: dev } : null;
}


function warmSpareJson(dev) {
  const pair = warmSparePair(dev);
  if (!pair) return { enabled: false, primarySerial: dev.serial };
  return { enabled: true, primarySerial: pair.primary.serial, spareSerial: pair.spare.serial };
}

function switchOf(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'switch');
  return dev;
}

function updateWarmSpare(ctx) {
  const dev = switchOf(ctx);
  const b = ctx.body;
  const pair = warmSparePair(dev);
  if (pair && pair.spare === dev) throw badRequest(`Switch '${dev.serial}' is the warm spare for '${pair.primary.serial}'; change it on the primary`);
  if (!b.enabled) {
    delete dev.switchWarmSpare;
    return warmSpareJson(dev);
  }
  if (!seriesOf(dev)) throw badRequest(`${dev.model} switches do not support warm spare`);
  const stacked = (d) => stacksOf(dev.net).find((s) => s.members.includes(d));
  if (stacked(dev)) throw badRequest(`Switch '${dev.serial}' is in stack '${stacked(dev).name}'; stacked switches can't have a warm spare`);
  const serial = b.spareSerial ?? pair?.spare.serial;
  if (serial == null) throw badRequest("'spareSerial' is required to enable warm spare");
  const spare = switchIn(dev.net, serial);
  if (!spare) throw badRequest(`'spareSerial' ${serial} is not a switch in this network`);
  if (spare === dev) throw badRequest("'spareSerial' must not be the primary switch");
  if (spare.model !== dev.model) throw badRequest(`The warm spare must be the same model as the primary (${dev.model})`);
  if (stacked(spare)) throw badRequest(`Switch '${serial}' is in stack '${stacked(spare).name}'`);
  const other = warmSparePair(spare);
  if (other && other.primary !== dev) throw badRequest(`Switch '${serial}' is already in a warm spare pair with '${other.primary === spare ? other.spare.serial : other.primary.serial}'`);
  // The spare takes the primary's layer 3 settings, so its own are gone.
  delete spare.switchRouting;
  delete spare.switchWarmSpare;
  dev.switchWarmSpare = { enabled: true, spare };
  return warmSpareJson(dev);
}

// HQ's first MS250, which has a twin to pair with.
const SPARE_SAMPLE = { serial: (world) => world.orgs[0].networks[0].switches.find((d) => d.model === 'MS250-48FP').serial };

export default [
  { op: 'getNetworkSwitchStp', path: `${NET}/stp`, handler: (ctx) => stpJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchStp', method: 'PUT', path: `${NET}/stp`, handler: updateStp },
  { op: 'getNetworkSwitchMtu', path: `${NET}/mtu`, handler: (ctx) => mtuJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchMtu', method: 'PUT', path: `${NET}/mtu`, handler: updateMtu },
  { op: 'getNetworkSwitchStormControl', path: `${NET}/stormControl`, handler: (ctx) => structuredClone(stormOf(switchNet(ctx))) },
  { op: 'updateNetworkSwitchStormControl', method: 'PUT', path: `${NET}/stormControl`, handler: updateStorm },
  { op: 'getNetworkSwitchAlternateManagementInterface', path: `${NET}/alternateManagementInterface`, handler: (ctx) => amiJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchAlternateManagementInterface', method: 'PUT', path: `${NET}/alternateManagementInterface`, handler: updateAmi },
  ...linkAggregations.routes,
  { op: 'getDeviceSwitchWarmSpare', path: '/devices/{serial}/switch/warmSpare', sample: SPARE_SAMPLE, handler: (ctx) => warmSpareJson(switchOf(ctx)) },
  { op: 'updateDeviceSwitchWarmSpare', method: 'PUT', path: '/devices/{serial}/switch/warmSpare', sample: SPARE_SAMPLE, handler: updateWarmSpare },
];
