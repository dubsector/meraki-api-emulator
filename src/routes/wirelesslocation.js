// Wireless Bluetooth, location scanning, MQTT, billing and the alternate
// management interface. There is no Bluetooth client sim, and scanning
// receivers and MQTT settings only store where data would go.

import { stored, uuid } from '../config.js';
import { arrayParam, badRequest, boolParam, notFound, paginate, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { DAY } from '../time.js';
import { inRange, ipInCidr, isIpv6, parseIp } from '../validate.js';
import { checkHttpUrl } from '../webhooks.js';
import { byId, collection, devOf, orgOf, requireModel } from './common.js';
import { isMask, prefixOf } from './switchsettings.js';
import { wirelessNet, wirelessNets } from './wireless.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const MAX_INT = 2147483647;
const BY_NETWORK = { def: 50, max: 250 };

const rand = (ctx, kind, id) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${id}`));

function wirelessNetIn(org, id) {
  const net = org.networks.find((n) => n.id === id);
  if (!net) throw badRequest(`Network '${id}' is not in this organization`);
  if (!net.productTypes.includes('wireless')) throw badRequest(`Network '${id}' has no wireless devices`);
  return net;
}

function wirelessAp(ctx) {
  const ap = devOf(ctx);
  requireModel(ap, 'wireless');
  return ap;
}

// ── Bluetooth ──

const bluetoothOf = (net) =>
  stored(net, 'wirelessBluetooth', () => ({ scanningEnabled: false, advertisingEnabled: false, uuid: uuid(net.key, 'bluetooth'), majorMinorAssignmentMode: 'Unique', major: 1, minor: 1, eslEnabled: false }));

// Major and minor only show in Non-unique mode, where every AP shares them.
function bluetoothJson(net) {
  const { major, minor, eslEnabled, ...s } = bluetoothOf(net);
  return s.majorMinorAssignmentMode === 'Unique' ? { ...s, eslEnabled } : { ...s, major, minor, eslEnabled };
}

function checkBeacon(b) {
  if (b.uuid != null && !UUID_RE.test(b.uuid)) throw badRequest("'uuid' must be a UUID like 00000000-0000-0000-0000-000000000000");
  inRange(b.major, 0, 65535, 'major');
  inRange(b.minor, 0, 65535, 'minor');
}

function updateBluetooth(ctx) {
  const net = wirelessNet(ctx);
  const s = bluetoothOf(net);
  const b = ctx.body;
  checkBeacon(b);
  const mode = b.majorMinorAssignmentMode ?? s.majorMinorAssignmentMode;
  if (mode === 'Unique' && (b.major != null || b.minor != null)) throw badRequest("'major' and 'minor' can only be set in 'Non-unique' mode");
  for (const k of ['scanningEnabled', 'advertisingEnabled', 'major', 'minor']) if (b[k] != null) s[k] = b[k];
  if (b.uuid !== undefined) s.uuid = b.uuid?.toLowerCase() ?? uuid(net.key, 'bluetooth');
  s.majorMinorAssignmentMode = mode;
  return bluetoothJson(net);
}

// In Unique mode the network gets one major and each AP its own minor.
function deviceBluetoothJson(ctx, ap) {
  const s = bluetoothOf(ap.net);
  const own = ap.bluetooth ?? {};
  const unique = s.majorMinorAssignmentMode === 'Unique';
  return {
    uuid: own.uuid ?? s.uuid,
    major: own.major ?? (unique ? rand(ctx, 'bluetoothMajor', ap.net.id).int(1, 65535) : s.major),
    minor: own.minor ?? (unique ? rand(ctx, 'bluetoothMinor', ap.serial).int(1, 65535) : s.minor),
  };
}

// A null resets the value to the one Dashboard picks.
function updateDeviceBluetooth(ctx) {
  const ap = wirelessAp(ctx);
  const b = ctx.body;
  checkBeacon(b);
  const own = (ap.bluetooth ??= {});
  for (const k of ['uuid', 'major', 'minor']) {
    if (b[k] === null) delete own[k];
    else if (b[k] !== undefined) own[k] = k === 'uuid' ? b[k].toLowerCase() : b[k];
  }
  return deviceBluetoothJson(ctx, ap);
}

function bluetoothClients(ctx) {
  wirelessNet(ctx);
  timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, lookback: 7 * DAY });
  boolParam(ctx.query, 'includeConnectivityHistory');
  return paginate(ctx, [], (c) => c.id, { def: 10, max: 1000, min: 5 });
}

// ── Alternate management interface ──

const PROTOCOLS = ['radius', 'snmp', 'syslog', 'ldap'];

// Kept on the network, not its config, since it gives the network's own APs addresses.
const amiOf = (net) => (net.wirelessAlternateManagement ??= { enabled: false, vlanId: null, protocols: [], accessPoints: [] });

function amiJson(net) {
  const a = amiOf(net);
  const accessPoints = a.accessPoints.filter((x) => net.aps.includes(x.dev)).map(({ dev, ...x }) => ({ serial: dev.serial, ...x }));
  return { enabled: a.enabled, vlanId: a.vlanId, protocols: [...a.protocols], accessPoints };
}

function checkAccessPoints(net, list) {
  const seen = new Set();
  const ips = new Set();
  return list.flatMap((x, i) => {
    const at = `accessPoints[${i}]`;
    if (typeof x.serial !== 'string' || typeof x.alternateManagementIp !== 'string') throw badRequest(`'${at}' needs 'serial' and 'alternateManagementIp'`);
    const dev = net.aps.find((d) => d.serial === x.serial);
    if (!dev) throw badRequest(`Access point '${x.serial}' is not in this network`);
    if (seen.has(dev)) throw badRequest(`Access point '${x.serial}' is listed more than once`);
    seen.add(dev);
    // An empty address removes the AP's assignment.
    if (x.alternateManagementIp === '') return [];
    if (parseIp(x.alternateManagementIp) == null) throw badRequest(`'${at}.alternateManagementIp' must be an IPv4 address`);
    if (ips.has(x.alternateManagementIp)) throw badRequest(`${x.alternateManagementIp} is given to more than one access point`);
    ips.add(x.alternateManagementIp);
    const user = net.devices.find((d) => d.lanIp === x.alternateManagementIp);
    if (user) throw badRequest(`${x.alternateManagementIp} is the LAN address of ${user.name}`);
    if (x.subnetMask && !isMask(x.subnetMask)) throw badRequest(`'${at}.subnetMask' must be a subnet mask like 255.255.255.0`);
    for (const k of ['gateway', 'dns1', 'dns2']) if (x[k] && parseIp(x[k]) == null) throw badRequest(`'${at}.${k}' must be an IPv4 address`);
    if (x.subnetMask && x.gateway) {
      if (!ipInCidr(x.gateway, `${x.alternateManagementIp}/${prefixOf(x.subnetMask)}`)) throw badRequest(`'${at}.gateway' must be in the same subnet as ${x.alternateManagementIp}`);
      if (x.gateway === x.alternateManagementIp) throw badRequest(`'${at}.gateway' must not be the access point's own address`);
    }
    return [{ dev, alternateManagementIp: x.alternateManagementIp, subnetMask: x.subnetMask || null, gateway: x.gateway || null, dns1: x.dns1 || null, dns2: x.dns2 || null }];
  });
}

