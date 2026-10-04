// MT sensors: readings, gateway connections, alert profiles and their
// overviews, commands, livestream roles and MQTT broker settings. Readings
// come from sim/sensors.js. Profiles and roles keep device objects, so a swap
// keeps them and a removed device drops out on read.

import { configOf } from '../config.js';
import { arrayParam, badRequest, intParam, notFound, paginate, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr, unit } from '../rng.js';
import { eachOutage, isDown } from '../sim/outages.js';
import { latestRaw, metricsOf, rawReadings, readingJson, sensorsOf } from '../sim/sensors.js';
import { DAY, HOUR, isoMicro, iso } from '../time.js';
import { bySerial, collection, devOf, netOf, orgOf, productNet, requireModel } from './common.js';

const PROFILES = '/networks/{networkId}/sensor/alerts/profiles';
const MAX_PROFILES = 100;
const MAX_COMMANDS = 500;
const YEAR = 31556952;
const READING_METRICS = ['apparentPower', 'battery', 'button', 'co2', 'current', 'door', 'downstreamPower', 'frequency', 'humidity', 'indoorAirQuality', 'noise', 'pm25', 'powerFactor', 'realPower', 'remoteLockoutSwitch', 'temperature', 'tvoc', 'voltage', 'water'];
const ALERT_METRICS = ['apparentPower', 'co2', 'current', 'door', 'frequency', 'humidity', 'indoorAirQuality', 'noise', 'pm25', 'powerFactor', 'realPower', 'temperature', 'tvoc', 'upstreamPower', 'voltage', 'water'];
const INTERVALS = [900, 3600, 86400, 604800, 2629746];
const POWER_OPS = ['enableDownstreamPower', 'disableDownstreamPower', 'cycleDownstreamPower'];
// Seconds a command takes once the sensor picks it up.
const COMMAND_SECONDS = { refreshData: 10, enableDownstreamPower: 5, disableDownstreamPower: 5, cycleDownstreamPower: 5 };

const montreal = (world) => world.orgs[1].networks.find((n) => n.code === 'MTL');
const sensorNamed = (model) => (world) => sensorsOf(montreal(world)).find((d) => d.model === model).serial;
const NET_SAMPLE = { org: 1, networkId: (world) => montreal(world).id };

const tsOf = (t) => isoMicro(t);
const netRef = (net) => ({ id: net.id, name: net.name });
const alive = (world, net) => (d) => world.deviceBySerial.get(d.serial) === d && d.net === net;

const sensorNet = (ctx) => productNet(ctx, 'sensor');

function sensorDev(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'sensor');
  return dev;
}

// The organization's sensors after the networkIds and serials filters, by serial.
function orgSensors(ctx, serialsParam = 'serials') {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const serials = arrayParam(ctx.query, serialsParam);
  return org.devices.filter((d) => d.productType === 'sensor' && (!ids.length || ids.includes(d.net.id)) && (!serials.length || serials.includes(d.serial))).sort(bySerial);
}

function metricsParam(ctx, allowed) {
  const metrics = arrayParam(ctx.query, 'metrics');
  const bad = metrics.find((m) => !allowed.includes(m));
  if (bad) throw badRequest(`'metrics' must be some of: ${allowed.join(', ')}`);
  return metrics;
}

// ── Readings ──

const pad = (t) => String(Math.floor(t)).padStart(10, '0');

function readingsHistory(ctx) {
  const sensors = orgSensors(ctx);
  const metrics = metricsParam(ctx, READING_METRICS);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 7 * DAY, defaultSpan: 2 * HOUR, lookback: YEAR });
  const rows = [];
  for (const dev of sensors) {
    const want = metricsOf(dev).filter((m) => !metrics.length || metrics.includes(m));
    if (want.length) for (const r of rawReadings(dev, t0, t1, want)) rows.push([r, dev]);
  }
  rows.sort(([a, x], [b, y]) => a[0] - b[0] || bySerial(x, y) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const page = paginate(ctx, rows, ([r, d]) => `${pad(r[0])}_${d.serial}_${r[1]}`, { def: 1000, max: 1000 });
  return page.map(([r, dev]) => ({ serial: dev.serial, network: netRef(dev.net), ...readingJson(dev, r, tsOf) }));
}

