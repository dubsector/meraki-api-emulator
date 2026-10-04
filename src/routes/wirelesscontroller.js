// Catalyst wireless LAN controller views (sim/wlc.js). Every series reads the
// pair's role and the controllers' outages, so the overview, interfaces, usage,
// CPU and redundancy views agree with each other and with the org device views.

import { arrayParam, badRequest, boolParam, paginateItems, resolutionParam, timeWindow } from '../http.js';
import { statusChanges } from '../sim/outages.js';
import { buckets } from '../sim/usage.js';
import { L2, L3, MODULE, SLOT, activeAt, catalystAps, chassisName, clientsAt, cpuAt, failoversTo, ifaceChanges, ifaceMac, ifaceStatus, isController, isHa, l3Usage, pairOf, peerOf, roleAt, usageBetween } from '../sim/wlc.js';
import { DAY, HOUR, iso } from '../time.js';
import { orgOf, round } from './common.js';

const LAB = { org: 1 };
const PAGE = { def: 1000, max: 1000 };
const MONTH = 31 * DAY;
const RESOLUTIONS = [300, 600, 1200, 3600, 14400, 86400];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Controllers in the organization, by serial, narrowed by networkIds and serials.
function controllers(ctx, { networks = true } = {}) {
  const org = orgOf(ctx);
  const nets = networks ? arrayParam(ctx.query, 'networkIds') : [];
  const serials = arrayParam(ctx.query, 'serials');
  return org.devices
    .filter((d) => isController(d) && d.net && (!nets.length || nets.includes(d.net.id)) && (!serials.length || serials.includes(d.serial)))
    .sort((a, b) => cmp(a.serial, b.serial));
}

const windowOf = (ctx) => timeWindow(ctx.query, ctx.now, { maxSpan: MONTH, defaultSpan: 7 * DAY, lookback: MONTH });

// Interval length for the auto-sized series: five minutes up to a day, then hourly-ish.
const step = (span) => (span <= DAY ? SLOT : span <= 7 * DAY ? 1200 : HOUR);

// Aligned buckets clipped to [t0, t1).
const clipped = (t0, t1, res) => buckets(t0, t1, res).map(([s, e]) => [Math.max(s, t0), Math.min(e, t1)]).filter(([s, e]) => e > s);

// ── Catalyst APs ──

function apRows(ctx) {
  const org = orgOf(ctx);
  const nets = arrayParam(ctx.query, 'networkIds');
  const ctls = arrayParam(ctx.query, 'controllerSerials');
  return org.networks
    .filter((n) => !nets.length || nets.includes(n.id))
    .flatMap((net) => catalystAps(net, ctx.now).map((x) => ({ net, ...x })))
    .filter((x) => !ctls.length || ctls.includes(x.ctl.serial))
    .sort((a, b) => cmp(a.ap.serial, b.ap.serial));
}

function catalystDevices(ctx) {
  const serials = arrayParam(ctx.query, 'serials');
  const rows = apRows(ctx).filter((x) => !serials.length || serials.includes(x.ap.serial));
  return paginateItems(ctx, rows, (x) => x.ap.serial, { def: 100, max: 1000 }, ({ net, ap, ctl }) => ({
    network: { id: net.id },
    serial: ap.serial,
    controller: { serial: ctl.serial },
    joinedAt: iso(ap.joinedAt),
    model: ap.model,
    tags: [{ ...ap.tags }],
    mode: ap.mode,
    countryCode: ap.countryCode,
    details: [
      { name: 'catalyst serial', value: ap.catalystSerial },
      { name: 'name', value: ap.name },
    ],
  }));
}

function connections(ctx) {
  return paginateItems(ctx, apRows(ctx), (x) => x.ap.serial, PAGE, ({ net, ap, ctl }) => ({
    serial: ap.serial,
    controller: { serial: ctl.serial },
    network: { id: net.id, url: net.url, name: net.name },
  }));
}

// ── Overview and redundancy ──

function overview(ctx) {
  return paginateItems(ctx, controllers(ctx), (d) => d.serial, PAGE, (d) => {
    const s = pairOf(d);
    const aps = catalystAps(d.net, ctx.now).filter((x) => x.ctl === d);
    const online = roleAt(d, ctx.now) === 'Active' ? aps.length : 0;
    const peer = peerOf(d);
    return {
      serial: d.serial,
      network: { id: d.net.id },
      counts: {
        // The latest five-minute slot, the one ending now.
        clients: { byStatus: { online: clientsAt(d, ctx.now - 1) } },
        connections: { total: aps.length, byStatus: { online, offline: aps.length - online } },
      },
      redundancy: {
        role: roleAt(d, ctx.now),
        id: peer ? s.id : null,
        chassisName: peer ? chassisName(s, d) : 'Chassis 1',
        redundantSerial: peer?.serial ?? null,
        management: { addresses: d.lanIp ? [{ address: d.lanIp }] : [] },
      },
      firmware: { version: { shortName: 'ios-xe' } },
    };
  });
}

