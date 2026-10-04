// Systems Manager devices, owners and profiles in an SM network. The store
// and the histories are in sim/sm.js.

import { arrayParam, badRequest, notFound, paginate } from '../http.js';
import { hashStr, unit } from '../rng.js';
import { KINDS, LOOKBACK, SCOPES, cellularRows, desktopLogRows, idOf, inScope, lastConnected, ownerOf, performanceRows, profilesFor, sessions, smOf } from '../sim/sm.js';
import { HOUR, iso } from '../time.js';
import { collection, netOf, newId, requireProduct } from './common.js';

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
// Apps removed through the API stay stored, so installing them again finds them.
const softwaresOf = (dev) => dev.softwares.filter((s) => s.uninstalledAt == null);

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

// Writes build the store; reads go through smOf and never do.
function writable(net) {
  return (net.sm ??= { devices: [], users: [], profiles: [] });
}

const NO_GROUPS = { created: 0, list: [] };
const platformOf = (dev) => KINDS[dev.kind].platform;
// Each device keeps its newest 1000 commands.
const MAX_COMMANDS = 1000;
function logCommand(ctx, dev, action, name, details = {}) {
  dev.commandLogs.push({ action, name, details: JSON.stringify(details), dashboardUser: ctx.world.apiAdmin.name, ts: ctx.now });
  if (dev.commandLogs.length > MAX_COMMANDS) dev.commandLogs.shift();
}

// A scope given as [mode, ...tags], in a body or a target group.
function scopeOf(list, at) {
  const [mode, ...tags] = list;
  if (!SCOPES.includes(mode)) throw badRequest(`'${at}' must start with one of ${SCOPES.join(', ')}`);
  if (tags.some((t) => typeof t !== 'string' || !t.trim())) throw badRequest(`'${at}' tags must not be empty`);
  return { mode, tags: tags.map((t) => t.trim()) };
}

// Devices named by any of the set selectors: wifiMacs, ids, serials or scope.
function selected(net, b) {
  const lists = ['wifiMacs', 'ids', 'serials', 'scope'].map((k) => b[k] ?? []);
  if (!lists.some((l) => l.length)) throw badRequest("Name the devices with 'wifiMacs', 'ids', 'serials' or 'scope'");
  const [macs, ids, serials] = lists.map((l) => l.map((v) => String(v).toLowerCase()));
  const scope = lists[3].length ? scopeOf(lists[3], 'scope') : null;
  return smOf(net).devices.filter((d) => macs.includes(d.wifiMac) || ids.includes(d.id) || serials.includes(d.serialNumber.toLowerCase()) || (scope && inScope(scope.mode, scope.tags, d.tags)));
}

// The one device named by wifiMac, id or serial.
function single(net, b) {
  if (b.wifiMac == null && b.id == null && b.serial == null) throw badRequest("Name the device with 'wifiMac', 'id' or 'serial'");
  const dev = smOf(net).devices.find((d) => (b.id == null || d.id === b.id) && (b.wifiMac == null || d.wifiMac === b.wifiMac.toLowerCase()) && (b.serial == null || d.serialNumber === b.serial));
  if (!dev) throw notFound('Device');
  return dev;
}

function checkPin(devs, pin, what) {
  if (pin != null && (!Number.isInteger(pin) || pin < 0 || pin > 999999)) throw badRequest("'pin' must be a six digit number");
  if (pin == null && devs.some((d) => platformOf(d) === 'macos')) throw badRequest(`'pin' is required to ${what} macOS devices`);
}

// Logs the profiles a device gains and loses when its tags or network change.
function reprofile(ctx, net, dev, change, to = net) {
  const before = profilesFor(net, dev);
  change();
  const after = profilesFor(to, dev);
  for (const p of before) if (!after.some((q) => q.id === p.id)) logCommand(ctx, dev, 'RemoveProfile', p.name, { profileId: p.id, identifier: p.identifier });
  for (const p of after) if (!before.some((q) => q.id === p.id)) logCommand(ctx, dev, 'InstallProfile', p.name, { profileId: p.id, identifier: p.identifier });
}

const ids = (devs) => ({ ids: devs.map((d) => d.id) });

