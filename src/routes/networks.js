import { clientJson, deviceJson, networkJson } from '../format.js';
import { arrayParam, badRequest, intParam, linkHeader, notFound, paginate, perPageParam, resolutionParam, timeWindow } from '../http.js';
import { networkEventsOnDay, securityEventsOnDay } from '../sim/events.js';
import { eachSession, isOnline, presenceIn } from '../sim/presence.js';
import { trafficRows, uplinkBytes } from '../sim/traffic.js';
import { SLOT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, buckets, clientUsage, eachSlot, networkTotals } from '../sim/usage.js';
import { connectionStats, latencyStats } from '../sim/wireless.js';
import { DAY, iso, isoMicro, isoUs, parseUs } from '../time.js';
import { byId, bySerial, netOf, requireProduct, round } from './common.js';

const US = 1e6;
const DAY_US = DAY * US;
const EVENT_RETENTION = 90 * DAY;
const PRODUCT_TYPES = ['appliance', 'camera', 'campusGateway', 'cellularGateway', 'secureConnect', 'switch', 'systemsManager', 'wireless', 'wirelessController'];
const WIRELESS_RESOLUTIONS = [300, 600, 1200, 3600, 14400, 86400];

// ── Clients ──

function clientFilter(q) {
  const statuses = arrayParam(q, 'statuses');
  const conns = arrayParam(q, 'recentDeviceConnections');
  const part = (name) => q.get(name)?.toLowerCase();
  const ip = part('ip');
  const ip6 = part('ip6');
  const ip6Local = part('ip6Local');
  const mac = part('mac');
  const os = part('os');
  const description = part('description');
  const namedVlan = part('namedVlan');
  const vlan = q.get('vlan');
  const has = (v, want) => !want || (v != null && v.toLowerCase().includes(want));
  return (row) =>
    (!statuses.length || statuses.includes(row.status)) &&
    (!conns.length || conns.includes(row.recentDeviceConnection)) &&
    has(row.ip, ip) &&
    has(row.ip6, ip6) &&
    has(row.ip6Local, ip6Local) &&
    has(row.mac, mac) &&
    has(row.os, os) &&
    has(row.description, description) &&
    has(row.namedVlan, namedVlan) &&
    (!vlan || row.vlan === vlan);
}

function findClient(net, id) {
  const lower = id.toLowerCase();
  return net.clients.find((c) => c.id === id || c.mac === lower || c.ip === id);
}

// ── Events ──

// First index whose microsecond timestamp is greater than us.
function firstAfter(list, us) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (list[m].us > us) hi = m;
    else lo = m + 1;
  }
  return lo;
}

function* eventsForward(net, lo, hi) {
  for (let d = Math.floor(lo / DAY_US); d * DAY_US < hi; d++) {
    const list = networkEventsOnDay(net, d);
    for (let i = firstAfter(list, lo); i < list.length && list[i].us < hi; i++) yield list[i];
  }
}

function* eventsBackward(net, lo, hi) {
  for (let d = Math.floor((hi - 1) / DAY_US); (d + 1) * DAY_US > lo; d--) {
    const list = networkEventsOnDay(net, d);
    for (let i = firstAfter(list, hi - 1) - 1; i >= 0 && list[i].us > lo; i--) yield list[i];
  }
}

function eventFilter(ctx, net) {
  const q = ctx.query;
  let productType = q.get('productType');
  if (!productType) {
    if (net.productTypes.length > 1) throw badRequest('productType is required for networks with multiple device types');
    productType = net.productTypes[0];
  } else if (!PRODUCT_TYPES.includes(productType)) {
    throw badRequest(`'productType' must be one of: ${PRODUCT_TYPES.join(', ')}`);
  }
  const included = new Set(arrayParam(q, 'includedEventTypes'));
  const excluded = new Set(arrayParam(q, 'excludedEventTypes'));
  const deviceMac = q.get('deviceMac')?.toLowerCase();
  const deviceSerial = q.get('deviceSerial');
  const deviceName = q.get('deviceName');
  const clientIp = q.get('clientIp');
  const clientMac = q.get('clientMac')?.toLowerCase();
  const clientName = q.get('clientName');
  const { world } = ctx;
  return (e) =>
    e.productType === productType &&
    (!included.size || included.has(e.type)) &&
    !excluded.has(e.type) &&
    (!deviceSerial || e.deviceSerial === deviceSerial) &&
    (!deviceName || e.deviceName === deviceName) &&
    (!deviceMac || world.deviceBySerial.get(e.deviceSerial)?.mac === deviceMac) &&
    (!clientMac || e.clientMac === clientMac) &&
    (!clientName || e.clientDescription === clientName) &&
    (!clientIp || world.clientById.get(e.clientId)?.ip === clientIp);
}

