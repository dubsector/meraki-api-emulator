// Foreign SSIDs the APs hear: a few per wireless network, each with its own
// BSSIDs, channels and sighting rhythm, so Air Marshal has something to show.

import { Rand, derive } from '../rng.js';
import { DAY } from '../time.js';

const VENDORS = [
  ['Cisco-Linksys, LLC', '00:14:bf', ['linksys', 'Linksys00412']],
  ['NETGEAR', 'a0:40:a0', ['NETGEAR42', 'NETGEAR-5G-Guest']],
  ['TP-LINK TECHNOLOGIES CO.,LTD.', 'f4:f2:6d', ['TP-Link_8C2A', 'TP-Link_Extender']],
  ['Apple, Inc.', 'f0:18:98', ["Jordan's iPhone", 'iPhone (2)']],
  ['Samsung Electronics Co.,Ltd', '8c:f5:a3', ['Galaxy S24 7D1E', 'DIRECT-Samsung TV']],
  ['Hewlett Packard', '3c:52:82', ['DIRECT-7F-HP OfficeJet Pro', 'HP-Print-3B-LaserJet']],
  ['Ubiquiti Inc', '24:5a:4c', ['NeighborCo-WiFi', 'Suite200-Guest']],
  ['ARRIS Group, Inc.', '00:1d:d5', ['xfinitywifi', 'HOME-2F4D']],
];
const CH24 = [1, 6, 11];
const CH5 = [36, 44, 52, 100, 149, 157];
// Neighbors appeared at fixed points in the past, so firstSeen never moves.
const ANCHOR = Date.UTC(2025, 0, 1) / 1000;

function mac(r, oui) {
  const tail = Array.from({ length: 3 }, () => r.int(0, 255).toString(16).padStart(2, '0'));
  return `${oui}:${tail.join(':')}`;
}

function neighbor(r, net, ssid, vendor) {
  const [manufacturer, oui] = vendor;
  const bssids = Array.from({ length: r.int(1, 2) }, (_, i) => {
    const heard = Array.from({ length: r.int(1, 3) }, () => r.int(0, 999));
    return { bssid: mac(r, oui), channel: i === 0 || r.next() < 0.5 ? r.pick(CH24) : r.pick(CH5), heard: heard.map((a) => ({ ap: a, rssi: r.int(5, 40) })) };
  });
  const e = r.next();
  return {
    ssid,
    manufacturer,
    encryption: e < 0.75 ? 'WPA' : e < 0.95 ? 'open' : 'WEP',
    bssids,
    firstSeen: Math.floor(ANCHOR - r.next() * 300 * DAY),
    // Phones and printers come and go; the rest are heard every few minutes.
    period: r.next() < 0.3 ? r.int(2, 5) * DAY : r.int(5, 15) * 60,
    phase: r.next(),
    wired: null,
  };
}

// Built from the network's key, so reads stay stable; `heard` holds AP slots
// that readers map onto the network's current APs. A site with a flaky AP
// also has a rogue plugged into its LAN, and big sites hear someone copying
// their guest SSID.
export function neighborsOf(net) {
  if (!net.aps.length) return [];
  const r = new Rand(derive(net.key, 'airMarshal'));
  const list = [];
  const used = new Set();
  for (let i = r.int(3, 6); i > 0; i--) {
    const vendor = r.pick(VENDORS);
    const ssid = r.pick(vendor[2]);
    if (used.has(ssid)) continue;
    used.add(ssid);
    list.push(neighbor(r, net, ssid, vendor));
  }
  const flaky = net.aps.findIndex((a) => a.flaky);
  if (flaky >= 0) {
    const rogue = neighbor(r, net, 'NETGEAR-Dock4', VENDORS[1]);
    rogue.period = 300;
    rogue.bssids = [{ ...rogue.bssids[0], heard: [{ ap: flaky, rssi: 38 }] }];
    rogue.wired = { macs: [rogue.bssids[0].bssid.replace(/..$/, (h) => ((parseInt(h, 16) + 1) & 0xff).toString(16).padStart(2, '0'))], vlans: [1, net.ssids[0]?.vlan ?? 1].filter((v, i, a) => a.indexOf(v) === i) };
    list.push(rogue);
  }
  const guest = net.ssids.find((s) => s.key === 'guest');
  if (net.aps.length >= 6 && guest) {
    const spoof = neighbor(r, net, guest.name, VENDORS[2]);
    spoof.period = 600;
    list.push(spoof);
  }
  return list;
}

// The last sighting at or before t, or null before the first one.
export function lastSighting(n, t) {
  const offset = n.firstSeen + Math.floor(n.phase * n.period);
  if (t < n.firstSeen) return null;
  if (t < offset) return n.firstSeen;
  return offset + Math.floor((t - offset) / n.period) * n.period;
}
