// Camera analytics: area and crossing line boundaries, their detection counts,
// custom analytics artifacts and per-camera workloads, and onboarding statuses.
// The spec has no boundary writes, so each camera gets one area and one line
// worked out from the seed and the camera's key, which a swap keeps.

import { arrayParam, badRequest, intParam, paginate } from '../http.js';
import { Rand, derive, hashStr, lognoise, unit } from '../rng.js';
import { DAY, HOUR, MIN, iso, isoMicro, parseTime, weekday } from '../time.js';
import { eachOutage } from '../sim/outages.js';
import { workCurve } from '../sim/usage.js';
import { bySerial, collection, devOf, filterDevices, orgOf, requireModel } from './common.js';

const ARTIFACTS = '/organizations/{organizationId}/camera/customAnalytics/artifacts';
const MAX_ARTIFACTS = 100;
const UPLOAD = MIN; // until the upload is taken as done
const PROCESSING = 2 * MIN;
const UPLOAD_TTL = HOUR;
const LOOKBACK = 31 * DAY;
const MAX_BUCKETS = 1440;
const MAX_RANGES = 10;
const OBJECT_TYPES = ['person', 'vehicle'];
const AREA_NAMES = ['Entrance', 'Lobby', 'Loading zone', 'Walkway', 'Parking', 'Doorway'];
const LINE_NAMES = ['Front door', 'Gate', 'Corridor', 'Driveway', 'Stairs', 'Dock door'];
// Detections a minute at the busiest hour, by boundary and object type.
const RATE = { area: { person: 0.6, vehicle: 0.15 }, line: { person: 0.4, vehicle: 0.1 } };

// ── Boundaries ──

const cameras = (org) => org.devices.filter((d) => d.productType === 'camera');

const at = (r) => Math.round((0.05 + r.next() * 0.4) * 1000) / 1000;
const span = (r) => Math.round((0.2 + r.next() * 0.3) * 1000) / 1000;
const boundaryId = (r) => r.chars(1, 'abcdefghijklmnopqrstuvwxyz') + r.hex(6);

