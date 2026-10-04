// Per-client wireless stats and the views built from the same sessions:
// connection and latency stats per client, connectivity events, data rate and
// latency history, channel utilization per radio, mesh statuses, and the
// organization-wide client counts and connection failures.

import { arrayParam, badRequest, intParam, notFound, paginate, paginateItems, resolutionParam, timeWindow } from '../http.js';
import { derive, hashStr, unit } from '../rng.js';
import { tunnelsOf } from '../sim/campus.js';
import { connectFailure, failureTime } from '../sim/events.js';
import { END, START, eachSession, isOnline, presenceIn } from '../sim/presence.js';
import { apChannel, channelUtilization, clientSignal, phyRate } from '../sim/rf.js';
import { buckets } from '../sim/usage.js';
import { ACCESS_CATEGORIES, apLatency, classLatency, clientLatency, connectionStats, latencyBins, latencyJson } from '../sim/wireless.js';
import { DAY, HOUR, iso, isoMicro } from '../time.js';
import { bySerial, findClient, netOf } from './common.js';
import { statsWindow, wirelessScope } from './networks.js';
import { bandParam, historyWindow, orgAps, wirelessNet, wirelessNets } from './wireless.js';

const HISTORY_RESOLUTIONS = [300, 600, 1200, 3600, 14400, 86400];
const EVENT_TYPES = ['assoc', 'auth', 'connection', 'deauth', 'dhcp', 'disassoc', 'dns', 'roam', 'sticky'];
const SEVERITIES = ['good', 'info', 'warn', 'bad'];

// A wireless client by its ID, MAC or IP.
function wirelessClient(net, id) {
  const c = findClient(net, id);
  if (!c || c.wired) throw notFound('Client');
  return c;
}

// SSIDs have no ID elsewhere in the API, so one is derived from the network and number.
export function ssidId(net, number) {
  return String(100000 + (hashStr(`${net.id}:ssid:${number}`) % 900000));
}

// ── Per-client stats ──

// The single-client view has no DNS count in the spec.
function clientConnectionStats(clients, t0, t1) {
  const { dns, ...rest } = connectionStats(clients, t0, t1);
  return rest;
}

function clientsConnectionStats(ctx) {
  const { clients } = wirelessScope(ctx, netOf(ctx));
  const { t0, t1 } = statsWindow(ctx);
  return clients
    .map((c) => ({ mac: c.mac, connectionStats: connectionStats([c], t0, t1) }))
    .filter((r) => r.connectionStats.success > 0)
    .sort((a, b) => (a.mac < b.mac ? -1 : 1));
}

function clientsLatencyStats(ctx) {
  const { clients } = wirelessScope(ctx, netOf(ctx));
  const { t0, t1 } = statsWindow(ctx);
  const fields = ctx.query.get('fields');
  const rows = [];
  for (const c of clients) {
    const l = clientLatency(c, t0, t1);
    if (l.samples) rows.push({ mac: c.mac, latencyStats: latencyJson(l.be, l.samples, fields) });
  }
  return rows.sort((a, b) => (a.mac < b.mac ? -1 : 1));
}

// A client outside the filters gets zero counts rather than a 404.
function scopedClient(ctx) {
  const net = netOf(ctx);
  const { clients } = wirelessScope(ctx, net);
  const c = wirelessClient(net, ctx.params.clientId);
  return { c, inScope: clients.includes(c) };
}

// ── Connectivity events ──

function failureData(c, step) {
  if (step === 'auth') return { reason: c.ssid.auth === '8021x' ? 'Invalid credentials' : 'Pairwise key handshake timed out' };
  if (step === 'assoc') return { status: '17' };
  if (step === 'dns') return { server: `10.${c.net.siteIndex}.1.1` };
  return {};
}

