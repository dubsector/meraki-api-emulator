import { VLANS } from '../catalog.js';
import { deviceJson } from '../format.js';
import { badRequest, resolutionParam, timeWindow } from '../http.js';
import { lognoise } from '../rng.js';
import { linkAverage, linkSample } from '../sim/links.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { isOnline, presenceIn } from '../sim/presence.js';
import { WAN_RECV, WAN_SENT, clientUsage, networkTotals } from '../sim/usage.js';
import { connectionStats, latencyStats } from '../sim/wireless.js';
import { DAY, HOUR, MIN, iso } from '../time.js';
import { devOf, requireModel, round } from './common.js';

const UPLINKS = ['wan1', 'wan2', 'wan3', 'cellular', 'wan4'];
const NO_USAGE = { sent: 0, recv: 0, clients: 0, wh: 0 };

function deviceClients(dev) {
  const net = dev.net;
  if (dev.productType === 'wireless') return net.clients.filter((c) => !c.wired && c.ap === dev);
  if (dev.productType === 'switch') return net.clients.filter((c) => c.switchPort?.switch === dev);
  if (dev.productType === 'appliance') return net.clients;
  return [];
}

// Seconds a device was up within [a, b).
function upSeconds(dev, a, b) {
  if (dev.dormant && dev.dormantSince < b) return Math.max(0, dev.dormantSince - a);
  let down = 0;
  eachOutage(dev, a, b, (s, e) => (down += Math.min(e, b) - Math.max(s, a)));
  return b - a - down;
}

// Traffic through one access port, from the attached device's point of view (sent = upstream).
function portLoad(port, t0, t1) {
  const peer = port.peer?.device;
  if (peer?.productType === 'wireless') {
    let sent = 0;
    let recv = 0;
    let clients = 0;
    for (const c of peer.net.clients) {
      if (c.wired || c.ap !== peer || !presenceIn(c, t0, t1)) continue;
      const u = clientUsage(c, t0, t1);
      sent += u.sent;
      recv += u.recv;
      clients++;
    }
    return { sent, recv, clients: clients + 1, wh: (peer.info.watts * upSeconds(peer, t0, t1)) / HOUR };
  }
  if (peer?.productType === 'camera') {
    // Cameras store video locally and upload a trickle of metadata and thumbnails.
    const up = upSeconds(peer, t0, t1);
    return { sent: (up * 90) / 8, recv: (up * 6) / 8, clients: up > 0 ? 1 : 0, wh: (peer.info.watts * up) / HOUR };
  }
  const c = port.clients[0];
  if (!c) return NO_USAGE;
  const p = presenceIn(c, t0, t1);
  if (!p) return NO_USAGE;
  const u = clientUsage(c, t0, t1);
  return { sent: u.sent, recv: u.recv, clients: 1, wh: c.kindName === 'deskPhone' ? (6.2 * p.seconds) / HOUR : 0 };
}

// Everything a switch carries toward the core.
function switchLoad(sw, t0, t1) {
  const out = { sent: 0, recv: 0, clients: 0 };
  for (const p of sw.ports) {
    if (p.uplinkPort) continue;
    const l = portLoad(p, t0, t1);
    out.sent += l.sent;
    out.recv += l.recv;
    out.clients += l.clients;
  }
  return out;
}

function peerConnected(port, now) {
  const peer = port.peer?.device;
  if (peer) return !isDown(peer, now);
  const c = port.clients[0];
  return c ? isOnline(c, now) : false;
}

function portSpeed(sw, port) {
  const peer = port.peer?.device;
  if (port.uplinkPort) {
    if (peer?.productType === 'appliance') return peer.model === 'MX250' ? '10 Gbps' : '1 Gbps';
    return sw.info.uplinkSpeed;
  }
  if (peer?.info.speed && sw.model === 'MS390-48UX') return peer.info.speed;
  const c = port.clients[0];
  if (c && (c.kindName === 'printer' || c.kindName === 'pos')) return '100 Mbps';
  return sw.info.accessSpeed;
}

