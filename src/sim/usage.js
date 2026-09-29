// Client traffic on a fixed 5-minute grid. Every bucket size the API offers is
// a multiple of 5 minutes (except 60s, which splits a slot), so totals agree
// across resolutions.

import { derive, lognoise, unit } from '../rng.js';
import { DAY, HOUR, weekday } from '../time.js';
import { eachSession } from './presence.js';

export const SLOT = 300;
const PER_DAY = DAY / SLOT;

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
export function eachSlot(c, a, b, visit) {
  keysOf(c);
  const zone = c.net.zone;
  eachSession(c, a, b, (s, e) => {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    const off = zone.offset(lo);
    for (let slot = Math.floor(lo / SLOT); slot * SLOT < hi; slot++) {
      const ss = slot * SLOT;
      const secs = Math.min(hi, ss + SLOT) - Math.max(lo, ss);
      const kb = (kbps(c, ss, off, slot) * secs) / 8;
      visit(slot, kb * c.kind.up, kb * (1 - c.kind.up), secs);
    }
  });
}

export function clientUsage(c, a, b) {
  let sent = 0;
  let recv = 0;
  eachSlot(c, a, b, (slot, s, r) => {
    sent += s;
    recv += r;
  });
  return { sent, recv };
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

const dayCache = new Map();

export function networkDay(net, day) {
  const key = `${net.id}:${day}`;
  let arr = dayCache.get(key);
  if (arr) return arr;
  arr = new Float64Array(SERIES * PER_DAY);
  const a = day * DAY;
  const base = day * PER_DAY;
  for (const c of net.clients) {
    const s = c.wired ? WD_SENT : WL_SENT;
    const wan = c.kind.wan;
    eachSlot(c, a, a + DAY, (slot, sent, recv) => {
      const i = slot - base;
      arr[s * PER_DAY + i] += sent;
      arr[(s + 1) * PER_DAY + i] += recv;
      arr[WAN_SENT * PER_DAY + i] += sent * wan;
      arr[WAN_RECV * PER_DAY + i] += recv * wan;
    });
  }
  if (dayCache.size > 2000) dayCache.clear();
  dayCache.set(key, arr);
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
