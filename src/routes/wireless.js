// Wireless settings, RF profiles, SSID firewall and splash pages, radio status,
// channel utilization, signal quality and failed connections.

import { configOf, stored } from '../config.js';
import { arrayParam, badRequest, intParam, notFound, paginate, resolutionParam, timeWindow } from '../http.js';
import { hashStr } from '../rng.js';
import { connectFailure, failureTime } from '../sim/events.js';
import { isDown } from '../sim/outages.js';
import { START, eachSession, presenceIn } from '../sim/presence.js';
import { RADIO, WIDTH, apChannel, apPower, bssid, channelUtilization, clientSignal } from '../sim/rf.js';
import { clientUsage } from '../sim/usage.js';
import { DAY, HOUR, iso, isoMicro } from '../time.js';
import { merge } from '../validate.js';
import { bySerial, devOf, netOf, orgOf, requireModel, requireProduct, round } from './common.js';

const BANDS = ['2.4', '5', '6'];
const MB = 1024;
const REGULATORY = { 'Europe/London': ['ETSI', 'GB'], 'America/Toronto': ['ISED', 'CA'] };
const FIVE_GHZ = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
const SIX_GHZ = Array.from({ length: 59 }, (_, i) => 1 + i * 4);

function wirelessNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'wireless');
  return net;
}

function bandParam(q) {
  const band = q.get('band');
  if (band && !BANDS.includes(band)) throw badRequest("'band' must be one of: 2.4, 5, 6");
  return band;
}

function findClient(net, id) {
  const lower = id.toLowerCase();
  const c = net.clients.find((x) => x.id === id || x.mac === lower);
  if (!c || c.wired) throw notFound('Client');
  return c;
}

function ssidOf(net, ctx) {
  const n = Number(ctx.params.number);
  if (!Number.isInteger(n) || n < 0 || n > 14) throw notFound('SSID');
  return { number: n, ssid: net.ssids.find((s) => s.number === n), config: configOf(net).ssids[n] };
}

// ── Settings and RF profiles ──

function rfProfile(net, id, name, indoor) {
  const six = net.aps.some((a) => a.info.bands.includes('6'));
  const bands = six ? ['2.4', '5', '6'] : ['2.4', '5'];
  const mode = six ? 'multi' : 'dual';
  const ssids = configOf(net).ssids;
  const perSsid = Object.fromEntries(ssids.map((s, n) => [String(n), { name: s.name, minBitrate: 11, bandOperationMode: mode, bands: { enabled: bands }, bandSteeringEnabled: true }]));
  return {
    id,
    networkId: net.id,
    name,
    clientBalancingEnabled: true,
    minBitrateType: 'band',
    bandSelectionType: 'ap',
    apBandSettings: { bandOperationMode: mode, bands: { enabled: bands }, bandSteeringEnabled: true },
    twoFourGhzSettings: { maxPower: 30, minPower: 5, minBitrate: 11, validAutoChannels: [1, 6, 11], axEnabled: true, dot11ax: { enabled: true }, rxsop: null },
    fiveGhzSettings: { maxPower: 30, minPower: 8, minBitrate: 12, validAutoChannels: indoor ? FIVE_GHZ : FIVE_GHZ.filter((c) => c >= 100), channelWidth: 'auto', rxsop: null, dot11ax: { enabled: true } },
    sixGhzSettings: { maxPower: 30, minPower: 8, minBitrate: 12, validAutoChannels: SIX_GHZ, channelWidth: 'auto', rxsop: null },
    transmission: { enabled: true },
    perSsidSettings: perSsid,
    isIndoorDefault: indoor,
    isOutdoorDefault: !indoor,
  };
}

function profileId(net, i) {
  return String(100000 + ((hashStr(net.id) + i) % 900000));
}

// Every wireless network starts with the two basic profiles.
function profilesOf(net) {
  return stored(net, 'rfProfiles', () => [rfProfile(net, profileId(net, 0), 'Basic Indoor Profile', true), rfProfile(net, profileId(net, 1), 'Basic Outdoor Profile', false)]);
}

function profileOf(net, id) {
  const p = profilesOf(net).find((x) => x.id === id);
  if (!p) throw notFound('RF profile');
  return p;
}

// An AP uses the profile set on its radio, else the default; MR78s are outdoor APs.
function apProfile(ap) {
  const list = profilesOf(ap.net);
  return list.find((p) => p.id === ap.radio?.rfProfileId) ?? list.find((p) => (ap.model === 'MR78' ? p.isOutdoorDefault : p.isIndoorDefault)) ?? list[0];
}

