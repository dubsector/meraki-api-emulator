// Organization administration: admins, inventory, the change log
// and the log of API calls made to this emulator.

import { arrayParam, badRequest, hasTags, intParam, notFound, paginate, timeWindow } from '../http.js';
import { hashStr } from '../rng.js';
import { changesOnDay } from '../sim/changes.js';
import { DAY, iso, isoMicro, weekday } from '../time.js';
import { orgOf } from './common.js';
import { deviceLicense } from './licenses.js';

const RESPONSE_CODES = [200, 201, 202, 203, 204, 205, 206, 207, 208, 226, 300, 301, 302, 303, 304, 305, 306, 307, 308, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451, 500];
const COUNTRY = { 'Europe/London': 'GB', 'America/Toronto': 'CA' };

// Human admins were last active at their usual hour on the latest weekday.
function lastActive(a, ctx) {
  if (a.api) {
    const last = ctx.apiLog.items.at(-1);
    return iso(last ? last.ts : ctx.now);
  }
  if (a.accountStatus !== 'ok') return null;
  for (let d = Math.floor(ctx.now / DAY); ; d--) {
    const t = d * DAY + (a.activeHour + 7) * 3600;
    if (t <= ctx.now && weekday(d) !== 0 && weekday(d) !== 6) return iso(t);
  }
}

function adminJson(a, ctx) {
  return {
    id: a.id,
    name: a.name,
    email: a.email,
    orgAccess: a.orgAccess,
    accountStatus: a.accountStatus,
    twoFactorAuthEnabled: a.twoFactorAuthEnabled,
    hasApiKey: a.hasApiKey,
    lastActive: lastActive(a, ctx),
    tags: a.tags,
    networks: a.networks,
    authenticationMethod: 'Email',
  };
}

const MAX_ADMINS = 200;

function adminOf(org, id) {
  const a = org.admins.find((x) => x.id === id);
  if (!a) throw notFound('Admin');
  return a;
}

// Network and tag privileges must point at networks in this organization.
export function checkPrivileges(org, b) {
  for (const n of b.networks || []) {
    if (!org.networks.some((x) => x.id === n.id)) throw badRequest(`Network ${n.id} is not in this organization`);
  }
}

function createAdmin(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("'email' must be an email address");
  if (org.admins.some((a) => a.email === email)) throw badRequest('Email has already been taken');
  if (org.admins.length >= MAX_ADMINS) throw badRequest(`Organizations are limited to ${MAX_ADMINS} admins in the emulator`);
  checkPrivileges(org, b);
  let id;
  const ids = new Set(ctx.world.orgs.flatMap((o) => o.admins.map((a) => a.id)));
  for (let i = 0; !id || ids.has(id); i++) id = String(100000 + ((hashStr(`${org.id}:${email}:${i}`) % 900000)));
  const admin = { id, name: b.name, email, orgAccess: b.orgAccess, accountStatus: 'unverified', twoFactorAuthEnabled: false, hasApiKey: false, tags: b.tags || [], networks: b.networks || [], activeHour: 9 };
  org.admins.push(admin);
  return adminJson(admin, ctx);
}

function sku(model) {
  return model.startsWith('CW') ? `${model}-MR` : `${model}-HW`;
}

function inventoryJson(d, org) {
  const net = d.net;
  const license = deviceLicense(org, d.serial);
  return {
    mac: d.mac,
    serial: d.serial,
    name: d.name,
    address: net ? net.address : '',
    model: d.model,
    sku: sku(d.model),
    networkId: net ? net.id : null,
    orderNumber: d.orderNumber,
    claimedAt: isoMicro(d.claimedAt),
    licenseExpirationDate: license ? isoMicro(license.expirationDate) : null,
    tags: d.tags,
    productType: d.productType,
    countryCode: net ? COUNTRY[net.timeZone] ?? 'US' : 'US',
    details: [],
    eox: { status: null, endOfSaleAt: null, endOfSupportAt: null },
  };
}

