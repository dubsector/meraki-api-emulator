// MS switch ports: configuration, live status and LLDP/CDP neighbors, per
// switch and across the organization.

import { configOf } from '../config.js';
import { arrayParam, notFound, paginate, timeWindow } from '../http.js';
import { crcPort } from '../sim/alerts.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { isOnline, presenceIn } from '../sim/presence.js';
import { WAN_RECV, WAN_SENT, clientUsage, networkTotals } from '../sim/usage.js';
import { DAY, HOUR } from '../time.js';
import { bySerial, devOf, netOf, orgOf, requireModel, requireProduct, round } from './common.js';

const NO_USAGE = { sent: 0, recv: 0, clients: 0, wh: 0 };

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

export function peerConnected(port, now) {
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
  const alertPort = sw.alerting && port === crcPort(sw);
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
    },
    deviceMac: sw.mac,
  });
  if (dev.productType === 'switch') {
    for (const port of dev.ports) {
      if (!peerConnected(port, now)) continue;
      const n = neighbor(port);
      if (!n.lldp) continue;
      ports[port.portId] = { lldp: { ...n.lldp, sourcePort: port.portId }, ...(n.cdp ? { cdp: { ...n.cdp, sourcePort: port.portId } } : {}) };
      if (port.peer) ports[port.portId].deviceMac = port.peer.device.mac;
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
function orgSwitches(ctx) {
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
        (!name || d.name.toLowerCase().includes(name)) &&
        (!serial || d.serial.includes(serial)) &&
        (!mac || d.mac.includes(mac)),
    )
    .sort(bySerial);
}

const switchHeader = (sw) => ({ name: sw.name, serial: sw.serial, mac: sw.mac, network: { name: sw.net.name, id: sw.net.id }, model: sw.model });

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
    op: 'getOrganizationSwitchPortsBySwitch',
    path: '/organizations/{organizationId}/switch/ports/bySwitch',
    handler: (ctx) => {
      const rows = orgSwitches(ctx).map((sw) => ({ ...switchHeader(sw), ports: sw.ports.map((p) => portConfig(sw.net, sw, p)) }));
      return paginate(ctx, rows, (r) => r.serial, { def: 50, max: 50 });
    },
  },
  {
    op: 'getOrganizationSwitchPortsStatusesBySwitch',
    path: '/organizations/{organizationId}/switch/ports/statuses/bySwitch',
    handler: (ctx) => {
      const switches = orgSwitches(ctx);
      const page = paginate(ctx, switches, (sw) => sw.serial, { def: 10, max: 20 });
      const end = page.length ? switches.indexOf(page[page.length - 1]) + 1 : switches.length;
      return {
        items: page.map((sw) => ({ ...switchHeader(sw), ports: sw.ports.map((p) => liveStatus(sw, p, ctx.now)) })),
        meta: { counts: { items: { total: switches.length, remaining: switches.length - end } } },
      };
    },
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
    op: 'getNetworkSwitchStacks',
    path: '/networks/{networkId}/switch/stacks',
    handler: (ctx) => {
      requireProduct(netOf(ctx), 'switch');
      return [];
    },
  },
];