function wirelessSettings(net) {
  const [name, countryCode] = REGULATORY[net.timeZone] ?? ['FCC', 'US'];
  return stored(net, 'wirelessSettings', () => ({
    meshingEnabled: false,
    ipv6BridgeEnabled: false,
    locationAnalyticsEnabled: net.kind === 'retail',
    upgradeStrategy: 'minimizeUpgradeTime',
    upgrade: { predownload: { enabled: false } },
    ledLightsOn: net.kind !== 'office',
    multicastToUnicastConversion: { enabled: false },
    namedVlans: { poolDhcpMonitoring: { enabled: false, duration: 3 } },
    regulatoryDomain: { name, countryCode, permits6e: true },
  }));
}

// Guest SSIDs keep clients off the LAN; everything else may reach it. The LAN
// and default rules always come last, after any rules written through the API.
function ssidL3(net, number) {
  const all = stored(net, 'ssidL3', () => ({}));
  return (all[number] ??= { rules: [], allowLanAccess: net.ssids.find((s) => s.number === number)?.key !== 'guest' });
}

function ssidL3Json(set) {
  return {
    rules: [
      ...set.rules,
      { comment: 'Wireless clients accessing LAN', policy: set.allowLanAccess ? 'allow' : 'deny', ipVer: 'ipv4', protocol: 'Any', destPort: 'Any', destCidr: 'Local LAN' },
      { comment: 'Default rule', policy: 'allow', ipVer: 'both', protocol: 'Any', destPort: 'Any', destCidr: 'Any' },
    ],
    allowLanAccess: set.allowLanAccess,
  };
}

function ssidL7(net, number) {
  const all = stored(net, 'ssidL7', () => ({}));
  const guest = net.ssids.find((s) => s.number === number)?.key === 'guest';
  return (all[number] ??= { rules: guest ? [{ policy: 'deny', type: 'applicationCategory', value: { id: 'meraki:layer7/category/2', name: 'Peer-to-peer (P2P)' } }] : [] });
}

function splashSettings(net, number) {
  const all = stored(net, 'splash', () => ({}));
  const ssid = net.ssids.find((s) => s.number === number);
  const none = { md5: null, extension: null };
  return (all[number] ??= {
    ssidNumber: number,
    splashPage: ssid?.splashPage || 'None',
    useSplashUrl: false,
    splashUrl: null,
    splashTimeout: 1440,
    redirectUrl: null,
    useRedirectUrl: false,
    welcomeMessage: ssid?.splashPage ? 'Welcome to Acme guest Wi-Fi.' : null,
    userConsent: { required: false, message: null },
    themeId: null,
    splashLogo: none,
    splashImage: none,
    splashPrepaidFront: none,
    guestSponsorship: { durationInMinutes: 30, guestCanRequestTimeframe: false },
    blockAllTrafficBeforeSignOn: false,
    controllerDisconnectionBehavior: 'default',
    allowSimultaneousLogins: false,
    billing: { freeAccess: { enabled: false, durationInMinutes: 20 }, prepaidAccessFastLoginEnabled: false, replyToEmailAddress: null },
    sentryEnrollment: { systemsManagerNetwork: { id: null }, strength: 'focused', enforcedSystems: [] },
    selfRegistration: { enabled: false, authorizationType: 'admin' },
  });
}

// PSK and 802.1X settings only make sense for their own auth mode, so a change
// of mode drops the other mode's fields. A new name also renames the SSID the
// simulated clients use.
function updateSsid(ctx) {
  const net = wirelessNet(ctx);
  const { number, ssid, config } = ssidOf(net, ctx);
  const { number: ignored, ...patch } = ctx.body;
  const next = merge(structuredClone(config), patch);
  if (next.authMode === 'psk') {
    if (!next.psk || next.psk.length < 8 || next.psk.length > 63) throw badRequest("'psk' must be 8 to 63 characters when authMode is psk");
    next.encryptionMode ??= 'wpa';
    next.wpaEncryptionMode ??= 'WPA2 only';
  } else {
    delete next.psk;
    if (!String(next.authMode).startsWith('8021x')) delete next.encryptionMode;
    if (next.authMode === 'open') delete next.wpaEncryptionMode;
  }
  if (next.authMode === '8021x-radius' && !next.radiusServers?.length) throw badRequest("'radiusServers' is required when authMode is 8021x-radius");
  // Server IDs are assigned by the API: a host and port it already knows keep theirs.
  if (next.radiusServers) {
    next.radiusServers = next.radiusServers.map((s) => ({ id: config.radiusServers?.find((o) => o.host === s.host && o.port === s.port)?.id ?? String(hashStr(`${net.id}:${s.host}:${s.port}`) % 1e9), ...s }));
  }
  if (patch.name && ssid) ssid.name = patch.name;
  configOf(net).ssids[number] = next;
  return next;
}

