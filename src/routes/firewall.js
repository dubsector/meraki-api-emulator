// MX firewall settings, cellular firewall rules, 1:many NAT, static multicast
// forwarding, uplink NAT, connectivity monitoring destinations and warm spare.
// Each is a network setting built from its default on first read. None of the
// MXes has a cellular uplink, so the cellular rules are stored and never used.

import { DEFAULT_RULE, configOf, stored } from '../config.js';
import { arrayParam, badRequest, paginate, paginateItems } from '../http.js';
import { ipInCidr, isAddress, isHostname, isPort, parseIp } from '../validate.js';
import { limit, mxNet, mxNets, orgOf } from './common.js';
import { checkRefs, isRef } from './policyobjects.js';

const BASE = '/networks/{networkId}/appliance';
const MAX_RULES = 1000;
const MAX_DESTINATIONS = 100;
const WAN_UPLINKS = ['wan1', 'wan2'];
const NAT_UPLINKS = ['internet1', 'internet2'];
const UPLINK_MODES = ['virtual', 'public'];
// The target linkSample() measures uplink loss and latency against.
const DEFAULT_DESTINATION = { ip: '8.8.8.8', description: 'Google', default: true };

// ── Settings, built on first read ──

const settingsOf = (net) => stored(net, 'applianceFirewallSettings', () => ({ spoofingProtection: { ipSourceGuard: { mode: 'block' } } }));
const cellularOf = (net) => stored(net, 'applianceCellularRules', () => ({ rules: [] }));
const inboundCellularOf = (net) => stored(net, 'applianceInboundCellularRules', () => ({ rules: [] }));
const oneToManyOf = (net) => stored(net, 'applianceOneToManyNat', () => ({ rules: [] }));
const multicastOf = (net) => stored(net, 'applianceMulticastForwarding', () => ({ rules: [] }));
const uplinksNatOf = (net) => stored(net, 'applianceUplinksNat', () => ({ uplinks: WAN_UPLINKS.map((i) => ({ interface: i, nat: { enabled: true } })) }));
const destinationsOf = (net) => stored(net, 'applianceConnectivityDestinations', () => ({ destinations: [{ ...DEFAULT_DESTINATION }] }));

// ── Cellular firewall rules ──

export const isPorts = (v) => isPort(v, true);
const items = (v) => String(v).split(',').map((x) => x.trim());

export function checkList(v, at, ok, what) {
  if (v == null || /^any$/i.test(v)) return;
  if (!items(v).every(ok)) throw badRequest(`'${at}' must be 'any' or a comma-separated list of ${what}`);
}

// Address lists also take the organization's policy objects as OBJ(id) and GRP(id).
export function checkAddresses(org, v, at, ok, what) {
  checkList(v, at, (x) => isRef(x) || ok(x), what);
  checkRefs(org, v, at);
}

// Like the L3 rules: the default rule is always last and dropped when sent back.
function cellularRules(org, rules) {
  limit(rules, MAX_RULES, 'Rules');
  const kept = rules.filter((r) => r.comment !== DEFAULT_RULE.comment);
  kept.forEach((r, i) => {
    checkList(r.srcPort, `rules[${i}].srcPort`, isPorts, 'ports');
    checkList(r.destPort, `rules[${i}].destPort`, isPorts, 'ports');
    checkAddresses(org, r.srcCidr, `rules[${i}].srcCidr`, isAddress, 'IP addresses or CIDRs');
    checkAddresses(org, r.destCidr, `rules[${i}].destCidr`, (x) => isAddress(x) || isHostname(x), 'IP addresses, CIDRs or domain names');
  });
  return kept.map((r) => ({ comment: r.comment ?? '', policy: r.policy, protocol: r.protocol, srcPort: r.srcPort ?? 'Any', srcCidr: r.srcCidr, destPort: r.destPort ?? 'Any', destCidr: r.destCidr, syslogEnabled: r.syslogEnabled ?? false }));
}

const rulesJson = (set) => ({ rules: [...structuredClone(set.rules), { ...DEFAULT_RULE }] });

