// MT sensor readings. Continuous metrics report every 15 minutes, battery,
// water and the MT40's switch states every hour, and doors and buttons on each
// event. Values are pure functions of the sensor and the time, cached a UTC day
// at a time; a sensor that is down reports nothing. Commands on an MT40 change
// what it reports from the moment they finish, applied at read time.

import { derive, gauss, unit } from '../rng.js';
import { DAY, HOUR, weekday } from '../time.js';
import { perDay } from './cache.js';
import { eachOutage } from './outages.js';

const STEP = 900;
const SLOTS = DAY / STEP;
const HOURS = DAY / HOUR;
// A cycle turns the outlet off this many seconds before the command finishes.
export const CYCLE_OFF = 5;

export const GRID = ['temperature', 'humidity', 'co2', 'tvoc', 'pm25', 'noise', 'indoorAirQuality', 'realPower', 'apparentPower', 'current', 'voltage', 'frequency', 'powerFactor'];
const HOURLY = ['battery', 'water', 'downstreamPower', 'remoteLockoutSwitch'];
const POWER_DRAW = ['realPower', 'apparentPower', 'current', 'powerFactor'];

export const sensorsOf = (net) => net.devices.filter((d) => d.productType === 'sensor');

// Every metric a sensor model reports, battery included.
export const metricsOf = (dev) => [...dev.info.metrics, ...(dev.info.battery ? ['battery'] : [])];

// How busy the sensor's site is at t: 0 outside office hours, up to 1 mid-afternoon.
function occupancy(net, t) {
  const wd = weekday(net.zone.day(t));
  if (wd === 0 || wd === 6) return 0;
  const h = net.zone.hourOf(t);
  return h >= 8 && h < 18 ? Math.sin(((h - 8) / 10) * Math.PI) : 0;
}

// The value of a continuous metric at any time, before commands.
export function valueAt(dev, metric, t) {
  const k = derive(dev.key, metric);
  const n = gauss(k, Math.floor(t / 60));
  const busy = occupancy(dev.net, t);
  const off = unit(k, 0) - 0.5;
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;
  switch (metric) {
    case 'temperature':
      // The MT11's probe sits in a freezer.
      if (dev.model === 'MT11') return r2(-18.5 + off * 2 + n * 0.3);
      return r2(21.5 + off * 2 + busy * 1.5 + n * 0.15);
    case 'humidity':
      return Math.round(38 + off * 8 - busy * 4 + n * 0.8);
    case 'co2':
      return Math.round(430 + off * 40 + busy * 480 + n * 15);
    case 'tvoc':
      return Math.max(0, Math.round(110 + off * 60 + busy * 190 + n * 12));
    case 'pm25':
      return Math.max(0, Math.round(5 + off * 4 + busy * 5 + n * 1.2));
    case 'noise':
      return Math.round(33 + off * 4 + busy * 20 + n * 2);
    case 'indoorAirQuality': {
      const bad = Math.max(0, valueAt(dev, 'tvoc', t) - 200) / 20 + Math.max(0, valueAt(dev, 'pm25', t) - 10) * 1.5 + (dev.info.metrics.includes('co2') ? Math.max(0, valueAt(dev, 'co2', t) - 700) / 25 : 0);
      return Math.max(0, Math.min(100, Math.round(96 - bad)));
    }
    case 'voltage':
      return r1(120.5 + off * 2 + n * 0.4);
    case 'frequency':
      return r2(60 + n * 0.02);
    case 'powerFactor':
      return Math.round(93 + off * 4 + n * 0.5);
    case 'realPower':
      return r1(160 + off * 60 + busy * 45 + n * 3);
    case 'apparentPower':
      return r1(valueAt(dev, 'realPower', t) / (valueAt(dev, 'powerFactor', t) / 100));
    case 'current':
      return r2(valueAt(dev, 'apparentPower', t) / valueAt(dev, 'voltage', t));
  }
  return null;
}

// Battery falls a little each day from a full one at claim time.
function batteryAt(dev, t) {
  const rate = 0.03 + unit(derive(dev.key, 'battery'), 0) * 0.04;
  return Math.max(5, Math.min(100, Math.round(100 - ((t - dev.claimedAt) / DAY) * rate)));
}

