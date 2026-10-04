// Systems Manager devices, owners and profiles in an SM network. The store
// and the histories are in sim/sm.js.

import { arrayParam, badRequest, notFound, paginate } from '../http.js';
import { KINDS, LOOKBACK, SCOPES, cellularRows, desktopLogRows, idOf, inScope, lastConnected, ownerOf, performanceRows, profilesFor, sessions, smOf } from '../sim/sm.js';
import { unit } from '../rng.js';
import { HOUR, iso } from '../time.js';
import { netOf, requireProduct } from './common.js';

const DEFAULT_FIELDS = ['id', 'name', 'tags', 'ssid', 'wifiMac', 'osName', 'systemModel', 'uuid', 'serialNumber', 'serial', 'ip', 'notes'];
const PAGE = { def: 1000, min: 3, max: 1000 };

function smNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'systemsManager');
  return net;
}

function deviceOf(ctx) {
  const net = smNet(ctx);
  const dev = smOf(net).devices.find((d) => d.id === ctx.params.deviceId);
  if (!dev) throw notFound('Device');
  return { net, dev };
}

function userOf(ctx) {
  const net = smNet(ctx);
  const user = smOf(net).users.find((u) => u.id === ctx.params.userId);
  if (!user) throw notFound('User');
  return { net, user };
}

// `scope[]=withAny&scope[]=tag1`: the mode first, then the tags.
function scopeParam(q) {
  const [mode, ...tags] = arrayParam(q, 'scope');
  if (mode == null) return null;
  if (!SCOPES.includes(mode)) throw badRequest(`'scope' must start with one of ${SCOPES.join(', ')}`);
  return { mode, tags };
}

const desktop = (dev) => !!KINDS[dev.kind].desktop;
const windows = (dev) => dev.kind === 'Windows';
const cellularUsed = (dev, now) => cellularRows(dev, now).reduce((s, x) => s + x.received + x.sent, 0);
const missingApps = (dev) => dev.softwares.filter((s) => s.toInstall && !s.installedAt).length;

// The optional fields, worked out only when asked for.
const EXTRA = {
  systemType: (d) => KINDS[d.kind].systemType,
  availableDeviceCapacity: (d) => d.available,
  kioskAppName: (d, net) => profilesFor(net, d).find((p) => p.kioskApp)?.kioskApp ?? '',
  biosVersion: (d) => d.biosVersion,
  lastConnected: (d, net, now) => lastConnected(d, net, now),
  missingAppsCount: (d) => missingApps(d),
  userSuppliedAddress: () => '',
  location: (d, net) => net.address || '',
  lastUser: (d, net) => (desktop(d) ? (ownerOf(net, d)?.username ?? null) : null),
  ownerEmail: (d, net) => ownerOf(net, d)?.email ?? null,
  ownerUsername: (d, net) => ownerOf(net, d)?.username ?? null,
  osBuild: (d) => d.osBuild,
  publicIp: (d) => d.publicIp,
  phoneNumber: (d) => d.phoneNumber,
  diskInfoJson: (d) => (desktop(d) ? JSON.stringify({ [windows(d) ? 'C:' : '/']: { size: d.capacity * 1024 ** 3, free: d.available * 1024 ** 3 } }) : null),
  deviceCapacity: (d) => d.capacity,
  isManaged: () => true,
  hadMdm: (d) => KINDS[d.kind].platform !== 'chrome',
  isSupervised: (d) => d.supervised,
  meid: (d) => d.meid,
  imei: (d) => d.imei,
  iccid: (d) => d.iccid,
  simCarrierNetwork: (d) => d.carrier,
  cellularDataUsed: (d, net, now) => (d.cellular ? cellularUsed(d, now) : null),
  isHotspotEnabled: (d) => (d.cellular ? false : null),
  createdAt: (d) => d.createdAt,
  batteryEstCharge: (d, net, now) => (d.kind === 'Chromebook' ? null : 40 + Math.floor(unit(d.key, Math.floor(now / HOUR)) * 61)),
  quarantined: () => false,
  avName: (d) => (windows(d) ? 'Microsoft Defender Antivirus' : null),
  avRunning: (d) => (windows(d) ? true : null),
  asName: (d) => (windows(d) ? 'Microsoft Defender Antivirus' : null),
  fwName: (d) => (windows(d) ? 'Windows Defender Firewall' : d.kind === 'Mac' ? 'macOS Application Firewall' : null),
  isRooted: () => false,
  loginRequired: (d) => desktop(d),
  screenLockEnabled: (d, net) => profilesFor(net, d).some((p) => p.payloadTypes.includes('Passcode')),
  screenLockDelay: (d, net) => (profilesFor(net, d).some((p) => p.payloadTypes.includes('Passcode')) ? 300 : null),
  autoLoginDisabled: (d) => (desktop(d) ? true : null),
  autoTags: () => [],
  hasMdm: (d) => KINDS[d.kind].platform !== 'chrome',
  hasDesktopAgent: (d) => desktop(d),
  diskEncryptionEnabled: (d) => !d.tags.includes('byod') || KINDS[d.kind].platform === 'ios',
  hardwareEncryptionCaps: (d) => (KINDS[d.kind].platform === 'ios' ? 'Block-level and file-level encryption' : null),
  passCodeLock: (d, net) => profilesFor(net, d).some((p) => p.payloadTypes.includes('Passcode')),
  usesHardwareKeystore: (d) => d.kind === 'Android' || null,
  androidSecurityPatchVersion: (d) => KINDS[d.kind].patch ?? null,
  cellular: (d) => d.cellular,
  url: (d, net) => net.url.replace('/manage/usage/list', `/manage/pcc/list#pcc${d.id}`),
};

