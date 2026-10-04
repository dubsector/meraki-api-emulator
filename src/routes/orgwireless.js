// Organization-wide wireless views: client usage by network and SSID, packet
// loss, channel utilization history, Ethernet and PoE status, power mode and
// CPU load history, BSSID statuses and impacted APs. Each one reuses the
// numbers of the per-network and per-device routes that show the same data.

import { configOf } from '../config.js';
import { arrayParam, badRequest, boolParam, intParam, paginate, paginateItems, timeWindow } from '../http.js';
import { tunnelsOf } from '../sim/campus.js';
import { CPU_COUNT, cpuSamples } from '../sim/memory.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { RADIO, SETTINGS, apChannel, apPower, apWidth, bssid } from '../sim/rf.js';
import { buckets, clientUsage } from '../sim/usage.js';
import { clientLoss } from '../sim/wireless.js';
import { DAY, HOUR, iso, isoMicro } from '../time.js';
import { round } from './common.js';
import { portSpeed, speedMbps } from './switch.js';
import { BANDS, byBand, orgAps, wirelessNets } from './wireless.js';
import { ssidId } from './wirelessstats.js';

const UNITS = { KB: ['kilobytes', 1], MB: ['megabytes', 1024], GB: ['gigabytes', 1024 ** 2], TB: ['terabytes', 1024 ** 3] };
const INTERVALS = [300, 600, 3600, 7200, 14400, 21600];
const POE = ['802.3af', '802.3at', '802.3bt'];
// PoE each AP model needs for full power, and what each switch port can give.
const NEEDS = { CW9166I: '802.3bt', MR46: '802.3at', MR78: '802.3at', MR36: '802.3af' };
const SUPPLIES = { 'MS390-48UX': '802.3bt' };
const REBOOT = 900;

const deviceHead = (ap) => ({
  serial: ap.serial,
  model: ap.model,
  name: ap.name,
  mac: ap.mac,
  tags: ap.tags,
  network: { id: ap.net.id, name: ap.net.name, tags: ap.net.tags },
});

// ── Client usage ──

function usageScope(ctx) {
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 7 * DAY, minSpan: HOUR, defaultSpan: 2 * HOUR, lookback: 8 * DAY });
  const units = q.get('usageUnits') ?? 'MB';
  if (!UNITS[units]) throw badRequest("'usageUnits' must be one of: GB, KB, MB, TB");
  // With gatewayNetworkIds, only SSIDs tunneling to clusters in those networks count.
  const gateways = arrayParam(q, 'gatewayNetworkIds');
  const only = new Map(wirelessNets(ctx).map((net) => [net, gateways.length ? new Set(tunnelsOf(net).filter((t) => gateways.includes(t.net.id)).map((t) => t.number)) : null]));
  return { t0, t1, nets: [...only.keys()].filter((n) => only.get(n)?.size !== 0), units, only };
}

// Clients seen and KB each way per SSID number, counted like the top SSIDs summary.
function ssidUsage(net, t0, t1, only = null) {
  const by = new Map();
  for (const c of net.clients) {
    if (c.wired || !c.ap || (only && !only.has(c.ssid.number)) || !presenceIn(c, t0, t1)) continue;
    const u = clientUsage(c, t0, t1);
    const r = by.get(c.ssid.number) ?? { clients: 0, sent: 0, recv: 0 };
    r.clients++;
    r.sent += u.sent;
    r.recv += u.recv;
    by.set(c.ssid.number, r);
  }
  return by;
}

// SSIDs that are enabled or carried clients in the window, by number.
function ssidsOf(net, by, only = null) {
  const config = configOf(net).ssids;
  const numbers = new Set([...config.flatMap((s, n) => (s.enabled && (!only || only.has(n)) ? [n] : [])), ...by.keys()]);
  return [...numbers].sort((a, b) => a - b).map((n) => ({ number: n, name: config[n].name, aps: config[n].enabled ? net.aps.length : 0 }));
}

const EMPTY = { clients: 0, sent: 0, recv: 0 };
const usageJson = (r, units) => {
  const d = UNITS[units][1];
  return { total: round((r.sent + r.recv) / d, 2), upstream: round(r.sent / d, 2), downstream: round(r.recv / d, 2) };
};
const byUsage = (a, b) => b.usage.total - a.usage.total;

