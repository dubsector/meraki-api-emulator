// WAN link quality: per-minute loss, latency and jitter for each MX uplink.

import { derive, gauss, hashStr, unit } from '../rng.js';
import { workCurve } from './usage.js';
import { isDown, uplinkUp } from './outages.js';

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function keys(uplink) {
  return (uplink.keys ||= { spike: derive(uplink.key, 'spike'), size: derive(uplink.key, 'size'), loss: derive(uplink.key, 'loss'), jit: derive(uplink.key, 'jit') });
}

export function linkSample(mx, uplink, t, ip = '8.8.8.8') {
  if (!uplinkUp(mx, uplink, t)) return { latencyMs: null, lossPercent: 100, jitter: null, goodput: 0 };
  const k = keys(uplink);
  const minute = Math.floor(t / 60);
  const block = Math.floor(t / 600);
  const h = mx.net.zone.hourOf(t);
  const evening = h >= 19 && h < 23 ? uplink.evening : 0;
  const busy = 3 * workCurve(h);
  let latency = uplink.latency + (hashStr(ip) % 5) + evening + busy + Math.abs(gauss(uplink.key, minute)) * uplink.jitter;
  let loss = 0;
  let jitter = uplink.jitter * (0.4 + unit(k.jit, minute));
  if (unit(k.spike, block) < 0.015) {
    latency += 60 + unit(k.size, block) * 180;
    loss = 1 + unit(k.size, block + 1) * 12;
    jitter += 15;
  } else if (unit(k.loss, minute) < 0.02) {
    loss = 0.3 + unit(k.loss, minute + 1) * 2;
  }
  return { latencyMs: round(latency), lossPercent: round(loss), jitter: round(jitter, 2), goodput: Math.round(1450 + gauss(k.jit, minute) * 25) };
}

// Averages minute samples over [a, b); long buckets sample every few minutes.
export function linkAverage(mx, uplink, a, b, ip) {
  const step = b - a > 6 * 3600 ? 300 : 60;
  let n = 0;
  let lat = 0;
  let latN = 0;
  let loss = 0;
  let jit = 0;
  let good = 0;
  for (let t = Math.floor(a / 60) * 60; t < b; t += step) {
    const s = linkSample(mx, uplink, t, ip);
    n++;
    loss += s.lossPercent;
    good += s.goodput;
    if (s.latencyMs != null) {
      lat += s.latencyMs;
      jit += s.jitter;
      latN++;
    }
  }
  if (!n) return null;
  return {
    lossPercent: round(loss / n),
    latencyMs: latN ? round(lat / latN) : null,
    jitter: latN ? round(jit / latN, 2) : null,
    goodput: Math.round(good / n),
  };
}

// Rough site-to-site RTT from the two sites' distance.
export function pathLatency(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  const km = 12742 * Math.asin(Math.sqrt(x));
  return 4 + km / 65;
}

export function vpnReachable(a, b, t) {
  return !isDown(a.mx, t) && !isDown(b.mx, t);
}
