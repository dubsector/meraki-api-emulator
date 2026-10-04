// Systems Manager: devices enrolled in an SM network, their owners and the
// network's profiles. Enrolled devices aren't Meraki hardware, so they live in
// net.sm, never in world.devices. Lab - Systems Manager is seeded from its
// LAB_NETWORKS entry on its own stream; histories are worked out on read.

import { FIRST_NAMES, LAST_NAMES } from '../catalog.js';
import { Rand, derive, hashStr, unit } from '../rng.js';
import { DAY, HOUR, iso, weekday } from '../time.js';
import { bssid } from './rf.js';

export const LOOKBACK = 30 * DAY;
const EMPTY = { devices: [], users: [], profiles: [] };
const SERIAL_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const DOMAIN = 'acme-lab.example.com';
const CARRIERS = ['Rogers', 'Bell', 'TELUS'];

// What each kind of device reports. platform picks the profiles and apps it
// takes; desktops run the agent that sends performance history and logs.
export const KINDS = {
  iPhone: { systemType: 'iphone', platform: 'ios', label: 'iPhone', models: ['iPhone 15', 'iPhone 14'], osName: 'iOS 17.6.1', osBuild: '21G93', capacity: 128, phone: true, adapter: 'en0' },
  iPad: { systemType: 'ipad', platform: 'ios', label: 'iPad', models: ['iPad Air (5th generation)', 'iPad (10th generation)'], osName: 'iPadOS 17.6.1', osBuild: '21G93', capacity: 64, adapter: 'en0' },
  Mac: { systemType: 'mac', platform: 'macos', label: 'MacBook', models: ['MacBook Pro (14-inch, 2023)', 'MacBook Air (M2, 2022)'], osName: 'Mac OS X 14.6.1', osBuild: '23G93', capacity: 512, desktop: true, ram: 16384, adapter: 'en0', driver: 'Apple80211' },
  Windows: { systemType: 'windows', platform: 'windows', label: 'laptop', models: ['Latitude 7440', 'ThinkPad T14 Gen 4'], osName: 'Microsoft Windows 11 Pro 10.0.22631', osBuild: '22631.4169', capacity: 512, desktop: true, ram: 16384, adapter: 'Wi-Fi', driver: 'Intel(R) Wi-Fi 6E AX211 160MHz', bios: ['1.21.0', 'N3MET22W (1.21)'] },
  Android: { systemType: 'android', platform: 'android', label: 'phone', models: ['Pixel 8', 'Galaxy S23'], osName: 'Android 14', osBuild: 'AP2A.240905.003', capacity: 128, phone: true, adapter: 'wlan0', patch: '2024-09-05' },
  Chromebook: { systemType: 'chrome', platform: 'chrome', label: 'Chromebook', models: ['Chromebook Plus 514'], osName: 'Chrome OS 128.0.6613.133', osBuild: '15964.59.0', capacity: 64, adapter: 'wlan0' },
};

// Apps per platform: [name, identifier, vendor, version, managed].
const APPS = {
  ios: [['Meraki Systems Manager', 'com.meraki.sm', 'Cisco Meraki', '4.6.2', true], ['Slack', 'com.tinyspeck.chatlyio', 'Slack Technologies', '24.09.10', true], ['Microsoft Outlook', 'com.microsoft.Office.Outlook', 'Microsoft Corporation', '4.2436.0', true], ['Webex', 'com.cisco.webex.meetings', 'Cisco', '44.9.0', false]],
  macos: [['Meraki Systems Manager', 'com.meraki.sm.agent', 'Cisco Meraki', '3.8.1', true], ['Google Chrome', 'com.google.Chrome', 'Google LLC', '129.0.6668.59', true], ['Slack', 'com.tinyspeck.slackmacgap', 'Slack Technologies', '4.40.126', true], ['Zoom', 'us.zoom.xos', 'Zoom Video Communications', '6.2.3', true], ['Microsoft Word', 'com.microsoft.Word', 'Microsoft Corporation', '16.89', false]],
  windows: [['Meraki Systems Manager', 'Meraki Systems Manager Agent', 'Cisco Meraki', '3.8.1', true], ['Google Chrome', 'Google Chrome', 'Google LLC', '129.0.6668.59', true], ['Microsoft Teams', 'Microsoft Teams', 'Microsoft Corporation', '24215.1007.3082', true], ['Zoom Workplace', 'Zoom', 'Zoom Video Communications', '6.2.3', false]],
  android: [['Meraki Systems Manager', 'com.meraki.sm', 'Cisco Meraki', '4.6.0', true], ['Slack', 'com.Slack', 'Slack Technologies', '24.09.10', true], ['Microsoft Outlook', 'com.microsoft.office.outlook', 'Microsoft Corporation', '4.2436.1', true]],
  chrome: [['Google Docs', 'aohghmighlieiainnegkcijnfilokake', 'Google LLC', '0.10', true], ['Zoom', 'jldbdlmljpigglecmeclifcdhgbjbakk', 'Zoom Video Communications', '6.2.3', false]],
};

