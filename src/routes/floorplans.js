// Floor plans: an image placed on the map, the devices assigned to it, and AP
// auto locate jobs. Networks start with none; writes add them.

import { createHash } from 'node:crypto';
import { deviceJson } from '../format.js';
import { arrayParam, badRequest, notFound, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { MIN, iso, parseTime } from '../time.js';
import { deviceStatus } from '../sim/outages.js';
import { byId, bySerial, netOf, orgOf, round } from './common.js';

const LIST = '/networks/{networkId}/floorPlans';
const PLAN = `${LIST}/{floorPlanId}`;
const JOB = `${LIST}/autoLocate/jobs/{jobId}`;
const MAX_PLANS = 128;
const MAX_JOBS = 1000;
const MAX_BATCH = 100;
const M_PER_DEG = 111320;
const DEFAULT_WIDTH = 100; // metres, for a plan placed by its center
const URL_TTL = 30 * MIN;
// A full run gets a GNSS fix and ranges between APs before positioning. Without
// a refresh it only positions, from the data it already has.
const GNSS_END = 5 * MIN;
const RANGING_END = 8 * MIN;
const RUN = 10 * MIN;
const POSITION_ONLY = 1 * MIN;
const MISSING = { floorPlanId: 'g_578149602163689000', status: 404 };

const POINTS = ['center', 'bottomLeftCorner', 'bottomRightCorner', 'topLeftCorner', 'topRightCorner'];
// Adjacent corner pairs, in the order they're tried, and the side each forms.
const SIDES = [
  ['topLeftCorner', 'topRightCorner', 'top'],
  ['bottomLeftCorner', 'bottomRightCorner', 'bottom'],
  ['topLeftCorner', 'bottomLeftCorner', 'left'],
  ['topRightCorner', 'bottomRightCorner', 'right'],
];

// Kept on the network, not its config, so copying a network doesn't copy them.
const storeOf = (net) => (net.floorPlans ??= { created: 0, list: [], jobsCreated: 0, jobs: [] });

export function hasFloorPlan(net, id) {
  return storeOf(net).list.some((p) => p.id === id);
}

function planOf(ctx) {
  const net = netOf(ctx);
  const store = storeOf(net);
  const plan = store.list.find((p) => p.id === ctx.params.floorPlanId);
  if (!plan) throw notFound('Floor plan');
  return { net, store, plan };
}

// The validator lets null through, so required values are checked here.
function need(v, name) {
  if (v == null) throw badRequest(`'${name}' is required`);
  return v;
}

function nextId(ctx, store, kind, net, taken) {
  const counter = kind === 'floorPlan' ? 'created' : 'jobsCreated';
  store[counter]++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${net.id}:${store[counter]}`));
  let id;
  do id = (kind === 'floorPlan' ? 'g_' : '') + r.digits(18);
  while (taken.some((x) => x.id === id));
  return id;
}

// ── Images ──

// Pixel size of a PNG, GIF or JPEG, or null for anything else.
function imageSize(buf) {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('latin1', 12, 16) === 'IHDR') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf.length >= 10 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 <= buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1];
      // Start of frame markers, skipping DHT, JPG and DAC which share the range.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Only the MD5 and aspect ratio are kept. Every image is saved as PNG.
function image(b64) {
  const text = need(b64, 'imageContents').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw badRequest("'imageContents' must be base 64 encoded");
  const buf = Buffer.from(text, 'base64');
  const size = imageSize(buf);
  if (!size || !size[0] || !size[1]) throw badRequest("'imageContents' must be a PNG, GIF or JPG image");
  return { md5: createHash('md5').update(buf).digest('hex'), aspect: size[0] / size[1] };
}

// ── Geometry, in metres on a flat local grid (fine at building scale) ──
// A plan keeps the point it was placed by as its grid origin, so the corners
// given come back as given.

const cosLat = (lat) => Math.cos((lat * Math.PI) / 180);
const toXY = (o, p) => [(p.lng - o.lng) * M_PER_DEG * cosLat(o.lat), (p.lat - o.lat) * M_PER_DEG];
const toGeo = (o, [x, y]) => ({ lat: o.lat + y / M_PER_DEG, lng: o.lng + x / (M_PER_DEG * cosLat(o.lat)) });

// A point on the plan, from fractions of its width (left to right) and height (bottom to top).
function onPlan(p, fx, fy) {
  const u = [Math.cos(p.angle), Math.sin(p.angle)];
  const v = [-u[1], u[0]];
  const a = (fx - 0.5) * p.width;
  const b = (fy - 0.5) * p.height;
  return toGeo(p.origin, [p.cxy[0] + a * u[0] + b * v[0], p.cxy[1] + a * u[1] + b * v[1]]);
}

const centerOf = (p) => toGeo(p.origin, p.cxy);

function pointOf(b, k) {
  const p = b[k];
  if (typeof p.lat !== 'number' || typeof p.lng !== 'number') throw badRequest(`'${k}' needs both 'lat' and 'lng'`);
  if (Math.abs(p.lat) >= 90 || Math.abs(p.lng) > 180) throw badRequest(`'${k}' is not a valid location`);
  return { lat: p.lat, lng: p.lng };
}

const placedBy = (b) => POINTS.some((k) => b[k] != null);

// Over 'center' with no rotation, or lined up with the first two adjacent
// corners given. The image's aspect ratio always holds.
function place(b, aspect, width) {
  const pts = Object.fromEntries(POINTS.filter((k) => b[k] != null).map((k) => [k, pointOf(b, k)]));
  const keys = Object.values(pts).map((p) => `${p.lat},${p.lng}`);
  if (new Set(keys).size < keys.length) throw badRequest('No two points can have the same latitude, longitude pair');
  if (pts.center) return { origin: pts.center, cxy: [0, 0], angle: 0, width, height: width / aspect };
  const side = SIDES.find(([a, c]) => pts[a] && pts[c]);
  if (!side) throw badRequest("Either 'center' or two adjacent corners (e.g. 'topLeftCorner' and 'bottomLeftCorner') must be specified");
  const [a, c, edge] = side;
  const o = pts[a];
  const d = toXY(o, pts[c]);
  const len = Math.hypot(d[0], d[1]);
  let u, w, h, mid;
  if (edge === 'top' || edge === 'bottom') {
    // The side runs along the width; the plan extends down from the top, up from the bottom.
    [w, h] = [len, len / aspect];
    u = [d[0] / len, d[1] / len];
    const s = edge === 'top' ? -h / 2 : h / 2;
    mid = [d[0] / 2 - u[1] * s, d[1] / 2 + u[0] * s];
  } else {
    // The side runs down the height; the plan extends right from the left, left from the right.
    [w, h] = [len * aspect, len];
    u = [-d[1] / len, d[0] / len];
    const s = edge === 'left' ? w / 2 : -w / 2;
    mid = [d[0] / 2 + u[0] * s, d[1] / 2 + u[1] * s];
  }
  return { origin: o, cxy: mid, angle: Math.atan2(u[1], u[0]), width: w, height: h };
}

// ── Floor plans ──

const onFloorPlan = (net, id) => net.devices.filter((d) => d.floorPlanId === id);

function planJson(ctx, net, p) {
  return {
    floorPlanId: p.id,
    imageUrl: `https://floorplans.example.com/${net.id}/${p.id}/${p.imageMd5}.png`,
    imageUrlExpiresAt: iso(ctx.now + URL_TTL).replace('T', ' ').replace('Z', ' +00:00'),
    imageExtension: 'png',
    imageMd5: p.imageMd5,
    name: p.name,
    devices: onFloorPlan(net, p.id).map((d) => deviceJson(d)),
    width: round(p.width, 2),
    height: round(p.height, 2),
    center: centerOf(p),
    bottomLeftCorner: onPlan(p, 0, 0),
    bottomRightCorner: onPlan(p, 1, 0),
    topLeftCorner: onPlan(p, 0, 1),
    topRightCorner: onPlan(p, 1, 1),
    floorNumber: p.floorNumber,
  };
}

