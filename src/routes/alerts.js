// Assurance alerts across the organization, and the older per-network health alerts view.

import { deviceUrl } from '../format.js';
import { arrayParam, badRequest, boolParam, hasTags, notFound, paginate } from '../http.js';
import { DEVICE_TYPE, orgAlerts } from '../sim/alerts.js';
import { iso, parseTime } from '../time.js';
import { netOf, orgOf } from './common.js';

const SORT_BY = ['startedAt', 'resolvedAt', 'dismissedAt', 'severity', 'category'];
const SEVERITY_RANK = { critical: 0, warning: 1, informational: 2 };

function alertJson(a) {
  const device = { url: deviceUrl(a.dev), name: a.dev.name, order: 0, productType: a.dev.productType, serial: a.dev.serial, mac: a.dev.mac };
  if (a.port) device.lldp = { port: a.port };
  return {
    id: a.id,
    categoryType: a.categoryType,
    network: { name: a.net.name, id: a.net.id, url: a.net.url },
    startedAt: iso(a.startedAt),
    resolvedAt: a.resolvedAt == null ? null : iso(a.resolvedAt),
    dismissedAt: null,
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

// Active alerts by default; resolved ones only when asked for. Nothing is ever dismissed.
function filtered(ctx) {
  const q = ctx.query;
  const org = orgOf(ctx);
  const active = boolParam(q, 'active', true);
  const resolved = boolParam(q, 'resolved', false);
  const dismissed = boolParam(q, 'dismissed', false);
  const [types, serials, deviceTypes, deviceTags] = ['types', 'serials', 'deviceTypes', 'deviceTags'].map((n) => arrayParam(q, n));
  const networkId = q.get('networkId');
  const severity = q.get('severity');
  const category = q.get('category');
  const from = time(q, 'tsStart');
  const to = time(q, 'tsEnd');
  const offlineOnly = boolParam(q, 'suppressAlertsForOfflineNodes', false) && !resolved;
  return orgAlerts(org, ctx.world, ctx.now).filter(
    (a) =>
      !dismissed &&
      (a.resolvedAt == null ? active : resolved) &&
      (!networkId || a.net.id === networkId) &&
      (!severity || a.severity === severity) &&
      (!category || a.categoryType === category) &&
      (!types.length || types.includes(a.type)) &&
      (!serials.length || serials.includes(a.dev.serial)) &&
      (!deviceTypes.length || deviceTypes.includes(DEVICE_TYPE[a.dev.productType])) &&
      hasTags(a.dev.tags, deviceTags, 'withAnyTags') &&
      (from == null || a.startedAt >= from) &&
      (to == null || a.startedAt <= to) &&
      (!offlineOnly || a.type !== 'unreachable' || a.resolvedAt == null),
  );
}

function sorted(ctx, alerts) {
  const by = ctx.query.get('sortBy') || 'startedAt';
  if (!SORT_BY.includes(by)) throw badRequest(`'sortBy' must be one of: ${SORT_BY.join(', ')}`);
  const order = ctx.query.get('sortOrder') || 'ascending';
  if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
  const key = {
    startedAt: (a) => a.startedAt,
    resolvedAt: (a) => a.resolvedAt ?? Infinity,
    dismissedAt: (a) => a.startedAt,
    severity: (a) => SEVERITY_RANK[a.severity],
    category: (a) => a.categoryType,
  }[by];
  const out = [...alerts].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.startedAt - b.startedAt));
  return order === 'descending' ? out.reverse() : out;
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

export default [
  {
    op: 'getOrganizationAssuranceAlerts',
    path: '/organizations/{organizationId}/assurance/alerts',
    handler: (ctx) => {
      const rows = sorted(ctx, filtered(ctx)).map(alertJson);
      return paginate(ctx, rows, (a) => a.id, { def: 30, max: 300, min: 4 });
    },
  },
  {
    op: 'getOrganizationAssuranceAlertsOverview',
    path: '/organizations/{organizationId}/assurance/alerts/overview',
    handler: (ctx) => {
      const alerts = filtered(ctx);
      const bySeverity = ['critical', 'warning', 'informational'].map((type) => ({ type, count: alerts.filter((a) => a.severity === type).length })).filter((s) => s.count);
      return { counts: { total: alerts.length, bySeverity } };
    },
  },
  {
    op: 'getOrganizationAssuranceAlert',
    path: '/organizations/{organizationId}/assurance/alerts/{id}',
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
        .filter((a) => a.net === net && a.resolvedAt == null)
        .map(healthAlertJson);
    },
  },
];