function boundariesOf(world, dev) {
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:cameraBoundary:${dev.key}`));
  const [x, y, w, h] = [at(r), at(r), span(r), span(r)];
  const area = { id: boundaryId(r), type: 'area', name: r.pick(AREA_NAMES), vertices: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] };
  const ly = at(r) + 0.2;
  const line = { id: boundaryId(r), type: 'line', name: r.pick(LINE_NAMES), vertices: [{ x: 0.25, y: ly }, { x: 0.75, y: ly }], directionVertex: { x: 0.5, y: Math.round((ly + 0.05) * 1000) / 1000 } };
  for (const v of area.vertices) (v.x = Math.round(v.x * 1000) / 1000), (v.y = Math.round(v.y * 1000) / 1000);
  return { area, line, scale: 0.5 + r.next() };
}

function byDevice(type) {
  return (ctx) => {
    const org = orgOf(ctx);
    return filterDevices(ctx.query, cameras(org))
      .sort(bySerial)
      .map((dev) => ({ networkId: dev.net.id, serial: dev.serial, boundaries: structuredClone(boundariesOf(ctx.world, dev)[type]) }));
  };
}

// ── Detections ──

// The SDK sends ranges[]startTime=..&ranges[]endTime=..; a repeated field
// starts the next range. ranges[N][field] and ranges[][field] work too.
function rangesParam(q) {
  const out = [];
  const indexed = new Map();
  for (const [k, v] of q) {
    const m = /^ranges\[(\d*)\](?:\[(\w+)\]|(\w+))$/.exec(k);
    if (!m) continue;
    const field = m[2] ?? m[3];
    let r;
    if (m[1] !== '') {
      r = indexed.get(m[1]);
      if (!r) indexed.set(m[1], (r = {})), out.push(r);
    } else {
      r = out.at(-1);
      if (!r || field in r || indexed.size) out.push((r = {}));
    }
    r[field] = v;
  }
  return out;
}

function checkRanges(ctx) {
  const ranges = rangesParam(ctx.query);
  if (!ranges.length) throw badRequest("'ranges' is required");
  if (ranges.length > MAX_RANGES) throw badRequest(`'ranges' can hold at most ${MAX_RANGES} ranges`);
  return ranges.map((r, i) => {
    const name = `ranges[${i}]`;
    for (const k of ['startTime', 'endTime', 'interval']) if (r[k] == null || r[k] === '') throw badRequest(`'${name}.${k}' is required`);
    const start = parseTime(r.startTime);
    const end = parseTime(r.endTime);
    const interval = Number(r.interval);
    if (Number.isNaN(start)) throw badRequest(`'${name}.startTime' must be a time`);
    if (Number.isNaN(end)) throw badRequest(`'${name}.endTime' must be a time`);
    if (!Number.isInteger(interval) || interval < 60) throw badRequest(`'${name}.interval' must be an integer of at least 60 seconds`);
    if (end <= start) throw badRequest(`'${name}.endTime' must be after its startTime`);
    if (start < ctx.now - LOOKBACK) throw badRequest(`'${name}.startTime' can be at most 31 days ago`);
    if (Math.ceil((end - start) / interval) > MAX_BUCKETS) throw badRequest(`'${name}' can hold at most ${MAX_BUCKETS} intervals`);
    return { start, end, interval };
  });
}

// Counts whole minutes starting in [a, b) and before now, skipping the minutes
// the camera was down or dormant. Busier in business hours and on weekdays.
function detections(dev, b, objectType, factor, a, end, now) {
  const stop = Math.min(end, now);
  const down = [];
  eachOutage(dev, a, stop, (s, e) => down.push([s, e]));
  if (dev.dormant) down.push([dev.dormantSince, Infinity]);
  const key = derive(dev.key, `${b.id}:${objectType}`);
  const rate = RATE[b.type][objectType] * factor;
  let inCount = 0;
  let outCount = 0;
  for (let m = Math.ceil(a / MIN) * MIN; m < stop; m += MIN) {
    if (down.some(([s, e]) => m >= s && m < e)) continue;
    const local = m + dev.net.zone.offset(m);
    const h = ((local % DAY) + DAY) % DAY / HOUR;
    const dow = weekday(Math.floor(local / DAY));
    const r = rate * workCurve(h) * (dow === 0 || dow === 6 ? 0.4 : 1) * lognoise(key, m / MIN, 0.3);
    inCount += Math.floor(r + unit(key, 2 * (m / MIN)));
    outCount += Math.floor(r + unit(key, 2 * (m / MIN) + 1));
  }
  return { in: inCount, out: outCount };
}

function history(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const ids = arrayParam(q, 'boundaryIds');
  if (!ids.length) throw badRequest("'boundaryIds' is required");
  const ranges = checkRanges(ctx);
  const types = arrayParam(q, 'boundaryTypes');
  for (const t of types) if (!OBJECT_TYPES.includes(t)) throw badRequest("'boundaryTypes' must be person or vehicle");
  const objectTypes = types.length ? OBJECT_TYPES.filter((t) => types.includes(t)) : ['person'];
  const duration = intParam(q, 'duration', 60, { min: 0, max: 86400 });
  // Unknown IDs drop out, like the other filters.
  const found = [];
  for (const dev of cameras(org).sort(bySerial)) {
    const { area, line, scale } = boundariesOf(ctx.world, dev);
    for (const b of [area, line]) if (ids.includes(b.id)) found.push({ dev, b, scale });
  }
  const rows = [];
  ranges.forEach((r, ri) => {
    for (const f of found) {
      for (const objectType of objectTypes) {
        for (let s = r.start; s < r.end; s += r.interval) rows.push({ key: `${ri}:${f.b.id}:${objectType}:${s}`, ...f, objectType, s, e: Math.min(s + r.interval, r.end) });
      }
    }
  });
  const page = paginate(ctx, rows, (x) => x.key, { def: 1000, max: 1000, min: 1 });
  return page.map((x) => {
    // A longer minimum stay counts fewer people in an area; lines don't use it.
    const factor = x.scale * (x.b.type === 'area' ? Math.exp(-(duration - 60) / 900) : 1);
    const counts = detections(x.dev, x.b, x.objectType, factor, x.s, x.e, ctx.now);
    return { boundaryId: x.b.id, type: x.b.type, results: { startTime: iso(x.s), endTime: iso(x.e), objectType: x.objectType, ...counts } };
  });
}

// ── Custom analytics artifacts ──

const artifactsOf = (org) => (org.cameraArtifacts ??= { created: 0, list: [] });

// Nothing is uploaded, so an artifact is taken as uploaded a minute after the
// create, then checked. A frozen clock finishes both in the create.
function artifactStatus(x, now) {
  if (now < x.start) return { type: 'pending', message: 'Waiting for the artifact upload' };
  if (now < x.end) return { type: 'processing', message: 'Validating the artifact' };
  return { type: 'ready', message: 'Artifact is ready' };
}

const artifactJson = (x, org, now) => ({ artifactId: x.artifactId, organizationId: org.id, name: x.name, status: artifactStatus(x, now) });

const usersOf = (x, org) => cameras(org).filter((d) => d.cameraCustomAnalytics?.artifact === x);

function uploadOf(ctx, org, x) {
  const uploadId = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:cameraArtifactUpload:${org.id}:${x.artifactId}`)).hex(32);
  return { uploadId, uploadUrl: `https://custom-analytics-upload.example.com/${uploadId}`, uploadUrlExpiry: isoMicro(x.created + UPLOAD_TTL).replace('Z', '+00:00') };
}

