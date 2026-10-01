// Client traffic on a fixed 5-minute grid. Every bucket size the API offers is
// a multiple of 5 minutes (except 60s, which splits a slot), so totals agree
// across resolutions.

import { derive, lognoise, unit } from '../rng.js';
import { DAY, HOUR, weekday } from '../time.js';
import { perDay } from './cache.js';
import { eachSession } from './presence.js';

export const SLOT = 300;
const PER_DAY = DAY / SLOT;
const PER_HOUR = HOUR / SLOT;

// Days of per-client totals kept: the longest window is 186 days. Hourly
// totals serve the days a window only partly covers. Per-day client
// histories split at local midnight, so up to 31 days need them at once.
const DAYS_KEPT = 200;
const HOURS_KEPT = 40;

// Series stored per network day, in KB.
export const WL_SENT = 0;
export const WL_RECV = 1;
export const WD_SENT = 2;
export const WD_RECV = 3;
export const WAN_SENT = 4;
export const WAN_RECV = 5;
const SERIES = 6;

const WORK = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.4, 0.7, 0.95, 1.25, 1.3, 1.2, 0.75, 1.1, 1.2, 1.15, 1.0, 0.8, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3];

function interp(table, h) {
  const i = Math.floor(h);
  const f = h - i;
  return table[i % 24] * (1 - f) + table[(i + 1) % 24] * f;
}

export function workCurve(h) {
  return interp(WORK, h);
}

function curve(c, h, slot, dow) {
  const weekdayHours = dow !== 0 && dow !== 6 && h >= 8.5 && h < 17.5;
  switch (c.kind.curve) {
    case 'work':
      return interp(WORK, h);
    case 'calls':
      return weekdayHours && unit(c.keys.call, Math.floor(slot / 3)) < 0.22 ? 22 : 1;
    case 'backup':
      return h >= 2 && h < 3.5 ? 400 : 1;
    case 'meetings':
      return weekdayHours && unit(c.keys.meet, Math.floor(slot / 6)) < 0.4 ? 380 : 1;
    case 'retail':
      return h >= 10 && h < 20 ? 1.5 : 0.3;
    default:
      return 1;
  }
}

function keysOf(c) {
  return (c.keys ||= { burst: derive(c.key, 'burst'), call: derive(c.key, 'call'), meet: derive(c.key, 'meet') });
}

function kbps(c, ss, off, slot) {
  const local = ss + off;
  const h = (((local % DAY) + DAY) % DAY) / HOUR;
  const dow = weekday(Math.floor(local / DAY));
  let r = c.kind.kbps * curve(c, h, slot, dow) * lognoise(c.key, slot, c.kind.sigma);
  if (c.kind.burst && unit(c.keys.burst, slot) < c.kind.burst) r *= 12;
  return r;
}

// Calls visit(slot, sentKB, recvKB, seconds) for each slot the client used in [a, b).
// Walks every slot, so endpoints should total usage with clientUsage,
// clientsUsage or networkTotals, which are cached per day.
export function eachSlot(c, a, b, visit) {
  keysOf(c);
  const zone = c.net.zone;
  eachSession(c, a, b, (s, e) => {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    // Each slot uses the offset at its own time, so it reads the same through
    // any window and follows local time across a DST change.
    const off = zone.offset(lo);
    const fixed = off === zone.offset(hi - 1);
    for (let slot = Math.floor(lo / SLOT); slot * SLOT < hi; slot++) {
      const ss = slot * SLOT;
      const secs = Math.min(hi, ss + SLOT) - Math.max(lo, ss);
      const kb = (kbps(c, ss, fixed ? off : zone.offset(ss), slot) * secs) / 8;
      visit(slot, kb * c.kind.up, kb * (1 - c.kind.up), secs);
    }
  });
}

// Hourly KB, sent and received interleaved, 48 values per UTC day. Daily
// totals are always summed from these, so every way of building a day agrees.
function hourly(c, d0, d1, out = new Float64Array((d1 - d0) * 48)) {
  out.fill(0, 0, (d1 - d0) * 48);
  const base = d0 * PER_DAY;
  eachSlot(c, d0 * DAY, d1 * DAY, (slot, s, r) => {
    const i = 2 * Math.floor((slot - base) / PER_HOUR);
    out[i] += s;
    out[i + 1] += r;
  });
  return out;
}

function dayTotals(hours, at = 0) {
  let sent = 0;
  let recv = 0;
  for (let i = at; i < at + 48; i += 2) {
    sent += hours[i];
    recv += hours[i + 1];
  }
  return [sent, recv];
}

// Reused for hours that only feed daily totals.
let scratch = new Float64Array(48);

function setDay(c, day, hours, at) {
  perDay(c, 'dayCache', day, () => dayTotals(hours, at), DAYS_KEPT);
}

function clientHours(c, day) {
  return perDay(c, 'hourCache', day, () => hourly(c, day, day + 1), HOURS_KEPT);
}

