// System memory use and CPU load, sampled every five minutes. Each device holds a steady
// share of its RAM that rises over the working day at its site, plus a little
// noise. A device reports nothing while it's down.

import { derive, gauss, unit } from '../rng.js';
import { DAY } from '../time.js';
import { perDay } from './cache.js';
import { eachOutage } from './outages.js';

export const SAMPLE = 300;
const PER_DAY = DAY / SAMPLE;
const BASE = { appliance: 0.42, switch: 0.5, wireless: 0.38, camera: 0.55, sensor: 0.3, cellularGateway: 0.35 };

export const ramKb = (dev) => dev.info.ram * 1024;

// Used kB for each sample time in a UTC day, 0 while the device was down.
// The sample at i is taken at the day's start plus (i + 1) * SAMPLE.
function memoryDay(dev, day) {
  return perDay(dev, 'memoryCache', day, () => {
    const total = ramKb(dev);
    const k = derive(dev.key, 'memory');
    const base = BASE[dev.productType] + unit(k, 0) * 0.15;
    const start = day * DAY;
    const out = new Int32Array(PER_DAY);
    for (let i = 0; i < PER_DAY; i++) {
      const t = start + (i + 1) * SAMPLE;
      const hour = dev.net.zone.hourOf(t);
      const busy = hour >= 8 && hour < 18 ? Math.sin(((hour - 8) / 10) * Math.PI) : 0;
      const share = base + busy * 0.06 + gauss(k, t / SAMPLE) * 0.01;
      out[i] = Math.round(total * Math.min(0.95, Math.max(0.1, share)));
    }
    eachOutage(dev, start, start + DAY + SAMPLE, (s, e) => {
      for (let i = Math.max(0, Math.ceil((s - start) / SAMPLE) - 1); i < PER_DAY && start + (i + 1) * SAMPLE < e; i++) out[i] = 0;
    });
    if (dev.dormant) for (let i = 0; i < PER_DAY; i++) if (start + (i + 1) * SAMPLE >= dev.dormantSince) out[i] = 0;
    return out;
  }, 64);
}

// Samples in (a, b], oldest first, leaving out the times the device was down.
export function memorySamples(dev, a, b) {
  const out = [];
  for (let t = Math.floor(a / SAMPLE) * SAMPLE + SAMPLE; t <= b; t += SAMPLE) {
    const day = Math.floor((t - SAMPLE) / DAY);
    const used = memoryDay(dev, day)[(t - day * DAY) / SAMPLE - 1];
    if (used) out.push({ t, used });
  }
  return out;
}

// CPU load on the same five-minute samples: the 5-minute load average times
// 1000, busier over the site's working day. The flaky AP runs hotter.
export const CPU_COUNT = { CW9166I: 4, MR46: 4, MR36: 2, MR78: 2 };

function cpuDay(dev, day) {
  return perDay(dev, 'cpuCache', day, () => {
    const k = derive(dev.key, 'cpu');
    const base = (0.2 + unit(k, 0) * 0.3) * (dev.flaky ? 2 : 1);
    const start = day * DAY;
    const out = new Int32Array(PER_DAY);
    for (let i = 0; i < PER_DAY; i++) {
      const t = start + (i + 1) * SAMPLE;
      const hour = dev.net.zone.hourOf(t);
      const busy = hour >= 8 && hour < 18 ? Math.sin(((hour - 8) / 10) * Math.PI) : 0;
      out[i] = Math.max(1, Math.round((base + busy * 0.5 + Math.abs(gauss(k, t / SAMPLE)) * 0.08) * 1000));
    }
    eachOutage(dev, start, start + DAY + SAMPLE, (s, e) => {
      for (let i = Math.max(0, Math.ceil((s - start) / SAMPLE) - 1); i < PER_DAY && start + (i + 1) * SAMPLE < e; i++) out[i] = 0;
    });
    if (dev.dormant) for (let i = 0; i < PER_DAY; i++) if (start + (i + 1) * SAMPLE >= dev.dormantSince) out[i] = 0;
    return out;
  }, 64);
}

// Samples in (a, b], oldest first, without the times the device was down.
export function cpuSamples(dev, a, b) {
  const out = [];
  for (let t = Math.floor(a / SAMPLE) * SAMPLE + SAMPLE; t <= b; t += SAMPLE) {
    const day = Math.floor((t - SAMPLE) / DAY);
    const load = cpuDay(dev, day)[(t - day * DAY) / SAMPLE - 1];
    if (load) out.push({ t, load });
  }
  return out;
}