const artifacts = collection({
  ops: {
    list: 'getOrganizationCameraCustomAnalyticsArtifacts',
    create: 'createOrganizationCameraCustomAnalyticsArtifact',
    get: 'getOrganizationCameraCustomAnalyticsArtifact',
    delete: 'deleteOrganizationCameraCustomAnalyticsArtifact',
  },
  path: ARTIFACTS,
  param: 'artifactId',
  parent: orgOf,
  store: artifactsOf,
  scope: 'organization',
  what: 'custom analytics artifact',
  key: 'artifactId',
  nextId: (ctx, store) => String(++store.created),
  max: MAX_ARTIFACTS,
  required: ['name'],
  blank: (ctx) => ({ name: null, created: ctx.now, start: ctx.frozen ? ctx.now : ctx.now + UPLOAD, end: ctx.frozen ? ctx.now : ctx.now + UPLOAD + PROCESSING }),
  apply: (x, b) => {
    x.name = b.name;
  },
  json: (x, org, ctx) => artifactJson(x, org, ctx.now),
  inUse: (x, org) => {
    const users = usersOf(x, org);
    if (users.length) return `The artifact is used by camera ${users[0].serial}`;
  },
  missing: { artifactId: '999999', status: 404 },
});

// The create also answers where to upload the artifact.
const artifactRoutes = artifacts.routes.map((r) =>
  r.method === 'POST'
    ? {
        ...r,
        handler: (ctx) => {
          const out = r.handler(ctx);
          const { parent: org, store } = artifacts.storeOf(ctx);
          return { ...out, ...uploadOf(ctx, org, store.list.at(-1)) };
        },
      }
    : r,
);

// ── Per-camera custom analytics ──

function cameraOf(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'camera');
  return dev;
}

const analyticsOf = (dev) => (dev.cameraCustomAnalytics ??= { enabled: false, artifact: null, parameters: [] });

function analyticsJson(dev) {
  const a = analyticsOf(dev);
  return { enabled: a.enabled, artifactId: a.artifact?.artifactId ?? null, parameters: a.parameters.map((p) => ({ ...p })) };
}

// Artifacts belong to the organization, so a network whose cameras name one
// can't move to another.
export const usesArtifacts = (net) => net.cameras.some((d) => d.cameraCustomAnalytics?.artifact);