function checkName(name) {
  if (name != null && !name.trim()) throw badRequest("'name' must not be empty");
}

function createPlan(ctx) {
  const net = netOf(ctx);
  const store = storeOf(net);
  if (store.list.length >= MAX_PLANS) throw badRequest(`Networks are limited to ${MAX_PLANS} floor plans in the emulator`);
  const b = ctx.body;
  checkName(need(b.name, 'name'));
  const img = image(b.imageContents);
  if (!placedBy(b)) throw badRequest("Either 'center' or two adjacent corners (e.g. 'topLeftCorner' and 'bottomLeftCorner') must be specified");
  const plan = { id: null, name: b.name, floorNumber: b.floorNumber ?? null, imageMd5: img.md5, aspect: img.aspect, ...place(b, img.aspect, DEFAULT_WIDTH) };
  plan.id = nextId(ctx, store, 'floorPlan', net, store.list);
  store.list.push(plan);
  return planJson(ctx, net, plan);
}

// New corners or center move the plan. A new image alone recenters it with no
// rotation, keeping its width.
function updatePlan(ctx) {
  const { net, plan } = planOf(ctx);
  const b = ctx.body;
  checkName(b.name);
  const img = b.imageContents != null ? image(b.imageContents) : null;
  const aspect = img?.aspect ?? plan.aspect;
  let spot = null;
  if (placedBy(b)) spot = place(b, aspect, plan.width);
  else if (img) spot = { origin: centerOf(plan), cxy: [0, 0], angle: 0, width: plan.width, height: plan.width / aspect };
  if (b.name != null) plan.name = b.name;
  if (b.floorNumber !== undefined) plan.floorNumber = b.floorNumber;
  if (img) Object.assign(plan, { imageMd5: img.md5, aspect });
  if (spot) Object.assign(plan, spot);
  return planJson(ctx, net, plan);
}

