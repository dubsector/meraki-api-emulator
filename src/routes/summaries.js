// Organization summaries and overviews: the top-N views dashboards open with,
// switch power, uplink and client totals, security events and client search.
// Each reuses the numbers of the routes that already show the same data.

import { APPS, L7_CATEGORIES } from '../catalog.js';
import { clientJson, networkJson } from '../format.js';
import { arrayParam, badRequest, intParam, notFound, paginate, timeWindow } from '../http.js';
import { uplinkStatus } from '../sim/outages.js';
import { isOnline, presenceIn } from '../sim/presence.js';
import { trafficRows } from '../sim/traffic.js';
import { SLOT, WAN_RECV, WAN_SENT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, buckets, clientUsage, networkTotals } from '../sim/usage.js';
import { DAY, HOUR, MIN, iso } from '../time.js';
import { orgOf, round } from './common.js';
import { perfScore } from './devices.js';
import { securityEvents } from './networks.js';
import { byStatus, groupOfNetwork, statusOverview } from './orgnetworks.js';
import { portLoad } from './switch.js';

const MB = 1024;
const TOP = { maxSpan: 186 * DAY };
const quantityOf = (ctx) => intParam(ctx.query, 'quantity', 10, { min: 1, max: 50 });

// Traffic analysis apps by Layer 7 category, falling back to the app's own
// category for apps the Layer 7 list doesn't have.
const CATEGORY = new Map(APPS.map((a) => [a.application, L7_CATEGORIES.find((c) => c.applications.some((x) => x.name === a.application))?.name ?? a.category]));

// The networks a top-N query selects.
function summaryNetworks(ctx, org) {
  const q = ctx.query;
  const networkId = q.get('networkId');
  const networkTag = q.get('networkTag');
  return org.networks.filter((n) => (!networkId || n.id === networkId) && (!networkTag || n.tags.includes(networkTag)));
}

// Devices of one product type in those networks, or every type but cameras,
// sensors and cellular gateways, narrowed by deviceTag.
function summaryDevices(ctx, org, productType) {
  const nets = new Set(summaryNetworks(ctx, org));
  const tag = ctx.query.get('deviceTag');
  return org.devices.filter((d) => nets.has(d.net) && (productType ? d.productType === productType : !['camera', 'sensor', 'cellularGateway'].includes(d.productType)) && (!tag || d.tags.includes(tag)));
}

// KB a device carried over [t0, t1), and the clients it served.
function deviceUsage(dev, t0, t1) {
  const net = dev.net;
  if (dev.productType === 'appliance') {
    const [s, r] = networkTotals(net, t0, t1, [WAN_SENT, WAN_RECV]);
    return { kb: s + r, clients: net.clients };
  }
  const clients =
    dev.productType === 'wireless'
      ? net.clients.filter((c) => c.ap === dev && !c.wired)
      : dev.productType === 'switch'
        ? net.clients.filter((c) => c.switchPort?.switch === dev || c.ap?.switchPort?.switch === dev)
        : [];
  let kb = 0;
  for (const c of clients) {
    const u = clientUsage(c, t0, t1);
    kb += u.sent + u.recv;
  }
  return { kb, clients };
}

// Traffic analysis totals in MB, grouped by keyOf(application), largest first.
function appTotals(ctx, org, t0, t1, keyOf) {
  const totals = new Map();
  for (const n of summaryNetworks(ctx, org)) {
    for (const row of trafficRows(n, t0, t1)) {
      const key = keyOf(row.application);
      const t = totals.get(key) || { key, downstream: 0, upstream: 0 };
      t.downstream += row.recv / MB;
      t.upstream += row.sent / MB;
      totals.set(key, t);
    }
  }
  const rows = [...totals.values()].map((t) => ({ ...t, total: t.downstream + t.upstream }));
  const sum = rows.reduce((a, r) => a + r.total, 0) || 1;
  return rows
    .sort((a, b) => b.total - a.total)
    .slice(0, quantityOf(ctx))
    .map((r) => ({ key: r.key, total: round(r.total, 1), downstream: round(r.downstream, 1), upstream: round(r.upstream, 1), percentage: round((r.total / sum) * 100, 4) }));
}

