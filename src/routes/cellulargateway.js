// MG cellular gateway LAN, port forwarding and uplink settings, and the org
// uplink statuses. LAN and port forwarding rules belong to the device; the
// uplink bandwidth limits are a network setting.

import { configOf } from '../config.js';
import { arrayParam, badRequest, paginate } from '../http.js';
import { isGateway, signalAt, signalType, uplinkState } from '../sim/cellular.js';
import { lastReportedAt } from '../sim/outages.js';
import { iso } from '../time.js';
import { ipInCidr, isAddress, isPort, parseIp } from '../validate.js';
import { bySerial, devOf, netOf, orgOf, requireProduct } from './common.js';

// Every MG answers on the same LAN out of the box; the API can't change it.
const LAN_IP = '192.168.0.33';
const LAN_SUBNET = '192.168.0.32/27';
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const MAX_RULES = 100;

function gatewayOf(ctx) {
  const dev = devOf(ctx);
  if (!isGateway(dev)) throw badRequest('This endpoint is only supported for MG cellular gateways');
  return dev;
}

const lanOf = (dev) => dev.cellularGatewayLan ?? { fixedIpAssignments: [], reservedIpRanges: [] };

const lanJson = (dev) => {
  const lan = lanOf(dev);
  return { deviceName: dev.name, deviceLanIp: LAN_IP, deviceSubnet: LAN_SUBNET, fixedIpAssignments: lan.fixedIpAssignments.map((f) => ({ ...f })), reservedIpRanges: lan.reservedIpRanges.map((r) => ({ ...r })) };
};

// A host address on the MG's LAN, other than its own.
function lanHost(ip, at) {
  if (typeof ip !== 'string' || parseIp(ip) == null || !ipInCidr(ip, LAN_SUBNET)) throw badRequest(`'${at}' must be an address in the MG's LAN ${LAN_SUBNET}`);
  const host = parseIp(ip) % 32;
  if (host === 0 || host === 31) throw badRequest(`'${at}' can't be the LAN's network or broadcast address`);
  if (ip === LAN_IP) throw badRequest(`'${at}' can't be the MG's own address ${LAN_IP}`);
  return ip;
}

// Lists the body gives replace the stored ones whole.
function updateLan(ctx) {
  const dev = gatewayOf(ctx);
  const b = ctx.body;
  const cur = lanOf(dev);
  let fixed = cur.fixedIpAssignments;
  let ranges = cur.reservedIpRanges;
  if (b.fixedIpAssignments != null) {
    if (b.fixedIpAssignments.length > MAX_RULES) throw badRequest(`'fixedIpAssignments' can list at most ${MAX_RULES} assignments`);
    const ips = new Set();
    const macs = new Set();
    fixed = b.fixedIpAssignments.map((f, i) => {
      const ip = lanHost(f.ip, `fixedIpAssignments[${i}].ip`);
      if (typeof f.mac !== 'string' || !MAC_RE.test(f.mac)) throw badRequest(`'fixedIpAssignments[${i}].mac' must be a MAC address like 00:11:22:33:44:55`);
      const mac = f.mac.toLowerCase();
      if (ips.has(ip)) throw badRequest(`${ip} is assigned twice`);
      if (macs.has(mac)) throw badRequest(`${mac} is assigned twice`);
      ips.add(ip);
      macs.add(mac);
      return { name: f.name ?? '', ip, mac };
    });
  }
  if (b.reservedIpRanges != null) {
    if (b.reservedIpRanges.length > MAX_RULES) throw badRequest(`'reservedIpRanges' can list at most ${MAX_RULES} ranges`);
    ranges = b.reservedIpRanges.map((r, i) => {
      const start = lanHost(r.start, `reservedIpRanges[${i}].start`);
      const end = lanHost(r.end, `reservedIpRanges[${i}].end`);
      if (parseIp(start) > parseIp(end)) throw badRequest(`'reservedIpRanges[${i}]' must start before it ends`);
      if (typeof r.comment !== 'string') throw badRequest(`'reservedIpRanges[${i}].comment' is required`);
      return { start, end, comment: r.comment };
    });
  }
  for (const f of fixed) {
    const n = parseIp(f.ip);
    if (ranges.some((r) => n >= parseIp(r.start) && n <= parseIp(r.end))) throw badRequest(`Fixed IP ${f.ip} is inside a reserved range`);
  }
  dev.cellularGatewayLan = { fixedIpAssignments: fixed, reservedIpRanges: ranges };
  return lanJson(dev);
}

const rulesOf = (dev) => dev.cellularGatewayPortForwarding ?? [];
const ruleJson = (r) => ({ ...r, allowedIps: [...r.allowedIps] });

