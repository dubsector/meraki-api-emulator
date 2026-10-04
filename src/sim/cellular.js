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
// The data management views call the eSIM's slot 'esim'.
export const logicalSlot = (dev, slot) => (slot === dev.info.esim ? 'esim' : slot);

// Providers eSIM profiles can come from. The bootstrap provider only brings
// a new eSIM online, so it takes no accounts.
export const ESIM_PROVIDERS = [
  { provider: 'AT&T', mcc: '310', mnc: '410', apn: 'broadband', dns: ['68.94.156.1', '68.94.157.1'] },
  { provider: 'Verizon', mcc: '311', mnc: '480', apn: 'vzwinternet', dns: ['198.224.166.135', '198.224.167.135'] },
  { provider: 'T-Mobile', mcc: '310', mnc: '260', apn: 'fast.t-mobile.com', dns: ['10.177.0.34', '10.177.0.210'] },
  ...CARRIERS,
  { provider: 'Cisco IoT Bootstrap', bootstrap: true },
];
export const providerOf = (name) => ESIM_PROVIDERS.find((p) => p.provider === name);

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');
export const communicationPlans = (p) => [
  { name: `${p.provider} IoT Pooled Data`, apns: [{ name: p.apn }] },
  { name: `${p.provider} IoT Private APN`, apns: [{ name: `meraki.${slug(p.provider)}.iot` }] },
];
export const ratePlans = (p) => ['1 GB Shared', '10 GB Shared', 'Unlimited'].map((x) => ({ name: `${p.provider} IoT ${x}` }));

function simNumbers(carrier, r) {
  return { carrier, iccid: `89${carrier.mcc}${carrier.mnc}${r.digits(11)}`, imsi: `${carrier.mcc}${carrier.mnc}${r.digits(9)}`, msisdn: `1613${r.digits(7)}` };
}

// A profile on the eSIM with the provider's numbers and the plans it runs.
export function esimProfile(dev, n, carrier, comm, rate, accountId = null) {
  const r = new Rand(derive(dev.key, n ? `esim:${n}` : `sim:${dev.info.esim}`));
  return { ...simNumbers(carrier, r), accountId, plans: [{ name: comm.name, type: 'communication' }, { name: rate.name, type: 'rate' }], apns: comm.apns.map((a) => a.name) };
}

// The eSIM as shipped: one profile from the carrier its slot would hold,
// with the same numbers a physical SIM there would have.
function shippedEsim(dev) {
  const carrier = CARRIERS[(dev.key + slotsOf(dev).indexOf(dev.info.esim)) % CARRIERS.length];
  const profile = esimProfile(dev, 0, carrier, communicationPlans(carrier)[0], ratePlans(carrier)[0]);
  return { status: 'activated', profiles: [profile], current: profile.iccid, updatedAt: dev.claimedAt ?? 0, ids: 0, swap: null };
}

// The eSIM at t, with a profile swap that has finished by then applied.
// Writes store what this returns, so a read never changes the device.
export function esimOf(dev, t) {
  const e = dev.esim ?? shippedEsim(dev);
  const s = e.swap;
  if (!s || s.applied || t < s.end) return e;
  const profiles = e.profiles.filter((p) => p.iccid !== s.profile.iccid);
  return { ...e, profiles: [...profiles, s.profile], current: s.profile.iccid, updatedAt: s.end, swap: { ...s, applied: true } };
}

export const esimProfileNow = (e) => e.profiles.find((p) => p.iccid === e.current);
// The EID belongs to the chip, so a replacement MG has its own.
export const eidOf = (dev) => `89049032${new Rand(derive(dev.key, `eid:${dev.serial}`)).digits(24)}`;

// The SIM in a slot: every physical slot holds one, each on its own carrier.
// The eSIM's numbers and carrier come from its current profile.
export function simOf(dev, slot, t) {
  if (slot === dev.info.esim) {
    const p = esimProfileNow(esimOf(dev, t));
    return { slot, carrier: p.carrier, iccid: p.iccid, imsi: p.imsi, msisdn: p.msisdn };
  }
  const i = slotsOf(dev).indexOf(slot);
  const carrier = CARRIERS[(dev.key + i) % CARRIERS.length];
  return { slot, ...simNumbers(carrier, new Rand(derive(dev.key, `sim:${slot}`))) };
}

// Whether a slot holds a SIM that can carry data: a deactivated eSIM can't.
export const simUsable = (dev, slot, t) => slot !== dev.info.esim || esimOf(dev, t).status === 'activated';

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
  const sim = simOf(dev, slot, t);
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
