// Org-wide switch port views (overview, clients, LLDP/CDP and usage history)
// and the DHCP servers a switched network sees.

import { configOf } from '../config.js';
import { deviceUrl } from '../format.js';
import { badRequest, paginate, paginateItems, timeWindow } from '../http.js';
import { derive, unit } from '../rng.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { eachSession, presenceIn } from '../sim/presence.js';
import { buckets } from '../sim/usage.js';
import { DAY, iso } from '../time.js';
import { bySerial, netOf, orgOf, requireProduct, round } from './common.js';
import { neighbor, orgSwitches, portSpeed, portTraffic, speedMbps, switchHeader, upSeconds } from './switch.js';

const RJ45 = [10, 100, 1000, 2500, 5000, 10000];
const SFP = [100, 1000, 10000, 20000, 25000, 40000, 50000, 100000];
const INTERVALS = [300, 1200, 14400, 86400];
// Most intervals one port returns: a day at 300 s.
const MAX_INTERVALS = 288;
const LLDP_TLVS = { systemName: 'System name', systemDescription: 'System description', chassisId: 'Chassis ID', portId: 'Port ID', portDescription: 'Port description', managementAddress: 'Management address', systemCapabilities: 'System capabilities', managementVlan: 'Management VLAN', portVlan: 'Port VLAN ID' };
const CDP_TLVS = { deviceId: 'Device ID', platform: 'Platform', portId: 'Port ID', address: 'Address', nativeVlan: 'Native VLAN', version: 'Version', vtpManagementDomain: 'VTP management domain', capabilities: 'Capabilities' };

// Last instant in [t0, t1) something answered on the port, or null if nothing did.
function lastConnected(port, t0, t1) {
  if (port.config?.enabled === false) return null;
  const peer = port.peer?.device;
  if (peer) {
    if (upSeconds(peer, t0, t1) <= 0) return null;
    if (!isDown(peer, t1 - 1)) return t1;
    // Down at the end, so it was last up when the outage covering t1 began.
    let last = peer.dormant && peer.dormantSince < t1 ? peer.dormantSince : t1;
    eachOutage(peer, t0, t1, (s, e) => e >= t1 && (last = Math.min(last, s)));
    return Math.max(last, t0);
  }
  const c = port.clients[0];
  const p = c && presenceIn(c, t0, t1);
  return p ? p.last : null;
}

function portsOverview(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 186 * DAY, minSpan: 12 * 3600 });
  const zeros = (keys) => Object.fromEntries([...keys.map((k) => [k, 0]), ['total', 0]]);
  const active = { rj45: zeros(RJ45), sfp: zeros(SFP) };
  const inactive = { rj45: { total: 0 }, sfp: { total: 0 } };
  let total = 0;
  for (const sw of orgOf(ctx).devices.filter((d) => d.productType === 'switch')) {
    // Only switches online at some point in the window report their ports.
    if (upSeconds(sw, t0, t1) <= 0) continue;
    for (const port of sw.ports) {
      const media = port.uplinkPort ? 'sfp' : 'rj45';
      total++;
      if (lastConnected(port, t0, t1) == null) {
        inactive[media].total++;
        continue;
      }
      const speed = speedMbps(portSpeed(sw, port));
      if (speed in active[media]) active[media][speed]++;
      active[media].total++;
    }
  }
  const activeTotal = active.rj45.total + active.sfp.total;
  return {
    counts: {
      total,
      byStatus: {
        active: { total: activeTotal, byMediaAndLinkSpeed: active },
        inactive: { total: total - activeTotal, byMedia: inactive },
      },
    },
  };
}

const switchWindow = (ctx) => timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });

// Ports with clients in the window; counts match the port statuses' clientCount.
function clientsOverview(ctx) {
  const { t0, t1 } = switchWindow(ctx);
  return paginateItems(ctx, orgSwitches(ctx), (sw) => sw.serial, { def: 20, max: 20 }, (sw) => ({
    ...switchHeader(sw),
    ports: sw.ports
      .filter((p) => p.config?.enabled !== false)
      .map((p) => ({ portId: p.portId, counts: { byStatus: { online: portTraffic(sw, p, t0, t1).clients } } }))
      .filter((p) => p.counts.byStatus.online > 0),
  }));
}