function redundancyStatuses(ctx) {
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => {
    const s = pairOf(d);
    const done = s ? failoversTo(d.net, s, ctx.now) : [];
    const last = done.at(-1);
    return {
      serial: d.serial,
      mode: 'SSO',
      enabled: !!s && isHa(d.net, s),
      failover: { last: last ? { ts: iso(last.ts), reason: last.reason } : null, counts: { total: done.length } },
      mobilityMac: s ? s.mobilityMac : d.mac,
    };
  });
}

// Failovers in the window, newest first, under the unit that took over.
function failoverHistory(ctx) {
  const { t0, t1 } = windowOf(ctx);
  const serials = arrayParam(ctx.query, 'serials');
  const org = orgOf(ctx);
  const rows = [];
  for (const net of org.networks) {
    const s = net.wirelessControllers;
    if (!s) continue;
    for (const f of failoversTo(net, s, t1)) {
      if (f.ts < t0) continue;
      const active = activeAt(net, s, f.ts);
      const failed = s.members.find((m) => m !== active);
      if (serials.length && !serials.includes(active.serial)) continue;
      rows.push({ serial: active.serial, ts: iso(f.ts), reason: f.reason, failed: { chassis: { name: chassisName(s, failed) } }, active: { chassis: { name: chassisName(s, active) } } });
    }
  }
  rows.sort((a, b) => cmp(b.ts, a.ts) || cmp(a.serial, b.serial));
  return [paginateItems(ctx, rows, (r) => `${r.serial}_${r.ts}`, PAGE)];
}

// Status intervals from statusChanges. An SSO pair lists only the active unit,
// from its last switchover; the open interval has no end.
function availabilities(ctx) {
  const { t0, t1 } = windowOf(ctx);
  const rows = controllers(ctx, { networks: false }).filter((d) => {
    const s = pairOf(d);
    return !s || !isHa(d.net, s) || activeAt(d.net, s, ctx.now) === d;
  });
  return paginateItems(ctx, rows, (d) => d.serial, PAGE, (d) => {
    const s = pairOf(d);
    const last = s ? failoversTo(d.net, s, t1).at(-1) : null;
    const from = Math.max(t0, last?.ts ?? t0);
    const changes = [];
    let start = from;
    let status = roleAt(d, from) === 'Offline' ? 'offline' : 'online';
    for (const c of statusChanges(d, from, t1, ctx.now)) {
      if (c.ts > start) changes.push({ startTs: iso(start), endTs: iso(c.ts), status });
      start = c.ts;
      status = c.to === 'offline' ? 'offline' : 'online';
    }
    changes.push({ startTs: iso(start), endTs: t1 >= ctx.now ? null : iso(t1), status });
    return { serial: d.serial, changes };
  });
}

// ── Clients ──

// The most clients online in any five-minute slot of each interval.
function clientsHistory(ctx) {
  const { t0, t1 } = windowOf(ctx);
  const res = resolutionParam(ctx.query, RESOLUTIONS, DAY, t1 - t0);
  return paginateItems(ctx, controllers(ctx), (d) => d.serial, PAGE, (d) => ({
    serial: d.serial,
    network: { id: d.net.id },
    readings: clipped(t0, t1, res).map(([s, e]) => {
      let online = 0;
      for (let t = Math.floor(s / SLOT) * SLOT; t < e; t += SLOT) online = Math.max(online, clientsAt(d, t));
      return { startTs: iso(s), endTs: iso(e), counts: { byStatus: { online } } };
    }),
  }));
}

// ── Interfaces ──

const channel = (x) => (x.channel ? { number: x.channel } : null);

function l2Json(d, t) {
  return L2.map((x, i) => ({
    name: x.name,
    description: x.description,
    enabled: x.enabled,
    mac: ifaceMac(d, i),
    status: ifaceStatus(d, x, t),
    speed: x.speed,
    isUplink: x.isUplink,
    vlan: x.vlan,
    isRedundancyPort: !!x.redundancy,
    linkNegotiation: 'auto',
    channelGroup: channel(x),
    module: { model: MODULE },
  }));
}