function updateAmi(ctx) {
  const net = wirelessNet(ctx);
  const b = ctx.body;
  const a = amiOf(net);
  inRange(b.vlanId, 1, 4094, 'vlanId');
  const vlanId = b.vlanId ?? a.vlanId;
  let protocols = a.protocols;
  if (b.protocols) {
    if (new Set(b.protocols).size !== b.protocols.length) throw badRequest("'protocols' lists a protocol more than once");
    protocols = PROTOCOLS.filter((p) => b.protocols.includes(p));
  }
  const enabled = b.enabled ?? a.enabled;
  if (enabled && (vlanId == null || !protocols.length)) throw badRequest("'vlanId' and 'protocols' must be set to enable the alternate management interface");
  // An empty list removes every assignment; leaving it out keeps them.
  const accessPoints = b.accessPoints ? checkAccessPoints(net, b.accessPoints) : a.accessPoints;
  Object.assign(a, { enabled, vlanId, protocols: [...protocols], accessPoints });
  return amiJson(net);
}

// Stored on the AP and only echoed back; nothing reads it yet.
function updateAmiIpv6(ctx) {
  const ap = wirelessAp(ctx);
  const given = ctx.body.addresses;
  if (given == null) return { addresses: structuredClone(ap.wirelessAmiAddresses ?? []) };
  const seen = new Set();
  const addresses = given.map((x, i) => {
    const at = `addresses[${i}]`;
    const protocol = x.protocol ?? 'ipv6';
    const mode = x.assignmentMode ?? 'static';
    const valid = protocol === 'ipv6' ? isIpv6 : (v) => parseIp(v) != null;
    if (seen.has(protocol)) throw badRequest(`'addresses' lists more than one ${protocol} address`);
    seen.add(protocol);
    const servers = x.nameservers?.addresses ?? [];
    if (servers.length > 2) throw badRequest(`'${at}.nameservers.addresses' takes up to 2 addresses`);
    for (const s of servers) if (!valid(s)) throw badRequest(`'${at}.nameservers.addresses' must hold ${protocol} addresses`);
    const out = { protocol, assignmentMode: mode, address: null, gateway: null, prefix: null, nameservers: { addresses: [...servers] } };
    if (mode === 'dynamic') return out;
    if (typeof x.address !== 'string' || !valid(x.address)) throw badRequest(`'${at}.address' must be an ${protocol} address for static assignment`);
    if (x.gateway != null && !valid(x.gateway)) throw badRequest(`'${at}.gateway' must be an ${protocol} address`);
    if (protocol === 'ipv6') {
      const [net, bits] = String(x.prefix ?? '').split('/');
      if (!isIpv6(net) || !/^\d{1,3}$/.test(bits ?? '') || Number(bits) > 128) throw badRequest(`'${at}.prefix' must be an IPv6 prefix like 2001:db8:3c4d:15::/64`);
    }
    return { ...out, address: x.address, gateway: x.gateway ?? null, prefix: protocol === 'ipv6' ? x.prefix : null };
  });
  ap.wirelessAmiAddresses = addresses;
  return { addresses: structuredClone(addresses) };
}

