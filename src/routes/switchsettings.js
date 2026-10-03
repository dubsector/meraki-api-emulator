// Network-wide switch settings: STP, MTU, storm control, the alternate
// management interface, link aggregations and port schedules, plus a routing
// switch's warm spare and cloning one switch onto others. None of them change
// what the sim reports.

import { configOf, stored } from '../config.js';
import { badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { inRange, ipInCidr, parseIp } from '../validate.js';
import { collection, devOf, limit, netOf, orgOf, requireModel, requireProduct } from './common.js';
import { checkEntries, liveEntries, multicastOf, seriesOf, stacksOf } from './routing.js';
import { CUSTOM_POLICY, boundProfile, portConfig } from './switch.js';

const NET = '/networks/{networkId}/switch';
const MAX_ENTRIES = 64;
const MAX_AGGREGATIONS = 64;
const MAX_SCHEDULES = 64;
const MAX_MULTICAST = 128;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
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

const switchIn = (net, serial) => net.switches.find((d) => d.serial === serial);

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
    entries = checkEntries(net, b.stpBridgePriority, ['switches', 'stacks'], 'stpBridgePriority', MAX_ENTRIES);
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
    overrides = checkEntries(net, b.overrides, ['switches'], 'overrides', MAX_ENTRIES);
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
export function isMask(v) {
  const n = parseIp(v);
  if (n == null) return false;
  const inv = 2 ** 32 - 1 - n;
  return ((inv + 1) & inv) === 0 && n !== 0;
}

export const prefixOf = (mask) => 32 - Math.log2(2 ** 32 - parseIp(mask));

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
  apply: (g, b, net, ctx, ports) => {
    g.ports = ports;
  },
  json: (g) => ({ id: g.id, switchPorts: g.ports.map((p) => ({ serial: p.dev.serial, portId: p.portId })) }),
});

// ── Port schedules ──

// Kept in config like access policies, so ports check against the same store
// (switch.js checkPortPolicy). Times are 'H:MM' or 'HH:MM' on the half hour.
const schedulesOf = (net) => stored(net, 'switchPortSchedules', () => ({ created: 0, list: [] }));
const fullDay = () => ({ active: true, from: '00:00', to: '24:00' });

function minutes(v, at) {
  const m = typeof v === 'string' && /^(\d{1,2}):(\d{2})$/.exec(v);
  const n = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!(n >= 0 && n <= 1440) || Number(m[2]) >= 60) throw badRequest(`'${at}' must be a time from '00:00' to '24:00'`);
  if (n % 30) throw badRequest(`'${at}' must be on a 30 minute boundary`);
  return n;
}

// The days a write leaves, each given day merged over what it had.
function scheduleDays(b, self) {
  const days = {};
  for (const d of DAYS) {
    const given = b.portSchedule?.[d];
    const day = { ...(self?.portSchedule[d] ?? fullDay()) };
    if (given) for (const k of ['active', 'from', 'to']) if (given[k] != null) day[k] = given[k];
    if (minutes(day.from, `portSchedule.${d}.from`) >= minutes(day.to, `portSchedule.${d}.to`)) throw badRequest(`'portSchedule.${d}.from' must be earlier than 'portSchedule.${d}.to'`);
    days[d] = day;
  }
  return days;
}

function scheduleUsers(net, id) {
  return net.switches.filter((sw) => !boundProfile(sw)).flatMap((sw) => sw.ports.filter((p) => p.config?.portScheduleId === id).map((p) => `${sw.serial}/${p.portId}`));
}

