// Webhook payload templates and tests, the organization's webhook log, alert
// types and callback statuses, and organization-wide alert configs.

import { configOf } from '../config.js';
import { badRequest, notFound, paginate, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { DAY } from '../time.js';
import { WEBHOOK_PRODUCTS, alertTypes, callbacksOf, customTemplates, deliver, isWebhookAlertType, newWebhookId, pickTemplate, templateOf, templatesOf, testPayload, webhookLogs } from '../webhooks.js';
import { webhookServers } from './alerts.js';
import { netOf, orgOf } from './common.js';

const MAX_TEMPLATES = 100;
const MAX_TESTS = 1000;
const MAX_CONFIGS = 100;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// The threshold each org-wide alert type is measured against.
const THRESHOLD = { wanUtilization: 'bit_rate_bps', wanLatency: 'latency_ms', wanPacketLoss: 'loss_ratio', voipJitter: 'jitter_ms', voipMos: 'mos', voipPacketLoss: 'loss_ratio' };

// ── Payload templates ──

function decode(b64, name) {
  const s = b64.replace(/\s+/g, '');
  if (!BASE64.test(s)) throw badRequest(`'${name}' must be Base64 encoded`);
  return Buffer.from(s, 'base64').toString('utf8');
}

// A headers file holds a JSON list of {name, template} or an object of name to template.
function headersOf(b) {
  if (b.headersFile == null) return b.headers?.map((h) => ({ name: h.name ?? '', template: h.template ?? '' }));
  let parsed;
  try {
    parsed = JSON.parse(decode(b.headersFile, 'headersFile'));
  } catch (e) {
    throw e.status ? e : badRequest("'headersFile' must hold a JSON list of headers");
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.entries(parsed).map(([name, template]) => ({ name, template })) : null;
  if (!list || list.some((h) => typeof h?.name !== 'string' || typeof h.template !== 'string')) throw badRequest("'headersFile' must hold a JSON list of headers");
  return list.map(({ name, template }) => ({ name, template }));
}

function applyTemplate(t, b) {
  if (b.name != null) {
    if (!b.name.trim()) throw badRequest("'name' must not be empty");
    t.name = b.name;
  }
  const body = b.bodyFile != null ? decode(b.bodyFile, 'bodyFile') : b.body;
  if (body != null) t.body = body;
  const headers = headersOf(b);
  if (headers) t.headers = headers;
}

function createTemplate(ctx) {
  const net = netOf(ctx);
  const c = configOf(net);
  const list = customTemplates(net);
  if (list.length >= MAX_TEMPLATES) throw badRequest(`Networks are limited to ${MAX_TEMPLATES} payload templates in the emulator`);
  if (ctx.body.body == null && ctx.body.bodyFile == null) throw badRequest("Either 'body' or 'bodyFile' must be specified");
  const t = { payloadTemplateId: null, type: 'custom', name: '', headers: [], body: '', sharing: { byNetwork: { adminsCanModify: false } } };
  applyTemplate(t, ctx.body);
  c.payloadTemplatesCreated = (c.payloadTemplatesCreated ?? 0) + 1;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:payloadTemplate:${net.id}:${c.payloadTemplatesCreated}`));
  do t.payloadTemplateId = `wpt_${r.digits(5)}`;
  while (templatesOf(net).some((x) => x.payloadTemplateId === t.payloadTemplateId));
  list.push(t);
  return t;
}

function customOf(ctx, what) {
  const net = netOf(ctx);
  const t = templateOf(net, ctx.params.payloadTemplateId);
  if (t.type === 'included') throw badRequest(`Included payload templates cannot be ${what}`);
  return { net, t };
}

function updateTemplate(ctx) {
  const { net, t } = customOf(ctx, 'changed');
  applyTemplate(t, ctx.body);
  // Servers using the template show its new name.
  for (const s of configOf(net).httpServers) if (s.payloadTemplate.payloadTemplateId === t.payloadTemplateId) s.payloadTemplate.name = t.name;
  return t;
}

function deleteTemplate(ctx) {
  const { net, t } = customOf(ctx, 'deleted');
  const user = configOf(net).httpServers.find((s) => s.payloadTemplate.payloadTemplateId === t.payloadTemplateId);
  if (user) throw badRequest(`Payload template ${t.payloadTemplateId} is used by HTTP server ${user.name}`);
  const list = customTemplates(net);
  list.splice(list.indexOf(t), 1);
}

// ── Webhook tests ──

const testsOf = (net) => (net.webhookTests ??= new Map());

function createTest(ctx) {
  const net = netOf(ctx);
  const c = configOf(net);
  const b = ctx.body;
  let parsed = null;
  try {
    parsed = new URL(b.url);
  } catch {}
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw badRequest("'url' must be an http or https URL");
  const alertTypeId = b.alertTypeId ?? 'power_supply_down';
  if (!isWebhookAlertType(alertTypeId)) throw badRequest(`'${alertTypeId}' is not a webhook alert type`);
  // Defaults come from the HTTP server set up for this URL, if there is one.
  const server = c.httpServers.find((s) => s.url === b.url);
  const sharedSecret = b.sharedSecret ?? (server ? (c.httpServerSecrets?.[server.id] ?? '') : '');
  const given = b.payloadTemplateId != null || b.payloadTemplateName != null;
  const template = given ? pickTemplate(net, { payloadTemplateId: b.payloadTemplateId, name: b.payloadTemplateName }) : templateOf(net, server?.payloadTemplate.payloadTemplateId ?? 'wpt_00001');
  const tests = testsOf(net);
  if (tests.size >= MAX_TESTS) tests.delete(tests.keys().next().value);
  const job = { id: newWebhookId(ctx.world, net.org, 'webhookTest'), url: b.url, status: 'enqueued' };
  tests.set(job.id, job);
  const reply = { ...job };
  deliver(ctx, net, job, { url: b.url, template, data: testPayload(net, alertTypeId, sharedSecret, ctx.now) }).catch(() => (job.status = 'abandoned'));
  return reply;
}

function testOf(ctx) {
  const job = testsOf(netOf(ctx)).get(ctx.params.webhookTestId);
  if (!job) throw notFound('Webhook test');
  return { ...job };
}

// ── Organization webhooks ──

function logs(ctx) {
  const org = orgOf(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 30 * DAY, lookback: 30 * DAY });
  const url = ctx.query.get('url');
  const rows = webhookLogs(org).filter((l) => l.at >= t0 && l.at <= t1 && (!url || l.url === url));
  const keyed = rows.reverse().map(({ seq, at, ...row }) => ({ key: String(seq), row }));
  return paginate(ctx, keyed, (x) => x.key, { def: 50, max: 1000 }).map((x) => x.row);
}

function types(ctx) {
  orgOf(ctx);
  const productType = ctx.query.get('productType');
  if (productType && !WEBHOOK_PRODUCTS.includes(productType)) throw badRequest(`'productType' must be one of: ${WEBHOOK_PRODUCTS.join(', ')}`);
  return alertTypes(productType);
}

function callbackOf(ctx) {
  const cb = callbacksOf(orgOf(ctx)).get(ctx.params.callbackId);
  if (!cb) throw notFound('Callback');
  return structuredClone(cb);
}

// ── Organization-wide alert configs ──

const configsOf = (org) => (org.alertConfigs ??= []);

function configOfId(org, id) {
  const config = configsOf(org).find((x) => x.id === id);
  if (!config) throw notFound('Alert config');
  return config;
}

// Checks a whole config: the type's threshold must be set and webhook recipients must exist.
function checkConfig(org, a) {
  const key = THRESHOLD[a.type];
  if (key && a.alertCondition[key] == null) throw badRequest(`'alertCondition.${key}' is required for ${a.type} alerts`);
  const servers = webhookServers(org);
  for (const id of a.recipients.httpServerIds) if (!servers.has(id)) throw badRequest(`HTTP server ${id} does not exist in this organization`);
}

function shapeCondition(type, cond) {
  const { duration, window, interface: uplink } = cond;
  const out = { duration, window };
  const key = THRESHOLD[type];
  if (key) out[key] = cond[key];
  if (uplink != null) out.interface = uplink;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}

function createConfig(ctx) {
  const org = orgOf(ctx);
  const list = configsOf(org);
  if (list.length >= MAX_CONFIGS) throw badRequest(`Organizations are limited to ${MAX_CONFIGS} alert configs in the emulator`);
  const b = ctx.body;
  const a = {
    id: null,
    type: b.type,
    enabled: true,
    alertCondition: shapeCondition(b.type, b.alertCondition),
    recipients: { emails: [...(b.recipients.emails ?? [])], httpServerIds: [...(b.recipients.httpServerIds ?? [])] },
    networkTags: [...b.networkTags],
    description: b.description ?? '',
  };
  checkConfig(org, a);
  org.alertConfigsCreated = (org.alertConfigsCreated ?? 0) + 1;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:alertConfig:${org.id}:${org.alertConfigsCreated}`));
  do a.id = r.digits(13);
  while (list.some((x) => x.id === a.id));
  list.push(a);
  return a;
}

