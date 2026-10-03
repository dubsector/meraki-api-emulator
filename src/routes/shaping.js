// MX traffic shaping and SD-WAN: global and per-uplink bandwidth limits,
// shaping rules, uplink selection, custom performance classes, VPN exclusions
// and internet policies. Each is a network setting built from its default on
// first read. Writes change the settings, not the simulated traffic.

import { L7_CATEGORIES } from '../catalog.js';
import { stored } from '../config.js';
import { arrayParam, badRequest, notFound, paginate } from '../http.js';
import { isAddress, isHostname, isPort } from '../validate.js';
import { collection, limit, mxNet, mxNets, netOf, orgOf } from './common.js';

const BASE = '/networks/{networkId}/appliance/trafficShaping';
const CLASSES = `${BASE}/customPerformanceClasses`;
const CLASS = `${CLASSES}/{customPerformanceClassId}`;
const MAX_RULES = 8;
const DEFAULT_RULES = 4;
const MAX_CLASSES = 100;
const MAX_ITEMS = 100;
const RULE_SETTINGS = ['network default', 'ignore', 'custom'];
const PRIORITIES = ['low', 'normal', 'high'];
const WAN_UPLINKS = ['wan1', 'wan2'];
const UPLINKS = ['wan1', 'wan2', 'bestForVoIP', 'loadBalancing', 'defaultUplink', 'cellular'];
const PORTS = /^(any|\d{1,5}(-\d{1,5})?)$/;
// Default uplink limits in Kbps, [up, down], by kind of WAN link.
const ISP_LIMITS = { fiber: [1000000, 1000000], cable: [50000, 500000], dsl: [20000, 100000] };
const CELLULAR_LIMIT = 51200;
const CLASS_DEFAULTS = { maxLatency: 100, maxJitter: 100, maxLossPercentage: 5 };
const CLASS_RANGES = { maxLatency: [1, 3000], maxJitter: [1, 3000], maxLossPercentage: [0, 100] };
const MISSING = { customPerformanceClassId: '578149602163689000', status: 404 };

const DSCP = [
  [0, 'Best Effort (BE), Default'],
  [8, 'CS1 - Scavenger, Low Priority Data'],
  [10, 'AF11 - High Throughput, Latency Insensitive, Low Drop'],
  [12, 'AF12 - High Throughput, Latency Insensitive, Medium Drop'],
  [14, 'AF13 - High Throughput, Latency Insensitive, High Drop'],
  [16, 'CS2 - Network Operations, Administration and Management'],
  [18, 'AF21 - Low Latency Data, Low Drop'],
  [20, 'AF22 - Low Latency Data, Medium Drop'],
  [22, 'AF23 - Low Latency Data, High Drop'],
  [24, 'CS3 - Broadcast Video'],
  [26, 'AF31 - Multimedia Streaming, Low Drop'],
  [28, 'AF32 - Multimedia Streaming, Medium Drop'],
  [30, 'AF33 - Multimedia Streaming, High Drop'],
  [32, 'CS4 - Real-Time Interactive'],
  [34, 'AF41 - Multimedia Conferencing, Low Drop'],
  [36, 'AF42 - Multimedia Conferencing, Medium Drop'],
  [38, 'AF43 - Multimedia Conferencing, High Drop'],
  [40, 'CS5 - Signaling'],
  [46, 'EF - Expedited Forwarding, Voice'],
  [48, 'CS6 - Network Control'],
  [56, 'CS7 - Reserved'],
].map(([dscpTagValue, description]) => ({ dscpTagValue, description }));

// The apps VPN exclusion takes, by the spec's names. The IDs are stand-ins
// except Office 365 Sharepoint, which matches the spec's example.
const MAJOR_APPS = ['Office 365 Suite', 'Office 365 Sharepoint', 'AWS', 'Box', 'Oracle', 'SAP', 'Salesforce', 'Skype & Teams', 'Slack', 'Webex', 'Webex Calling', 'Webex Meetings', 'Zoom'].map((name, i) => ({ id: `meraki:vpnExclusion/application/${i + 1}`, name }));
const L7_APPS = new Map(L7_CATEGORIES.flatMap((c) => c.applications.map((a) => [a.id, a])));

