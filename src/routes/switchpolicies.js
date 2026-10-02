// Switch ACLs, access policies (802.1X and MAC bypass against RADIUS), QoS
// rules and DSCP to CoS mappings. All are network settings, so a network bound
// to a config template takes them from the template.

import { configOf, stored } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { inRange, isAddress, isIpv6, isPort, merge, parseIp } from '../validate.js';
import { limit, netOf, newId, requireProduct } from './common.js';
import { CUSTOM_POLICY, portConfig } from './switch.js';

const NET = '/networks/{networkId}/switch';
const POLICIES = `${NET}/accessPolicies`;
const POLICY = `${POLICIES}/{accessPolicyNumber}`;
const QOS = `${NET}/qosRules`;
const QOS_RULE = `${QOS}/{qosRuleId}`;
const MAX_ACL_RULES = 128;
const MAX_POLICIES = 32;
const MAX_SERVERS = 8;
const MAX_RANGES = 32;
const MAX_QOS_RULES = 128;
const MAX_MAPPINGS = 64;
const MAX_NAME = 255;
const MAX_CACHE_HOURS = 24;
const ACL_DEFAULT = { comment: 'Default rule', policy: 'allow', ipVersion: 'any', protocol: 'any', srcCidr: 'any', srcPort: 'any', dstCidr: 'any', dstPort: 'any', vlan: 'any' };
// The AF classes and EF on the switch's six queues. A guess to settle with the real GET.
const DSCP_DEFAULTS = [
  { dscp: 0, cos: 0, title: 'Best effort' },
  { dscp: 10, cos: 1, title: 'AF11' },
  { dscp: 18, cos: 2, title: 'AF21' },
  { dscp: 26, cos: 3, title: 'AF31' },
  { dscp: 34, cos: 4, title: 'AF41' },
  { dscp: 46, cos: 5, title: 'EF' },
];
const MISSING = { accessPolicyNumber: '999', qosRuleId: '578149602163689004', status: 404 };

function switchNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  return net;
}

const isAny = (v) => v == null || /^any$/i.test(v);
const vlanError = (at) => badRequest(`'${at}' must be a VLAN from 1 to 4094`);
const checkVlan = (v, at) => {
  if (v != null && !(Number.isInteger(v) && v >= 1 && v <= 4094)) throw vlanError(at);
};

// ── Access control lists ──

const aclOf = (net) => stored(net, 'switchAccessControlLists', () => ({ rules: [] }));
const aclJson = (net) => ({ rules: [...structuredClone(aclOf(net).rules), { ...ACL_DEFAULT }] });

function isIpv6Cidr(v) {
  const [ip, bits, extra] = String(v).split('/');
  return extra === undefined && isIpv6(ip) && (bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128));
}

const FAMILIES = {
  ipv4: { ok: isAddress, name: 'IPv4' },
  ipv6: { ok: isIpv6Cidr, name: 'IPv6' },
  any: { ok: (v) => isAddress(v) || isIpv6Cidr(v), name: 'IP' },
};

function aclRule(r, i) {
  const at = (k) => `rules[${i}].${k}`;
  for (const k of ['policy', 'protocol', 'srcCidr', 'dstCidr']) if (r[k] == null) throw badRequest(`'${at(k)}' is required`);
  const ipVersion = r.ipVersion ?? 'ipv4';
  const protocol = r.protocol.toLowerCase();
  const family = FAMILIES[ipVersion];
  for (const k of ['srcCidr', 'dstCidr']) if (!isAny(r[k]) && !family.ok(r[k])) throw badRequest(`'${at(k)}' must be 'any' or an ${family.name} address or CIDR`);
  for (const k of ['srcPort', 'dstPort']) {
    if (isAny(r[k])) continue;
    if (!isPort(String(r[k]))) throw badRequest(`'${at(k)}' must be 'any' or a port from 1 to 65535`);
    if (protocol === 'any') throw badRequest(`'${at(k)}' needs 'protocol' to be 'tcp' or 'udp'`);
  }
  if (!isAny(r.vlan) && !(/^\d{1,4}$/.test(r.vlan) && r.vlan >= 1 && r.vlan <= 4095)) throw badRequest(`'${at('vlan')}' must be 'any' or a VLAN from 1 to 4095`);
  const val = (v) => (isAny(v) ? 'any' : String(v));
  return { comment: r.comment ?? '', policy: r.policy, ipVersion, protocol, srcCidr: val(r.srcCidr), srcPort: val(r.srcPort), dstCidr: val(r.dstCidr), dstPort: val(r.dstPort), vlan: val(r.vlan) };
}