// Each connection's steps, timed like the event log: a failed attempt first
// when there is one, then association, authentication and DHCP, and a
// disassociation when the session ends. Clients don't roam between APs.
function connectivityEvents(c, t0, t1) {
  const rows = [];
  const channel = apChannel(c.ap, c.band);
  const k = derive(c.key, 'connectivity');
  const push = (t, { rssi, eventData, ...e }) => {
    if (t >= t0 && t < t1) rows.push({ t, occurredAt: isoMicro(t), band: c.band, ssidNumber: c.ssid.number, ...e, channel, rssi, eventData, deviceSerial: c.ap.serial });
  };
  eachSession(c, t0 - 60, t1 + 60, (s, e, flags) => {
    // The same draws the event log uses for its association, auth and DHCP times.
    const frac = (i) => unit(c.key, Math.floor(s) + i);
    if (flags & START) {
      const rssi = 20 + Math.floor(frac(2) * 30);
      const step = connectFailure(c, s);
      if (step) push(failureTime(c, s), { type: step, subtype: 'failure', severity: 'bad', durationMs: 1000 + Math.floor(unit(k, Math.floor(s)) * 4000), rssi, eventData: failureData(c, step) });
      const assoc = s + frac(1) * 0.5;
      const auth = s + 0.6 + frac(4);
      const dhcp = s + 2 + frac(7) * 2;
      const ms = (a, b) => Math.round((b - a) * 1000);
      push(assoc, { type: 'assoc', subtype: 'success', severity: 'good', durationMs: ms(s, assoc), rssi, eventData: { aid: String(Math.floor(frac(3) * 2e9)) } });
      push(auth, { type: 'auth', subtype: 'success', severity: 'good', durationMs: ms(assoc, auth), rssi, eventData: c.ssid.auth === '8021x' ? { identity: c.user } : {} });
      // Printers keep a static address, as in the event log.
      if (c.kindName !== 'printer') push(dhcp, { type: 'dhcp', subtype: 'success', severity: 'good', durationMs: ms(auth, dhcp), rssi, eventData: { client_ip: c.ip } });
    }
    if (flags & END) {
      push(e, { type: 'disassoc', subtype: 'leaving', severity: 'info', durationMs: 0, rssi: Math.round(clientSignal(c, e).snr), eventData: { reason: '8', duration: String(Math.round(e - s)) } });
    }
  });
  return rows.sort((a, b) => a.t - b.t).map(({ t, ...row }) => row);
}

function listParam(q, name, valid) {
  const v = arrayParam(q, name);
  const bad = v.find((x) => !valid.includes(x));
  if (bad) throw badRequest(`'${name}' must only contain: ${valid.join(', ')}`);
  return v;
}

function clientConnectivityEvents(ctx) {
  const net = wirelessNet(ctx);
  const c = wirelessClient(net, ctx.params.clientId);
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
  const order = q.get('sortOrder') || 'ascending';
  if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
  const types = listParam(q, 'types', EVENT_TYPES);
  const severities = listParam(q, 'includedSeverities', SEVERITIES);
  const band = bandParam(q);
  const ssid = intParam(q, 'ssidNumber', null, { min: 0, max: 14 });
  const serial = q.get('deviceSerial');
  const match = (!band || c.band === band) && (ssid == null || c.ssid.number === ssid) && (!serial || c.ap.serial === serial);
  const rows = match ? connectivityEvents(c, t0, t1).filter((e) => (!types.length || types.includes(e.type)) && (!severities.length || severities.includes(e.severity))) : [];
  if (order === 'descending') rows.reverse();
  return paginate(ctx, rows, (r) => r.occurredAt, { def: 1000, max: 1000 });
}

// ── Histories ──

function clientLatencyHistory(ctx) {
  const net = wirelessNet(ctx);
  const c = wirelessClient(net, ctx.params.clientId);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 791 * DAY, lookback: 791 * DAY });
  const res = resolutionParam(ctx.query, [86400], 86400, t1 - t0);
  return buckets(t0, t1, res).map(([s, e]) => {
    const l = clientLatency(c, Math.max(s, t0), Math.min(e, t1));
    return { t0: s, t1: e, latencyBinsByCategory: latencyBins(l.be, l.samples) };
  });
}

// Link rates averaged over the clients in scope, weighted by time connected.
// Buckets with nobody connected have no rate.
function dataRateHistory(ctx) {
  const { clients } = wirelessScope(ctx, netOf(ctx));
  return historyWindow(ctx, HISTORY_RESOLUTIONS).map(([s, e, a, b]) => {
    let w = 0;
    let down = 0;
    let up = 0;
    for (const c of clients) {
      const p = presenceIn(c, a, b);
      if (!p) continue;
      const r = phyRate(c, (p.first + p.last) / 2);
      w += p.seconds;
      down += r.down * p.seconds;
      up += r.up * p.seconds;
    }
    if (!w) return { startTs: iso(s), endTs: iso(e), averageKbps: null, downloadKbps: null, uploadKbps: null };
    const [d, u] = [Math.round(down / w), Math.round(up / w)];
    return { startTs: iso(s), endTs: iso(e), averageKbps: Math.round((d + u) / 2), downloadKbps: d, uploadKbps: u };
  });
}

