// Site-to-site VPN settings beyond each network's own VPN mode: hub BGP, the
// organization's third-party peers, IPsec SLA policies and VPN firewall rules,
// and the organization's allowed intrusion rules. All of it is configuration;
// the VPN status and stats routes don't read it.

import { IDS_SIGNATURES } from '../catalog.js';
import { DEFAULT_RULE, configOf, stored } from '../config.js';
import { badRequest } from '../http.js';
import { inRange, isAddress, isHostname, isIpv6, parseCidr, parseIp } from '../validate.js';
import { checkHttpUrl } from '../webhooks.js';
import { checkAddresses, checkList, isPorts } from './firewall.js';
import { limit, mxNet, newId, orgOf } from './common.js';

const ORG = '/organizations/{organizationId}/appliance';
const MAX_ASN = 4294967295;
const DEFAULT_ASN = 64512;
const MAX_NEIGHBORS = 100;
const MAX_PEERS = 300;
const MAX_SLAS = 100;
const MAX_RULES = 1000;
const MAX_ALLOWED = 1000;
const WELL_KNOWN_COMMUNITIES = ['NO_EXPORT', 'NO_ADVERTISE', 'LOCAL_AS', 'INTERNET'];
const DH_GROUPS = ['group14', 'group5', 'group2', 'group1'];
// Custom IPsec policies start from these; a peer with neither policies nor a preset uses the default preset.
const POLICY_DEFAULTS = {
  ikeCipherAlgo: ['tripledes'],
  ikeAuthAlgo: ['sha1'],
  ikePrfAlgo: ['default'],
  ikeDiffieHellmanGroup: ['group2'],
  ikeLifetime: 28800,
  childCipherAlgo: ['aes128'],
  childAuthAlgo: ['sha1'],
  childPfsGroup: ['disabled'],
  childLifetime: 28800,
};
const RULE_ID = /^meraki:intrusion\/snort\/GID\/(\d+)\/SID\/(\d+)$/;

const peersOf = (org) => (org.vpnPeers ??= { created: 0, neighbors: 0, list: [] });
const slasOf = (org) => (org.vpnSlaPolicies ??= { created: 0, list: [] });
const vpnRulesOf = (org) => (org.vpnFirewallRules ??= { rules: [], syslogDefaultRule: false });
const intrusionOf = (org) => (org.applianceIntrusion ??= { allowedRules: [] });
// The ASN covers the whole Auto VPN domain, so every hub shares it.
const asnOf = (org) => (org.vpnBgp ??= { asNumber: DEFAULT_ASN });

const text = (v) => typeof v === 'string' && v.trim() !== '';

function checkSubnets(list, name) {
  if (!Array.isArray(list) || !list.length) throw badRequest(`'${name}' must list at least one subnet`);
  for (const s of list) if (!parseCidr(s)) throw badRequest(`'${name}' must hold IPv4 CIDRs such as 192.168.1.0/24`);
}

function checkPrepend(list, name) {
  if (list == null) return;
  limit(list, 10, `'${name}' values`);
  list.forEach((v, i) => inRange(v, 1, MAX_ASN, `${name}[${i}]`));
}

// ── Hub BGP ──

const bgpOf = (net) => stored(net, 'applianceVpnBgp', () => ({ enabled: false, ibgpHoldTimer: 240, neighbors: [] }));
const isHub = (net) => configOf(net).siteToSite.mode === 'hub';

function bgpJson(net) {
  const s = bgpOf(net);
  const out = { enabled: s.enabled && isHub(net), asNumber: asnOf(net.org).asNumber, ibgpHoldTimer: s.ibgpHoldTimer };
  if (s.routerId) out.routerId = s.routerId;
  out.neighbors = structuredClone(s.neighbors);
  return out;
}

function sourceInterface(net, v, at) {
  const m = /^(wan|vlan)(\d+)$/.exec(v);
  if (!m) throw badRequest(`'${at}' must be wan{number} or vlan{VLAN ID}`);
  const c = configOf(net);
  const ok = m[1] === 'wan' ? net.mx.uplinks.some((u) => u.interface === v) : c.vlansEnabled && c.vlans.some((x) => x.id === m[2]);
  if (!ok) throw badRequest(`'${at}' ${v} does not exist on this network`);
}