function deviceJson(d, fields, net, now) {
  const out = { id: d.id, name: d.name, tags: [...d.tags], ssid: d.ssid, wifiMac: d.wifiMac, osName: d.osName, systemModel: d.systemModel, uuid: d.uuid, serialNumber: d.serialNumber, serial: d.serialNumber, ip: d.ip, notes: d.notes };
  for (const f of fields) if (!(f in out)) out[f] = EXTRA[f](d, net, now);
  return out;
}

function listDevices(ctx) {
  const net = smNet(ctx);
  const q = ctx.query;
  const fields = arrayParam(q, 'fields');
  const unknown = fields.filter((f) => !DEFAULT_FIELDS.includes(f) && !EXTRA[f]);
  if (unknown.length) throw badRequest(`Unknown fields: ${unknown.join(', ')}`);
  const lower = (name) => arrayParam(q, name).map((v) => v.toLowerCase());
  const [wifiMacs, serials, ids, uuids, types] = [lower('wifiMacs'), arrayParam(q, 'serials'), arrayParam(q, 'ids'), lower('uuids'), arrayParam(q, 'systemTypes')];
  const scope = scopeParam(q);
  const rows = smOf(net).devices.filter(
    (d) =>
      (!wifiMacs.length || wifiMacs.includes(d.wifiMac)) &&
      (!serials.length || serials.includes(d.serialNumber)) &&
      (!ids.length || ids.includes(d.id)) &&
      (!uuids.length || uuids.includes(d.uuid.toLowerCase())) &&
      (!types.length || types.includes(KINDS[d.kind].systemType)) &&
      (!scope || inScope(scope.mode, scope.tags, d.tags)),
  );
  return paginate(ctx, rows, (d) => d.id, PAGE).map((d) => deviceJson(d, fields, net, ctx.now));
}

function userJson(u) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    username: u.username,
    hasPassword: u.hasPassword,
    tags: u.tags.length ? ` ${u.tags.join(' ')} ` : '',
    adGroups: [],
    azureAdGroups: [],
    samlGroups: [],
    asmGroups: [],
    isExternal: u.isExternal,
    displayName: `${u.fullName} <${u.email}>`,
    hasIdentityCertificate: u.hasIdentityCertificate,
    userThumbnail: `https://s3.amazonaws.com/meraki-sm-thumbnails/${u.id}.png`,
  };
}

function listUsers(ctx) {
  const net = smNet(ctx);
  const q = ctx.query;
  const [ids, usernames, emails] = [arrayParam(q, 'ids'), arrayParam(q, 'usernames'), arrayParam(q, 'emails').map((e) => e.toLowerCase())];
  const scope = scopeParam(q);
  return smOf(net)
    .users.filter((u) => (!ids.length || ids.includes(u.id)) && (!usernames.length || usernames.includes(u.username)) && (!emails.length || emails.includes(u.email)) && (!scope || inScope(scope.mode, scope.tags, u.tags)))
    .map(userJson);
}

function profileJson(p) {
  return { id: p.id, name: p.name, description: p.description, scope: p.scope, tags: [...p.tags], payloadTypes: [...p.payloadTypes] };
}

function listProfiles(ctx) {
  const net = smNet(ctx);
  const types = arrayParam(ctx.query, 'payloadTypes');
  const rows = smOf(net).profiles.filter((p) => !types.length || p.payloadTypes.some((t) => types.includes(t)));
  return paginate(ctx, rows, (p) => p.id, { def: 50, min: 3, max: 50 }).map(profileJson);
}