// ── Radios ──

function wirelessStatus(ap, now) {
  const sets = [];
  configOf(ap.net).ssids.forEach((s, number) => {
    if (!s.enabled) return;
    for (const band of ap.info.bands) {
      sets.push({
        ssidName: s.name,
        ssidNumber: number,
        enabled: true,
        band: `${band} GHz`,
        bssid: bssid(ap, band, number),
        channel: apChannel(ap, band),
        channelWidth: `${WIDTH[band]} MHz`,
        power: `${apPower(ap, band)} dBm`,
        visible: s.visible !== false,
        broadcasting: !isDown(ap, now),
      });
    }
  });
  return { basicServiceSets: sets };
}

function radioSettings(ap) {
  return {
    serial: ap.serial,
    rfProfileId: apProfile(ap).id,
    twoFourGhzSettings: { channel: apChannel(ap, '2.4'), targetPower: apPower(ap, '2.4') },
    fiveGhzSettings: { channel: apChannel(ap, '5'), channelWidth: ap.radio?.fiveGhzSettings?.channelWidth ?? WIDTH[5], targetPower: apPower(ap, '5') },
  };
}

// Channels have to be ones the band offers; power is in dBm.
function updateRadio(ctx) {
  const ap = devOf(ctx);
  requireModel(ap, 'wireless');
  const b = ctx.body;
  if (b.rfProfileId != null) profileOf(ap.net, b.rfProfileId);
  const two = b.twoFourGhzSettings?.channel;
  if (two != null && !(two >= 1 && two <= 14)) throw badRequest("'twoFourGhzSettings.channel' must be a 2.4 GHz channel from 1 to 14");
  const five = b.fiveGhzSettings?.channel;
  if (five != null && !FIVE_GHZ.includes(five)) throw badRequest(`'fiveGhzSettings.channel' must be one of: ${FIVE_GHZ.join(', ')}`);
  ap.radio = merge(ap.radio || {}, b);
  return radioSettings(ap);
}

// Average utilization over the chosen APs and bands.
function averageUtilization(aps, bands, t0, t1) {
  let n = 0;
  const sum = { wifi: 0, nonWifi: 0, total: 0 };
  for (const ap of aps) {
    for (const band of ap.info.bands) {
      if (bands && !bands.includes(band)) continue;
      const u = channelUtilization(ap, band, t0, t1);
      sum.wifi += u.wifi;
      sum.nonWifi += u.nonWifi;
      sum.total += u.total;
      n++;
    }
  }
  return n ? { wifi: round(sum.wifi / n, 2), nonWifi: round(sum.nonWifi / n, 2), total: round(sum.total / n, 2) } : null;
}

function byBand(aps, t0, t1) {
  const bands = BANDS.filter((b) => aps.some((a) => a.info.bands.includes(b)));
  return bands.map((band) => {
    const u = averageUtilization(aps, [band], t0, t1);
    return { band, wifi: { percentage: u.wifi }, nonWifi: { percentage: u.nonWifi }, total: { percentage: u.total } };
  });
}

function historyWindow(ctx, resolutions) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 7 * DAY, lookback: 31 * DAY });
  const res = resolutionParam(ctx.query, resolutions, 86400, t1 - t0);
  const out = [];
  for (let s = Math.floor(t0 / res) * res; s < t1; s += res) out.push([s, s + res, Math.max(s, t0), Math.min(s + res, t1)]);
  return out;
}

function utilizationHistory(ctx) {
  const net = wirelessNet(ctx);
  const q = ctx.query;
  const band = bandParam(q);
  let aps = net.aps;
  let bands = band ? [band] : null;
  if (q.get('deviceSerial')) {
    aps = aps.filter((a) => a.serial === q.get('deviceSerial'));
    if (!aps.length) throw notFound('Device');
  }
  if (q.get('apTag')) aps = aps.filter((a) => a.tags.includes(q.get('apTag')));
  if (q.get('clientId')) {
    const c = findClient(net, q.get('clientId'));
    aps = [c.ap];
    bands = [c.band];
  }
  return historyWindow(ctx, [600, 1200, 3600, 14400, 86400]).map(([s, e, a, b]) => {
    const u = averageUtilization(aps, bands, a, b) ?? { wifi: 0, nonWifi: 0, total: 0 };
    return { startTs: iso(s), endTs: iso(e), utilizationTotal: u.total, utilization80211: u.wifi, utilizationNon80211: u.nonWifi };
  });
}