function updatePortForwarding(ctx) {
  const dev = gatewayOf(ctx);
  const rules = ctx.body.rules;
  if (rules == null) return { rules: rulesOf(dev).map(ruleJson) };
  if (rules.length > MAX_RULES) throw badRequest(`'rules' can list at most ${MAX_RULES} rules`);
  const out = rules.map((r, i) => {
    const at = `rules[${i}]`;
    const lanIp = lanHost(r.lanIp, `${at}.lanIp`);
    for (const k of ['publicPort', 'localPort']) if (typeof r[k] !== 'string' || !isPort(r[k], true)) throw badRequest(`'${at}.${k}' must be a port or a range like 8000-8010`);
    if (r.protocol !== 'tcp' && r.protocol !== 'udp') throw badRequest(`'${at}.protocol' must be tcp or udp`);
    if (r.access !== 'any' && r.access !== 'restricted') throw badRequest(`'${at}.access' must be any or restricted`);
    let allowedIps = ['any'];
    if (r.access === 'restricted') {
      allowedIps = r.allowedIps ?? [];
      if (!allowedIps.length) throw badRequest(`'${at}.allowedIps' must list at least one address when access is restricted`);
      const bad = allowedIps.find((ip) => typeof ip !== 'string' || !isAddress(ip));
      if (bad !== undefined) throw badRequest(`'${at}.allowedIps' has ${bad}, which is not an IP address or CIDR`);
    }
    return { name: r.name ?? '', lanIp, publicPort: r.publicPort, localPort: r.localPort, allowedIps: [...allowedIps], protocol: r.protocol, access: r.access };
  });
  dev.cellularGatewayPortForwarding = out;
  return { rules: out.map(ruleJson) };
}

function gatewayNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'cellularGateway');
  return net;
}

const uplinkOf = (net) => configOf(net).cellularGatewayUplink ?? { bandwidthLimits: { limitUp: null, limitDown: null } };

function updateUplink(ctx) {
  const net = gatewayNet(ctx);
  const limits = ctx.body.bandwidthLimits;
  const cur = uplinkOf(net).bandwidthLimits;
  const next = { ...cur };
  for (const k of ['limitUp', 'limitDown']) {
    if (limits?.[k] === undefined) continue;
    const v = limits[k];
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 10000000)) throw badRequest(`'bandwidthLimits.${k}' must be a number of Kbps from 1 to 10000000, or null for no limit`);
    next[k] = v;
  }
  configOf(net).cellularGatewayUplink = { bandwidthLimits: next };
  return { bandwidthLimits: { ...next } };
}

// The MG's one cellular uplink, on its primary SIM.
function uplinkJson(d, now) {
  const u = uplinkState(d, now);
  const type = signalType(d);
  return {
    interface: 'cellular',
    status: u.down ? 'not connected' : 'active',
    ip: u.ip,
    provider: u.carrier.provider,
    publicIp: u.publicIp,
    model: 'integrated',
    signalStat: u.down ? { rsrp: null, rsrq: null } : signalAt(d, now),
    mcc: u.carrier.mcc,
    mnc: u.carrier.mnc,
    roaming: { status: 'home' },
    connectionType: type === 'LTE' ? '4g' : '5g',
    apn: u.apn,
    gateway: u.gateway,
    dns1: u.carrier.dns[0],
    dns2: u.carrier.dns[1],
    signalType: type === 'LTE' ? '4G' : '5G',
    mtu: 1500,
    iccid: u.sim.iccid,
    imsi: u.sim.imsi,
    msisdn: u.sim.msisdn,
  };
}

const DEVICE = '/devices/{serial}/cellularGateway';
const SAMPLE = { org: 1, serial: 'cellularGateway' };
const NET_SAMPLE = { org: 1, networkId: (world) => world.orgs[1].devices.find(isGateway).net.id };

export default [
  {
    op: 'getOrganizationCellularGatewayUplinkStatuses',
    path: '/organizations/{organizationId}/cellularGateway/uplink/statuses',
    sample: { org: 1 },
    handler: (ctx) => {
      const q = ctx.query;
      const networkIds = arrayParam(q, 'networkIds');
      const serials = arrayParam(q, 'serials');
      const iccids = arrayParam(q, 'iccids');
      const rows = orgOf(ctx)
        .devices.filter((d) => isGateway(d) && (!networkIds.length || networkIds.includes(d.net.id)) && (!serials.length || serials.includes(d.serial)))
        .sort(bySerial)
        .map((d) => ({ d, uplink: uplinkJson(d, ctx.now) }))
        .filter((x) => !iccids.length || iccids.includes(x.uplink.iccid));
      return paginate(ctx, rows, (x) => x.d.serial, { def: 1000, min: 3, max: 1000 }).map(({ d, uplink }) => ({
        networkId: d.net.id,
        serial: d.serial,
        model: d.model,
        lastReportedAt: iso(lastReportedAt(d, ctx.now)),
        uplinks: [uplink],
      }));
    },
  },
  { op: 'getDeviceCellularGatewayLan', path: `${DEVICE}/lan`, sample: SAMPLE, handler: (ctx) => lanJson(gatewayOf(ctx)) },
  { op: 'updateDeviceCellularGatewayLan', method: 'PUT', path: `${DEVICE}/lan`, sample: SAMPLE, handler: updateLan },
  { op: 'getDeviceCellularGatewayPortForwardingRules', path: `${DEVICE}/portForwardingRules`, sample: SAMPLE, handler: (ctx) => ({ rules: rulesOf(gatewayOf(ctx)).map(ruleJson) }) },
  { op: 'updateDeviceCellularGatewayPortForwardingRules', method: 'PUT', path: `${DEVICE}/portForwardingRules`, sample: SAMPLE, handler: updatePortForwarding },
  { op: 'getNetworkCellularGatewayUplink', path: '/networks/{networkId}/cellularGateway/uplink', sample: NET_SAMPLE, handler: (ctx) => ({ bandwidthLimits: { ...uplinkOf(gatewayNet(ctx)).bandwidthLimits } }) },
  { op: 'updateNetworkCellularGatewayUplink', method: 'PUT', path: '/networks/{networkId}/cellularGateway/uplink', sample: NET_SAMPLE, handler: updateUplink },
];
