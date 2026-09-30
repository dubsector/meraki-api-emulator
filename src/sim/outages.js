// Device outages and WAN uplink failures, generated per UTC day.

import { derive, unit } from '../rng.js';
import { DAY } from '../time.js';
import { perDay } from './cache.js';

export function deviceOutagesOnDay(dev, day) {
  return perDay(dev, 'outageCache', day, () => {
    const k = derive(dev.key, day);
    const start = day * DAY;
    const out = [];
    if (dev.flaky) {
      // The flaky AP drops a few times a day for a few minutes.
      const n = unit(k, 0) < 0.65 ? 1 + Math.floor(unit(k, 1) * 3) : 0;
      for (let i = 0; i < n; i++) {
        const s = start + unit(k, 2 + i) * DAY;
        out.push([s, s + 60 + unit(k, 6 + i) * 840]);
      }
    } else if (unit(k, 0) < dev.outageRate) {
      const s = start + unit(k, 1) * DAY;
      out.push([s, s + 120 + unit(k, 2) * 5400]);
    }
    // A dormant device never comes back, so only outages that ended before it went dark count.
    return out.filter((o) => !dev.dormant || o[1] < dev.dormantSince).sort((x, y) => x[0] - y[0]);
  });
}

// Outages last at most a couple of hours, so looking back one day is enough.
export function eachOutage(dev, a, b, fn) {
  for (let d = Math.floor(a / DAY) - 1; d <= Math.floor(b / DAY); d++) {
    for (const o of deviceOutagesOnDay(dev, d)) if (o[1] > a && o[0] < b) fn(o[0], o[1]);
  }
}

export function isDown(dev, t) {
  if (dev.dormant && t >= dev.dormantSince) return true;
  let down = false;
  eachOutage(dev, t, t + 1, () => (down = true));
  return down;
}

export function deviceStatus(dev, t) {
  if (dev.dormant && t >= dev.dormantSince) return t - dev.dormantSince > 7 * DAY ? 'dormant' : 'offline';
  if (isDown(dev, t)) return 'offline';
  return dev.alerting ? 'alerting' : 'online';
}

// Status transitions in [a, b), oldest first.
export function statusChanges(dev, a, b, now) {
  const out = [];
  const end = Math.min(b, now);
  eachOutage(dev, a - DAY, end, (s, e) => {
    if (s >= a && s < end) out.push({ ts: s, from: dev.alerting ? 'alerting' : 'online', to: 'offline' });
    if (e >= a && e < end) out.push({ ts: e, from: 'offline', to: dev.alerting ? 'alerting' : 'online' });
  });
  if (dev.dormant && dev.dormantSince >= a && dev.dormantSince < end) out.push({ ts: dev.dormantSince, from: 'online', to: 'offline' });
  if (dev.dormant) {
    const d = dev.dormantSince + 7 * DAY;
    if (d >= a && d < end) out.push({ ts: d, from: 'offline', to: 'dormant' });
  }
  return out.sort((x, y) => x.ts - y.ts);
}

export function uplinkFailuresOnDay(uplink, day) {
  return perDay(uplink, 'failCache', day, () => {
    const k = derive(uplink.key, day);
    if (unit(k, 0) >= 0.07) return [];
    const s = day * DAY + unit(k, 1) * DAY;
    return [[s, s + 180 + unit(k, 2) * 2400]];
  });
}

export function eachUplinkFailure(uplink, a, b, fn) {
  for (let d = Math.floor(a / DAY) - 1; d <= Math.floor(b / DAY); d++) {
    for (const f of uplinkFailuresOnDay(uplink, d)) if (f[1] > a && f[0] < b) fn(f[0], f[1]);
  }
}

export function uplinkUp(mx, uplink, t) {
  if (isDown(mx, t)) return false;
  let up = true;
  eachUplinkFailure(uplink, t, t + 1, () => (up = false));
  return up;
}

// Which uplink carries traffic at t: wan1 unless it has failed.
export function activeUplink(mx, t) {
  for (const u of mx.uplinks) if (uplinkUp(mx, u, t)) return u;
  return null;
}

export function uplinkStatus(mx, uplink, t) {
  if (isDown(mx, t)) return 'not connected';
  if (!uplinkUp(mx, uplink, t)) return 'failed';
  return activeUplink(mx, t) === uplink ? 'active' : 'ready';
}
