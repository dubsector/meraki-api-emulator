// NetFlow reporting and traffic analysis settings. Stored only: nothing is
// exported, and the traffic analysis mode doesn't change the traffic routes.

import { stored } from '../config.js';
import { badRequest } from '../http.js';
import { isHostname, isPort, parseCidr, parseIp } from '../validate.js';
import { limit, mxNet, netOf } from './common.js';

const MAX_PIE_ITEMS = 100;

// ── NetFlow ──

const netflowOf = (net) => stored(net, 'applianceNetflow', () => ({ reportingEnabled: false, collectorIp: null, collectorPort: null, etaEnabled: false, etaDstPort: null }));

const port = (v, name) => {
  if (v != null && !(Number.isInteger(v) && v >= 1 && v <= 65535)) throw badRequest(`'${name}' must be a port from 1 to 65535`);
};

function updateNetflow(ctx) {
  const net = mxNet(ctx);
  const b = ctx.body;
  const next = { ...netflowOf(net) };
  for (const k of Object.keys(next)) if (b[k] !== undefined) next[k] = b[k];
  next.reportingEnabled = !!next.reportingEnabled;
  next.etaEnabled = !!next.etaEnabled;
  if (next.collectorIp != null && (typeof next.collectorIp !== 'string' || parseIp(next.collectorIp) == null)) throw badRequest("'collectorIp' must be an IPv4 address");
  port(next.collectorPort, 'collectorPort');
  port(next.etaDstPort, 'etaDstPort');
  if (next.reportingEnabled && (next.collectorIp == null || next.collectorPort == null)) throw badRequest("'collectorIp' and 'collectorPort' are required when NetFlow reporting is enabled");
  if (next.etaEnabled && !next.reportingEnabled) throw badRequest('Encrypted Traffic Analytics needs NetFlow reporting enabled');
  if (next.etaEnabled && next.etaDstPort == null) throw badRequest("'etaDstPort' is required when Encrypted Traffic Analytics is enabled");
  return Object.assign(netflowOf(net), next);
}

// ── Traffic analysis ──

// Detailed by default, since the traffic routes list destination hostnames.
const analysisOf = (net) => stored(net, 'trafficAnalysis', () => ({ mode: 'detailed', customPieChartItems: [] }));

// An IP or CIDR range, optionally with a port: 10.1.0.0/16:80.
function isIpRange(v) {
  const m = /^([\d./]+?)(?::(\d{1,5}))?$/.exec(v);
  return !!m && (parseIp(m[1]) != null || parseCidr(m[1]) != null) && (m[2] == null || isPort(m[2]));
}

const VALUES = {
  host: [isHostname, 'a hostname such as example.com'],
  port: [(v) => isPort(v), 'a port from 1 to 65535'],
  ipRange: [isIpRange, 'an IP address or CIDR range, optionally with a port, such as 10.1.0.0/16:80'],
};

function checkPieItems(items) {
  limit(items, MAX_PIE_ITEMS, 'Custom pie chart items');
  return items.map((x, i) => {
    const at = `customPieChartItems[${i}]`;
    for (const k of ['name', 'type', 'value']) if (typeof x[k] !== 'string' || !x[k].trim()) throw badRequest(`'${at}.${k}' is required`);
    const [ok, what] = VALUES[x.type] ?? [];
    if (!ok) throw badRequest(`'${at}.type' must be one of host, port, ipRange`);
    if (!ok(x.value)) throw badRequest(`'${at}.value' must be ${what} for type ${x.type}`);
    return { name: x.name, type: x.type, value: x.value };
  });
}

function updateAnalysis(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  const items = b.customPieChartItems != null ? checkPieItems(b.customPieChartItems) : null;
  const s = analysisOf(net);
  if (b.mode != null) s.mode = b.mode;
  if (items) s.customPieChartItems = items;
  return s;
}

export default [
  { op: 'getNetworkNetflow', path: '/networks/{networkId}/netflow', handler: (ctx) => netflowOf(mxNet(ctx)) },
  { op: 'updateNetworkNetflow', method: 'PUT', path: '/networks/{networkId}/netflow', handler: updateNetflow },
  { op: 'getNetworkTrafficAnalysis', path: '/networks/{networkId}/trafficAnalysis', handler: (ctx) => analysisOf(netOf(ctx)) },
  { op: 'updateNetworkTrafficAnalysis', method: 'PUT', path: '/networks/{networkId}/trafficAnalysis', handler: updateAnalysis },
];