// ── Settings, built on first read ──

const globalOf = (net) => stored(net, 'applianceShaping', () => ({ globalBandwidthLimits: { limitUp: 0, limitDown: 0 } }));
const rulesOf = (net) => stored(net, 'applianceShapingRules', () => ({ defaultRulesEnabled: true, rules: [] }));
const classesOf = (net) => stored(net, 'applianceShapingClasses', () => ({ created: 0, list: [] }));
const exclusionsOf = (net) => stored(net, 'applianceVpnExclusions', () => ({ custom: [], majorApplications: [] }));
// Matches the sim: wan1 carries traffic and wan2 stands by.
const selectionOf = (net) =>
  stored(net, 'applianceUplinkSelection', () => ({
    activeActiveAutoVpnEnabled: false,
    defaultUplink: 'wan1',
    loadBalancingEnabled: false,
    failoverAndFailback: { immediate: { enabled: false } },
    wanTrafficUplinkPreferences: [],
    vpnTrafficUplinkPreferences: [],
  }));

// An unused WAN port has no limit.
const bandwidthOf = (net) =>
  stored(net, 'applianceUplinkBandwidth', () => {
    const wan = (i) => {
      const [limitUp, limitDown] = ISP_LIMITS[net.mx?.uplinks[i]?.isp] ?? [null, null];
      return { limitUp, limitDown };
    };
    return { bandwidthLimits: { wan1: wan(0), wan2: wan(1), cellular: { limitUp: CELLULAR_LIMIT, limitDown: CELLULAR_LIMIT } } };
  });

function checkLimits(limits, at, min) {
  for (const k of ['limitUp', 'limitDown']) {
    if (limits?.[k] != null && limits[k] < min) throw badRequest(`'${at}.${k}' must be at least ${min}`);
  }
}

// ── Shaping rules ──

function ipRange(v) {
  const [addr, port, ...rest] = v.split(':');
  return !rest.length && isAddress(addr) && (port === undefined || isPort(port));
}

// A rule definition, shared with SSID shaping. Application ones take an object
// with an ID from the L7 catalog and come back with its name.
export function shapingDefinition(d, at) {
  const { type, value } = d;
  if (type === 'application' || type === 'applicationCategory') {
    const found = type === 'application' ? L7_APPS.get(value?.id) : L7_CATEGORIES.find((c) => c.id === value?.id);
    if (!found) throw badRequest(`'${at}.value' must be an object with the ID of an ${type === 'application' ? 'application' : 'application category'} from trafficShaping/applicationCategories`);
    return { type, value: { id: found.id, name: found.name } };
  }
  if (typeof value !== 'string') throw badRequest(`'${at}.value' must be a string`);
  const checks = {
    host: [isHostname(value), 'a hostname'],
    port: [isPort(value), 'a port from 1 to 65535'],
    ipRange: [ipRange(value), 'an IP address or CIDR, with an optional port'],
    localNet: [isAddress(value), 'an IP address or CIDR'],
  };
  const [ok, what] = checks[type] ?? [true];
  if (!ok) throw badRequest(`'${at}.value' must be ${what}`);
  return { type, value };
}