function readingsLatest(ctx) {
  const sensors = orgSensors(ctx);
  const metrics = metricsParam(ctx, [...READING_METRICS, 'rawTemperature'].sort());
  const rows = [];
  for (const dev of sensors) {
    const want = metricsOf(dev).filter((m) => !metrics.length || metrics.includes(m));
    const latest = want.length ? latestRaw(dev, ctx.now, want) : [];
    if (latest.length) rows.push({ dev, latest });
  }
  const page = paginate(ctx, rows, (x) => x.dev.serial, { def: 1000, max: 1000 });
  return page.map(({ dev, latest }) => ({ serial: dev.serial, network: netRef(dev.net), readings: latest.map((r) => readingJson(dev, r, tsOf)) }));
}

// ── Gateway connections ──

// When the sensor last came back from an outage in the past 30 days, else when it was claimed.
function lastConnected(dev, now) {
  let at = dev.claimedAt;
  eachOutage(dev, Math.max(dev.claimedAt, now - 30 * DAY), now, (_, end) => {
    if (end <= now) at = Math.max(at, end);
  });
  return at;
}

function gatewayConnections(ctx) {
  const rows = [];
  for (const dev of orgSensors(ctx, 'sensorSerials')) {
    const latest = latestRaw(dev, ctx.now);
    if (!latest.length) continue;
    const reported = Math.max(...latest.map((r) => r[0]));
    for (const ap of [...dev.net.aps].sort(bySerial)) {
      const rssi = -45 - Math.floor(unit(hashStr(`${dev.serial}:${ap.serial}`), 0) * 40);
      rows.push({ dev, ap, rssi, reported });
    }
  }
  return paginateItems(ctx, rows, (x) => `${x.dev.serial}_${x.ap.serial}`, { def: 1000, max: 1000 }, (x) => ({
    lastReportedAt: iso(x.reported),
    lastConnectedAt: iso(lastConnected(x.dev, ctx.now)),
    rssi: x.rssi,
    network: { name: x.dev.net.name, id: x.dev.net.id },
    sensor: { serial: x.dev.serial, name: x.dev.name ?? '', mac: x.dev.mac },
    gateway: { serial: x.ap.serial, name: x.ap.name ?? '', mac: x.ap.mac },
  }));
}

// ── Alert profiles ──

const QUALITY = ['good', 'fair', 'poor', 'inadequate'];
// Upper bounds of good, fair and poor; higher is worse except the air quality score.
const QUALITY_BANDS = { humidity: null, tvoc: [261, 660, 2200], co2: [800, 1000, 1500], pm25: [12, 35, 55], noise: [55, 65, 75] };
// Metric: [the threshold's fields, a direction applies, ranges].
const THRESHOLDS = {
  temperature: [['celsius', 'fahrenheit', 'quality'], true],
  humidity: [['relativePercentage', 'quality'], true, { relativePercentage: [0, 100] }],
  water: [['present']],
  door: [['open']],
  tvoc: [['concentration', 'quality']],
  co2: [['concentration', 'quality']],
  pm25: [['concentration', 'quality']],
  noise: [['level', 'quality']],
  indoorAirQuality: [['score', 'quality'], false, { score: [0, 100] }],
  realPower: [['draw'], true, { draw: [0, 3750] }],
  apparentPower: [['draw'], true, { draw: [0, 3750] }],
  powerFactor: [['percentage'], true, { percentage: [0, 100] }],
  current: [['draw'], true, { draw: [0, 15] }],
  voltage: [['level'], true, { level: [0, 250] }],
  frequency: [['level'], true, { level: [0, 60] }],
  upstreamPower: [['outageDetected']],
};
const FLAGS = { water: 'present', door: 'open', upstreamPower: 'outageDetected' };

function qualityOf(metric, v) {
  if (metric === 'temperature') {
    const d = Math.abs(v - 21);
    return QUALITY[d < 3 ? 0 : d < 5 ? 1 : d < 8 ? 2 : 3];
  }
  if (metric === 'humidity') return QUALITY[v >= 30 && v <= 50 ? 0 : v >= 25 && v <= 60 ? 1 : v >= 20 && v <= 70 ? 2 : 3];
  if (metric === 'indoorAirQuality') return QUALITY[v >= 80 ? 0 : v >= 60 ? 1 : v >= 40 ? 2 : 3];
  const b = QUALITY_BANDS[metric];
  return QUALITY[v <= b[0] ? 0 : v <= b[1] ? 1 : v <= b[2] ? 2 : 3];
}

