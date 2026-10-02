// Assurance alerts across the organization: the list and its overviews,
// dismissing and restoring, alert profiles and the alert taxonomy. Also the
// older per-network health alerts view.

import { configOf } from '../config.js';
import { deviceUrl } from '../format.js';
import { ApiError, arrayParam, badRequest, boolParam, hasTags, notFound, paginate } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { ALERT_CATEGORIES, ALERT_TYPES, DEVICE_TYPE, LOOKBACK, orgAlerts } from '../sim/alerts.js';
import { DAY, iso, parseTime } from '../time.js';
import { isAlertType } from '../validate.js';
import { netOf, orgOf } from './common.js';

const SORT_BY = ['startedAt', 'resolvedAt', 'dismissedAt', 'severity', 'category'];
const SEVERITIES = ['critical', 'warning', 'informational'];
const SEVERITY_RANK = { critical: 0, warning: 1, informational: 2 };
const MAX_SEGMENTS = 1000;
const MAX_PROFILES = 100;

// Groups by type come in the order their first alert started unless sorted by something else.
const GROUP_SORT = {
  startedAt: () => 0,
  count: (r) => r.count,
  lastAlertedAt: (r) => r.lastAlertedAt,
  networkCount: (r) => r.networkCount,
  severity: (r) => SEVERITY_RANK[r.severity],
};

const dismissedAt = (a) => a.net.org.dismissedAlerts?.get(a.id) ?? null;

// Each alert is in one state: dismissed once someone dismisses it, otherwise active until it resolves.
const stateOf = (a) => (dismissedAt(a) != null ? 'dismissed' : a.resolvedAt == null ? 'active' : 'resolved');

function alertJson(a) {
  const device = { url: deviceUrl(a.dev), name: a.dev.name, order: 0, productType: a.dev.productType, serial: a.dev.serial, mac: a.dev.mac };
  if (a.port) device.lldp = { port: a.port };
  const dismissed = dismissedAt(a);
  return {
    id: a.id,
    categoryType: a.categoryType,
    network: { name: a.net.name, id: a.net.id, url: a.net.url },
    startedAt: iso(a.startedAt),
    resolvedAt: a.resolvedAt == null ? null : iso(a.resolvedAt),
    dismissedAt: dismissed == null ? null : iso(dismissed),
    deviceType: DEVICE_TYPE[a.dev.productType],
    type: a.type,
    title: a.title,
    description: a.description,
    severity: a.severity,
    scope: { devices: [device] },
  };
}

function time(q, name) {
  if (!q.has(name)) return null;
  const t = parseTime(q.get(name));
  if (Number.isNaN(t)) throw badRequest(`'${name}' must be an ISO 8601 timestamp`);
  return t;
}

function sortOrder(q) {
  const order = q.get('sortOrder') || 'ascending';
  if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
  return order;
}

// The filters every alert view takes, historical included.
function matcher(q) {
  const [types, serials, deviceTypes] = ['types', 'serials', 'deviceTypes'].map((n) => arrayParam(q, n));
  const networkId = q.get('networkId');
  const severity = q.get('severity');
  const category = q.get('category');
  return (a) =>
    (!networkId || a.net.id === networkId) &&
    (!severity || a.severity === severity) &&
    (!category || a.categoryType === category) &&
    (!types.length || types.includes(a.type)) &&
    (!serials.length || serials.includes(a.dev.serial)) &&
    (!deviceTypes.length || deviceTypes.includes(DEVICE_TYPE[a.dev.productType]));
}

