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
  const be = weight ? weighted / weight : 0;
  const want = fields ? fields.split(',').map((f) => f.trim()) : ['rawDistribution', 'avg'];
  const out = {};
  for (const [name, factor] of Object.entries(CLASSES)) {
    const avg = Math.round(be * factor * 100) / 100;
    const n = Math.round(samples * (name === 'bestEffortTraffic' ? 0.7 : 0.1));
    const entry = {};
    if (want.includes('rawDistribution')) entry.rawDistribution = avg > 0 ? distribution(avg, n) : {};
    if (want.includes('avg')) entry.avg = avg;
    out[name] = entry;
  }
  return out;
}
