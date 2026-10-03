// Camera settings, video links and snapshots, quality retention profiles and
// MQTT brokers. Cameras start at the defaults below, and networks start with
// no profiles or brokers; writes fill them in.

import { deviceUrl, nodeId } from '../format.js';
import { badRequest, intParam, notFound } from '../http.js';
import { Rand, derive, hashStr } from '../rng.js';
import { DAY, MIN, iso, parseTime } from '../time.js';
import { isDown } from '../sim/outages.js';
import { collection, devOf, netOf, requireModel, requireProduct } from './common.js';

const DEV = '/devices/{serial}/camera';
const PROFILES = '/networks/{networkId}/camera/qualityRetentionProfiles';
const PROFILE = `${PROFILES}/{qualityRetentionProfileId}`;
const BROKERS = '/networks/{networkId}/mqttBrokers';
const BROKER = `${BROKERS}/{mqttBrokerId}`;
const MAX_PROFILES = 100;
const MAX_BROKERS = 100;
const RETENTION_DAYS = 30; // what a camera with no profile cap keeps
const LINK_TTL = 30 * MIN;
const MAX_CLIP = 5 * MIN;
const SECURITY_MODES = ['none', 'tls'];
const MISSING = { qualityRetentionProfileId: '578149602163689000', mqttBrokerId: '578149602163689001', status: 404 };

// Profile videoSettings key and supported video per camera model.
const VIDEO = {
  MV22: { key: 'MV12/MV22/MV72', qualities: ['Standard', 'Enhanced', 'High'], resolutions: ['1280x720', '1920x1080'] },
  MV72: { key: 'MV12/MV22/MV72', qualities: ['Standard', 'Enhanced', 'High'], resolutions: ['1280x720', '1920x1080'] },
};
const DETECTION_MODELS = [
  { id: '0', description: 'People and vehicles' },
  { id: '1', description: 'People' },
  { id: '2', description: 'Vehicles' },
];
const SCHEDULES = ['Business hours', 'After hours', 'Weekdays', 'Weekends'];

// ── Per-camera settings ──

function cameraOf(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'camera');
  return dev;
}

const settingsOf = (dev) =>
  (dev.cameraSettings ??= {
    profileId: null,
    motionBasedRetentionEnabled: false,
    audioRecordingEnabled: false,
    restrictedBandwidthModeEnabled: false,
    quality: 'Standard',
    resolution: '1280x720',
    motionDetectorVersion: 2,
    externalRtspEnabled: false,
    senseEnabled: false,
    mqttBrokerId: null,
    audioDetection: false,
    detectionModelId: DETECTION_MODELS[0].id,
  });

// A profile or broker that was deleted, or belongs to a network the camera
// left, no longer applies.
const profileFor = (dev) => profilesOf(dev.net).list.find((p) => p.id === settingsOf(dev).profileId) ?? null;
const brokerFor = (dev) => brokersOf(dev.net).list.find((b) => b.id === settingsOf(dev).mqttBrokerId) ?? null;

// A profile overrides every per-camera setting, video too when it has some for the model.
function qualityJson(dev) {
  const s = settingsOf(dev);
  const p = profileFor(dev);
  const from = p ?? s;
  const video = (p && p.videoSettings[VIDEO[dev.model]?.key]) || s;
  return {
    profileId: p?.id ?? null,
    motionBasedRetentionEnabled: from.motionBasedRetentionEnabled,
    audioRecordingEnabled: from.audioRecordingEnabled,
    restrictedBandwidthModeEnabled: from.restrictedBandwidthModeEnabled,
    quality: video.quality,
    resolution: video.resolution,
    motionDetectorVersion: from.motionDetectorVersion,
  };
}

function checkVideo(dev, b) {
  const v = VIDEO[dev.model];
  if (!v) return;
  if (b.quality != null && !v.qualities.includes(b.quality)) throw badRequest(`Quality '${b.quality}' is not supported by ${dev.model} cameras`);
  if (b.resolution != null && !v.resolutions.includes(b.resolution)) throw badRequest(`Resolution '${b.resolution}' is not supported by ${dev.model} cameras`);
}

function updateQuality(ctx) {
  const dev = cameraOf(ctx);
  const b = ctx.body;
  if (b.profileId != null && !profilesOf(dev.net).list.some((p) => p.id === b.profileId)) throw badRequest(`Quality retention profile ${b.profileId} does not exist in this network`);
  checkVideo(dev, b);
  const s = settingsOf(dev);
  if (b.profileId !== undefined) s.profileId = b.profileId;
  for (const k of ['motionBasedRetentionEnabled', 'audioRecordingEnabled', 'restrictedBandwidthModeEnabled', 'quality', 'resolution', 'motionDetectorVersion']) {
    if (b[k] != null) s[k] = b[k];
  }
  return qualityJson(dev);
}