function updateAnalytics(ctx) {
  const dev = cameraOf(ctx);
  const b = ctx.body;
  const a = analyticsOf(dev);
  const list = artifactsOf(dev.net.org).list;
  let artifact = a.artifact;
  if (b.artifactId !== undefined) {
    artifact = b.artifactId == null || b.artifactId === '' ? null : list.find((x) => x.artifactId === b.artifactId);
    if (artifact === undefined) throw badRequest("'artifactId' must name a custom analytics artifact in this organization");
  }
  const enabled = b.enabled ?? a.enabled;
  if (enabled && !artifact) throw badRequest("'artifactId' is required to enable custom analytics");
  let parameters = a.parameters;
  if (b.parameters != null) {
    parameters = b.parameters.map((p, i) => {
      if (typeof p.name !== 'string' || !p.name.trim()) throw badRequest(`'parameters[${i}].name' must not be empty`);
      const value = typeof p.value === 'string' && p.value.trim() !== '' ? Number(p.value) : NaN;
      if (!Number.isFinite(value)) throw badRequest(`'parameters[${i}].value' must be a number`);
      return { name: p.name, value };
    });
    if (new Set(parameters.map((p) => p.name)).size < parameters.length) throw badRequest("'parameters' names must be unique");
  }
  Object.assign(a, { enabled, artifact, parameters });
  return analyticsJson(dev);
}

// ── Onboarding ──

// The emulator's cameras are wired, so they start onboarded.
function onboardingJson(dev) {
  const o = dev.cameraOnboarding;
  return { networkId: dev.net.id, serial: dev.serial, status: o ? o.status : 'complete', updatedAt: isoMicro(o ? o.at : dev.claimedAt) };
}

function updateOnboarding(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  if (b.serial == null || b.serial === '') throw badRequest("'serial' is required");
  if (b.wirelessCredentialsSent == null) throw badRequest("'wirelessCredentialsSent' is required");
  const dev = cameras(org).find((d) => d.serial === b.serial);
  if (!dev) throw badRequest("'serial' must be a camera in this organization");
  dev.cameraOnboarding = { status: b.wirelessCredentialsSent ? 'complete' : 'pending onboarding', at: ctx.now };
  return { success: true };
}

// One hour of the first camera's area, in 5 minute intervals.
function historySample(world, now) {
  const dev = world.orgs[0].networks[0].cameras[0];
  const end = Math.floor(now / 300) * 300;
  return `boundaryIds[]=${boundariesOf(world, dev).area.id}&ranges[]startTime=${iso(end - HOUR)}&ranges[]endTime=${iso(end)}&ranges[]interval=300`;
}

export default [
  { op: 'getDeviceCameraCustomAnalytics', path: '/devices/{serial}/camera/customAnalytics', sample: { serial: 'camera' }, handler: (ctx) => analyticsJson(cameraOf(ctx)) },
  { op: 'updateDeviceCameraCustomAnalytics', method: 'PUT', path: '/devices/{serial}/camera/customAnalytics', handler: updateAnalytics },
  { op: 'getOrganizationCameraBoundariesAreasByDevice', path: '/organizations/{organizationId}/camera/boundaries/areas/byDevice', handler: byDevice('area') },
  { op: 'getOrganizationCameraBoundariesLinesByDevice', path: '/organizations/{organizationId}/camera/boundaries/lines/byDevice', handler: byDevice('line') },
  ...artifactRoutes,
  { op: 'getOrganizationCameraDetectionsHistoryByBoundaryByInterval', path: '/organizations/{organizationId}/camera/detections/history/byBoundary/byInterval', sample: { query: historySample }, handler: history },
  {
    op: 'getOrganizationCameraOnboardingStatuses',
    path: '/organizations/{organizationId}/camera/onboarding/statuses',
    handler: (ctx) => filterDevices(ctx.query, cameras(orgOf(ctx))).sort(bySerial).map(onboardingJson),
  },
  { op: 'updateOrganizationCameraOnboardingStatuses', method: 'PUT', path: '/organizations/{organizationId}/camera/onboarding/statuses', handler: updateOnboarding },
];
