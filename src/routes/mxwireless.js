// Wi-Fi on MX appliances with a radio (the W models): device radio settings,
// network RF profiles and the four MX SSIDs. None of the seeded MXes has a
// radio, so these answer 400 until one is claimed. Also the vMX token.

import { MODELS } from '../catalog.js';
import { configOf, stored } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { HOUR, iso } from '../time.js';
import { parseIp } from '../validate.js';
import { collection, devOf, mxNet, requireModel } from './common.js';

const MAX_PROFILES = 50;
const SSID_NUMBERS = [1, 2, 3, 4];
const CHANNELS_24 = Array.from({ length: 14 }, (_, i) => i + 1);
const CHANNELS_5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165, 169, 173, 177];
const WIDTHS_5 = [0, 20, 40, 80, 160];
const RATES_24 = [1, 2, 5.5, 6, 9, 11, 12, 18, 24, 36, 48, 54];
const RATES_5 = [6, 9, 12, 18, 24, 36, 48, 54];
const BAND_MODES = ['2.4ghz', '5ghz', '6ghz', 'dual', 'multi'];
const AUTH_MODES = ['open', 'psk', '8021x-meraki', '8021x-radius', '8021x-nac'];
const WPA_MODES = ['WPA1 and WPA2', 'WPA2 only', 'WPA3 Transition Mode', 'WPA3 only'];
// A vMX authentication token lasts an hour.
const TOKEN_LIFE = HOUR;

const hasRadio = (dev) => !!dev && !!MODELS[dev.model]?.radio;

function radioDevice(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'appliance');
  if (!hasRadio(dev)) throw badRequest(`${dev.model} has no wireless radio`);
  return dev;
}

function wifiNet(ctx) {
  const net = mxNet(ctx);
  if (!hasRadio(net.mx)) throw badRequest(net.mx ? `This network's appliance (${net.mx.model}) has no wireless radio` : 'This network has no appliance');
  return net;
}

// ── RF profiles ──

const profilesOf = (net) => stored(net, 'applianceRfProfiles', () => ({ created: 0, list: [] }));
const ssidSettings = () => Object.fromEntries(SSID_NUMBERS.map((n) => [n, { bandOperationMode: 'dual', bandSteeringEnabled: true }]));

function checkProfile(ctx, net, b) {
  const two = b.twoFourGhzSettings;
  const five = b.fiveGhzSettings;
  if (two?.minBitrate != null && !RATES_24.includes(two.minBitrate)) throw badRequest(`'twoFourGhzSettings.minBitrate' must be one of ${RATES_24.join(', ')}`);
  if (five?.minBitrate != null && !RATES_5.includes(five.minBitrate)) throw badRequest(`'fiveGhzSettings.minBitrate' must be one of ${RATES_5.join(', ')}`);
  for (const [n, s] of Object.entries(b.perSsidSettings ?? {})) {
    if (s?.bandOperationMode != null && !BAND_MODES.includes(s.bandOperationMode)) throw badRequest(`'perSsidSettings.${n}.bandOperationMode' must be one of ${BAND_MODES.join(', ')}`);
  }
}

function applyProfile(x, b) {
  if (b.name != null) x.name = b.name;
  for (const k of ['twoFourGhzSettings', 'fiveGhzSettings']) {
    for (const f of ['minBitrate', 'axEnabled']) if (b[k]?.[f] != null) x[k][f] = b[k][f];
  }
  for (const n of SSID_NUMBERS) {
    for (const f of ['bandOperationMode', 'bandSteeringEnabled']) if (b.perSsidSettings?.[n]?.[f] != null) x.perSsidSettings[n][f] = b.perSsidSettings[n][f];
  }
}

const profileJson = (x, net) => ({
  id: x.id,
  networkId: net.id,
  name: x.name,
  twoFourGhzSettings: { ...x.twoFourGhzSettings },
  fiveGhzSettings: { ...x.fiveGhzSettings },
  perSsidSettings: Object.fromEntries(SSID_NUMBERS.map((n) => [n, { ...x.perSsidSettings[n] }])),
});

// Networks bound to one template share its profiles, so any of their MXes may use one.
function profileUser(x, net) {
  const c = configOf(net);
  for (const n of net.org.networks) {
    if (configOf(n) !== c) continue;
    // A W model swapped for one without a radio keeps its settings, unused.
    const dev = n.devices.find((d) => hasRadio(d) && d.applianceRadio?.rfProfileId === x.id);
    if (dev) return dev;
  }
  return null;
}

const profiles = collection({
  ops: { create: 'createNetworkApplianceRfProfile', get: 'getNetworkApplianceRfProfile', update: 'updateNetworkApplianceRfProfile', delete: 'deleteNetworkApplianceRfProfile' },
  path: '/networks/{networkId}/appliance/rfProfiles',
  param: 'rfProfileId',
  parent: wifiNet,
  store: profilesOf,
  what: 'RF profile',
  kind: 'applianceRfProfile',
  max: MAX_PROFILES,
  required: ['name'],
  check: checkProfile,
  blank: () => ({ name: null, twoFourGhzSettings: { minBitrate: 11, axEnabled: true }, fiveGhzSettings: { minBitrate: 12, axEnabled: true }, perSsidSettings: ssidSettings() }),
  apply: applyProfile,
  json: profileJson,
  inUse: (x, net) => {
    const dev = profileUser(x, net);
    return dev && `RF profile ${x.id} is assigned to appliance ${dev.serial}`;
  },
  missing: { rfProfileId: '1234', status: 400 },
});

