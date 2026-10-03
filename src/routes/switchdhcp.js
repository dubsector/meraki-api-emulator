// DHCP server guard and Dynamic ARP Inspection for a switch network. The
// policy is a setting only; servers seen keep reporting the MX as allowed,
// since the MX is one of the servers that can't be blocked.

import { stored } from '../config.js';
import { deviceUrl } from '../format.js';
import { badRequest, paginate } from '../http.js';
import { inRange, parseIp } from '../validate.js';
import { bySerial, collection, netOf, requireProduct } from './common.js';
import { portConfig } from './switch.js';

const POLICY = '/networks/{networkId}/switch/dhcpServerPolicy';
const TRUSTED = `${POLICY}/arpInspection/trustedServers`;
const MAX_SERVERS = 1000;
const MAX_TRUSTED = 1000;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
// MS120 and MS125 switches can't run DAI.
const UNSUPPORTED = ['MS120-8', 'MS120-8LP', 'MS120-8FP', 'MS120-24', 'MS120-24P', 'MS120-48', 'MS120-48LP', 'MS120-48FP', 'MS125-24', 'MS125-24P', 'MS125-48', 'MS125-48LP', 'MS125-48FP'];

function switchNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return net;
}

const policyOf = (net) =>
  stored(net, 'switchDhcpServerPolicy', () => ({ alerts: { email: { enabled: false } }, defaultPolicy: 'allow', allowedServers: [], blockedServers: [], arpInspection: { enabled: false }, trusted: { created: 0, list: [] } }));

// The MX, which servers seen reports, and the network's switches.
const alwaysAllowed = (net) => [...(net.mx ? [net.mx] : []), ...[...net.switches].sort(bySerial)].map((d) => d.mac);

function policyJson(net) {
  const p = policyOf(net);
  return {
    alerts: { email: { enabled: p.alerts.email.enabled } },
    defaultPolicy: p.defaultPolicy,
    blockedServers: [...p.blockedServers],
    allowedServers: [...p.allowedServers],
    alwaysAllowedServers: alwaysAllowed(net),
    arpInspection: { enabled: p.arpInspection.enabled, unsupportedModels: [...UNSUPPORTED] },
  };
}

function macList(list, what) {
  if (list.length > MAX_SERVERS) throw badRequest(`'${what}' is limited to ${MAX_SERVERS} entries in the emulator`);
  const out = list.map((m) => {
    if (typeof m !== 'string' || !MAC.test(m)) throw badRequest(`'${what}' must be a list of MAC addresses like 00:11:22:33:44:55`);
    return m.toLowerCase();
  });
  const dup = out.find((m, i) => out.indexOf(m) !== i);
  if (dup) throw badRequest(`'${what}' lists ${dup} more than once`);
  return out;
}

function updatePolicy(ctx) {
  const net = switchNet(ctx);
  const b = ctx.body;
  const allowed = b.allowedServers ? macList(b.allowedServers, 'allowedServers') : null;
  const blocked = b.blockedServers ? macList(b.blockedServers, 'blockedServers') : null;
  const always = alwaysAllowed(net);
  const pinned = blocked?.find((m) => always.includes(m));
  if (pinned) throw badRequest(`${pinned} is always allowed on this network and can't be blocked`);
  const p = policyOf(net);
  if (b.alerts?.email?.enabled != null) p.alerts.email.enabled = b.alerts.email.enabled;
  if (b.defaultPolicy != null) p.defaultPolicy = b.defaultPolicy;
  if (allowed) p.allowedServers = allowed;
  if (blocked) p.blockedServers = blocked;
  if (b.arpInspection?.enabled != null) p.arpInspection.enabled = b.arpInspection.enabled;
  return policyJson(net);
}

// ── Trusted servers ──

function checkTrusted(ctx, net, b, self) {
  for (const k of ['mac', 'vlan', 'ipv4']) if (!self && b[k] == null) throw badRequest(`'${k}' is required`);
  if (b.mac != null && !MAC.test(b.mac)) throw badRequest("'mac' must be a MAC address like 00:11:22:33:44:55");
  inRange(b.vlan, 1, 4094, 'vlan');
  if (b.ipv4 != null) {
    const a = b.ipv4.address;
    if (a == null && !self) throw badRequest("'ipv4.address' is required");
    if (a != null && (typeof a !== 'string' || parseIp(a) == null)) throw badRequest("'ipv4.address' must be an IPv4 address");
  }
  const mac = (b.mac ?? self?.mac)?.toLowerCase();
  const vlan = b.vlan ?? self?.vlan;
  const dup = policyOf(net).trusted.list.find((t) => t !== self && t.mac === mac && t.vlan === vlan);
  if (dup) throw badRequest(`${mac} on VLAN ${vlan} is already a trusted server`);
}

const trustedJson = (t) => ({ trustedServerId: t.trustedServerId, mac: t.mac, vlan: t.vlan, ipv4: { address: t.ipv4.address } });

const trusted = collection({
  ops: { create: 'createNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer', update: 'updateNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer', delete: 'deleteNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer' },
  path: TRUSTED,
  param: 'trustedServerId',
  parent: switchNet,
  store: (net) => policyOf(net).trusted,
  what: 'trusted server',
  kind: 'arpTrustedServer',
  key: 'trustedServerId',
  max: MAX_TRUSTED,
  unique: false,
  check: checkTrusted,
  blank: () => ({ mac: null, vlan: null, ipv4: { address: null } }),
  apply: (t, b) => {
    if (b.mac != null) t.mac = b.mac.toLowerCase();
    if (b.vlan != null) t.vlan = b.vlan;
    if (b.ipv4?.address != null) t.ipv4.address = b.ipv4.address;
  },
  json: trustedJson,
});

function listTrusted(ctx) {
  const net = switchNet(ctx);
  return paginate(ctx, policyOf(net).trusted.list, (t) => t.trustedServerId, { def: 1000, max: 1000 }).map(trustedJson);
}

// Switches that can't inspect ARP, or can but have no trusted port to the
// DHCP server. Nothing to warn about while inspection is off.
function warnings(ctx) {
  const net = switchNet(ctx);
  if (!policyOf(net).arpInspection.enabled) return paginate(ctx, [], (r) => r.serial, { def: 1000, max: 1000 });
  const rows = [];
  for (const sw of [...net.switches].sort(bySerial)) {
    const supportsInspection = !UNSUPPORTED.includes(sw.model);
    const hasTrustedPort = supportsInspection && sw.ports.some((p) => portConfig(net, sw, p).daiTrusted);
    if (!hasTrustedPort) rows.push({ serial: sw.serial, name: sw.name, url: deviceUrl(sw), supportsInspection, hasTrustedPort });
  }
  return paginate(ctx, rows, (r) => r.serial, { def: 1000, max: 1000 });
}

export default [
  { op: 'getNetworkSwitchDhcpServerPolicy', path: POLICY, handler: (ctx) => policyJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchDhcpServerPolicy', method: 'PUT', path: POLICY, handler: updatePolicy },
  { op: 'getNetworkSwitchDhcpServerPolicyArpInspectionTrustedServers', path: TRUSTED, handler: listTrusted },
  ...trusted.routes,
  { op: 'getNetworkSwitchDhcpServerPolicyArpInspectionWarningsByDevice', path: `${POLICY}/arpInspection/warnings/byDevice`, handler: warnings },
];