function inventory(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const used = q.get('usedState');
  if (used && used !== 'used' && used !== 'unused') throw badRequest("'usedState' must be 'used' or 'unused'");
  const search = q.get('search')?.toLowerCase();
  const list = (name) => arrayParam(q, name);
  const [macs, networkIds, serials, models, orders, tags, productTypes, eox] = ['macs', 'networkIds', 'serials', 'models', 'orderNumbers', 'tags', 'productTypes', 'eoxStatuses'].map(list);
  const mode = q.get('tagsFilterType') || 'withAnyTags';
  return [...org.devices, ...org.spares]
    .filter(
      (d) =>
        (!used || (used === 'used') === !!d.net) &&
        (!search || [d.serial, d.mac, d.model].some((v) => v.toLowerCase().includes(search))) &&
        (!macs.length || macs.map((m) => m.toLowerCase()).includes(d.mac)) &&
        (!networkIds.length || networkIds.includes(d.net ? d.net.id : 'null')) &&
        (!serials.length || serials.includes(d.serial)) &&
        (!models.length || models.includes(d.model)) &&
        (!orders.length || orders.includes(d.orderNumber)) &&
        (!productTypes.length || productTypes.includes(d.productType)) &&
        (!eox.length || eox.includes('null')) &&
        hasTags(d.tags, tags, mode),
    )
    .sort((a, b) => (a.serial < b.serial ? -1 : 1))
    .map((d) => inventoryJson(d, org));
}

// Newest first, like the Dashboard's change log.
function configurationChanges(ctx) {
  const org = orgOf(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 365 * DAY, defaultSpan: 365 * DAY, lookback: 365 * DAY });
  const networkId = ctx.query.get('networkId');
  const adminId = ctx.query.get('adminId');
  const changes = [];
  for (let d = Math.floor(t0 / DAY); d <= Math.floor(t1 / DAY); d++) changes.push(...changesOnDay(org, d).filter((c) => c.t >= t0 && c.t < t1));
  // API writes land at the current instant, which is the window's end.
  changes.push(...(org.apiChanges || []).filter((c) => c.t >= t0 && c.t <= t1));
  const rows = changes
    .filter((c) => (!networkId || c.net?.id === networkId) && (!adminId || c.admin.id === adminId))
    .sort((a, b) => a.t - b.t)
    .map((c, i) => {
      const row = { ts: isoMicro(c.t), adminName: c.admin.name, adminEmail: c.admin.email, adminId: c.admin.id, networkName: c.net?.name ?? null, networkId: c.net?.id ?? null, networkUrl: c.net?.url ?? null, ssidName: c.ssidName ?? null, ssidNumber: c.ssidNumber ?? null };
      return { key: `${row.ts}:${i}`, row: { ...row, page: c.page, label: c.label, oldValue: c.oldValue, newValue: c.newValue } };
    });
  return paginate(ctx, rows.reverse(), (r) => r.key, { def: 5000, max: 100000 }).map((r) => r.row);
}

function apiWindow(ctx, defaultSpan = 31 * DAY) {
  return timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan, lookback: 31 * DAY });
}

function apiCalls(ctx, t0, t1) {
  return ctx.apiLog.forOrg(orgOf(ctx).id, t0, t1);
}

function apiRequestJson(e) {
  return {
    adminId: e.adminId,
    method: e.method,
    host: e.host,
    path: e.path,
    queryString: e.queryString,
    userAgent: e.userAgent,
    ts: isoMicro(e.ts),
    responseCode: e.responseCode,
    sourceIp: e.sourceIp,
    version: e.version,
    operationId: e.operationId,
    client: { id: e.clientId, type: 'api_key' },
  };
}