function neighbor(port) {
  const peer = port.peer?.device;
  if (peer) {
    const lldp = {
      systemName: `Meraki ${peer.model} - ${peer.name}`,
      systemDescription: `Meraki ${peer.model} Cloud Managed ${{ wireless: 'AP', switch: 'Switch', camera: 'Camera', appliance: 'Security Appliance' }[peer.productType]}`,
      chassisId: peer.mac,
      portId: port.peer.portId,
      managementAddress: peer.lanIp ?? peer.uplinks?.[0].publicIp ?? null,
      systemCapabilities: { wireless: 'WLAN access point', camera: 'Other', appliance: 'Router' }[peer.productType] ?? 'Switch',
    };
    return { lldp };
  }
  const c = port.clients[0];
  if (c?.kindName === 'deskPhone') {
    return {
      cdp: { systemName: '', platform: 'Cisco IP Phone 8845', deviceId: c.description, portId: 'Port 1', nativeVlan: 10, address: c.ip, managementAddress: c.ip, version: 'sip88xx.14-2-1-0101-40', vtpManagementDomain: '', capabilities: 'Host, Phone' },
      lldp: { systemName: c.description, systemDescription: 'Cisco IP Phone 8845', chassisId: c.mac, portId: c.mac, portDescription: 'SW PORT', systemCapabilities: 'Telephone' },
    };
  }
  return {};
}

function portConfig(net, sw, port) {
  const peer = port.peer?.device;
  const c = port.clients[0];
  const out = {
    portId: port.portId,
    name: null,
    tags: [],
    enabled: true,
    poeEnabled: !port.uplinkPort,
    type: 'trunk',
    vlan: 1,
    voiceVlan: null,
    allowedVlans: 'all',
    isolationEnabled: false,
    rstpEnabled: true,
    stpGuard: 'disabled',
    linkNegotiation: 'Auto negotiate',
    portScheduleId: null,
    udld: 'Alert only',
    accessPolicyType: 'Open',
    daiTrusted: false,
    stormControlEnabled: false,
    flexibleStackingEnabled: false,
    profile: { enabled: false, id: '', iname: null },
    mirror: { mode: 'Not mirroring traffic' },
    dot3az: { enabled: false },
  };
  if (peer?.productType === 'appliance') return { ...out, name: 'Uplink to MX', tags: ['uplink'], daiTrusted: true };
  if (peer?.productType === 'switch') return { ...out, name: port.isUplink ? 'Uplink' : `To ${peer.name}`, tags: ['uplink'], stpGuard: port.isUplink ? 'disabled' : 'root guard' };
  if (peer?.productType === 'wireless') {
    const vlans = [1, ...new Set(net.ssids.map((s) => s.vlan))].sort((a, b) => a - b);
    return { ...out, name: peer.name, tags: ['ap'], allowedVlans: vlans.join(',') };
  }
  if (peer?.productType === 'camera') return { ...out, name: peer.name, tags: ['camera'], type: 'access', vlan: 1, allowedVlans: 'all' };
  if (c?.kindName === 'deskPhone') return { ...out, type: 'access', vlan: 10, voiceVlan: 20, stpGuard: 'bpdu guard' };
  if (c) return { ...out, type: 'access', vlan: c.vlan, voiceVlan: net.clients.some((x) => x.kindName === 'deskPhone') ? 20 : null, stpGuard: 'bpdu guard' };
  return out;
}

function portStatus(sw, port, t0, t1, now) {
  const peer = port.peer?.device;
  let load;
  let dir = 1;
  if (port.uplinkPort && peer?.productType === 'appliance') {
    const [s, r] = networkTotals(sw.net, t0, t1, [WAN_SENT, WAN_RECV]);
    load = { sent: s, recv: r, clients: sw.net.clients.filter((c) => presenceIn(c, t0, t1)).length, wh: 0 };
  } else if (port.uplinkPort && peer?.productType === 'switch') {
    // Our uplink carries our own load; the core's port toward us carries it the other way.
    load = { ...switchLoad(port.isUplink ? sw : peer, t0, t1), wh: 0 };
    if (!port.isUplink) dir = -1;
  } else {
    load = portLoad(port, t0, t1);
  }
  const connected = peerConnected(port, now);
  const secs = t1 - t0;
  // Switch view: "sent" leaves the port toward the device, so it is the device's download.
  const sent = dir === 1 && port.uplinkPort ? load.sent : load.recv;
  const recv = dir === 1 && port.uplinkPort ? load.recv : load.sent;
  const alertPort = sw.alerting && port === sw.ports.find((p) => p.clients.length && !p.uplinkPort);
  return {
    portId: port.portId,
    enabled: true,
    status: connected ? 'Connected' : 'Disconnected',
    isUplink: port.isUplink,
    errors: alertPort ? ['Very high proportion of CRC errors'] : [],
    warnings: [],
    speed: connected ? portSpeed(sw, port) : '',
    duplex: connected ? 'full' : '',
    spanningTree: { statuses: connected ? ['Forwarding'] : [] },
    poe: { isAllocated: connected && load.wh > 0 },
    usageInKb: { total: Math.round(sent + recv), sent: Math.round(sent), recv: Math.round(recv) },
    ...(connected ? neighbor(port) : {}),
    clientCount: load.clients,
    powerUsageInWh: round(load.wh, 1),
    trafficInKbps: { total: round(((sent + recv) * 8) / secs, 1), sent: round((sent * 8) / secs, 1), recv: round((recv * 8) / secs, 1) },
    securePort: { enabled: false, active: false, authenticationStatus: 'Disabled', configOverrides: {} },
  };
}