// Its devices come off it and its auto locate jobs go with it.
function deletePlan(ctx) {
  const { net, store, plan } = planOf(ctx);
  store.list.splice(store.list.indexOf(plan), 1);
  store.jobs = store.jobs.filter((j) => j.floorPlanId !== plan.id);
  for (const d of onFloorPlan(net, plan.id)) d.floorPlanId = null;
}

function batchSize(list, name) {
  if (list.length > MAX_BATCH) throw badRequest(`'${name}' can have at most ${MAX_BATCH} items`);
}

// Checks every assignment before changing any.
function assignDevices(ctx) {
  const net = netOf(ctx);
  const list = ctx.body.assignments;
  batchSize(list, 'assignments');
  const moves = list.map((a, i) => {
    const dev = ctx.world.deviceBySerial.get(need(a, `assignments[${i}]`).serial);
    if (dev?.net !== net) throw badRequest(`Device ${a.serial} is not in this network`);
    const id = need(a.floorPlan, `assignments[${i}].floorPlan`).id;
    if (id !== null && !hasFloorPlan(net, id)) throw badRequest(`Floor plan ${id} does not exist in this network`);
    return [dev, id];
  });
  for (const [dev, id] of moves) dev.floorPlanId = id;
  return { success: true };
}

// ── Auto locate jobs ──

const apsOn = (net, id) => onFloorPlan(net, id).filter((d) => d.productType === 'wireless');

function jobOf(ctx) {
  const net = netOf(ctx);
  const store = storeOf(net);
  const job = store.jobs.find((j) => j.id === ctx.params.jobId);
  if (!job) throw notFound('Auto locate job');
  return { net, store, job };
}