// A command every selected device that supports it receives.
function command(action, platforms) {
  return (ctx) => {
    const net = smNet(ctx);
    const b = ctx.body;
    const devs = selected(net, b).filter((d) => !platforms || platforms(d));
    if (action === 'DeviceLock') checkPin(devs, b.pin, 'lock');
    if (b.kextPaths?.some((p) => typeof p !== 'string' || !p.trim())) throw badRequest("'kextPaths' must not hold empty paths");
    const details = {};
    for (const k of ['notifyUser', 'rebuildKernelCache', 'requestRequiresNetworkTether', 'kextPaths']) if (b[k] != null) details[k] = b[k];
    for (const d of devs) {
      if (action === 'DeviceInformation') d.checkedInAt = ctx.now;
      logCommand(ctx, d, action, d.name, platformOf(d) === 'macos' ? details : {});
    }
    return ids(devs);
  };
}

const RESTARTS = (d) => ['macos', 'windows', 'chrome'].includes(platformOf(d)) || d.supervised;
const SHUTDOWNS = (d) => ['macos', 'windows'].includes(platformOf(d));

function updateFields(ctx) {
  const net = smNet(ctx);
  const b = ctx.body;
  const dev = single(net, b);
  const f = b.deviceFields;
  if (f == null) throw badRequest("'deviceFields' is required");
  if (f.name != null && !f.name.trim()) throw badRequest("'deviceFields.name' must not be empty");
  if (f.name != null) dev.name = f.name.trim();
  if (f.notes != null) dev.notes = f.notes;
  return [{ id: dev.id, name: dev.name, wifiMac: dev.wifiMac, serial: dev.serialNumber, notes: dev.notes }];
}

const ACTIONS = ['add', 'delete', 'update'];
function modifyTags(ctx) {
  const net = smNet(ctx);
  const b = ctx.body;
  if (!ACTIONS.includes(b.updateAction)) throw badRequest(`'updateAction' must be one of ${ACTIONS.join(', ')}`);
  if (b.tags == null) throw badRequest("'tags' is required");
  if (b.tags.some((t) => typeof t !== 'string' || !/^\S+$/.test(t))) throw badRequest("'tags' must be words without spaces");
  const devs = selected(net, b);
  const tags = [...new Set(b.tags)];
  const out = [];
  for (const d of devs) {
    const next = b.updateAction === 'update' ? tags : b.updateAction === 'add' ? [...new Set([...d.tags, ...tags])] : d.tags.filter((t) => !tags.includes(t));
    if (next.length === d.tags.length && next.every((t, i) => t === d.tags[i])) continue;
    reprofile(ctx, net, d, () => (d.tags = next));
    out.push({ id: d.id, tags: [...d.tags], wifiMac: d.wifiMac, serial: d.serialNumber });
  }
  return out;
}

function moveDevices(ctx) {
  const net = smNet(ctx);
  const b = ctx.body;
  if (typeof b.newNetwork !== 'string') throw badRequest("'newNetwork' is required");
  const to = net.org.networks.find((n) => n.id === b.newNetwork);
  if (!to) throw badRequest(`'newNetwork' ${b.newNetwork} is not a network in this organization`);
  if (!to.productTypes.includes('systemsManager')) throw badRequest("'newNetwork' must be a Systems Manager network");
  if (to === net) throw badRequest('The devices are already in this network');
  const devs = selected(net, b);
  if (!devs.length) return { ids: [], newNetwork: to.id };
  const from = writable(net);
  const dest = writable(to);
  for (const d of devs) {
    reprofile(ctx, net, d, () => {
      from.devices.splice(from.devices.indexOf(d), 1);
      dest.devices.push(d);
    }, to);
    // Owners are per network, so the owner comes along when the new network lacks them.
    const owner = ownerOf(net, d);
    if (owner && !dest.users.some((u) => u.id === owner.id)) dest.users.push({ ...owner, tags: [...owner.tags] });
  }
  dest.devices.sort((x, y) => (x.id < y.id ? -1 : 1));
  return { ...ids(devs), newNetwork: to.id };
}

// Erasing a device or unenrolling it takes it out of the network.
function drop(net, dev) {
  const sm = writable(net);
  sm.devices.splice(sm.devices.indexOf(dev), 1);
}

function wipeDevice(ctx) {
  const net = smNet(ctx);
  const dev = single(net, ctx.body);
  checkPin([dev], ctx.body.pin, 'wipe');
  drop(net, dev);
  return { id: dev.id };
}

function appIds(b) {
  if (b.appIds == null || !b.appIds.length) throw badRequest("'appIds' must name at least one app");
  return [...new Set(b.appIds)];
}

