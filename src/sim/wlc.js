// Catalyst 9800 wireless LAN controllers. A network's controllers can form an
// SSO pair (net.wirelessControllers), which holds its units as device objects,
// its failovers and the Catalyst APs joined to it. The APs are records on the
// pair, not org devices. The active unit carries the APs, clients and traffic;
// the standby only syncs state over the redundancy port.

import { MODELS } from '../catalog.js';
import { Rand, derive, gauss, hashStr, lognoise, unit } from '../rng.js';
import { DAY, HOUR, weekday } from '../time.js';
import { perDay } from './cache.js';
import { eachOutage, isDown } from './outages.js';
import { workCurve } from './usage.js';

export const SLOT = 300;
const PER_DAY = DAY / SLOT;
const RELOAD = 420;

export const isController = (d) => d.productType === 'wirelessController';

// The pair a controller belongs to, if it is still one of its units.
export function pairOf(dev) {
  const s = dev.net?.wirelessControllers;
  return s && s.members.includes(dev) && dev.net.devices.includes(dev) ? s : null;
}

// Units still in the pair's network; both must be there for SSO.
export const liveMembers = (net, s) => s.members.filter((m) => net.devices.includes(m));
export const isHa = (net, s) => liveMembers(net, s).length === 2;
export const chassisName = (s, dev) => `Chassis ${s.members.indexOf(dev) + 1}`;

// Failovers up to t, while both units are in the pair.
export const failoversTo = (net, s, t) => (isHa(net, s) ? s.failovers.filter((f) => f.ts <= t) : []);

// The unit active at t: chassis 1 at first, then the other one after each failover.
export function activeAt(net, s, t) {
  const live = liveMembers(net, s);
  if (live.length < 2) return live[0] ?? null;
  return s.members[failoversTo(net, s, t).length % 2];
}

// Role names as the overview lists them.
export function roleAt(dev, t) {
  if (isDown(dev, t)) return 'Offline';
  const s = pairOf(dev);
  if (!s || activeAt(dev.net, s, t) === dev) return 'Active';
  return 'Standby hot';
}

// The other unit of an SSO pair still holding both.
export function peerOf(dev) {
  const s = pairOf(dev);
  return s && isHa(dev.net, s) ? s.members.find((m) => m !== dev) : null;
}

// The Catalyst APs and the unit they are joined to at t (none without a unit).
export function catalystAps(net, t) {
  const s = net.wirelessControllers;
  const ctl = s ? activeAt(net, s, t) : null;
  return ctl ? s.aps.map((ap) => ({ ap, ctl })) : [];
}

// Clients on the pair's APs for each five-minute slot of a UTC day: a working
// day curve at the site, quieter at weekends.
function clientsDay(net, s, day) {
  return perDay(s, 'clientsCache', day, () => {
    const k = derive(s.key, 'clients');
    const peak = s.aps.length * 9;
    const out = new Int32Array(PER_DAY);
    for (let i = 0; i < PER_DAY; i++) {
      const t = day * DAY + i * SLOT;
      const weekend = [0, 6].includes(weekday(net.zone.day(t))) ? 0.35 : 1;
      out[i] = Math.round((peak * workCurve(net.zone.hourOf(t)) * weekend * lognoise(k, t / SLOT, 0.12)) / 1.3);
    }
    return out;
  });
}

// Clients a controller served in the slot holding t: the active unit's, while up.
export function clientsAt(dev, t) {
  const s = pairOf(dev);
  if (!s || isDown(dev, t) || activeAt(dev.net, s, t) !== dev) return 0;
  const slot = Math.floor(t / SLOT);
  const day = Math.floor(slot / PER_DAY);
  return clientsDay(dev.net, s, day)[slot - day * PER_DAY];
}