// ── Billing ──

const MAX_PLANS = 5;
const billingOf = (net) => stored(net, 'wirelessBilling', () => ({ currency: 'USD', created: 0, plans: [] }));

function billingJson(net) {
  const s = billingOf(net);
  return { currency: s.currency, plans: structuredClone(s.plans) };
}

// The plans list replaces the old one; a plan with an ID updates that plan.
function updateBilling(ctx) {
  const net = wirelessNet(ctx);
  const s = billingOf(net);
  const b = ctx.body;
  if (b.currency != null && !/^[A-Z]{3}$/.test(b.currency)) throw badRequest("'currency' must be a three letter currency code like USD");
  let plans = s.plans;
  let created = s.created;
  if (b.plans) {
    if (b.plans.length > MAX_PLANS) throw badRequest(`'plans' is limited to ${MAX_PLANS} plans`);
    const ids = new Set();
    plans = b.plans.map((p, i) => {
      const at = `plans[${i}]`;
      if (p.id != null) {
        if (!s.plans.some((x) => x.id === p.id)) throw badRequest(`Billing plan '${p.id}' does not exist in this network`);
        if (ids.has(p.id)) throw badRequest(`Billing plan '${p.id}' is listed more than once`);
        ids.add(p.id);
      }
      if (typeof p.price !== 'number' || p.price < 0) throw badRequest(`'${at}.price' must be a number of at least 0`);
      if (p.timeLimit == null) throw badRequest(`'${at}.timeLimit' is required`);
      const limits = p.bandwidthLimits ?? {};
      for (const k of ['limitUp', 'limitDown']) inRange(limits[k], 0, MAX_INT, `${at}.bandwidthLimits.${k}`);
      return { id: p.id ?? String(++created), price: p.price, bandwidthLimits: { limitUp: limits.limitUp ?? null, limitDown: limits.limitDown ?? null }, timeLimit: p.timeLimit };
    });
  }
  Object.assign(s, { currency: b.currency ?? s.currency, created, plans });
  return billingJson(net);
}

// ── Location scanning ──