function signalHistory(ctx) {
  const net = wirelessNet(ctx);
  const q = ctx.query;
  const band = bandParam(q);
  const ssid = intParam(q, 'ssid', null, { min: 0, max: 14 });
  let clients;
  if (q.get('clientId')) clients = [findClient(net, q.get('clientId'))];
  else if (q.get('deviceSerial')) {
    const ap = net.aps.find((a) => a.serial === q.get('deviceSerial'));
    if (!ap) throw notFound('Device');
    clients = net.clients.filter((c) => c.ap === ap && !c.wired);
  } else throw badRequest("'clientId' or 'deviceSerial' is required");
  if (q.get('apTag')) clients = clients.filter((c) => c.ap.tags.includes(q.get('apTag')));
  clients = clients.filter((c) => (!band || c.band === band) && (ssid == null || c.ssid.number === ssid));
  return historyWindow(ctx, [300, 600, 1200, 3600, 14400, 86400]).map(([s, e, a, b]) => {
    let w = 0;
    let rssi = 0;
    let snr = 0;
    for (const c of clients) {
      const p = presenceIn(c, a, b);
      if (!p) continue;
      const sig = clientSignal(c, (p.first + p.last) / 2);
      w += p.seconds;
      rssi += sig.rssi * p.seconds;
      snr += sig.snr * p.seconds;
    }
    return { startTs: iso(s), endTs: iso(e), snr: w ? Math.round(snr / w) : null, rssi: w ? Math.round(rssi / w) : null };
  });
}

const FAILURE_TYPE = { assoc: '802.11 association rejected', dhcp: 'DHCP no offers', dns: 'DNS failure' };

function failedConnections(ctx) {
  const net = wirelessNet(ctx);
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 7 * DAY, lookback: 180 * DAY });
  const band = bandParam(q);
  const ssid = intParam(q, 'ssid', null, { min: 0, max: 14 });
  const apTag = q.get('apTag');
  const serial = q.get('serial');
  const mac = q.get('clientId')?.toLowerCase();
  const rows = [];
  for (const c of net.clients) {
    if (c.wired || (band && c.band !== band) || (ssid != null && c.ssid.number !== ssid) || (apTag && !c.ap.tags.includes(apTag)) || (serial && c.ap.serial !== serial) || (mac && c.mac !== mac)) continue;
    eachSession(c, t0 - 60, t1 + 60, (s, e, flags) => {
      if (!(flags & START)) return;
      const step = connectFailure(c, s);
      const t = failureTime(c, s);
      if (!step || t < t0 || t >= t1) return;
      const type = step === 'auth' ? (c.ssid.auth === '8021x' ? '802.1X auth fail' : 'WPA auth fail') : FAILURE_TYPE[step];
      rows.push({ ssidNumber: c.ssid.number, vlan: c.vlan, clientMac: c.mac, serial: c.ap.serial, radio: Number(RADIO[c.band]), failureStep: step, type, ts: isoMicro(t) });
    });
  }
  return rows.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// ── Organization-wide ──

function orgAps(ctx) {
  const networkIds = arrayParam(ctx.query, 'networkIds');
  const serials = arrayParam(ctx.query, 'serials');
  return orgOf(ctx)
    .devices.filter((d) => d.productType === 'wireless' && (!networkIds.length || networkIds.includes(d.net.id)) && (!serials.length || serials.includes(d.serial)))
    .sort(bySerial);
}

function utilizationWindow(ctx) {
  const interval = intParam(ctx.query, 'interval', 3600);
  if (![300, 600, 3600, 7200, 14400, 21600].includes(interval)) throw badRequest("'interval' must be one of 300, 600, 3600, 7200, 14400, 21600");
  return timeWindow(ctx.query, ctx.now, { maxSpan: 90 * DAY, defaultSpan: 7 * DAY, lookback: 90 * DAY });
}