// Each client sees its AP's latency, weighted by its share of the samples,
// so one AP's history matches its latency stats over the same window.
function latencyHistory(ctx) {
  const { clients } = wirelessScope(ctx, netOf(ctx));
  const cat = ctx.query.get('accessCategory');
  if (cat && !ACCESS_CATEGORIES.includes(cat)) throw badRequest(`'accessCategory' must be one of: ${ACCESS_CATEGORIES.join(', ')}`);
  return historyWindow(ctx, HISTORY_RESOLUTIONS).map(([s, e, a, b]) => {
    const perAp = new Map();
    let w = 0;
    let sum = 0;
    for (const c of clients) {
      const p = presenceIn(c, a, b);
      const samples = Math.round((p?.seconds ?? 0) / 4);
      if (!samples) continue;
      if (!perAp.has(c.ap)) perAp.set(c.ap, apLatency(c.ap, a, b).be);
      w += samples;
      sum += perAp.get(c.ap) * samples;
    }
    return { startTs: iso(s), endTs: iso(e), avgLatencyMs: w ? Math.round(classLatency(sum / w, cat)) : null };
  });
}

// Tags in the space-padded string form this older endpoint uses.
const tagString = (tags) => (tags.length ? ` ${tags.join(' ')} ` : '');

// wifi0 is the 2.4 GHz radio and wifi1 the 5 GHz one. The spec has no third
// radio, so a CW9166I's 6 GHz radio is left out.
function networkHealthChannelUtilization(ctx) {
  const net = wirelessNet(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
  const res = resolutionParam(ctx.query, [600], 600, t1 - t0);
  const bs = buckets(t0, t1, res);
  const radios = new Map();
  const radio = (ap, band) =>
    bs.map(([s, e]) => {
      const u = channelUtilization(ap, band, Math.max(s, t0), Math.min(e, t1), radios);
      return { startTime: iso(s), endTime: iso(e), utilizationTotal: u.total, utilization80211: u.wifi, utilizationNon80211: u.nonWifi };
    });
  const page = paginate(ctx, [...net.aps].sort(bySerial), (ap) => ap.serial, { def: 10, max: 100 });
  return page.map((ap) => ({ serial: ap.serial, model: ap.model, tags: tagString(ap.tags), wifi0: radio(ap, '2.4'), wifi1: radio(ap, '5') }));
}

// ── Organization-wide ──

const STEPS = { assoc: 'association', auth: 'authentication', dhcp: 'ipAssignment' };

// Unique clients that failed a connection step on each SSID, counted at the
// failure's time like failedConnections. DNS failures aren't a step here.
function impactedBySsid(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, minSpan: 300, defaultSpan: 2 * HOUR, lookback: 8 * DAY });
  const rows = [];
  for (const net of wirelessNets(ctx)) {
    const bySsid = new Map();
    for (const c of net.clients) {
      if (c.wired || !c.ap) continue;
      const failed = new Set();
      eachSession(c, t0 - 60, t1 + 60, (s, e, flags) => {
        const step = flags & START ? connectFailure(c, s) : null;
        const t = step ? failureTime(c, s) : 0;
        if (STEPS[step] && t >= t0 && t < t1) failed.add(STEPS[step]);
      });
      if (!failed.size && !presenceIn(c, t0, t1)) continue;
      const n = c.ssid.number;
      if (!bySsid.has(n)) bySsid.set(n, { name: c.ssid.name, total: 0, impacted: 0, byStep: { association: 0, authentication: 0, ipAssignment: 0 } });
      const row = bySsid.get(n);
      row.total++;
      if (failed.size) row.impacted++;
      for (const step of failed) row.byStep[step]++;
    }
    for (const [number, r] of bySsid) {
      rows.push({
        network: { id: net.id, name: net.name },
        ssid: { id: ssidId(net, number), name: r.name, number },
        clients: { impacted: { byStep: r.byStep, total: r.impacted }, total: r.total },
      });
    }
  }
  // Most impacted first; ties keep network and SSID order.
  rows.sort((a, b) => b.clients.impacted.total - a.clients.impacted.total || (a.network.id < b.network.id ? -1 : a.network.id > b.network.id ? 1 : a.ssid.number - b.ssid.number));
  return paginateItems(ctx, rows, (r) => `${r.network.id}:${r.ssid.number}`, { def: 100, max: 1000 });
}