// Managed apps the device knows, installed or not.
function appsOf(dev, wanted) {
  const rows = wanted.map((id) => dev.softwares.find((s) => s.appId === id));
  const unknown = wanted.filter((id, i) => !rows[i]);
  if (unknown.length) throw badRequest(`Unknown apps for this device: ${unknown.join(', ')}`);
  return rows;
}

const installed = (s) => s.installedAt != null && s.uninstalledAt == null;

function installApps(ctx) {
  const { dev } = deviceOf(ctx);
  const rows = appsOf(dev, appIds(ctx.body));
  for (const s of rows) {
    if (installed(s) && !ctx.body.force) continue;
    Object.assign(s, { installedAt: ctx.now, uninstalledAt: null, toInstall: false, toUninstall: false, status: 'Managed', updatedAt: ctx.now });
    logCommand(ctx, dev, 'InstallApplication', s.name, { identifier: s.identifier });
  }
  return {};
}

function uninstallApps(ctx) {
  const { dev } = deviceOf(ctx);
  const rows = appsOf(dev, appIds(ctx.body));
  const absent = rows.filter((s) => !installed(s));
  if (absent.length) throw badRequest(`Not installed on this device: ${absent.map((s) => s.appId).join(', ')}`);
  for (const s of rows) {
    Object.assign(s, { uninstalledAt: ctx.now, toInstall: false, toUninstall: false, updatedAt: ctx.now });
    logCommand(ctx, dev, 'RemoveApplication', s.name, { identifier: s.identifier });
  }
  return {};
}

// Activation lock bypass works out each device's result when asked and
// reports it once the attempt completes.
const BYPASS_SECONDS = 20;
const MAX_ATTEMPTS = 100;
const NO_CODE = 'Activation lock bypass code not known for this device';

function bypassJson(a, now) {
  const done = now >= a.end;
  return { id: a.id, status: done ? 'complete' : 'pending', data: done ? structuredClone(a.data) : {} };
}

function createBypass(ctx) {
  const net = smNet(ctx);
  const wanted = ctx.body.ids;
  if (wanted == null || !wanted.length) throw badRequest("'ids' must name at least one device");
  const devs = wanted.map((id) => smOf(net).devices.find((d) => d.id === id));
  const unknown = wanted.filter((id, i) => !devs[i]);
  if (unknown.length) throw badRequest(`Unknown devices: ${unknown.join(', ')}`);
  const store = (writable(net).bypassAttempts ??= { created: 0, list: [] });
  const data = {};
  for (const d of devs) data[d.id] = d.supervised ? { success: true } : { success: false, errors: [NO_CODE] };
  const a = { id: newId(ctx, store, 'smBypass', net.id), start: ctx.now, end: ctx.frozen ? ctx.now : ctx.now + BYPASS_SECONDS, data };
  store.list.push(a);
  if (store.list.length > MAX_ATTEMPTS) store.list.shift();
  return bypassJson(a, ctx.now);
}

function getBypass(ctx) {
  const net = smNet(ctx);
  const a = smOf(net).bypassAttempts?.list.find((x) => x.id === ctx.params.attemptId);
  if (!a) throw notFound('Bypass activation lock attempt');
  return bypassJson(a, ctx.now);
}

// Target groups: a tag scope over the network's devices and owners, given as
// 'withAny, tag1, tag2'.
function parseScope(text) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? scopeOf(parts, 'scope') : { mode: 'none', tags: [] };
}

function groupJson(g, net, ctx) {
  const out = { id: g.id, name: g.name, scope: g.scope, tags: [...g.tags] };
  if (ctx.query?.get('withDetails') === 'true') {
    const sm = smOf(net);
    out.deviceIds = sm.devices.filter((d) => inScope(g.scope, g.tags, d.tags)).map((d) => d.id);
    out.userIds = sm.users.filter((u) => inScope(g.scope, g.tags, u.tags)).map((u) => u.id);
  }
  return out;
}

const groups = collection({
  ops: { list: 'getNetworkSmTargetGroups', create: 'createNetworkSmTargetGroup', get: 'getNetworkSmTargetGroup', update: 'updateNetworkSmTargetGroup', delete: 'deleteNetworkSmTargetGroup' },
  path: '/networks/{networkId}/sm/targetGroups',
  param: 'targetGroupId',
  parent: smNet,
  store: (net) => net.sm?.targetGroups ?? NO_GROUPS,
  what: 'target group',
  kind: 'smTargetGroup',
  max: 500,
  required: ['name'],
  check: (ctx, net, b) => (b.scope == null ? null : parseScope(b.scope)),
  blank: () => ({ name: '', scope: 'none', tags: [] }),
  apply: (g, b, net, ctx, scope) => {
    if (b.name != null) g.name = b.name;
    if (scope) Object.assign(g, { scope: scope.mode, tags: scope.tags });
  },
  json: groupJson,
  missing: { ...NET_SAMPLE, targetGroupId: '1000', status: 404 },
});