// Status comes from the clock: scheduled, running, then finished, or error
// when there are fewer than two APs to range between. Progress stops at a
// cancel. A run without a refresh skips GNSS and reuses its ranging data.
function jobJson(net, job, now) {
  const t = Math.min(now, job.canceledAt ?? Infinity) - job.start;
  const canceled = job.canceledAt != null;
  const pct = (end) => (t < 0 ? 0 : t >= end ? 100 : Math.floor((t / end) * 100));
  const phase = (end, done) => (t < 0 ? 'scheduled' : t < end ? 'in progress' : done);
  const step = (status, percentage) => ({ status, completed: { percentage } });
  const span = job.refresh ? RUN : POSITION_ONLY;
  const rangingEnd = job.refresh ? RANGING_END : 0;
  const lonely = job.serials.length < 2;
  const status = job.publishedAt != null ? 'published' : canceled ? 'canceled' : phase(span, lonely ? 'error' : 'finished');
  return {
    id: job.id,
    networkId: net.id,
    floorPlanId: job.floorPlanId,
    status,
    scheduledAt: iso(job.scheduledAt),
    completed: { percentage: pct(span) },
    ranging: lonely ? step(t < 0 ? 'scheduled' : 'no neighbors', 0) : step(phase(rangingEnd, 'finished'), pct(rangingEnd)),
    gnss: job.refresh ? step(canceled && t < GNSS_END ? 'canceled' : phase(GNSS_END, 'finished'), pct(GNSS_END)) : step('not applicable', 0),
    errors: status === 'error' ? [{ source: 'ranging', type: 'no neighbors' }] : [],
  };
}

const statusOf = (net, job, now) => jobJson(net, job, now).status;
const ACTIVE = new Set(['scheduled', 'in progress']);

// A time in the past is kept, so the job may already be running or finished.
function scheduleJobs(ctx) {
  const net = netOf(ctx);
  const store = storeOf(net);
  const list = ctx.body.jobs;
  batchSize(list, 'jobs');
  const busy = new Set(store.jobs.filter((j) => ACTIVE.has(statusOf(net, j, ctx.now))).map((j) => j.floorPlanId));
  const made = list.map((j, i) => {
    need(j, `jobs[${i}]`);
    if (!hasFloorPlan(net, j.floorPlanId)) throw badRequest(`Floor plan ${j.floorPlanId} does not exist in this network`);
    if (busy.has(j.floorPlanId)) throw badRequest(`Floor plan ${j.floorPlanId} already has an auto locate job scheduled or in progress`);
    busy.add(j.floorPlanId);
    const refresh = new Set(j.refresh ?? []);
    if (refresh.size && !(refresh.size === 2 && refresh.has('gnss') && refresh.has('ranging'))) throw badRequest(`'jobs[${i}].refresh' must contain both 'gnss' and 'ranging', or be empty`);
    const at = j.scheduledAt == null ? ctx.now : parseTime(j.scheduledAt);
    if (Number.isNaN(at)) throw badRequest(`'jobs[${i}].scheduledAt' must be an ISO8601 timestamp`);
    return { id: null, floorPlanId: j.floorPlanId, refresh: refresh.size > 0, scheduledAt: at, start: at, serials: apsOn(net, j.floorPlanId).map((d) => d.serial), canceledAt: null, publishedAt: null };
  });
  for (const job of made) {
    job.id = nextId(ctx, store, 'autoLocateJob', net, store.jobs);
    store.jobs.push(job);
  }
  store.jobs.splice(0, Math.max(0, store.jobs.length - MAX_JOBS));
  return { jobs: made.map((j) => jobJson(net, j, ctx.now)) };
}

function cancelJob(ctx) {
  const { net, job } = jobOf(ctx);
  const status = statusOf(net, job, ctx.now);
  if (!ACTIVE.has(status)) throw badRequest(`Auto locate job ${job.id} is ${status}; only a scheduled or in progress job can be canceled`);
  job.canceledAt = ctx.now;
}

