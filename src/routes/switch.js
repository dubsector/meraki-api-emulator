// MS switch ports: configuration, live status and LLDP/CDP neighbors, per
// switch and across the organization.

import { configOf } from '../config.js';
import { deviceUrl } from '../format.js';
import { arrayParam, badRequest, notFound, paginate, paginateItems, timeWindow } from '../http.js';
import { derive, unit } from '../rng.js';
import { crcPort } from '../sim/alerts.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { isOnline, presenceIn } from '../sim/presence.js';
import { WAN_RECV, WAN_SENT, clientUsage, networkTotals } from '../sim/usage.js';
import { DAY, HOUR, parseTime } from '../time.js';
import { merge } from '../validate.js';
import { bySerial, devOf, netOf, orgOf, requireModel, requireProduct, round } from './common.js';

const NO_USAGE = { sent: 0, recv: 0, clients: 0, wh: 0 };

// Seconds a device was up within [a, b).
export function upSeconds(dev, a, b) {
  if (dev.dormant && dev.dormantSince < b) return Math.max(0, dev.dormantSince - a);
  let down = 0;
  eachOutage(dev, a, b, (s, e) => (down += Math.min(e, b) - Math.max(s, a)));
  return b - a - down;
}

// Traffic through one access port, from the attached device's point of view (sent = upstream).
export function portLoad(port, t0, t1) {
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

export function peerConnected(port, now) {
  if (port.config?.enabled === false) return false;
  const peer = port.peer?.device;
  if (peer) return !isDown(peer, now);
  const c = port.clients[0];
  return c ? isOnline(c, now) : false;
}

export function portSpeed(sw, port) {
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

export function neighbor(port) {
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
    // Switches also send their management VLAN and the native VLAN of their port.
    if (peer.productType === 'switch') Object.assign(lldp, switchVlans(peer, portOf(peer, port.peer.portId)));
    return { lldp };
  }
  const c = port.clients[0];
  if (c?.kindName === 'deskPhone') {
    return {
      cdp: { systemName: '', platform: 'Cisco IP Phone 8845', deviceId: c.description, model: 'CP-8845', portId: 'Port 1', nativeVlan: 10, address: c.ip, managementAddress: c.ip, version: 'sip88xx.14-2-1-0101-40', vtpManagementDomain: '', capabilities: 'Host, Phone' },
      lldp: { systemName: c.description, systemDescription: 'Cisco IP Phone 8845', chassisId: c.mac, portId: c.mac, portDescription: 'SW PORT', managementAddress: c.ip, systemCapabilities: 'Telephone' },
    };
  }
  return {};
}

function switchVlans(sw, port) {
  return { managementVlan: configOf(sw.net).switchSettings.vlan, portVlan: portConfig(sw.net, sw, port).vlan };
}

const GIG_SPEEDS = ['Auto negotiate', '1 Gigabit full duplex (auto)', '100 Megabit (auto)', '100 Megabit half duplex (forced)', '100 Megabit full duplex (forced)', '10 Megabit (auto)', '10 Megabit half duplex (forced)', '10 Megabit full duplex (forced)'];
const MGIG_SPEEDS = ['Auto negotiate', '10 Gigabit full duplex (auto)', '5 Gigabit full duplex (auto)', '2.5 Gigabit full duplex (auto)', '1 Gigabit full duplex (auto)', '100 Megabit (auto)', '100 Megabit full duplex (forced)'];
// The org-wide view carries fewer fields per port than the per-switch one.
const BY_SWITCH_FIELDS = ['portId', 'name', 'tags', 'enabled', 'poeEnabled', 'perpetualPoe', 'fastPoe', 'type', 'vlan', 'voiceVlan', 'allowedVlans', 'rstpEnabled', 'stpGuard', 'linkNegotiation', 'accessPolicyType', 'stickyMacAllowList', 'stickyMacAllowListLimit'];

// Uplinks are SFP cages; the MS390-48UX has multigigabit access ports.
function linkSpeeds(sw, port) {
  if (port.uplinkPort) return sw.info.uplinkSpeed === '10 Gbps' ? ['Auto negotiate', '10 Gigabit full duplex (forced)', '1 Gigabit full duplex (forced)'] : ['Auto negotiate', '1 Gigabit full duplex (forced)'];
  return [...(sw.model === 'MS390-48UX' ? MGIG_SPEEDS : GIG_SPEEDS)];
}

// Topology decides the defaults; anything written through the API sits on top.
function portConfig(net, sw, port) {
  const base = defaultPortConfig(net, sw, port);
  return port.config ? merge(base, port.config) : base;
}

// What a port starts with before its neighbors or writes change it.
export function portDefaults(sw, port) {
  return {
    portId: port.portId,
    name: null,
    tags: [],
    enabled: true,
    poeEnabled: !port.uplinkPort,
    perpetualPoe: { enabled: false },
    fastPoe: { enabled: false },
    type: 'trunk',
    vlan: 1,
    voiceVlan: null,
    allowedVlans: 'all',
    isolationEnabled: false,
    rstpEnabled: true,
    stpGuard: 'disabled',
    stpPortFastTrunk: false,
    linkNegotiation: 'Auto negotiate',
    linkNegotiationCapabilities: linkSpeeds(sw, port),
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
}

// VLANs and link speeds a port update has to stay within.
export function checkPortBody(sw, port, b) {
  for (const k of ['vlan', 'voiceVlan']) {
    const v = b[k];
    if (v != null && (v < 1 || v > 4094)) throw badRequest(`'${k}' must be a VLAN from 1 to 4094`);
  }
  const speeds = linkSpeeds(sw, port);
  if (b.linkNegotiation != null && !speeds.includes(b.linkNegotiation)) throw badRequest(`'linkNegotiation' must be one of: ${speeds.join(', ')}`);
}

function defaultPortConfig(net, sw, port) {
  const peer = port.peer?.device;
  const c = port.clients[0];
  const out = portDefaults(sw, port);
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

// A port's load in kB, from the switch's point of view. up and down are toward
// and away from the core.
export function portTraffic(sw, port, t0, t1) {
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
  // Switch view: "sent" leaves the port toward the device, so it is the device's download.
  const toward = dir === 1 && port.uplinkPort;
  const sent = toward ? load.sent : load.recv;
  const recv = toward ? load.recv : load.sent;
  return { ...load, sent, recv, up: toward ? sent : recv, down: toward ? recv : sent };
}

function portStatus(sw, port, t0, t1, now) {
  if (port.config?.enabled === false) {
    const zero = { total: 0, sent: 0, recv: 0 };
    return { portId: port.portId, enabled: false, status: 'Disabled', isUplink: port.isUplink, errors: [], warnings: [], speed: '', duplex: '', spanningTree: { statuses: [] }, poe: { isAllocated: false }, usageInKb: zero, clientCount: 0, powerUsageInWh: 0, trafficInKbps: zero, securePort: { enabled: false, active: false, authenticationStatus: 'Disabled', configOverrides: {} } };
  }
  const load = portTraffic(sw, port, t0, t1);
  const { sent, recv } = load;
  const connected = peerConnected(port, now);
  const secs = t1 - t0;
  const alertPort = sw.alerting && port === crcPort(sw);
  const seen = connected ? neighbor(port) : {};
  delete seen.cdp?.model; // the port status view's CDP block has no model
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
    ...seen,
    clientCount: load.clients,
    powerUsageInWh: round(load.wh, 1),
    trafficInKbps: { total: round(((sent + recv) * 8) / secs, 1), sent: round((sent * 8) / secs, 1), recv: round((recv * 8) / secs, 1) },
    securePort: { enabled: false, active: false, authenticationStatus: 'Disabled', configOverrides: {} },
  };
}

// The packet counter windows the real API snaps a requested span to.
const PACKET_WINDOWS = [300, 900, HOUR, DAY];
const PACKET_BYTES = 1100;
const PACKET_ROWS = ['Total', 'Broadcast', 'Multicast', 'CRC align errors', 'Fragments', 'Collisions', 'Topology changes'];

function packetWindow(q, now) {
  let span = DAY;
  if (q.has('timespan')) {
    if (q.has('t0')) throw badRequest("'timespan' cannot be combined with 't0'");
    span = Number(q.get('timespan'));
    if (!(span > 0) || span > DAY) throw badRequest(`'timespan' must be a number of seconds up to ${DAY}`);
  } else if (q.has('t0')) {
    const t0 = parseTime(q.get('t0'));
    if (Number.isNaN(t0)) throw badRequest("'t0' must be an ISO 8601 timestamp or epoch seconds");
    if (t0 >= now) throw badRequest("'t0' must be in the past");
    span = now - t0;
  }
  return PACKET_WINDOWS.reduce((best, w) => (Math.abs(w - span) < Math.abs(best - span) ? w : best));
}

// Seconds the link was up within [t0, t1).
function linkSeconds(sw, port, t0, t1) {
  const peer = port.peer?.device;
  if (peer) return Math.min(upSeconds(sw, t0, t1), upSeconds(peer, t0, t1));
  const c = port.clients[0];
  return c ? (presenceIn(c, t0, t1)?.seconds ?? 0) : 0;
}

// Data packets from the port's traffic, one ACK back for every two, plus
// broadcast and multicast (ARP, DHCP, mDNS, STP) while the link is up. Trunks
// carry more of those. Only the port with the CRC alert sees errors, and a
// port gets a topology change each time the device on it comes back up.
function portPackets(sw, port, t0, t1) {
  const secs = t1 - t0;
  const row = (desc, s, r) => {
    const sent = Math.round(s);
    const recv = Math.round(r);
    return { desc, total: sent + recv, sent, recv, ratePerSec: { total: Math.round((sent + recv) / secs), sent: Math.round(sent / secs), recv: Math.round(recv / secs) } };
  };
  if (port.config?.enabled === false) return { portId: port.portId, packets: PACKET_ROWS.map((desc) => row(desc, 0, 0)) };
  const up = linkSeconds(sw, port, t0, t1);
  const t = portTraffic(sw, port, t0, t1);
  const dataSent = (t.sent * 1024) / PACKET_BYTES;
  const dataRecv = (t.recv * 1024) / PACKET_BYTES;
  const peer = port.peer?.device;
  const trunk = port.uplinkPort || peer?.productType === 'wireless';
  const vary = 0.7 + unit(derive(sw.key, `packets:${port.portId}`), 0) * 0.6;
  const bcast = [up * (trunk ? 2 : 0.4) * vary, up * (trunk ? 0.3 : 0.05) * vary];
  const mcast = [up * (trunk ? 3 : 0.8) * vary, up * (trunk ? 1.5 : 0.2) * vary];
  const sent = dataSent + dataRecv / 2 + bcast[0] + mcast[0];
  const recv = dataRecv + dataSent / 2 + bcast[1] + mcast[1];
  const crc = sw.alerting && port === crcPort(sw) ? recv * 0.004 : 0;
  let changes = 0;
  if (peer) eachOutage(peer, t0, t1, (s, e) => e >= t0 && e < t1 && changes++);
  return {
    portId: port.portId,
    packets: [[sent, recv], bcast, mcast, [0, crc], [0, crc * 0.1], [0, 0], [changes, 0]].map(([s, r], i) => row(PACKET_ROWS[i], s, r)),
  };
}

// Takes single ports and ranges, as in "1" and "2-5".
function cyclePorts(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'switch');
  const { ports } = ctx.body;
  if (!ports.length) throw badRequest("'ports' must not be empty");
  const ids = new Set(dev.ports.map((p) => p.portId));
  for (const p of ports) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(p).trim());
    if (!m || !ids.has(m[1]) || (m[2] && (!ids.has(m[2]) || Number(m[2]) < Number(m[1])))) throw badRequest(`'${p}' is not a port or port range on this switch`);
  }
  return { ports };
}