function clientDay(c, day) {
  return perDay(c, 'dayCache', day, () => dayTotals(c.hourCache?.get(day) ?? hourly(c, day, day + 1, scratch)), DAYS_KEPT);
}

// Totals for the uncached days in [d0, d1), from one walk rather than one per day.
function fillDays(c, d0, d1) {
  const cache = c.dayCache;
  while (d0 < d1 && cache?.has(d0)) d0++;
  while (d1 > d0 && cache?.has(d1 - 1)) d1--;
  if (d1 <= d0) return;
  // Make room first, so the cache doesn't clear itself halfway through.
  if (cache && cache.size + (d1 - d0) > DAYS_KEPT) cache.clear();
  if (scratch.length < (d1 - d0) * 48) scratch = new Float64Array((d1 - d0) * 48);
  hourly(c, d0, d1, scratch);
  for (let d = d0; d < d1; d++) setDay(c, d, scratch, (d - d0) * 48);
}

function walk(c, a, b, out) {
  if (b > a) {
    eachSlot(c, a, b, (slot, s, r) => {
      out.sent += s;
      out.recv += r;
    });
  }
}

// KB over [a, b): cached days in the middle, cached hours on the days at each
// edge, and a slot walk only for the partial hours at either end.
export function clientUsage(c, a, b) {
  const out = { sent: 0, recv: 0 };
  const h0 = Math.ceil(a / HOUR);
  const h1 = Math.floor(b / HOUR);
  if (h1 <= h0) {
    walk(c, a, b, out);
    return out;
  }
  fillDays(c, Math.ceil(h0 / 24), Math.floor(h1 / 24));
  walk(c, a, h0 * HOUR, out);
  for (let h = h0; h < h1; ) {
    const day = Math.floor(h / 24);
    const end = Math.min(h1, (day + 1) * 24);
    if (h === day * 24 && end === (day + 1) * 24) {
      const [s, r] = clientDay(c, day);
      out.sent += s;
      out.recv += r;
    } else {
      const hours = clientHours(c, day);
      for (let i = 2 * (h - day * 24); i < 2 * (end - day * 24); i += 2) {
        out.sent += hours[i];
        out.recv += hours[i + 1];
      }
    }
    h = end;
  }
  walk(c, h1 * HOUR, b, out);
  return out;
}

export function clientsUsage(clients, a, b) {
  let sent = 0;
  let recv = 0;
  for (const c of clients) {
    const u = clientUsage(c, a, b);
    sent += u.sent;
    recv += u.recv;
  }
  return { sent, recv };
}

export function networkDay(net, day) {
  return perDay(net, 'usageCache', day, () => buildDay(net, day), 400);
}

function buildDay(net, day) {
  const arr = new Float64Array(SERIES * PER_DAY);
  const base = day * PER_DAY;
  for (const c of net.clients) {
    const s = c.wired ? WD_SENT : WL_SENT;
    const wan = c.kind.wan;
    const hours = scratch.fill(0, 0, 48);
    eachSlot(c, day * DAY, (day + 1) * DAY, (slot, sent, recv) => {
      const i = slot - base;
      arr[s * PER_DAY + i] += sent;
      arr[(s + 1) * PER_DAY + i] += recv;
      arr[WAN_SENT * PER_DAY + i] += sent * wan;
      arr[WAN_RECV * PER_DAY + i] += recv * wan;
      const h = 2 * Math.floor(i / PER_HOUR);
      hours[h] += sent;
      hours[h + 1] += recv;
    });
    // The client's daily total comes free with the walk.
    setDay(c, day, hours, 0);
  }
  return arr;
}

// Sums the given series over [a, b), weighting partial slots at the edges.
export function networkTotals(net, a, b, series) {
  const out = new Array(series.length).fill(0);
  if (b <= a) return out;
  for (let slot = Math.floor(a / SLOT); slot * SLOT < b; slot++) {
    const day = Math.floor(slot / PER_DAY);
    const arr = networkDay(net, day);
    const i = slot - day * PER_DAY;
    const w = (Math.min(b, (slot + 1) * SLOT) - Math.max(a, slot * SLOT)) / SLOT;
    for (let j = 0; j < series.length; j++) out[j] += arr[series[j] * PER_DAY + i] * w;
  }
  return out;
}

// Splits one slot into five minutes with stable weights, for 60s resolutions.
export function minuteShare(key, minute) {
  const slotStart = minute - (((minute % 5) + 5) % 5);
  let total = 0;
  for (let m = 0; m < 5; m++) total += 0.5 + unit(key, slotStart + m);
  return (0.5 + unit(key, minute)) / total;
}

// Aligned [start, end) buckets covering [t0, t1).
export function buckets(t0, t1, res) {
  const out = [];
  for (let s = Math.floor(t0 / res) * res; s < t1; s += res) out.push([s, s + res]);
  return out;
}
