// Wireless connection and latency stats, derived from client sessions.

import { lognoise } from '../rng.js';
import { connectFailure } from './events.js';
import { START, eachSession, presenceIn } from './presence.js';

export function connectionStats(clients, t0, t1) {
  const out = { assoc: 0, auth: 0, dhcp: 0, dns: 0, success: 0 };
  for (const c of clients) {
    if (c.wired || !c.ap) continue;
    eachSession(c, t0, t1, (s, e, flags) => {
      if (!(flags & START) || s < t0 || s >= t1) return;
      out.success++;
      const fail = connectFailure(c, s);
      if (fail) out[fail]++;
    });
  }
  return out;
}

const BUCKETS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const CLASSES = { backgroundTraffic: 1.8, bestEffortTraffic: 1, videoTraffic: 0.7, voiceTraffic: 0.45 };
export const ACCESS_CATEGORIES = Object.keys(CLASSES);
// Share of the sampled packets in each class.
const SHARE = (name) => (name === 'bestEffortTraffic' ? 0.7 : 0.1);

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

// Sample counts per latency bucket (ms) for a lognormal centred near avg.
function distribution(avg, samples) {
  const sigma = 0.8;
  const mu = Math.log(avg) - (sigma * sigma) / 2;
  const cdf = (x) => (x <= 0 ? 0 : 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2))));
  const out = {};
  BUCKETS.forEach((b, i) => {
    const hi = BUCKETS[i + 1] ?? Infinity;
    out[String(b)] = Math.round(samples * (cdf(hi) - cdf(b)));
  });
  return out;
}

// Per-AP latency by traffic class; busier windows and the flaky AP run slower.
export function apLatency(ap, t0, t1) {
  const clients = ap.net.clients.filter((c) => c.ap === ap && !c.wired);
  let seconds = 0;
  for (const c of clients) seconds += presenceIn(c, t0, t1)?.seconds ?? 0;
  const load = clients.length ? seconds / ((t1 - t0) * clients.length) : 0;
  const be = (5 + 28 * load) * (ap.flaky ? 2.8 : 1) * lognoise(ap.key, Math.floor(t0 / 3600), 0.15);
  return { be, samples: Math.round(seconds / 4) };
}

export function latencyStats(aps, t0, t1, fields) {
  let weighted = 0;
  let weight = 0;
  let samples = 0;
  for (const ap of aps) {
    const l = apLatency(ap, t0, t1);
    weighted += l.be * Math.max(1, l.samples);
    weight += Math.max(1, l.samples);
    samples += l.samples;
  }
  return latencyJson(weight ? weighted / weight : 0, samples, fields);
}

// A client sees its AP's latency, sampled in proportion to its own airtime.
export function clientLatency(c, t0, t1) {
  const seconds = presenceIn(c, t0, t1)?.seconds ?? 0;
  return { be: seconds ? apLatency(c.ap, t0, t1).be : 0, samples: Math.round(seconds / 4) };
}

// Average latency in one traffic class, or across all of them by sample share.
export function classLatency(be, name) {
  if (name) return be * CLASSES[name];
  return Object.entries(CLASSES).reduce((sum, [n, f]) => sum + be * f * SHARE(n), 0);
}

export function latencyJson(be, samples, fields) {
  const want = fields ? fields.split(',').map((f) => f.trim()) : ['rawDistribution', 'avg'];
  const out = {};
  for (const [name, factor] of Object.entries(CLASSES)) {
    const avg = Math.round(be * factor * 100) / 100;
    const n = Math.round(samples * SHARE(name));
    const entry = {};
    if (want.includes('rawDistribution')) entry.rawDistribution = avg > 0 ? distribution(avg, n) : {};
    if (want.includes('avg')) entry.avg = avg;
    out[name] = entry;
  }
  return out;
}

// Sample counts per class keyed by bucket in the latency history's format
// ("0.5" for the first bucket, then "1.0", "2.0" and so on), from the same
// distribution latencyStats reports.
export function latencyBins(be, samples) {
  const out = {};
  for (const [name, factor] of Object.entries(CLASSES)) {
    const avg = Math.round(be * factor * 100) / 100;
    const counts = avg > 0 ? distribution(avg, Math.round(samples * SHARE(name))) : {};
    out[name] = Object.fromEntries(BUCKETS.map((b) => [b ? b.toFixed(1) : '0.5', counts[String(b)] ?? 0]));
  }
  return out;
}