function videoJson(dev) {
  const on = settingsOf(dev).externalRtspEnabled;
  return { externalRtspEnabled: on, ...(on && { rtspUrl: `rtsp://${dev.lanIp}:9000/live` }) };
}

// MV Sense publishes on these topics once it has a broker to send to.
function senseJson(dev) {
  const s = settingsOf(dev);
  const broker = brokerFor(dev);
  const base = `/merakimv/${dev.serial}`;
  const topics = s.senseEnabled && broker ? [`${base}/raw_detections`, `${base}/light`, `${base}/net.meraki.detector`, `${base}/0`] : [];
  if (topics.length && s.audioDetection) topics.push(`${base}/audio_detections`);
  return { senseEnabled: s.senseEnabled, mqttBrokerId: broker?.id ?? null, mqttTopics: topics, audioDetection: { enabled: s.audioDetection }, detectionModelId: s.detectionModelId };
}

function updateSense(ctx) {
  const dev = cameraOf(ctx);
  const b = ctx.body;
  if (b.mqttBrokerId != null && !brokersOf(dev.net).list.some((x) => x.id === b.mqttBrokerId)) throw badRequest(`MQTT broker ${b.mqttBrokerId} does not exist in this network`);
  if (b.detectionModelId != null && !DETECTION_MODELS.some((m) => m.id === b.detectionModelId)) throw badRequest(`Object detection model ${b.detectionModelId} does not exist`);
  const s = settingsOf(dev);
  if (b.senseEnabled != null) s.senseEnabled = b.senseEnabled;
  if (b.mqttBrokerId !== undefined) s.mqttBrokerId = b.mqttBrokerId;
  if (b.audioDetection?.enabled != null) s.audioDetection = b.audioDetection.enabled;
  if (b.detectionModelId != null) s.detectionModelId = b.detectionModelId;
  return senseJson(dev);
}

// ── Video links, snapshots and clips ──

function timeOf(v, name) {
  const t = parseTime(v);
  if (!Number.isFinite(t)) throw badRequest(`'${name}' must be an ISO 8601 timestamp`);
  return t;
}

function videoLink(ctx) {
  const dev = cameraOf(ctx);
  const v = ctx.query.get('timestamp');
  const ms = Math.round((v ? timeOf(v, 'timestamp') : ctx.now) * 1000);
  return {
    url: `${deviceUrl(dev)}?timestamp=${ms}`,
    visionUrl: `https://vision.meraki.com/n/${dev.net.id.replace(/\D/g, '')}/cameras/${nodeId(dev)}?ts=${ms}`,
  };
}

const retentionDays = (dev) => profileFor(dev)?.maxRetentionDays ?? RETENTION_DAYS;

// Footage lives on the camera, so it has to be up to send any.
function checkFootage(ctx, dev, t, name) {
  if (t > ctx.now) throw badRequest(`'${name}' must not be in the future`);
  const days = retentionDays(dev);
  if (t < ctx.now - days * DAY) throw badRequest(`'${name}' is older than the camera's ${days} day retention`);
}

function checkOnline(ctx, dev) {
  if (isDown(dev, ctx.now)) throw badRequest('The camera is offline');
}

function link(ctx, dev, kind, t) {
  const key = hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${dev.serial}:${t}:${ctx.now}`);
  const token = [0, 1, 2].map((i) => derive(key, i).toString(16).padStart(8, '0')).join('');
  const path = kind === 'clip' ? `video/mp4/clip/${token}.mp4` : `stream/jpeg/snapshot/${token}`;
  return { url: `https://camera.example.com/${path}`, expiry: `Access to the image will expire at ${iso(ctx.now + LINK_TTL)}.` };
}

function snapshot(ctx) {
  const dev = cameraOf(ctx);
  const b = ctx.body;
  if (b.fullframe && b.timestamp != null) throw badRequest("'fullframe' can't be used with 'timestamp'");
  const t = b.timestamp != null ? timeOf(b.timestamp, 'timestamp') : ctx.now;
  checkFootage(ctx, dev, t, 'timestamp');
  checkOnline(ctx, dev);
  return link(ctx, dev, 'snapshot', t);
}