function wirelessClients(ctx, dev) {
  const q = ctx.query;
  const band = q.get('band');
  if (band && !['2.4', '5', '6'].includes(band)) throw badRequest("'band' must be one of: 2.4, 5, 6");
  const ssid = q.get('ssid');
  return deviceClients(dev).filter((c) => (!band || c.band === band) && (ssid == null || String(c.ssid.number) === ssid));
}

function statsWindow(ctx) {
  return timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, lookback: 180 * DAY });
}

export default [
  {
    path: '/devices/{serial}',
    handler: (ctx) => deviceJson(devOf(ctx), { full: true }),
  },
  {
    path: '/devices/{serial}/clients',
    handler: (ctx) => {
      const dev = devOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });
      const rows = [];
      for (const c of deviceClients(dev)) {
        if (!presenceIn(c, t0, t1)) continue;
        const u = clientUsage(c, t0, t1);
        rows.push({
          id: c.id,
          mac: c.mac,
          description: c.description,
          mdnsName: c.manufacturer === 'Apple' ? c.description : null,
          dhcpHostname: c.description,
          user: c.user,
          ip: c.ip,
          vlan: String(c.vlan),
          namedVlan: VLANS[c.vlan] ?? null,
          switchport: c.switchport,
          adaptivePolicyGroup: null,
          usage: { sent: Math.round(u.sent), recv: Math.round(u.recv) },
        });
      }
      return rows.sort((a, b) => b.usage.sent + b.usage.recv - (a.usage.sent + a.usage.recv));
    },
  },
  {
    path: '/devices/{serial}/lossAndLatencyHistory',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      const q = ctx.query;
      const ip = q.get('ip');
      if (!ip) throw badRequest("'ip' is required");
      const name = q.get('uplink') || 'wan1';
      if (!UPLINKS.includes(name)) throw badRequest(`'uplink' must be one of: ${UPLINKS.join(', ')}`);
      const latest = Math.floor(ctx.now / MIN) * MIN;
      const { t0, t1 } = timeWindow(q, latest, { maxSpan: 31 * DAY, lookback: 60 * DAY });
      const res = resolutionParam(q, [60, 600, 3600, 86400], 60, t1 - t0);
      const uplink = dev.uplinks.find((u) => u.interface === name);
      if (!uplink) return [];
      const rows = [];
      for (let s = Math.ceil(t0 / res) * res; s + res <= t1; s += res) {
        const v = res === 60 ? linkSample(dev, uplink, s, ip) : linkAverage(dev, uplink, s, s + res, ip);
        rows.push({ startTime: iso(s), endTime: iso(s + res), lossPercent: v.lossPercent, latencyMs: v.latencyMs, goodput: v.goodput, jitter: v.jitter });
      }
      return rows;
    },
  },
  {
    path: '/devices/{serial}/appliance/performance',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, defaultSpan: 1800, lookback: 30 * DAY });
      const [s, r] = networkTotals(dev.net, t0, t1, [WAN_SENT, WAN_RECV]);
      const mbps = ((s + r) * 8) / 1000 / (t1 - t0);
      const clients = dev.net.clients.length;
      const score = (2 + 100 * (mbps / dev.info.throughput) ** 0.6 + clients / 40) * lognoise(dev.key, Math.floor(t1 / 300), 0.08);
      return { perfScore: round(Math.min(100, score), 1) };
    },
  },
  {
    path: '/devices/{serial}/switch/ports',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      return dev.ports.map((p) => portConfig(dev.net, dev, p));
    },
  },
  {
    path: '/devices/{serial}/switch/ports/statuses',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });
      return dev.ports.map((p) => portStatus(dev, p, t0, t1, ctx.now));
    },
  },
  {
    path: '/devices/{serial}/wireless/connectionStats',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      const { t0, t1 } = statsWindow(ctx);
      return { serial: dev.serial, connectionStats: connectionStats(wirelessClients(ctx, dev), t0, t1) };
    },
  },
  {
    path: '/devices/{serial}/wireless/latencyStats',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      const { t0, t1 } = statsWindow(ctx);
      return { serial: dev.serial, latencyStats: latencyStats([dev], t0, t1, ctx.query.get('fields')) };
    },
  },
];