function shapingRule(r, i) {
  const at = `rules[${i}]`;
  if (!r.definitions.length) throw badRequest(`'${at}.definitions' needs at least one definition`);
  const definitions = r.definitions.map((d, j) => shapingDefinition(d, `${at}.definitions[${j}]`));
  const limits = r.perClientBandwidthLimits ?? {};
  const settings = limits.settings ?? 'network default';
  if (!RULE_SETTINGS.includes(settings)) throw badRequest(`'${at}.perClientBandwidthLimits.settings' must be one of: ${RULE_SETTINGS.join(', ')}`);
  checkLimits(limits.bandwidthLimits, `${at}.perClientBandwidthLimits.bandwidthLimits`, 0);
  if (r.dscpTagValue != null && !DSCP.some((o) => o.dscpTagValue === r.dscpTagValue)) throw badRequest(`'${at}.dscpTagValue' must be one of the values trafficShaping/dscpTaggingOptions lists`);
  const priority = r.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) throw badRequest(`'${at}.priority' must be one of: ${PRIORITIES.join(', ')}`);
  return {
    definitions,
    perClientBandwidthLimits: settings === 'custom' ? { settings, bandwidthLimits: { limitUp: limits.bandwidthLimits?.limitUp ?? null, limitDown: limits.bandwidthLimits?.limitDown ?? null } } : { settings },
    dscpTagValue: r.dscpTagValue ?? null,
    priority,
  };
}

// The four default rules count against the limit of eight.
function updateRules(ctx) {
  const set = rulesOf(mxNet(ctx));
  const { rules, defaultRulesEnabled } = ctx.body;
  const next = { defaultRulesEnabled: defaultRulesEnabled ?? set.defaultRulesEnabled, rules: rules === undefined ? set.rules : (rules ?? []).map(shapingRule) };
  if (next.rules.length + (next.defaultRulesEnabled ? DEFAULT_RULES : 0) > MAX_RULES) throw badRequest(`A network can have at most ${MAX_RULES} traffic shaping rules, and the default rules count as ${DEFAULT_RULES}`);
  return structuredClone(Object.assign(set, next));
}

// ── Custom performance classes ──

function checkClass(b) {
  for (const [k, [min, max]] of Object.entries(CLASS_RANGES)) {
    if (b[k] != null && (b[k] < min || b[k] > max)) throw badRequest(`'${k}' must be between ${min} and ${max}`);
  }
}

function applyClass(c, b) {
  for (const k of ['name', ...Object.keys(CLASS_DEFAULTS)]) if (b[k] != null) c[k] = b[k];
}

const classJson = (c) => ({ name: c.name, customPerformanceClassId: c.id, maxLatency: c.maxLatency, maxJitter: c.maxJitter, maxLossPercentage: c.maxLossPercentage });

const usesClass = (p, id) => p.performanceClass?.type === 'custom' && p.performanceClass.customPerformanceClassId === id;

function classInUse(cls, net) {
  const s = selectionOf(net);
  if ([...s.wanTrafficUplinkPreferences, ...s.vpnTrafficUplinkPreferences].some((p) => usesClass(p, cls.id))) return `Custom performance class ${cls.id} is used by an uplink preference rule`;
}

const classes = collection({
  ops: {
    list: 'getNetworkApplianceTrafficShapingCustomPerformanceClasses',
    create: 'createNetworkApplianceTrafficShapingCustomPerformanceClass',
    get: 'getNetworkApplianceTrafficShapingCustomPerformanceClass',
    update: 'updateNetworkApplianceTrafficShapingCustomPerformanceClass',
    delete: 'deleteNetworkApplianceTrafficShapingCustomPerformanceClass',
  },
  path: CLASSES,
  param: 'customPerformanceClassId',
  parent: mxNet,
  store: classesOf,
  what: 'custom performance class',
  plural: 'custom performance classes',
  kind: 'performanceClass',
  max: MAX_CLASSES,
  required: ['name'],
  check: (ctx, net, b) => checkClass(b),
  blank: () => ({ name: null, ...CLASS_DEFAULTS }),
  apply: applyClass,
  json: classJson,
  inUse: classInUse,
  missing: MISSING,
});

// ── Uplink preferences ──