function clip(ctx) {
  const dev = cameraOf(ctx);
  const q = ctx.query;
  for (const name of ['startTimestamp', 'endTimestamp']) if (!q.get(name)) throw badRequest(`'${name}' is required`);
  const t0 = timeOf(q.get('startTimestamp'), 'startTimestamp');
  const t1 = timeOf(q.get('endTimestamp'), 'endTimestamp');
  if (intParam(q, 'imagerId', 0) !== 0) throw badRequest("'imagerId' must be omitted or 0 for single-imager cameras");
  if (t1 <= t0) throw badRequest("'endTimestamp' must be after 'startTimestamp'");
  if (t1 - t0 > MAX_CLIP) throw badRequest('Clips can be at most 5 minutes long');
  checkFootage(ctx, dev, t0, 'startTimestamp');
  checkFootage(ctx, dev, t1, 'endTimestamp');
  checkOnline(ctx, dev);
  return link(ctx, dev, 'clip', t0);
}

// ── Quality retention profiles and schedules ──

// Kept on the network, not its config, so copying a network doesn't copy them.
const profilesOf = (net) => (net.cameraProfiles ??= { created: 0, list: [] });
const brokersOf = (net) => (net.mqttBrokers ??= { created: 0, list: [] });

function cameraNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'camera');
  return net;
}