function apiRequests(ctx) {
  const q = ctx.query;
  const { t0, t1 } = apiWindow(ctx);
  const method = q.get('method');
  if (method && !['GET', 'PUT', 'POST', 'DELETE'].includes(method)) throw badRequest("'method' must be one of: GET, PUT, POST, DELETE");
  const code = intParam(q, 'responseCode', null);
  const version = intParam(q, 'version', null, { min: 0, max: 1 });
  const ops = arrayParam(q, 'operationIds');
  const exact = (name, v) => !q.get(name) || q.get(name) === v;
  const rows = apiCalls(ctx, t0, t1).filter(
    (e) =>
      exact('adminId', e.adminId) &&
      exact('path', e.path) &&
      exact('sourceIp', e.sourceIp) &&
      exact('userAgent', e.userAgent) &&
      (!method || e.method === method) &&
      (code == null || e.responseCode === code) &&
      (version == null || e.version === version) &&
      (!ops.length || ops.includes(e.operationId)),
  );
  const keyed = rows.reverse().map((e) => ({ key: String(e.seq), row: apiRequestJson(e) }));
  return paginate(ctx, keyed, (x) => x.key, { def: 50, max: 1000 }).map((x) => x.row);
}

const INTERVALS = [120, 3600, 14400, 21600];