// Clients that used data in the window, with MB each way, on ssidName if given.
function clientTotals(ctx, org, t0, t1) {
  const ssidName = ctx.query.get('ssidName');
  const rows = [];
  for (const n of summaryNetworks(ctx, org)) {
    for (const c of n.clients) {
      if (ssidName && c.ssid?.name !== ssidName) continue;
      const u = clientUsage(c, t0, t1);
      if (u.sent + u.recv > 0) rows.push({ c, up: u.sent / MB, down: u.recv / MB });
    }
  }
  return rows;
}

// PoE energy a switch delivered over [t0, t1), in watt hours: the same
// numbers its port statuses report as powerUsageInWh.
function switchWh(sw, t0, t1) {
  let wh = 0;
  for (const p of sw.ports) if (!p.uplinkPort && p.config?.enabled !== false) wh += portLoad(p, t0, t1).wh;
  return wh;
}

function topApplications(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 25 * MIN });
  return appTotals(ctx, orgOf(ctx), t0, t1, (a) => a).map(({ key, ...r }) => ({ application: key, ...r }));
}

function topCategories(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 25 * MIN });
  return appTotals(ctx, orgOf(ctx), t0, t1, (a) => CATEGORY.get(a)).map(({ key, ...r }) => ({ category: key, ...r }));
}

function topClients(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 8 * HOUR });
  const rows = clientTotals(ctx, orgOf(ctx), t0, t1);
  const sum = rows.reduce((a, r) => a + r.up + r.down, 0) || 1;
  return rows
    .sort((a, b) => b.up + b.down - (a.up + a.down))
    .slice(0, quantityOf(ctx))
    .map(({ c, up, down }) => ({
      name: c.description || c.mac,
      mac: c.mac,
      id: c.id,
      network: { name: c.net.name, id: c.net.id },
      usage: { total: round(up + down, 1), upstream: round(up, 1), downstream: round(down, 1), percentage: round(((up + down) / sum) * 100, 4) },
    }));
}

function topManufacturers(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, TOP);
  const totals = new Map();
  for (const { c, up, down } of clientTotals(ctx, orgOf(ctx), t0, t1)) {
    const t = totals.get(c.manufacturer) || { name: c.manufacturer, clients: 0, up: 0, down: 0 };
    t.clients++;
    t.up += up;
    t.down += down;
    totals.set(c.manufacturer, t);
  }
  return [...totals.values()]
    .sort((a, b) => b.up + b.down - (a.up + a.down))
    .slice(0, quantityOf(ctx))
    .map((t) => ({ name: t.name, clients: { counts: { total: t.clients } }, usage: { total: round(t.up + t.down, 1), upstream: round(t.up, 1), downstream: round(t.down, 1) } }));
}

function topDevices(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 8 * HOUR });
  const rows = summaryDevices(ctx, orgOf(ctx)).map((d) => {
    const u = deviceUsage(d, t0, t1);
    const seen = u.clients.filter((c) => presenceIn(c, t0, t1)).length;
    return { d, mb: u.kb / MB, seen };
  });
  const sum = rows.reduce((a, r) => a + r.mb, 0) || 1;
  return rows
    .sort((a, b) => b.mb - a.mb)
    .slice(0, quantityOf(ctx))
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
}

function topModels(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 8 * HOUR });
  const totals = new Map();
  for (const d of summaryDevices(ctx, orgOf(ctx))) {
    const t = totals.get(d.model) || { model: d.model, count: 0, mb: 0 };
    t.count++;
    t.mb += deviceUsage(d, t0, t1).kb / MB;
    totals.set(d.model, t);
  }
  return [...totals.values()]
    .sort((a, b) => b.mb - a.mb || (a.model < b.model ? -1 : 1))
    .slice(0, quantityOf(ctx))
    .map((t) => ({ model: t.model, count: t.count, usage: { total: round(t.mb, 1), average: round(t.mb / t.count, 1) } }));
}

