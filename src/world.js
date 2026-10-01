// Builds the static world (orgs, networks, devices, clients, switch ports) from a seed.

import { CLIENT_PROFILES, DEVICE_OUI, FIRST_NAMES, ISPS, KINDS, LAST_NAMES, MODELS, ORGS, SERIAL_PREFIX, SSIDS } from './catalog.js';
import { configOf } from './config.js';
import { Rand, derive, hashStr } from './rng.js';
import { DAY, Zone } from './time.js';

const SERIAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

// Clients were first seen at a fixed point in the past so firstSeen never moves.
const FIRST_SEEN_ANCHOR = Date.UTC(2025, 0, 1) / 1000;

export function buildWorld({ seed = 1, bootTime = Date.now() / 1000 } = {}) {
  const r = new Rand(hashStr(`meraki-api-emulator:${seed}`));
  const used = new Set();
  const unique = (make) => {
    for (;;) {
      const v = make();
      if (!used.has(v)) {
        used.add(v);
        return v;
      }
    }
  };

  const world = {
    seed,
    orgs: [],
    networks: [],
    devices: [],
    clients: [],
    orgById: new Map(),
    networkById: new Map(),
    deviceBySerial: new Map(),
    clientById: new Map(),
    // A dormant device has been offline for a while; anchor it to the day the server started.
    dormantSince: Math.floor(bootTime / DAY) * DAY - 12 * DAY,
    bootDay: Math.floor(bootTime / DAY) * DAY,
    created: 0,
  };

  ORGS.forEach((orgTpl, orgIndex) => {
    const org = {
      id: unique(() => String(r.int(100000, 999999))),
      name: orgTpl.name,
      slug: unique(() => r.chars(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz')),
      networks: [],
    };
    world.orgs.push(org);
    world.orgById.set(org.id, org);

    orgTpl.networks.forEach((tpl) => {
      const siteIndex = world.networks.length + 1;
      const net = buildNetwork(r, unique, org, tpl, siteIndex);
      org.networks.push(net);
      world.networks.push(net);
      world.networkById.set(net.id, net);
      for (const d of net.devices) {
        world.devices.push(d);
        world.deviceBySerial.set(d.serial, d);
      }
      for (const c of net.clients) {
        world.clients.push(c);
        world.clientById.set(c.id, c);
      }
    });
    org.index = orgIndex;
    org.baseNetworks = [...org.networks];
  });

  for (const d of world.devices) if (d.dormant) d.dormantSince = world.dormantSince;
  for (const org of world.orgs) {
    org.devices = world.devices.filter((d) => d.net.org === org);
    org.hub = org.networks.find((n) => n.vpn === 'hub') || null;
  }
  buildAdminData(world, seed, bootTime);
  return world;
}

// Admins, spare inventory and licenses. They draw from their own stream so
// adding them never shifts the IDs above.
function buildAdminData(world, seed, bootTime) {
  const r = new Rand(hashStr(`meraki-api-emulator:${seed}:admin`));
  const bootDay = Math.floor(bootTime / DAY) * DAY;
  const ids = new Set();
  const adminId = () => {
    for (;;) {
      const id = r.digits(6);
      if (!ids.has(id)) return ids.add(id), id;
    }
  };
  const person = () => {
    const first = r.pick(FIRST_NAMES);
    const last = r.pick(LAST_NAMES);
    return { name: `${first} ${last}`, email: `${first}.${last}@example.com`.toLowerCase() };
  };
  const admin = (fields) => ({ id: adminId(), twoFactorAuthEnabled: true, hasApiKey: false, accountStatus: 'ok', tags: [], networks: [], activeHour: r.int(8, 17), ...fields });

  // Every API key acts as this admin, in every organization.
  world.apiAdmin = admin({ name: 'API Integration', email: 'api@example.com', orgAccess: 'full', hasApiKey: true, twoFactorAuthEnabled: false, api: true });
  const engineer = admin({ ...person(), orgAccess: 'full', hasApiKey: true });
  const [corp, lab] = world.orgs;
  const reno = corp.networks.find((n) => n.code === 'RNO');
  corp.admins = [
    admin({ ...person(), orgAccess: 'full' }),
    engineer,
    admin({ ...person(), orgAccess: 'read-only' }),
    admin({ ...person(), orgAccess: 'none', networks: [{ id: reno.id, access: 'full' }] }),
    admin({ ...person(), orgAccess: 'none', tags: [{ tag: 'retail', access: 'read-only' }] }),
    admin({ ...person(), orgAccess: 'read-only', accountStatus: 'unverified', twoFactorAuthEnabled: false }),
    world.apiAdmin,
  ];
  lab.admins = [engineer, admin({ ...person(), orgAccess: 'full', twoFactorAuthEnabled: false }), world.apiAdmin];
  for (const org of world.orgs) org.baseAdmins = [...org.admins];

  corp.licensing = 'co-term';
  lab.licensing = 'per-device';
  corp.cotermExpires = bootDay + 540 * DAY;

  // Devices were claimed in one order per network; spares came later.
  for (const org of world.orgs) {
    for (const net of org.networks) {
      const order = `4C${r.digits(7)}`;
      const claimed = Date.UTC(2023, 0, 1) / 1000 + r.int(0, 700) * DAY + r.int(15, 23) * 3600;
      for (const d of net.devices) Object.assign(d, { orderNumber: order, claimedAt: claimed + r.int(0, 300) });
    }
  }
  const spares = { 0: ['MR46', 'MS130-24P', 'MV22'], 1: ['MR36'] };
  for (const org of world.orgs) {
    const order = `4C${r.digits(7)}`;
    org.spares = spares[org.index].map((model) => {
      const info = MODELS[model];
      let serial;
      do serial = `${SERIAL_PREFIX[info.productType]}-${r.chars(4, SERIAL_CHARS)}-${r.chars(4, SERIAL_CHARS)}`;
      while (world.deviceBySerial.has(serial));
      return { serial, model, productType: info.productType, mac: macFrom(r, DEVICE_OUI[info.productType]), orderNumber: order, claimedAt: bootDay - 40 * DAY + r.int(9, 17) * 3600, net: null, tags: [], name: null };
    });
  }

  // Per-device licensing: one license per AP, one expiring soon, one unused.
  const licenseKey = () => `Z2${r.chars(10, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}`;
  const order = `4C${r.digits(7)}`;
  lab.licenses = lab.devices.map((d, i) => {
    const activation = d.claimedAt + 3600;
    const expires = i === 0 ? bootDay + 400 * DAY : bootDay + 45 * DAY;
    return { id: r.digits(6), licenseType: 'ENT', licenseKey: licenseKey(), orderNumber: order, deviceSerial: d.serial, networkId: d.net.id, claimDate: d.claimedAt, activationDate: activation, expirationDate: expires };
  });
  lab.licenses.push({ id: r.digits(6), licenseType: 'ENT', licenseKey: licenseKey(), orderNumber: order, deviceSerial: null, networkId: null, claimDate: bootDay - 40 * DAY, activationDate: null, expirationDate: null, durationInDays: 1095 });
}

function macFrom(r, oui) {
  return `${oui}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`;
}

function randomMac(r) {
  // Locally administered bit set, like phones using private Wi-Fi addresses.
  const first = ((r.int(0, 255) & 0xfc) | 0x02).toString(16).padStart(2, '0');
  return `${first}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`;
}

function buildNetwork(r, unique, org, tpl, siteIndex) {
  const productTypes = [];
  if (tpl.mx) productTypes.push('appliance');
  if (tpl.switches) productTypes.push('switch');
  if (tpl.aps) productTypes.push('wireless');
  if (tpl.cameras) productTypes.push('camera');
  const combined = productTypes.length > 1;

  const net = {
    id: unique(() => (combined ? 'L_' : 'N_') + r.digits(18)),
    org,
    code: tpl.code,
    name: tpl.name,
    kind: tpl.kind,
    timeZone: tpl.tz,
    zone: new Zone(tpl.tz),
    tags: tpl.tags,
    address: tpl.address,
    lat: tpl.lat,
    lng: tpl.lng,
    productTypes,
    vpn: tpl.vpn || null,
    siteIndex,
    subnet: (vlan) => `10.${siteIndex}.${vlan}`,
    ssids: (tpl.ssids || []).map((key, number) => ({ number, key, ...SSIDS[key] })),
    devices: [],
    clients: [],
    key: 0,
  };
  net.key = hashStr(net.id);
  net.url = `https://n${100 + siteIndex}.meraki.com/${tpl.code}/n/${r.chars(8, SERIAL_CHARS)}/manage/usage/list`;

  const addDevice = (model, name, extra = {}) => {
    const info = MODELS[model];
    const serial = unique(() => `${SERIAL_PREFIX[info.productType]}-${r.chars(4, SERIAL_CHARS)}-${r.chars(4, SERIAL_CHARS)}`);
    const dev = {
      serial,
      name,
      model,
      productType: info.productType,
      firmware: info.firmware,
      mac: unique(() => macFrom(r, DEVICE_OUI[info.productType])),
      net,
      info,
      tags: [],
      lat: tpl.lat + (r.next() - 0.5) * 0.002,
      lng: tpl.lng + (r.next() - 0.5) * 0.002,
      key: hashStr(serial),
      outageRate: { appliance: 0.004, switch: 0.008, wireless: 0.02, camera: 0.03 }[info.productType],
      ...extra,
    };
    net.devices.push(dev);
    return dev;
  };

  let mgmtHost = 2;
  if (tpl.mx) {
    net.mx = addDevice(tpl.mx.model, `MX-${tpl.code}`, { lanIp: null });
    net.mx.uplinks = tpl.mx.wan.map((isp, i) => ({
      interface: `wan${i + 1}`,
      isp,
      ...ISPS[isp],
      publicIp: i === 0 ? `198.51.100.${10 + siteIndex}` : `203.0.113.${10 + siteIndex}`,
      gateway: i === 0 ? `198.51.100.1` : `203.0.113.1`,
      key: derive(net.mx.key, `wan${i + 1}`),
    }));
    net.mx.tags = ['edge'];
  }

  net.switches = (tpl.switches || []).map((s) =>
    addDevice(s.model, `SW-${tpl.code}-${s.name}`, { lanIp: `${net.subnet(1)}.${mgmtHost++}`, alerting: !!s.alerting, ports: [] }),
  );
  net.aps = tpl.aps
    ? tpl.aps.names.map((n) =>
        addDevice(tpl.aps.model, `AP-${tpl.code}-${n}`, { lanIp: `${net.subnet(1)}.${mgmtHost++}`, flaky: tpl.aps.flaky === n, tags: n === 'Lobby' ? ['lobby'] : [] }),
      )
    : [];
  if (net.aps.some((a) => a.flaky)) net.aps.find((a) => a.flaky).outageRate = 0;
  net.cameras = tpl.cameras
    ? tpl.cameras.names.map((n) =>
        addDevice(tpl.cameras.model, `CAM-${tpl.code}-${n}`, { lanIp: `${net.subnet(1)}.${mgmtHost++}`, dormant: tpl.cameras.dormant === n }),
      )
    : [];

  buildClients(r, unique, net, tpl);
  buildSwitchPorts(r, net);
  return net;
}

function buildClients(r, unique, net, tpl) {
  const hostCounter = {};
  for (const [kindName, spec] of Object.entries(tpl.clients)) {
    const [count, schedule] = Array.isArray(spec) ? spec : [spec, null];
    const kind = KINDS[kindName];
    for (let i = 0; i < count; i++) {
      const profile = r.pick(CLIENT_PROFILES[kindName]);
      const first = r.pick(FIRST_NAMES);
      const last = r.pick(LAST_NAMES);
      const user = (first[0] + last).toLowerCase();
      const mac = unique(() => (profile.randomMac && r.chance(profile.randomMac)) || !profile.oui.length ? randomMac(r) : macFrom(r, r.pick(profile.oui)));
      const privateMac = /^.[26ae]/.test(mac) && !profile.oui.some((o) => mac.startsWith(o));
      const canWire = net.switches.length > 0;
      const wired = canWire && (kind.wired || (kind.wiredShare && r.chance(kind.wiredShare)) || net.aps.length === 0);
      const ssid = wired ? null : net.ssids.find((s) => s.key === kind.ssid) || net.ssids[0];
      const vlan = wired ? kind.vlan : ssid.vlan;
      hostCounter[vlan] = (hostCounter[vlan] || 0) + 1;
      const n = hostCounter[vlan];
      const c = {
        id: unique(() => 'k' + r.hex(6)),
        mac,
        kindName,
        kind,
        schedule: schedule || kind.schedule,
        net,
        manufacturer: privateMac ? null : profile.manufacturer,
        os: profile.os,
        prediction: profile.prediction,
        description: profile.host(user, r, first, mac, i),
        user: ssid && ssid.auth === '8021x' ? user : null,
        wired,
        ssid,
        vlan,
        ip: `10.${net.siteIndex}.${vlan + Math.floor((n - 1) / 250)}.${10 + ((n - 1) % 250)}`,
        firstSeen: Math.floor(FIRST_SEEN_ANCHOR - r.next() * 400 * DAY),
        habit: r.next(),
        shift: r.int(0, 1),
        attend: 0.85 + r.next() * 0.15,
        key: 0,
      };
      c.key = hashStr(c.id + c.mac);
      c.switchport = null;
      if (!wired) attachWireless(r, c);
      net.clients.push(c);
    }
  }
}

function attachWireless(r, c) {
  const net = c.net;
  c.wired = false;
  c.ssid = c.ssid || net.ssids.find((s) => s.key === c.kind.ssid) || net.ssids[0];
  c.ap = r.weighted(net.aps, (a) => (a.name.endsWith('Lobby') ? 2.5 : 1 + (hashStr(a.serial) % 7) / 10));
  const bands = c.ap.info.bands;
  c.band = bands.includes('6') && r.chance(0.2) ? '6' : r.chance(0.8) ? '5' : '2.4';
}

function makePorts(sw) {
  const ports = [];
  for (let p = 1; p <= sw.info.ports + sw.info.uplinks; p++) {
    ports.push({ portId: String(p), switch: sw, isUplink: false, uplinkPort: p > sw.info.ports, peer: null, clients: [] });
  }
  return ports;
}

// APs and cameras get PoE ports first, then wired clients spread across switches.
function buildSwitchPorts(r, net) {
  if (!net.switches.length) return;
  const cursor = new Map(net.switches.map((s) => [s.serial, 0]));
  for (const sw of net.switches) sw.ports = makePorts(sw);

  const core = net.switches[0];
  // Core uplinks to the MX; every other switch uplinks to a core uplink port.
  const coreUp = core.ports.filter((p) => p.uplinkPort);
  if (net.mx) Object.assign(coreUp[0], { isUplink: true, peer: { device: net.mx, portId: '3' } });
  net.switches.slice(1).forEach((sw, i) => {
    const mine = sw.ports.find((p) => p.uplinkPort);
    const theirs = coreUp[i + 1];
    Object.assign(mine, { isUplink: true, peer: { device: core, portId: theirs.portId } });
    Object.assign(theirs, { peer: { device: sw, portId: mine.portId } });
  });

  let rr = 0;
  const nextPort = () => {
    for (let tries = 0; tries < net.switches.length; tries++) {
      const sw = net.switches[rr++ % net.switches.length];
      const i = cursor.get(sw.serial);
      if (i < sw.info.ports) {
        cursor.set(sw.serial, i + 1);
        return sw.ports[i];
      }
    }
    return null;
  };

  for (const dev of [...net.aps, ...net.cameras]) {
    const port = nextPort();
    if (!port) break;
    port.peer = { device: dev, portId: '0' };
    dev.switchPort = port;
  }
  for (const c of net.clients) {
    if (!c.wired) continue;
    const port = nextPort();
    if (!port) {
      attachWireless(r, c);
      continue;
    }
    port.clients.push(c);
    c.switchPort = port;
    c.switchport = port.portId;
  }
}

// ── Changes made through the API ──

// Seeded IDs for things created at runtime, so the same calls give the same IDs.
function nextRand(world, kind) {
  return new Rand(hashStr(`meraki-api-emulator:${world.seed}:${kind}:${world.created++}`));
}

export function addOrganization(world, name) {
  const r = nextRand(world, 'org');
  let id;
  do id = String(r.int(100000, 999999));
  while (world.orgById.has(id));
  const org = {
    id,
    name,
    slug: r.chars(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'),
    networks: [],
    baseNetworks: [],
    devices: [],
    spares: [],
    admins: [world.apiAdmin],
    licensing: 'co-term',
    cotermExpires: world.bootDay + 365 * DAY,
    hub: null,
    index: world.orgs.length,
    created: true,
  };
  world.orgs.push(org);
  world.orgById.set(org.id, org);
  return org;
}

export function removeOrganization(world, org) {
  world.orgs.splice(world.orgs.indexOf(org), 1);
  world.orgById.delete(org.id);
}

// An empty network: no devices or clients, so every stats endpoint reports nothing.
export function addNetwork(world, org, { name, productTypes, tags = [], timeZone = 'America/Los_Angeles', notes = '' }) {
  const r = nextRand(world, 'network');
  let id;
  do id = (productTypes.length > 1 ? 'L_' : 'N_') + r.digits(18);
  while (world.networkById.has(id));
  const siteIndex = 100 + world.created;
  const net = {
    id,
    org,
    code: 'NET',
    name,
    kind: 'office',
    timeZone,
    zone: new Zone(timeZone),
    tags,
    notes,
    address: '',
    lat: 0,
    lng: 0,
    productTypes,
    vpn: null,
    siteIndex,
    subnet: (vlan) => `10.${siteIndex % 256}.${vlan}`,
    ssids: [],
    devices: [],
    clients: [],
    mx: null,
    switches: [],
    aps: [],
    cameras: [],
    key: hashStr(id),
    created: true,
  };
  net.url = `https://n${siteIndex}.meraki.com/${org.slug}/n/${r.chars(8, SERIAL_CHARS)}/manage/usage/list`;
  org.networks.push(net);
  world.networks.push(net);
  world.networkById.set(net.id, net);
  return net;
}

// Deleting a network returns its devices to the organization's inventory.
export function removeNetwork(world, net) {
  const org = net.org;
  const gone = new Set(net.devices);
  for (const list of [org.networks, world.networks]) list.splice(list.indexOf(net), 1);
  world.networkById.delete(net.id);
  world.devices = world.devices.filter((d) => !gone.has(d));
  org.devices = org.devices.filter((d) => !gone.has(d));
  for (const d of gone) {
    world.deviceBySerial.delete(d.serial);
    org.spares.push(spareOf(d));
  }
  dropClients(world, net, new Set(net.clients));
  if (org.hub === net) org.hub = null;
  net.deleted = true;
}

// ── Claiming, removing and swapping devices ──

// The inventory entry a device leaves behind. Its license stays with it.
function spareOf(dev) {
  for (const l of dev.net.org.licenses || []) if (l.deviceSerial === dev.serial) l.networkId = null;
  return { serial: dev.serial, model: dev.model, productType: dev.productType, mac: dev.mac, orderNumber: dev.orderNumber, claimedAt: dev.claimedAt, net: null, tags: dev.tags, name: dev.name };
}

function dropClients(world, net, gone) {
  if (!gone.size) return;
  net.clients = net.clients.filter((c) => !gone.has(c));
  world.clients = world.clients.filter((c) => !gone.has(c));
  for (const c of gone) world.clientById.delete(c.id);
}

// Settings are built from the topology the first time they're read. A network
// keeps its settings when devices come and go, so build them all first.
function settle(org) {
  for (const net of org.networks) configOf(net);
}

// Events, usage and the change history are cached per day from the devices and
// clients, and a hub's events mention its spokes, so the whole org starts over.
function dropCaches(org) {
  for (const net of org.networks) for (const k of ['eventCache', 'securityCache', 'usageCache']) delete net[k];
  delete org.changeCache;
}

export function serialTaken(world, serial) {
  return world.deviceBySerial.has(serial) || world.orgs.some((o) => o.spares.some((s) => s.serial === serial));
}

function nextLanIp(net) {
  const prefix = `${net.subnet(1)}.`;
  const used = net.devices.filter((d) => d.lanIp?.startsWith(prefix)).map((d) => Number(d.lanIp.slice(prefix.length)));
  return prefix + (Math.max(1, ...used) + 1);
}

// A claimed device checks in right away and never goes down. It starts with no
// clients: a switch gets empty ports and an MX one DHCP uplink. Claiming a new
// kind of device adds its product type to the network.
export function claimDevice(world, net, spare) {
  const org = net.org;
  settle(org);
  const i = org.spares.indexOf(spare);
  if (i >= 0) org.spares.splice(i, 1);
  const info = MODELS[spare.model];
  const pt = info.productType;
  const dev = {
    serial: spare.serial,
    name: spare.name,
    model: spare.model,
    productType: pt,
    firmware: info.firmware,
    mac: spare.mac,
    net,
    info,
    tags: spare.tags,
    lat: net.lat,
    lng: net.lng,
    key: hashStr(spare.serial),
    outageRate: 0,
    orderNumber: spare.orderNumber,
    claimedAt: spare.claimedAt,
    lanIp: pt === 'appliance' ? null : nextLanIp(net),
  };
  if (pt === 'appliance') {
    const host = 10 + (net.siteIndex % 240);
    dev.uplinks = [{ interface: 'wan1', isp: 'cable', ...ISPS.cable, publicIp: `198.51.100.${host}`, gateway: '198.51.100.1', key: derive(dev.key, 'wan1') }];
    if (!net.mx) net.mx = dev;
  } else if (pt === 'switch') {
    dev.ports = makePorts(dev);
    net.switches.push(dev);
  } else if (pt === 'wireless') {
    net.aps.push(dev);
  } else if (pt === 'camera') {
    net.cameras.push(dev);
  }
  if (!net.productTypes.includes(pt)) net.productTypes.push(pt);
  net.devices.push(dev);
  org.devices.push(dev);
  world.devices.push(dev);
  world.deviceBySerial.set(dev.serial, dev);
  for (const l of org.licenses || []) if (l.deviceSerial === dev.serial) l.networkId = net.id;
  dropCaches(org);
  return dev;
}

// A brand new virtual MX, straight into the network.
export function claimVmx(world, net, model, now) {
  const r = nextRand(world, 'vmx');
  let serial;
  do serial = `${SERIAL_PREFIX.appliance}-${r.chars(4, SERIAL_CHARS)}-${r.chars(4, SERIAL_CHARS)}`;
  while (serialTaken(world, serial));
  return claimDevice(world, net, { serial, model, mac: macFrom(r, DEVICE_OUI.appliance), orderNumber: null, claimedAt: now, tags: [], name: null });
}

// Removing a device returns it to inventory along with what hung off it: an
// AP's clients roam to the other APs (or leave with the last one), a switch's
// wired clients are unplugged, and a network without its MX leaves AutoVPN.
export function removeDevice(world, dev) {
  const net = dev.net;
  const org = net.org;
  settle(org);
  for (const list of [net.devices, net.aps, net.switches, net.cameras, org.devices, world.devices]) {
    const i = list.indexOf(dev);
    if (i >= 0) list.splice(i, 1);
  }
  world.deviceBySerial.delete(dev.serial);
  org.spares.push(spareOf(dev));

  const gone = new Set();
  if (dev.productType === 'wireless') {
    for (const c of net.clients) {
      if (c.ap !== dev) continue;
      if (!net.aps.length) gone.add(c);
      else {
        c.ap = net.aps[c.key % net.aps.length];
        if (!c.ap.info.bands.includes(c.band)) c.band = '5';
      }
    }
  }
  for (const port of dev.ports || []) {
    for (const c of port.clients) gone.add(c);
    if (port.peer?.device.switchPort === port) port.peer.device.switchPort = null;
  }
  for (const sw of net.switches) for (const port of sw.ports) if (port.peer?.device === dev) port.peer = null;
  if (net.mx === dev) {
    net.mx = net.devices.find((d) => d.productType === 'appliance') || null;
    if (!net.mx) {
      if (org.hub === net) org.hub = null;
      net.vpn = null;
    }
  }
  dropClients(world, net, gone);
  dropCaches(org);
}

// The new device takes the old one's place with all its settings and links.
// The old one goes back to inventory, or leaves it and frees its license.
export function swapDevice(world, dev, spare, afterAction) {
  const org = dev.net.org;
  settle(org);
  const old = spareOf(dev);
  org.spares.splice(org.spares.indexOf(spare), 1);
  if (afterAction === 'remove from network') org.spares.push(old);
  else for (const l of org.licenses || []) if (l.deviceSerial === old.serial) Object.assign(l, { deviceSerial: null, networkId: null });
  world.deviceBySerial.delete(dev.serial);
  Object.assign(dev, { serial: spare.serial, mac: spare.mac, model: spare.model, info: MODELS[spare.model], orderNumber: spare.orderNumber, claimedAt: spare.claimedAt });
  delete dev.memoryCache; // sized to the old model's RAM
  world.deviceBySerial.set(dev.serial, dev);
  for (const l of org.licenses || []) if (l.deviceSerial === dev.serial) l.networkId = dev.net.id;
  if (dev.productType === 'wireless') for (const c of dev.net.clients) if (c.ap === dev && !dev.info.bands.includes(c.band)) c.band = '5';
  dropCaches(org);
  return old;
}