const scanningOf = (ctx, net) => stored(net, 'wirelessLocationScanning', () => ({ enabled: false, api: { enabled: false }, validator: rand(ctx, 'scanningValidator', net.id).hex(40) }));

function scanningJson(ctx, net) {
  const s = scanningOf(ctx, net);
  return { enabled: s.enabled, api: { enabled: s.api.enabled, validator: { string: s.validator } } };
}

// Turning analytics off turns the push API off with it.
function updateScanning(ctx) {
  const net = wirelessNet(ctx);
  const s = scanningOf(ctx, net);
  const b = ctx.body;
  const enabled = b.enabled ?? s.enabled;
  const api = enabled && (b.api?.enabled ?? s.api.enabled);
  if (b.api?.enabled && !enabled) throw badRequest('The scanning API can only be enabled when location analytics is enabled');
  s.enabled = enabled;
  s.api.enabled = api;
  return scanningJson(ctx, net);
}

const MAX_RECEIVERS = 100;
const VERSIONS = ['2', '3'];
const RADIOS = ['Wi-Fi', 'Bluetooth'];

// Org-wide; receivers of a network that is gone drop out.
function receiversOf(org) {
  const store = (org.wirelessScanningReceivers ??= { created: 0, list: [] });
  if (store.list.some((r) => !org.networks.some((n) => n.id === r.networkId))) store.list = store.list.filter((r) => org.networks.some((n) => n.id === r.networkId));
  return store;
}

function receiverJson(r, org) {
  const net = org.networks.find((n) => n.id === r.networkId);
  return { network: { id: net.id, name: net.name }, receiverId: r.receiverId, url: r.url, version: r.version, radio: { type: r.radioType } };
}

function checkReceiver(ctx, org, b, self) {
  if (!self && typeof b.network.id !== 'string') throw badRequest("'network.id' is required");
  const net = self ? null : wirelessNetIn(org, b.network.id);
  if (b.url != null) checkHttpUrl(b.url, 'url');
  if (b.version != null && !VERSIONS.includes(b.version)) throw badRequest(`'version' must be one of: ${VERSIONS.join(', ')}`);
  if (b.radio != null || !self) {
    if (!RADIOS.includes(b.radio?.type)) throw badRequest(`'radio.type' must be one of: ${RADIOS.join(', ')}`);
  }
  if (!self && (typeof b.sharedSecret !== 'string' || !b.sharedSecret)) throw badRequest("'sharedSecret' must not be empty");
  return net;
}

// The shared secret is kept but never shown, and nothing is ever sent.
const receivers = collection({
  ops: {
    create: 'createOrganizationWirelessLocationScanningReceiver',
    update: 'updateOrganizationWirelessLocationScanningReceiver',
    delete: 'deleteOrganizationWirelessLocationScanningReceiver',
  },
  path: '/organizations/{organizationId}/wireless/location/scanning/receivers',
  param: 'receiverId',
  parent: orgOf,
  store: receiversOf,
  scope: 'organization',
  unique: false,
  what: 'scanning API receiver',
  key: 'receiverId',
  nextId: (ctx, store, org) => {
    let id;
    do id = rand(ctx, 'scanningReceiver', `${org.id}:${++store.created}`).digits(7);
    while (store.list.some((r) => r.receiverId === id));
    return id;
  },
  max: MAX_RECEIVERS,
  required: ['network', 'url', 'version', 'radio', 'sharedSecret'],
  check: checkReceiver,
  blank: () => ({ networkId: null, url: null, version: null, radioType: null, sharedSecret: null }),
  apply: (r, b, org, ctx, net) => {
    if (net) r.networkId = net.id;
    for (const k of ['url', 'version', 'sharedSecret']) if (b[k] != null) r[k] = b[k];
    if (b.radio?.type != null) r.radioType = b.radio.type;
  },
  json: receiverJson,
});

// ── MQTT ──

const MESSAGE_FIELDS = ['RSSI', 'AP MAC address', 'Client MAC address', 'Timestamp', 'Radio', 'Network ID', 'Beacon type', 'Raw payload', 'Client UUID', 'Client major value', 'Client minor value', 'Signal power', 'Band', 'Slot ID'];