function topAppliances(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 25 * MIN });
  return summaryDevices(ctx, orgOf(ctx), 'appliance')
    .map((d) => ({ d, score: perfScore(d, t0, t1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, quantityOf(ctx))
    .map(({ d, score }) => ({ network: { name: d.net.name, id: d.net.id }, name: d.name, mac: d.mac, serial: d.serial, model: d.model, utilization: { average: { percentage: score } } }));
}

function topSwitches(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { ...TOP, minSpan: 25 * MIN });
  return summaryDevices(ctx, orgOf(ctx), 'switch')
    .map((d) => ({ d, joules: switchWh(d, t0, t1) * HOUR }))
    .sort((a, b) => b.joules - a.joules)
    .slice(0, quantityOf(ctx))
    .map(({ d, joules }) => ({ network: { name: d.net.name, id: d.net.id }, name: d.name, mac: d.mac, model: d.model, usage: { total: round(joules, 3) } }));
}

function topNetworks(ctx) {
  const org = orgOf(ctx);
  const rows = summaryNetworks(ctx, org)
    .map((n) => {
      const { clients, statuses, productTypes } = statusOverview([n], ctx.now);
      const group = groupOfNetwork(org, n.id);
      return {
        networkId: n.id,
        name: n.name,
        url: n.url,
        tags: n.tags,
        group: group ? { id: group.groupId } : null,
        clients,
        statuses,
        devices: { byProductType: productTypes.map((productType) => ({ productType, url: n.url.replace('/usage/list', '/nodes/new_list/000000000000') })) },
        permissions: { canWrite: true },
        productTypes: n.productTypes,
      };
    })
    .sort(byStatus)
    .slice(0, quantityOf(ctx));
  return paginate(ctx, rows, (r) => r.networkId, { def: 5000, max: 5000 });
}

// 20 minute intervals up to a day, 4 hours up to two weeks, then days.
function powerHistory(ctx) {
  const org = orgOf(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, TOP);
  const span = t1 - t0;
  const res = span <= DAY ? 20 * MIN : span <= 14 * DAY ? 4 * HOUR : DAY;
  const switches = org.devices.filter((d) => d.productType === 'switch');
  return buckets(t0, t1, res)
    .map(([s, e]) => {
      const a = Math.max(s, t0);
      const b = Math.min(e, t1);
      let wh = 0;
      for (const sw of switches) wh += switchWh(sw, a, b);
      return { ts: iso(s), draw: round(wh / ((b - a) / HOUR), 4) };
    })
    .reverse();
}

// Network client totals over the same intervals the network history uses,
// then hourly up to 31 days and daily beyond.
function bandwidthHistory(ctx) {
  const org = orgOf(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, TOP);
  const span = t1 - t0;
  const res = span <= DAY ? SLOT : span <= 31 * DAY ? HOUR : DAY;
  const nets = summaryNetworks(ctx, org);
  return buckets(t0, t1, res).map(([s, e]) => {
    const a = Math.max(s, t0);
    const b = Math.min(e, t1);
    let up = 0;
    let down = 0;
    for (const n of nets) {
      const [ws, wr, ds, dr] = networkTotals(n, a, b, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
      up += ws + ds;
      down += wr + dr;
    }
    // Whole Mbps, as the spec types them.
    const mbps = (kb) => Math.round((kb * 8) / 1000 / (b - a));
    return { ts: iso(s), total: mbps(up + down), upstream: mbps(up), downstream: mbps(down) };
  });
}

const UPLINK_STATUS = { active: 'active', ready: 'ready', failed: 'failed', 'not connected': 'notConnected' };

function uplinksOverview(ctx) {
  const org = orgOf(ctx);
  const networkIds = arrayParam(ctx.query, 'networkIds');
  // The sim has no uplinks that are still connecting.
  const counts = { active: 0, ready: 0, failed: 0, connecting: 0, notConnected: 0 };
  for (const n of org.networks) {
    if (!n.mx || (networkIds.length && !networkIds.includes(n.id))) continue;
    for (const u of n.mx.uplinks) counts[UPLINK_STATUS[uplinkStatus(n.mx, u, ctx.now)]]++;
  }
  return { counts: { byStatus: counts } };
}

// A client lives in one network, so a MAC finds at most one record.
function searchClients(ctx) {
  const org = orgOf(ctx);
  const mac = ctx.query.get('mac')?.toLowerCase();
  if (!mac) throw badRequest("'mac' is required");
  const found = org.networks.flatMap((n) => n.clients.filter((c) => c.mac === mac));
  if (!found.length) throw notFound('Client');
  const records = found.map((c) => {
    const p = presenceIn(c, ctx.now - 31 * DAY, ctx.now);
    const j = clientJson(c, { usage: { sent: 0, recv: 0 }, last: p ? p.last : c.firstSeen, online: isOnline(c, ctx.now) });
    return {
      network: networkJson(c.net),
      ip: j.ip,
      ip6: j.ip6,
      description: j.description,
      firstSeen: j.firstSeen,
      lastSeen: j.lastSeen,
      os: j.os,
      user: j.user,
      vlan: j.vlan,
      ssid: j.ssid,
      switchport: j.switchport,
      wirelessCapabilities: j.wirelessCapabilities,
      smInstalled: j.smInstalled,
      recentDeviceMac: j.recentDeviceMac,
      clientVpnConnections: null,
      lldp: null,
      cdp: null,
      status: j.status,
    };
  });
  const [c] = found;
  return { clientId: c.id, mac: c.mac, manufacturer: c.manufacturer, records: paginate(ctx, records, (r) => r.network.id, { def: 5, max: 5 }) };
}

const ORG = '/organizations/{organizationId}';

export default [
  { op: 'getOrganizationSummaryTopApplicationsByUsage', path: `${ORG}/summary/top/applications/byUsage`, handler: topApplications },
  { op: 'getOrganizationSummaryTopClientsByUsage', path: `${ORG}/summary/top/clients/byUsage`, handler: topClients },
  { op: 'getOrganizationSummaryTopDevicesByUsage', path: `${ORG}/summary/top/devices/byUsage`, handler: topDevices },
  { op: 'getOrganizationSummaryTopAppliancesByUtilization', path: `${ORG}/summary/top/appliances/byUtilization`, handler: topAppliances },
  { op: 'getOrganizationSummaryTopApplicationsCategoriesByUsage', path: `${ORG}/summary/top/applications/categories/byUsage`, handler: topCategories },
  { op: 'getOrganizationSummaryTopClientsManufacturersByUsage', path: `${ORG}/summary/top/clients/manufacturers/byUsage`, handler: topManufacturers },
  { op: 'getOrganizationSummaryTopDevicesModelsByUsage', path: `${ORG}/summary/top/devices/models/byUsage`, handler: topModels },
  { op: 'getOrganizationSummaryTopNetworksByStatus', path: `${ORG}/summary/top/networks/byStatus`, handler: topNetworks },
  { op: 'getOrganizationSummaryTopSwitchesByEnergyUsage', path: `${ORG}/summary/top/switches/byEnergyUsage`, handler: topSwitches },
  { op: 'getOrganizationSummarySwitchPowerHistory', path: `${ORG}/summary/switch/power/history`, handler: powerHistory },
  { op: 'getOrganizationClientsBandwidthUsageHistory', path: `${ORG}/clients/bandwidthUsageHistory`, handler: bandwidthHistory },
  { op: 'getOrganizationApplianceUplinksStatusesOverview', path: `${ORG}/appliance/uplinks/statuses/overview`, handler: uplinksOverview },
  {
    op: 'getOrganizationApplianceSecurityEvents',
    path: `${ORG}/appliance/security/events`,
    handler: (ctx) => securityEvents(ctx, orgOf(ctx).networks.filter((n) => n.mx), 365 * DAY),
  },
  {
    op: 'getOrganizationClientsSearch',
    path: `${ORG}/clients/search`,
    sample: { query: (world) => `mac=${encodeURIComponent(world.orgs[0].networks[0].clients[0].mac)}` },
    handler: searchClients,
  },
];