// A profile as installed on a device.
function installedJson(dev, p) {
  const data = { PayloadDisplayName: p.name, PayloadIdentifier: p.identifier, PayloadType: 'Configuration', PayloadVersion: 1, PayloadContent: p.payloadTypes.map((t) => ({ PayloadType: t })) };
  return { deviceId: dev.id, id: p.id, isEncrypted: false, isManaged: true, profileData: JSON.stringify(data), profileIdentifier: p.identifier, name: p.name, version: p.version };
}

function softwareJson(dev, s) {
  return { ...s, createdAt: iso(s.createdAt), deviceId: dev.id, installedAt: s.installedAt == null ? null : iso(s.installedAt), uninstalledAt: s.uninstalledAt == null ? null : iso(s.uninstalledAt), updatedAt: iso(s.updatedAt) };
}

// Certificates come with the profiles that carry one: an identity issued
// by the lab's CA when the profile was installed.
function certsOf(net, dev) {
  const owner = ownerOf(net, dev);
  return profilesFor(net, dev)
    .filter((p) => p.payloadTypes.includes('Certificate'))
    .map((p) => {
      const id = idOf(dev.key, `cert:${p.id}`);
      const from = dev.createdAt;
      const body = Buffer.from(`${p.identifier}:${dev.uuid}:${id}`).toString('base64');
      return {
        name: `${owner?.username ?? dev.name} identity`,
        notValidAfter: iso(from + 2 * 365 * 86400),
        notValidBefore: iso(from),
        certPem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
        deviceId: dev.id,
        issuer: 'CN=Acme Lab Issuing CA, O=Acme Test Lab',
        subject: `CN=${owner?.email ?? dev.serialNumber}, O=Acme Test Lab`,
        id,
      };
    });
}

function adaptersOf(dev) {
  const prefix = dev.ip.split('.').slice(0, 3).join('.');
  return [{ dhcpServer: `${prefix}.1`, dnsServer: `${prefix}.1`, gateway: `${prefix}.1`, id: idOf(dev.key, 'adapter:0'), ip: dev.ip, mac: dev.wifiMac, name: KINDS[dev.kind].adapter, subnet: '255.255.255.0' }];
}

