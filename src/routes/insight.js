// Meraki Insight: the tracked applications with their thresholds, each
// application's health over time on a network, and the organization's
// monitored media servers. Health comes from the same traffic and WAN link
// samples the traffic analysis and uplink routes use.

import { APPS } from '../catalog.js';
import { badRequest, notFound, resolutionParam, timeWindow } from '../http.js';
import { Rand, derive, hashStr, unit } from '../rng.js';
import { activeUplink } from '../sim/outages.js';
import { isOnline } from '../sim/presence.js';
import { appWeights } from '../sim/traffic.js';
import { linkAverage } from '../sim/links.js';
import { WAN_RECV, WAN_SENT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, buckets, clientsUsage, networkTotals } from '../sim/usage.js';
import { DAY, HOUR, iso } from '../time.js';
import { isHostname, parseIp } from '../validate.js';
import { collection, mxNet, mxNets, orgOf, round } from './common.js';

const ORG = '/organizations/{organizationId}';
const MAX_SERVERS = 100;

// The applications Insight tracks, a fixed subset of the traffic catalog.
const TRACKED = [
  ['13.1', 'Microsoft 365'],
  ['13.4', 'Salesforce'],
  ['13.7', 'Slack'],
  ['16.2', 'Zoom'],
  ['16.5', 'Webex'],
  ['19.12', 'Google HTTPS'],
  ['21.3', 'Dropbox'],
  ['24.9', 'Amazon AWS'],
].map(([applicationId, name]) => ({ applicationId, name, index: APPS.findIndex((a) => a.application === name) }));

// Smart thresholds Meraki would learn for each network, from the seed.
function thresholds(app, nets) {
  return {
    type: 'smart',
    byNetwork: nets.map((n) => {
      const k = derive(n.key, `insight:${app.applicationId}`);
      return { networkId: n.id, goodput: 20000 + Math.round(unit(k, 0) * 16) * 5000, responseDuration: 500 + Math.round(unit(k, 1) * 15) * 100 };
    }),
  };
}

function appOf(ctx) {
  const app = TRACKED.find((a) => a.applicationId === ctx.params.applicationId);
  if (!app) throw notFound('Application');
  return app;
}

// The guest share of WAN bytes over [a, b), which skews the application mix
// the way it does in the traffic analysis rows.
function guestShare(net, a, b) {
  const [sent, recv] = networkTotals(net, a, b, [WAN_SENT, WAN_RECV]);
  if (!(sent + recv > 0)) return 0;
  const g = clientsUsage(net.clients.filter((c) => c.kindName === 'guest'), a, b);
  return Math.min(1, (g.sent + g.recv) / (sent + recv));
}

