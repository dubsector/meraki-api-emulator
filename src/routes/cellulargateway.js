// MG cellular gateway LAN, port forwarding and uplink settings, and the org
// uplink statuses. LAN and port forwarding rules belong to the device; the
// uplink bandwidth limits, DHCP, connectivity monitoring destinations and the
// subnet pool each MG's LAN comes from are network settings.

import { configOf } from '../config.js';
import { arrayParam, badRequest, paginate } from '../http.js';
import { DEFAULT_DESTINATION, checkDestinations } from './firewall.js';
import { isGateway, signalAt, signalType, uplinkState } from '../sim/cellular.js';
import { lastReportedAt } from '../sim/outages.js';
import { iso } from '../time.js';
import { ipInCidr, isAddress, isPort, parseCidr, parseIp } from '../validate.js';
import { bySerial, devOf, netOf, orgOf, requireProduct } from './common.js';

// Each MG takes the next subnet of its network's pool, in the order the MGs
// joined; the pool's first subnet is held back, so the first MG gets
// 192.168.0.32/27 and answers on its first host address.
const DEFAULT_POOL = { cidr: '192.168.0.0/24', mask: 27 };
const LEASE_TIMES = ['30 minutes', '1 hour', '4 hours', '12 hours', '1 day', '1 week'];
const DNS_MODES = ['upstream_dns', 'google_dns', 'opendns', 'custom'];
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const MAX_RULES = 100;

function gatewayOf(ctx) {
  const dev = devOf(ctx);
  if (!isGateway(dev)) throw badRequest('This endpoint is only supported for MG cellular gateways');
  return dev;
}

const dotted = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
const poolOf = (net) => configOf(net).cellularGatewaySubnetPool ?? DEFAULT_POOL;
const gatewaysOf = (net) => net.devices.filter(isGateway);

// The LAN subnet each MG of a network gets from a pool, by serial. MGs past
// the end of the pool get none.
function subnetsFor(net, pool) {
  const [base, prefix] = parseCidr(pool.cidr);
  const size = 2 ** (32 - pool.mask);
  const count = 2 ** (pool.mask - prefix);
  const out = new Map();
  gatewaysOf(net).forEach((d, i) => {
    if (i + 1 >= count) return;
    const start = base + (i + 1) * size;
    out.set(d.serial, { subnet: `${dotted(start)}/${pool.mask}`, ip: dotted(start + 1), start, size });
  });
  return out;
}

const lanAddress = (dev) => subnetsFor(dev.net, poolOf(dev.net)).get(dev.serial) ?? null;

const lanOf = (dev) => dev.cellularGatewayLan ?? { fixedIpAssignments: [], reservedIpRanges: [] };

const lanJson = (dev) => {
  const lan = lanOf(dev);
  const addr = lanAddress(dev);
  return { deviceName: dev.name, deviceLanIp: addr?.ip ?? null, deviceSubnet: addr?.subnet ?? null, fixedIpAssignments: lan.fixedIpAssignments.map((f) => ({ ...f })), reservedIpRanges: lan.reservedIpRanges.map((r) => ({ ...r })) };
};

// Why an address can't be a host on an MG's LAN, or null when it can.
function hostProblem(ip, addr) {
  if (typeof ip !== 'string' || parseIp(ip) == null || !ipInCidr(ip, addr.subnet)) return `must be an address in the MG's LAN ${addr.subnet}`;
  const host = parseIp(ip) - addr.start;
  if (host === 0 || host === addr.size - 1) return "can't be the LAN's network or broadcast address";
  if (ip === addr.ip) return `can't be the MG's own address ${addr.ip}`;
  return null;
}

// A host address on the MG's LAN, other than its own.
function lanHost(ip, at, addr) {
  if (!addr) throw badRequest("This MG has no LAN subnet, since its network's subnet pool is full");
  const problem = hostProblem(ip, addr);
  if (problem) throw badRequest(`'${at}' ${problem}`);
  return ip;
}