function portOf(dev, portId) {
  const port = dev.ports.find((p) => p.portId === portId);
  if (!port) throw notFound('Port');
  return port;
}

// Neighbors a device sees on its own ports, in the lldpCdp format.
export function lldpCdp(dev, now) {
  const ports = {};
  if (isDown(dev, now)) return { sourceMac: dev.mac, ports };
  const describe = (sw, port) => ({
    lldp: {
      systemName: `Meraki ${sw.model} - ${sw.name}`,
      systemDescription: `Meraki ${sw.model} Cloud Managed Switch`,
      portId: port.portId,
      chassisId: sw.mac,
      managementAddress: sw.lanIp,
      systemCapabilities: 'Switch',
      ...switchVlans(sw, port),
    },
    deviceMac: sw.mac,
    device: { url: deviceUrl(sw) },
  });
  if (dev.productType === 'switch') {
    for (const port of dev.ports) {
      if (!peerConnected(port, now)) continue;
      const n = neighbor(port);
      if (!n.lldp) continue;
      ports[port.portId] = { lldp: { ...n.lldp, sourcePort: port.portId } };
      // This view's CDP block has the model where the port status view has a system name.
      if (n.cdp) {
        const { systemName, managementAddress, ...cdp } = n.cdp;
        ports[port.portId].cdp = { ...cdp, sourcePort: port.portId };
      }
      if (port.peer) Object.assign(ports[port.portId], { deviceMac: port.peer.device.mac, device: { url: deviceUrl(port.peer.device) } });
    }
  } else if (dev.switchPort) {
    const n = describe(dev.switchPort.switch, dev.switchPort);
    ports.wired0 = { ...n, lldp: { ...n.lldp, sourcePort: 'wired0' } };
  } else if (dev.productType === 'appliance' && dev.net.switches.length) {
    const core = dev.net.switches[0];
    const port = core.ports.find((p) => p.peer?.device === dev);
    if (port && !isDown(core, now)) {
      const n = describe(core, port);
      ports['3'] = { ...n, lldp: { ...n.lldp, sourcePort: '3' } };
    }
  }
  return { sourceMac: dev.mac, ports };
}