// Like the MX L3 rules: the default rule is always last and dropped when sent back.
function updateAcl(ctx) {
  const net = switchNet(ctx);
  const rules = limit(ctx.body.rules, MAX_ACL_RULES, 'ACL rules').filter((r) => r.comment !== ACL_DEFAULT.comment).map(aclRule);
  aclOf(net).rules = rules;
  return aclJson(net);
}

// ── Access policies ──

const policiesOf = (net) => stored(net, 'switchAccessPolicies', () => ({ created: 0, servers: 0, list: [] }));

function policyDefaults() {
  return {
    name: '',
    radiusServers: [],
    radius: {
      criticalAuth: { dataVlanId: null, voiceVlanId: null, suspendPortBounce: false, dataGroupPolicyId: null, voiceGroupPolicyId: null, dataSgtId: null, voiceSgtId: null },
      failedAuthVlanId: null,
      failedAuthGroupPolicyId: null,
      failedAuthSgtId: null,
      reAuthenticationInterval: null,
      cache: { enabled: false, timeout: null },
      authentication: { mode: 'Open' },
      preAuthenticationGroupPolicyId: null,
    },
    guestPortBouncing: false,
    radiusTestingEnabled: false,
    radiusCoaSupportEnabled: false,
    radiusAccountingEnabled: false,
    radiusAccountingServers: [],
    radiusGroupAttribute: '',
    hostMode: 'Single-Host',
    accessPolicyType: '802.1x',
    increaseAccessSpeed: false,
    guestVlanId: null,
    dot1x: { controlDirection: 'both' },
    voiceVlanClients: false,
    urlRedirectWalledGardenEnabled: false,
    urlRedirectWalledGardenRanges: [],
    guestGroupPolicyId: null,
    guestSgtId: null,
  };
}

function policyOf(ctx) {
  const net = switchNet(ctx);
  const p = policiesOf(net).list.find((x) => x.number === ctx.params.accessPolicyNumber);
  if (!p) throw notFound('Access policy');
  return { net, p };
}

// Ports in the network that use each policy, by policy number.
function portCounts(net) {
  const counts = new Map();
  for (const sw of net.switches) {
    for (const port of sw.ports) {
      const c = portConfig(net, sw, port);
      if (c.accessPolicyType === CUSTOM_POLICY && c.accessPolicyNumber != null) counts.set(String(c.accessPolicyNumber), (counts.get(String(c.accessPolicyNumber)) ?? 0) + 1);
    }
  }
  return counts;
}

const serverJson = (s) => ({ serverId: s.serverId, organizationRadiusServerId: '', host: s.host, port: s.port });

function policyJson(p, counts) {
  const c = structuredClone(p);
  return {
    accessPolicyNumber: c.number,
    name: c.name,
    radiusServers: c.radiusServers.map(serverJson),
    radius: c.radius,
    enforceRadiusMonitoring: false,
    guestPortBouncing: c.guestPortBouncing,
    radiusTestingEnabled: c.radiusTestingEnabled,
    radiusCoaSupportEnabled: c.radiusCoaSupportEnabled,
    radiusAccountingEnabled: c.radiusAccountingEnabled,
    radiusAccountingServers: c.radiusAccountingServers.map(serverJson),
    radiusGroupAttribute: c.radiusGroupAttribute,
    hostMode: c.hostMode,
    accessPolicyType: c.accessPolicyType,
    increaseAccessSpeed: c.increaseAccessSpeed,
    guestVlanId: c.guestVlanId,
    dot1x: c.dot1x,
    voiceVlanClients: c.voiceVlanClients,
    urlRedirectWalledGardenEnabled: c.urlRedirectWalledGardenEnabled,
    urlRedirectWalledGardenRanges: c.urlRedirectWalledGardenRanges,
    counts: { ports: { withThisPolicy: counts.get(c.number) ?? 0 } },
    guestGroupPolicyId: c.guestGroupPolicyId,
    guestSgtId: c.guestSgtId,
  };
}

