import { exportedSubnets } from '../config.js';
import { deviceJson, networkJson, networkRef, orgJson } from '../format.js';
import { arrayParam, hasTags, intParam, paginate, timeWindow } from '../http.js';
import { linkAverage, linkSample, pathLatency, vpnReachable } from '../sim/links.js';
import { deviceStatus, lastReportedAt, statusChanges, uplinkStatus } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { trafficRows, uplinkBytes } from '../sim/traffic.js';
import { WAN_RECV, WAN_SENT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, clientUsage, networkTotals } from '../sim/usage.js';
import { DAY, HOUR, MIN, iso, isoMicro } from '../time.js';
import { byId, bySerial, filterDevices, orgOf, round } from './common.js';

const MB = 1024;

function uplinkJson(mx, u, now) {
  return {
    interface: u.interface,
    status: uplinkStatus(mx, u, now),
    ip: u.publicIp,
    gateway: u.gateway,
    publicIp: u.publicIp,
    primaryDns: '8.8.8.8',
    secondaryDns: '1.1.1.1',
    ipAssignedBy: u.isp === 'fiber' ? 'static' : 'dhcp',
  };
}

function uplinkStatuses(ctx) {
  const org = orgOf(ctx);
  const networkIds = arrayParam(ctx.query, 'networkIds');
  const serials = arrayParam(ctx.query, 'serials');
  const rows = org.networks
    .filter((n) => n.mx && (!networkIds.length || networkIds.includes(n.id)) && (!serials.length || serials.includes(n.mx.serial)))
    .map((n) => ({
      networkId: n.id,
      serial: n.mx.serial,
      model: n.mx.model,
      lastReportedAt: iso(lastReportedAt(n.mx, ctx.now)),
      highAvailability: { enabled: false, role: 'primary' },
      uplinks: n.mx.uplinks.map((u) => uplinkJson(n.mx, u, ctx.now)),
    }))
    .sort((a, b) => (a.serial < b.serial ? -1 : 1));
  return paginate(ctx, rows, (r) => r.serial, { def: 1000, max: 1000 });
}

function vpnPeers(net) {
  if (!net.mx || !net.org.hub) return [];
  return net.vpn === 'hub' ? net.org.networks.filter((n) => n.vpn === 'spoke') : [net.org.hub];
}

function vpnPeerStats(local, peer, t0, t1) {
  const spoke = local.vpn === 'spoke' ? local : peer;
  const [s, r] = networkTotals(spoke, t0, t1, [WAN_SENT, WAN_RECV]);
  const toHub = s * 0.08;
  const fromHub = r * 0.08;
  const a = linkAverage(local.mx, local.mx.uplinks[0], t0, t1) || { latencyMs: 0, lossPercent: 0, jitter: 0 };
  const b = linkAverage(peer.mx, peer.mx.uplinks[0], t0, t1) || { latencyMs: 0, lossPercent: 0, jitter: 0 };
  const base = pathLatency(local, peer);
  const lat = base + ((a.latencyMs ?? 0) + (b.latencyMs ?? 0)) / 2;
  const loss = Math.min(100, (a.lossPercent + b.lossPercent) / 2);
  const jitter = ((a.jitter ?? 0) + (b.jitter ?? 0)) / 2;
  const mos = Math.max(1, Math.min(4.4, 4.4 - lat / 250 - loss * 0.12));
  const pair = { senderUplink: 'wan1', receiverUplink: 'wan1' };
  return {
    networkId: peer.id,
    networkName: peer.name,
    usageSummary: {
      receivedInKilobytes: Math.round(local === spoke ? fromHub : toHub),
      sentInKilobytes: Math.round(local === spoke ? toHub : fromHub),
    },
    latencySummaries: [{ ...pair, avgLatencyMs: round(lat, 1), minLatencyMs: round(base * 0.97, 1), maxLatencyMs: round(lat * 2.2 + 25, 1) }],
    lossPercentageSummaries: [{ ...pair, avgLossPercentage: round(loss, 2), minLossPercentage: 0, maxLossPercentage: round(Math.max(0.5, loss * 6), 2) }],
    jitterSummaries: [{ ...pair, avgJitter: round(jitter, 2), minJitter: round(jitter * 0.2, 2), maxJitter: round(jitter * 4 + 2, 2) }],
    mosSummaries: [{ ...pair, avgMos: round(mos, 1), minMos: round(Math.max(1, mos - 0.6), 1), maxMos: round(Math.min(4.5, mos + 0.1), 1) }],
  };
}

// Usage in MB for top-N summaries, over the networks a query selects.
function summaryNetworks(ctx, org) {
  const q = ctx.query;
  const networkId = q.get('networkId');
  const networkTag = q.get('networkTag');
  return org.networks.filter((n) => (!networkId || n.id === networkId) && (!networkTag || n.tags.includes(networkTag)));
}

