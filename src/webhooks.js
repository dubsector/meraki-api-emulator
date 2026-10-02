// Webhook payload templates, the alert types they render, and delivery of
// webhook tests and API callbacks, with retries and an organization-wide log.

import { configOf } from './config.js';
import { deviceUrl, orgJson } from './format.js';
import { badRequest, notFound } from './http.js';
import { Rand, hashStr } from './rng.js';
import { DAY, isoUs } from './time.js';

const ATTEMPTS = 3;
const RETRY_MS = [500, 1000];
const TIMEOUT_MS = 5000;
const LOG_DAYS = 31;
const MAX_LOGS = 5000;

const field = (name) => `"${name}":{{${name} | jsonify}}`;
const MERAKI_FIELDS = ['version', 'sharedSecret', 'sentAt', 'organizationId', 'organizationName', 'organizationUrl', 'networkId', 'networkName', 'networkUrl', 'networkTags', 'deviceSerial', 'deviceMac', 'deviceName', 'deviceUrl', 'deviceTags', 'deviceModel', 'alertId', 'alertType', 'alertTypeId', 'alertLevel', 'occurredAt', 'alertData'];
const text = (t) => `{"text":"${t}"}`;
const SUMMARY = '{{alertType}} in {{networkName}} ({{organizationName}}) at {{occurredAt}}';

// The included templates. Only the IDs (and the first and fifth names) come from the spec.
export const INCLUDED = [
  ['wpt_00001', 'Meraki (included)', `{${MERAKI_FIELDS.map(field).join(',')}}`],
  ['wpt_00002', 'Webex (included)', `{"markdown":"**${SUMMARY}**"}`],
  ['wpt_00003', 'Slack (included)', text(SUMMARY)],
  ['wpt_00004', 'Microsoft Teams (included)', text(SUMMARY)],
  ['wpt_00005', 'Callback (included)', `{${['version', 'sharedSecret', 'sentAt', 'organizationId', 'organizationName', 'alertId', 'alertType', 'alertTypeId', 'alertData'].map(field).join(',')}}`],
  ['wpt_00006', 'ServiceNow (included)', `{"short_description":"${SUMMARY}","severity":"{{alertLevel}}"}`],
  ['wpt_00007', 'PagerDuty (included)', `{"routing_key":"{{sharedSecret}}","event_action":"trigger","payload":{"summary":"${SUMMARY}","source":"{{networkName}}","severity":"{{alertLevel}}"}}`],
  ['wpt_00008', 'Splunk (included)', `{"event":{${MERAKI_FIELDS.slice(3).map(field).join(',')}}}`],
  ['wpt_00009', 'Google Chat (included)', text(SUMMARY)],
].map(([payloadTemplateId, name, body]) => ({ payloadTemplateId, type: 'included', name, headers: [], body, sharing: { byNetwork: { adminsCanModify: false } } }));