// Org-wide switch filters shared by the bySwitch endpoints.
export function orgSwitches(ctx) {
  const q = ctx.query;
  const networkIds = arrayParam(q, 'networkIds');
  const serials = arrayParam(q, 'serials');
  const macs = arrayParam(q, 'macs').map((m) => m.toLowerCase());
  const name = q.get('name')?.toLowerCase();
  const serial = q.get('serial')?.toUpperCase();
  const mac = q.get('mac')?.toLowerCase();
  return orgOf(ctx)
    .devices.filter(
      (d) =>
        d.productType === 'switch' &&
        (!networkIds.length || networkIds.includes(d.net.id)) &&
        (!serials.length || serials.includes(d.serial)) &&
        (!macs.length || macs.includes(d.mac)) &&
        (!name || (d.name ?? '').toLowerCase().includes(name)) &&
        (!serial || d.serial.includes(serial)) &&
        (!mac || d.mac.includes(mac)),
    )
    .sort(bySerial);
}

export const switchHeader = (sw) => ({ name: sw.name, serial: sw.serial, mac: sw.mac, network: { name: sw.net.name, id: sw.net.id }, model: sw.model });

// The live fields the org-wide status view carries, taken over the last five minutes.
function liveStatus(sw, port, now) {
  const s = portStatus(sw, port, now - 300, now, now);
  return {
    portId: s.portId,
    enabled: s.enabled,
    status: s.status,
    isUplink: s.isUplink,
    errors: s.errors,
    warnings: s.warnings,
    speed: s.speed,
    duplex: s.duplex,
    spanningTree: s.spanningTree,
    poe: s.poe,
    securePort: { active: false, authenticationStatus: 'Disabled' },
  };
}

