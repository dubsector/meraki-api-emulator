// Zigbee door locks and electronic shelf label state. Both run on CW916x
// access points only. Door locks live on the AP that paired them, so a swap
// keeps them and a removed AP takes them along.

import { Rand, hashStr } from '../rng.js';
import { DAY } from '../time.js';
import { isDown, lastReportedAt } from './outages.js';

const HEX = '0123456789ABCDEF';

export const iotCapable = (dev) => dev.productType === 'wireless' && dev.model.startsWith('CW916');

export const locksOf = (ap) => (ap.zigbeeLocks ??= { created: 0, list: [] });

// Enrolled and not yet disenrolled at time t.
export const lockLive = (l, t) => l.enrolledAt <= t && !(l.removedAt != null && l.removedAt <= t);

export function addDoorLock(world, ap, enrolledAt, name) {
  const store = locksOf(ap);
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:doorLock:${ap.serial}:${store.created}`));
  const shortId = r.chars(6, HEX);
  const lock = { doorLockId: r.digits(13), name: name ?? `Door Lock ${shortId}`, shortId, eui64: r.chars(16, HEX), lqi: r.int(90, 255), rssi: r.int(-85, -45), key: r.key(), enrolledAt, removedAt: null };
  store.list.push(lock);
  return lock;
}

// Locks check in every few minutes while their gateway is up.
export function lockSeen(lock, ap, now) {
  const t = isDown(ap, now) ? lastReportedAt(ap, now) : Math.floor(now) - (lock.key % 240);
  return Math.max(lock.enrolledAt, t);
}

// Lab networks marked zigbee or esl start with them on: the first CW916x is
// the IoT controller and pairs the named locks some days after it was claimed.
export function seedIot(world, net, tpl) {
  const ap = net.devices.find(iotCapable);
  if (!ap) return;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:lab:${tpl.code}:iot`));
  if (tpl.zigbee) {
    net.wirelessZigbee = { enabled: true, controller: ap, lockManagement: { address: null, username: null, password: null }, defaults: { transmitPowerLevel: 10, channel: 'auto' } };
    ap.zigbeeGateway = { enrolled: true, channel: null };
    let t = ap.claimedAt + r.int(2, 20) * DAY;
    for (const name of tpl.zigbee.locks) addDoorLock(world, ap, (t += r.int(600, 7200)), name);
  }
  if (tpl.esl) {
    net.wirelessEsl = { enabled: true, hostname: tpl.esl.hostname, mode: tpl.esl.mode };
    ap.wirelessEsl = { enabled: true, channel: 'Auto' };
  }
}