function usagePage(ctx, rows, keyOf, units) {
  const out = paginateItems(ctx, rows, keyOf, { def: 100, max: 1000 });
  out.meta.units = { usage: { name: UNITS[units][0], symbol: units } };
  return out;
}

function usageByNetwork(ctx) {
  const { t0, t1, nets, units, only } = usageScope(ctx);
  const rows = nets.map((net) => {
    const total = { ...EMPTY };
    for (const r of ssidUsage(net, t0, t1, only.get(net)).values()) for (const k of ['clients', 'sent', 'recv']) total[k] += r[k];
    return { network: { id: net.id, name: net.name }, clients: { total: total.clients }, devices: { byProductType: { wireless: net.aps.length } }, usage: usageJson(total, units) };
  });
  rows.sort((a, b) => byUsage(a, b) || (a.network.id < b.network.id ? -1 : 1));
  return usagePage(ctx, rows, (r) => r.network.id, units);
}

function usageByNetworkBySsid(ctx) {
  const { t0, t1, nets, units, only } = usageScope(ctx);
  const ids = arrayParam(ctx.query, 'ssidIds');
  const names = arrayParam(ctx.query, 'ssidNames');
  const rows = [];
  for (const net of nets) {
    const by = ssidUsage(net, t0, t1, only.get(net));
    const tunnels = tunnelsOf(net);
    for (const s of ssidsOf(net, by, only.get(net))) {
      const id = ssidId(net, s.number);
      const tunnel = tunnels.find((t) => t.number === s.number);
      if ((ids.length && !ids.includes(id)) || (names.length && !names.includes(s.name))) continue;
      const r = by.get(s.number) ?? EMPTY;
      rows.push({
        network: { id: net.id, name: net.name },
        ssid: { id, number: s.number, name: s.name, tunneledTo: tunnel ? { network: { id: tunnel.net.id, name: tunnel.net.name }, cluster: { id: tunnel.cluster.clusterId, name: tunnel.cluster.name } } : null },
        clients: { total: r.clients },
        devices: { byProductType: { wireless: s.aps } },
        usage: usageJson(r, units),
      });
    }
  }
  rows.sort((a, b) => byUsage(a, b) || (a.network.id < b.network.id ? -1 : a.network.id > b.network.id ? 1 : a.ssid.number - b.ssid.number));
  return usagePage(ctx, rows, (r) => `${r.network.id}:${r.ssid.number}`, units);
}

// SSIDs across networks share a row when they share a name, as in the top SSIDs summary.
function usageBySsid(ctx) {
  const { t0, t1, nets, units, only } = usageScope(ctx);
  const names = arrayParam(ctx.query, 'ssidNames');
  const byName = new Map();
  for (const net of nets) {
    const by = ssidUsage(net, t0, t1, only.get(net));
    for (const s of ssidsOf(net, by, only.get(net))) {
      if (names.length && !names.includes(s.name)) continue;
      const row = byName.get(s.name) ?? { ...EMPTY, aps: 0 };
      const r = by.get(s.number) ?? EMPTY;
      row.clients += r.clients;
      row.sent += r.sent;
      row.recv += r.recv;
      row.aps += s.aps;
      byName.set(s.name, row);
    }
  }
  const rows = [...byName].map(([name, r]) => ({ ssid: { name }, clients: { total: r.clients }, devices: { byProductType: { wireless: r.aps } }, usage: usageJson(r, units) }));
  rows.sort((a, b) => byUsage(a, b) || (a.ssid.name < b.ssid.name ? -1 : 1));
  return usagePage(ctx, rows, (r) => r.ssid.name, units);
}

// ── Packet loss ──

// APs from networkIds and serials, and their wireless clients on the given SSIDs, bands and MACs.
function lossScope(ctx) {
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 90 * DAY, minSpan: 300, defaultSpan: 7 * DAY, lookback: 90 * DAY });
  const ssids = arrayParam(q, 'ssids').map(Number);
  if (ssids.some((n) => !Number.isInteger(n) || n < 0 || n > 14)) throw badRequest("'ssids' must be SSID numbers from 0 to 14");
  const bands = arrayParam(q, 'bands');
  if (bands.some((b) => !BANDS.includes(b))) throw badRequest("'bands' must be one of: 2.4, 5, 6");
  const macs = arrayParam(q, 'macs').map((m) => m.toLowerCase());
  const aps = orgAps(ctx);
  const chosen = new Set(aps);
  const clients = [];
  for (const net of new Set(aps.map((a) => a.net))) {
    for (const c of net.clients) {
      if (c.wired || !chosen.has(c.ap) || (ssids.length && !ssids.includes(c.ssid.number)) || (bands.length && !bands.includes(c.band)) || (macs.length && !macs.includes(c.mac))) continue;
      clients.push({ c, loss: clientLoss(c, t0, t1) });
    }
  }
  return { aps, clients };
}