function eventJson(e) {
  return {
    occurredAt: isoUs(e.us),
    networkId: e.networkId,
    type: e.type,
    description: e.description,
    category: e.category,
    clientId: e.clientId ?? null,
    clientDescription: e.clientDescription ?? null,
    clientMac: e.clientMac ?? null,
    deviceSerial: e.deviceSerial ?? null,
    deviceName: e.deviceName ?? null,
    ssidNumber: e.ssidNumber ?? null,
    eventData: e.eventData ?? {},
  };
}

// Pages are newest first. Without startingAfter the newest events come back;
// with it, the oldest events after that instant. Like the real event log, a
// rel=next link is always present, so clients must decide when to stop.
function networkEvents(ctx) {
  const net = netOf(ctx);
  const q = ctx.query;
  const match = eventFilter(ctx, net);
  const perPage = perPageParam(q, { def: 10, max: 1000 });
  const nowUs = Math.floor(ctx.now * US);
  const floor = nowUs - EVENT_RETENTION * US;
  const cursor = (name) => {
    const v = q.get(name);
    if (v == null) return null;
    if (v === 'zzzzzzzzzz') return nowUs;
    const us = parseUs(v);
    if (Number.isNaN(us)) throw badRequest(`'${name}' must be a timestamp`);
    return us;
  };
  const after = cursor('startingAfter');
  const before = cursor('endingBefore');
  const hi = Math.max(floor, Math.min(before ?? nowUs, nowUs));
  const lo = after != null ? Math.max(after, floor) : floor;

  const page = [];
  let more = false;
  for (const e of after != null ? eventsForward(net, lo, hi) : eventsBackward(net, lo, hi)) {
    if (!match(e)) continue;
    if (page.length === perPage) {
      more = true;
      break;
    }
    page.push(e);
  }
  if (after == null) page.reverse();

  const first = page.length ? page[0].us : lo;
  const last = page.length ? page[page.length - 1].us : hi;
  const next = after != null && !more ? hi : last;
  const keep = before != null ? { endingBefore: q.get('endingBefore') } : {};
  ctx.headers.Link = linkHeader(ctx, perPage, [
    ['first', { startingAfter: '0000000000' }],
    ['prev', { endingBefore: isoUs(first) }],
    ['next', { startingAfter: isoUs(next), ...keep }],
    ['last', { endingBefore: 'zzzzzzzzzz' }],
  ]);
  return {
    message: null,
    pageStartAt: isoUs(first),
    pageEndAt: isoUs(last),
    events: page.reverse().map(eventJson),
  };
}

// ── Wireless ──

function wirelessScope(ctx, net) {
  requireProduct(net, 'wireless');
  const q = ctx.query;
  const band = q.get('band');
  if (band && !['2.4', '5', '6'].includes(band)) throw badRequest("'band' must be one of: 2.4, 5, 6");
  const ssid = intParam(q, 'ssid', null, { min: 0, max: 14 });
  const vlan = intParam(q, 'vlan', null, { min: 1, max: 4094 });
  const apTag = q.get('apTag');
  const serial = q.get('deviceSerial');
  const clientId = q.get('clientId');
  let aps = net.aps;
  if (apTag) aps = aps.filter((a) => a.tags.includes(apTag));
  if (serial) {
    aps = aps.filter((a) => a.serial === serial);
    if (!net.aps.some((a) => a.serial === serial)) throw notFound('Device');
  }
  const apSet = new Set(aps);
  let client = null;
  if (clientId) {
    client = findClient(net, clientId);
    if (!client) throw notFound('Client');
  }
  const clients = net.clients.filter(
    (c) => !c.wired && apSet.has(c.ap) && (!band || c.band === band) && (ssid == null || c.ssid.number === ssid) && (vlan == null || c.vlan === vlan) && (!client || c === client),
  );
  const narrowed = band || ssid != null || vlan != null || client;
  // Latency is per AP, so client-level filters keep only APs that serve a matching client.
  const latencyAps = narrowed ? aps.filter((a) => clients.some((c) => c.ap === a)) : aps;
  return { aps, clients, latencyAps, filtered: !!(narrowed || apTag || serial) };
}