function bgpNeighbor(net, n, i) {
  const at = `neighbors[${i}]`;
  if (n.ip == null && n.ipv6?.address == null) throw badRequest(`'${at}' needs 'ip' or 'ipv6.address'`);
  if (n.ip != null && parseIp(n.ip) == null) throw badRequest(`'${at}.ip' must be an IPv4 address`);
  if (n.ipv6?.address != null && !isIpv6(n.ipv6.address)) throw badRequest(`'${at}.ipv6.address' must be an IPv6 address`);
  inRange(n.remoteAsNumber, 1, MAX_ASN, `${at}.remoteAsNumber`);
  inRange(n.receiveLimit, 0, 2147483647, `${at}.receiveLimit`);
  inRange(n.ebgpHoldTimer, 12, 240, `${at}.ebgpHoldTimer`);
  inRange(n.ebgpMultihop, 1, 255, `${at}.ebgpMultihop`);
  inRange(n.multiExitDiscriminator, 0, MAX_ASN, `${at}.multiExitDiscriminator`);
  inRange(n.weight, 0, 49, `${at}.weight`);
  checkPrepend(n.pathPrepend, `${at}.pathPrepend`);
  if (n.sourceInterface != null) sourceInterface(net, n.sourceInterface, `${at}.sourceInterface`);
  if (n.nextHopIp != null && parseIp(n.nextHopIp) == null) throw badRequest(`'${at}.nextHopIp' must be an IPv4 address`);
  if (n.filterIn != null && !n.filterIn.every((x) => parseCidr(x))) throw badRequest(`'${at}.filterIn' must hold IPv4 CIDRs such as 10.0.0.0/8`);
  if (n.communityOut != null && !n.communityOut.every((x) => /^\d+:\d+(:\d+)?$/.test(x) || WELL_KNOWN_COMMUNITIES.includes(x))) {
    throw badRequest(`'${at}.communityOut' must hold communities such as 64515:100 or ${WELL_KNOWN_COMMUNITIES.join(', ')}`);
  }
  const out = {};
  if (n.ip != null) out.ip = n.ip;
  if (n.ipv6?.address != null) out.ipv6 = { address: n.ipv6.address };
  Object.assign(out, {
    remoteAsNumber: n.remoteAsNumber,
    receiveLimit: n.receiveLimit ?? 0,
    allowTransit: n.allowTransit ?? false,
    ebgpHoldTimer: n.ebgpHoldTimer,
    ebgpMultihop: n.ebgpMultihop,
    sourceInterface: n.sourceInterface ?? 'wan1',
  });
  if (n.nextHopIp != null) out.nextHopIp = n.nextHopIp;
  out.ttlSecurity = { enabled: n.ttlSecurity?.enabled ?? false };
  if (n.authentication?.password != null) out.authentication = { password: n.authentication.password };
  for (const k of ['multiExitDiscriminator', 'pathPrepend', 'weight', 'filterIn', 'communityOut']) if (n[k] != null) out[k] = structuredClone(n[k]);
  return out;
}

function updateBgp(ctx) {
  const net = mxNet(ctx);
  const b = ctx.body;
  if (typeof b.enabled !== 'boolean') throw badRequest("'enabled' must be true or false");
  if (b.enabled && !isHub(net)) throw badRequest('BGP can only be enabled on networks in VPN hub mode');
  inRange(b.asNumber, 1, MAX_ASN, 'asNumber');
  inRange(b.ibgpHoldTimer, 12, 240, 'ibgpHoldTimer');
  if (b.routerId != null && parseIp(b.routerId) == null) throw badRequest("'routerId' must be an IPv4 address");
  let neighbors;
  if (b.neighbors) {
    neighbors = limit(b.neighbors, MAX_NEIGHBORS, 'BGP neighbors').map((n, i) => bgpNeighbor(net, n, i));
    const keys = neighbors.map((n) => n.ip ?? n.ipv6.address);
    if (new Set(keys).size < keys.length) throw badRequest('Each BGP neighbor needs its own address');
  }
  const s = bgpOf(net);
  s.enabled = b.enabled;
  if (b.asNumber != null) asnOf(net.org).asNumber = b.asNumber;
  if (b.ibgpHoldTimer != null) s.ibgpHoldTimer = b.ibgpHoldTimer;
  if (b.routerId != null) s.routerId = b.routerId;
  if (neighbors) s.neighbors = neighbors;
  return bgpJson(net);
}

// ── Third-party VPN peers ──