// Kept on the network, since it names one of the network's MQTT brokers.
const mqttOf = (ctx, net) =>
  (net.wirelessMqtt ??= {
    settingsId: rand(ctx, 'wirelessMqtt', net.id).digits(7),
    enabled: false,
    topic: '',
    messageFields: [...MESSAGE_FIELDS],
    publishing: { frequency: 1, qos: 0 },
    brokerId: null,
    ble: { enabled: false, type: 'all', flush: { frequency: 60 }, allowLists: { uuids: [], macs: [] }, hysteresis: { enabled: false, threshold: 1 } },
    wifi: { enabled: false, type: 'associated', flush: { frequency: 60 }, allowLists: { macs: [] }, hysteresis: { enabled: false, threshold: 1 } },
  });

const brokerOf = (net, pick) => (net.mqttBrokers?.list ?? []).find(pick) ?? null;

function mqttJson(ctx, net) {
  const m = mqttOf(ctx, net);
  const broker = m.brokerId && brokerOf(net, (x) => x.id === m.brokerId);
  return {
    network: { id: net.id, name: net.name },
    mqtt: { settingsId: m.settingsId, enabled: m.enabled, topic: m.topic, messageFields: [...m.messageFields], publishing: { ...m.publishing }, broker: broker ? { id: broker.id, name: broker.name } : null },
    ble: structuredClone(m.ble),
    wifi: structuredClone(m.wifi),
  };
}

function checkMacs(list, name) {
  for (const mac of list ?? []) if (!MAC_RE.test(mac)) throw badRequest(`'${name}' must hold MAC addresses like 00:11:22:33:44:55`);
}

function checkTelemetry(x, name) {
  if (!x) return;
  inRange(x.flush?.frequency, 1, MAX_INT, `${name}.flush.frequency`);
  inRange(x.hysteresis?.threshold, 1, MAX_INT, `${name}.hysteresis.threshold`);
  checkMacs(x.allowLists?.macs, `${name}.allowLists.macs`);
}

function applyTelemetry(cur, x) {
  if (!x) return;
  for (const k of ['enabled', 'type']) if (x[k] != null) cur[k] = x[k];
  if (x.flush?.frequency != null) cur.flush.frequency = x.flush.frequency;
  for (const k of ['enabled', 'threshold']) if (x.hysteresis?.[k] != null) cur.hysteresis[k] = x.hysteresis[k];
  for (const k of Object.keys(cur.allowLists)) if (x.allowLists?.[k]) cur.allowLists[k] = x.allowLists[k].map((v) => v.toLowerCase());
}

// The broker is named, and must be one of the network's own MQTT brokers.
function updateMqtt(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  if (typeof b.network.id !== 'string') throw badRequest("'network.id' is required");
  const net = wirelessNetIn(org, b.network.id);
  const m = mqttOf(ctx, net);
  const q = b.mqtt;
  const fields = q.messageFields;
  if (fields) {
    const bad = fields.find((f) => !MESSAGE_FIELDS.includes(f));
    if (bad != null) throw badRequest(`'mqtt.messageFields' must be some of: ${MESSAGE_FIELDS.join(', ')}`);
    if (new Set(fields).size !== fields.length) throw badRequest("'mqtt.messageFields' lists a field more than once");
  }
  inRange(q.publishing?.frequency, 1, MAX_INT, 'mqtt.publishing.frequency');
  let brokerId = m.brokerId;
  if (q.broker) {
    const name = q.broker.name;
    const broker = name == null ? null : brokerOf(net, (x) => x.name === name);
    if (name != null && !broker) throw badRequest(`MQTT broker '${name}' does not exist in this network`);
    brokerId = broker?.id ?? null;
  }
  const enabled = q.enabled ?? m.enabled;
  if (enabled && !(brokerId && brokerOf(net, (x) => x.id === brokerId))) throw badRequest("'mqtt.broker' must name one of the network's MQTT brokers to enable MQTT");
  checkTelemetry(b.ble, 'ble');
  checkTelemetry(b.wifi, 'wifi');
  for (const u of b.ble?.allowLists?.uuids ?? []) if (!UUID_RE.test(u)) throw badRequest("'ble.allowLists.uuids' must hold UUIDs like 00000000-0000-0000-0000-000000000000");
  Object.assign(m, { enabled, brokerId });
  if (q.topic != null) m.topic = q.topic;
  if (fields) m.messageFields = MESSAGE_FIELDS.filter((f) => fields.includes(f));
  for (const k of ['frequency', 'qos']) if (q.publishing?.[k] != null) m.publishing[k] = q.publishing[k];
  applyTelemetry(m.ble, b.ble);
  applyTelemetry(m.wifi, b.wifi);
  return mqttJson(ctx, net);
}

