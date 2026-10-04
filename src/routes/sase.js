// Secure Access (SASE): the organization's integration, the regions sites can
// attach in, the connectors deployed in them, and attached sites with their
// connectivity. Everything is empty until an integration is created, and
// deleting it detaches every site. Sites name networks (or templates) by ID,
// so world.js repoints them and a gone network's site drops out on read.

import { configOf } from '../config.js';
import { arrayParam, badRequest, notFound, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { linkSample } from '../sim/links.js';
import { activeUplink, isDown, uplinkUp } from '../sim/outages.js';
import { iso } from '../time.js';
import { localSubnets } from './appliance.js';
import { orgOf } from './common.js';
import { roles } from './firewall.js';

const ORG = '/organizations/{organizationId}/sase';
// How long an attach takes on a running clock before the tunnels come up.
const ATTACH_SECONDS = 120;
const MAX_SPOKES = 2500;
const MAX_HUBS = 100;
const MAX_CONNECTOR_DELETES = 20;
const MAX_SITE_IDS = 100;
const MAX_SPAN = 7 * 86400;
// A tunnel over an uplink this lossy or slow counts as bad.
const BAD_LOSS = 5;
const BAD_LATENCY = 150;

export const REGIONS = [
  { slug: 'us-west-1', name: 'US West', lat: 37.4, lng: -121.9 },
  { slug: 'us-east-1', name: 'US East', lat: 39.0, lng: -77.5 },
  { slug: 'ca-central-1', name: 'Canada Central', lat: 45.5, lng: -73.6 },
  { slug: 'eu-west-1', name: 'EU West', lat: 53.3, lng: -6.3 },
  { slug: 'eu-central-1', name: 'EU Central', lat: 50.1, lng: 8.7 },
  { slug: 'ap-southeast-1', name: 'Asia Pacific Southeast', lat: 1.3, lng: 103.8 },
  { slug: 'ap-northeast-1', name: 'Asia Pacific Northeast', lat: 35.7, lng: 139.7 },
  { slug: 'ap-southeast-2', name: 'Australia East', lat: -33.9, lng: 151.2 },
];
const SITE_STATUSES = ['bad NAT', 'bad tunnel', 'dormant', 'good', 'many bad tunnels', 'no registry', 'offline'];
const OVERVIEW = { good: 'healthy', offline: 'offline', dormant: 'offline', 'no registry': 'offline' };

const saseOf = (org) => (org.sase ??= { integration: null, ids: { site: 0, connector: 0, pipeline: 0 }, sites: [], connectors: [] });
const regionOf = (slug) => REGIONS.find((r) => r.slug === slug);

// The region nearest a network, by great circle distance.
function nearestRegion(net) {
  if (net.lat == null) return REGIONS[0];
  const rad = Math.PI / 180;
  const dist = (r) => {
    const x = Math.sin(((r.lat - net.lat) * rad) / 2) ** 2 + Math.cos(net.lat * rad) * Math.cos(r.lat * rad) * Math.sin(((r.lng - net.lng) * rad) / 2) ** 2;
    return Math.asin(Math.sqrt(x));
  };
  return REGIONS.reduce((a, b) => (dist(b) < dist(a) ? b : a));
}

// What a site names: a network of the organization or a template. A network
// keeps its site while it has no MX (offline) or is bound to a template.
function siteTarget(org, id) {
  const net = org.networks.find((n) => n.id === id);
  if (net) return { net };
  const template = org.configTemplates?.list.find((x) => x.id === id);
  return template ? { template } : null;
}

// What can be attached: an MX network not bound to a template, or a template
// with the appliance product.
function targetOf(org, id) {
  const x = siteTarget(org, id);
  if (x?.net) return x.net.mx && !x.net.template ? x : null;
  return x?.template.productTypes.includes('appliance') ? x : null;
}

function targets(org) {
  const nets = org.networks.filter((n) => n.mx && !n.template).map((net) => ({ net }));
  const temps = (org.configTemplates?.list ?? []).filter((t) => t.productTypes.includes('appliance')).map((template) => ({ template }));
  return [...nets, ...temps].sort((a, b) => (idOf(a) < idOf(b) ? -1 : 1));
}

const idOf = (x) => (x.net ?? x.template).id;
const vpnMode = (x) => {
  const mode = x.net ? configOf(x.net).siteToSite.mode : x.template.config?.siteToSite?.mode;
  return mode === 'hub' || mode === 'spoke' ? mode : 'off';
};
const typeOf = (x) => (x.template ? 'Meraki template' : vpnMode(x) === 'hub' ? 'Meraki hub' : 'Meraki spoke');
const subnetsOf = (x) => {
  const c = x.net ? configOf(x.net) : x.template.config;
  return c ? localSubnets(c).map((subnet) => ({ subnet })) : [];
};

// Sites whose network or template is still there, with what they name.
function liveSites(org) {
  return (org.sase?.sites ?? []).flatMap((s) => {
    const x = siteTarget(org, s.networkId);
    return x ? [{ s, ...x }] : [];
  });
}

// Warm spare roles, without building the warm spare settings on a read.
const mxRoles = (net) => (net.warmSpare ? roles(net) : { primary: net.mx, spare: null });

const usesSaseIn = (org, id) => (org.sase?.sites ?? []).some((s) => s.networkId === id);
export const usesSase = (net) => usesSaseIn(net.org, net.id);

// ── Connectivity ──

const badLink = (mx, u, t) => {
  const l = linkSample(mx, u, t);
  return l.lossPercent >= BAD_LOSS || l.latencyMs >= BAD_LATENCY;
};

// A site's status at t, from its primary MX and the uplink carrying its tunnels.
function siteStatus(site, t) {
  if (t < site.s.attachedAt) return 'unknown';
  if (!site.net) return 'dormant';
  if (t < site.s.readyAt) return 'no registry';
  const mx = mxRoles(site.net).primary;
  if (!mx || isDown(mx, t)) return 'offline';
  const up = activeUplink(mx, t);
  if (!up) return 'offline';
  if (!badLink(mx, up, t)) return 'good';
  const ups = mx.uplinks.filter((u) => uplinkUp(mx, u, t));
  return ups.length > 1 && ups.every((u) => badLink(mx, u, t)) ? 'many bad tunnels' : 'bad tunnel';
}

// The spare carries no tunnels while the primary is up.
function spareStatus(site, spare, t) {
  if (t < site.s.attachedAt) return 'unknown';
  if (isDown(spare, t)) return 'offline';
  return siteStatus(site, t) === 'offline' ? 'good' : 'dormant';
}

const devicesOf = (site) => {
  if (!site.net) return { primary: null, spare: null };
  const { primary, spare } = mxRoles(site.net);
  return { primary, spare };
};
const deviceRef = (d) => (d ? { name: d.name || d.mac, model: d.model } : null);

// The update answers the site without its devices, subnets and URL.
function siteJson(site, full) {
  const x = site;
  const { primary, spare } = devicesOf(site);
  const out = {
    siteId: site.s.siteId,
    network: { id: idOf(x) },
    type: typeOf(x),
    name: (x.net ?? x.template).name,
    region: { slug: site.s.region },
    model: primary?.model ?? null,
    address: { street: x.net?.address ?? null },
    vpn: { type: vpnMode(x) },
    routing: { defaultRoute: { enabled: site.s.defaultRoute } },
  };
  if (!full) return out;
  const devices = { primary: deviceRef(primary) };
  if (spare) devices.spare = deviceRef(spare);
  return { ...out, devices, subnets: subnetsOf(x), url: x.net?.url ?? null };
}

// ── Integration ──

function integrationJson(i) {
  return {
    integrationId: i.integrationId,
    integrated: { by: { admin: { name: i.adminName } }, at: iso(i.createdAt) },
    lastUsedAt: iso(i.lastUsedAt),
    external: { organization: { id: i.externalId } },
    status: 'active',
  };
}

function integrationOf(ctx) {
  const org = orgOf(ctx);
  const i = org.sase?.integration;
  if (!i || i.integrationId !== ctx.params.integrationId) throw notFound('Secure Access integration');
  return org;
}

// The store that attach, detach and connector writes go through.
function requireIntegration(org) {
  if (!org.sase?.integration) throw badRequest('The organization has no Secure Access integration');
  return org.sase;
}

const used = (store, now) => (store.integration.lastUsedAt = now);

const secret = (v, at) => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`'${at}' must not be empty`);
  return v;
};

