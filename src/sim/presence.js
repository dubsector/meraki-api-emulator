// When each client is connected. Sessions are generated per local day from the
// client's schedule, so presence is stable for any time window.

import { derive, unit } from '../rng.js';
import { HOUR, weekday } from '../time.js';
import { perDay } from './cache.js';

// Session flags: a real connect at the start and/or a real disconnect at the end.
// Always-on clients span midnight, so their day boundaries are not events.
export const START = 1;
export const END = 2;

export function sessions(c, day) {
  return perDay(c, 'sessionCache', day, () => build(c, day));
}

function build(c, day) {
  const zone = c.net.zone;
  const mid = zone.midnight(day);
  const next = zone.midnight(day + 1);
  const dow = weekday(day);
  const k = derive(c.key, day);
  const u = (i) => unit(k, i);
  const at = (h) => mid + h * HOUR;
  const weekend = dow === 0 || dow === 6;

  switch (c.schedule) {
    case 'always': {
      if (u(0) < 0.04) {
        const drop = mid + u(1) * (next - mid);
        const back = Math.min(next, drop + 60 + u(2) * 600);
        return [[mid, drop, END], [back, next, START]];
      }
      return [[mid, next, 0]];
    }
    case 'office': {
      const p = dow === 0 ? 0.03 : dow === 6 ? 0.06 : 0.9 * c.attend;
      if (u(0) >= p) return [];
      if (weekend) {
        const s = 10 + u(1) * 3;
        return [[at(s), at(s + 1.5 + u(2) * 3), START | END]];
      }
      const s = 7.25 + c.habit * 1.5 + u(1) * 0.6;
      const out = [[at(s), at(s + 7.75 + u(2) * 2), START | END]];
      // Phones sometimes leave the building for lunch.
      if (c.kindName === 'phone' && u(3) < 0.35) {
        const l = 11.75 + u(4) * 1.5;
        const e = out[0][1];
        out[0] = [out[0][0], at(l), START | END];
        out.push([at(l + 0.5 + u(5) * 0.5), e, START | END]);
      }
      return out;
    }
    case 'shift': {
      const p = dow === 0 ? 0.12 : dow === 6 ? 0.5 : 0.92 * c.attend;
      if (u(0) >= p) return [];
      const s = (c.shift ? 14 : 6) - 0.25 + u(1) * 0.4;
      return [[at(s), at(s + 8.5 + u(2) * 0.3), START | END]];
    }
    case 'retail': {
      if (u(0) >= (dow === 0 ? 0.55 : 0.72)) return [];
      const s = 9 + u(1) * 4.5;
      return [[at(s), at(Math.min(21.25, s + 5 + u(2) * 4)), START | END]];
    }
    case 'guest': {
      const retail = c.net.kind === 'retail';
      const p = retail ? (dow === 6 ? 0.34 : 0.22) : weekend ? 0.02 : 0.28;
      if (u(0) >= p) return [];
      const open = retail ? 10 : 9;
      const close = retail ? 20.5 : 17.5;
      const out = [];
      const n = u(1) < 0.25 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const s = open + u(2 + i) * (close - open);
        const len = (retail ? 0.15 : 0.4) + u(4 + i) * (retail ? 0.9 : 1.8);
        out.push([at(s), at(s + len), START | END]);
      }
      out.sort((a, b) => a[0] - b[0]);
      if (out.length === 2 && out[1][0] < out[0][1]) return [[out[0][0], Math.max(out[0][1], out[1][1]), START | END]];
      return out;
    }
    default:
      return [];
  }
}

// Calls fn(start, end, flags) for every session overlapping [a, b), unclipped.
export function eachSession(c, a, b, fn) {
  const zone = c.net.zone;
  const d1 = zone.day(b);
  for (let d = zone.day(a) - 1; d <= d1; d++) {
    for (const s of sessions(c, d)) {
      if (s[1] > a && s[0] < b) fn(s[0], s[1], s[2]);
    }
  }
}

export function isOnline(c, t) {
  let on = false;
  eachSession(c, t, t + 1, () => (on = true));
  return on;
}

// Seconds connected within [a, b), plus first and last connected instants.
export function presenceIn(c, a, b) {
  let seconds = 0;
  let first = Infinity;
  let last = -Infinity;
  eachSession(c, a, b, (s, e) => {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    seconds += hi - lo;
    first = Math.min(first, lo);
    last = Math.max(last, hi);
  });
  return seconds > 0 ? { seconds, first, last } : null;
}