// Alert types a webhook can carry: [alertTypeId, alertType, productType, alertLevel, alertData].
// Down alerts and the appliance ones match what the network alert history sends.
const TYPES = [
  ['power_supply_down', 'Power supply went down', 'switch', 'critical', { num: 2 }],
  ['stopped_reporting', 'Appliances went down', 'appliance', 'critical', { minutes: 5 }],
  ['stopped_reporting', 'Switches went down', 'switch', 'critical', { minutes: 5 }],
  ['stopped_reporting', 'APs went down', 'wireless', 'warning', { minutes: 10 }],
  ['stopped_reporting', 'Cameras went down', 'camera', 'warning', { minutes: 30 }],
  ['failover_event', 'Failover event', 'appliance', 'warning', { uplink: '1', reason: 'wan1 unreachable' }],
  ['vpn_connectivity_change', 'VPN connectivity changed', 'appliance', 'warning', { vpn_type: 'site-to-site', peer_contact: '203.0.113.10:51820', peer_ident: 'Q2XX-AAAA-0001', connectivity: 'false' }],
  ['amp_malware_blocked', 'Malware blocked', 'appliance', 'critical', { clientMac: '00:11:22:33:44:66', fileHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', fileType: 'MS_EXE', canonicalName: 'Win.Trojan.Example' }],
  ['settings_changed', 'Settings changed', 'platform', 'informational', { page: 'Alerts', label: 'Alert settings', oldValue: 'disabled', newValue: 'enabled' }],
];
export const WEBHOOK_PRODUCTS = ['appliance', 'camera', 'cellularGateway', 'platform', 'sensor', 'sm', 'switch', 'wireless'];
const PLACEHOLDER_DEVICE = { appliance: ['My appliance', 'MX67'], switch: ['My switch', 'MS120-8LP'], wireless: ['My AP', 'MR34'], camera: ['My camera', 'MV12'] };

function example([alertTypeId, alertType, productType, alertLevel, alertData]) {
  const at = '2018-02-11T00:00:00.090210Z';
  const out = { version: '0.1', sharedSecret: 'secret', sentAt: at, alertId: '0000000000000000', alertType, alertTypeId, alertLevel, occurredAt: at, alertData: structuredClone(alertData) };
  Object.assign(out, { organizationId: '2930418', organizationName: 'My organization', organizationUrl: 'https://dashboard.meraki.com/o/VjjsAd/manage/organization/overview' });
  const device = PLACEHOLDER_DEVICE[productType];
  if (device) Object.assign(out, { deviceSerial: 'Q234-ABCD-5678', deviceMac: '00:11:22:33:44:55', deviceName: device[0], deviceUrl: 'https://n1.meraki.com//n//manage/nodes/new_list/000000000000', deviceTags: ['tag1', 'tag2'], deviceModel: device[1] });
  return Object.assign(out, { networkId: 'N_24329156', networkName: 'Main Office', networkUrl: 'https://n1.meraki.com//n//manage/nodes/list', networkTags: [], enrollmentString: 'my-enrollment-string', notes: 'Additional description of the network', productTypes: ['appliance', 'switch', 'wireless'], encryptedId: '6GREra' });
}

export function alertTypes(productType) {
  return TYPES.filter((t) => !productType || t[2] === productType).map((t) => ({ alertTypeId: t[0], alertType: t[1], example: example(t) }));
}

// ── Payload templates ──

export const customTemplates = (net) => (configOf(net).payloadTemplates ??= []);

export function templatesOf(net) {
  return net ? [...INCLUDED, ...customTemplates(net)] : INCLUDED;
}

export function templateOf(net, id) {
  const t = templatesOf(net).find((x) => x.payloadTemplateId === id);
  if (!t) throw notFound('Payload template');
  return t;
}

// An HTTP server's template, by ID or by name. The ID wins when both are given,
// and Meraki (included) is the default.
export function pickTemplate(net, { payloadTemplateId, name } = {}) {
  if (payloadTemplateId == null && name == null) payloadTemplateId = 'wpt_00001';
  const list = templatesOf(net);
  const t = payloadTemplateId != null ? list.find((x) => x.payloadTemplateId === payloadTemplateId) : list.find((x) => x.name === name);
  if (!t) throw badRequest(`Payload template ${payloadTemplateId ?? name} does not exist in this network`);
  return t;
}

// Liquid output tags only: {{ path }} with an optional jsonify filter. Objects
// print as JSON, missing values as nothing, and {% %} tags are left as they are.
export function render(template, data) {
  return template.replace(/\{\{\s*([\w.]+)\s*((?:\|\s*\w+\s*)*)\}\}/g, (_, path, filters) => {
    const value = path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), data);
    if (/\bjsonify\b/.test(filters)) return JSON.stringify(value ?? null);
    if (value == null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

// What a test webhook for one alert type carries, with the network's own names.
export function testPayload(net, type, sharedSecret, now) {
  const row = TYPES.find((t) => t[0] === type);
  const out = example(row);
  const org = net.org;
  const dev = net.devices.find((d) => d.productType === row[2]);
  const at = isoUs(Math.round(now * 1e6));
  Object.assign(out, { sharedSecret, sentAt: at, occurredAt: at, organizationId: org.id, organizationName: org.name, organizationUrl: orgJson(org).url });
  Object.assign(out, { networkId: net.id, networkName: net.name, networkUrl: net.url, networkTags: [...net.tags], productTypes: [...net.productTypes], enrollmentString: net.enrollmentString ?? null, notes: net.notes ?? '' });
  if (dev && out.deviceSerial) Object.assign(out, { deviceSerial: dev.serial, deviceMac: dev.mac, deviceName: dev.name, deviceUrl: deviceUrl(dev), deviceTags: [...dev.tags], deviceModel: dev.model });
  return out;
}

export const isWebhookAlertType = (type) => TYPES.some((t) => t[0] === type);
export const alertTitle = (type) => TYPES.find((t) => t[0] === type)?.[1] ?? type;

// ── Delivery ──

export const callbacksOf = (org) => (org.webhookCallbacks ??= new Map());
const logsOf = (org) => (org.webhookLogs ??= []);

export function webhookLogs(org) {
  return logsOf(org);
}

function addLog(org, entry, now) {
  const logs = logsOf(org);
  entry.seq = org.webhookLogSeq = (org.webhookLogSeq ?? 0) + 1;
  logs.push(entry);
  const keep = logs.filter((l) => l.at >= now - LOG_DAYS * DAY).slice(-MAX_LOGS);
  if (keep.length !== logs.length) org.webhookLogs = keep;
}

export function newWebhookId(world, org, kind) {
  org.webhookIds = (org.webhookIds ?? 0) + 1;
  return new Rand(hashStr(`meraki-api-emulator:${world.seed}:${kind}:${org.id}:${org.webhookIds}`)).digits(13);
}

async function post(url, body, headers) {
  const started = performance.now();
  try {
    const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    return { code: res.status, ms: Math.round(performance.now() - started) };
  } catch {
    return { code: 0, ms: Math.round(performance.now() - started) };
  }
}

// Sends one webhook and keeps job.status current: processing while a POST is out,
// retrying between attempts, then delivered on a 2xx or abandoned. Every attempt
// is logged. With delivery turned off nothing is sent and the job counts as delivered.
// `net` is null for organization-wide sends.
export async function deliver(ctx, net, job, { url, template, data, org = net.org }) {
  if (ctx.replay) return;
  const body = render(template.body, data);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'MerakiWebhooks/1.0' };
  for (const h of template.headers) if (h.name) headers[h.name] = render(h.template ?? '', data);
  const log = (code, ms, sent) => addLog(org, { at: sent, alertType: data.alertType, loggedAt: isoUs(Math.round(sent * 1e6) + ms * 1000), networkId: net?.id ?? '', organizationId: org.id, responseCode: code, responseDuration: ms, sentAt: isoUs(Math.round(sent * 1e6)), url }, sent);
  if (!ctx.webhooks) {
    log(200, 0, ctx.now);
    job.status = 'delivered';
    return;
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    job.status = 'processing';
    const sent = ctx.clock();
    const { code, ms } = await post(url, body, headers);
    log(code, ms, sent);
    if (code >= 200 && code < 300) {
      job.status = 'delivered';
      return;
    }
    if (attempt === ATTEMPTS - 1) break;
    job.status = 'retrying';
    await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
  }
  job.status = 'abandoned';
}

// ── API callbacks ──

const MAX_CALLBACKS = 1000;

// Checks a request's `callback` and records it as running. The receiver is
// either one of the network's HTTP servers or a URL with its shared secret.
// Organization-wide requests pass the network holding the server, or null.
export function newCallback(ctx, net, given, org = net.org) {
  if (given == null) return null;
  const c = net ? configOf(net) : { httpServers: [] };
  const serverId = given.httpServer?.id;
  let url;
  let secret;
  if (serverId != null) {
    if (given.url != null || given.sharedSecret != null) throw badRequest("'callback' takes either 'httpServer.id' or 'url' and 'sharedSecret', not both");
    const server = c.httpServers.find((s) => s.id === serverId);
    if (!server) throw badRequest(`HTTP server ${serverId} does not exist in this network`);
    url = server.url;
    secret = c.httpServerSecrets?.[server.id] ?? '';
  } else {
    if (given.url == null || given.sharedSecret == null) throw badRequest("'callback' needs either 'httpServer.id' or both 'url' and 'sharedSecret'");
    let parsed = null;
    try {
      parsed = new URL(given.url);
    } catch {}
    if (!parsed || !/^https?:$/.test(parsed.protocol)) throw badRequest("'callback.url' must be an http or https URL");
    url = given.url;
    secret = given.sharedSecret;
  }
  const template = pickTemplate(net, { payloadTemplateId: given.payloadTemplate?.id ?? 'wpt_00005' });
  const cb = {
    callbackId: newWebhookId(ctx.world, org, 'callback'),
    status: 'running',
    errors: [],
    createdBy: { adminId: ctx.world.apiAdmin.id },
    webhook: { url, ...(serverId != null && { httpServer: { id: serverId } }), payloadTemplate: { id: template.payloadTemplateId } },
  };
  const store = callbacksOf(org);
  if (store.size >= MAX_CALLBACKS) store.delete(store.keys().next().value);
  store.set(cb.callbackId, cb);
  return { cb, secret, template };
}

// Sends a callback after `delay` seconds with what `alertData()` gives then.
// The callback completes once the receiver answers 2xx and fails otherwise.
// Organization-wide callbacks pass the organization with no network or device.
export function sendCallback(ctx, net, dev, { cb, secret, template }, alertData, delay, org = net.org) {
  if (ctx.replay) return;
  const run = () => {
    const sent = ctx.clock();
    const at = isoUs(Math.round(sent * 1e6));
    cb.webhook.sentAt = at;
    const data = { version: '0.1', sharedSecret: secret, sentAt: at, organizationId: org.id, organizationName: org.name, organizationUrl: orgJson(org).url };
    if (net) Object.assign(data, { networkId: net.id, networkName: net.name, networkUrl: net.url, networkTags: [...net.tags] });
    if (dev) Object.assign(data, { deviceSerial: dev.serial, deviceMac: dev.mac, deviceName: dev.name, deviceUrl: deviceUrl(dev), deviceTags: [...dev.tags], deviceModel: dev.model });
    Object.assign(data, { alertId: cb.callbackId, alertType: 'API callback', alertTypeId: 'api_callback', alertLevel: 'informational', occurredAt: at, alertData: alertData() });
    const job = { status: 'enqueued' };
    const done = () => {
      cb.status = job.status === 'delivered' ? 'completed' : 'failed';
      cb.errors = cb.status === 'failed' ? ['Callback failed'] : [];
    };
    deliver(ctx, net, job, { url: cb.webhook.url, template, data, org }).catch(() => (job.status = 'abandoned')).finally(done);
  };
  if (delay > 0) setTimeout(run, delay * 1000).unref();
  else run();
}