// Layer 2 interfaces of a C9800-40: two uplinks in Port-channel1, two unused
// ports, the service port (nothing plugged in) and the SSO redundancy port.
export const L2 = [
  { name: 'TenGigabitEthernet0/0/0', description: 'Uplink', enabled: true, speed: '10 Gbps', isUplink: true, vlan: 1, channel: 1 },
  { name: 'TenGigabitEthernet0/0/1', description: 'Uplink', enabled: true, speed: '10 Gbps', isUplink: true, vlan: 1, channel: 1 },
  { name: 'TenGigabitEthernet0/0/2', description: '', enabled: false, speed: '10 Gbps', isUplink: false, vlan: 1, channel: null },
  { name: 'TenGigabitEthernet0/0/3', description: '', enabled: false, speed: '10 Gbps', isUplink: false, vlan: 1, channel: null },
  { name: 'GigabitEthernet0', description: 'Service port', enabled: true, speed: '1 Gbps', isUplink: false, vlan: null, channel: null, unplugged: true },
  { name: 'RedundancyPort', description: 'SSO redundancy port', enabled: true, speed: '1 Gbps', isUplink: false, vlan: null, channel: null, redundancy: true },
];
// Layer 3: the wireless management SVI over the uplinks, and the service port's VRF.
export const L3 = [
  { name: 'Vlan1', description: 'Wireless Mgmt', speed: '20 Gbps', isUplink: true, vlan: 1, vrf: 'Global' },
  { name: 'GigabitEthernet0', description: 'Service port', speed: '1 Gbps', isUplink: false, vlan: null, vrf: 'Mgmt-intf', unplugged: true },
];
export const MODULE = 'BUILT-IN-4X10G/1G';

// An interface's MAC, counting up from the controller's.
export function ifaceMac(dev, i) {
  const n = (parseInt(dev.mac.replaceAll(':', '').slice(6), 16) + i + 1) % 0x1000000;
  return `${dev.mac.slice(0, 8)}:${[16, 8, 0].map((b) => ((n >> b) & 0xff).toString(16).padStart(2, '0')).join(':')}`;
}

// Interface status at t: disabled, or connected while the controller (and,
// for the redundancy port, its peer) is up.
export function ifaceStatus(dev, x, t) {
  if (x.enabled === false) return 'disabled';
  if (x.unplugged || isDown(dev, t)) return 'disconnected';
  if (x.redundancy) {
    const peer = peerOf(dev);
    return peer && !isDown(peer, t) ? 'connected' : 'disconnected';
  }
  return 'connected';
}

// Status changes of an interface in [a, b): [{ ts, status }], oldest first.
export function ifaceChanges(dev, x, a, b) {
  if (x.enabled === false || x.unplugged) return [];
  const peer = x.redundancy ? peerOf(dev) : null;
  if (x.redundancy && !peer) return [];
  const times = new Set();
  for (const d of [dev, peer].filter(Boolean)) eachOutage(d, a, b, (s, e) => [s, e].forEach((v) => v >= a && v < b && times.add(v)));
  const out = [];
  let prev = null;
  for (const ts of [...times].sort((p, q) => p - q)) {
    const before = prev ?? ifaceStatus(dev, x, ts - 1);
    const now = ifaceStatus(dev, x, ts);
    if (now !== before) out.push({ ts, status: now });
    prev = now;
  }
  return out;
}

// Bytes [recv, send] on each layer 2 interface in the slot starting at t. The
// uplinks carry the clients' tunneled traffic both ways plus management; the
// redundancy port carries state sync to the standby.
// A slot's role is the one at its start; bytes scale with the seconds it was up.
function slotBytes(dev, t) {
  const out = L2.map(() => [0, 0]);
  let down = 0;
  eachOutage(dev, t, t + SLOT, (s, e) => (down += Math.min(e, t + SLOT) - Math.max(s, t)));
  const up = Math.max(0, 1 - down / SLOT);
  if (!up) return out;
  const slot = t / SLOT;
  const k = derive(dev.key, 'wlcUsage');
  const clients = clientsAt(dev, t);
  const mgmt = 1500 * SLOT * lognoise(k, slot, 0.2);
  const data = clients * 24000 * SLOT * lognoise(derive(k, 1), slot, 0.35);
  const share = Math.min(0.7, Math.max(0.3, 0.5 + gauss(derive(k, 2), slot) * 0.06));
  const recv = (data + mgmt * 0.45) * up;
  const send = (data * 1.04 + mgmt * 0.55) * up;
  out[0] = [recv * share, send * share];
  out[1] = [recv * (1 - share), send * (1 - share)];
  const peer = peerOf(dev);
  if (peer && !isDown(peer, t)) {
    // The active unit sends the state; the standby acknowledges it.
    const active = activeAt(dev.net, pairOf(dev), t);
    const sync = (400 + clientsAt(active, t) * 30) * SLOT * up * lognoise(derive(k, 3), slot, 0.1);
    out[5] = active === dev ? [sync * 0.12, sync] : [sync, sync * 0.12];
  }
  return out;
}