function createIntegration(ctx) {
  const org = orgOf(ctx);
  const api = ctx.body.api;
  if (api == null) throw badRequest("'api' is required");
  const key = secret(api.key, 'api.key');
  const sec = secret(api.secret, 'api.secret');
  if (org.sase?.integration) throw badRequest('The organization already has a Secure Access integration');
  const store = saseOf(org);
  store.ids.integration = (store.ids.integration ?? 0) + 1;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:saseIntegration:${org.id}:${store.ids.integration}`));
  store.integration = { integrationId: r.digits(6), externalId: r.digits(10), key, secret: sec, adminName: ctx.world.apiAdmin.name, createdAt: ctx.now, lastUsedAt: ctx.now };
  return integrationJson(store.integration);
}

// ── Pipelines ──

// The answer for a pipeline of jobs, done at once under a frozen clock.
function pipeline(ctx, store, op, jobs) {
  store.ids.pipeline++;
  const counts = (n) => ({ completed: ctx.frozen ? n : 0, failed: 0, pending: ctx.frozen ? 0 : n });
  const used = jobs.filter(([, n]) => n > 0);
  const total = used.reduce((a, [, n]) => a + n, 0);
  return {
    pipelineId: String(9000 + store.ids.pipeline),
    operation: { id: op },
    status: ctx.frozen ? 'completed' : 'active',
    counts: { jobs: { total, byStatus: counts(total) }, byJobOperation: used.map(([name, n]) => ({ name, total: n, byStatus: counts(n) })) },
  };
}

// ── Sites ──

function attachSites(ctx) {
  const org = orgOf(ctx);
  const store = requireIntegration(org);
  const items = ctx.body.items;
  if (!items?.length) throw badRequest("'items' must list at least one site");
  const seen = new Set();
  const live = liveSites(org);
  const checked = items.map((it, i) => {
    const id = it?.network?.id;
    if (typeof id !== 'string') throw badRequest(`'items[${i}].network.id' is required`);
    const x = targetOf(org, id);
    if (!x) throw badRequest(`'items[${i}].network.id' ${id} is not an MX network or appliance template in this organization`);
    if (seen.has(id)) throw badRequest(`Network ${id} is listed twice`);
    seen.add(id);
    if (live.some((s) => s.s.networkId === id)) throw badRequest(`Network ${id} is already attached to Secure Access`);
    const region = regionOf(it.region?.slug);
    if (!region) throw badRequest(`'items[${i}].region.slug' must be one of: ${REGIONS.map((r) => r.slug).join(', ')}`);
    return { x, region };
  });
  const hubs = [...live, ...checked.map((c) => c.x)].filter((x) => vpnMode(x) === 'hub').length;
  if (hubs > MAX_HUBS) throw badRequest(`At most ${MAX_HUBS} sites in hub mode can be attached to Secure Access`);
  if (live.length + checked.length - hubs > MAX_SPOKES) throw badRequest(`At most ${MAX_SPOKES} sites in spoke mode can be attached to Secure Access`);
  used(store, ctx.now);
  const readyAt = ctx.frozen ? ctx.now : ctx.now + ATTACH_SECONDS;
  let deployed = 0;
  for (const { x, region } of checked) {
    if (!store.connectors.some((c) => c.region === region.slug)) {
      store.ids.connector++;
      store.connectors.push({ id: String(100 + store.ids.connector), region: region.slug, readyAt });
      deployed++;
    }
    store.ids.site++;
    store.sites.push({ siteId: String(1000 + store.ids.site), networkId: idOf(x), region: region.slug, defaultRoute: true, attachedAt: ctx.now, readyAt });
  }
  return pipeline(ctx, store, 'attachOrganizationSaseSites', [['enroll wired site', checked.length], ['deploy CNHE SSE connector', deployed], ['complete bulk enrollment', 1]]);
}

function detachSites(ctx) {
  const org = orgOf(ctx);
  const store = requireIntegration(org);
  const items = ctx.body.items;
  if (!items?.length) throw badRequest("'items' must list at least one site");
  const sites = org.sase?.sites ?? [];
  const ids = new Set();
  items.forEach((it, i) => {
    const id = it?.siteId;
    if (typeof id !== 'string') throw badRequest(`'items[${i}].siteId' is required`);
    if (!sites.some((s) => s.siteId === id)) throw badRequest(`'items[${i}].siteId' ${id} is not a Secure Access site in this organization`);
    if (ids.has(id)) throw badRequest(`Site ${id} is listed twice`);
    ids.add(id);
  });
  used(store, ctx.now);
  store.sites = store.sites.filter((s) => !ids.has(s.siteId));
  return pipeline(ctx, store, 'detachOrganizationSaseSites', [['detach wired site', ids.size], ['complete bulk detachment', 1]]);
}

function siteOf(ctx) {
  const org = orgOf(ctx);
  const site = liveSites(org).find((s) => s.s.siteId === ctx.params.siteId);
  if (!site) throw notFound('Secure Access site');
  return { org, site };
}

function updateSite(ctx) {
  const { org, site } = siteOf(ctx);
  const b = ctx.body;
  if (b.siteId != null && b.siteId !== site.s.siteId) throw badRequest(`'siteId' ${b.siteId} does not match the site in the URL`);
  const enabled = b.routing?.defaultRoute?.enabled;
  if (b.routing != null && typeof enabled !== 'boolean') throw badRequest("'routing.defaultRoute.enabled' must be a boolean");
  if (typeof enabled === 'boolean') site.s.defaultRoute = enabled;
  used(org.sase, ctx.now);
  return siteJson(site, false);
}

function listSites(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const search = (q.get('search') ?? '').toLowerCase();
  const status = q.get('status');
  if (status && !SITE_STATUSES.includes(status)) throw badRequest(`'status' must be one of: ${SITE_STATUSES.join(', ')}`);
  const siteId = q.get('siteId');
  const rows = liveSites(org)
    .filter((s) => !siteId || s.s.siteId === siteId)
    .filter((s) => !search || (s.net ?? s.template).name.toLowerCase().includes(search))
    .filter((s) => !status || siteStatus(s, ctx.now) === status)
    .sort((a, b) => Number(a.s.siteId) - Number(b.s.siteId));
  return paginateItems(ctx, rows, (s) => s.s.siteId, { def: 10, max: 1000 }, (s) => siteJson(s, true));
}

// '-2hours', '2 hours', '7200' or '-7200s'; the span looking back from now.
const UNITS = { s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hour: 3600, d: 86400, day: 86400 };
function spanParam(q) {
  const v = q.get('timespan');
  if (v == null || v === '') return 7200;
  const m = /^-?\s*(\d+(?:\.\d+)?)\s*([a-z]*?)s?$/i.exec(v.trim());
  const unit = m && (m[2] === '' ? 1 : UNITS[m[2].toLowerCase()]);
  const span = m && unit ? Number(m[1]) * unit : NaN;
  if (!(span > 0 && span <= MAX_SPAN)) throw badRequest("'timespan' must be a span such as '-2hours', at most 7 days");
  return span;
}

function history(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'siteIds');
  if (ids.length > MAX_SITE_IDS) throw badRequest(`'siteIds' takes at most ${MAX_SITE_IDS} values`);
  const span = spanParam(ctx.query);
  const step = span <= 86400 ? 300 : 3600;
  const times = [];
  for (let t = Math.ceil((ctx.now - span) / step) * step; t <= ctx.now; t += step) times.push(t);
  const items = liveSites(org)
    .filter((s) => !ids.length || ids.includes(s.s.siteId))
    .sort((a, b) => Number(a.s.siteId) - Number(b.s.siteId))
    .map((s) => {
      const { primary, spare } = devicesOf(s);
      const devices = {};
      if (primary) devices.primary = { id: primary.serial, history: times.map((t) => ({ status: siteStatus(s, t), timestamp: iso(t) })) };
      if (spare) devices.spare = { id: spare.serial, history: times.map((t) => ({ status: spareStatus(s, spare, t), timestamp: iso(t) })) };
      return { siteId: s.s.siteId, name: (s.net ?? s.template).name, history: times.map((t) => ({ status: siteStatus(s, t), timestamp: iso(t) })), devices };
    });
  return { items };
}

function overview(ctx) {
  const org = orgOf(ctx);
  const byStatus = { healthy: { total: 0 }, degraded: { total: 0 }, offline: { total: 0 } };
  const sites = liveSites(org);
  for (const s of sites) byStatus[OVERVIEW[siteStatus(s, ctx.now)] ?? 'degraded'].total++;
  return { counts: { byStatus, total: sites.length } };
}

// ── Eligible networks, regions and connectors ──

function eligible(ctx) {
  const org = orgOf(ctx);
  const search = (ctx.query.get('search') ?? '').toLowerCase();
  const attached = new Set(liveSites(org).map((s) => s.s.networkId));
  const rows = targets(org).filter((x) => !attached.has(idOf(x)) && (!search || (x.net ?? x.template).name.toLowerCase().includes(search)));
  return paginateItems(ctx, rows, idOf, { def: 5, max: 1000 }, (x) => ({
    networkId: idOf(x),
    type: typeOf(x),
    name: (x.net ?? x.template).name,
    region: { name: (x.net ? nearestRegion(x.net) : REGIONS[0]).name },
    device: { primary: { model: x.net ? mxRoles(x.net).primary?.model ?? null : null } },
    address: { street: x.net?.address ?? null },
    vpn: { type: vpnMode(x) },
    routing: { defaultRoute: { enabled: true } },
  }));
}

const connectorsOf = (org) => org.sase?.connectors ?? [];
const everything = (items) => ({ items, meta: { counts: { items: { total: items.length, remaining: 0 } } } });

function connectorJson(org, c, now) {
  const r = regionOf(c.region);
  const connected = liveSites(org).filter((s) => s.s.region === c.region && now >= s.s.readyAt).length;
  return { id: c.id, name: `${r.slug}-connector`, region: { name: r.name, slug: r.slug }, state: now < c.readyAt ? 'provisioned' : 'deployed', counts: { sitesConnected: { total: connected } } };
}

function deleteConnectors(ctx) {
  const org = orgOf(ctx);
  const store = requireIntegration(org);
  const items = ctx.body.items;
  if (!items?.length) throw badRequest("'items' must list at least one connector");
  if (items.length > MAX_CONNECTOR_DELETES) throw badRequest(`'items' takes at most ${MAX_CONNECTOR_DELETES} connectors`);
  const live = liveSites(org);
  const ids = new Set();
  items.forEach((it, i) => {
    const id = it?.connectorId;
    if (typeof id !== 'string') throw badRequest(`'items[${i}].connectorId' is required`);
    const c = connectorsOf(org).find((x) => x.id === id);
    if (!c) throw badRequest(`'items[${i}].connectorId' ${id} is not a connector in this organization`);
    if (live.some((s) => s.s.region === c.region)) throw badRequest(`Connector ${id} still has sites attached in ${c.region}; detach them first`);
    ids.add(id);
  });
  used(store, ctx.now);
  store.connectors = store.connectors.filter((c) => !ids.has(c.id));
  return pipeline(ctx, store, 'batchOrganizationSaseConnectorsDelete', [['teardown CNHE SSE connector', ids.size]]);
}

// Samples: a site or connector made at runtime, else one that answers 404.
const SITE = (world) => world.orgs[0].sase?.sites[0]?.siteId ?? '1001';
const INTEGRATION = (world) => world.orgs[0].sase?.integration?.integrationId ?? '100000';

export default [
  {
    op: 'getOrganizationSaseConnectors',
    path: `${ORG}/connectors`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      return { items: connectorsOf(org).map((c) => connectorJson(org, c, ctx.now)) };
    },
  },
  { op: 'batchOrganizationSaseConnectorsDelete', method: 'POST', path: `${ORG}/connectors/batchDelete`, status: 202, handler: deleteConnectors },
  { op: 'createOrganizationSaseIntegration', method: 'POST', path: `${ORG}/integrations`, handler: createIntegration },
  { op: 'getOrganizationSaseIntegration', path: `${ORG}/integrations/{integrationId}`, sample: { integrationId: INTEGRATION, status: 404 }, handler: (ctx) => integrationJson(integrationOf(ctx).sase.integration) },
  {
    op: 'deleteOrganizationSaseIntegration',
    method: 'DELETE',
    path: `${ORG}/integrations/{integrationId}`,
    sample: { integrationId: INTEGRATION },
    handler: (ctx) => {
      const store = integrationOf(ctx).sase;
      Object.assign(store, { integration: null, sites: [], connectors: [] });
    },
  },
  { op: 'getOrganizationSaseNetworksEligible', path: `${ORG}/networks/eligible`, handler: eligible },
  {
    op: 'getOrganizationSaseRegions',
    path: `${ORG}/regions`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      return everything(REGIONS.map((r) => ({ connector: { id: connectorsOf(org).find((c) => c.region === r.slug)?.id ?? null }, type: 'Cloud Native Head End', name: r.name, slug: r.slug })));
    },
  },
  { op: 'getOrganizationSaseSites', path: `${ORG}/sites`, handler: listSites },
  { op: 'attachOrganizationSaseSites', method: 'POST', path: `${ORG}/sites/attach`, status: 202, handler: attachSites },
  { op: 'getOrganizationSaseSitesConnectivityHistoryBySite', path: `${ORG}/sites/connectivity/history/bySite`, handler: history },
  { op: 'getOrganizationSaseSitesConnectivityOverview', path: `${ORG}/sites/connectivity/overview`, handler: overview },
  { op: 'detachOrganizationSaseSites', method: 'POST', path: `${ORG}/sites/detach`, status: 202, handler: detachSites },
  { op: 'updateOrganizationSaseSite', method: 'PUT', path: `${ORG}/sites/{siteId}`, sample: { siteId: SITE }, handler: updateSite },
];