function topSsids(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 186 * DAY, minSpan: 8 * HOUR });
  const quantity = intParam(q, 'quantity', 10, { min: 1, max: 50 });
  const tag = q.get('networkTag');
  const deviceTag = q.get('deviceTag');
  const only = q.get('ssidName');
  const totals = new Map();
  for (const net of org.networks) {
    if (tag && !net.tags.includes(tag)) continue;
    for (const c of net.clients) {
      if (c.wired || (only && c.ssid.name !== only) || (deviceTag && !c.ap.tags.includes(deviceTag)) || !presenceIn(c, t0, t1)) continue;
      const u = clientUsage(c, t0, t1);
      const row = totals.get(c.ssid.name) || { name: c.ssid.name, up: 0, down: 0, clients: 0 };
      row.up += u.sent / MB;
      row.down += u.recv / MB;
      row.clients++;
      totals.set(c.ssid.name, row);
    }
  }
  const rows = [...totals.values()];
  const sum = rows.reduce((a, r) => a + r.up + r.down, 0) || 1;
  return rows
    .sort((a, b) => b.up + b.down - (a.up + a.down))
    .slice(0, quantity)
    .map((r) => ({
      name: r.name,
      usage: { total: round(r.up + r.down, 1), downstream: round(r.down, 1), upstream: round(r.up, 1), percentage: round(((r.up + r.down) / sum) * 100, 4) },
      clients: { counts: { total: r.clients } },
    }));
}