// One bucket per resolution step. Bytes are the application's share of the
// network's WAN and LAN totals; latency and loss come from the active uplink.
function healthByTime(ctx) {
  const net = mxNet(ctx);
  const app = appOf(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, defaultSpan: 2 * HOUR, lookback: 7 * DAY });
  const res = resolutionParam(ctx.query, [60, 300, 3600, 86400], 300, t1 - t0);
  const days = new Map();
  const mixOf = (day) => {
    if (!days.has(day)) days.set(day, appWeights(net, guestShare(net, Math.max(day * DAY, t0), Math.min((day + 1) * DAY, t1)), day));
    const w = days.get(day);
    return { share: w.weights[app.index] / w.wSum, up: w.upWeights[app.index] / w.upSum };
  };
  const mx = net.mx;
  const lanKey = derive(net.key, `insightLan:${app.applicationId}`);
  const serverMs = 40 + (hashStr(app.name) % 120);
  return buckets(t0, t1, res).map(([s, e]) => {
    const a = Math.max(s, t0);
    const b = Math.min(e, t1);
    const secs = Math.max(1, b - a);
    const { share, up } = mixOf(Math.floor(a / DAY));
    const [ws, wr] = networkTotals(net, a, b, [WAN_SENT, WAN_RECV]);
    const lan = networkTotals(net, a, b, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
    const sent = ws * up;
    const recv = wr * share;
    const lanKb = (lan[0] + lan[2]) * up + (lan[1] + lan[3]) * share;
    const uplink = mx && activeUplink(mx, (a + b) / 2);
    const link = uplink ? linkAverage(mx, uplink, a, b, app.name) : null;
    const wanLoss = link ? link.lossPercent : 100;
    const mid = (a + b) / 2;
    const online = net.clients.reduce((n, c) => n + (isOnline(c, mid) ? 1 : 0), 0);
    const lanLatency = round(0.8 + unit(lanKey, Math.floor(a / 60)) * 2.4, 1);
    return {
      startTs: iso(s),
      endTs: iso(e),
      wanGoodput: Math.round((((sent + recv) * 8000) / secs) * (1 - wanLoss / 100)),
      lanGoodput: Math.round((lanKb * 8000) / secs),
      wanLatencyMs: link?.latencyMs ?? null,
      lanLatencyMs: lanLatency,
      wanLossPercent: wanLoss,
      lanLossPercent: 0,
      responseDuration: link?.latencyMs != null ? Math.round(serverMs + link.latencyMs * 3 + lanLatency) : null,
      sent: Math.round(sent / secs),
      recv: Math.round(recv / secs),
      numClients: sent + recv > 0 ? Math.max(1, Math.round(online * Math.min(1, share * 7))) : 0,
    };
  });
}

// ── Monitored media servers ──

const serversOf = (org) => (org.insightMediaServers ??= { created: 0, list: [] });

function nextServerId(ctx, store, org) {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:insightMediaServer:${org.id}:${store.created}`));
  let id;
  do id = r.digits(13);
  while (store.list.some((x) => x.id === id));
  return id;
}

function checkServer(b) {
  if (b.address == null) return;
  if (typeof b.address !== 'string' || !b.address.trim()) throw badRequest("'address' must not be empty");
  if (b.address.includes(':')) throw badRequest("'address' must be an IPv4 address or a hostname");
  if (parseIp(b.address) == null && !isHostname(b.address)) throw badRequest("'address' must be an IPv4 address or a hostname");
}

const servers = collection({
  ops: {
    list: 'getOrganizationInsightMonitoredMediaServers',
    create: 'createOrganizationInsightMonitoredMediaServer',
    get: 'getOrganizationInsightMonitoredMediaServer',
    update: 'updateOrganizationInsightMonitoredMediaServer',
    delete: 'deleteOrganizationInsightMonitoredMediaServer',
  },
  path: `${ORG}/insight/monitoredMediaServers`,
  param: 'monitoredMediaServerId',
  parent: orgOf,
  store: serversOf,
  scope: 'organization',
  what: 'monitored media server',
  nextId: nextServerId,
  max: MAX_SERVERS,
  required: ['name', 'address'],
  check: (ctx, org, b) => checkServer(b),
  blank: () => ({ name: '', address: '', bestEffortMonitoringEnabled: false }),
  apply: (x, b) => {
    for (const k of ['name', 'address', 'bestEffortMonitoringEnabled']) if (b[k] != null) x[k] = b[k];
  },
  json: (x) => ({ id: x.id, name: x.name, address: x.address, bestEffortMonitoringEnabled: x.bestEffortMonitoringEnabled }),
  missing: { monitoredMediaServerId: '1000000000000', status: 404 },
});

export default [
  {
    op: 'getNetworkInsightApplicationHealthByTime',
    path: '/networks/{networkId}/insight/applications/{applicationId}/healthByTime',
    sample: { applicationId: '13.1' },
    handler: healthByTime,
  },
  {
    op: 'getOrganizationInsightApplications',
    path: `${ORG}/insight/applications`,
    handler: (ctx) => {
      const nets = mxNets(orgOf(ctx), []);
      return TRACKED.map((a) => ({ applicationId: a.applicationId, name: a.name, thresholds: thresholds(a, nets) }));
    },
  },
  ...servers.routes,
];
