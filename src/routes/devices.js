import { VLANS } from '../catalog.js';
import { deviceJson } from '../format.js';
import { badRequest, resolutionParam, timeWindow } from '../http.js';
import { lognoise } from '../rng.js';
import { linkAverage, linkSample } from '../sim/links.js';
import { presenceIn } from '../sim/presence.js';
import { WAN_RECV, WAN_SENT, clientUsage, networkTotals } from '../sim/usage.js';
import { connectionStats, latencyStats } from '../sim/wireless.js';
import { DAY, MIN, iso } from '../time.js';
import { devOf, requireModel, round } from './common.js';
import { hasFloorPlan } from './floorplans.js';
import { lldpCdp } from './switch.js';

const UPLINKS = ['wan1', 'wan2', 'wan3', 'cellular', 'wan4'];

// An MX's load score over [t0, t1): its WAN throughput against the model's
// rated throughput, plus a little per client.
export function perfScore(dev, t0, t1) {
  const [s, r] = networkTotals(dev.net, t0, t1, [WAN_SENT, WAN_RECV]);
  const mbps = ((s + r) * 8) / 1000 / (t1 - t0);
  const clients = dev.net.clients.length;
  const score = (2 + 100 * (mbps / dev.info.throughput) ** 0.6 + clients / 40) * lognoise(dev.key, Math.floor(t1 / 300), 0.08);
  return round(Math.min(100, score), 1);
}

function deviceClients(dev) {
  const net = dev.net;
  if (dev.productType === 'wireless') return net.clients.filter((c) => !c.wired && c.ap === dev);
  if (dev.productType === 'switch') return net.clients.filter((c) => c.switchPort?.switch === dev);
  if (dev.productType === 'appliance') return net.clients;
  return [];
}

function wirelessClients(ctx, dev) {
  const q = ctx.query;
  const band = q.get('band');
  if (band && !['2.4', '5', '6'].includes(band)) throw badRequest("'band' must be one of: 2.4, 5, 6");
  const ssid = q.get('ssid');
  return deviceClients(dev).filter((c) => (!band || c.band === band) && (ssid == null || String(c.ssid.number) === ssid));
}

function statsWindow(ctx) {
  return timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, lookback: 180 * DAY });
}

export default [
  {
    op: 'getDevice',
    path: '/devices/{serial}',
    handler: (ctx) => deviceJson(devOf(ctx), { full: true }),
  },
  {
    op: 'updateDevice',
    method: 'PUT',
    path: '/devices/{serial}',
    handler: (ctx) => {
      const dev = devOf(ctx);
      const plan = ctx.body.floorPlanId;
      if (plan != null && !hasFloorPlan(dev.net, plan)) throw badRequest(`Floor plan ${plan} does not exist in this device's network`);
      for (const k of ['name', 'lat', 'lng', 'address', 'notes', 'floorPlanId']) if (ctx.body[k] !== undefined) dev[k] = ctx.body[k];
      if (ctx.body.tags !== undefined) dev.tags = ctx.body.tags ?? [];
      return deviceJson(dev, { full: true });
    },
  },
  {
    op: 'getDeviceLldpCdp',
    path: '/devices/{serial}/lldpCdp',
    sample: { serial: 'switch' },
    handler: (ctx) => lldpCdp(devOf(ctx), ctx.now),
  },
  {
    op: 'getDeviceClients',
    path: '/devices/{serial}/clients',
    handler: (ctx) => {
      const dev = devOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });
      const rows = [];
      for (const c of deviceClients(dev)) {
        if (!presenceIn(c, t0, t1)) continue;
        const u = clientUsage(c, t0, t1);
        rows.push({
          id: c.id,
          mac: c.mac,
          description: c.description,
          mdnsName: c.manufacturer === 'Apple' ? c.description : null,
          dhcpHostname: c.description,
          user: c.user,
          ip: c.ip,
          vlan: String(c.vlan),
          namedVlan: VLANS[c.vlan] ?? null,
          switchport: c.switchport,
          adaptivePolicyGroup: null,
          usage: { sent: Math.round(u.sent), recv: Math.round(u.recv) },
        });
      }
      return rows.sort((a, b) => b.usage.sent + b.usage.recv - (a.usage.sent + a.usage.recv));
    },
  },
  {
    op: 'getDeviceLossAndLatencyHistory',
    path: '/devices/{serial}/lossAndLatencyHistory',
    sample: { query: 'ip=8.8.8.8&timespan=3600' },
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      const q = ctx.query;
      const ip = q.get('ip');
      if (!ip) throw badRequest("'ip' is required");
      const name = q.get('uplink') || 'wan1';
      if (!UPLINKS.includes(name)) throw badRequest(`'uplink' must be one of: ${UPLINKS.join(', ')}`);
      const latest = Math.floor(ctx.now / MIN) * MIN;
      const { t0, t1 } = timeWindow(q, latest, { maxSpan: 31 * DAY, lookback: 60 * DAY });
      const res = resolutionParam(q, [60, 600, 3600, 86400], 60, t1 - t0);
      const uplink = dev.uplinks.find((u) => u.interface === name);
      if (!uplink) return [];
      const rows = [];
      for (let s = Math.ceil(t0 / res) * res; s + res <= t1; s += res) {
        const v = res === 60 ? linkSample(dev, uplink, s, ip) : linkAverage(dev, uplink, s, s + res, ip);
        rows.push({ startTime: iso(s), endTime: iso(s + res), lossPercent: v.lossPercent, latencyMs: v.latencyMs, goodput: v.goodput, jitter: v.jitter });
      }
      return rows;
    },
  },
  {
    op: 'getDeviceAppliancePerformance',
    path: '/devices/{serial}/appliance/performance',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, minSpan: 30 * MIN, defaultSpan: 30 * MIN, lookback: 30 * DAY });
      return { perfScore: perfScore(dev, t0, t1) };
    },
  },
  {
    op: 'getDeviceWirelessConnectionStats',
    path: '/devices/{serial}/wireless/connectionStats',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      const { t0, t1 } = statsWindow(ctx);
      return { serial: dev.serial, connectionStats: connectionStats(wirelessClients(ctx, dev), t0, t1) };
    },
  },
  {
    op: 'getDeviceWirelessLatencyStats',
    path: '/devices/{serial}/wireless/latencyStats',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'wireless');
      const { t0, t1 } = statsWindow(ctx);
      return { serial: dev.serial, latencyStats: latencyStats([dev], t0, t1, ctx.query.get('fields')) };
    },
  },
];