const noLoss = () => ({ downstream: { total: 0, lost: 0 }, upstream: { total: 0, lost: 0 } });
function addLoss(to, l) {
  for (const d of ['downstream', 'upstream']) {
    to[d].total += l[d].total;
    to[d].lost += l[d].lost;
  }
  return to;
}
const direction = (d) => ({ total: d.total, lost: d.lost, lossPercentage: d.total ? round((d.lost / d.total) * 100, 2) : 0 });
const lossJson = (l) => ({ downstream: direction(l.downstream), upstream: direction(l.upstream) });

function lossByClient(ctx) {
  const rows = lossScope(ctx)
    .clients.filter((r) => r.loss.downstream.total + r.loss.upstream.total > 0)
    .sort((a, b) => (a.c.mac < b.c.mac ? -1 : 1))
    .map(({ c, loss }) => ({ ...lossJson(loss), client: { id: c.id, mac: c.mac }, network: { id: c.net.id, name: c.net.name } }));
  return paginate(ctx, rows, (r) => r.client.id, { def: 1000, max: 1000 });
}

function lossByDevice(ctx) {
  const { aps, clients } = lossScope(ctx);
  const rows = aps.map((ap) => {
    const sum = clients.filter((r) => r.c.ap === ap).reduce((to, r) => addLoss(to, r.loss), noLoss());
    return { ...lossJson(sum), network: { id: ap.net.id, name: ap.net.name }, device: { name: ap.name, serial: ap.serial, mac: ap.mac } };
  });
  return paginate(ctx, rows, (r) => r.device.serial, { def: 1000, max: 1000 });
}

function lossByNetwork(ctx) {
  const { aps, clients } = lossScope(ctx);
  const nets = [...new Set(aps.map((a) => a.net))].sort((a, b) => (a.id < b.id ? -1 : 1));
  const rows = nets.map((net) => {
    const sum = clients.filter((r) => r.c.net === net).reduce((to, r) => addLoss(to, r.loss), noLoss());
    return { ...lossJson(sum), network: { id: net.id, name: net.name } };
  });
  return paginate(ctx, rows, (r) => r.network.id, { def: 1000, max: 1000 });
}

// ── Channel utilization history ──

// Aligned intervals over the window; the edge ones are averaged over the part inside it.
function utilizationIntervals(ctx) {
  const interval = intParam(ctx.query, 'interval', 3600);
  if (!INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 7 * DAY, lookback: 31 * DAY });
  return buckets(t0, t1, interval).map(([s, e]) => [s, e, Math.max(s, t0), Math.min(e, t1)]);
}

// Oldest interval first, then by serial. Only the page's rows are computed.
function utilizationByDevice(ctx) {
  const aps = orgAps(ctx);
  const rows = utilizationIntervals(ctx).flatMap((b) => aps.map((ap) => ({ b, ap })));
  const page = paginate(ctx, rows, (r) => `${r.b[0]}:${r.ap.serial}`, { def: 1000, max: 1000 });
  return page.map(({ b: [s, e, a, z], ap }) => ({ startTs: iso(s), endTs: iso(e), serial: ap.serial, mac: ap.mac, network: { id: ap.net.id }, byBand: byBand([ap], a, z) }));
}

function utilizationByNetwork(ctx) {
  const aps = orgAps(ctx);
  const nets = [...new Set(aps.map((a) => a.net))].sort((a, b) => (a.id < b.id ? -1 : 1));
  const rows = utilizationIntervals(ctx).flatMap((b) => nets.map((net) => ({ b, net })));
  const page = paginate(ctx, rows, (r) => `${r.b[0]}:${r.net.id}`, { def: 1000, max: 1000 });
  return page.map(({ b: [s, e, a, z], net }) => ({
    startTs: iso(s),
    endTs: iso(e),
    network: { id: net.id },
    byBand: byBand(aps.filter((ap) => ap.net === net), a, z),
  }));
}