// Active alerts by default; resolved and dismissed ones only when asked for.
function filtered(ctx) {
  const q = ctx.query;
  const show = { active: boolParam(q, 'active', true), resolved: boolParam(q, 'resolved', false), dismissed: boolParam(q, 'dismissed', false) };
  const deviceTags = arrayParam(q, 'deviceTags');
  const from = time(q, 'tsStart');
  const to = time(q, 'tsEnd');
  const match = matcher(q);
  const all = orgAlerts(orgOf(ctx), ctx.world, ctx.now);
  // A device that is down right now only shows its connectivity alerts.
  const suppress = boolParam(q, 'suppressAlertsForOfflineNodes', false) && !show.resolved;
  const offline = suppress ? new Set(all.filter((a) => a.type === 'unreachable' && a.resolvedAt == null).map((a) => a.dev)) : null;
  return all.filter(
    (a) =>
      show[stateOf(a)] &&
      match(a) &&
      hasTags(a.dev.tags, deviceTags, 'withAnyTags') &&
      (from == null || a.startedAt >= from) &&
      (to == null || a.startedAt <= to) &&
      (!offline || !offline.has(a.dev) || a.categoryType === 'connectivity'),
  );
}

function sorted(ctx, alerts) {
  const by = ctx.query.get('sortBy') || 'startedAt';
  if (!SORT_BY.includes(by)) throw badRequest(`'sortBy' must be one of: ${SORT_BY.join(', ')}`);
  const order = sortOrder(ctx.query);
  const key = {
    startedAt: (a) => a.startedAt,
    resolvedAt: (a) => a.resolvedAt ?? Infinity,
    dismissedAt: (a) => dismissedAt(a) ?? Infinity,
    severity: (a) => SEVERITY_RANK[a.severity],
    category: (a) => a.categoryType,
  }[by];
  const out = [...alerts].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.startedAt - b.startedAt));
  return order === 'descending' ? out.reverse() : out;
}

function severityCounts(alerts) {
  return SEVERITIES.map((type) => ({ type, count: alerts.filter((a) => a.severity === type).length })).filter((s) => s.count);
}