// Whether a reading breaks a condition. A quality threshold alerts at that level or worse.
function breaks(c, v) {
  const t = c.threshold;
  if (c.metric === 'upstreamPower') return false;
  if (FLAGS[c.metric]) return v === 1;
  if (t.quality != null) return QUALITY.indexOf(qualityOf(c.metric, v)) >= QUALITY.indexOf(t.quality);
  const x = t.celsius ?? t.relativePercentage ?? t.concentration ?? t.level ?? t.score ?? t.draw ?? t.percentage;
  if (c.metric === 'indoorAirQuality') return v < x;
  return c.direction === 'below' ? v < x : v > x;
}

function checkThreshold(metric, threshold, at) {
  if (threshold == null || typeof threshold !== 'object') throw badRequest(`'${at}.threshold' is required`);
  const keys = Object.keys(threshold).filter((k) => threshold[k] != null);
  if (keys.length !== 1 || keys[0] !== metric) throw badRequest(`'${at}.threshold' must hold one key, '${metric}', matching the condition's metric`);
  let t = threshold[metric];
  const where = `${at}.threshold.${metric}`;
  if (metric === 'noise') {
    if (t.ambient == null) throw badRequest(`'${where}.ambient' is required`);
    t = t.ambient;
  }
  const [fields, , ranges = {}] = THRESHOLDS[metric];
  if (FLAGS[metric]) {
    if (t[FLAGS[metric]] !== true) throw badRequest(`'${where}.${FLAGS[metric]}' must be true`);
    return { [FLAGS[metric]]: true };
  }
  const given = fields.filter((f) => t[f] != null);
  if (!given.length) throw badRequest(`'${where}' needs one of: ${fields.join(', ')}`);
  if (t.quality != null && given.length > 1) throw badRequest(`'${where}' takes either a value or 'quality', not both`);
  if (t.quality != null) return { quality: t.quality };
  const out = {};
  for (const f of given) {
    const r = ranges[f];
    if (r && (t[f] < r[0] || t[f] > r[1])) throw badRequest(`'${where}.${f}' must be between ${r[0]} and ${r[1]}`);
  }
  if (metric === 'temperature') out.celsius = t.celsius ?? Math.round((((t.fahrenheit - 32) * 5) / 9) * 100) / 100;
  else out[given[0]] = t[given[0]];
  return out;
}

function checkConditions(list) {
  if (!list.length) throw badRequest("'conditions' must not be empty");
  return list.map((c, i) => {
    const at = `conditions[${i}]`;
    if (c.metric == null) throw badRequest(`'${at}.metric' is required`);
    const threshold = checkThreshold(c.metric, c.threshold, at);
    const directional = THRESHOLDS[c.metric][1];
    if (directional && c.direction == null) throw badRequest(`'${at}.direction' is required for ${c.metric}`);
    if (!directional && c.direction != null) throw badRequest(`'${at}.direction' only applies to temperature, humidity, realPower, apparentPower, powerFactor, voltage, current and frequency`);
    return { metric: c.metric, threshold, ...(directional ? { direction: c.direction } : {}), duration: c.duration ?? 0 };
  });
}

function thresholdJson(c) {
  const t = c.threshold;
  let inner = { ...t };
  if (c.metric === 'temperature' && t.celsius != null) inner = { celsius: t.celsius, fahrenheit: Math.round(((t.celsius * 9) / 5 + 32) * 100) / 100 };
  if (c.metric === 'noise') inner = { ambient: inner };
  return { [c.metric]: inner };
}

const profilesOf = (net) => (net.sensorAlertProfiles ??= { created: 0, list: [] });
const httpServerIds = (net) => new Set(configOf(net).httpServers.map((s) => s.id));
const profileSensors = (world, net, p) => p.sensors.filter(alive(world, net));