// Servers named by serverId keep their secret unless a new one is sent; the
// rest are new and need a host and a secret. IDs are handed out by the caller.
function checkServers(given, old, at, defaultPort) {
  limit(given, MAX_SERVERS, 'RADIUS servers');
  return given.map((s, i) => {
    if (s.organizationRadiusServerId != null && s.organizationRadiusServerId !== '') throw badRequest(`Organization RADIUS server '${s.organizationRadiusServerId}' does not exist`);
    const prev = s.serverId != null ? old.find((x) => x.serverId === String(s.serverId)) : null;
    if (s.serverId != null && !prev) throw badRequest(`'${at}[${i}].serverId' '${s.serverId}' is not one of this policy's servers`);
    const host = s.host ?? prev?.host;
    if (host == null || (parseIp(host) == null && !isIpv6(host))) throw badRequest(`'${at}[${i}].host' must be an IP address`);
    const port = s.port ?? prev?.port ?? defaultPort;
    inRange(port, 1, 65535, `${at}[${i}].port`);
    const secret = s.secret ?? prev?.secret;
    if (!secret) throw badRequest(`'${at}[${i}].secret' is required for a new RADIUS server`);
    return { serverId: prev?.serverId ?? null, host, port, secret };
  });
}

function checkGroupPolicy(net, id, at) {
  if (id != null && !configOf(net).groupPolicies.some((g) => g.groupPolicyId === String(id))) throw badRequest(`'${at}': group policy '${id}' does not exist in this network`);
}

// A null can clear an optional ID or VLAN, but not a flag, list or setting that always has a value.
function keepSet(next, prev, defaults) {
  for (const [k, def] of Object.entries(defaults)) {
    if (def === null) continue;
    if (next[k] == null) next[k] = structuredClone(prev[k] ?? def);
    else if (typeof def === 'object' && !Array.isArray(def)) keepSet(next[k], prev[k] ?? def, def);
  }
  return next;
}

// The policy as it would be after the body, checked in full before anything changes.
function nextPolicy(net, p, b) {
  const { radiusServers, radiusAccountingServers, number, ...patch } = b;
  const next = keepSet(merge(structuredClone(p), patch), p, policyDefaults());
  next.radiusServers = radiusServers ? checkServers(radiusServers, p.radiusServers, 'radiusServers', 1812) : p.radiusServers;
  next.radiusAccountingServers = radiusAccountingServers ? checkServers(radiusAccountingServers, p.radiusAccountingServers, 'radiusAccountingServers', 1813) : p.radiusAccountingServers;
  if (typeof next.name !== 'string' || !next.name.trim()) throw badRequest("'name' must not be empty");
  if (next.name.length > MAX_NAME) throw badRequest(`'name' must be at most ${MAX_NAME} characters`);
  const r = next.radius;
  for (const [v, at] of [[next.guestVlanId, 'guestVlanId'], [r.failedAuthVlanId, 'radius.failedAuthVlanId'], [r.criticalAuth.dataVlanId, 'radius.criticalAuth.dataVlanId'], [r.criticalAuth.voiceVlanId, 'radius.criticalAuth.voiceVlanId']]) checkVlan(v, at);
  for (const [v, at] of [[next.guestGroupPolicyId, 'guestGroupPolicyId'], [r.failedAuthGroupPolicyId, 'radius.failedAuthGroupPolicyId'], [r.preAuthenticationGroupPolicyId, 'radius.preAuthenticationGroupPolicyId'], [r.criticalAuth.dataGroupPolicyId, 'radius.criticalAuth.dataGroupPolicyId'], [r.criticalAuth.voiceGroupPolicyId, 'radius.criticalAuth.voiceGroupPolicyId']]) checkGroupPolicy(net, v, at);
  inRange(r.reAuthenticationInterval, 1, 65535, 'radius.reAuthenticationInterval');
  if (r.cache.enabled && r.cache.timeout == null) throw badRequest("'radius.cache.timeout' is required when RADIUS caching is enabled");
  inRange(r.cache.timeout, 1, MAX_CACHE_HOURS, 'radius.cache.timeout');
  if (!['', '11'].includes(next.radiusGroupAttribute)) throw badRequest("'radiusGroupAttribute' must be '' or '11'");
  if (next.radiusAccountingEnabled && !next.radiusAccountingServers.length) throw badRequest("'radiusAccountingServers' needs at least one server when RADIUS accounting is enabled");
  limit(next.urlRedirectWalledGardenRanges, MAX_RANGES, 'Walled garden ranges');
  next.urlRedirectWalledGardenRanges.forEach((v, i) => {
    if (!isAddress(v)) throw badRequest(`'urlRedirectWalledGardenRanges[${i}]' must be an IP address or CIDR`);
  });
  // Multi-Domain implies hybrid authentication and voice clients; Multi-Auth has no VLAN fallbacks.
  if (next.hostMode === 'Multi-Domain') Object.assign(next, { accessPolicyType: 'Hybrid authentication', voiceVlanClients: true });
  if (next.hostMode === 'Multi-Auth') {
    Object.assign(r.criticalAuth, { dataVlanId: null, voiceVlanId: null });
    Object.assign(r, { failedAuthVlanId: null, reAuthenticationInterval: null });
  }
  if (next.increaseAccessSpeed && next.accessPolicyType !== 'Hybrid authentication') throw badRequest("'increaseAccessSpeed' only applies when 'accessPolicyType' is 'Hybrid authentication'");
  return next;
}