const byNetwork = (ctx, json) => paginateItems(ctx, wirelessNets(ctx).sort(byId), (n) => n.id, BY_NETWORK, (n) => json(ctx, n));

export default [
  { op: 'getNetworkWirelessBluetoothSettings', path: '/networks/{networkId}/wireless/bluetooth/settings', handler: (ctx) => bluetoothJson(wirelessNet(ctx)) },
  { op: 'updateNetworkWirelessBluetoothSettings', method: 'PUT', path: '/networks/{networkId}/wireless/bluetooth/settings', handler: updateBluetooth },
  { op: 'getDeviceWirelessBluetoothSettings', path: '/devices/{serial}/wireless/bluetooth/settings', handler: (ctx) => deviceBluetoothJson(ctx, wirelessAp(ctx)), sample: { serial: 'wireless' } },
  { op: 'updateDeviceWirelessBluetoothSettings', method: 'PUT', path: '/devices/{serial}/wireless/bluetooth/settings', handler: updateDeviceBluetooth },
  { op: 'getNetworkBluetoothClients', path: '/networks/{networkId}/bluetoothClients', handler: bluetoothClients },
  {
    op: 'getNetworkBluetoothClient',
    path: '/networks/{networkId}/bluetoothClients/{bluetoothClientId}',
    handler: (ctx) => {
      wirelessNet(ctx);
      throw notFound('Bluetooth client');
    },
    sample: { bluetoothClientId: '1284392014819', status: 404 },
  },
  { op: 'getNetworkWirelessAlternateManagementInterface', path: '/networks/{networkId}/wireless/alternateManagementInterface', handler: (ctx) => amiJson(wirelessNet(ctx)) },
  { op: 'updateNetworkWirelessAlternateManagementInterface', method: 'PUT', path: '/networks/{networkId}/wireless/alternateManagementInterface', handler: updateAmi },
  { op: 'updateDeviceWirelessAlternateManagementInterfaceIpv6', method: 'PUT', path: '/devices/{serial}/wireless/alternateManagementInterface/ipv6', handler: updateAmiIpv6 },
  { op: 'getNetworkWirelessBilling', path: '/networks/{networkId}/wireless/billing', handler: (ctx) => billingJson(wirelessNet(ctx)) },
  { op: 'updateNetworkWirelessBilling', method: 'PUT', path: '/networks/{networkId}/wireless/billing', handler: updateBilling },
  { op: 'updateNetworkWirelessLocationScanning', method: 'PUT', path: '/networks/{networkId}/wireless/location/scanning', handler: updateScanning },
  { op: 'getOrganizationWirelessLocationScanningByNetwork', path: '/organizations/{organizationId}/wireless/location/scanning/byNetwork', handler: (ctx) => byNetwork(ctx, (c, n) => ({ networkId: n.id, name: n.name, ...scanningJson(c, n) })) },
  {
    op: 'getOrganizationWirelessLocationScanningReceivers',
    path: '/organizations/{organizationId}/wireless/location/scanning/receivers',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const ids = arrayParam(ctx.query, 'networkIds');
      const list = receiversOf(org).list.filter((r) => !ids.length || ids.includes(r.networkId));
      return paginateItems(ctx, list, (r) => r.receiverId, BY_NETWORK, (r) => receiverJson(r, org));
    },
  },
  ...receivers.routes,
  { op: 'getOrganizationWirelessMqttSettings', path: '/organizations/{organizationId}/wireless/mqtt/settings', handler: (ctx) => byNetwork(ctx, mqttJson) },
  { op: 'updateOrganizationWirelessMqttSettings', method: 'PUT', path: '/organizations/{organizationId}/wireless/mqtt/settings', status: 201, handler: updateMqtt },
];