// Alerts come oldest first, so groups keep the order their first alert started.
function groupBy(alerts, keyOf) {
  const groups = new Map();
  for (const a of alerts) {
    const k = keyOf(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  return [...groups.values()];
}

const latest = (alerts, f) => Math.max(...alerts.map(f));
const uniqueSorted = (values) => [...new Set(values)].sort();

function overviewByNetwork(ctx) {
  const order = sortOrder(ctx.query);
  const rows = groupBy(filtered(ctx), (a) => a.net).map((list) => ({
    networkId: list[0].net.id,
    networkName: list[0].net.name,
    alertCount: list.length,
    lastAlertedAt: iso(latest(list, (a) => a.startedAt)),
    severityCounts: severityCounts(list),
  }));
  if (order === 'descending') rows.reverse();
  const items = paginate(ctx, rows, (r) => r.networkId, { def: 1000, max: 1000 });
  return { items, meta: { counts: { items: rows.length } } };
}

// One row per alert type and severity. Tags and networks are only listed when asked for.
function overviewByType(ctx) {
  const q = ctx.query;
  const by = q.get('sortBy') || 'startedAt';
  if (!Object.hasOwn(GROUP_SORT, by)) throw badRequest(`'sortBy' must be one of: ${Object.keys(GROUP_SORT).join(', ')}`);
  const order = sortOrder(q);
  const withTags = boolParam(q, 'includeDeviceTags', false);
  const withNetworks = boolParam(q, 'includeNetworks', false);
  const rows = groupBy(filtered(ctx), (a) => `${a.type}:${a.severity}`).map((list) => {
    const networks = [...new Set(list.map((a) => a.net))];
    const resolved = list.filter((a) => a.resolvedAt != null);
    return {
      type: list[0].type,
      categoryType: list[0].categoryType,
      severity: list[0].severity,
      lastAlertedAt: iso(latest(list, (a) => a.startedAt)),
      ...(resolved.length && { lastResolvedAt: iso(latest(resolved, (a) => a.resolvedAt)) }),
      count: list.length,
      networkCount: networks.length,
      deviceTypes: uniqueSorted(list.map((a) => DEVICE_TYPE[a.dev.productType])),
      deviceTags: withTags ? uniqueSorted(list.flatMap((a) => a.dev.tags)) : [],
      networks: withNetworks ? networks.map((n) => ({ id: n.id, name: n.name })) : [],
    };
  });
  const key = GROUP_SORT[by];
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (order === 'descending') rows.reverse();
  const items = paginate(ctx, rows, (r) => `${r.type}:${r.severity}`, { def: 1000, max: 1000 });
  return { items, meta: { counts: { items: rows.length } } };
}

// Each segment counts the alerts that were open at any point in it, dismissed or not.
function overviewHistorical(ctx) {
  const q = ctx.query;
  const org = orgOf(ctx);
  for (const name of ['segmentDuration', 'tsStart']) if (!q.get(name)) throw badRequest(`'${name}' is required`);
  const step = Number(q.get('segmentDuration'));
  if (!Number.isInteger(step) || step < 1) throw badRequest("'segmentDuration' must be a positive integer");
  const from = time(q, 'tsStart');
  if (from >= ctx.now) throw badRequest("'tsStart' must be in the past");
  if (from < ctx.now - LOOKBACK - 3600) throw badRequest(`'tsStart' must be within the last ${LOOKBACK / DAY} days`);
  const to = Math.min(time(q, 'tsEnd') ?? ctx.now, ctx.now);
  if (to <= from) throw badRequest("'tsEnd' must be after 'tsStart'");
  const count = Math.ceil((to - from) / step);
  if (count > MAX_SEGMENTS) throw badRequest(`At most ${MAX_SEGMENTS} segments can be returned, use a longer 'segmentDuration'`);

  const alerts = orgAlerts(org, ctx.world, ctx.now).filter(matcher(q));
  const tally = (list) => ({ informational: 0, warning: 0, critical: 0, ...Object.fromEntries(severityCounts(list).map((s) => [s.type, s.count])) });
  const items = [];
  for (let i = 0; i < count; i++) {
    const start = from + i * step;
    const end = Math.min(start + step, to);
    const open = alerts.filter((a) => a.startedAt < end && (a.resolvedAt == null || a.resolvedAt > start));
    const byAlertType = uniqueSorted(open.map((a) => a.type)).map((type) => ({ type, ...tally(open.filter((a) => a.type === type)) }));
    items.push({ segmentStart: iso(start), totals: tally(open), byAlertType });
  }
  return { items, meta: { counts: { items: items.length } } };
}

// Every ID must be an alert in this organization, or nothing changes.
function alertIds(ctx) {
  const org = orgOf(ctx);
  const ids = [...new Set(ctx.body.alertIds)];
  if (!ids.length) throw badRequest("'alertIds' must not be empty");
  const known = new Set(orgAlerts(org, ctx.world, ctx.now).map((a) => a.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) throw new ApiError(404, missing.map((id) => `Alert ${id} not found`));
  return { org, ids };
}

function dismiss(ctx) {
  const { org, ids } = alertIds(ctx);
  const dismissed = (org.dismissedAlerts ??= new Map());
  for (const id of ids) if (!dismissed.has(id)) dismissed.set(id, ctx.now);
}

function restore(ctx) {
  const { org, ids } = alertIds(ctx);
  for (const id of ids) org.dismissedAlerts?.delete(id);
}

// ── Alert profiles ──

const profilesOf = (org) => (org.alertProfiles ??= []);

function profileOf(org, id) {
  const profile = profilesOf(org).find((p) => p.profileId === id);
  if (!profile) throw notFound('Alert profile');
  return profile;
}

// Webhook recipients are the HTTP servers set up in the organization's networks.
export function webhookServers(org) {
  const servers = new Map();
  for (const net of org.networks) for (const s of configOf(net).httpServers) if (!servers.has(s.id)) servers.set(s.id, s);
  return servers;
}

// Every top-level field is required, so an update replaces the whole profile.
function shapeProfile(ctx, org, profileId) {
  const b = ctx.body;
  if (!b.name.trim()) throw badRequest("'name' must not be empty");
  const networkIds = [...new Set(b.networkIds)];
  for (const id of networkIds) if (ctx.world.networkById.get(id)?.org !== org) throw badRequest(`Network ${id} is not in this organization`);
  const alertTypes = [...new Set(b.alertTypes)];
  for (const t of alertTypes) if (!isAlertType(t)) throw badRequest(`'${t}' is not an assurance alert type`);
  const d = b.configuration.alertDestinations ?? {};
  const channel = (c) => ({ enabled: c?.enabled ?? false, recipients: [...new Set(c?.recipients ?? [])] });
  const webhook = channel(d.webhook);
  const servers = webhookServers(org);
  for (const id of webhook.recipients) if (!servers.has(id)) throw badRequest(`HTTP server ${id} does not exist in this organization`);
  return {
    profileId,
    name: b.name,
    organizationId: org.id,
    networkIds,
    alertTypes,
    alertScheduleId: b.alertScheduleId ?? null,
    configuration: {
      enabled: b.configuration.enabled ?? true,
      maintenance: { silencing: { enabled: b.configuration.maintenance?.silencing?.enabled ?? false } },
      alertDestinations: { email: channel(d.email), sms: channel(d.sms), webhook },
    },
  };
}

// Deleted networks and webhook servers drop out; webhooks show their name and URL.
function profileJson(world, org, p) {
  const servers = webhookServers(org);
  const out = structuredClone(p);
  out.networkIds = p.networkIds.filter((id) => world.networkById.get(id)?.org === org);
  const hook = out.configuration.alertDestinations.webhook;
  hook.recipients = hook.recipients.filter((id) => servers.has(id)).map((id) => ({ id, name: servers.get(id).name, url: servers.get(id).url }));
  return out;
}

function createProfile(ctx) {
  const org = orgOf(ctx);
  const list = profilesOf(org);
  if (list.length >= MAX_PROFILES) throw badRequest(`Organizations are limited to ${MAX_PROFILES} alert profiles in the emulator`);
  const profile = shapeProfile(ctx, org, null);
  // Seeded from a count that never goes down, so the same calls give the same IDs.
  org.alertProfilesCreated = (org.alertProfilesCreated ?? 0) + 1;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:alertProfile:${org.id}:${org.alertProfilesCreated}`));
  do profile.profileId = r.digits(14);
  while (list.some((p) => p.profileId === profile.profileId));
  list.push(profile);
  return profileJson(ctx.world, org, profile);
}

function updateProfile(ctx) {
  const org = orgOf(ctx);
  const list = profilesOf(org);
  const current = profileOf(org, ctx.params.profileId);
  const profile = shapeProfile(ctx, org, current.profileId);
  list[list.indexOf(current)] = profile;
  return profileJson(ctx.world, org, profile);
}

function deleteProfile(ctx) {
  const org = orgOf(ctx);
  const list = profilesOf(org);
  list.splice(list.indexOf(profileOf(org, ctx.params.profileId)), 1);
}

// The older view: what is wrong in one network right now.
function healthAlertJson(a) {
  return {
    id: a.id,
    category: a.type === 'crc_errors' ? 'Wired' : 'Connectivity',
    type: a.title,
    severity: a.severity === 'critical' ? 'error' : 'warning',
    scope: {
      devices: [{ url: deviceUrl(a.dev), name: a.dev.name, productType: a.dev.productType, serial: a.dev.serial, mac: a.dev.mac, ...(a.port ? { lldp: { portId: a.port } } : {}), clients: [] }],
      applications: [],
      peers: [],
    },
  };
}

const ORG = '/organizations/{organizationId}/assurance/alerts';

export default [
  {
    op: 'getOrganizationAssuranceAlerts',
    path: ORG,
    handler: (ctx) => {
      const rows = sorted(ctx, filtered(ctx)).map(alertJson);
      return paginate(ctx, rows, (a) => a.id, { def: 30, max: 300, min: 4 });
    },
  },
  {
    op: 'dismissOrganizationAssuranceAlerts',
    method: 'POST',
    status: 204,
    path: `${ORG}/dismiss`,
    handler: dismiss,
  },
  {
    op: 'restoreOrganizationAssuranceAlerts',
    method: 'POST',
    status: 204,
    path: `${ORG}/restore`,
    handler: restore,
  },
  {
    op: 'getOrganizationAssuranceAlertsOverview',
    path: `${ORG}/overview`,
    handler: (ctx) => {
      const alerts = filtered(ctx);
      return { counts: { total: alerts.length, bySeverity: severityCounts(alerts) } };
    },
  },
  {
    op: 'getOrganizationAssuranceAlertsOverviewByNetwork',
    path: `${ORG}/overview/byNetwork`,
    handler: overviewByNetwork,
  },
  {
    op: 'getOrganizationAssuranceAlertsOverviewByType',
    path: `${ORG}/overview/byType`,
    sample: { query: 'resolved=true&includeDeviceTags=true&includeNetworks=true' },
    handler: overviewByType,
  },
  {
    op: 'getOrganizationAssuranceAlertsOverviewHistorical',
    path: `${ORG}/overview/historical`,
    sample: { query: (world, now) => `segmentDuration=86400&tsStart=${iso(now - 7 * DAY)}` },
    handler: overviewHistorical,
  },
  {
    op: 'getOrganizationAssuranceAlertsProfiles',
    path: `${ORG}/profiles`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const items = profilesOf(org).map((p) => profileJson(ctx.world, org, p));
      return { items, meta: { counts: { items: { total: items.length, remaining: 0 } } } };
    },
  },
  {
    op: 'createOrganizationAssuranceAlertsProfile',
    method: 'POST',
    path: `${ORG}/profiles`,
    handler: createProfile,
  },
  {
    op: 'updateOrganizationAssuranceAlertsProfile',
    method: 'PUT',
    path: `${ORG}/profiles/{profileId}`,
    handler: updateProfile,
  },
  {
    op: 'deleteOrganizationAssuranceAlertsProfile',
    method: 'DELETE',
    path: `${ORG}/profiles/{profileId}`,
    handler: deleteProfile,
  },
  {
    op: 'getOrganizationAssuranceAlertsTaxonomyCategories',
    path: `${ORG}/taxonomy/categories`,
    handler: (ctx) => (orgOf(ctx), structuredClone(ALERT_CATEGORIES)),
  },
  {
    op: 'getOrganizationAssuranceAlertsTaxonomyTypes',
    path: `${ORG}/taxonomy/types`,
    handler: (ctx) => {
      orgOf(ctx);
      return Object.entries(ALERT_TYPES).map(([type, t]) => ({ type, title: t.title, categoryType: t.categoryType, severities: t.severities.map((s) => ({ type: s })), deviceTypes: [...t.deviceTypes] }));
    },
  },
  {
    op: 'getOrganizationAssuranceAlert',
    path: `${ORG}/{id}`,
    sample: { id: (world, now) => orgAlerts(world.orgs[0], world, now).at(-1).id },
    handler: (ctx) => {
      const a = orgAlerts(orgOf(ctx), ctx.world, ctx.now).find((x) => x.id === ctx.params.id);
      if (!a) throw notFound('Alert');
      return alertJson(a);
    },
  },
  {
    op: 'getNetworkHealthAlerts',
    path: '/networks/{networkId}/health/alerts',
    handler: (ctx) => {
      const net = netOf(ctx);
      return orgAlerts(net.org, ctx.world, ctx.now)
        .filter((a) => a.net === net && a.resolvedAt == null && dismissedAt(a) == null)
        .map(healthAlertJson);
    },
  },
];