// Only template networks take VLANs, hosts and network IDs; no network here is one.
function endpoint(e, at, protocol, fqdn) {
  for (const k of ['vlan', 'host', 'network']) if (e[k] != null) throw badRequest(`'${at}.${k}' is only available under a config template`);
  const port = String(e.port ?? 'any');
  if (!PORTS.test(port) || port.split('-').some((p) => p !== 'any' && Number(p) > 65535)) throw badRequest(`'${at}.port' must be "any", a port or a range like "1-1024"`);
  if (!['any', '0'].includes(port) && !['tcp', 'udp'].includes(protocol)) throw badRequest(`'${at}.port' needs protocol tcp or udp`);
  const out = { port };
  if (fqdn && e.fqdn != null) {
    if (e.cidr != null) throw badRequest(`'${at}.fqdn' cannot be used with 'cidr'`);
    if (!isHostname(e.fqdn)) throw badRequest(`'${at}.fqdn' must be a hostname`);
    out.fqdn = e.fqdn;
  } else {
    const cidr = e.cidr ?? 'any';
    if (cidr !== 'any' && !isAddress(cidr)) throw badRequest(`'${at}.cidr' must be "any", an IP address or a CIDR`);
    out.cidr = cidr;
  }
  if (e.applications != null) {
    out.applications = e.applications.map((a, i) => {
      if (!a.id) throw badRequest(`'${at}.applications[${i}].id' is required`);
      return { id: a.id, name: a.name ?? '', type: a.type ?? 'major' };
    });
  }
  return out;
}

function trafficFilter(f, at) {
  const v = f.value;
  if (f.type === 'application' || f.type === 'applicationCategory') {
    if (v.id != null) {
      const found = f.type === 'application' ? L7_APPS.get(v.id) : L7_CATEGORIES.find((c) => c.id === v.id);
      if (!found) throw badRequest(`'${at}.value.id' must be an ${f.type === 'application' ? 'application' : 'application category'} ID from trafficShaping/applicationCategories`);
      return { type: f.type, value: { id: v.id } };
    }
  }
  const protocol = v.protocol ?? 'any';
  const value = { protocol, source: endpoint(v.source ?? {}, `${at}.value.source`, protocol, false), destination: endpoint(v.destination ?? {}, `${at}.value.destination`, protocol, true) };
  if (f.type !== 'custom' && !value.destination.applications?.length) throw badRequest(`'${at}.value' needs an application ID, or 'destination.applications' for a ${f.type} filter`);
  return { type: f.type, value };
}

function performanceClass(net, pc, at) {
  if (pc.type === 'builtin') {
    if (pc.builtinPerformanceClassName == null) throw badRequest(`'${at}.builtinPerformanceClassName' is required for a builtin class`);
    return { type: 'builtin', builtinPerformanceClassName: pc.builtinPerformanceClassName };
  }
  if (pc.type === 'custom') {
    const id = String(pc.customPerformanceClassId ?? '');
    if (!classesOf(net).list.some((c) => c.id === id)) throw badRequest(`'${at}.customPerformanceClassId' must be a custom performance class in this network`);
    return { type: 'custom', customPerformanceClassId: id };
  }
  throw badRequest(`'${at}.type' is required`);
}

// Checks one rule and returns it as stored. The API has no way to add VRFs,
// so only the default VRF is taken, whether or not VRFs are on.
function preference(net, p, at, uplinks) {
  if (!uplinks.includes(p.preferredUplink)) throw badRequest(`'${at}.preferredUplink' must be one of: ${uplinks.join(', ')}`);
  if (!p.trafficFilters.length) throw badRequest(`'${at}.trafficFilters' needs at least one filter`);
  if (p.vrf != null && String(p.vrf.id) !== '0') throw badRequest(`'${at}.vrf.id' must be 0, ${net.org.applianceVrfs?.enabled ? 'the only VRF in this organization' : 'VRFs are not enabled for this organization'}`);
  const out = { trafficFilters: limit(p.trafficFilters, MAX_ITEMS, 'Traffic filters').map((f, i) => trafficFilter(f, `${at}.trafficFilters[${i}]`)), preferredUplink: p.preferredUplink };
  if (p.failOverCriterion != null) out.failOverCriterion = p.failOverCriterion;
  if (p.performanceClass != null) out.performanceClass = performanceClass(net, p.performanceClass, `${at}.performanceClass`);
  return out;
}