const cellularRoutes = (name, path, setOf) => [
  { op: `getNetworkApplianceFirewall${name}`, path: `${BASE}/firewall/${path}`, handler: (ctx) => rulesJson(setOf(mxNet(ctx))) },
  {
    op: `updateNetworkApplianceFirewall${name}`,
    method: 'PUT',
    path: `${BASE}/firewall/${path}`,
    handler: (ctx) => {
      const net = mxNet(ctx);
      const set = setOf(net);
      if (ctx.body.rules) set.rules = cellularRules(net.org, ctx.body.rules);
      return rulesJson(set);
    },
  },
];

// ── 1:many NAT ──

function oneToManyRule(r, i) {
  const at = `rules[${i}]`;
  if (parseIp(r.publicIp) == null) throw badRequest(`'${at}.publicIp' must be an IPv4 address`);
  if (!NAT_UPLINKS.includes(r.uplink)) throw badRequest(`'${at}.uplink' must be one of ${NAT_UPLINKS.join(', ')}`);
  const portRules = r.portRules.map((p, j) => {
    const pat = `${at}.portRules[${j}]`;
    for (const k of ['publicPort', 'localPort']) if (p[k] != null && !isPorts(p[k])) throw badRequest(`'${pat}.${k}' must be a port or port range between 1 and 65535`);
    if (p.localIp != null && parseIp(p.localIp) == null) throw badRequest(`'${pat}.localIp' must be an IPv4 address`);
    const allowedIps = p.allowedIps ?? ['any'];
    if (!allowedIps.every((x) => /^any$/i.test(x) || isAddress(x))) throw badRequest(`'${pat}.allowedIps' must hold 'any' or IP addresses and CIDRs`);
    return { name: p.name ?? '', protocol: p.protocol ?? 'tcp', publicPort: p.publicPort ?? null, localIp: p.localIp ?? null, localPort: p.localPort ?? null, allowedIps };
  });
  return { publicIp: r.publicIp, uplink: r.uplink, portRules };
}

function updateOneToMany(ctx) {
  const set = oneToManyOf(mxNet(ctx));
  const rules = limit(ctx.body.rules, MAX_RULES, 'Rules').map(oneToManyRule);
  const ips = rules.map((r) => r.publicIp);
  const dup = ips.find((ip, i) => ips.indexOf(ip) !== i);
  if (dup) throw badRequest(`Public IP ${dup} is used by more than one rule`);
  set.rules = rules;
  return structuredClone(set);
}

// ── Static multicast forwarding ──

// A rule's VLANs have to be the network's own, or VLAN 1 on a single LAN.
function multicastRule(c, r, i) {
  const at = `rules[${i}]`;
  if (!ipInCidr(r.address, '224.0.0.0/4')) throw badRequest(`'${at}.address' must be an IPv4 multicast address (224.0.0.0/4)`);
  if (!r.vlanIds.length) throw badRequest(`'${at}.vlanIds' must name at least one VLAN`);
  const vlans = c.vlansEnabled ? c.vlans.map((v) => v.id) : ['1'];
  const missing = r.vlanIds.find((v) => !vlans.includes(String(v)));
  if (missing != null) throw badRequest(`'${at}.vlanIds' names VLAN ${missing}, which is not configured on this network`);
  return { description: r.description, address: r.address, vlanIds: [...new Set(r.vlanIds.map(String))] };
}

const multicastJson = (net) => ({ network: { id: net.id, name: net.name }, rules: structuredClone(multicastOf(net).rules) });

function updateMulticast(ctx) {
  const net = mxNet(ctx);
  const c = configOf(net);
  const rules = limit(ctx.body.rules, MAX_RULES, 'Rules').map((r, i) => multicastRule(c, r, i));
  multicastOf(net).rules = rules;
  return multicastJson(net);
}

function multicastByNetwork(ctx) {
  const nets = mxNets(orgOf(ctx), arrayParam(ctx.query, 'networkIds'));
  return paginateItems(ctx, nets, (n) => n.id, { def: 1000, max: 1000 }, multicastJson);
}

// ── Uplink NAT ──

function updateUplinksNat(ctx) {
  const set = uplinksNatOf(mxNet(ctx));
  const given = ctx.body.uplinks;
  given.forEach((u, i) => {
    if (!WAN_UPLINKS.includes(u.interface)) throw badRequest(`'uplinks[${i}].interface' must be one of ${WAN_UPLINKS.join(', ')}`);
  });
  for (const u of given) set.uplinks.find((x) => x.interface === u.interface).nat.enabled = u.nat.enabled;
  return structuredClone(set);
}