// ── Device radio settings ──

// null means auto. Assigning a profile, or the basic one with null, clears
// the manual values first.
const radioOf = (dev) => (dev.applianceRadio ??= { rfProfileId: null, twoFourGhzSettings: { channel: null, targetPower: null }, fiveGhzSettings: { channel: null, channelWidth: null, targetPower: null } });

function radioJson(dev) {
  const r = radioOf(dev);
  const known = profilesOf(dev.net).list.some((p) => p.id === r.rfProfileId);
  return { serial: dev.serial, rfProfileId: known ? r.rfProfileId : null, twoFourGhzSettings: { ...r.twoFourGhzSettings }, fiveGhzSettings: { ...r.fiveGhzSettings } };
}

function updateRadio(ctx) {
  const dev = radioDevice(ctx);
  const b = ctx.body;
  const two = b.twoFourGhzSettings ?? {};
  const five = b.fiveGhzSettings ?? {};
  if ('rfProfileId' in b && b.rfProfileId != null && !profilesOf(dev.net).list.some((p) => p.id === b.rfProfileId)) throw badRequest(`RF profile ${b.rfProfileId} does not exist in this network`);
  if (two.channel != null && !CHANNELS_24.includes(two.channel)) throw badRequest("'twoFourGhzSettings.channel' must be a 2.4 GHz channel from 1 to 14");
  if (five.channel != null && !CHANNELS_5.includes(five.channel)) throw badRequest(`'fiveGhzSettings.channel' must be one of ${CHANNELS_5.join(', ')}`);
  if (five.channelWidth != null && !WIDTHS_5.includes(five.channelWidth)) throw badRequest(`'fiveGhzSettings.channelWidth' must be one of ${WIDTHS_5.join(', ')}`);
  for (const [k, v] of [['twoFourGhzSettings', two], ['fiveGhzSettings', five]]) {
    if (v.targetPower != null && !(Number.isInteger(v.targetPower) && v.targetPower >= 2 && v.targetPower <= 30)) throw badRequest(`'${k}.targetPower' must be an integer from 2 to 30 dBm`);
  }
  const r = radioOf(dev);
  if ('rfProfileId' in b) {
    r.rfProfileId = b.rfProfileId ?? null;
    for (const s of [r.twoFourGhzSettings, r.fiveGhzSettings]) for (const k of Object.keys(s)) s[k] = null;
  }
  for (const [s, v] of [[r.twoFourGhzSettings, two], [r.fiveGhzSettings, five]]) for (const k of Object.keys(s)) if (k in v) s[k] = v[k] ?? null;
  return radioJson(dev);
}

// ── SSIDs ──

const ssidsOf = (net) =>
  stored(net, 'applianceSsids', () =>
    SSID_NUMBERS.map((number) => ({
      number,
      name: `Unconfigured SSID ${number}`,
      enabled: false,
      defaultVlanId: null,
      authMode: 'open',
      psk: null,
      radiusServers: [],
      encryptionMode: 'wpa',
      wpaEncryptionMode: 'WPA2 only',
      visible: true,
      dhcpEnforcedDeauthentication: { enabled: false },
      dot11w: { enabled: false, required: false },
    })),
  );

function ssidOf(net, number) {
  const s = ssidsOf(net).find((x) => String(x.number) === number);
  if (!s) throw notFound('SSID');
  return s;
}

// A VLAN that is gone, or VLANs turned off, puts the SSID on the first VLAN
// (VLAN 1 is the single LAN).
function vlanOf(net, id) {
  const c = configOf(net);
  if (!c.vlansEnabled) return 1;
  const v = c.vlans.find((x) => x.id === String(id)) ?? c.vlans[0];
  return Number(v.id);
}

function ssidJson(net, s) {
  const out = { number: s.number, name: s.name, enabled: s.enabled, defaultVlanId: vlanOf(net, s.defaultVlanId), authMode: s.authMode };
  if (s.authMode === '8021x-radius') out.radiusServers = s.radiusServers.map((r) => ({ host: r.host, port: r.port }));
  if (s.authMode === 'psk') out.encryptionMode = s.encryptionMode;
  if (s.authMode.startsWith('8021x') || (s.authMode === 'psk' && s.encryptionMode === 'wpa')) out.wpaEncryptionMode = s.wpaEncryptionMode;
  out.visible = s.visible;
  return out;
}