function checkProfile(ctx, net, b) {
  const out = {};
  if (b.schedule?.id) throw badRequest("'schedule.id' must name a sensor schedule, and the emulator has none; leave it out to alert at all times");
  if (b.conditions != null) out.conditions = checkConditions(b.conditions);
  const r = b.recipients ?? {};
  if (r.emails != null) {
    const bad = r.emails.find((e) => typeof e !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad !== undefined) throw badRequest(`'recipients.emails' has an invalid email address: ${bad}`);
    out.emails = [...new Set(r.emails)];
  }
  if (r.smsNumbers != null) {
    const bad = r.smsNumbers.find((n) => typeof n !== 'string' || !/^\+?[0-9]{7,15}$/.test(n));
    if (bad !== undefined) throw badRequest(`'recipients.smsNumbers' has an invalid phone number: ${bad}`);
    out.smsNumbers = [...new Set(r.smsNumbers)];
  }
  if (r.httpServerIds != null) {
    const have = httpServerIds(net);
    const bad = r.httpServerIds.find((id) => !have.has(id));
    if (bad !== undefined) throw badRequest(`'recipients.httpServerIds' names ${bad}, which is not one of this network's webhook HTTP servers`);
    out.httpServerIds = [...new Set(r.httpServerIds)];
  }
  if (b.serials != null) {
    out.sensors = [...new Set(b.serials)].map((s) => {
      const d = ctx.world.deviceBySerial.get(s);
      if (!d || d.net !== net || d.productType !== 'sensor') throw badRequest(`'serials' names ${s}, which is not a sensor in this network`);
      return d;
    });
  }
  return out;
}

function applyProfile(p, b, net, ctx, checked) {
  if (b.name != null) p.name = b.name;
  Object.assign(p, checked);
  if (b.includeSensorUrl != null) p.includeSensorUrl = b.includeSensorUrl;
  if (b.message != null) p.message = b.message;
}

function profileJson(p, net, ctx) {
  const have = httpServerIds(net);
  return {
    profileId: p.profileId,
    name: p.name,
    conditions: p.conditions.map((c) => ({ metric: c.metric, threshold: thresholdJson(c), ...(c.direction ? { direction: c.direction } : {}), duration: c.duration })),
    recipients: { emails: [...p.emails], smsNumbers: [...p.smsNumbers], httpServerIds: p.httpServerIds.filter((id) => have.has(id)) },
    serials: profileSensors(ctx.world, net, p).map((d) => d.serial),
    includeSensorUrl: p.includeSensorUrl,
    message: p.message,
  };
}

const profiles = collection({
  ops: { list: 'getNetworkSensorAlertsProfiles', create: 'createNetworkSensorAlertsProfile', get: 'getNetworkSensorAlertsProfile', update: 'updateNetworkSensorAlertsProfile', delete: 'deleteNetworkSensorAlertsProfile' },
  path: PROFILES,
  param: 'id',
  key: 'profileId',
  parent: sensorNet,
  store: profilesOf,
  what: 'sensor alert profile',
  kind: 'sensorAlertProfile',
  max: MAX_PROFILES,
  required: ['name', 'conditions'],
  check: checkProfile,
  blank: () => ({ name: null, conditions: [], emails: [], smsNumbers: [], httpServerIds: [], sensors: [], includeSensorUrl: true, message: '' }),
  apply: applyProfile,
  json: profileJson,
  missing: { ...NET_SAMPLE, id: '1', status: 404 },
});

// Each run of breaking readings that lasts the condition's duration is one
// alert, at the moment it lasted that long. `fn(t)` gets each alert.
function eachAlert(dev, c, a, b, fn) {
  if (c.metric === 'upstreamPower' || !metricsOf(dev).includes(c.metric)) return;
  let start = null;
  let fired = false;
  for (const [t, , v] of rawReadings(dev, a - c.duration - HOUR, b, [c.metric])) {
    if (!breaks(c, v)) {
      start = null;
      continue;
    }
    if (start == null) {
      start = t;
      fired = false;
    }
    if (!fired && t - start >= c.duration) {
      fired = true;
      if (t >= a) fn(t);
    }
  }
}

// Whether a condition's latest run of breaking readings has lasted its duration by now.
function alertingNow(dev, c, now) {
  if (c.metric === 'upstreamPower' || !metricsOf(dev).includes(c.metric)) return false;
  let start = null;
  for (const [t, , v] of rawReadings(dev, now - c.duration - 2 * HOUR, now, [c.metric])) start = breaks(c, v) ? (start ?? t) : null;
  return start != null && now - start >= c.duration;
}