// ── Ethernet, power and CPU ──

// An AP on a switch port gets the lower of the PoE standard it needs and the
// one the port gives, and drops to low power when the port gives less. One
// with no switch port runs from a PoE injector.
function poeOf(ap) {
  const need = NEEDS[ap.model] ?? '802.3at';
  const port = ap.switchPort;
  if (!port) return { mode: 'full', standard: null };
  const supply = SUPPLIES[port.switch.model] ?? '802.3at';
  return { mode: POE.indexOf(supply) >= POE.indexOf(need) ? 'full' : 'low', standard: POE[Math.min(POE.indexOf(need), POE.indexOf(supply))] };
}

// Catalyst APs report no duplex, speed or aggregation.
function ethernetStatus(ap) {
  const poe = poeOf(ap);
  const port = ap.switchPort;
  const speed = ap.model.startsWith('CW') ? null : speedMbps(port ? portSpeed(port.switch, port) : ap.info.speed);
  return {
    serial: ap.serial,
    name: ap.name,
    network: { id: ap.net.id },
    power: { mode: poe.mode, ac: { isConnected: false }, poe: { isConnected: true } },
    ports: [{ name: 'Ethernet 0', poe: { standard: poe.standard }, linkNegotiation: { duplex: speed == null ? null : 'full', speed } }],
    aggregation: { enabled: speed == null ? null : false, speed },
  };
}

// An AP reports its power mode each time it comes back up, after its own
// outage or one of the switch powering it.
function powerEvents(ap, t0, t1) {
  const ends = [];
  const add = (s, e) => e > t0 && e <= t1 && ends.push(e);
  eachOutage(ap, t0, t1, add);
  if (ap.switchPort) eachOutage(ap.switchPort.switch, t0, t1, add);
  const powerMode = `${poeOf(ap).mode} power`;
  return [...new Set(ends)].sort((a, b) => a - b).map((t) => ({ ts: isoMicro(t), powerMode }));
}

const dayWindow = (ctx) => timeWindow(ctx.query, ctx.now, { maxSpan: DAY, defaultSpan: DAY, lookback: DAY });

function powerModeHistory(ctx) {
  const { t0, t1 } = dayWindow(ctx);
  const page = paginate(ctx, orgAps(ctx), (ap) => ap.serial, { def: 10, max: 20 });
  return { items: page.map((ap) => ({ ...deviceHead(ap), events: powerEvents(ap, t0, t1) })) };
}

function cpuLoadHistory(ctx) {
  const { t0, t1 } = dayWindow(ctx);
  const page = paginate(ctx, orgAps(ctx), (ap) => ap.serial, { def: 10, max: 20 });
  return {
    items: page.map((ap) => ({
      ...deviceHead(ap),
      cpuCount: CPU_COUNT[ap.model] ?? 2,
      series: cpuSamples(ap, t0, t1).map((s) => ({ ts: isoMicro(s.t), cpuLoad5: s.load })),
    })),
  };
}

// ── BSSIDs and impacted APs ──

// The same basic service sets as each AP's wireless status, in the same order.
function ssidStatuses(ctx) {
  const q = ctx.query;
  const hide = boolParam(q, 'hideDisabled', true);
  const wanted = arrayParam(q, 'bssids').map((b) => b.toUpperCase());
  const rows = [];
  for (const ap of orgAps(ctx)) {
    const sets = [];
    const up = !isDown(ap, ctx.now);
    configOf(ap.net).ssids.forEach((s, number) => {
      if (hide && !s.enabled) return;
      for (const band of ap.info.bands) {
        const id = bssid(ap, band, number);
        if (wanted.length && !wanted.includes(id)) continue;
        sets.push({
          bssid: id,
          ssid: { name: s.name, number, enabled: Boolean(s.enabled), advertised: Boolean(s.enabled) && s.visible !== false },
          radio: { band, channel: apChannel(ap, band), channelWidth: apWidth(ap, band), power: apPower(ap, band), isBroadcasting: up && ap.radio?.[SETTINGS[band]]?.enabled !== false, index: RADIO[band] },
        });
      }
    });
    if (sets.length || !wanted.length) rows.push({ serial: ap.serial, name: ap.name, network: { id: ap.net.id, name: ap.net.name }, basicServiceSets: sets });
  }
  return paginateItems(ctx, rows, (r) => r.serial, { def: 100, max: 500 });
}