const tlvs = (fields, names) =>
  Object.entries(names)
    .filter(([k]) => fields[k] != null && fields[k] !== '')
    .map(([k, name]) => ({ name, value: String(fields[k]) }));

function discoveryPorts(sw, t0, t1) {
  const out = [];
  for (const port of sw.ports) {
    const n = neighbor(port);
    if (!n.lldp && !n.cdp) continue;
    const last = lastConnected(port, t0, t1);
    if (last == null) continue;
    out.push({ portId: port.portId, lastUpdatedAt: iso(last), cdp: n.cdp ? tlvs(n.cdp, CDP_TLVS) : [], lldp: n.lldp ? tlvs(n.lldp, LLDP_TLVS) : [] });
  }
  return out;
}

function topologyDiscovery(ctx) {
  const { t0, t1 } = switchWindow(ctx);
  return paginateItems(ctx, orgSwitches(ctx), (sw) => sw.serial, { def: 10, max: 20 }, (sw) => ({ ...switchHeader(sw), ports: discoveryPorts(sw, t0, t1) }));
}

// With no time params the interval sets the span (72 intervals, so 1200 s gives the
// default day). With them, the interval is the smallest at or above the one asked
// for (1200 by default) that keeps the span within MAX_INTERVALS.
function usageWindow(q, now) {
  const v = q.get('interval');
  const asked = v == null ? null : Number(v);
  if (asked != null && !INTERVALS.includes(asked)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
  if (!q.has('timespan') && !q.has('t0') && !q.has('t1')) {
    const interval = asked ?? 1200;
    return { t0: now - Math.min(31 * DAY, 72 * interval), t1: now, interval };
  }
  const { t0, t1 } = timeWindow(q, now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
  const interval = INTERVALS.find((i) => i >= (asked ?? 1200) && (t1 - t0) / i <= MAX_INTERVALS) ?? INTERVALS[INTERVALS.length - 1];
  return { t0, t1, interval };
}

function portIntervals(sw, port, t0, t1, interval) {
  return buckets(t0, t1, interval).map(([s, e]) => {
    const a = Math.max(s, t0);
    const b = Math.min(e, t1);
    const l = port.config?.enabled === false ? { up: 0, down: 0, wh: 0 } : portTraffic(sw, port, a, b);
    const kbps = (kb) => round((kb * 8) / (b - a), 1);
    return {
      startTs: iso(s),
      endTs: iso(e),
      data: { usage: { total: Math.round(l.up + l.down), upstream: Math.round(l.up), downstream: Math.round(l.down) } },
      bandwidth: { usage: { total: kbps(l.up + l.down), upstream: kbps(l.up), downstream: kbps(l.down) } },
      energy: { usage: { total: round(l.wh, 1) } },
    };
  });
}

function usageHistory(ctx) {
  const { t0, t1, interval } = usageWindow(ctx.query, ctx.now);
  return paginateItems(ctx, orgSwitches(ctx), (sw) => sw.serial, { def: 10, max: 50 }, (sw) => ({
    ...switchHeader(sw),
    ports: sw.ports.map((p) => ({ portId: p.portId, intervals: portIntervals(sw, p, t0, t1, interval) })),
  }));
}

// ── DHCP servers seen ──

const hex = (u, digits) => '0x' + Math.floor(u * 16 ** digits).toString(16).padStart(digits, '0');

// The ACK the server last sent to c at ts, as the switches captured it.
function ackPacket(mx, vlan, c, ts) {
  const key = derive(c.key, 'dhcp');
  const i = Math.floor(ts);
  return {
    source: { mac: mx.mac, ipv4: { address: vlan.applianceIp }, port: 67 },
    destination: { mac: c.mac, ipv4: { address: c.ip }, port: 68 },
    type: 'ACK',
    ethernet: { type: '0x0800' },
    ip: { id: hex(unit(key, i), 4), version: 4, length: 328, headerLength: 5, protocol: 17, ttl: 64, dscp: { tag: 0, ecn: 0 } },
    udp: { length: 308, checksum: hex(unit(key, i + 1), 4) },
    fields: {
      op: 2,
      htype: 1,
      hlen: 6,
      hops: 0,
      xid: hex(unit(key, i + 2), 8),
      secs: 0,
      flags: '0x0000',
      ciaddr: '0.0.0.0',
      yiaddr: c.ip,
      siaddr: '0.0.0.0',
      giaddr: '0.0.0.0',
      chaddr: c.mac.replace(/:/g, ''),
      sname: '',
      magicCookie: '0x63825363',
      options: [
        { name: 'DHCP message type', value: 'ACK' },
        { name: 'Server identifier', value: vlan.applianceIp },
        { name: 'Lease time', value: '86400 seconds' },
        { name: 'Subnet mask', value: maskOf(vlan.subnet) },
        { name: 'Router', value: vlan.applianceIp },
      ],
    },
  };
}

function maskOf(cidr) {
  const bits = Number(cidr.split('/')[1]);
  const m = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
  return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join('.');
}

// The MX's LAN interfaces that run DHCP: every DHCP VLAN, or the single LAN.
function dhcpVlans(net) {
  const c = configOf(net);
  if (!c.vlansEnabled) return [{ id: '1', name: 'Default', subnet: c.singleLan.subnet, applianceIp: c.singleLan.applianceIp }];
  return c.vlans.filter((v) => v.dhcpHandling === 'Run a DHCP server');
}

// Latest lease the MX handed out on a VLAN in [t0, t1): a session start while the MX was up.
function lastLease(net, vlanId, t0, t1) {
  let best = null;
  for (const c of net.clients) {
    if (vlanId != null && c.vlan !== vlanId) continue;
    eachSession(c, t0, t1, (s) => {
      if (s >= t0 && s < t1 && (!best || s > best.ts) && !isDown(net.mx, s)) best = { c, ts: s };
    });
  }
  return best;
}

function dhcpServersSeen(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'switch');
  const { t0, t1 } = switchWindow(ctx);
  const mx = net.mx;
  const rows = [];
  if (mx) {
    const single = !configOf(net).vlansEnabled;
    for (const v of dhcpVlans(net)) {
      const lease = lastLease(net, single ? null : Number(v.id), t0, t1);
      if (!lease) continue;
      const ts = iso(lease.ts);
      rows.push({
        mac: mx.mac,
        vlan: Number(v.id),
        isAllowed: true,
        lastSeenAt: ts,
        seenBy: net.switches
          .filter((sw) => !isDown(sw, lease.ts))
          .sort(bySerial)
          .map((sw) => ({ serial: sw.serial, name: sw.name, url: deviceUrl(sw) })),
        type: 'device',
        device: { serial: mx.serial, name: mx.name, url: deviceUrl(mx), interface: { name: v.name, url: net.url.replace('/usage/list', '/configure/vlans') } },
        ipv4: { address: v.applianceIp, subnet: v.subnet, gateway: v.applianceIp },
        isConfigured: true,
        lastAck: { ts, ipv4: { address: lease.c.ip } },
        lastPacket: ackPacket(mx, v, lease.c, lease.ts),
      });
    }
  }
  rows.sort((a, b) => a.vlan - b.vlan);
  return paginate(ctx, rows, (r) => String(r.vlan), { def: 1000, max: 1000 });
}

const ORG = '/organizations/{organizationId}/switch/ports';

export default [
  { op: 'getOrganizationSwitchPortsOverview', path: `${ORG}/overview`, handler: portsOverview },
  { op: 'getOrganizationSwitchPortsClientsOverviewByDevice', path: `${ORG}/clients/overview/byDevice`, handler: clientsOverview },
  { op: 'getOrganizationSwitchPortsTopologyDiscoveryByDevice', path: `${ORG}/topology/discovery/byDevice`, handler: topologyDiscovery },
  { op: 'getOrganizationSwitchPortsUsageHistoryByDeviceByInterval', path: `${ORG}/usage/history/byDevice/byInterval`, handler: usageHistory },
  { op: 'getNetworkSwitchDhcpV4ServersSeen', path: '/networks/{networkId}/switch/dhcp/v4/servers/seen', handler: dhcpServersSeen },
];
