// JSON shapes for the core Dashboard API objects.

import { VLANS } from './catalog.js';

export function orgJson(org) {
  return {
    id: org.id,
    name: org.name,
    url: `https://dashboard.meraki.com/o/${org.slug}/manage/organization/overview`,
    api: { enabled: org.apiEnabled ?? true },
    licensing: { model: org.licensing },
    cloud: { region: { name: 'North America', host: { name: 'United States' } } },
    management: org.management ?? { details: [] },
  };
}

export function networkJson(net) {
  return {
    id: net.id,
    organizationId: net.org.id,
    name: net.name,
    productTypes: net.productTypes,
    timeZone: net.timeZone,
    tags: net.tags,
    enrollmentString: net.enrollmentString ?? null,
    url: net.url,
    notes: net.notes ?? '',
    isBoundToConfigTemplate: !!net.template,
  };
}

export function networkRef(net) {
  return { id: net.id, name: net.name, url: net.url, tags: net.tags };
}

// The Dashboard's node ID for a device, and its page in the network.
export function nodeId(dev) {
  return parseInt(dev.mac.replace(/:/g, '').slice(-8), 16);
}

export function deviceUrl(dev) {
  return dev.net.url.replace('/usage/list', `/nodes/new_list/${nodeId(dev)}`);
}

export function deviceJson(dev, { full = false } = {}) {
  const out = {
    name: dev.name,
    lat: dev.lat,
    lng: dev.lng,
    address: dev.address ?? dev.net.address,
    notes: dev.notes ?? '',
    tags: dev.tags,
    networkId: dev.net.id,
    serial: dev.serial,
    model: dev.model,
    mac: dev.mac,
    lanIp: dev.lanIp ?? null,
    firmware: dev.firmware,
    productType: dev.productType,
    details: [],
  };
  if (full) {
    out.url = deviceUrl(dev);
    out.floorPlanId = dev.floorPlanId ?? null;
    if (dev.productType === 'wireless') {
      out.beaconIdParams = { uuid: '4d52ab1c-0000-4a1e-9d6b-' + dev.net.id.slice(-12), major: dev.net.siteIndex, minor: dev.net.aps.indexOf(dev) + 1 };
    }
  }
  return out;
}

// Link-local IPv6 address from the MAC (EUI-64), in Meraki's uncompressed style.
function linkLocal(mac) {
  const b = mac.split(':').map((h) => parseInt(h, 16));
  b[0] ^= 0x02;
  const words = [(b[0] << 8) | b[1], (b[2] << 8) | 0xff, 0xfe00 | b[3], (b[4] << 8) | b[5]];
  return `fe80:0:0:0:${words.map((w) => w.toString(16)).join(':')}`;
}

function capabilities(c) {
  if (c.kindName === 'iot') return '802.11n - 2.4 GHz';
  if (c.kindName === 'scanner') return '802.11ac - 2.4 and 5 GHz';
  return c.ap.info.bands.includes('6') ? '802.11ax - 2.4, 5 and 6 GHz' : '802.11ax - 2.4 and 5 GHz';
}

export function recentDevice(c) {
  return c.wired ? c.switchPort.switch : c.ap;
}

export function clientJson(c, { usage, last, online }) {
  const dev = recentDevice(c);
  const sent = Math.round(usage.sent);
  const recv = Math.round(usage.recv);
  return {
    id: c.id,
    mac: c.mac,
    ip: c.ip,
    ip6: null,
    description: c.description,
    firstSeen: c.firstSeen,
    lastSeen: Math.floor(last),
    manufacturer: c.manufacturer,
    os: c.os,
    user: c.user,
    vlan: String(c.vlan),
    ssid: c.ssid ? c.ssid.name : null,
    switchport: c.switchport,
    wirelessCapabilities: c.wired ? null : capabilities(c),
    smInstalled: false,
    recentDeviceMac: dev.mac,
    status: online ? 'Online' : 'Offline',
    usage: { sent, recv, total: sent + recv },
    namedVlan: VLANS[c.vlan] ?? null,
    adaptivePolicyGroup: null,
    deviceTypePrediction: c.prediction,
    recentDeviceSerial: dev.serial,
    recentDeviceName: dev.name,
    recentDeviceConnection: c.wired ? 'Wired' : 'Wireless',
    notes: null,
    ip6Local: linkLocal(c.mac),
    groupPolicy8021x: null,
    pskGroup: null,
  };
}