// One UTC day of a sensor's reports: 15 minute slots for continuous metrics
// and hourly ones for the rest, NaN while the sensor is down or before it was
// claimed, plus door and button events as [ts, metric, value].
function sensorDay(dev, day) {
  return perDay(dev, 'readingsCache', day, () => {
    const start = day * DAY;
    const shift = dev.key % 60;
    const down = [];
    eachOutage(dev, start, start + DAY, (a, b) => down.push([a, b]));
    const up = (t) => t >= dev.claimedAt && !(dev.dormant && t >= dev.dormantSince) && !down.some(([a, b]) => t >= a && t < b);
    const grid = {};
    const hourly = {};
    const metrics = metricsOf(dev);
    for (const m of metrics.filter((x) => GRID.includes(x))) {
      const out = new Float64Array(SLOTS);
      for (let i = 0; i < SLOTS; i++) {
        const t = start + shift + i * STEP;
        out[i] = up(t) ? valueAt(dev, m, t) : NaN;
      }
      grid[m] = out;
    }
    for (const m of metrics.filter((x) => HOURLY.includes(x))) {
      const out = new Float64Array(HOURS);
      for (let i = 0; i < HOURS; i++) {
        const t = start + shift + i * HOUR;
        out[i] = !up(t) ? NaN : m === 'battery' ? batteryAt(dev, t) : m === 'downstreamPower' ? 1 : 0;
      }
      hourly[m] = out;
    }
    const events = [];
    const k = derive(dev.key, day);
    const local = dev.net.zone.midnight(dev.net.zone.day(start + DAY / 2));
    const workday = ![0, 6].includes(weekday(dev.net.zone.day(start + DAY / 2)));
    if (metrics.includes('door')) {
      const n = workday ? 6 + Math.floor(unit(k, 0) * 9) : Math.floor(unit(k, 0) * 3);
      for (let i = 0; i < n; i++) {
        const at = Math.floor(local + 8 * HOUR + unit(k, 1 + i) * 10 * HOUR);
        const close = at + 10 + Math.floor(unit(k, 40 + i) * 80);
        if (at >= start && at < start + DAY && up(at)) events.push([at, 'door', 1]);
        if (close >= start && close < start + DAY && up(close)) events.push([close, 'door', 0]);
      }
    }
    if (metrics.includes('button')) {
      const n = workday ? Math.floor(unit(k, 80) * 4) : 0;
      for (let i = 0; i < n; i++) {
        const at = Math.floor(local + 9 * HOUR + unit(k, 81 + i) * 8 * HOUR);
        if (at >= start && at < start + DAY && up(at)) events.push([at, 'button', unit(k, 90 + i) < 0.8 ? 0 : 1]);
      }
    }
    return { start, shift, grid, hourly, events: events.sort((a, b) => a[0] - b[0]) };
  });
}