function statsWindow(ctx) {
  return timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, lookback: 180 * DAY });
}

function historyWindow(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 7 * DAY, lookback: 31 * DAY });
  const res = resolutionParam(ctx.query, WIRELESS_RESOLUTIONS, 86400, t1 - t0);
  return { t0, t1, res, bs: buckets(t0, t1, res) };
}

const PSK_SSID = { encryptionMode: 'wpa', wpaEncryptionMode: 'WPA2 only', psk: 'example-passphrase' };

function ssidJson(net, number) {
  const s = net.ssids.find((x) => x.number === number);
  const common = {
    number,
    ssidAdminAccessible: false,
    localAuth: false,
    minBitrate: 11,
    bandSelection: 'Dual band operation',
    perClientBandwidthLimitUp: 0,
    perClientBandwidthLimitDown: 0,
    perSsidBandwidthLimitUp: 0,
    perSsidBandwidthLimitDown: 0,
    mandatoryDhcpEnabled: false,
    visible: true,
    availableOnAllAps: true,
    availabilityTags: [],
    speedBurst: { enabled: false },
  };
  if (!s) return { ...common, name: `Unconfigured SSID ${number + 1}`, enabled: false, splashPage: 'None', authMode: 'open', ipAssignmentMode: 'NAT mode' };
  const out = {
    ...common,
    name: s.name,
    enabled: true,
    splashPage: s.splashPage || 'None',
    authMode: s.authMode,
    ipAssignmentMode: s.nat ? 'NAT mode' : 'Bridge mode',
    bandSelection: 'Dual band operation with Band Steering',
    minBitrate: 12,
  };
  if (s.authMode === 'psk') Object.assign(out, PSK_SSID);
  if (s.authMode === '8021x-radius') {
    Object.assign(out, {
      encryptionMode: 'wpa-eap',
      wpaEncryptionMode: 'WPA2 only',
      radiusServers: [{ id: String(net.key % 1e9), host: `${net.org.hub ? net.org.hub.subnet(5) : net.subnet(5)}.20`, port: 1812 }],
      radiusAccountingEnabled: false,
      radiusFailoverPolicy: 'Deny access',
      radiusLoadBalancingPolicy: 'Round robin',
    });
  }
  if (!s.nat) Object.assign(out, { useVlanTagging: true, defaultVlanId: s.vlan });
  if (s.splashPage) Object.assign(out, { splashTimeout: '1440 minutes', walledGardenEnabled: false });
  return out;
}