// IDs in the store resolve on read, so removed SLA policies and networks drop out.
function peerJson(org, p) {
  const out = { peerId: p.id, name: p.name };
  for (const k of ['publicIp', 'publicHostname', 'remoteId', 'localId']) if (p[k] != null) out[k] = p[k];
  out.secret = p.secret;
  out.privateSubnets = [...p.privateSubnets];
  if (p.ipsecPoliciesPreset) out.ipsecPoliciesPreset = p.ipsecPoliciesPreset;
  else out.ipsecPolicies = structuredClone(p.ipsecPolicies);
  if (p.slaPolicyId && slasOf(org).list.some((s) => s.id === p.slaPolicyId)) out.slaPolicy = { id: p.slaPolicyId };
  out.ikeVersion = p.ikeVersion;
  out.networkTags = [...p.networkTags];
  if (p.networkIds) {
    const nets = p.networkIds.map((id) => org.networks.find((n) => n.id === id)).filter(Boolean);
    out.network = { names: nets.map((n) => n.name), ids: nets.map((n) => n.id) };
  }
  out.isRouteBased = p.isRouteBased;
  for (const k of ['ebgpNeighbor', 'ecmpUplinkConfigs', 'priorityInGroup', 'group']) if (p[k] != null) out[k] = structuredClone(p[k]);
  return out;
}

const peersJson = (org) => ({ peers: peersOf(org).list.map((p) => peerJson(org, p)) });

function ipsecPolicies(given, at) {
  const out = { ...structuredClone(POLICY_DEFAULTS), ...structuredClone(given) };
  for (const k of ['ikeCipherAlgo', 'ikeAuthAlgo', 'ikePrfAlgo', 'ikeDiffieHellmanGroup']) {
    if (!Array.isArray(out[k]) || out[k].length !== 1) throw badRequest(`'${at}.${k}' must hold exactly one value`);
  }
  for (const k of ['childCipherAlgo', 'childAuthAlgo', 'childPfsGroup']) {
    if (!Array.isArray(out[k]) || !out[k].length) throw badRequest(`'${at}.${k}' must hold at least one value`);
  }
  if (!DH_GROUPS.includes(out.ikeDiffieHellmanGroup[0])) throw badRequest(`'${at}.ikeDiffieHellmanGroup' must be one of ${DH_GROUPS.join(', ')}`);
  if (!out.childPfsGroup.every((g) => g === 'disabled' || DH_GROUPS.includes(g))) throw badRequest(`'${at}.childPfsGroup' must hold disabled or ${DH_GROUPS.join(', ')}`);
  inRange(out.ikeLifetime, 60, 2 ** 31 - 1, `${at}.ikeLifetime`);
  inRange(out.childLifetime, 60, 2 ** 31 - 1, `${at}.childLifetime`);
  return out;
}

const neighborIp = (v, at) => {
  if (v != null && parseIp(v) == null && !isIpv6(v)) throw badRequest(`'${at}' must be an IPv4 or IPv6 address`);
};

function ebgpNeighbor(n, at, old) {
  if (n.neighborIp == null) throw badRequest(`'${at}.neighborIp' is required`);
  neighborIp(n.neighborIp, `${at}.neighborIp`);
  neighborIp(n.sourceIp, `${at}.sourceIp`);
  const version = isIpv6(n.neighborIp) ? 6 : 4;
  if (n.ipVersion != null && n.ipVersion !== version) throw badRequest(`'${at}.ipVersion' must match neighborIp (IPv${version})`);
  if (n.remoteAsNumber == null) throw badRequest(`'${at}.remoteAsNumber' is required`);
  inRange(n.remoteAsNumber, 1, MAX_ASN, `${at}.remoteAsNumber`);
  inRange(n.ebgpHoldTimer, 12, 240, `${at}.ebgpHoldTimer`);
  inRange(n.ebgpMultihop, 1, 255, `${at}.ebgpMultihop`);
  inRange(n.multiExitDiscriminator, 0, MAX_ASN, `${at}.multiExitDiscriminator`);
  inRange(n.weight, 0, MAX_ASN, `${at}.weight`);
  checkPrepend(n.pathPrepend, `${at}.pathPrepend`);
  const out = { neighborId: old?.neighborId, neighborIp: n.neighborIp, ipVersion: version, remoteAsNumber: n.remoteAsNumber, ebgpHoldTimer: n.ebgpHoldTimer ?? 180, ebgpMultihop: n.ebgpMultihop ?? 1 };
  for (const k of ['sourceIp', 'pathPrepend', 'multiExitDiscriminator', 'weight']) if (n[k] != null) out[k] = structuredClone(n[k]);
  return out;
}

