// Cellular gateways: the SIMs in each slot, their carrier, signal, towers and
// data use. Everything comes from the device key, so the org cellular views,
// the uplink statuses and the device's own routes agree.

import { Rand, derive, gauss, lognoise, unit } from '../rng.js';
import { DAY } from '../time.js';
import { perDay } from './cache.js';
import { eachOutage, isDown } from './outages.js';

export const SLOT = 300;
const PER_DAY = DAY / SLOT;
// Signal, tower and location telemetry refreshes every 90 minutes.
export const REFRESH = 5400;

export const CARRIERS = [
  { provider: 'Rogers', mcc: '302', mnc: '720', apn: 'ltemobile.apn', dns: ['64.71.255.198', '64.71.255.204'] },
  { provider: 'Bell', mcc: '302', mnc: '610', apn: 'pda.bell.ca', dns: ['184.151.118.254', '207.164.234.193'] },
  { provider: 'Telus', mcc: '302', mnc: '220', apn: 'sp.telus.com', dns: ['209.29.158.106', '209.29.158.107'] },
];

export const BANDS = {
  LTE: ['2', '4', '5', '7', '12', '13', '14', '17', '25', '26', '29', '30', '41', '48', '66', '71'],
  '5GNSA': ['n2', 'n5', 'n7', 'n12', 'n25', 'n41', 'n48', 'n66', 'n71', 'n77', 'n78'],
  '5GSA': ['n2', 'n5', 'n7', 'n12', 'n25', 'n41', 'n48', 'n66', 'n71', 'n77', 'n78'],
};

export const isGateway = (d) => d.productType === 'cellularGateway';
export const slotsOf = (dev) => dev.info.sims ?? [];

// The SIM in a slot: every physical slot holds one, each on its own carrier.
export function simOf(dev, slot) {
  const i = slotsOf(dev).indexOf(slot);
  const carrier = CARRIERS[(dev.key + i) % CARRIERS.length];
  const r = new Rand(derive(dev.key, `sim:${slot}`));
  return { slot, carrier, iccid: `89302${carrier.mnc}${r.digits(11)}`, imsi: `${carrier.mcc}${carrier.mnc}${r.digits(9)}`, msisdn: `1613${r.digits(7)}` };
}

// SIM settings: the slot order (primary first), APNs per slot and failover.
// Stored settings for slots the model doesn't have are skipped.
export function simSettings(dev) {
  const slots = slotsOf(dev);
  const s = dev.cellularSims;
  const order = s?.order?.filter((x) => slots.includes(x)) ?? [];
  return {
    order: [...order, ...slots.filter((x) => !order.includes(x))],
    apns: s?.apns ?? {},
    // Failover needs a second SIM, which a swap to a single-SIM model takes away.
    failover: { ...(s?.failover ?? { enabled: true, timeout: 300 }), ...(slots.length < 2 && { enabled: false }) },
  };
}

export const primarySlot = (dev) => simSettings(dev).order[0];

// The 5G modem rides 5G non-standalone, the LTE one LTE.
export const signalType = (dev) => (dev.info.signalTypes.includes('5GNSA') ? '5GNSA' : 'LTE');

// Reference signal power and quality, steady per device with some noise per
// refresh. Stronger on the 5G modem's better antennas.
export function signalAt(dev, t) {
  const k = derive(dev.key, Math.floor(t / REFRESH));
  const base = -82 - unit(dev.key, 3) * 22;
  return { rsrp: String(Math.round(base + gauss(k, 0) * 3)), rsrq: String(Math.round(-8 - unit(dev.key, 4) * 4 + gauss(k, 1))) };
}

export function towerOf(dev) {
  const k = derive(dev.key, `tower:${primarySlot(dev)}`);
  return { cell: { id: String(10000000 + (k % 200000000)) }, tac: `0x${((k >>> 8) % 0x10000).toString(16).toUpperCase().padStart(4, '0')}` };
}

// Carrier-grade NAT address on the cellular side and the public one behind it.
export function addressing(dev) {
  const k = derive(dev.key, `wan:${primarySlot(dev)}`);
  const net = `100.${64 + (k % 64)}.${(k >>> 6) % 256}`;
  return { ip: `${net}.${2 + ((k >>> 14) % 250)}`, gateway: `${net}.1`, publicIp: `192.0.2.${100 + ((k >>> 22) % 150)}` };
}

// The cellular uplink on the primary SIM at t: carrier, addressing and APN.
// No addresses while the device is down.
export function uplinkState(dev, t) {
  const slot = primarySlot(dev);
  const sim = simOf(dev, slot);
  const down = isDown(dev, t);
  const addr = down ? { ip: null, gateway: null, publicIp: null } : addressing(dev);
  return { slot, sim, carrier: sim.carrier, down, ...addr, apn: simSettings(dev).apns[slot]?.[0]?.name ?? sim.carrier.apn };
}

// Location telemetry near where the device was placed, refreshed every 90 minutes.
export function locationAt(dev, t) {
  const k = derive(dev.key, Math.floor(t / REFRESH));
  return { latitude: Math.round((dev.lat + gauss(k, 0) * 0.0002) * 1e6) / 1e6, longitude: Math.round((dev.lng + gauss(k, 1) * 0.0002) * 1e6) / 1e6 };
}

// Bytes moved per five minute slot over one UTC day: a business-hours curve
// in local time, nothing while the device is down or before it was claimed.
export function usageDay(dev, day) {
  return perDay(dev, 'cellularUsageCache', day, () => {
    const out = new Float64Array(PER_DAY);
    const start = day * DAY;
    const rate = (dev.info.signalTypes.includes('5GNSA') ? 2.4e6 : 7e5) * (0.6 + unit(dev.key, 5) * 0.8);
    const k = derive(dev.key, day);
    for (let i = 0; i < PER_DAY; i++) {
      const t = start + i * SLOT;
      if (t < (dev.claimedAt ?? 0)) continue;
      const h = dev.net.zone.hourOf(t);
      out[i] = Math.round(rate * (0.25 + 0.75 * Math.exp(-((h - 13) ** 2) / 18)) * lognoise(k, i, 0.4));
    }
    eachOutage(dev, start, start + DAY, (s, e) => {
      for (let i = Math.max(0, Math.floor((s - start) / SLOT)); i < PER_DAY && start + i * SLOT < e; i++) out[i] = 0;
    });
    return out;
  });
}

// Bytes in the whole slots of [a, b) that ended by now.
export function usageBetween(dev, a, b, now) {
  const end = Math.min(b, Math.floor(now / SLOT) * SLOT);
  let total = 0;
  for (let t = Math.ceil(a / SLOT) * SLOT; t < end; ) {
    const day = Math.floor(t / DAY);
    const slots = usageDay(dev, day);
    const stop = Math.min(end, (day + 1) * DAY);
    for (; t < stop; t += SLOT) total += slots[(t - day * DAY) / SLOT];
  }
  return total;
}