// The devices named must be APs on the job's floor plan.
function jobDevices(net, job, list) {
  const aps = apsOn(net, job.floorPlanId);
  return list.map((d, i) => {
    const dev = aps.find((a) => a.serial === need(d, `devices[${i}]`).serial);
    if (!dev) throw badRequest(`Device ${d.serial} is not an access point on floor plan ${job.floorPlanId}`);
    return [dev, d];
  });
}

// The spot a job works out for an AP: a seeded place on the plan.
function calculated(world, plan, job, dev) {
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:autoLocate:${job.id}:${dev.serial}`));
  return onPlan(plan, 0.1 + 0.8 * r.next(), 0.1 + 0.8 * r.next());
}

// Moves the devices to the positions given, or to the calculated ones (a
// seeded spot on the plan) when the body names none.
function publishJob(ctx) {
  const { net, store, job } = jobOf(ctx);
  const status = statusOf(net, job, ctx.now);
  if (status !== 'finished') throw badRequest(`Auto locate job ${job.id} is ${status}; only a finished job can be published`);
  let moves;
  if (ctx.body.devices) {
    moves = jobDevices(net, job, ctx.body.devices).map(([dev, d], i) => [dev, { lat: need(d.lat, `devices[${i}].lat`), lng: need(d.lng, `devices[${i}].lng`) }, d.autoLocate?.isAnchor ?? undefined]);
  } else {
    const plan = store.list.find((p) => p.id === job.floorPlanId);
    moves = apsOn(net, plan.id)
      .filter((d) => job.serials.includes(d.serial))
      .map((dev) => [dev, calculated(ctx.world, plan, job, dev)]);
  }
  for (const [dev, at, isAnchor] of moves) {
    Object.assign(dev, at);
    if (isAnchor !== undefined) dev.autoLocate = { ...at, isAnchor };
  }
  job.publishedAt = ctx.now;
  return { success: true };
}

// Saves any anchors, then positions again from the data the job already has.
function recalculateJob(ctx) {
  const { net, job } = jobOf(ctx);
  const status = statusOf(net, job, ctx.now);
  if (ACTIVE.has(status) || status === 'canceled') throw badRequest(`Auto locate job ${job.id} is ${status}; only a finished, published or failed job can be recalculated`);
  const anchors = jobDevices(net, job, ctx.body.devices ?? []);
  const saved = anchors.map(([dev, d], i) => {
    const a = need(d.autoLocate, `devices[${i}].autoLocate`);
    return [dev, { lat: a.lat ?? dev.lat, lng: a.lng ?? dev.lng, isAnchor: need(a.isAnchor, `devices[${i}].autoLocate.isAnchor`) }];
  });
  for (const [dev, a] of saved) dev.autoLocate = a;
  Object.assign(job, { start: ctx.now, refresh: false, publishedAt: null, serials: apsOn(net, job.floorPlanId).map((d) => d.serial) });
  return { success: true };
}

// ── Organization auto locate views ──

// Floor plans in the organization's networks, read without creating stores.
function orgPlans(ctx) {
  const q = ctx.query;
  const nets = arrayParam(q, 'networkIds');
  const ids = arrayParam(q, 'floorPlanIds');
  return orgOf(ctx)
    .networks.filter((n) => !nets.length || nets.includes(n.id))
    .sort(byId)
    .flatMap((net) => (net.floorPlans?.list ?? []).filter((p) => !ids.length || ids.includes(p.id)).map((plan) => ({ net, plan })));
}

const latestJob = (net, plan) => (net.floorPlans?.jobs ?? []).filter((j) => j.floorPlanId === plan.id).at(-1);

// A saved anchor is the admin's own position. Otherwise the plan's latest
// job gives one once it has finished: suggested, then calculated when published.
function autoLocateOf(ctx, net, plan, dev) {
  if (dev.autoLocate) return { autoLocate: { lat: dev.autoLocate.lat, lng: dev.autoLocate.lng }, type: 'user', isAnchor: dev.autoLocate.isAnchor };
  const job = latestJob(net, plan);
  const status = job && job.serials.includes(dev.serial) ? statusOf(net, job, ctx.now) : null;
  if (status !== 'finished' && status !== 'published') return { autoLocate: null, type: null, isAnchor: false };
  const at = calculated(ctx.world, plan, job, dev);
  return { autoLocate: { lat: at.lat, lng: at.lng }, type: status === 'published' ? 'calculated' : 'suggested', isAnchor: false };
}

function orgAutoLocateDevices(ctx) {
  const rows = orgPlans(ctx)
    .flatMap(({ net, plan }) => apsOn(net, plan.id).map((dev) => ({ net, plan, dev })))
    .sort((a, b) => bySerial(a.dev, b.dev));
  // The spec wraps the page in a one-item array.
  return [
    paginateItems(ctx, rows, (x) => x.dev.serial, { def: 1000, max: 10000 }, ({ net, plan, dev }) => ({
      name: dev.name,
      serial: dev.serial,
      mac: dev.mac,
      model: dev.model,
      tags: [...dev.tags],
      status: deviceStatus(dev, ctx.now),
      network: { id: net.id },
      floorPlan: { id: plan.id, name: plan.name },
      lat: dev.lat,
      lng: dev.lng,
      ...autoLocateOf(ctx, net, plan, dev),
    })),
  ];
}

function orgAutoLocateStatuses(ctx) {
  const rows = orgPlans(ctx);
  return [
    paginateItems(ctx, rows, (x) => x.plan.id, { def: 1000, max: 10000 }, ({ net, plan }) => {
      const job = latestJob(net, plan);
      const jobs = job ? [jobJson(net, job, ctx.now)].map(({ id, status, scheduledAt, completed, ranging, gnss, errors }) => ({ id, status, scheduledAt, completed, ranging, gnss, errors })) : [];
      return { network: { id: net.id }, floorPlanId: plan.id, name: plan.name, counts: { devices: { total: apsOn(net, plan.id).length } }, jobs };
    }),
  ];
}

export default [
  {
    op: 'getNetworkFloorPlans',
    path: LIST,
    handler: (ctx) => {
      const net = netOf(ctx);
      return storeOf(net).list.map((p) => planJson(ctx, net, p));
    },
  },
  { op: 'createNetworkFloorPlan', method: 'POST', path: LIST, handler: createPlan },
  {
    op: 'getNetworkFloorPlan',
    path: PLAN,
    sample: MISSING,
    handler: (ctx) => {
      const { net, plan } = planOf(ctx);
      return planJson(ctx, net, plan);
    },
  },
  { op: 'updateNetworkFloorPlan', method: 'PUT', path: PLAN, handler: updatePlan },
  { op: 'deleteNetworkFloorPlan', method: 'DELETE', path: PLAN, handler: deletePlan },
  { op: 'batchNetworkFloorPlansDevicesUpdate', method: 'POST', path: `${LIST}/devices/batchUpdate`, status: 200, handler: assignDevices },
  { op: 'batchNetworkFloorPlansAutoLocateJobs', method: 'POST', path: `${LIST}/autoLocate/jobs/batch`, status: 200, handler: scheduleJobs },
  { op: 'cancelNetworkFloorPlansAutoLocateJob', method: 'POST', path: `${JOB}/cancel`, status: 204, handler: cancelJob },
  { op: 'publishNetworkFloorPlansAutoLocateJob', method: 'POST', path: `${JOB}/publish`, status: 200, handler: publishJob },
  { op: 'recalculateNetworkFloorPlansAutoLocateJob', method: 'POST', path: `${JOB}/recalculate`, status: 200, handler: recalculateJob },
  { op: 'getOrganizationFloorPlansAutoLocateDevices', path: '/organizations/{organizationId}/floorPlans/autoLocate/devices', handler: orgAutoLocateDevices },
  { op: 'getOrganizationFloorPlansAutoLocateStatuses', path: '/organizations/{organizationId}/floorPlans/autoLocate/statuses', handler: orgAutoLocateStatuses },
];