function ecmpConfigs(list, at, old) {
  limit(list, 4, `'${at}' entries`);
  const wans = list.map((c) => c.wan);
  if (wans.some((w) => w == null)) throw badRequest(`'${at}[].wan' is required`);
  if (new Set(wans).size < wans.length) throw badRequest(`'${at}' must name each WAN once`);
  return list.map((c, i) => {
    const here = `${at}[${i}]`;
    checkSubnets(c.privateSubnets, `${here}.privateSubnets`);
    neighborIp(c.ebgpNeighbor?.neighborIp, `${here}.ebgpNeighbor.neighborIp`);
    neighborIp(c.ebgpNeighbor?.sourceIp, `${here}.ebgpNeighbor.sourceIp`);
    if (c.id != null && !old?.some((x) => x.id === c.id)) throw badRequest(`'${here}.id' ${c.id} is not an ECMP configuration of this peer`);
    const out = { id: c.id, wan: c.wan, privateSubnets: [...c.privateSubnets] };
    const nb = c.ebgpNeighbor;
    if (nb?.neighborIp != null || nb?.sourceIp != null) out.ebgpNeighbor = { ...(nb.neighborIp != null && { neighborIp: nb.neighborIp }), ...(nb.sourceIp != null && { sourceIp: nb.sourceIp }) };
    return out;
  });
}

// An IPv4 address, an FQDN or a user FQDN (user@example.com).
const isPeerId = (v) => parseIp(v) != null || isHostname(v) || (/^[^@\s]+@[^@\s]+$/.test(v) && isHostname(v.split('@')[1]));

// Checks one peer and returns what to store, without IDs for new items yet.
function checkPeer(org, p, i) {
  const at = `peers[${i}]`;
  const store = peersOf(org);
  const old = p.peerId != null ? store.list.find((x) => x.id === p.peerId) : null;
  if (p.peerId != null && !old) throw badRequest(`'${at}.peerId' ${p.peerId} is not a peer in this organization`);
  if (!text(p.name)) throw badRequest(`'${at}.name' must not be empty`);
  if (!text(p.secret)) throw badRequest(`'${at}.secret' must not be empty`);
  if (p.publicIp == null && p.publicHostname == null) throw badRequest(`'${at}' needs 'publicIp' or 'publicHostname'`);
  if (p.publicIp != null && p.publicHostname != null) throw badRequest(`'${at}' takes 'publicIp' or 'publicHostname', not both`);
  if (p.publicIp != null && parseIp(p.publicIp) == null) throw badRequest(`'${at}.publicIp' must be an IPv4 address`);
  if (p.publicHostname != null && !isHostname(p.publicHostname)) throw badRequest(`'${at}.publicHostname' must be a hostname`);
  if (p.remoteId != null && !isPeerId(p.remoteId)) throw badRequest(`'${at}.remoteId' must be an IPv4 address, an FQDN or a user FQDN`);
  checkSubnets(p.privateSubnets, `${at}.privateSubnets`);
  const out = { id: old?.id, name: p.name };
  for (const k of ['publicIp', 'publicHostname', 'remoteId', 'localId']) if (p[k] != null) out[k] = p[k];
  Object.assign(out, { secret: p.secret, privateSubnets: [...p.privateSubnets] });
  if (p.ipsecPoliciesPreset != null || p.ipsecPolicies == null) out.ipsecPoliciesPreset = p.ipsecPoliciesPreset ?? 'default';
  else out.ipsecPolicies = ipsecPolicies(p.ipsecPolicies, `${at}.ipsecPolicies`);
  if (p.slaPolicy?.id != null) {
    if (!slasOf(org).list.some((s) => s.id === p.slaPolicy.id)) throw badRequest(`'${at}.slaPolicy.id' ${p.slaPolicy.id} is not an IPsec SLA policy in this organization`);
    out.slaPolicyId = p.slaPolicy.id;
  }
  out.ikeVersion = p.ikeVersion ?? '1';
  out.networkTags = p.networkTags ? [...new Set(p.networkTags)] : ['all'];
  if (p.network?.ids) {
    for (const id of p.network.ids) {
      if (!org.networks.some((n) => n.id === id && n.productTypes.includes('appliance'))) throw badRequest(`'${at}.network.ids' ${id} is not an appliance network in this organization`);
    }
    out.networkIds = [...new Set(p.network.ids)];
  }
  out.isRouteBased = p.isRouteBased ?? false;
  if ((p.ebgpNeighbor || p.ecmpUplinkConfigs) && !out.isRouteBased) throw badRequest(`'${at}' needs 'isRouteBased' for BGP neighbors and ECMP uplinks`);
  if (p.ebgpNeighbor) out.ebgpNeighbor = ebgpNeighbor(p.ebgpNeighbor, `${at}.ebgpNeighbor`, old?.ebgpNeighbor);
  if (p.ecmpUplinkConfigs) out.ecmpUplinkConfigs = ecmpConfigs(p.ecmpUplinkConfigs, `${at}.ecmpUplinkConfigs`, old?.ecmpUplinkConfigs);
  if (p.priorityInGroup != null) out.priorityInGroup = p.priorityInGroup;
  if (p.group) {
    out.group = {};
    if (p.group.number != null) out.group.number = p.group.number;
    if (p.group.failover?.directToInternet != null) out.group.failover = { directToInternet: p.group.failover.directToInternet };
    if (p.group.activeActiveTunnel != null) out.group.activeActiveTunnel = p.group.activeActiveTunnel;
  }
  return out;
}