// Bytes [recv, send] per layer 2 interface over [a, b), with partial slots
// counted by their overlap.
export function usageBetween(dev, a, b) {
  const out = L2.map(() => [0, 0]);
  for (let t = Math.floor(a / SLOT) * SLOT; t < b; t += SLOT) {
    const f = (Math.min(b, t + SLOT) - Math.max(a, t)) / SLOT;
    slotBytes(dev, t).forEach(([r, s], i) => {
      out[i][0] += r * f;
      out[i][1] += s * f;
    });
  }
  return out;
}

// The management SVI carries what the uplinks do.
export const l3Usage = (l2) => [[l2[0][0] + l2[1][0], l2[0][1] + l2[1][1]], [0, 0]];

export const coresOf = (dev) => dev.info.cores ?? MODELS['C9800-40'].cores;

// Per-core CPU percentages for the slots of a UTC day before load: a steady
// share per core plus noise. Clients add load on the active unit at read.
function cpuDay(dev, day) {
  return perDay(dev, 'wlcCpuCache', day, () => {
    const cores = coresOf(dev);
    const k = derive(dev.key, 'wlcCpu');
    const out = new Float64Array(PER_DAY * cores);
    for (let i = 0; i < PER_DAY; i++) {
      const slot = day * PER_DAY + i;
      for (let c = 0; c < cores; c++) out[i * cores + c] = 3 + unit(k, c) * 6 + Math.abs(gauss(derive(k, c + 1), slot)) * 1.5;
    }
    return out;
  }, 64);
}

// Per-core CPU percentages in the slot starting at t, or null while down.
export function cpuAt(dev, t) {
  if (isDown(dev, t)) return null;
  const cores = coresOf(dev);
  const slot = Math.floor(t / SLOT);
  const day = Math.floor(slot / PER_DAY);
  const base = cpuDay(dev, day);
  const load = clientsAt(dev, t) * 0.12;
  return Array.from({ length: cores }, (_, c) => Math.min(100, base[(slot - day * PER_DAY) * cores + c] + load * (c < 2 ? 1.5 : 1)));
}

// Halifax starts as an SSO pair with Catalyst APs joined to chassis 1, which
// failed over to chassis 2 nine days before boot: chassis 1 reloaded and came
// back as the standby.
export function seedWlc(world, net, tpl) {
  if (!tpl.controllers) return;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:lab:${tpl.code}:wlc`));
  const members = net.devices.filter(isController);
  const ts = world.bootDay - 9 * DAY + r.int(13, 20) * HOUR + r.int(0, 3599);
  const id = r.digits(6);
  const serials = new Set();
  const aps = tpl.catalystAps.map((model, i) => {
    let serial;
    do serial = `Q5AB-${r.chars(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}-${r.chars(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}`;
    while (serials.has(serial) || world.deviceBySerial.has(serial));
    serials.add(serial);
    const name = `AP-${tpl.code}-${String(i + 1).padStart(2, '0')}`;
    return {
      serial,
      model,
      name,
      joinedAt: members[0].claimedAt + 2 * HOUR + i * 95 + r.int(0, 60),
      mode: 'local',
      countryCode: 'CA',
      tags: { policy: `${tpl.code}-policy`, site: `${tpl.code}-site`, rf: 'default-rf-tag' },
      catalystSerial: `FGL${r.digits(4)}${r.chars(4, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')}`,
    };
  });
  net.wirelessControllers = { id, key: hashStr(`wlc:${net.id}:${id}`), mobilityMac: `00:1e:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}:${r.hex(2)}`, members, failovers: [{ ts, reason: 'Active Unit Failed' }], aps };
  members[0].reloads = [[ts, ts + RELOAD]];
}