// Finished power commands, oldest first, as [time, enabled].
function powerChanges(dev) {
  const out = [];
  for (const c of dev.sensorCommands?.list ?? []) {
    if (c.failed || !c.operation.endsWith('DownstreamPower')) continue;
    if (c.operation === 'cycleDownstreamPower') out.push([c.end - CYCLE_OFF, false], [c.end, true]);
    else out.push([c.end, c.operation === 'enableDownstreamPower']);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const powerAt = (changes, t) => {
  let on = true;
  for (const [at, v] of changes) if (at <= t) on = v;
  return on;
};

const reading = (dev, metric, ts, v) => {
  switch (metric) {
    case 'door':
      return { ts, metric, door: { open: v === 1 } };
    case 'button':
      return { ts, metric, button: { pressType: v === 1 ? 'long' : 'short' } };
    case 'water':
      return { ts, metric, water: { present: v === 1 } };
    case 'downstreamPower':
      return { ts, metric, downstreamPower: { enabled: v === 1 } };
    case 'remoteLockoutSwitch':
      return { ts, metric, remoteLockoutSwitch: { locked: v === 1 } };
    case 'battery':
      return { ts, metric, battery: { percentage: v } };
    case 'temperature':
      return { ts, metric, temperature: { fahrenheit: Math.round((v * 9 / 5 + 32) * 100) / 100, celsius: v } };
    case 'humidity':
      return { ts, metric, humidity: { relativePercentage: v } };
    case 'noise':
      return { ts, metric, noise: { ambient: { level: v } } };
    case 'indoorAirQuality':
      return { ts, metric, indoorAirQuality: { score: v } };
    case 'co2':
    case 'tvoc':
    case 'pm25':
      return { ts, metric, [metric]: { concentration: v } };
    case 'voltage':
    case 'frequency':
      return { ts, metric, [metric]: { level: v } };
    case 'powerFactor':
      return { ts, metric, powerFactor: { percentage: v } };
    default:
      return { ts, metric, [metric]: { draw: v } };
  }
};

// Readings as [ts, metric, value] in [a, b], oldest first, then by metric.
// Values are numbers; door, water and the switches use 1 and 0, buttons 1 for
// a long press. `metrics` limits them.
export function rawReadings(dev, a, b, metrics = metricsOf(dev)) {
  const want = new Set(metrics);
  const changes = dev.model === 'MT40' ? powerChanges(dev) : [];
  const refreshes = (dev.sensorCommands?.list ?? []).filter((c) => !c.failed && c.operation === 'refreshData' && c.end >= a && c.end <= b);
  const out = [];
  for (let day = Math.floor(a / DAY); day <= Math.floor(b / DAY); day++) {
    const d = sensorDay(dev, day);
    for (const [m, vals] of Object.entries(d.grid)) {
      if (!want.has(m)) continue;
      for (let i = 0; i < SLOTS; i++) {
        const t = d.start + d.shift + i * STEP;
        if (t < a || t > b || Number.isNaN(vals[i])) continue;
        out.push([t, m, POWER_DRAW.includes(m) && !powerAt(changes, t) ? 0 : vals[i]]);
      }
    }
    for (const [m, vals] of Object.entries(d.hourly)) {
      if (!want.has(m)) continue;
      for (let i = 0; i < HOURS; i++) {
        const t = d.start + d.shift + i * HOUR;
        if (t < a || t > b || Number.isNaN(vals[i])) continue;
        out.push([t, m, m === 'downstreamPower' ? Number(powerAt(changes, t)) : vals[i]]);
      }
    }
    for (const e of d.events) if (e[0] >= a && e[0] <= b && want.has(e[1])) out.push(e);
  }
  // A power change is reported as it happens; a refresh uploads every continuous reading.
  for (const [t, on] of changes) {
    if (t < a || t > b) continue;
    if (want.has('downstreamPower')) out.push([t, 'downstreamPower', Number(on)]);
    for (const m of POWER_DRAW) if (want.has(m)) out.push([t, m, on ? valueAt(dev, m, t) : 0]);
  }
  for (const c of refreshes) {
    for (const m of dev.info.metrics) {
      if (!GRID.includes(m) || !want.has(m)) continue;
      const v = valueAt(dev, m, c.end);
      out.push([c.end, m, POWER_DRAW.includes(m) && !powerAt(changes, c.end) ? 0 : v]);
    }
  }
  out.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  // One reading per metric and second; a command's wins over the schedule's.
  return out.filter((x, i) => i + 1 === out.length || out[i + 1][0] !== x[0] || out[i + 1][1] !== x[1]);
}

export const readingJson = (dev, [t, metric, v], tsOf) => reading(dev, metric, tsOf(t), v);

// The newest reading of each metric at or before now, looking back up to
// `days`. Buttons only report presses, so an idle one can have none.
export function latestRaw(dev, now, metrics = metricsOf(dev), days = 31) {
  const found = new Map();
  const left = new Set(metrics);
  for (let back = 0; back < days && left.size; back++) {
    const dayStart = (Math.floor(now / DAY) - back) * DAY;
    const rows = rawReadings(dev, dayStart, Math.min(now, dayStart + DAY - 1), [...left]);
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i][1];
      if (left.has(m)) {
        found.set(m, rows[i]);
        left.delete(m);
      }
    }
  }
  return [...found.values()].sort((x, y) => (x[1] < y[1] ? -1 : 1));
}