// APs that went down in the window, per network. A short outage is a reboot.
// The spec shows one object, but the route pages and counts per network, so
// this returns a list with one entry for each wireless network.
function impactedDevices(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, minSpan: 2 * HOUR, defaultSpan: 2 * HOUR, lookback: 14 * DAY });
  const rows = wirelessNets(ctx).map((net) => {
    const types = new Map();
    let total = 0;
    for (const ap of net.aps) {
      const seen = new Set();
      eachOutage(ap, t0, t1, (s, e) => seen.add(e - s <= REBOOT ? 'AP reboot' : 'AP offline'));
      if (seen.size) total++;
      for (const t of seen) types.set(t, (types.get(t) ?? 0) + 1);
    }
    const byFailureType = [...types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
    return { network: { id: net.id, name: net.name }, counts: { total, byFailureType } };
  });
  rows.sort((a, b) => b.counts.total - a.counts.total || (a.network.id < b.network.id ? -1 : 1));
  return paginate(ctx, rows, (r) => r.network.id, { def: 1000, max: 5000 });
}

const ORG = '/organizations/{organizationId}';

export default [
  {
    op: 'getOrganizationAssuranceImpactedDeviceWirelessByNetwork',
    path: `${ORG}/assurance/impactedDevice/wireless/byNetwork`,
    sample: { query: 'timespan=1209600' },
    handler: impactedDevices,
  },
  {
    op: 'getOrganizationWirelessClientsUsageByNetwork',
    path: `${ORG}/wireless/clients/usage/byNetwork`,
    handler: usageByNetwork,
  },
  {
    op: 'getOrganizationWirelessClientsUsageByNetworkBySsid',
    path: `${ORG}/wireless/clients/usage/byNetwork/bySsid`,
    handler: usageByNetworkBySsid,
  },
  {
    op: 'getOrganizationWirelessClientsUsageBySsid',
    path: `${ORG}/wireless/clients/usage/bySsid`,
    handler: usageBySsid,
  },
  {
    op: 'getOrganizationWirelessDevicesChannelUtilizationHistoryByDeviceByInterval',
    path: `${ORG}/wireless/devices/channelUtilization/history/byDevice/byInterval`,
    sample: { query: 'timespan=86400' },
    handler: utilizationByDevice,
  },
  {
    op: 'getOrganizationWirelessDevicesChannelUtilizationHistoryByNetworkByInterval',
    path: `${ORG}/wireless/devices/channelUtilization/history/byNetwork/byInterval`,
    sample: { query: 'timespan=86400' },
    handler: utilizationByNetwork,
  },
  {
    op: 'getOrganizationWirelessDevicesEthernetStatuses',
    path: `${ORG}/wireless/devices/ethernet/statuses`,
    handler: (ctx) => paginate(ctx, orgAps(ctx), (ap) => ap.serial, { def: 100, max: 1000 }).map(ethernetStatus),
  },
  {
    op: 'getOrganizationWirelessDevicesPacketLossByClient',
    path: `${ORG}/wireless/devices/packetLoss/byClient`,
    handler: lossByClient,
  },
  {
    op: 'getOrganizationWirelessDevicesPacketLossByDevice',
    path: `${ORG}/wireless/devices/packetLoss/byDevice`,
    handler: lossByDevice,
  },
  {
    op: 'getOrganizationWirelessDevicesPacketLossByNetwork',
    path: `${ORG}/wireless/devices/packetLoss/byNetwork`,
    handler: lossByNetwork,
  },
  {
    op: 'getOrganizationWirelessDevicesPowerModeHistory',
    path: `${ORG}/wireless/devices/power/mode/history`,
    handler: powerModeHistory,
  },
  {
    op: 'getOrganizationWirelessDevicesSystemCpuLoadHistory',
    path: `${ORG}/wireless/devices/system/cpu/load/history`,
    handler: cpuLoadHistory,
  },
  {
    op: 'getOrganizationWirelessSsidsStatusesByDevice',
    path: `${ORG}/wireless/ssids/statuses/byDevice`,
    handler: ssidStatuses,
  },
];