function schedulesOf(ctx, net) {
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:cameraSchedules:${net.id}`));
  return SCHEDULES.map((name) => ({ id: r.digits(18), name }));
}

function checkProfile(ctx, net, b) {
  if (b.maxRetentionDays != null && (b.maxRetentionDays < 1 || b.maxRetentionDays > 90)) throw badRequest("'maxRetentionDays' must be between 1 and 90");
  if (b.motionDetectorVersion != null && ![1, 2].includes(b.motionDetectorVersion)) throw badRequest("'motionDetectorVersion' must be 1 or 2");
  if (b.scheduleId != null && !schedulesOf(ctx, net).some((s) => s.id === b.scheduleId)) throw badRequest(`Schedule ${b.scheduleId} does not exist in this network`);
}

function applyProfile(p, b) {
  for (const k of ['name', 'motionBasedRetentionEnabled', 'restrictedBandwidthModeEnabled', 'audioRecordingEnabled', 'cloudArchiveEnabled', 'motionDetectorVersion']) {
    if (b[k] != null) p[k] = b[k];
  }
  for (const k of ['scheduleId', 'maxRetentionDays']) if (b[k] !== undefined) p[k] = b[k];
  if (b.smartRetention?.enabled != null) p.smartRetention = b.smartRetention.enabled;
  for (const [model, v] of Object.entries(b.videoSettings ?? {})) {
    if (v === null) delete p.videoSettings[model];
    else p.videoSettings[model] = { quality: v.quality, resolution: v.resolution };
  }
}

function profileJson(p, net) {
  return {
    id: p.id,
    networkId: net.id,
    name: p.name,
    restrictedBandwidthModeEnabled: p.restrictedBandwidthModeEnabled,
    motionBasedRetentionEnabled: p.motionBasedRetentionEnabled,
    audioRecordingEnabled: p.audioRecordingEnabled,
    cloudArchiveEnabled: p.cloudArchiveEnabled,
    maxRetentionDays: p.maxRetentionDays,
    scheduleId: p.scheduleId,
    motionDetectorVersion: p.motionDetectorVersion,
    smartRetention: { enabled: p.smartRetention },
    axisVideoQuality: 'standard',
    videoSettings: structuredClone(p.videoSettings),
  };
}

// Deleting one sends the cameras using it back to their own settings.
const profiles = collection({
  ops: {
    list: 'getNetworkCameraQualityRetentionProfiles',
    create: 'createNetworkCameraQualityRetentionProfile',
    get: 'getNetworkCameraQualityRetentionProfile',
    update: 'updateNetworkCameraQualityRetentionProfile',
    delete: 'deleteNetworkCameraQualityRetentionProfile',
  },
  path: PROFILES,
  param: 'qualityRetentionProfileId',
  parent: cameraNet,
  store: profilesOf,
  what: 'quality retention profile',
  kind: 'cameraProfile',
  max: MAX_PROFILES,
  required: ['name'],
  check: (ctx, net, b) => checkProfile(ctx, net, b),
  blank: () => ({ name: null, motionBasedRetentionEnabled: false, restrictedBandwidthModeEnabled: false, audioRecordingEnabled: false, cloudArchiveEnabled: false, maxRetentionDays: null, scheduleId: null, motionDetectorVersion: 2, smartRetention: false, videoSettings: {} }),
  apply: applyProfile,
  json: profileJson,
  missing: MISSING,
});

// ── MQTT brokers ──

// Brokers serve cameras (MV Sense) and sensors.
function brokerNet(ctx) {
  const net = netOf(ctx);
  if (!net.productTypes.some((p) => p === 'camera' || p === 'sensor')) throw badRequest("This endpoint requires a network with product type 'camera' or 'sensor'");
  return net;
}

// The CA certificate and password are kept but never sent back.
function brokerJson(b) {
  return {
    id: b.id,
    name: b.name,
    host: b.host,
    port: b.port,
    security: { mode: b.mode, tls: { hasCaCertificate: Boolean(b.caCertificate), verifyHostnames: b.verifyHostnames } },
    authentication: { username: b.username },
  };
}

function checkBroker(b) {
  if (b.host != null && !/^[^\s/]+$/.test(b.host)) throw badRequest("'host' must be a host name or IP address");
  if (b.port != null && (b.port < 1 || b.port > 65535)) throw badRequest("'port' must be between 1 and 65535");
  const mode = b.security?.mode;
  if (mode != null && !SECURITY_MODES.includes(mode)) throw badRequest(`'security.mode' must be one of: ${SECURITY_MODES.join(', ')}`);
}

function applyBroker(x, b) {
  for (const k of ['name', 'host', 'port']) if (b[k] != null) x[k] = b[k];
  if (b.security?.mode != null) x.mode = b.security.mode;
  const tls = b.security?.tls ?? {};
  if (tls.caCertificate !== undefined) x.caCertificate = tls.caCertificate || null;
  if (tls.verifyHostnames != null) x.verifyHostnames = tls.verifyHostnames;
  const auth = b.authentication ?? {};
  if (auth.username !== undefined) x.username = auth.username;
  if (auth.password !== undefined) x.password = auth.password;
}

// Deleting one stops the cameras sending to it.
const brokers = collection({
  ops: { list: 'getNetworkMqttBrokers', create: 'createNetworkMqttBroker', get: 'getNetworkMqttBroker', update: 'updateNetworkMqttBroker', delete: 'deleteNetworkMqttBroker' },
  path: BROKERS,
  param: 'mqttBrokerId',
  parent: brokerNet,
  store: brokersOf,
  what: 'MQTT broker',
  kind: 'mqttBroker',
  max: MAX_BROKERS,
  required: ['name', 'host', 'port'],
  check: (ctx, net, b) => checkBroker(b),
  blank: () => ({ name: null, host: null, port: null, mode: 'none', caCertificate: null, verifyHostnames: true, username: null, password: null }),
  apply: applyBroker,
  json: brokerJson,
  missing: MISSING,
});

const clipSample = (world, now) => `startTimestamp=${iso(now - 10 * MIN)}&endTimestamp=${iso(now - 8 * MIN)}`;

export default [
  { op: 'getDeviceCameraQualityAndRetention', path: `${DEV}/qualityAndRetention`, handler: (ctx) => qualityJson(cameraOf(ctx)) },
  { op: 'updateDeviceCameraQualityAndRetention', method: 'PUT', path: `${DEV}/qualityAndRetention`, handler: updateQuality },
  { op: 'getDeviceCameraVideoSettings', path: `${DEV}/video/settings`, handler: (ctx) => videoJson(cameraOf(ctx)) },
  {
    op: 'updateDeviceCameraVideoSettings',
    method: 'PUT',
    path: `${DEV}/video/settings`,
    handler: (ctx) => {
      const dev = cameraOf(ctx);
      if (ctx.body.externalRtspEnabled != null) settingsOf(dev).externalRtspEnabled = ctx.body.externalRtspEnabled;
      return videoJson(dev);
    },
  },
  { op: 'getDeviceCameraSense', path: `${DEV}/sense`, handler: (ctx) => senseJson(cameraOf(ctx)) },
  { op: 'updateDeviceCameraSense', method: 'PUT', path: `${DEV}/sense`, handler: updateSense },
  {
    op: 'getDeviceCameraSenseObjectDetectionModels',
    path: `${DEV}/sense/objectDetectionModels`,
    handler: (ctx) => {
      cameraOf(ctx);
      return structuredClone(DETECTION_MODELS);
    },
  },
  { op: 'getDeviceCameraVideoLink', path: `${DEV}/videoLink`, handler: videoLink },
  { op: 'generateDeviceCameraSnapshot', method: 'POST', path: `${DEV}/generateSnapshot`, status: 202, logged: false, handler: snapshot },
  { op: 'clipDeviceCamera', path: `${DEV}/clip`, status: 202, sample: { query: clipSample }, handler: clip },
  ...profiles.routes,
  { op: 'getNetworkCameraSchedules', path: '/networks/{networkId}/camera/schedules', handler: (ctx) => schedulesOf(ctx, cameraNet(ctx)) },
  ...brokers.routes,
];