function emptyCounts() {
  const out = {};
  for (const m of ALERT_METRICS) out[m] = m === 'noise' ? { ambient: 0 } : 0;
  return out;
}

const bump = (counts, metric) => (metric === 'noise' ? counts.noise.ambient++ : counts[metric]++);

function currentOverview(ctx) {
  const net = sensorNet(ctx);
  const sensors = sensorsOf(net);
  const supported = ALERT_METRICS.filter((m) => sensors.some((d) => metricsOf(d).includes(m)));
  const counts = emptyCounts();
  const alerting = new Map(ALERT_METRICS.map((m) => [m, new Set()]));
  for (const p of profilesOf(net).list) {
    for (const dev of profileSensors(ctx.world, net, p)) for (const c of p.conditions) if (alertingNow(dev, c, ctx.now)) alerting.get(c.metric).add(dev);
  }
  for (const [m, devs] of alerting) for (let i = 0; i < devs.size; i++) bump(counts, m);
  return { supportedMetrics: supported, counts };
}

function alertOverview(ctx) {
  const net = sensorNet(ctx);
  const q = ctx.query;
  const interval = intParam(q, 'interval', null);
  if (interval != null && !INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of: ${INTERVALS.join(', ')}`);
  const timed = q.has('t0') || q.has('t1') || q.has('timespan');
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 366 * DAY, defaultSpan: interval && !timed ? Math.max(7 * DAY, interval) : 7 * DAY, lookback: 731 * DAY });
  // Without an interval, the largest that fits the span.
  const step = interval ?? (timed ? [...INTERVALS].reverse().find((i) => i <= t1 - t0) ?? INTERVALS[0] : 604800);
  if ((t1 - t0) / step > 1000) throw badRequest(`'interval' of ${step} seconds gives more than 1000 buckets for this timespan`);
  const buckets = [];
  for (let s = t0; s < t1; s += step) buckets.push({ start: s, end: Math.min(s + step, t1), counts: emptyCounts() });
  for (const p of profilesOf(net).list) {
    for (const dev of profileSensors(ctx.world, net, p)) {
      for (const c of p.conditions) {
        eachAlert(dev, c, t0, t1, (t) => {
          const bucket = buckets[Math.min(buckets.length - 1, Math.floor((t - t0) / step))];
          if (bucket) bump(bucket.counts, c.metric);
        });
      }
    }
  }
  return buckets.map((x) => ({ startTs: iso(x.start), endTs: iso(x.end - 1), counts: x.counts }));
}

// ── Commands ──

const commandsOf = (dev) => (dev.sensorCommands ??= { created: 0, list: [] });

function commandStatus(c, now) {
  if (now < c.start) return 'pending';
  if (now < c.end) return 'in_progress';
  return c.failed ? 'failed' : 'completed';
}

function commandJson(ctx, c) {
  const status = commandStatus(c, ctx.now);
  return {
    commandId: c.commandId,
    createdAt: iso(c.createdAt),
    completedAt: status === 'completed' || status === 'failed' ? iso(c.end) : null,
    createdBy: { ...c.createdBy },
    operation: c.operation,
    status,
    errors: status === 'failed' ? [...c.errors] : [],
  };
}

function createCommand(ctx) {
  const dev = sensorDev(ctx);
  const op = ctx.body.operation;
  if (op == null) throw badRequest("'operation' is required");
  if (POWER_OPS.includes(op) && dev.model !== 'MT40') throw badRequest(`'${op}' is only supported on MT40 power monitors`);
  if (op === 'refreshData' && dev.model !== 'MT15' && dev.model !== 'MT40') throw badRequest("'refreshData' is only supported on MT15 and MT40 sensors");
  const store = commandsOf(dev);
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:sensorCommand:${dev.serial}:${store.created}`));
  const now = Math.floor(ctx.now);
  const start = ctx.frozen ? now : now + 1;
  const end = ctx.frozen ? now : start + COMMAND_SECONDS[op];
  const failed = isDown(dev, start);
  const a = ctx.world.apiAdmin;
  const c = { commandId: r.digits(13), createdAt: now, start, end, operation: op, failed, errors: failed ? ['The sensor is offline.'] : [], createdBy: { adminId: a.id, name: a.name, email: a.email } };
  store.list.push(c);
  if (store.list.length > MAX_COMMANDS) {
    const old = store.list.shift();
    // The outlet stays as the dropped command left it.
    if (!old.failed && POWER_OPS.includes(old.operation)) store.power = [old.end, old.operation !== 'disableDownstreamPower'];
  }
  return commandJson(ctx, c);
}