function updateSsid(ctx) {
  const net = wifiNet(ctx);
  const s = ssidOf(net, ctx.params.number);
  const b = ctx.body;
  const authMode = b.authMode ?? s.authMode;
  const encryptionMode = b.encryptionMode ?? s.encryptionMode;
  if (b.name != null && !String(b.name).trim()) throw badRequest("'name' must not be empty");
  if (!AUTH_MODES.includes(authMode)) throw badRequest(`'authMode' must be one of ${AUTH_MODES.join(', ')}`);
  if (b.defaultVlanId != null) {
    const c = configOf(net);
    if (!c.vlansEnabled) throw badRequest("'defaultVlanId' is only valid when VLANs are enabled on this network");
    if (!c.vlans.some((v) => v.id === String(b.defaultVlanId))) throw badRequest(`VLAN ${b.defaultVlanId} does not exist in this network`);
  }
  if (b.psk != null && authMode !== 'psk') throw badRequest("'psk' is only valid when authMode is psk");
  if (b.encryptionMode != null && authMode !== 'psk') throw badRequest("'encryptionMode' is only valid when authMode is psk");
  if (b.radiusServers != null && authMode !== '8021x-radius') throw badRequest("'radiusServers' is only valid when authMode is 8021x-radius");
  if (b.wpaEncryptionMode != null && !(authMode.startsWith('8021x') || (authMode === 'psk' && encryptionMode === 'wpa'))) throw badRequest("'wpaEncryptionMode' is only valid with WPA encryption or 802.1X");
  const psk = b.psk ?? s.psk;
  if (authMode === 'psk') {
    if (psk == null) throw badRequest("'psk' is required when authMode is psk");
    if (encryptionMode === 'wpa' && (psk.length < 8 || psk.length > 63)) throw badRequest("'psk' must be 8 to 63 characters");
    if (encryptionMode === 'wep' && ![5, 13].includes(psk.length)) throw badRequest("A WEP 'psk' must be 5 or 13 characters");
  }
  const servers = b.radiusServers ?? s.radiusServers;
  if (b.radiusServers != null) {
    for (const r of servers) {
      if (r.host == null || parseIp(r.host) == null) throw badRequest("'radiusServers.host' must be an IP address");
      if (r.port != null && !(Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535)) throw badRequest("'radiusServers.port' must be from 1 to 65535");
    }
  }
  if (authMode === '8021x-radius' && !servers.length) throw badRequest("'radiusServers' is required when authMode is 8021x-radius");
  for (const k of ['name', 'enabled', 'visible', 'authMode', 'encryptionMode', 'wpaEncryptionMode']) if (b[k] != null) s[k] = b[k];
  if (b.defaultVlanId != null) s.defaultVlanId = b.defaultVlanId;
  s.psk = psk;
  if (b.radiusServers != null) s.radiusServers = servers.map((r) => ({ host: r.host, port: r.port ?? 1812, secret: r.secret ?? null }));
  if (b.dhcpEnforcedDeauthentication?.enabled != null) s.dhcpEnforcedDeauthentication.enabled = b.dhcpEnforcedDeauthentication.enabled;
  for (const k of ['enabled', 'required']) if (b.dot11w?.[k] != null) s.dot11w[k] = b.dot11w[k];
  return ssidJson(net, s);
}

// ── vMX authentication token ──

function vmxToken(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'appliance');
  if (!dev.model.startsWith('VMX')) throw badRequest('Authentication tokens are only for vMX appliances');
  dev.vmxTokens = (dev.vmxTokens ?? 0) + 1;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:vmxToken:${dev.serial}:${dev.vmxTokens}`));
  return { token: `${r.hex(32)}/${r.hex(13)}`, expiresAt: iso(ctx.now + TOKEN_LIFE) };
}

export default [
  { op: 'getDeviceApplianceRadioSettings', path: '/devices/{serial}/appliance/radio/settings', sample: { serial: 'appliance', status: 400 }, handler: (ctx) => radioJson(radioDevice(ctx)) },
  { op: 'updateDeviceApplianceRadioSettings', method: 'PUT', path: '/devices/{serial}/appliance/radio/settings', sample: { serial: 'appliance' }, handler: updateRadio },
  { op: 'createDeviceApplianceVmxAuthenticationToken', method: 'POST', path: '/devices/{serial}/appliance/vmx/authenticationToken', sample: { serial: 'appliance' }, handler: vmxToken },
  {
    op: 'getNetworkApplianceRfProfiles',
    path: '/networks/{networkId}/appliance/rfProfiles',
    sample: { status: 400 },
    handler: (ctx) => {
      const net = wifiNet(ctx);
      return { assigned: profilesOf(net).list.map((x) => profileJson(x, net)) };
    },
  },
  ...profiles.routes,
  { op: 'getNetworkApplianceSsids', path: '/networks/{networkId}/appliance/ssids', sample: { status: 400 }, handler: (ctx) => { const net = wifiNet(ctx); return ssidsOf(net).map((s) => ssidJson(net, s)); } },
  { op: 'getNetworkApplianceSsid', path: '/networks/{networkId}/appliance/ssids/{number}', sample: { number: '1', status: 400 }, handler: (ctx) => { const net = wifiNet(ctx); return ssidJson(net, ssidOf(net, ctx.params.number)); } },
  { op: 'updateNetworkApplianceSsid', method: 'PUT', path: '/networks/{networkId}/appliance/ssids/{number}', sample: { number: '1' }, handler: updateSsid },
];