// Group numbers, and priorities inside each group, become 1, 2, 3 in their order.
function renumber(peers) {
  const numbers = [...new Set(peers.map((p) => p.group?.number).filter((n) => n != null))].sort((a, b) => a - b);
  for (const p of peers) if (p.group?.number != null) p.group.number = numbers.indexOf(p.group.number) + 1;
  const groups = Map.groupBy(peers.filter((p) => p.priorityInGroup != null), (p) => p.group?.number ?? null);
  for (const list of groups.values()) {
    const order = [...new Set(list.map((p) => p.priorityInGroup))].sort((a, b) => a - b);
    for (const p of list) p.priorityInGroup = order.indexOf(p.priorityInGroup) + 1;
  }
}

function updatePeers(ctx) {
  const org = orgOf(ctx);
  const store = peersOf(org);
  const peers = limit(ctx.body.peers, MAX_PEERS, 'Third-party VPN peers').map((p, i) => checkPeer(org, p, i));
  const names = peers.map((p) => p.name);
  if (new Set(names).size < names.length) throw badRequest('Each peer needs its own name');
  const ids = peers.map((p) => p.id).filter(Boolean);
  if (new Set(ids).size < ids.length) throw badRequest('Each peer ID can be given once');
  renumber(peers);
  for (const p of peers) {
    p.id ??= newId(ctx, store, 'vpnPeer', org.id);
    if (p.ebgpNeighbor) p.ebgpNeighbor.neighborId ??= ++store.neighbors;
    for (const c of p.ecmpUplinkConfigs || []) c.id ??= newId(ctx, store, 'vpnEcmp', org.id);
  }
  store.list = peers;
  return peersJson(org);
}

// ── IPsec SLA policies ──

function slasJson(org) {
  const peers = peersOf(org).list;
  const items = slasOf(org).list.map((s) => ({ id: s.id, name: s.name, uri: s.uri, ipsec: { peerIds: peers.filter((p) => p.slaPolicyId === s.id).map((p) => p.id) } }));
  return { items, meta: { counts: { items: { total: items.length, remaining: 0 } } } };
}

// The body has no IDs, so a policy keeps its ID when one with the same name stays.
function updateSlas(ctx) {
  const org = orgOf(ctx);
  const store = slasOf(org);
  const given = ctx.body.items;
  if (given) {
    limit(given, MAX_SLAS, 'IPsec SLA policies');
    given.forEach((s, i) => {
      if (!text(s.name)) throw badRequest(`'items[${i}].name' must not be empty`);
      if (s.uri == null) throw badRequest(`'items[${i}].uri' is required`);
      checkHttpUrl(s.uri, `items[${i}].uri`);
    });
    const names = given.map((s) => s.name);
    if (new Set(names).size < names.length) throw badRequest('Each SLA policy needs its own name');
    store.list = given.map((s) => ({ id: store.list.find((x) => x.name === s.name)?.id ?? newId(ctx, store, 'vpnSla', org.id), name: s.name, uri: s.uri }));
  }
  return slasJson(org);
}

// ── VPN firewall rules ──

// Like the L3 rules: the default rule is always last and dropped when sent back.
function vpnRulesJson(org) {
  const set = vpnRulesOf(org);
  return { rules: [...structuredClone(set.rules), { ...DEFAULT_RULE, syslogEnabled: set.syslogDefaultRule }] };
}