// Clients associated right now. A cluster filter keeps the APs of networks
// tunneling an SSID through one of those clusters.
function overviewByDevice(ctx) {
  const clusters = arrayParam(ctx.query, 'campusGatewayClusterIds');
  const aps = orgAps(ctx).filter((ap) => !clusters.length || tunnelsOf(ap.net).some((t) => clusters.includes(t.cluster.clusterId)));
  return paginateItems(ctx, aps, (ap) => ap.serial, { def: 1000, max: 1000 }, (ap) => ({
    network: { id: ap.net.id },
    serial: ap.serial,
    counts: { byStatus: { online: ap.net.clients.filter((c) => c.ap === ap && !c.wired && isOnline(c, ctx.now)).length } },
  }));
}

// HQ's first wireless client, for sample URLs.
const wirelessMac = (world) => world.orgs[0].networks[0].clients.find((c) => !c.wired).mac;

export default [
  {
    op: 'getNetworkNetworkHealthChannelUtilization',
    path: '/networks/{networkId}/networkHealth/channelUtilization',
    handler: networkHealthChannelUtilization,
  },
  {
    op: 'getNetworkWirelessClientsConnectionStats',
    path: '/networks/{networkId}/wireless/clients/connectionStats',
    handler: clientsConnectionStats,
  },
  {
    op: 'getNetworkWirelessClientsLatencyStats',
    path: '/networks/{networkId}/wireless/clients/latencyStats',
    handler: clientsLatencyStats,
  },
  {
    op: 'getNetworkWirelessClientConnectionStats',
    path: '/networks/{networkId}/wireless/clients/{clientId}/connectionStats',
    sample: { clientId: wirelessMac },
    handler: (ctx) => {
      const { c, inScope } = scopedClient(ctx);
      const { t0, t1 } = statsWindow(ctx);
      return { mac: c.mac, connectionStats: clientConnectionStats(inScope ? [c] : [], t0, t1) };
    },
  },
  {
    op: 'getNetworkWirelessClientConnectivityEvents',
    path: '/networks/{networkId}/wireless/clients/{clientId}/connectivityEvents',
    sample: { clientId: wirelessMac, query: 'timespan=604800' },
    handler: clientConnectivityEvents,
  },
  {
    op: 'getNetworkWirelessClientLatencyHistory',
    path: '/networks/{networkId}/wireless/clients/{clientId}/latencyHistory',
    sample: { clientId: wirelessMac, query: 'timespan=604800' },
    handler: clientLatencyHistory,
  },
  {
    op: 'getNetworkWirelessClientLatencyStats',
    path: '/networks/{networkId}/wireless/clients/{clientId}/latencyStats',
    sample: { clientId: wirelessMac, query: 'timespan=604800' },
    handler: (ctx) => {
      const { c, inScope } = scopedClient(ctx);
      const { t0, t1 } = statsWindow(ctx);
      const l = inScope ? clientLatency(c, t0, t1) : { be: 0, samples: 0 };
      return { mac: c.mac, latencyStats: latencyJson(l.be, l.samples, ctx.query.get('fields')) };
    },
  },
  {
    op: 'getNetworkWirelessDataRateHistory',
    path: '/networks/{networkId}/wireless/dataRateHistory',
    sample: { query: 'timespan=86400&resolution=3600' },
    handler: dataRateHistory,
  },
  {
    op: 'getNetworkWirelessLatencyHistory',
    path: '/networks/{networkId}/wireless/latencyHistory',
    sample: { query: 'timespan=86400&resolution=3600' },
    handler: latencyHistory,
  },
  {
    op: 'getNetworkWirelessMeshStatuses',
    path: '/networks/{networkId}/wireless/meshStatuses',
    // No AP is a mesh repeater: every one has a wired uplink.
    handler: (ctx) => {
      wirelessNet(ctx);
      return paginate(ctx, [], (r) => r.serial, { def: 50, max: 500 });
    },
  },
  {
    op: 'getOrganizationWirelessClientsConnectionsImpactedByNetworkBySsid',
    path: '/organizations/{organizationId}/wireless/clients/connections/impacted/byNetwork/bySsid',
    sample: { query: 'timespan=604800' },
    handler: impactedBySsid,
  },
  {
    op: 'getOrganizationWirelessClientsOverviewByDevice',
    path: '/organizations/{organizationId}/wireless/clients/overview/byDevice',
    handler: overviewByDevice,
  },
];