export default [
  {
    path: '/networks/{networkId}',
    handler: (ctx) => networkJson(netOf(ctx)),
  },
  {
    path: '/networks/{networkId}/devices',
    handler: (ctx) => netOf(ctx).devices.map((d) => deviceJson(d, { full: true })),
  },
  {
    path: '/networks/{networkId}/clients',
    handler: (ctx) => {
      const net = netOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY, allowT1: false });
      const keep = clientFilter(ctx.query);
      const rows = [];
      for (const c of [...net.clients].sort(byId)) {
        const p = presenceIn(c, t0, t1);
        if (!p) continue;
        const row = clientJson(c, { usage: clientUsage(c, t0, t1), last: p.last, online: isOnline(c, ctx.now) });
        if (keep(row)) rows.push(row);
      }
      return paginate(ctx, rows, (r) => r.id, { def: 10, max: 5000 });
    },
  },
  {
    path: '/networks/{networkId}/clients/overview',
    handler: (ctx) => {
      const net = netOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
      resolutionParam(ctx.query, [7200, 86400, 604800, 2629746], 604800, t1 - t0);
      const totals = [];
      for (const c of net.clients) {
        if (!presenceIn(c, t0, t1)) continue;
        const u = clientUsage(c, t0, t1);
        totals.push(u.sent + u.recv);
      }
      const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
      const heavy = totals.filter((v) => v > avg * 3);
      return {
        counts: { total: totals.length, withHeavyUsage: heavy.length },
        usages: { average: Math.round(avg), withHeavyUsageAverage: heavy.length ? Math.round(heavy.reduce((a, b) => a + b, 0) / heavy.length) : 0 },
      };
    },
  },
  {
    path: '/networks/{networkId}/clients/bandwidthUsageHistory',
    handler: (ctx) => {
      const net = netOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 30 * DAY });
      const res = t1 - t0 <= DAY ? SLOT : 3600;
      const rows = buckets(t0, t1, res).map(([s, e]) => {
        const a = Math.max(s, t0);
        const b = Math.min(e, t1);
        const [ws, wr, ds, dr] = networkTotals(net, a, b, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
        const mbps = (kb) => round((kb * 8) / 1000 / (b - a), 4);
        const up = mbps(ws + ds);
        const down = mbps(wr + dr);
        return { ts: iso(s), total: round(up + down, 4), upstream: up, downstream: down };
      });
      return paginate(ctx, rows, (r) => r.ts, { def: 1000, max: 1000 });
    },
  },
  {
    path: '/networks/{networkId}/clients/{clientId}',
    handler: (ctx) => {
      const net = netOf(ctx);
      const c = findClient(net, ctx.params.clientId);
      if (!c) throw notFound('Client');
      const p = presenceIn(c, ctx.now - 31 * DAY, ctx.now);
      const { usage, adaptivePolicyGroup, ...row } = clientJson(c, { usage: { sent: 0, recv: 0 }, last: p ? p.last : c.firstSeen, online: isOnline(c, ctx.now) });
      return { ...row, model: c.prediction, clientVpnConnections: null, lldp: null, cdp: null };
    },
  },
  {
    path: '/networks/{networkId}/events',
    handler: networkEvents,
  },
  {
    path: '/networks/{networkId}/traffic',
    handler: (ctx) => {
      const net = netOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 30 * DAY, lookback: 30 * DAY, allowT1: false });
      const deviceType = ctx.query.get('deviceType') || 'combined';
      if (!['combined', 'wireless', 'switch', 'appliance'].includes(deviceType)) throw badRequest("'deviceType' must be one of: combined, wireless, switch, appliance");
      return trafficRows(net, t0, t1, deviceType);
    },
  },
  {
    path: '/networks/{networkId}/appliance/uplinks/usageHistory',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'appliance');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 600, lookback: 30 * DAY });
      const res = resolutionParam(ctx.query, [60, 300, 600, 1800, 3600, 86400], 60, t1 - t0);
      return buckets(t0, t1, res).map(([s, e]) => {
        const bytes = uplinkBytes(net, Math.max(s, t0), Math.min(e, t1), res);
        return { startTime: iso(s), endTime: iso(e), byInterface: net.mx.uplinks.map((u) => ({ interface: u.interface, ...bytes[u.interface] })) };
      });
    },
  },
  {
    path: '/networks/{networkId}/appliance/security/events',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'appliance');
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 365 * DAY, defaultSpan: 31 * DAY, lookback: 365 * DAY });
      const order = ctx.query.get('sortOrder') || 'ascending';
      if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
      const rows = [];
      for (let d = Math.floor(t0 / DAY); d <= Math.floor(t1 / DAY); d++) {
        for (const { t, ts, ...rest } of securityEventsOnDay(net, d)) {
          if (t >= t0 && t < t1) rows.push({ ts: isoMicro(t), ...rest });
        }
      }
      if (order === 'descending') rows.reverse();
      return paginate(ctx, rows, (r) => r.ts, { def: 100, max: 1000 });
    },
  },
  {
    path: '/networks/{networkId}/wireless/clientCountHistory',
    handler: (ctx) => {
      const net = netOf(ctx);
      const { clients } = wirelessScope(ctx, net);
      const { t0, t1, res, bs } = historyWindow(ctx);
      const base = bs.length ? bs[0][0] : t0;
      const counts = new Array(bs.length).fill(0);
      for (const c of clients) {
        let marked = -1;
        eachSession(c, t0, t1, (s, e) => {
          const lo = Math.max(s, t0);
          const hi = Math.min(e, t1);
          for (let i = Math.max(marked + 1, Math.floor((lo - base) / res)); i < bs.length && base + i * res < hi; i++) {
            counts[i]++;
            marked = i;
          }
        });
      }
      return bs.map(([s, e], i) => ({ startTs: iso(s), endTs: iso(e), clientCount: counts[i] }));
    },
  },
  {
    path: '/networks/{networkId}/wireless/usageHistory',
    handler: (ctx) => {
      const net = netOf(ctx);
      const scope = wirelessScope(ctx, net);
      const { t0, t1, res, bs } = historyWindow(ctx);
      const base = bs.length ? bs[0][0] : t0;
      const sent = new Array(bs.length).fill(0);
      const recv = new Array(bs.length).fill(0);
      if (scope.filtered) {
        for (const c of scope.clients) {
          eachSlot(c, t0, t1, (slot, s, r) => {
            const i = Math.floor((slot * SLOT - base) / res);
            sent[i] += s;
            recv[i] += r;
          });
        }
      } else {
        bs.forEach(([s, e], i) => {
          [sent[i], recv[i]] = networkTotals(net, Math.max(s, t0), Math.min(e, t1), [WL_SENT, WL_RECV]);
        });
      }
      return bs.map(([s, e], i) => {
        const secs = Math.min(e, t1) - Math.max(s, t0);
        const kbps = (kb) => Math.round((kb * 8) / secs);
        return { startTs: iso(s), endTs: iso(e), totalKbps: kbps(sent[i] + recv[i]), sentKbps: kbps(sent[i]), receivedKbps: kbps(recv[i]) };
      });
    },
  },
  {
    path: '/networks/{networkId}/wireless/connectionStats',
    handler: (ctx) => {
      const { clients } = wirelessScope(ctx, netOf(ctx));
      const { t0, t1 } = statsWindow(ctx);
      return connectionStats(clients, t0, t1);
    },
  },
  {
    path: '/networks/{networkId}/wireless/latencyStats',
    handler: (ctx) => {
      const { latencyAps } = wirelessScope(ctx, netOf(ctx));
      const { t0, t1 } = statsWindow(ctx);
      return latencyStats(latencyAps, t0, t1, ctx.query.get('fields'));
    },
  },
  {
    path: '/networks/{networkId}/wireless/devices/connectionStats',
    handler: (ctx) => {
      const { aps, clients } = wirelessScope(ctx, netOf(ctx));
      const { t0, t1 } = statsWindow(ctx);
      return [...aps].sort(bySerial).map((ap) => ({ serial: ap.serial, connectionStats: connectionStats(clients.filter((c) => c.ap === ap), t0, t1) }));
    },
  },
  {
    path: '/networks/{networkId}/wireless/devices/latencyStats',
    handler: (ctx) => {
      const { latencyAps } = wirelessScope(ctx, netOf(ctx));
      const { t0, t1 } = statsWindow(ctx);
      const fields = ctx.query.get('fields');
      return [...latencyAps].sort(bySerial).map((ap) => ({ serial: ap.serial, latencyStats: latencyStats([ap], t0, t1, fields) }));
    },
  },
  {
    path: '/networks/{networkId}/wireless/ssids',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'wireless');
      return Array.from({ length: 15 }, (_, n) => ssidJson(net, n));
    },
  },
  {
    path: '/networks/{networkId}/wireless/ssids/{number}',
    handler: (ctx) => {
      const net = netOf(ctx);
      requireProduct(net, 'wireless');
      const n = Number(ctx.params.number);
      if (!Number.isInteger(n) || n < 0 || n > 14) throw notFound('SSID');
      return ssidJson(net, n);
    },
  },
];