// Hands new servers their IDs once the whole body has passed.
function commitPolicy(store, p, next) {
  for (const s of [...next.radiusServers, ...next.radiusAccountingServers]) s.serverId ??= String(++store.servers);
  Object.assign(p, next);
  return p;
}

function createPolicy(ctx) {
  const net = switchNet(ctx);
  const store = policiesOf(net);
  limit([...store.list, null], MAX_POLICIES, 'Access policies');
  const next = nextPolicy(net, policyDefaults(), ctx.body);
  const p = commitPolicy(store, { number: String(store.created + 1) }, next);
  store.created++;
  store.list.push(p);
  return policyJson(p, portCounts(net));
}

function updatePolicy(ctx) {
  const { net, p } = policyOf(ctx);
  commitPolicy(policiesOf(net), p, nextPolicy(net, p, ctx.body));
  return policyJson(p, portCounts(net));
}

function deletePolicy(ctx) {
  const { net, p } = policyOf(ctx);
  const used = portCounts(net).get(p.number);
  if (used) throw badRequest(`Access policy '${p.number}' is used by ${used} switch port${used === 1 ? '' : 's'}`);
  const list = policiesOf(net).list;
  list.splice(list.indexOf(p), 1);
}

// ── QoS rules ──

const qosOf = (net) => stored(net, 'switchQosRules', () => ({ created: 0, list: [] }));
const PORT_FIELDS = ['srcPort', 'srcPortRange', 'dstPort', 'dstPortRange'];
const qosJson = (q) => ({ id: q.id, vlan: q.vlan, protocol: q.protocol, srcPort: q.srcPort, srcPortRange: q.srcPortRange, dstPort: q.dstPort, dstPortRange: q.dstPortRange, dscp: q.dscp });

function qosRuleOf(ctx) {
  const net = switchNet(ctx);
  const q = qosOf(net).list.find((x) => x.id === ctx.params.qosRuleId);
  if (!q) throw notFound('QoS rule');
  return { net, q };
}

function isPortRange(v) {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(v);
  return !!m && isPort(m[1]) && isPort(m[2]) && Number(m[1]) <= Number(m[2]);
}

// A port replaces a range on the same side and the other way round. Ports
// only go with TCP or UDP, and switching to ANY drops them.
function nextQos(q, b) {
  const next = { ...q };
  if ('vlan' in b) next.vlan = b.vlan;
  if (b.protocol != null) next.protocol = b.protocol;
  if (b.dscp != null) next.dscp = b.dscp;
  for (const side of ['src', 'dst']) {
    const [port, range] = [`${side}Port`, `${side}PortRange`];
    if (b[port] != null && b[range] != null) throw badRequest(`Give '${port}' or '${range}', not both`);
    if (b[port] != null) Object.assign(next, { [port]: b[port], [range]: null });
    if (b[range] != null) Object.assign(next, { [port]: null, [range]: b[range] });
  }
  if (next.protocol === 'ANY') {
    const given = PORT_FIELDS.find((k) => b[k] != null);
    if (given) throw badRequest(`'${given}' only applies when 'protocol' is 'TCP' or 'UDP'`);
    for (const k of PORT_FIELDS) next[k] = null;
  }
  checkVlan(next.vlan, 'vlan');
  for (const k of ['srcPort', 'dstPort']) inRange(next[k], 1, 65535, k);
  for (const k of ['srcPortRange', 'dstPortRange']) if (next[k] != null && !isPortRange(next[k])) throw badRequest(`'${k}' must be a range of ports such as 70-80`);
  inRange(next.dscp, -1, 63, 'dscp');
  return next;
}

function createQos(ctx) {
  const net = switchNet(ctx);
  const store = qosOf(net);
  limit([...store.list, null], MAX_QOS_RULES, 'QoS rules');
  const next = nextQos({ vlan: null, protocol: 'ANY', srcPort: null, srcPortRange: null, dstPort: null, dstPortRange: null, dscp: 0 }, ctx.body);
  const q = { ...next, id: newId(ctx, store, 'switchQosRule', net.id) };
  store.list.push(q);
  return qosJson(q);
}