const preferences = (net, list, name, uplinks) => limit(list ?? [], MAX_ITEMS, 'Uplink preference rules').map((p, i) => preference(net, p, `${name}[${i}]`, uplinks));

// WAN rules are the same list SD-WAN internet policies write, shown here
// with the fields this endpoint has.
function selectionJson(net) {
  const s = structuredClone(selectionOf(net));
  s.wanTrafficUplinkPreferences = s.wanTrafficUplinkPreferences.map(({ trafficFilters, preferredUplink }) => ({ trafficFilters, preferredUplink }));
  return s;
}

function updateSelection(ctx) {
  const net = mxNet(ctx);
  const s = selectionOf(net);
  const b = ctx.body;
  if (b.defaultUplink != null && !WAN_UPLINKS.includes(b.defaultUplink)) throw badRequest(`'defaultUplink' must be one of: ${WAN_UPLINKS.join(', ')}`);
  const wan = b.wanTrafficUplinkPreferences === undefined ? null : preferences(net, b.wanTrafficUplinkPreferences, 'wanTrafficUplinkPreferences', WAN_UPLINKS);
  const vpn = b.vpnTrafficUplinkPreferences === undefined ? null : preferences(net, b.vpnTrafficUplinkPreferences, 'vpnTrafficUplinkPreferences', UPLINKS);
  for (const k of ['activeActiveAutoVpnEnabled', 'defaultUplink', 'loadBalancingEnabled']) if (b[k] != null) s[k] = b[k];
  if (b.failoverAndFailback?.immediate) s.failoverAndFailback.immediate.enabled = b.failoverAndFailback.immediate.enabled;
  if (wan) s.wanTrafficUplinkPreferences = wan;
  if (vpn) s.vpnTrafficUplinkPreferences = vpn;
  return selectionJson(net);
}

function updateInternetPolicies(ctx) {
  const net = mxNet(ctx);
  const s = selectionOf(net);
  const list = ctx.body.wanTrafficUplinkPreferences;
  if (list !== undefined) s.wanTrafficUplinkPreferences = preferences(net, list, 'wanTrafficUplinkPreferences', UPLINKS);
  return { wanTrafficUplinkPreferences: structuredClone(s.wanTrafficUplinkPreferences) };
}

// ── VPN exclusions ──

const exclusionsJson = (net) => ({ networkId: net.id, networkName: net.name, ...structuredClone(exclusionsOf(net)) });

function exclusion(r, at) {
  if (r.protocol === 'dns') {
    if (!r.destination || !isHostname(r.destination)) throw badRequest(`'${at}.destination' must be a hostname for protocol dns`);
  } else if (r.destination != null && r.destination !== 'any' && !isAddress(r.destination)) {
    throw badRequest(`'${at}.destination' must be an IPv4 address or CIDR`);
  }
  const port = String(r.port ?? 'any');
  if (!PORTS.test(port)) throw badRequest(`'${at}.port' must be "any", a port or a range like "1-1024"`);
  return { protocol: r.protocol, destination: r.destination ?? 'any', port };
}

function majorApp(a, at) {
  const found = MAJOR_APPS.find((m) => m.id === a.id);
  if (!found) throw badRequest(`'${at}.id' must be one of: ${MAJOR_APPS.map((m) => m.id).join(', ')}`);
  if (a.name != null && a.name !== found.name) throw badRequest(`'${at}.name' for ${found.id} is '${found.name}'`);
  return { ...found };
}

function updateExclusions(ctx) {
  const net = mxNet(ctx);
  const set = exclusionsOf(net);
  const { custom, majorApplications } = ctx.body;
  const next = {};
  if (custom !== undefined) next.custom = limit(custom ?? [], MAX_ITEMS, 'Custom VPN exclusion rules').map((r, i) => exclusion(r, `custom[${i}]`));
  if (majorApplications !== undefined) next.majorApplications = (majorApplications ?? []).map((a, i) => majorApp(a, `majorApplications[${i}]`));
  Object.assign(set, next);
  return exclusionsJson(net);
}