function uplinksNatByNetwork(ctx) {
  const nets = mxNets(orgOf(ctx), arrayParam(ctx.query, 'networkIds'));
  const interfaces = arrayParam(ctx.query, 'interfaces');
  return paginate(ctx, nets, (n) => n.id, { def: 1000, max: 100000 }).map((n) => ({
    networkId: n.id,
    uplinks: structuredClone(uplinksNatOf(n).uplinks.filter((u) => !interfaces.length || interfaces.includes(u.interface))),
  }));
}

// ── Connectivity monitoring destinations ──

function updateDestinations(ctx) {
  const set = destinationsOf(mxNet(ctx));
  if (!ctx.body.destinations) return structuredClone(set);
  const list = limit(ctx.body.destinations, MAX_DESTINATIONS, 'Destinations');
  list.forEach((d, i) => {
    if (parseIp(d.ip) == null) throw badRequest(`'destinations[${i}].ip' must be an IPv4 address`);
  });
  if (list.filter((d) => d.default).length > 1) throw badRequest('Only one destination can be the default');
  const ips = list.map((d) => d.ip);
  const dup = ips.find((ip, i) => ips.indexOf(ip) !== i);
  if (dup) throw badRequest(`Destination ${dup} is listed more than once`);
  set.destinations = list.map((d) => ({ ip: d.ip, description: d.description ?? '', default: d.default ?? false }));
  return structuredClone(set);
}

// ── Warm spare ──

// Roles are kept as device references on the network, so a device that
// leaves drops out and an RMA swap keeps its role. The primary is the MX the
// sim reports on unless a swap moved it; swapping changes the roles only.
const warmSpareOf = (net) => (net.warmSpare ??= { enabled: false, primary: null, spare: null, uplinkMode: null, virtualIp1: null, virtualIp2: null });
const inNet = (net, dev) => !!dev && dev.productType === 'appliance' && net.devices.includes(dev);

function roles(net) {
  const ws = warmSpareOf(net);
  const primary = inNet(net, ws.primary) ? ws.primary : net.mx;
  const spare = inNet(net, ws.spare) && ws.spare !== primary ? ws.spare : null;
  return { ws, primary, spare };
}

// The /24 a WAN address sits in, as the uplink settings give fiber links. The
// shared WAN links are the ones the network's MX reports, whichever role it has.
const wanSubnet = (u) => `${u.publicIp.split('.').slice(0, 3).join('.')}.0/24`;

function warmSpareJson(net) {
  const { ws, primary, spare } = roles(net);
  if (!ws.enabled || !spare) return { enabled: false, primarySerial: primary?.serial ?? null };
  const out = { enabled: true, primarySerial: primary.serial, spareSerial: spare.serial, uplinkMode: ws.uplinkMode };
  if (ws.uplinkMode === 'virtual') {
    net.mx.uplinks.forEach((u, i) => {
      if (i < 2) out[`wan${i + 1}`] = { ip: ws[`virtualIp${i + 1}`], subnet: wanSubnet(u) };
    });
  }
  return out;
}

// A virtual IP is shared by both MXes on a WAN subnet.
function checkVirtualIps(mx, b) {
  mx.uplinks.slice(0, 2).forEach((u, i) => {
    const k = `virtualIp${i + 1}`;
    const ip = b[k];
    if (ip == null) throw badRequest(`'${k}' is required when uplinkMode is virtual`);
    if (!ipInCidr(ip, wanSubnet(u))) throw badRequest(`'${k}' must be an address in ${u.interface}'s subnet ${wanSubnet(u)}`);
    if (ip === u.publicIp || ip === u.gateway) throw badRequest(`'${k}' must not be ${u.interface}'s own address or gateway`);
  });
}