function securityCenters(dev) {
  if (!windows(dev)) return [];
  return [
    {
      isRooted: false,
      hasAntiVirus: true,
      antiVirusName: EXTRA.avName(dev),
      isFireWallEnabled: true,
      hasFireWallInstalled: true,
      fireWallName: EXTRA.fwName(dev),
      isDiskEncrypted: EXTRA.diskEncryptionEnabled(dev),
      isAutoLoginDisabled: true,
      id: idOf(dev.key, 'security'),
      runningProcs: 'C:\\Windows\\explorer.exe,C:\\Program Files\\Meraki\\SM\\agent.exe,C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    },
  ];
}

function wlanLists(dev) {
  const header = dev.kind === 'Windows' ? 'Profiles on interface Wi-Fi:' : `Preferred networks on ${KINDS[dev.kind].adapter}:`;
  return [{ createdAt: iso(dev.createdAt + 120), id: idOf(dev.key, 'wlan'), xml: `${header}\n${dev.savedSsids.map((s) => `\t${s}`).join('\n')}\n` }];
}

const userDevices = (net, user) => smOf(net).devices.filter((d) => d.ownerId === user.id);
const ts = (k) => (x) => x[k];
const DEV = '/networks/{networkId}/sm/devices/{deviceId}';
const NET_SAMPLE = { org: 1, networkId: (world) => world.orgs[1].networks.find((n) => n.sm).id };
// No one device answers rows on every route, so each picks a fitting one.
const pick = (test) => ({ ...NET_SAMPLE, deviceId: (world) => world.orgs[1].networks.find((n) => n.sm).sm.devices.find(test).id });
const ANY = pick(() => true);
const DESKTOP = pick((d) => d.kind === 'Mac');
const WINDOWS = pick(windows);
const PHONE = pick((d) => d.cellular);
const USER = { ...NET_SAMPLE, userId: (world) => world.orgs[1].networks.find((n) => n.sm).sm.users[0].id };

export default [
  { op: 'getNetworkSmDevices', path: '/networks/{networkId}/sm/devices', sample: NET_SAMPLE, handler: listDevices },
  {
    op: 'getNetworkSmDeviceCellularUsageHistory',
    path: `${DEV}/cellularUsageHistory`,
    sample: PHONE,
    handler: (ctx) => cellularRows(deviceOf(ctx).dev, ctx.now),
  },
  { op: 'getNetworkSmDeviceCerts', path: `${DEV}/certs`, sample: DESKTOP, handler: (ctx) => { const { net, dev } = deviceOf(ctx); return certsOf(net, dev); } },
  {
    op: 'getNetworkSmDeviceConnectivity',
    path: `${DEV}/connectivity`,
    sample: ANY,
    handler: (ctx) => {
      const { net, dev } = deviceOf(ctx);
      const rows = sessions(dev, net, ctx.now - LOOKBACK, ctx.now).map((s) => ({ firstSeenAt: iso(s.start), lastSeenAt: iso(s.end) }));
      return paginate(ctx, rows, ts('firstSeenAt'), PAGE);
    },
  },
  {
    op: 'getNetworkSmDeviceDesktopLogs',
    path: `${DEV}/desktopLogs`,
    sample: DESKTOP,
    handler: (ctx) => {
      const { net, dev } = deviceOf(ctx);
      return paginate(ctx, desktopLogRows(dev, net, ctx.now, ownerOf(net, dev)?.username ?? null), ts('ts'), PAGE);
    },
  },
  {
    op: 'getNetworkSmDeviceDeviceCommandLogs',
    path: `${DEV}/deviceCommandLogs`,
    sample: ANY,
    handler: (ctx) => {
      const { dev } = deviceOf(ctx);
      const rows = dev.commandLogs.filter((c) => c.ts <= ctx.now).map((c, i) => ({ key: String(i).padStart(6, '0'), c }));
      return paginate(ctx, rows, ts('key'), PAGE).map(({ c }) => ({ action: c.action, name: c.name, details: c.details, dashboardUser: c.dashboardUser, ts: iso(c.ts) }));
    },
  },
  { op: 'getNetworkSmDeviceDeviceProfiles', path: `${DEV}/deviceProfiles`, sample: ANY, handler: (ctx) => { const { net, dev } = deviceOf(ctx); return profilesFor(net, dev).map((p) => installedJson(dev, p)); } },
  { op: 'getNetworkSmDeviceNetworkAdapters', path: `${DEV}/networkAdapters`, sample: ANY, handler: (ctx) => adaptersOf(deviceOf(ctx).dev) },
  {
    op: 'getNetworkSmDevicePerformanceHistory',
    path: `${DEV}/performanceHistory`,
    sample: DESKTOP,
    handler: (ctx) => {
      const { net, dev } = deviceOf(ctx);
      return paginate(ctx, performanceRows(dev, net, ctx.now), ts('ts'), PAGE);
    },
  },
  {
    op: 'getNetworkSmDeviceRestrictions',
    path: `${DEV}/restrictions`,
    sample: ANY,
    handler: (ctx) => {
      const { net, dev } = deviceOf(ctx);
      return { restrictions: profilesFor(net, dev).filter((p) => p.restrictions).map((p) => ({ profile: p.identifier, restrictions: { ...p.restrictions } })) };
    },
  },
  { op: 'getNetworkSmDeviceSecurityCenters', path: `${DEV}/securityCenters`, sample: WINDOWS, handler: (ctx) => securityCenters(deviceOf(ctx).dev) },
  { op: 'getNetworkSmDeviceSoftwares', path: `${DEV}/softwares`, sample: ANY, handler: (ctx) => { const { dev } = deviceOf(ctx); return dev.softwares.map((s) => softwareJson(dev, s)); } },
  { op: 'getNetworkSmDeviceWlanLists', path: `${DEV}/wlanLists`, sample: ANY, handler: (ctx) => wlanLists(deviceOf(ctx).dev) },
  { op: 'getNetworkSmProfiles', path: '/networks/{networkId}/sm/profiles', sample: NET_SAMPLE, handler: listProfiles },
  { op: 'getNetworkSmUsers', path: '/networks/{networkId}/sm/users', sample: NET_SAMPLE, handler: listUsers },
  {
    op: 'getNetworkSmUserDeviceProfiles',
    path: '/networks/{networkId}/sm/users/{userId}/deviceProfiles',
    sample: USER,
    handler: (ctx) => {
      const { net, user } = userOf(ctx);
      return userDevices(net, user).flatMap((d) => profilesFor(net, d).map((p) => installedJson(d, p)));
    },
  },
  {
    op: 'getNetworkSmUserSoftwares',
    path: '/networks/{networkId}/sm/users/{userId}/softwares',
    sample: USER,
    handler: (ctx) => {
      const { net, user } = userOf(ctx);
      return userDevices(net, user).flatMap((d) => d.softwares.map((s) => softwareJson(d, s)));
    },
  },
];