// A create builds the store first and takes it away again if it is refused.
const createGroup = groups.routes.find((r) => r.method === 'POST').handler;
function addGroup(ctx) {
  const net = smNet(ctx);
  const [sm, store] = [net.sm, net.sm?.targetGroups];
  writable(net).targetGroups ??= { created: 0, list: [] };
  try {
    return createGroup(ctx);
  } catch (e) {
    if (!sm) delete net.sm;
    else if (!store) delete net.sm.targetGroups;
    throw e;
  }
}

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
  { op: 'getNetworkSmDeviceSoftwares', path: `${DEV}/softwares`, sample: ANY, handler: (ctx) => { const { dev } = deviceOf(ctx); return softwaresOf(dev).map((s) => softwareJson(dev, s)); } },
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
      return userDevices(net, user).flatMap((d) => softwaresOf(d).map((s) => softwareJson(d, s)));
    },
  },
  { op: 'createNetworkSmBypassActivationLockAttempt', method: 'POST', path: '/networks/{networkId}/sm/bypassActivationLockAttempts', sample: NET_SAMPLE, handler: createBypass },
  { op: 'getNetworkSmBypassActivationLockAttempt', path: '/networks/{networkId}/sm/bypassActivationLockAttempts/{attemptId}', sample: { ...NET_SAMPLE, attemptId: '1234', status: 404 }, handler: getBypass },
  { op: 'checkinNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/checkin', status: 200, sample: NET_SAMPLE, handler: command('DeviceInformation') },
  { op: 'updateNetworkSmDevicesFields', method: 'PUT', path: '/networks/{networkId}/sm/devices/fields', sample: NET_SAMPLE, handler: updateFields },
  { op: 'lockNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/lock', status: 200, sample: NET_SAMPLE, handler: command('DeviceLock') },
  { op: 'modifyNetworkSmDevicesTags', method: 'POST', path: '/networks/{networkId}/sm/devices/modifyTags', status: 200, sample: NET_SAMPLE, handler: modifyTags },
  { op: 'moveNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/move', status: 200, sample: NET_SAMPLE, handler: moveDevices },
  { op: 'rebootNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/reboot', status: 200, sample: NET_SAMPLE, handler: command('RestartDevice', RESTARTS) },
  { op: 'shutdownNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/shutdown', status: 200, sample: NET_SAMPLE, handler: command('ShutDownDevice', SHUTDOWNS) },
  { op: 'wipeNetworkSmDevices', method: 'POST', path: '/networks/{networkId}/sm/devices/wipe', status: 200, sample: NET_SAMPLE, handler: wipeDevice },
  { op: 'installNetworkSmDeviceApps', method: 'POST', path: `${DEV}/installApps`, status: 200, sample: ANY, handler: installApps },
  {
    op: 'refreshNetworkSmDeviceDetails',
    method: 'POST',
    path: `${DEV}/refreshDetails`,
    status: 200,
    sample: ANY,
    handler: (ctx) => {
      const { dev } = deviceOf(ctx);
      dev.checkedInAt = ctx.now;
      for (const action of ['DeviceInformation', 'InstalledApplicationList', 'CertificateList']) logCommand(ctx, dev, action, dev.name);
      return {};
    },
  },
  {
    op: 'unenrollNetworkSmDevice',
    method: 'POST',
    path: `${DEV}/unenroll`,
    status: 200,
    sample: ANY,
    handler: (ctx) => {
      const { net, dev } = deviceOf(ctx);
      drop(net, dev);
      return { success: true };
    },
  },
  { op: 'uninstallNetworkSmDeviceApps', method: 'POST', path: `${DEV}/uninstallApps`, status: 200, sample: ANY, handler: uninstallApps },
  ...groups.routes.map((r) => (r.method === 'POST' ? { ...r, handler: addGroup, sample: NET_SAMPLE } : r.sample ? r : { ...r, sample: NET_SAMPLE })),
];