export default [
  {
    op: 'getNetworkWirelessSsids',
    path: '/networks/{networkId}/wireless/ssids',
    handler: (ctx) => configOf(wirelessNet(ctx)).ssids,
  },
  {
    op: 'getNetworkWirelessSsid',
    path: '/networks/{networkId}/wireless/ssids/{number}',
    sample: { number: '0' },
    handler: (ctx) => ssidOf(wirelessNet(ctx), ctx).config,
  },
  { op: 'updateNetworkWirelessSsid', method: 'PUT', path: '/networks/{networkId}/wireless/ssids/{number}', handler: updateSsid },
  {
    op: 'getNetworkWirelessSettings',
    path: '/networks/{networkId}/wireless/settings',
    handler: (ctx) => wirelessSettings(wirelessNet(ctx)),
  },
  {
    op: 'updateNetworkWirelessSettings',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/settings',
    handler: (ctx) => merge(wirelessSettings(wirelessNet(ctx)), ctx.body),
  },
  {
    op: 'getNetworkWirelessRfProfiles',
    path: '/networks/{networkId}/wireless/rfProfiles',
    handler: (ctx) => profilesOf(wirelessNet(ctx)),
  },
  {
    op: 'createNetworkWirelessRfProfile',
    method: 'POST',
    path: '/networks/{networkId}/wireless/rfProfiles',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const list = profilesOf(net);
      if (list.some((p) => p.name === ctx.body.name)) throw badRequest('Name has already been taken');
      if (list.length >= 100) throw badRequest('Networks are limited to 100 RF profiles in the emulator');
      let i = list.length;
      while (list.some((p) => p.id === profileId(net, i))) i++;
      const profile = merge({ ...rfProfile(net, profileId(net, i), ctx.body.name, true), isIndoorDefault: false, isOutdoorDefault: false }, ctx.body);
      list.push(profile);
      return profile;
    },
  },
  {
    op: 'getNetworkWirelessRfProfile',
    path: '/networks/{networkId}/wireless/rfProfiles/{rfProfileId}',
    sample: { rfProfileId: (world) => profilesOf(world.orgs[0].networks[0])[0].id },
    handler: (ctx) => profileOf(wirelessNet(ctx), ctx.params.rfProfileId),
  },
  {
    op: 'updateNetworkWirelessRfProfile',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/rfProfiles/{rfProfileId}',
    handler: (ctx) => {
      const { id, networkId, ...patch } = ctx.body;
      return merge(profileOf(wirelessNet(ctx), ctx.params.rfProfileId), patch);
    },
  },
  {
    op: 'deleteNetworkWirelessRfProfile',
    method: 'DELETE',
    path: '/networks/{networkId}/wireless/rfProfiles/{rfProfileId}',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const p = profileOf(net, ctx.params.rfProfileId);
      if (p.isIndoorDefault || p.isOutdoorDefault) throw badRequest('The basic RF profiles cannot be deleted');
      if (net.aps.some((a) => a.radio?.rfProfileId === p.id)) throw badRequest('This RF profile is assigned to an access point');
      const list = profilesOf(net);
      list.splice(list.indexOf(p), 1);
    },
  },
  {
    op: 'getNetworkWirelessSsidFirewallL3FirewallRules',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l3FirewallRules',
    sample: { number: '1' },
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      return ssidL3Json(ssidL3(net, ssidOf(net, ctx).number));
    },
  },
  {
    op: 'updateNetworkWirelessSsidFirewallL3FirewallRules',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l3FirewallRules',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const set = ssidL3(net, ssidOf(net, ctx).number);
      const { rules, allowLanAccess } = ctx.body;
      // The LAN and default rules are generated, so copies sent back are dropped.
      if (rules) set.rules = rules.filter((r) => r.comment !== 'Default rule' && r.comment !== 'Wireless clients accessing LAN').map((r) => ({ comment: r.comment ?? '', policy: r.policy, ipVer: r.ipVer ?? 'ipv4', protocol: r.protocol, destPort: r.destPort ?? 'Any', destCidr: r.destCidr }));
      if (allowLanAccess != null) set.allowLanAccess = allowLanAccess;
      return ssidL3Json(set);
    },
  },
  {
    op: 'getNetworkWirelessSsidFirewallL7FirewallRules',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l7FirewallRules',
    sample: { number: '1' },
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      return ssidL7(net, ssidOf(net, ctx).number);
    },
  },
  {
    op: 'updateNetworkWirelessSsidFirewallL7FirewallRules',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l7FirewallRules',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const set = ssidL7(net, ssidOf(net, ctx).number);
      if (ctx.body.rules) set.rules = ctx.body.rules;
      return set;
    },
  },
  {
    op: 'getNetworkWirelessSsidSplashSettings',
    path: '/networks/{networkId}/wireless/ssids/{number}/splash/settings',
    sample: { number: '1' },
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      return splashSettings(net, ssidOf(net, ctx).number);
    },
  },
  {
    op: 'updateNetworkWirelessSsidSplashSettings',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/ssids/{number}/splash/settings',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const { ssidNumber, ...patch } = ctx.body;
      return merge(splashSettings(net, ssidOf(net, ctx).number), patch);
    },
  },
  {
    op: 'getNetworkWirelessFailedConnections',
    path: '/networks/{networkId}/wireless/failedConnections',
    handler: failedConnections,
  },
  {
    op: 'getNetworkWirelessChannelUtilizationHistory',
    path: '/networks/{networkId}/wireless/channelUtilizationHistory',
    sample: { query: 'timespan=86400&resolution=3600&band=5' },
    handler: utilizationHistory,
  },
  {
    op: 'getNetworkWirelessSignalQualityHistory',
    path: '/networks/{networkId}/wireless/signalQualityHistory',
    sample: { query: (world) => `timespan=86400&resolution=3600&deviceSerial=${world.orgs[0].networks[0].aps[0].serial}` },
    handler: signalHistory,
  },
  {
    op: 'getDeviceWirelessStatus',
    path: '/devices/{serial}/wireless/status',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      return wirelessStatus(dev, ctx.now);
    },
  },
  {
    op: 'getDeviceWirelessRadioSettings',
    path: '/devices/{serial}/wireless/radio/settings',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      return radioSettings(dev);
    },
  },
  { op: 'updateDeviceWirelessRadioSettings', method: 'PUT', path: '/devices/{serial}/wireless/radio/settings', handler: updateRadio },
  {
    op: 'getOrganizationWirelessDevicesChannelUtilizationByDevice',
    path: '/organizations/{organizationId}/wireless/devices/channelUtilization/byDevice',
    sample: { query: 'timespan=86400' },
    handler: (ctx) => {
      const { t0, t1 } = utilizationWindow(ctx);
      const rows = orgAps(ctx).map((ap) => ({ serial: ap.serial, mac: ap.mac, network: { id: ap.net.id }, byBand: byBand([ap], t0, t1) }));
      return paginate(ctx, rows, (r) => r.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationWirelessDevicesChannelUtilizationByNetwork',
    path: '/organizations/{organizationId}/wireless/devices/channelUtilization/byNetwork',
    sample: { query: 'timespan=86400' },
    handler: (ctx) => {
      const { t0, t1 } = utilizationWindow(ctx);
      const aps = orgAps(ctx);
      const nets = [...new Set(aps.map((a) => a.net))].sort((a, b) => (a.id < b.id ? -1 : 1));
      const rows = nets.map((net) => ({ network: { id: net.id }, byBand: byBand(aps.filter((a) => a.net === net), t0, t1) }));
      return paginate(ctx, rows, (r) => r.network.id, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationSummaryTopSsidsByUsage',
    path: '/organizations/{organizationId}/summary/top/ssids/byUsage',
    handler: topSsids,
  },
];