function l3Json(d, t) {
  const up = (x) => (x.unplugged ? 'disconnected' : ifaceStatus(d, L2[0], t));
  return L3.map((x, i) => ({
    name: x.name,
    description: x.description,
    mac: ifaceMac(d, L2.length + i),
    status: up(x),
    speed: x.speed,
    addresses: x.name === 'Vlan1' && d.lanIp ? [{ protocol: 'ipv4', address: d.lanIp, subnet: `${d.lanIp.replace(/\.\d+$/, '.0')}/24` }] : [],
    vrf: { name: x.vrf },
    isUplink: x.isUplink,
    vlan: x.vlan,
    linkNegotiation: 'auto',
    channelGroup: null,
    module: { model: MODULE },
  }));
}

// Interfaces as they stood at the end of the window.
const interfacesAt = (json) => (ctx) => {
  const { t1 } = windowOf(ctx);
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => ({ serial: d.serial, interfaces: json(d, t1) }));
};

// Status changes in the window; interfaces without any are left out unless asked for.
const statusHistory = (layer) => (ctx) => {
  const { t0, t1 } = windowOf(ctx);
  const all = boolParam(ctx.query, 'includeInterfacesWithoutChanges');
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => {
    const ifaces = layer === 2 ? L2.map((x, i) => ({ x, mac: ifaceMac(d, i) })) : L3.map((x, i) => ({ x: x.unplugged ? x : { ...L2[0], name: x.name }, name: x.name, mac: ifaceMac(d, L2.length + i) }));
    const rows = ifaces.map(({ x, name, mac }) => ({ name: name ?? x.name, mac, changes: ifaceChanges(d, x, t0, t1).map((c) => ({ ts: iso(c.ts), status: c.status, warnings: [], errors: [] })) }));
    return { serial: d.serial, interfaces: all ? rows : rows.filter((r) => r.changes.length) };
  });
};

// Bytes each interface received and sent over the window.
const usageTotals = (layer) => (ctx) => {
  const { t0, t1 } = windowOf(ctx);
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => {
    const l2 = usageBetween(d, t0, t1);
    const [list, bytes, base] = layer === 2 ? [L2, l2, 0] : [L3, l3Usage(l2), L2.length];
    return { serial: d.serial, readings: list.map((x, i) => ({ name: x.name, mac: ifaceMac(d, base + i), recv: Math.round(bytes[i][0]), send: Math.round(bytes[i][1]) })) };
  });
};

// Layer 2 interfaces named by the names filter, refusing names a C9800 lacks.
function namedPorts(ctx) {
  const names = arrayParam(ctx.query, 'names');
  const unknown = names.find((n) => !L2.some((x) => x.name === n));
  if (unknown) throw badRequest(`'names' has an unknown interface '${unknown}'`);
  return L2.map((x, i) => ({ x, i })).filter(({ x }) => !names.length || names.includes(x.name));
}

const bps = (bytes, secs) => Math.round((bytes * 8) / secs);

function usageHistory(ctx) {
  const { t0, t1 } = windowOf(ctx);
  const ports = namedPorts(ctx);
  const res = step(t1 - t0);
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => ({
    serial: d.serial,
    intervals: clipped(t0, t1, res).map(([s, e]) => {
      const u = usageBetween(d, s, e);
      const by = ports.map(({ x, i }) => ({ name: x.name, usage: { total: bps(u[i][0] + u[i][1], e - s), recv: bps(u[i][0], e - s), send: bps(u[i][1], e - s) } }));
      const sum = (k) => by.reduce((n, b) => n + b.usage[k], 0);
      return { startTs: iso(s), endTs: iso(e), overall: { total: sum('total'), recv: sum('recv'), send: sum('send') }, byInterface: by };
    }),
  }));
}

// Data packets from the bytes at about 900 bytes each, plus broadcast and
// multicast (ARP, mDNS, CAPWAP discovery) while the link is up.
const PACKET_BYTES = 900;
function packets(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: DAY, defaultSpan: HOUR, lookback: DAY });
  const ports = namedPorts(ctx);
  const secs = t1 - t0;
  const row = (name, r, s) => {
    const recv = Math.round(r);
    const send = Math.round(s);
    return { name, total: recv + send, recv, send, rate: { total: Math.round((recv + send) / secs), recv: Math.round(recv / secs), send: Math.round(send / secs) } };
  };
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => {
    const u = usageBetween(d, t0, t1);
    return {
      serial: d.serial,
      interfaces: ports.map(({ x, i }) => {
        const [r, s] = u[i];
        const live = r + s > 0;
        const bcast = live ? [secs * 1.2, secs * 0.2] : [0, 0];
        const mcast = live ? [secs * 2.5, secs * 0.8] : [0, 0];
        const uni = [r / PACKET_BYTES, s / PACKET_BYTES];
        return { name: x.name, readings: [row('Total', uni[0] + bcast[0] + mcast[0], uni[1] + bcast[1] + mcast[1]), row('Unicast', ...uni), row('Broadcast', ...bcast), row('Multicast', ...mcast)] };
      }),
    };
  });
}