// The network's profiles; each device takes those whose scope matches its
// tags and whose platforms include its own.
const PROFILES = [
  { name: 'Acme Wi-Fi', description: 'Corporate Wi-Fi with an identity certificate', scope: 'withAny', tags: ['corporate'], payloadTypes: ['Wifi', 'Certificate'], platforms: ['ios', 'macos', 'windows', 'android', 'chrome'], identifier: 'com.acme-lab.wifi' },
  { name: 'Passcode policy', description: 'Six digit passcode, locks after five minutes', scope: 'withAny', tags: ['corporate', 'byod'], payloadTypes: ['Passcode'], platforms: ['ios', 'macos', 'windows', 'android'], identifier: 'com.acme-lab.passcode' },
  { name: 'Device restrictions', description: 'Restrictions for company iPhones and iPads', scope: 'withoutAny', tags: ['byod'], payloadTypes: ['Restrictions'], platforms: ['ios'], identifier: 'com.acme-lab.restrictions', restrictions: { allowCamera: true, allowScreenShot: false, allowAppInstallation: true, forceEncryptedBackup: true } },
  { name: 'Remote VPN', description: 'Always-on VPN for remote staff', scope: 'withAny', tags: ['remote'], payloadTypes: ['Vpn', 'ManagedSettings'], platforms: ['ios', 'macos', 'windows'], identifier: 'com.acme-lab.vpn' },
  { name: 'Front desk kiosk', description: 'Single app mode for the sign-in iPad', scope: 'withAll', tags: ['kiosk'], payloadTypes: ['AppLock', 'Restrictions'], platforms: ['ios'], identifier: 'com.acme-lab.kiosk', restrictions: { allowAppInstallation: false, allowSafari: false }, kioskApp: 'Acme Sign In' },
  { name: 'Content filter', description: 'Not deployed yet', scope: 'none', tags: [], payloadTypes: ['ContentFilter'], platforms: ['ios', 'macos'], identifier: 'com.acme-lab.contentfilter' },
];

export const SCOPES = ['all', 'none', 'withAny', 'withAll', 'withoutAny', 'withoutAll'];

// Whether tags fall in a scope of mode and scope tags.
export function inScope(mode, wanted, tags) {
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  const any = wanted.some((t) => tags.includes(t));
  const all = wanted.every((t) => tags.includes(t));
  return { withAny: any, withAll: all, withoutAny: !any, withoutAll: !all }[mode];
}

// Read-only view of a network's SM store: a GET never builds one.
export const smOf = (net) => net.sm ?? EMPTY;

// A 13 digit ID derived from a key, for records worked out on read.
export function idOf(key, salt) {
  return '1' + (String(derive(key, `${salt}:a`)).padStart(10, '0') + String(derive(key, `${salt}:b`)).padStart(10, '0')).slice(0, 12);
}

export const ownerOf = (net, dev) => smOf(net).users.find((u) => u.id === dev.ownerId) ?? null;
export const profilesFor = (net, dev) => smOf(net).profiles.filter((p) => p.platforms.includes(KINDS[dev.kind].platform) && inScope(p.scope, p.tags, dev.tags));

