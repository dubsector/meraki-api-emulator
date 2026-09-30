// Wireless settings, RF profiles, SSID firewall and splash pages, radio status,
// channel utilization, signal quality and failed connections.

import { arrayParam, badRequest, intParam, notFound, paginate, resolutionParam, timeWindow } from '../http.js';
import { hashStr } from '../rng.js';
import { connectFailure, failureTime } from '../sim/events.js';
import { isDown } from '../sim/outages.js';
import { START, eachSession, presenceIn } from '../sim/presence.js';
import { RADIO, WIDTH, apChannel, apPower, bssid, channelUtilization, clientSignal } from '../sim/rf.js';
import { clientUsage } from '../sim/usage.js';
import { DAY, HOUR, iso, isoMicro } from '../time.js';
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
  return { number: n, ssid: net.ssids.find((s) => s.number === n) };
}

// ── Settings and RF profiles ──

function rfProfiles(net) {
  const six = net.aps.some((a) => a.info.bands.includes('6'));
  const bands = six ? ['2.4', '5', '6'] : ['2.4', '5'];
  const mode = six ? 'multi' : 'dual';
  const perSsid = Object.fromEntries(
    Array.from({ length: 15 }, (_, n) => [String(n), { name: net.ssids.find((s) => s.number === n)?.name ?? `Unconfigured SSID ${n + 1}`, minBitrate: 11, bandOperationMode: mode, bands: { enabled: bands }, bandSteeringEnabled: true }]),
  );
  const profile = (name, indoor, i) => ({
    id: String(100000 + ((hashStr(net.id) + i) % 900000)),
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
  });
  return [profile('Basic Indoor Profile', true, 0), profile('Basic Outdoor Profile', false, 1)];
}

// MR78s are outdoor APs, so they get the outdoor profile.
function apProfile(ap) {
  return rfProfiles(ap.net)[ap.model === 'MR78' ? 1 : 0];
}

function wirelessSettings(net) {
  const [name, countryCode] = REGULATORY[net.timeZone] ?? ['FCC', 'US'];
  return {
    meshingEnabled: false,
    ipv6BridgeEnabled: false,
    locationAnalyticsEnabled: net.kind === 'retail',
    upgradeStrategy: 'minimizeUpgradeTime',
    upgrade: { predownload: { enabled: false } },
    ledLightsOn: net.kind !== 'office',
    multicastToUnicastConversion: { enabled: false },
    namedVlans: { poolDhcpMonitoring: { enabled: false, duration: 3 } },
    regulatoryDomain: { name, countryCode, permits6e: true },
  };
}

// Guest SSIDs keep clients off the LAN; everything else may reach it.
function ssidL3Rules(ssid) {
  const lan = !!ssid && ssid.key !== 'guest';
  return {
    rules: [
      { comment: 'Wireless clients accessing LAN', policy: lan ? 'allow' : 'deny', ipVer: 'ipv4', protocol: 'Any', destPort: 'Any', destCidr: 'Local LAN' },
      { comment: 'Default rule', policy: 'allow', ipVer: 'both', protocol: 'Any', destPort: 'Any', destCidr: 'Any' },
    ],
    allowLanAccess: lan,
  };
}

function splashSettings(number, ssid) {
  const none = { md5: null, extension: null };
  return {
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
  };
}

// ── Radios ──

function wirelessStatus(ap, now) {
  const sets = [];
  for (const s of ap.net.ssids) {
    for (const band of ap.info.bands) {
      sets.push({
        ssidName: s.name,
        ssidNumber: s.number,
        enabled: true,
        band: `${band} GHz`,
        bssid: bssid(ap, band, s.number),
        channel: apChannel(ap, band),
        channelWidth: `${WIDTH[band]} MHz`,
        power: `${apPower(ap, band)} dBm`,
        visible: true,
        broadcasting: !isDown(ap, now),
      });
    }
  }
  return { basicServiceSets: sets };
}

function radioSettings(ap) {
  return {
    serial: ap.serial,
    rfProfileId: apProfile(ap).id,
    twoFourGhzSettings: { channel: apChannel(ap, '2.4'), targetPower: apPower(ap, '2.4') },
    fiveGhzSettings: { channel: apChannel(ap, '5'), channelWidth: WIDTH[5], targetPower: apPower(ap, '5') },
  };
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
    op: 'getNetworkWirelessSettings',
    path: '/networks/{networkId}/wireless/settings',
    handler: (ctx) => wirelessSettings(wirelessNet(ctx)),
  },
  {
    op: 'getNetworkWirelessRfProfiles',
    path: '/networks/{networkId}/wireless/rfProfiles',
    handler: (ctx) => rfProfiles(wirelessNet(ctx)),
  },
  {
    op: 'getNetworkWirelessRfProfile',
    path: '/networks/{networkId}/wireless/rfProfiles/{rfProfileId}',
    sample: { rfProfileId: (world) => rfProfiles(world.orgs[0].networks[0])[0].id },
    handler: (ctx) => {
      const p = rfProfiles(wirelessNet(ctx)).find((x) => x.id === ctx.params.rfProfileId);
      if (!p) throw notFound('RF profile');
      return p;
    },
  },
  {
    op: 'getNetworkWirelessSsidFirewallL3FirewallRules',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l3FirewallRules',
    sample: { number: '1' },
    handler: (ctx) => ssidL3Rules(ssidOf(wirelessNet(ctx), ctx).ssid),
  },
  {
    op: 'getNetworkWirelessSsidFirewallL7FirewallRules',
    path: '/networks/{networkId}/wireless/ssids/{number}/firewall/l7FirewallRules',
    sample: { number: '1' },
    handler: (ctx) => {
      const { ssid } = ssidOf(wirelessNet(ctx), ctx);
      return { rules: ssid?.key === 'guest' ? [{ policy: 'deny', type: 'applicationCategory', value: { id: 'meraki:layer7/category/2', name: 'Peer-to-peer (P2P)' } }] : [] };
    },
  },
  {
    op: 'getNetworkWirelessSsidSplashSettings',
    path: '/networks/{networkId}/wireless/ssids/{number}/splash/settings',
    sample: { number: '1' },
    handler: (ctx) => {
      const { number, ssid } = ssidOf(wirelessNet(ctx), ctx);
      return splashSettings(number, ssid);
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