function updateWarmSpare(ctx) {
  const net = mxNet(ctx);
  const b = ctx.body;
  const { ws, primary, spare } = roles(net);
  if (!b.enabled) {
    Object.assign(ws, { enabled: false, primary, spare: null, uplinkMode: null, virtualIp1: null, virtualIp2: null });
    return warmSpareJson(net);
  }
  if (!primary) throw badRequest('Warm spare needs an MX in this network');
  let next = spare;
  if (b.spareSerial != null) {
    next = ctx.world.deviceBySerial.get(b.spareSerial);
    if (!inNet(net, next)) throw badRequest(`'spareSerial' ${b.spareSerial} is not an MX in this network`);
    if (next === primary) throw badRequest("'spareSerial' must not be the primary appliance");
  }
  if (!next) throw badRequest("'spareSerial' is required to enable warm spare");
  if (next.model !== primary.model) throw badRequest(`The warm spare must be the same model as the primary (${primary.model})`);
  const uplinkMode = b.uplinkMode ?? (ws.enabled ? ws.uplinkMode : 'public');
  if (!UPLINK_MODES.includes(uplinkMode)) throw badRequest(`'uplinkMode' must be one of ${UPLINK_MODES.join(', ')}`);
  const ips = { virtualIp1: b.virtualIp1 ?? ws.virtualIp1, virtualIp2: b.virtualIp2 ?? ws.virtualIp2 };
  if (uplinkMode === 'virtual') checkVirtualIps(net.mx, ips);
  Object.assign(ws, { enabled: true, primary, spare: next, uplinkMode, ...(uplinkMode === 'virtual' ? ips : { virtualIp1: null, virtualIp2: null }) });
  return warmSpareJson(net);
}

function swapWarmSpare(ctx) {
  const net = mxNet(ctx);
  const { ws, primary, spare } = roles(net);
  if (!ws.enabled || !spare) throw badRequest('Warm spare is not enabled on this network');
  Object.assign(ws, { primary: spare, spare: primary });
  return warmSpareJson(net);
}

export default [
  { op: 'getNetworkApplianceFirewallSettings', path: `${BASE}/firewall/settings`, handler: (ctx) => structuredClone(settingsOf(mxNet(ctx))) },
  {
    op: 'updateNetworkApplianceFirewallSettings',
    method: 'PUT',
    path: `${BASE}/firewall/settings`,
    handler: (ctx) => {
      const set = settingsOf(mxNet(ctx));
      const mode = ctx.body.spoofingProtection?.ipSourceGuard?.mode;
      if (mode != null) set.spoofingProtection.ipSourceGuard.mode = mode;
      return structuredClone(set);
    },
  },
  ...cellularRoutes('CellularFirewallRules', 'cellularFirewallRules', cellularOf),
  ...cellularRoutes('InboundCellularFirewallRules', 'inboundCellularFirewallRules', inboundCellularOf),
  { op: 'getNetworkApplianceFirewallOneToManyNatRules', path: `${BASE}/firewall/oneToManyNatRules`, handler: (ctx) => structuredClone(oneToManyOf(mxNet(ctx))) },
  { op: 'updateNetworkApplianceFirewallOneToManyNatRules', method: 'PUT', path: `${BASE}/firewall/oneToManyNatRules`, handler: updateOneToMany },
  { op: 'updateNetworkApplianceFirewallMulticastForwarding', method: 'PUT', path: `${BASE}/firewall/multicastForwarding`, handler: updateMulticast },
  { op: 'getOrganizationApplianceFirewallMulticastForwardingByNetwork', path: '/organizations/{organizationId}/appliance/firewall/multicastForwarding/byNetwork', handler: multicastByNetwork },
  { op: 'updateNetworkApplianceUplinksNat', method: 'PUT', path: `${BASE}/uplinks/nat`, handler: updateUplinksNat },
  { op: 'getOrganizationApplianceUplinksNatByNetwork', path: '/organizations/{organizationId}/appliance/uplinks/nat/byNetwork', handler: uplinksNatByNetwork },
  { op: 'getNetworkApplianceConnectivityMonitoringDestinations', path: `${BASE}/connectivityMonitoringDestinations`, handler: (ctx) => structuredClone(destinationsOf(mxNet(ctx))) },
  { op: 'updateNetworkApplianceConnectivityMonitoringDestinations', method: 'PUT', path: `${BASE}/connectivityMonitoringDestinations`, handler: updateDestinations },
  { op: 'getNetworkApplianceWarmSpare', path: `${BASE}/warmSpare`, handler: (ctx) => warmSpareJson(mxNet(ctx)) },
  { op: 'updateNetworkApplianceWarmSpare', method: 'PUT', path: `${BASE}/warmSpare`, handler: updateWarmSpare },
  { op: 'swapNetworkApplianceWarmSpare', method: 'POST', path: `${BASE}/warmSpare/swap`, status: 200, handler: swapWarmSpare },
];