const portSchedules = collection({
  ops: { list: 'getNetworkSwitchPortSchedules', create: 'createNetworkSwitchPortSchedule', update: 'updateNetworkSwitchPortSchedule', delete: 'deleteNetworkSwitchPortSchedule' },
  path: `${NET}/portSchedules`,
  param: 'portScheduleId',
  parent: switchNet,
  store: schedulesOf,
  what: 'port schedule',
  kind: 'portSchedule',
  max: MAX_SCHEDULES,
  required: ['name'],
  check: (ctx, net, b, self) => scheduleDays(b, self),
  blank: () => ({ name: null, portSchedule: {} }),
  apply: (s, b, net, ctx, days) => {
    s.portSchedule = days;
    if (b.name != null) s.name = b.name;
  },
  json: (s, net) => ({ id: s.id, networkId: net.id, name: s.name, portSchedule: structuredClone(s.portSchedule) }),
  inUse: (s, net) => {
    const ports = scheduleUsers(net, s.id);
    if (ports.length) return `Port schedule '${s.name}' is used by ${ports.length === 1 ? 'port' : 'ports'} ${ports.slice(0, 5).join(', ')}${ports.length > 5 ? ' and others' : ''}`;
  },
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

// ── Clone ──

const familyOf = (dev) => dev.model.split('-')[0];

function orgSwitch(org, serial, what) {
  const dev = typeof serial === 'string' ? org.devices.find((d) => d.serial === serial) : null;
  if (!dev || dev.productType !== 'switch' || !dev.net) throw badRequest(`${what} '${serial}' is not a switch in a network of this organization`);
  if (dev.net.template) throw badRequest(`${what} '${serial}' is in a network bound to a config template`);
  return dev;
}

const stackOf = (dev) => stacksOf(dev.net).find((s) => s.members.includes(dev));

// Moves a target into the entry holding the source (by serial or by its stack),
// or out of every entry when the source has none. Returns the new list.
function cloneEntry(list, srcList, src, dst, values, withStacks) {
  const srcStack = withStacks && stackOf(src);
  const from = srcList.find((e) => e.switches?.includes(src.serial) || (srcStack && e.stacks?.includes(srcStack.id)));
  const out = list
    .map((e) => (e.switches ? { ...e, switches: e.switches.filter((s) => s !== dst.serial) } : { ...e }))
    .filter((e) => e.switches?.length || e.stacks?.length);
  if (!from) return out;
  const same = out.find((e) => e.switches?.length && values.every((k) => e[k] === from[k]));
  if (same) same.switches.push(dst.serial);
  else out.push({ switches: [dst.serial], ...Object.fromEntries(values.map((k) => [k, from[k]])) });
  return out;
}

// The source's ports as the target takes them. Schedules and access policies
// only carry within one network.
function clonedPort(src, srcPort, dst, dstPort) {
  const { portId, linkNegotiationCapabilities, schedule, adaptivePolicyGroup, ...c } = portConfig(src.net, src, srcPort);
  const speeds = portConfig(dst.net, dst, dstPort).linkNegotiationCapabilities;
  if (!speeds.includes(c.linkNegotiation)) c.linkNegotiation = 'Auto negotiate';
  if (src.net !== dst.net) {
    c.portScheduleId = null;
    if (c.accessPolicyType === CUSTOM_POLICY) c.accessPolicyType = 'Open';
    delete c.accessPolicyNumber;
  }
  return structuredClone(c);
}

function cloneSwitch(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const src = orgSwitch(org, b.sourceSerial, 'Source switch');
  if (!b.targetSerials?.length) throw badRequest("'targetSerials' must list at least one switch");
  limit(b.targetSerials, 100, 'Target switches');
  if (new Set(b.targetSerials).size !== b.targetSerials.length) throw badRequest("'targetSerials' lists a switch more than once");
  const targets = b.targetSerials.map((s) => orgSwitch(org, s, 'Target switch'));
  for (const t of targets) {
    if (t === src) throw badRequest("'targetSerials' must not include the source switch");
    if (familyOf(t) !== familyOf(src)) throw badRequest(`Target switch '${t.serial}' is an ${t.model}; targets must be ${familyOf(src)} switches like the source`);
  }
  // Work out every change first, so a refused clone changes nothing.
  const lists = new Map();
  const listOf = (net, key, get) => {
    const k = `${net.id}/${key}`;
    if (!lists.has(k)) lists.set(k, { net, key, list: get(net) });
    return lists.get(k);
  };
  const srcLists = { stp: stpOf(src.net).stpBridgePriority, mtu: mtuOf(src.net).overrides, multicast: multicastOf(src.net).overrides };
  const srcGroups = aggregationsOf(src.net).list.filter((g) => g.ports.every((p) => p.dev === src));
  const ports = [];
  for (const t of targets) {
    for (const port of t.ports) {
      const from = src.ports.find((p) => p.portId === port.portId);
      if (from) ports.push([port, clonedPort(src, from, t, port)]);
    }
    const stacked = !!stackOf(t);
    const settings = [
      ['stp', (n) => stpOf(n).stpBridgePriority, ['stpPriority'], true, MAX_ENTRIES],
      ['mtu', (n) => mtuOf(n).overrides, ['mtuSize'], false, MAX_ENTRIES],
      ['multicast', (n) => multicastOf(n).overrides, ['igmpSnoopingEnabled', 'floodUnknownMulticastTrafficEnabled'], true, MAX_MULTICAST],
    ];
    for (const [key, get, values, withStacks, max] of settings) {
      if (withStacks && stacked) continue;
      const slot = listOf(t.net, key, get);
      slot.list = cloneEntry(slot.list, srcLists[key], src, t, values, withStacks);
      if (slot.list.length > max) throw badRequest(`Cloning would give network '${t.net.name}' more than ${max} ${key} entries`);
    }
    // The target's own groups go; the source's groups on its own ports come over.
    const lag = listOf(t.net, 'lag', (n) => aggregationsOf(n).list.map((g) => ({ g, ports: [...g.ports] })));
    for (const x of lag.list) x.ports = x.ports.filter((p) => p.dev !== t);
    for (const g of srcGroups) {
      const mapped = g.ports.filter((p) => t.ports.some((q) => q.portId === p.portId && q.peer?.device.productType !== 'appliance')).map((p) => ({ dev: t, portId: p.portId }));
      if (mapped.length >= 2) lag.list.push({ g: null, ports: mapped });
    }
    lag.list = lag.list.filter((x) => x.ports.length >= 2);
    if (lag.list.length > MAX_AGGREGATIONS) throw badRequest(`Cloning would give network '${t.net.name}' more than ${MAX_AGGREGATIONS} link aggregations`);
  }
  for (const [port, config] of ports) port.config = config;
  for (const { net, key, list } of lists.values()) {
    if (key === 'stp') stpOf(net).stpBridgePriority = list;
    else if (key === 'mtu') mtuOf(net).overrides = list;
    else if (key === 'multicast') multicastOf(net).overrides = list;
    else {
      const store = aggregationsOf(net);
      store.list = list.map((x) => {
        const g = x.g ?? { id: nextAggregationId(ctx, store, net) };
        g.ports = x.ports;
        return g;
      });
    }
  }
  return { sourceSerial: src.serial, targetSerials: targets.map((t) => t.serial) };
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
  ...portSchedules.routes,
  { op: 'getDeviceSwitchWarmSpare', path: '/devices/{serial}/switch/warmSpare', sample: SPARE_SAMPLE, handler: (ctx) => warmSpareJson(switchOf(ctx)) },
  { op: 'updateDeviceSwitchWarmSpare', method: 'PUT', path: '/devices/{serial}/switch/warmSpare', sample: SPARE_SAMPLE, handler: updateWarmSpare },
  { op: 'cloneOrganizationSwitchDevices', method: 'POST', path: '/organizations/{organizationId}/switch/devices/clone', status: 200, handler: cloneSwitch },
];