function updateQosOrder(ctx) {
  const store = qosOf(switchNet(ctx));
  const ids = ctx.body.ruleIds;
  const byId = new Map(store.list.map((q) => [q.id, q]));
  if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) throw badRequest("'ruleIds' must list every QoS rule in this network exactly once");
  store.list = ids.map((id) => byId.get(id));
  return { ruleIds: [...ids] };
}

// ── DSCP to CoS mappings ──

const dscpOf = (net) => stored(net, 'switchDscpToCos', () => ({ mappings: structuredClone(DSCP_DEFAULTS) }));

function updateDscp(ctx) {
  const net = switchNet(ctx);
  const given = limit(ctx.body.mappings, MAX_MAPPINGS, 'DSCP to CoS mappings');
  const seen = new Set();
  const mappings = given.map((m, i) => {
    inRange(m.dscp, 0, 63, `mappings[${i}].dscp`);
    inRange(m.cos, 0, 5, `mappings[${i}].cos`);
    if (seen.has(m.dscp)) throw badRequest(`DSCP ${m.dscp} is mapped more than once`);
    seen.add(m.dscp);
    return { dscp: m.dscp, cos: m.cos, title: m.title ?? '' };
  });
  // An empty list puts the defaults back.
  dscpOf(net).mappings = mappings.length ? mappings : structuredClone(DSCP_DEFAULTS);
  return structuredClone(dscpOf(net));
}

export default [
  { op: 'getNetworkSwitchAccessControlLists', path: `${NET}/accessControlLists`, handler: (ctx) => aclJson(switchNet(ctx)) },
  { op: 'updateNetworkSwitchAccessControlLists', method: 'PUT', path: `${NET}/accessControlLists`, handler: updateAcl },
  {
    op: 'getNetworkSwitchAccessPolicies',
    path: POLICIES,
    // Only policies that authenticate against the network's own RADIUS servers.
    handler: (ctx) => {
      const net = switchNet(ctx);
      const counts = portCounts(net);
      return policiesOf(net).list.filter((p) => p.radiusServers.length).map((p) => policyJson(p, counts));
    },
  },
  { op: 'createNetworkSwitchAccessPolicy', method: 'POST', path: POLICIES, handler: createPolicy },
  {
    op: 'getNetworkSwitchAccessPolicy',
    path: POLICY,
    sample: MISSING,
    handler: (ctx) => {
      const { net, p } = policyOf(ctx);
      return policyJson(p, portCounts(net));
    },
  },
  { op: 'updateNetworkSwitchAccessPolicy', method: 'PUT', path: POLICY, handler: updatePolicy },
  { op: 'deleteNetworkSwitchAccessPolicy', method: 'DELETE', path: POLICY, handler: deletePolicy },
  { op: 'getNetworkSwitchQosRules', path: QOS, handler: (ctx) => qosOf(switchNet(ctx)).list.map(qosJson) },
  { op: 'createNetworkSwitchQosRule', method: 'POST', path: QOS, handler: createQos },
  { op: 'getNetworkSwitchQosRulesOrder', path: `${QOS}/order`, handler: (ctx) => ({ ruleIds: qosOf(switchNet(ctx)).list.map((q) => q.id) }) },
  { op: 'updateNetworkSwitchQosRulesOrder', method: 'PUT', path: `${QOS}/order`, handler: updateQosOrder },
  { op: 'getNetworkSwitchQosRule', path: QOS_RULE, sample: MISSING, handler: (ctx) => qosJson(qosRuleOf(ctx).q) },
  {
    op: 'updateNetworkSwitchQosRule',
    method: 'PUT',
    path: QOS_RULE,
    handler: (ctx) => {
      const { q } = qosRuleOf(ctx);
      return qosJson(Object.assign(q, nextQos(q, ctx.body)));
    },
  },
  {
    op: 'deleteNetworkSwitchQosRule',
    method: 'DELETE',
    path: QOS_RULE,
    handler: (ctx) => {
      const { net, q } = qosRuleOf(ctx);
      const list = qosOf(net).list;
      list.splice(list.indexOf(q), 1);
    },
  },
  { op: 'getNetworkSwitchDscpToCosMappings', path: `${NET}/dscpToCosMappings`, handler: (ctx) => structuredClone(dscpOf(switchNet(ctx))) },
  { op: 'updateNetworkSwitchDscpToCosMappings', method: 'PUT', path: `${NET}/dscpToCosMappings`, handler: updateDscp },
];