// One stretch online per local day: desktops on most weekdays through the
// work day, phones and tablets from morning to late evening, the kiosk
// through opening hours. In progress, it was last seen at the last check-in.
const CHECKIN = 15 * 60;
function sessionOn(dev, net, day, now) {
  const k = derive(dev.key, day);
  const kiosk = dev.tags.includes('kiosk');
  const desk = KINDS[dev.kind].desktop || dev.kind === 'Chromebook';
  if (desk && !kiosk && ((weekday(day) % 6 === 0) || unit(k, 0) < 0.1)) return null;
  const [from, to] = kiosk ? [6, 22] : desk ? [8, 17] : [7, 22.5];
  const mid = net.zone.midnight(day);
  const start = Math.max(dev.createdAt, Math.round(mid + (from + unit(k, 1) * 1.5) * HOUR));
  const end = Math.round(mid + (to + unit(k, 2) * 1.5) * HOUR);
  if (start >= now || end <= start) return null;
  const phase = dev.key % CHECKIN;
  return { start, end: end <= now ? end : Math.max(start, Math.floor((now - phase) / CHECKIN) * CHECKIN + phase) };
}

// Sessions overlapping [t0, now], oldest first.
export function sessions(dev, net, t0, now) {
  const out = [];
  for (let day = net.zone.day(Math.max(t0, dev.createdAt)) - 1; day <= net.zone.day(now); day++) {
    const s = sessionOn(dev, net, day, now);
    if (s && s.end >= t0) out.push(s);
  }
  return out;
}

// The last check-in: the end of the latest session, or a forced check-in.
export function lastConnected(dev, net, now) {
  const s = sessions(dev, net, now - 7 * DAY, now).at(-1);
  return Math.max(dev.createdAt, dev.checkedInAt ?? 0, s?.end ?? 0);
}

// Hourly samples while a desktop is online.
export function performanceRows(dev, net, now) {
  const kind = KINDS[dev.kind];
  if (!kind.desktop) return [];
  const rows = [];
  for (const s of sessions(dev, net, now - LOOKBACK, now)) {
    for (let t = Math.ceil(Math.max(s.start, now - LOOKBACK) / HOUR) * HOUR; t <= s.end; t += HOUR) {
      const k = derive(dev.key, `perf:${t / HOUR}`);
      const wired = 2400 + Math.round(unit(k, 1) * 1200);
      const active = 4000 + Math.round(unit(k, 2) * 4000);
      const inactive = 1500 + Math.round(unit(k, 3) * 1500);
      rows.push({
        cpuPercentUsed: Math.round((0.05 + unit(k, 0) * 0.6) * 100) / 100,
        memFree: kind.ram - wired - active - inactive,
        memWired: wired,
        memActive: active,
        memInactive: inactive,
        networkSent: Math.round(2000 + unit(k, 4) * 60000),
        networkReceived: Math.round(8000 + unit(k, 5) * 240000),
        swapUsed: Math.round(unit(k, 6) * 2048),
        diskUsage: { c: { used: (dev.capacity - dev.available) * 1024, space: dev.capacity * 1024 } },
        ts: iso(t),
      });
    }
  }
  return rows;
}

// A desktop logs its connection when it comes online and every four hours.
export function desktopLogRows(dev, net, now, user) {
  if (!KINDS[dev.kind].desktop) return [];
  const rows = [];
  const prefix = dev.ip.split('.').slice(0, 3).join('.');
  for (const s of sessions(dev, net, now - LOOKBACK, now)) {
    for (let t = s.start; t <= s.end; t += 4 * HOUR) {
      if (t < now - LOOKBACK) continue;
      const k = derive(dev.key, `log:${t}`);
      rows.push({
        measuredAt: iso(t),
        user,
        networkDevice: KINDS[dev.kind].adapter,
        networkDriver: KINDS[dev.kind].driver,
        wifiChannel: String([36, 44, 149, 157][Math.floor(unit(k, 0) * 4)]),
        wifiAuth: dev.wifiAuth,
        wifiBssid: dev.bssids[Math.floor(unit(k, 1) * dev.bssids.length)],
        wifiSsid: dev.ssid,
        wifiRssi: String(-45 - Math.floor(unit(k, 2) * 25)),
        wifiNoise: String(-90 - Math.floor(unit(k, 3) * 8)),
        dhcpServer: `${prefix}.1`,
        ip: dev.ip,
        networkMTU: '1500',
        subnet: `${prefix}.0/24`,
        gateway: `${prefix}.1`,
        publicIP: dev.publicIp,
        dnsServer: `${prefix}.1`,
        ts: iso(t),
      });
    }
  }
  return rows;
}