function listCommands(ctx) {
  const dev = sensorDev(ctx);
  const q = ctx.query;
  const ops = arrayParam(q, 'operations');
  const bad = ops.find((o) => !COMMAND_SECONDS[o]);
  if (bad) throw badRequest(`'operations' must be some of: ${Object.keys(COMMAND_SECONDS).join(', ')}`);
  const order = q.get('sortOrder') || 'descending';
  if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 30 * DAY, defaultSpan: 30 * DAY, lookback: 30 * DAY });
  const list = commandsOf(dev).list.filter((c) => c.createdAt >= t0 && c.createdAt <= t1 && (!ops.length || ops.includes(c.operation)));
  if (order === 'descending') list.reverse();
  return paginate(ctx, list, (c) => c.commandId, { def: 10, max: 1000 }).map((c) => commandJson(ctx, c));
}

function getCommand(ctx) {
  const dev = sensorDev(ctx);
  const c = commandsOf(dev).list.find((x) => x.commandId === ctx.params.commandId);
  if (!c) throw notFound('Sensor command');
  return commandJson(ctx, c);
}

// ── Livestream roles ──

// A sensor keeps the cameras it shows; a camera's are the sensors naming it.
function relatedOf(world, dev) {
  const net = dev.net;
  if (dev.productType === 'sensor') return (dev.sensorLivestream ?? []).filter(alive(world, net)).sort(bySerial);
  return sensorsOf(net).filter((s) => (s.sensorLivestream ?? []).includes(dev)).sort(bySerial);
}

const rolesJson = (world, dev) => ({ livestream: { relatedDevices: relatedOf(world, dev).map((d) => ({ serial: d.serial, productType: d.productType })) } });

function roleDev(ctx) {
  const dev = devOf(ctx);
  if (dev.productType !== 'sensor' && dev.productType !== 'camera') throw badRequest('Sensor roles are only supported on sensor and camera devices');
  return dev;
}

function updateRoles(ctx) {
  const dev = roleDev(ctx);
  const list = ctx.body.livestream?.relatedDevices;
  if (list == null) return rolesJson(ctx.world, dev);
  const want = dev.productType === 'sensor' ? 'camera' : 'sensor';
  const related = [];
  list.forEach((x, i) => {
    if (x?.serial == null) throw badRequest(`'livestream.relatedDevices[${i}].serial' is required`);
    const d = ctx.world.deviceBySerial.get(x.serial);
    if (!d || d.net !== dev.net || d.productType !== want) throw badRequest(`'livestream.relatedDevices[${i}].serial' must be a ${want} in this device's network`);
    if (!related.includes(d)) related.push(d);
  });
  if (dev.productType === 'sensor') dev.sensorLivestream = related;
  else {
    for (const s of sensorsOf(dev.net)) {
      const has = (s.sensorLivestream ?? []).filter((c) => c !== dev);
      s.sensorLivestream = related.includes(s) ? [...has, dev] : has;
    }
  }
  return rolesJson(ctx.world, dev);
}

function networkRoles(ctx) {
  const net = netOf(ctx);
  if (!net.productTypes.includes('sensor') && !net.productTypes.includes('camera')) throw badRequest("This endpoint requires a network with product type 'sensor' or 'camera'");
  return net.devices
    .filter((d) => d.productType === 'sensor' || d.productType === 'camera')
    .sort(bySerial)
    .map((d) => ({ device: { name: d.name ?? '', serial: d.serial, productType: d.productType }, relationships: rolesJson(ctx.world, d) }));
}

// ── MQTT brokers ──

const brokersOf = (net) => net.mqttBrokers?.list ?? [];
const sensorBrokerJson = (b) => ({ mqttBrokerId: b.id, enabled: Boolean(b.sensorEnabled) });