// ── CPU ──

// Average per-core and overall CPU over each interval, leaving out intervals
// the controller was down for.
function utilization(ctx) {
  const { t0, t1 } = windowOf(ctx);
  const res = step(t1 - t0);
  return paginateItems(ctx, controllers(ctx, { networks: false }), (d) => d.serial, PAGE, (d) => {
    const intervals = [];
    for (const [s, e] of clipped(t0, t1, res)) {
      const sums = [];
      let n = 0;
      for (let t = Math.floor(s / SLOT) * SLOT; t < e; t += SLOT) {
        const cores = cpuAt(d, t);
        if (!cores) continue;
        cores.forEach((v, c) => (sums[c] = (sums[c] ?? 0) + v));
        n++;
      }
      if (!n) continue;
      const byCore = sums.map((v, c) => ({ name: String(c), usage: { average: { percentage: round(v / n, 2) } } }));
      const overall = round(sums.reduce((a, v) => a + v, 0) / n / sums.length, 2);
      intervals.push({ startTs: iso(s), endTs: iso(e), overall: { usage: { average: { percentage: overall } } }, byCore });
    }
    return { serial: d.serial, intervals };
  });
}

const ORG = '/organizations/{organizationId}/wirelessController';

export default [
  { op: 'getOrganizationWirelessDevicesWirelessControllersByDevice', path: '/organizations/{organizationId}/wireless/devices/wirelessControllers/byDevice', sample: LAB, handler: catalystDevices },
  { op: 'getOrganizationWirelessControllerAvailabilitiesChangeHistory', path: `${ORG}/availabilities/changeHistory`, sample: LAB, handler: availabilities },
  { op: 'getOrganizationWirelessControllerClientsOverviewHistoryByDeviceByInterval', path: `${ORG}/clients/overview/history/byDevice/byInterval`, sample: LAB, handler: clientsHistory },
  { op: 'getOrganizationWirelessControllerConnections', path: `${ORG}/connections`, sample: LAB, handler: connections },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL2ByDevice', path: `${ORG}/devices/interfaces/l2/byDevice`, sample: LAB, handler: interfacesAt(l2Json) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL2StatusesChangeHistoryByDevice', path: `${ORG}/devices/interfaces/l2/statuses/changeHistory/byDevice`, sample: LAB, handler: statusHistory(2) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL2UsageHistoryByInterval', path: `${ORG}/devices/interfaces/l2/usage/history/byInterval`, sample: LAB, handler: usageTotals(2) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL3ByDevice', path: `${ORG}/devices/interfaces/l3/byDevice`, sample: LAB, handler: interfacesAt(l3Json) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL3StatusesChangeHistoryByDevice', path: `${ORG}/devices/interfaces/l3/statuses/changeHistory/byDevice`, sample: LAB, handler: statusHistory(3) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesL3UsageHistoryByInterval', path: `${ORG}/devices/interfaces/l3/usage/history/byInterval`, sample: LAB, handler: usageTotals(3) },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesPacketsOverviewByDevice', path: `${ORG}/devices/interfaces/packets/overview/byDevice`, sample: LAB, handler: packets },
  { op: 'getOrganizationWirelessControllerDevicesInterfacesUsageHistoryByInterval', path: `${ORG}/devices/interfaces/usage/history/byInterval`, sample: LAB, handler: usageHistory },
  { op: 'getOrganizationWirelessControllerDevicesRedundancyFailoverHistory', path: `${ORG}/devices/redundancy/failover/history`, sample: LAB, handler: failoverHistory },
  { op: 'getOrganizationWirelessControllerDevicesRedundancyStatuses', path: `${ORG}/devices/redundancy/statuses`, sample: LAB, handler: redundancyStatuses },
  { op: 'getOrganizationWirelessControllerDevicesSystemUtilizationHistoryByInterval', path: `${ORG}/devices/system/utilization/history/byInterval`, sample: LAB, handler: utilization },
  { op: 'getOrganizationWirelessControllerOverviewByDevice', path: `${ORG}/overview/byDevice`, sample: LAB, handler: overview },
];