function updateVpnRules(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  let rules;
  if (b.rules) {
    rules = limit(b.rules, MAX_RULES, 'VPN firewall rules').filter((r) => r.comment !== DEFAULT_RULE.comment);
    rules.forEach((r, i) => {
      checkList(r.srcPort, `rules[${i}].srcPort`, isPorts, 'ports');
      checkList(r.destPort, `rules[${i}].destPort`, isPorts, 'ports');
      checkAddresses(org, r.srcCidr, `rules[${i}].srcCidr`, isAddress, 'IP addresses or CIDRs');
      checkAddresses(org, r.destCidr, `rules[${i}].destCidr`, isAddress, 'IP addresses or CIDRs');
    });
  }
  const set = vpnRulesOf(org);
  if (rules) set.rules = rules.map((r) => ({ comment: r.comment ?? '', policy: r.policy, protocol: r.protocol, srcPort: r.srcPort ?? 'Any', srcCidr: r.srcCidr ?? 'Any', destPort: r.destPort ?? 'Any', destCidr: r.destCidr ?? 'Any', syslogEnabled: r.syslogEnabled ?? false }));
  if (b.syslogDefaultRule != null) set.syslogDefaultRule = b.syslogDefaultRule;
  return vpnRulesJson(org);
}

// ── Organization intrusion settings ──

// GET names the rules the emulator's IDS catalog knows; PUT ignores messages.
function ruleMessage(ruleId) {
  const [, gid, sid] = RULE_ID.exec(ruleId);
  return IDS_SIGNATURES.find((s) => s.signature.startsWith(`${Number(gid)}:${Number(sid)}:`))?.message;
}

function intrusionJson(org) {
  return { allowedRules: intrusionOf(org).allowedRules.map((ruleId) => ({ ruleId, ...(ruleMessage(ruleId) && { message: ruleMessage(ruleId) }) })) };
}

function updateIntrusion(ctx) {
  const org = orgOf(ctx);
  const given = limit(ctx.body.allowedRules, MAX_ALLOWED, 'Allowed rules');
  given.forEach((r, i) => {
    if (!RULE_ID.test(r.ruleId ?? '')) throw badRequest(`'allowedRules[${i}].ruleId' must look like meraki:intrusion/snort/GID/1/SID/688`);
  });
  intrusionOf(org).allowedRules = [...new Set(given.map((r) => r.ruleId))];
  return intrusionJson(org);
}

export default [
  { op: 'getNetworkApplianceVpnBgp', path: '/networks/{networkId}/appliance/vpn/bgp', handler: (ctx) => bgpJson(mxNet(ctx)) },
  { op: 'updateNetworkApplianceVpnBgp', method: 'PUT', path: '/networks/{networkId}/appliance/vpn/bgp', handler: updateBgp },
  { op: 'getOrganizationApplianceVpnThirdPartyVPNPeers', path: `${ORG}/vpn/thirdPartyVPNPeers`, handler: (ctx) => peersJson(orgOf(ctx)) },
  { op: 'updateOrganizationApplianceVpnThirdPartyVPNPeers', method: 'PUT', path: `${ORG}/vpn/thirdPartyVPNPeers`, handler: updatePeers },
  { op: 'getOrganizationApplianceVpnSiteToSiteIpsecPeersSlas', path: `${ORG}/vpn/siteToSite/ipsec/peers/slas`, handler: (ctx) => slasJson(orgOf(ctx)) },
  { op: 'updateOrganizationApplianceVpnSiteToSiteIpsecPeersSlas', method: 'PUT', path: `${ORG}/vpn/siteToSite/ipsec/peers/slas`, handler: updateSlas },
  { op: 'getOrganizationApplianceVpnVpnFirewallRules', path: `${ORG}/vpn/vpnFirewallRules`, handler: (ctx) => vpnRulesJson(orgOf(ctx)) },
  { op: 'updateOrganizationApplianceVpnVpnFirewallRules', method: 'PUT', path: `${ORG}/vpn/vpnFirewallRules`, handler: updateVpnRules },
  { op: 'getOrganizationApplianceSecurityIntrusion', path: `${ORG}/security/intrusion`, handler: (ctx) => intrusionJson(orgOf(ctx)) },
  { op: 'updateOrganizationApplianceSecurityIntrusion', method: 'PUT', path: `${ORG}/security/intrusion`, handler: updateIntrusion },
];