// Every address an MG's LAN settings and port forwarding rules name.
const lanAddresses = (dev) => {
  const lan = lanOf(dev);
  return [...lan.fixedIpAssignments.map((f) => f.ip), ...lan.reservedIpRanges.flatMap((r) => [r.start, r.end]), ...rulesOf(dev).map((r) => r.lanIp)];
};

// Lists the body gives replace the stored ones whole.
function updateLan(ctx) {
  const dev = gatewayOf(ctx);
  const b = ctx.body;
  const cur = lanOf(dev);
  const addr = lanAddress(dev);
  let fixed = cur.fixedIpAssignments;
  let ranges = cur.reservedIpRanges;
  if (b.fixedIpAssignments != null) {
    if (b.fixedIpAssignments.length > MAX_RULES) throw badRequest(`'fixedIpAssignments' can list at most ${MAX_RULES} assignments`);
    const ips = new Set();
    const macs = new Set();
    fixed = b.fixedIpAssignments.map((f, i) => {
      const ip = lanHost(f.ip, `fixedIpAssignments[${i}].ip`, addr);
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
      const start = lanHost(r.start, `reservedIpRanges[${i}].start`, addr);
      const end = lanHost(r.end, `reservedIpRanges[${i}].end`, addr);
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
  const addr = lanAddress(dev);
  const out = rules.map((r, i) => {
    const at = `rules[${i}]`;
    const lanIp = lanHost(r.lanIp, `${at}.lanIp`, addr);
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

function subnetPoolJson(net) {
  const pool = poolOf(net);
  const subnets = subnetsFor(net, pool);
  return {
    deploymentMode: 'routed',
    cidr: pool.cidr,
    mask: pool.mask,
    subnets: gatewaysOf(net).map((d) => ({ serial: d.serial, name: d.name, applianceIp: subnets.get(d.serial)?.ip ?? null, subnet: subnets.get(d.serial)?.subnet ?? null })),
  };
}

// A new pool must hold every MG, and each MG's LAN settings and port
// forwarding rules must still fit the subnet it moves to.
function updateSubnetPool(ctx) {
  const net = gatewayNet(ctx);
  const b = ctx.body;
  const cur = poolOf(net);
  let cidr = cur.cidr;
  if (b.cidr != null) {
    const c = parseCidr(b.cidr);
    if (!c || c[1] < 8 || c[1] > 29) throw badRequest("'cidr' must be an IPv4 subnet like 192.168.0.0/16, from /8 to /29");
    if (c[0] % 2 ** (32 - c[1])) throw badRequest(`'cidr' ${b.cidr} has host bits set`);
    cidr = b.cidr;
  }
  const prefix = parseCidr(cidr)[1];
  const mask = b.mask ?? cur.mask;
  if (!Number.isInteger(mask) || mask <= prefix || mask > 30) throw badRequest(`'mask' must be from ${prefix + 1} to 30 for the pool ${cidr}`);
  const pool = { cidr, mask };
  const need = gatewaysOf(net).length;
  if (2 ** (mask - prefix) - 1 < need) throw badRequest(`The pool ${cidr} holds ${2 ** (mask - prefix) - 1} /${mask} subnets after the first, which is held back, and this network has ${need} MGs`);
  const subnets = subnetsFor(net, pool);
  for (const d of gatewaysOf(net)) {
    const addr = subnets.get(d.serial);
    const bad = lanAddresses(d).find((ip) => hostProblem(ip, addr));
    if (bad) throw badRequest(`${d.name ?? d.serial}'s LAN settings or port forwarding rules name ${bad}, which isn't a host in its new subnet ${addr.subnet}`);
  }
  configOf(net).cellularGatewaySubnetPool = pool;
  return subnetPoolJson(net);
}

const dhcpOf = (net) => configOf(net).cellularGatewayDhcp ?? { dhcpLeaseTime: '1 day', dnsNameservers: 'upstream_dns', dnsCustomNameservers: [] };

function updateDhcp(ctx) {
  const net = gatewayNet(ctx);
  const b = ctx.body;
  const next = { ...dhcpOf(net) };
  if (b.dhcpLeaseTime != null) {
    if (!LEASE_TIMES.includes(b.dhcpLeaseTime)) throw badRequest(`'dhcpLeaseTime' must be one of: ${LEASE_TIMES.join(', ')}`);
    next.dhcpLeaseTime = b.dhcpLeaseTime;
  }
  if (b.dnsNameservers != null) {
    if (!DNS_MODES.includes(b.dnsNameservers)) throw badRequest(`'dnsNameservers' must be one of: ${DNS_MODES.join(', ')}`);
    next.dnsNameservers = b.dnsNameservers;
  }
  if (b.dnsCustomNameservers != null) {
    const bad = b.dnsCustomNameservers.find((ip) => typeof ip !== 'string' || parseIp(ip) == null);
    if (bad !== undefined) throw badRequest(`'dnsCustomNameservers' has ${bad}, which is not an IPv4 address`);
    next.dnsCustomNameservers = [...new Set(b.dnsCustomNameservers)];
  }
  if (next.dnsNameservers !== 'custom') {
    if (b.dnsCustomNameservers?.length) throw badRequest("'dnsCustomNameservers' only applies when 'dnsNameservers' is custom");
    next.dnsCustomNameservers = [];
  } else if (!next.dnsCustomNameservers.length) throw badRequest("'dnsCustomNameservers' must list at least one server when 'dnsNameservers' is custom");
  configOf(net).cellularGatewayDhcp = next;
  return { ...next, dnsCustomNameservers: [...next.dnsCustomNameservers] };
}

const destinationsOf = (net) => configOf(net).cellularGatewayConnectivityDestinations ?? [{ ...DEFAULT_DESTINATION }];

function updateDestinations(ctx) {
  const net = gatewayNet(ctx);
  if (ctx.body.destinations != null) configOf(net).cellularGatewayConnectivityDestinations = checkDestinations(ctx.body.destinations);
  return { destinations: destinationsOf(net).map((d) => ({ ...d })) };
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
  { op: 'getNetworkCellularGatewaySubnetPool', path: '/networks/{networkId}/cellularGateway/subnetPool', sample: NET_SAMPLE, handler: (ctx) => subnetPoolJson(gatewayNet(ctx)) },
  { op: 'updateNetworkCellularGatewaySubnetPool', method: 'PUT', path: '/networks/{networkId}/cellularGateway/subnetPool', sample: NET_SAMPLE, handler: updateSubnetPool },
  { op: 'getNetworkCellularGatewayDhcp', path: '/networks/{networkId}/cellularGateway/dhcp', sample: NET_SAMPLE, handler: (ctx) => { const d = dhcpOf(gatewayNet(ctx)); return { ...d, dnsCustomNameservers: [...d.dnsCustomNameservers] }; } },
  { op: 'updateNetworkCellularGatewayDhcp', method: 'PUT', path: '/networks/{networkId}/cellularGateway/dhcp', sample: NET_SAMPLE, handler: updateDhcp },
  { op: 'getNetworkCellularGatewayConnectivityMonitoringDestinations', path: '/networks/{networkId}/cellularGateway/connectivityMonitoringDestinations', sample: NET_SAMPLE, handler: (ctx) => ({ destinations: destinationsOf(gatewayNet(ctx)).map((d) => ({ ...d })) }) },
  { op: 'updateNetworkCellularGatewayConnectivityMonitoringDestinations', method: 'PUT', path: '/networks/{networkId}/cellularGateway/connectivityMonitoringDestinations', sample: NET_SAMPLE, handler: updateDestinations },
  { op: 'getNetworkCellularGatewayUplink', path: '/networks/{networkId}/cellularGateway/uplink', sample: NET_SAMPLE, handler: (ctx) => ({ bandwidthLimits: { ...uplinkOf(gatewayNet(ctx)).bandwidthLimits } }) },
  { op: 'updateNetworkCellularGatewayUplink', method: 'PUT', path: '/networks/{networkId}/cellularGateway/uplink', sample: NET_SAMPLE, handler: updateUplink },
];