export default [
  {
    op: 'getDeviceSwitchPorts',
    path: '/devices/{serial}/switch/ports',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      return dev.ports.map((p) => portConfig(dev.net, dev, p));
    },
  },
  {
    op: 'getDeviceSwitchPortsStatuses',
    path: '/devices/{serial}/switch/ports/statuses',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });
      return dev.ports.map((p) => portStatus(dev, p, t0, t1, ctx.now));
    },
  },
  {
    op: 'getDeviceSwitchPortsStatusesPackets',
    path: '/devices/{serial}/switch/ports/statuses/packets',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      const span = packetWindow(ctx.query, ctx.now);
      return dev.ports.map((p) => portPackets(dev, p, ctx.now - span, ctx.now));
    },
  },
  {
    op: 'cycleDeviceSwitchPorts',
    method: 'POST',
    status: 200,
    path: '/devices/{serial}/switch/ports/cycle',
    handler: cyclePorts,
  },
  {
    op: 'getDeviceSwitchPort',
    path: '/devices/{serial}/switch/ports/{portId}',
    sample: { portId: '1' },
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      return portConfig(dev.net, dev, portOf(dev, ctx.params.portId));
    },
  },
  {
    op: 'updateDeviceSwitchPort',
    method: 'PUT',
    path: '/devices/{serial}/switch/ports/{portId}',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'switch');
      const port = portOf(dev, ctx.params.portId);
      checkPortBody(dev, port, ctx.body);
      const { portId, ...patch } = ctx.body;
      port.config = merge(port.config || {}, patch);
      return portConfig(dev.net, dev, port);
    },
  },
  {
    op: 'getOrganizationSwitchPortsBySwitch',
    path: '/organizations/{organizationId}/switch/ports/bySwitch',
    handler: (ctx) => {
      const pick = (port) => Object.fromEntries(BY_SWITCH_FIELDS.filter((k) => k in port).map((k) => [k, port[k]]));
      const rows = orgSwitches(ctx).map((sw) => ({ ...switchHeader(sw), ports: sw.ports.map((p) => pick(portConfig(sw.net, sw, p))) }));
      return paginate(ctx, rows, (r) => r.serial, { def: 50, max: 50 });
    },
  },
  {
    op: 'getOrganizationSwitchPortsStatusesBySwitch',
    path: '/organizations/{organizationId}/switch/ports/statuses/bySwitch',
    handler: (ctx) => paginateItems(ctx, orgSwitches(ctx), (sw) => sw.serial, { def: 10, max: 20 }, (sw) => ({ ...switchHeader(sw), ports: sw.ports.map((p) => liveStatus(sw, p, ctx.now)) })),
  },
  {
    op: 'getNetworkSwitchSettings',
    path: '/networks/{networkId}/switch/settings',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'switch');
      return configOf(net).switchSettings;
    },
  },
  {
    op: 'updateNetworkSwitchSettings',
    method: 'PUT',
    path: '/networks/{networkId}/switch/settings',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'switch');
      return merge(configOf(net).switchSettings, ctx.body);
    },
  },
];