function responseCodesByInterval(ctx) {
  const q = ctx.query;
  const timed = q.has('t0') || q.has('t1') || q.has('timespan');
  let interval = intParam(q, 'interval', null);
  if (interval != null && !INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
  // With an interval and no times, the span is sized to the interval; with times and no interval, the reverse.
  const { t0, t1 } = apiWindow(ctx, interval && !timed ? Math.min(31 * DAY, interval * 360) : 31 * DAY);
  if (interval == null) interval = !timed ? 21600 : t1 - t0 <= 2 * 3600 ? 120 : t1 - t0 <= 2 * DAY ? 3600 : t1 - t0 <= 7 * DAY ? 14400 : 21600;
  const version = intParam(q, 'version', null, { min: 0, max: 1 });
  const ops = arrayParam(q, 'operationIds');
  const ips = arrayParam(q, 'sourceIps');
  const admins = arrayParam(q, 'adminIds');
  const agent = q.get('userAgent');
  const calls = apiCalls(ctx, t0, t1).filter(
    (e) =>
      (version == null || e.version === version) &&
      (!ops.length || ops.includes(e.operationId)) &&
      (!ips.length || ips.includes(e.sourceIp)) &&
      (!admins.length || admins.includes(e.adminId)) &&
      (!agent || e.userAgent.includes(agent)),
  );
  const out = [];
  for (let s = Math.floor(t0 / interval) * interval; s < t1; s += interval) {
    const counts = new Map();
    for (const e of calls) if (e.ts >= s && (e.ts < s + interval || (s + interval >= t1 && e.ts <= t1))) counts.set(e.responseCode, (counts.get(e.responseCode) || 0) + 1);
    out.push({ startTs: iso(s), endTs: iso(s + interval), counts: [...counts].sort((a, b) => a[0] - b[0]).map(([code, count]) => ({ code, count })) });
  }
  return out;
}

export default [
  {
    op: 'getOrganizationAdmins',
    path: '/organizations/{organizationId}/admins',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const networkIds = arrayParam(ctx.query, 'networkIds');
      const nets = org.networks.filter((n) => networkIds.includes(n.id));
      const reaches = (a) => a.networks.some((n) => networkIds.includes(n.id)) || a.tags.some((t) => nets.some((n) => n.tags.includes(t.tag)));
      return org.admins.filter((a) => !networkIds.length || reaches(a)).map((a) => adminJson(a, ctx));
    },
  },
  {
    op: 'createOrganizationAdmin',
    method: 'POST',
    path: '/organizations/{organizationId}/admins',
    handler: createAdmin,
  },
  {
    op: 'updateOrganizationAdmin',
    method: 'PUT',
    path: '/organizations/{organizationId}/admins/{adminId}',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const a = adminOf(org, ctx.params.adminId);
      checkPrivileges(org, ctx.body);
      for (const k of ['name', 'orgAccess']) if (ctx.body[k] !== undefined) a[k] = ctx.body[k];
      // A null list clears it.
      for (const k of ['tags', 'networks']) if (ctx.body[k] !== undefined) a[k] = ctx.body[k] ?? [];
      return adminJson(a, ctx);
    },
  },
  {
    op: 'deleteOrganizationAdmin',
    method: 'DELETE',
    path: '/organizations/{organizationId}/admins/{adminId}',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const a = adminOf(org, ctx.params.adminId);
      if (a.api) throw badRequest('An admin cannot delete their own account');
      org.admins.splice(org.admins.indexOf(a), 1);
    },
  },
  {
    op: 'getOrganizationInventoryDevices',
    path: '/organizations/{organizationId}/inventory/devices',
    handler: (ctx) => paginate(ctx, inventory(ctx), (d) => d.serial, { def: 1000, max: 1000 }),
  },
  {
    op: 'getOrganizationInventoryDevice',
    path: '/organizations/{organizationId}/inventory/devices/{serial}',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const d = [...org.devices, ...org.spares].find((x) => x.serial === ctx.params.serial);
      if (!d) throw notFound('Device');
      return inventoryJson(d, org);
    },
  },
  {
    op: 'getOrganizationInventoryDevicesEoxOverview',
    path: '/organizations/{organizationId}/inventory/devices/eox/overview',
    handler: (ctx) => {
      // Counts the EOX status inventory reports. No model in the catalog has one yet.
      const org = orgOf(ctx);
      const byStatus = { endOfSale: { total: 0 }, endOfSupport: { total: 0 }, nearEndOfSupport: { total: 0 } };
      for (const d of [...org.devices, ...org.spares]) {
        const { status } = inventoryJson(d, org).eox;
        if (status) byStatus[status].total++;
      }
      return { counts: { byStatus } };
    },
  },
  {
    op: 'getOrganizationDevicesOverviewByModel',
    path: '/organizations/{organizationId}/devices/overview/byModel',
    handler: (ctx) => {
      const [models, networkIds, productTypes] = ['models', 'networkIds', 'productTypes'].map((n) => arrayParam(ctx.query, n));
      const counts = new Map();
      for (const d of orgOf(ctx).devices) {
        if ((models.length && !models.includes(d.model)) || (networkIds.length && !networkIds.includes(d.net.id)) || (productTypes.length && !productTypes.includes(d.productType))) continue;
        counts.set(d.model, (counts.get(d.model) || 0) + 1);
      }
      return { counts: [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([model, total]) => ({ model, total })) };
    },
  },
  {
    op: 'getOrganizationConfigurationChanges',
    path: '/organizations/{organizationId}/configurationChanges',
    sample: { query: 'timespan=604800' },
    handler: configurationChanges,
  },
  {
    op: 'getOrganizationApiRequests',
    path: '/organizations/{organizationId}/apiRequests',
    handler: apiRequests,
  },
  {
    op: 'getOrganizationApiRequestsOverview',
    path: '/organizations/{organizationId}/apiRequests/overview',
    handler: (ctx) => {
      const { t0, t1 } = apiWindow(ctx);
      const counts = Object.fromEntries(RESPONSE_CODES.map((c) => [String(c), 0]));
      for (const e of apiCalls(ctx, t0, t1)) counts[e.responseCode] = (counts[e.responseCode] || 0) + 1;
      return { responseCodeCounts: counts };
    },
  },
  {
    op: 'getOrganizationApiRequestsOverviewResponseCodesByInterval',
    path: '/organizations/{organizationId}/apiRequests/overview/responseCodes/byInterval',
    sample: { query: 'timespan=86400' },
    handler: responseCodesByInterval,
  },
];