function exclusionsByNetwork(ctx) {
  const nets = mxNets(orgOf(ctx), arrayParam(ctx.query, 'networkIds'));
  return { items: paginate(ctx, nets, (n) => n.id, { def: 50, max: 1000 }).map(exclusionsJson) };
}

export default [
  { op: 'getNetworkApplianceTrafficShaping', path: BASE, handler: (ctx) => structuredClone(globalOf(mxNet(ctx))) },
  {
    op: 'updateNetworkApplianceTrafficShaping',
    method: 'PUT',
    path: BASE,
    handler: (ctx) => {
      const set = globalOf(mxNet(ctx));
      const given = ctx.body.globalBandwidthLimits ?? {};
      checkLimits(given, 'globalBandwidthLimits', 0);
      for (const k of ['limitUp', 'limitDown']) if (given[k] != null) set.globalBandwidthLimits[k] = given[k];
      return structuredClone(set);
    },
  },
  { op: 'getNetworkApplianceTrafficShapingRules', path: `${BASE}/rules`, handler: (ctx) => structuredClone(rulesOf(mxNet(ctx))) },
  { op: 'updateNetworkApplianceTrafficShapingRules', method: 'PUT', path: `${BASE}/rules`, handler: updateRules },
  { op: 'getNetworkApplianceTrafficShapingUplinkBandwidth', path: `${BASE}/uplinkBandwidth`, handler: (ctx) => structuredClone(bandwidthOf(mxNet(ctx))) },
  {
    op: 'updateNetworkApplianceTrafficShapingUplinkBandwidth',
    method: 'PUT',
    path: `${BASE}/uplinkBandwidth`,
    handler: (ctx) => {
      const set = bandwidthOf(mxNet(ctx));
      const given = ctx.body.bandwidthLimits ?? {};
      for (const [uplink, limits] of Object.entries(given)) checkLimits(limits, `bandwidthLimits.${uplink}`, 1);
      for (const [uplink, limits] of Object.entries(given)) {
        for (const k of ['limitUp', 'limitDown']) if (limits && limits[k] !== undefined) set.bandwidthLimits[uplink][k] = limits[k];
      }
      return structuredClone(set);
    },
  },
  { op: 'getNetworkApplianceTrafficShapingUplinkSelection', path: `${BASE}/uplinkSelection`, handler: (ctx) => selectionJson(mxNet(ctx)) },
  { op: 'updateNetworkApplianceTrafficShapingUplinkSelection', method: 'PUT', path: `${BASE}/uplinkSelection`, handler: updateSelection },
  ...classes.routes,
  { op: 'updateNetworkApplianceTrafficShapingVpnExclusions', method: 'PUT', path: `${BASE}/vpnExclusions`, handler: updateExclusions },
  { op: 'getOrganizationApplianceTrafficShapingVpnExclusionsByNetwork', path: '/organizations/{organizationId}/appliance/trafficShaping/vpnExclusions/byNetwork', handler: exclusionsByNetwork },
  { op: 'updateNetworkApplianceSdwanInternetPolicies', method: 'PUT', path: '/networks/{networkId}/appliance/sdwan/internetPolicies', handler: updateInternetPolicies },
  {
    op: 'getNetworkTrafficShapingApplicationCategories',
    path: '/networks/{networkId}/trafficShaping/applicationCategories',
    handler: (ctx) => {
      mxNet(ctx);
      return { applicationCategories: structuredClone(L7_CATEGORIES) };
    },
  },
  {
    op: 'getNetworkTrafficShapingDscpTaggingOptions',
    path: '/networks/{networkId}/trafficShaping/dscpTaggingOptions',
    handler: (ctx) => {
      netOf(ctx);
      return structuredClone(DSCP);
    },
  },
];