function sensorBroker(ctx) {
  const net = sensorNet(ctx);
  const b = brokersOf(net).find((x) => x.id === ctx.params.mqttBrokerId);
  if (!b) throw notFound('MQTT broker');
  return { net, b };
}

function updateSensorBroker(ctx) {
  const { net, b } = sensorBroker(ctx);
  const enabled = ctx.body.enabled;
  if (enabled == null) throw badRequest("'enabled' is required");
  const other = brokersOf(net).find((x) => x !== b && x.sensorEnabled);
  if (enabled && other) throw badRequest(`Only one MQTT broker can be enabled for sensor data; disable broker ${other.id} first`);
  b.sensorEnabled = enabled;
  return sensorBrokerJson(b);
}

const DEVICE_SAMPLE = { org: 1, serial: sensorNamed('MT40') };
const ROLE_SAMPLE = { org: 1, serial: sensorNamed('MT10') };

export default [
  { op: 'getOrganizationSensorReadingsHistory', path: '/organizations/{organizationId}/sensor/readings/history', sample: { org: 1 }, handler: readingsHistory },
  { op: 'getOrganizationSensorReadingsLatest', path: '/organizations/{organizationId}/sensor/readings/latest', sample: { org: 1 }, handler: readingsLatest },
  { op: 'getOrganizationSensorGatewaysConnectionsLatest', path: '/organizations/{organizationId}/sensor/gateways/connections/latest', sample: { org: 1 }, handler: gatewayConnections },
  ...profiles.routes.map((r) => ({ ...r, sample: r.sample ?? NET_SAMPLE, ...(r.method === 'POST' ? { status: 200 } : {}) })),
  { op: 'getNetworkSensorAlertsCurrentOverviewByMetric', path: '/networks/{networkId}/sensor/alerts/current/overview/byMetric', sample: NET_SAMPLE, handler: currentOverview },
  { op: 'getNetworkSensorAlertsOverviewByMetric', path: '/networks/{networkId}/sensor/alerts/overview/byMetric', sample: NET_SAMPLE, handler: alertOverview },
  { op: 'getDeviceSensorCommands', path: '/devices/{serial}/sensor/commands', sample: DEVICE_SAMPLE, handler: listCommands },
  { op: 'createDeviceSensorCommand', method: 'POST', path: '/devices/{serial}/sensor/commands', sample: DEVICE_SAMPLE, handler: createCommand },
  { op: 'getDeviceSensorCommand', path: '/devices/{serial}/sensor/commands/{commandId}', sample: { ...DEVICE_SAMPLE, commandId: '1284392014819', status: 404 }, handler: getCommand },
  { op: 'getDeviceSensorRelationships', path: '/devices/{serial}/sensor/relationships', sample: ROLE_SAMPLE, handler: (ctx) => rolesJson(ctx.world, roleDev(ctx)) },
  { op: 'updateDeviceSensorRelationships', method: 'PUT', path: '/devices/{serial}/sensor/relationships', sample: ROLE_SAMPLE, handler: updateRoles },
  { op: 'getNetworkSensorRelationships', path: '/networks/{networkId}/sensor/relationships', sample: NET_SAMPLE, handler: networkRoles },
  { op: 'getNetworkSensorMqttBrokers', path: '/networks/{networkId}/sensor/mqttBrokers', sample: NET_SAMPLE, handler: (ctx) => brokersOf(sensorNet(ctx)).map(sensorBrokerJson) },
  { op: 'getNetworkSensorMqttBroker', path: '/networks/{networkId}/sensor/mqttBrokers/{mqttBrokerId}', sample: { ...NET_SAMPLE, mqttBrokerId: '1234', status: 404 }, handler: (ctx) => sensorBrokerJson(sensorBroker(ctx).b) },
  // Montreal has no brokers until one is made, so the sample takes the first made.
  { op: 'updateNetworkSensorMqttBroker', method: 'PUT', path: '/networks/{networkId}/sensor/mqttBrokers/{mqttBrokerId}', sample: { ...NET_SAMPLE, mqttBrokerId: (world) => montreal(world).mqttBrokers?.list[0]?.id ?? '1234' }, handler: updateSensorBroker },
];