function updateConfig(ctx) {
  const org = orgOf(ctx);
  const current = configOfId(org, ctx.params.alertConfigId);
  const b = ctx.body;
  const type = b.type ?? current.type;
  const next = structuredClone(current);
  next.type = type;
  if (b.enabled != null) next.enabled = b.enabled;
  next.alertCondition = shapeCondition(type, { ...current.alertCondition, ...b.alertCondition });
  if (b.recipients?.emails) next.recipients.emails = [...b.recipients.emails];
  if (b.recipients?.httpServerIds) next.recipients.httpServerIds = [...b.recipients.httpServerIds];
  if (b.networkTags) next.networkTags = [...b.networkTags];
  if (b.description != null) next.description = b.description;
  checkConfig(org, next);
  Object.assign(current, next);
  return current;
}

function deleteConfig(ctx) {
  const org = orgOf(ctx);
  const list = configsOf(org);
  list.splice(list.indexOf(configOfId(org, ctx.params.alertConfigId)), 1);
}

const NET = '/networks/{networkId}/webhooks';
const ORG = '/organizations/{organizationId}';

export default [
  { op: 'getNetworkWebhooksPayloadTemplates', path: `${NET}/payloadTemplates`, handler: (ctx) => templatesOf(netOf(ctx)) },
  { op: 'createNetworkWebhooksPayloadTemplate', method: 'POST', path: `${NET}/payloadTemplates`, handler: createTemplate },
  {
    op: 'getNetworkWebhooksPayloadTemplate',
    path: `${NET}/payloadTemplates/{payloadTemplateId}`,
    sample: { payloadTemplateId: 'wpt_00001' },
    handler: (ctx) => templateOf(netOf(ctx), ctx.params.payloadTemplateId),
  },
  { op: 'updateNetworkWebhooksPayloadTemplate', method: 'PUT', path: `${NET}/payloadTemplates/{payloadTemplateId}`, handler: updateTemplate },
  { op: 'deleteNetworkWebhooksPayloadTemplate', method: 'DELETE', path: `${NET}/payloadTemplates/{payloadTemplateId}`, handler: deleteTemplate },
  { op: 'createNetworkWebhooksWebhookTest', method: 'POST', path: `${NET}/webhookTests`, batch: false, handler: createTest },
  {
    op: 'getNetworkWebhooksWebhookTest',
    path: `${NET}/webhookTests/{webhookTestId}`,
    sample: { webhookTestId: '1234', status: 404 },
    handler: testOf,
  },
  { op: 'getOrganizationAlertsProfiles', path: `${ORG}/alerts/profiles`, handler: (ctx) => configsOf(orgOf(ctx)) },
  { op: 'createOrganizationAlertsProfile', method: 'POST', path: `${ORG}/alerts/profiles`, handler: createConfig },
  { op: 'updateOrganizationAlertsProfile', method: 'PUT', path: `${ORG}/alerts/profiles/{alertConfigId}`, handler: updateConfig },
  { op: 'deleteOrganizationAlertsProfile', method: 'DELETE', path: `${ORG}/alerts/profiles/{alertConfigId}`, handler: deleteConfig },
  { op: 'getOrganizationWebhooksAlertTypes', path: `${ORG}/webhooks/alertTypes`, handler: types },
  {
    op: 'getOrganizationWebhooksCallbacksStatus',
    path: `${ORG}/webhooks/callbacks/statuses/{callbackId}`,
    sample: { callbackId: '1284392014819', status: 404 },
    handler: callbackOf,
  },
  { op: 'getOrganizationWebhooksLogs', path: `${ORG}/webhooks/logs`, handler: logs },
];
