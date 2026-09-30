// AP radios: channels, power, channel utilization and client signal quality.

import { derive, gauss, lognoise, unit } from '../rng.js';
import { presenceIn } from './presence.js';

export const RADIO = { 2.4: '0', 5: '1', 6: '2' };
const CHANNELS = { 2.4: [1, 6, 11], 5: [36, 44, 52, 100, 149, 157], 6: [37, 69, 101] };
export const WIDTH = { 2.4: 20, 5: 40, 6: 80 };
const NOISE_FLOOR = { 2.4: -92, 5: -95, 6: -96 };
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const SETTINGS = { 2.4: 'twoFourGhzSettings', 5: 'fiveGhzSettings' };

// A channel set through the API wins over the one auto channel picked.
export function apChannel(ap, band) {
  const set = ap.radio?.[SETTINGS[band]]?.channel;
  if (set != null) return set;
  const chans = CHANNELS[band];
  return chans[ap.key % chans.length];
}

// Target transmit power in dBm.
export function apPower(ap, band) {
  return ap.radio?.[SETTINGS[band]]?.targetPower ?? { 2.4: 11, 5: 14, 6: 16 }[band] + (derive(ap.key, `power${band}`) % 6);
}

// Share of airtime in use on one radio over [t0, t1). Wi-Fi grows with the
// clients on it; non-Wi-Fi is background noise, worst on 2.4 GHz.
export function channelUtilization(ap, band, t0, t1) {
  let seconds = 0;
  for (const c of ap.net.clients) if (c.ap === ap && !c.wired && c.band === band) seconds += presenceIn(c, t0, t1)?.seconds ?? 0;
  const clients = seconds / (t1 - t0);
  const k = derive(ap.key, `util${band}`);
  const hour = Math.floor((t0 + t1) / 2 / 3600);
  const base = { 2.4: 9, 5: 3, 6: 1 }[band];
  const perClient = { 2.4: 2.4, 5: 1.1, 6: 0.8 }[band];
  const wifi = Math.min(90, (base + clients * perClient) * lognoise(k, hour, 0.15) * (ap.flaky ? 1.5 : 1));
  const nonWifi = { 2.4: 3.5, 5: 0.9, 6: 0.3 }[band] * lognoise(derive(k, 'noise'), hour, 0.3);
  return { wifi: round(wifi), nonWifi: round(nonWifi), total: round(Math.min(100, wifi + nonWifi)) };
}

// Each client sits somewhere in the room; RSSI wobbles a little every five minutes.
export function clientSignal(c, t) {
  const k = derive(c.key, 'rssi');
  const rssi = -47 - unit(k, 0) * 24 - (c.band === '2.4' ? 0 : 4) - (c.ap.flaky ? 6 : 0) + gauss(k, Math.floor(t / 300)) * 2;
  return { rssi, snr: rssi - NOISE_FLOOR[c.band] };
}

// A BSSID per SSID and band, derived from the AP's MAC like Meraki does.
export function bssid(ap, band, ssidNumber) {
  const b = ap.mac.split(':').map((h) => parseInt(h, 16));
  b[0] |= 0x02;
  b[5] = (b[5] + Number(RADIO[band]) * 16 + ssidNumber) & 0xff;
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
}
