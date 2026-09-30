// Builds the static world (orgs, networks, devices, clients, switch ports) from a seed.

import { CLIENT_PROFILES, DEVICE_OUI, FIRST_NAMES, ISPS, KINDS, LAST_NAMES, MODELS, ORGS, SERIAL_PREFIX, SSIDS } from './catalog.js';
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

// APs and cameras get PoE ports first, then wired clients spread across switches.
function buildSwitchPorts(r, net) {
  if (!net.switches.length) return;
  const cursor = new Map(net.switches.map((s) => [s.serial, 0]));
  const ports = new Map();
  for (const sw of net.switches) {
    const total = sw.info.ports + sw.info.uplinks;
    sw.ports = [];
    for (let p = 1; p <= total; p++) {
      const uplinkPort = p > sw.info.ports;
      sw.ports.push({ portId: String(p), switch: sw, isUplink: false, uplinkPort, peer: null, clients: [] });
    }
    ports.set(sw.serial, sw.ports);
  }

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
    org.spares.push({ serial: d.serial, model: d.model, productType: d.productType, mac: d.mac, orderNumber: d.orderNumber, claimedAt: d.claimedAt, net: null, tags: d.tags, name: d.name });
  }
  const clients = new Set(net.clients);
  world.clients = world.clients.filter((c) => !clients.has(c));
  for (const c of clients) world.clientById.delete(c.id);
  if (org.hub === net) org.hub = null;
  net.deleted = true;
}