function deviceUsage(dev, t0, t1) {
  const net = dev.net;
  if (dev.productType === 'appliance') {
    const [s, r] = networkTotals(net, t0, t1, [WAN_SENT, WAN_RECV]);
    return { kb: s + r, clients: net.clients };
  }
  if (dev.productType === 'wireless') {
    const clients = net.clients.filter((c) => c.ap === dev && !c.wired);
    let kb = 0;
    for (const c of clients) {
      const u = clientUsage(c, t0, t1);
      kb += u.sent + u.recv;
    }
    return { kb, clients };
  }
  if (dev.productType === 'switch') {
    const clients = net.clients.filter((c) => c.switchPort?.switch === dev || (c.ap?.switchPort?.switch === dev));
    let kb = 0;
    for (const c of clients) {
      const u = clientUsage(c, t0, t1);
      kb += u.sent + u.recv;
    }
    return { kb, clients };
  }
  return { kb: 0, clients: [] };
}

export default [
  {
    op: 'getOrganizations',
    path: '/organizations',
    handler: (ctx) => paginate(ctx, [...ctx.world.orgs].sort(byId).map(orgJson), (o) => o.id, { def: 9000, max: 9000 }),
  },
  {
    op: 'getOrganization',
    path: '/organizations/{organizationId}',
    handler: (ctx) => orgJson(orgOf(ctx)),
  },
  {
    op: 'getOrganizationNetworks',
    path: '/organizations/{organizationId}/networks',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const q = ctx.query;
      const tags = arrayParam(q, 'tags');
      const productTypes = arrayParam(q, 'productTypes');
      const mode = q.get('tagsFilterType') || 'withAnyTags';
      const bound = q.get('isBoundToConfigTemplate');
      const rows = org.networks
        .filter((n) => bound !== 'true' && !q.get('configTemplateId'))
        .filter((n) => hasTags(n.tags, tags, mode) && (!productTypes.length || productTypes.some((p) => n.productTypes.includes(p))))
        .sort(byId)
        .map(networkJson);
      return paginate(ctx, rows, (n) => n.id, { def: 1000, max: 100000 });
    },
  },
  {
    op: 'getOrganizationDevices',
    path: '/organizations/{organizationId}/devices',
    handler: (ctx) => {
      const rows = filterDevices(ctx.query, orgOf(ctx).devices).sort(bySerial).map((d) => deviceJson(d));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 5000 });
    },
  },
  {
    op: 'getOrganizationDevicesStatuses',
    path: '/organizations/{organizationId}/devices/statuses',
    handler: (ctx) => {
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .sort(bySerial)
        .map((d) => {
          const status = deviceStatus(d, ctx.now);
          const mx = d.net.mx;
          const out = {
            name: d.name,
            serial: d.serial,
            mac: d.mac,
            publicIp: mx ? mx.uplinks[0].publicIp : `192.0.2.${40 + d.net.siteIndex}`,
            networkId: d.net.id,
            status,
            lastReportedAt: iso(lastReportedAt(d, ctx.now)),
            lanIp: d.lanIp ?? null,
            gateway: d.productType === 'appliance' ? d.uplinks[0].gateway : `${d.net.subnet(1)}.1`,
            ipType: d.productType === 'appliance' ? 'static' : 'dhcp',
            primaryDns: d.productType === 'appliance' ? '8.8.8.8' : `${d.net.subnet(1)}.1`,
            secondaryDns: '8.8.4.4',
            productType: d.productType,
            model: d.model,
            tags: d.tags,
          };
          if (d.info.psus) {
            out.components = {
              powerSupplies: [1, 2].map((slot) => ({ slot, serial: `${d.serial.slice(0, 4)}-PSU${slot}`, model: 'PWR-C6-600WAC', status: status === 'offline' ? 'not powering' : 'powering', poe: { unit: 'watts', maximum: 740 } })),
            };
          }
          return out;
        })
        .filter((d) => !statuses.length || statuses.includes(d.status));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesStatusesOverview',
    path: '/organizations/{organizationId}/devices/statuses/overview',
    handler: (ctx) => {
      const byStatus = { online: 0, alerting: 0, offline: 0, dormant: 0 };
      for (const d of filterDevices(ctx.query, orgOf(ctx).devices)) byStatus[deviceStatus(d, ctx.now)]++;
      return { counts: { byStatus } };
    },
  },
  {
    op: 'getOrganizationDevicesAvailabilities',
    path: '/organizations/{organizationId}/devices/availabilities',
    handler: (ctx) => {
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .sort(bySerial)
        .map((d) => ({ mac: d.mac, name: d.name, network: { id: d.net.id }, productType: d.productType, serial: d.serial, status: deviceStatus(d, ctx.now), tags: d.tags }))
        .filter((d) => !statuses.length || statuses.includes(d.status));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesAvailabilitiesChangeHistory',
    path: '/organizations/{organizationId}/devices/availabilities/changeHistory',
    handler: (ctx) => {
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = [];
      for (const d of filterDevices(ctx.query, orgOf(ctx).devices)) {
        for (const ch of statusChanges(d, t0, t1, ctx.now)) {
          if (statuses.length && !statuses.includes(ch.to)) continue;
          rows.push({
            ts: isoMicro(ch.ts),
            device: { serial: d.serial, name: d.name, productType: d.productType, model: d.model },
            details: { old: [{ name: 'status', value: ch.from }], new: [{ name: 'status', value: ch.to }] },
            network: networkRef(d.net),
          });
        }
      }
      rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      return paginate(ctx, rows, (r) => `${r.ts}_${r.device.serial}`, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationApplianceUplinkStatuses',
    path: '/organizations/{organizationId}/appliance/uplink/statuses',
    handler: uplinkStatuses,
  },
  {
    op: 'getOrganizationUplinksStatuses',
    path: '/organizations/{organizationId}/uplinks/statuses',
    handler: uplinkStatuses,
  },
  {
    op: 'getOrganizationApplianceVpnStatuses',
    path: '/organizations/{organizationId}/appliance/vpn/statuses',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const networkIds = arrayParam(ctx.query, 'networkIds');
      const rows = org.networks
        .filter((n) => n.mx && org.hub && (!networkIds.length || networkIds.includes(n.id)))
        .map((n) => ({
          networkId: n.id,
          networkName: n.name,
          deviceSerial: n.mx.serial,
          deviceStatus: deviceStatus(n.mx, ctx.now),
          uplinks: n.mx.uplinks.map((u) => ({ interface: u.interface, publicIp: u.publicIp })),
          vpnMode: n.vpn,
          exportedSubnets: exportedSubnets(n),
          merakiVpnPeers: vpnPeers(n).map((p) => ({ networkId: p.id, networkName: p.name, reachability: vpnReachable(n, p, ctx.now) ? 'reachable' : 'unreachable' })),
          thirdPartyVpnPeers: n.vpn === 'hub' ? [{ name: 'Cloud VPC', publicIp: '192.0.2.200', reachability: 'reachable' }] : [],
        }))
        .sort(byId);
      return paginate(ctx, rows, (r) => r.networkId, { def: 300, max: 300 });
    },
  },
  {
    op: 'getOrganizationApplianceVpnStats',
    path: '/organizations/{organizationId}/appliance/vpn/stats',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
      const networkIds = arrayParam(ctx.query, 'networkIds');
      const rows = org.networks
        .filter((n) => n.mx && org.hub && (!networkIds.length || networkIds.includes(n.id)))
        .sort(byId)
        .map((n) => ({ networkId: n.id, networkName: n.name, merakiVpnPeers: vpnPeers(n).map((p) => vpnPeerStats(n, p, t0, t1)) }));
      return paginate(ctx, rows, (r) => r.networkId, { def: 300, max: 300 });
    },
  },
  {
    op: 'getOrganizationDevicesUplinksLossAndLatency',
    path: '/organizations/{organizationId}/devices/uplinksLossAndLatency',
    handler: (ctx) => {
      const org = orgOf(ctx);
      // The newest sample Meraki serves is two minutes old.
      const latest = Math.floor((ctx.now - 2 * MIN) / MIN) * MIN;
      const { t0, t1 } = timeWindow(ctx.query, latest, { maxSpan: 300, defaultSpan: 300, lookback: 60 * DAY });
      const uplink = ctx.query.get('uplink');
      const ip = ctx.query.get('ip') || '8.8.8.8';
      const rows = [];
      for (const n of org.networks) {
        if (!n.mx) continue;
        for (const u of n.mx.uplinks) {
          if (uplink && u.interface !== uplink) continue;
          const timeSeries = [];
          for (let t = Math.ceil(t0 / MIN) * MIN; t < t1; t += MIN) {
            const s = linkSample(n.mx, u, t, ip);
            timeSeries.push({ ts: iso(t), lossPercent: s.lossPercent, latencyMs: s.latencyMs });
          }
          rows.push({ networkId: n.id, serial: n.mx.serial, uplink: u.interface, ip, timeSeries });
        }
      }
      return rows;
    },
  },
  {
    op: 'getOrganizationApplianceUplinksUsageByNetwork',
    path: '/organizations/{organizationId}/appliance/uplinks/usage/byNetwork',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, lookback: 30 * DAY });
      return org.networks
        .filter((n) => n.mx)
        .map((n) => {
          const bytes = uplinkBytes(n, t0, t1);
          return { networkId: n.id, name: n.name, byUplink: n.mx.uplinks.map((u) => ({ serial: n.mx.serial, interface: u.interface, ...bytes[u.interface] })) };
        });
    },
  },
  {
    op: 'getOrganizationClientsOverview',
    path: '/organizations/{organizationId}/clients/overview',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY });
      let up = 0;
      let down = 0;
      let count = 0;
      for (const n of org.networks) {
        const [ws, wr, ds, dr] = networkTotals(n, t0, t1, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
        up += ws + ds;
        down += wr + dr;
        for (const c of n.clients) if (presenceIn(c, t0, t1)) count++;
      }
      const total = Math.round(up + down);
      return { usage: { overall: { total, downstream: Math.round(down), upstream: Math.round(up) }, average: count ? round(total / count, 2) : 0 }, counts: { total: count } };
    },
  },
  {
    op: 'getOrganizationSummaryTopApplicationsByUsage',
    path: '/organizations/{organizationId}/summary/top/applications/byUsage',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 186 * DAY, minSpan: 25 * MIN });
      const quantity = intParam(ctx.query, 'quantity', 10, { min: 1, max: 50 });
      const totals = new Map();
      for (const n of summaryNetworks(ctx, org)) {
        for (const row of trafficRows(n, t0, t1)) {
          const t = totals.get(row.application) || { application: row.application, downstream: 0, upstream: 0 };
          t.downstream += row.recv / MB;
          t.upstream += row.sent / MB;
          totals.set(row.application, t);
        }
      }
      const rows = [...totals.values()].map((t) => ({ ...t, total: t.downstream + t.upstream }));
      const sum = rows.reduce((a, r) => a + r.total, 0) || 1;
      return rows
        .sort((a, b) => b.total - a.total)
        .slice(0, quantity)
        .map((r) => ({ application: r.application, total: round(r.total, 1), downstream: round(r.downstream, 1), upstream: round(r.upstream, 1), percentage: round((r.total / sum) * 100, 4) }));
    },
  },
  {
    op: 'getOrganizationSummaryTopClientsByUsage',
    path: '/organizations/{organizationId}/summary/top/clients/byUsage',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 186 * DAY, minSpan: 8 * HOUR });
      const quantity = intParam(ctx.query, 'quantity', 10, { min: 1, max: 50 });
      const ssidName = ctx.query.get('ssidName');
      const rows = [];
      for (const n of summaryNetworks(ctx, org)) {
        for (const c of n.clients) {
          if (ssidName && c.ssid?.name !== ssidName) continue;
          const u = clientUsage(c, t0, t1);
          if (u.sent + u.recv > 0) rows.push({ c, up: u.sent / MB, down: u.recv / MB });
        }
      }
      const sum = rows.reduce((a, r) => a + r.up + r.down, 0) || 1;
      return rows
        .sort((a, b) => b.up + b.down - (a.up + a.down))
        .slice(0, quantity)
        .map(({ c, up, down }) => ({
          name: c.description || c.mac,
          mac: c.mac,
          id: c.id,
          network: { name: c.net.name, id: c.net.id },
          usage: { total: round(up + down, 1), upstream: round(up, 1), downstream: round(down, 1), percentage: round(((up + down) / sum) * 100, 4) },
        }));
    },
  },
  {
    op: 'getOrganizationSummaryTopDevicesByUsage',
    path: '/organizations/{organizationId}/summary/top/devices/byUsage',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 186 * DAY, minSpan: 8 * HOUR });
      const quantity = intParam(ctx.query, 'quantity', 10, { min: 1, max: 50 });
      const nets = new Set(summaryNetworks(ctx, org));
      const rows = org.devices
        .filter((d) => nets.has(d.net) && d.productType !== 'camera')
        .map((d) => {
          const u = deviceUsage(d, t0, t1);
          const seen = u.clients.filter((c) => presenceIn(c, t0, t1)).length;
          return { d, mb: u.kb / MB, seen };
        });
      const sum = rows.reduce((a, r) => a + r.mb, 0) || 1;
      return rows
        .sort((a, b) => b.mb - a.mb)
        .slice(0, quantity)
        .map(({ d, mb, seen }) => ({
          name: d.name,
          model: d.model,
          serial: d.serial,
          mac: d.mac,
          productType: d.productType,
          network: { name: d.net.name, id: d.net.id },
          usage: { total: round(mb, 1), percentage: round((mb / sum) * 100, 4) },
          clients: { counts: { total: seen } },
        }));
    },
  },
];