// Daily cellular use in kilobytes per UTC day since the lookback began; the
// current day counts up to now.
export function cellularRows(dev, now) {
  if (!dev.cellular) return [];
  const rows = [];
  for (let day = Math.floor(Math.max(now - LOOKBACK, dev.createdAt) / DAY); day * DAY < now; day++) {
    const k = derive(dev.key, `cell:${day}`);
    const share = Math.min(1, (now - day * DAY) / DAY);
    const received = Math.round((20000 + unit(k, 0) * 180000) * share);
    rows.push({ received, sent: Math.round(received * (0.08 + unit(k, 1) * 0.12)), ts: iso(day * DAY) });
  }
  return rows;
}

// Lab networks with an sm entry start with enrolled devices and owners.
export function seedSm(world, net, tpl) {
  if (!tpl.sm) return;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:lab:${tpl.code}:sm`));
  const used = new Set();
  const once = (make) => {
    for (;;) {
      const v = make();
      if (!used.has(v)) return used.add(v), v;
    }
  };
  const id = () => once(() => r.digits(13));
  const wifi = world.orgs[1].networks.filter((n) => n.aps.length && n.ssids.length);
  const home = wifi[0];
  const sm = (net.sm = { devices: [], users: [], profiles: [] });
  for (const p of PROFILES) sm.profiles.push({ id: id(), ...p, tags: [...p.tags], platforms: [...p.platforms], version: `${r.int(1, 6)}` });
  for (const tags of tpl.sm.owners) {
    let first, last;
    do (first = r.pick(FIRST_NAMES)), (last = r.pick(LAST_NAMES));
    while (sm.users.some((u) => u.fullName.startsWith(`${first} `) || u.fullName.endsWith(` ${last}`)));
    const username = `${first[0]}${last}`.toLowerCase();
    sm.users.push({ id: id(), email: `${first}.${last}@${DOMAIN}`.toLowerCase(), fullName: `${first} ${last}`, username, hasPassword: r.chance(0.3), tags: [...tags], isExternal: false, hasIdentityCertificate: false });
  }
  const enrolled = world.bootDay - r.int(300, 400) * DAY;
  tpl.sm.devices.forEach((d, i) => {
    const kind = KINDS[d.kind];
    const owner = d.owner == null ? null : sm.users[d.owner];
    const corp = !d.tags.includes('byod');
    const ssid = corp ? home.ssids.find((s) => s.auth === '8021x') ?? home.ssids[0] : home.ssids.find((s) => s.auth === 'wpa') ?? home.ssids[0];
    const createdAt = enrolled + r.int(0, 150) * DAY + r.int(13, 21) * HOUR + r.int(0, 3599);
    const model = r.pick(kind.models);
    const serialNumber = once(() => (kind.platform === 'ios' || kind.platform === 'macos' ? r.chars(10, SERIAL_CHARS) : kind.platform === 'windows' ? `PF${r.chars(6, SERIAL_CHARS)}` : r.chars(11, SERIAL_CHARS)));
    const cellular = !!(kind.phone || d.cellular);
    const imei = cellular ? once(() => `35${r.chars(13, '0123456789')}`) : null;
    const dev = {
      id: id(),
      kind: d.kind,
      name: d.name ?? `${owner.fullName.split(' ')[0]}'s ${kind.label}`,
      tags: [...d.tags],
      notes: '',
      ownerId: owner?.id ?? null,
      ssid: ssid.name,
      wifiAuth: ssid.auth === '8021x' ? 'wpa2-enterprise' : 'wpa2-psk',
      // Saved as the device saw them, so a later SSID rename doesn't rewrite its past.
      savedSsids: [...new Set(wifi.flatMap((n) => n.ssids.map((s) => s.name)))],
      bssids: home.aps.map((ap) => bssid(ap, '5', ssid.number)),
      wifiMac: once(() => (kind.platform === 'windows' || kind.desktop ? `${r.pick(['3c:22:fb', 'f8:4d:89', 'a4:83:e7'])}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}` : `${((r.int(0, 255) & 0xfc) | 0x02).toString(16).padStart(2, '0')}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`)),
      osName: kind.osName,
      osBuild: kind.osBuild,
      systemModel: model,
      uuid: once(() => (kind.platform === 'ios' ? `00008${r.hex(3)}-00${r.hex(14)}`.toUpperCase() : `${r.hex(8)}-${r.hex(4)}-${r.hex(4)}-${r.hex(4)}-${r.hex(12)}`.toUpperCase())),
      serialNumber,
      ip: `${home.subnet(ssid.vlan)}.${200 + i}`,
      publicIp: `192.0.2.${40 + r.int(0, 3)}`,
      capacity: kind.capacity,
      available: Math.round(kind.capacity * (0.2 + r.next() * 0.5)),
      supervised: corp && kind.platform === 'ios',
      cellular,
      phoneNumber: cellular ? `+1 416 555 0${r.int(100, 199)}` : null,
      imei,
      meid: imei && kind.platform === 'ios' ? imei.slice(0, 14) : null,
      iccid: cellular ? once(() => `89302${r.chars(14, '0123456789')}`) : null,
      carrier: cellular ? r.pick(CARRIERS) : null,
      biosVersion: kind.bios ? kind.bios[kind.models.indexOf(model)] : null,
      createdAt,
      key: 0,
      checkedInAt: null,
      softwares: [],
      commandLogs: [],
    };
    dev.key = hashStr(`sm:${dev.id}`);
    let t = createdAt;
    const log = (action, name, details) => dev.commandLogs.push({ action, name, details: JSON.stringify(details), dashboardUser: null, ts: (t += r.int(2, 40)) });
    log('DeviceInformation', dev.name, {});
    for (const p of profilesFor(net, dev)) log('InstallProfile', p.name, { profileId: p.id, identifier: p.identifier });
    const apps = APPS[kind.platform];
    for (const [j, [name, identifier, vendor, version, managed]] of apps.entries()) {
      // One Mac still waits for its last managed app.
      const pending = !!d.pending && j === apps.length - 2;
      const installedAt = pending ? null : managed ? (t += r.int(5, 90)) : createdAt + r.int(2, 60) * DAY;
      if (managed) log('InstallApplication', name, { identifier });
      dev.softwares.push({
        appId: managed ? idOf(hashStr(identifier), 'app') : null,
        bundleSize: r.int(20, 900) * 1024 * 1024,
        createdAt: installedAt ?? t,
        dynamicSize: r.int(1, 400) * 1024 * 1024,
        id: id(),
        identifier,
        installedAt,
        toInstall: pending,
        iosRedemptionCode: false,
        isManaged: managed,
        itunesId: kind.platform === 'ios' ? String(r.int(300000000, 1600000000)) : null,
        licenseKey: null,
        name,
        path: kind.platform === 'macos' ? `/Applications/${name}.app` : kind.platform === 'windows' ? `C:\\Program Files\\${name}` : null,
        redemptionCode: null,
        shortVersion: version.split('.').slice(0, 2).join('.'),
        status: pending ? 'Pending' : managed ? 'Managed' : 'Unmanaged',
        toUninstall: false,
        uninstalledAt: null,
        updatedAt: (installedAt ?? t) + r.int(1, 20) * DAY,
        vendor,
        version,
      });
    }
    log('InstalledApplicationList', dev.name, {});
    log('CertificateList', dev.name, {});
    sm.devices.push(dev);
  });
  sm.devices.sort((a, b) => (a.id < b.id ? -1 : 1));
}
