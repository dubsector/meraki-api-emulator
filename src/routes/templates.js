// Configuration templates, their switch profiles, and binding networks to
// them. Organizations start with none. A template copied from a network gets
// its settings and a switch profile for each switch model in it, and one copied
// from a template gets that template's.

import { MODELS } from '../catalog.js';
import { configOf, rebase } from '../config.js';
import { networkJson } from '../format.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { merge, validTimeZone } from '../validate.js';
import { netOf, orgOf } from './common.js';
import { checkPortBody, portConfig, portDefaults } from './switch.js';

const LIST = '/organizations/{organizationId}/configTemplates';
const TEMPLATE = `${LIST}/{configTemplateId}`;
const PROFILES = `${TEMPLATE}/switch/profiles`;
const PORT = `${PROFILES}/{profileId}/ports/{portId}`;
const MAX_TEMPLATES = 100;
const DEFAULT_PRODUCTS = ['appliance', 'switch', 'wireless'];
const MISSING = { configTemplateId: 'L_578149602163689000', status: 404 };

const storeOf = (org) => (org.configTemplates ??= { created: 0, list: [] });

function templateOf(ctx) {
  const org = orgOf(ctx);
  const template = storeOf(org).list.find((t) => t.id === ctx.params.configTemplateId);
  if (!template) throw notFound('Config template');
  return { org, template };
}

function profileOf(ctx) {
  const { template } = templateOf(ctx);
  const profile = template.profiles.find((p) => p.switchProfileId === ctx.params.profileId);
  if (!profile) throw notFound('Switch profile');
  return profile;
}

function portOf(ctx) {
  const profile = profileOf(ctx);
  const port = profile.ports.find((p) => p.portId === ctx.params.portId);
  if (!port) throw notFound('Port');
  return { profile, port };
}

const templateJson = (t) => ({ id: t.id, name: t.name, productTypes: t.productTypes, timeZone: t.timeZone });
const profileJson = (p) => ({ switchProfileId: p.switchProfileId, name: p.name, model: p.model });

// A profile port is a switch port without a switch: its model's defaults, and
// whatever was written on top. The PoE extras aren't template settings.
function portJson(profile, port) {
  const { perpetualPoe, fastPoe, ...base } = portDefaults({ model: profile.model, info: MODELS[profile.model] }, port);
  return port.config ? merge(base, port.config) : base;
}

function newProfile(ctx, template, model, ports) {
  template.profilesCreated++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:switchProfile:${template.id}:${template.profilesCreated}`));
  let switchProfileId;
  do switchProfileId = r.digits(12);
  while (template.profiles.some((p) => p.switchProfileId === switchProfileId));
  template.profiles.push({ switchProfileId, name: model, model, ports });
}

function checkName(org, name, template) {
  if (!name?.trim()) throw badRequest("'name' must not be empty");
  if (storeOf(org).list.some((t) => t !== template && t.name === name)) throw badRequest('Name has already been taken');
}

function createTemplate(ctx) {
  const org = orgOf(ctx);
  const store = storeOf(org);
  const b = ctx.body;
  checkName(org, b.name, null);
  if (b.timeZone != null && !validTimeZone(b.timeZone)) throw badRequest("'timeZone' must be a valid IANA time zone");
  if (store.list.length >= MAX_TEMPLATES) throw badRequest(`Organizations are limited to ${MAX_TEMPLATES} config templates in the emulator`);
  let net = null;
  let source = null;
  if (b.copyFromNetworkId) {
    net = org.networks.find((n) => n.id === b.copyFromNetworkId);
    source = store.list.find((t) => t.id === b.copyFromNetworkId);
    if (!net && !source) throw notFound('Network or config template to copy from');
  }
  const productTypes = [...(net ?? source)?.productTypes ?? DEFAULT_PRODUCTS];
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:configTemplate:${org.id}:${store.created}`));
  let id;
  do id = (productTypes.length > 1 ? 'L_' : 'N_') + r.digits(18);
  while (ctx.world.networkById.has(id) || ctx.world.orgs.some((o) => o.configTemplates?.list.some((t) => t.id === id)));
  const template = { id, name: b.name, timeZone: b.timeZone ?? (net ?? source)?.timeZone ?? 'America/Los_Angeles', productTypes, profilesCreated: 0, profiles: [] };
  if (net) {
    for (const model of [...new Set(net.switches.map((s) => s.model))]) {
      const info = MODELS[model];
      newProfile(ctx, template, model, Array.from({ length: info.ports + info.uplinks }, (_, i) => ({ portId: String(i + 1), uplinkPort: i >= info.ports, config: null })));
    }
  }
  for (const p of source?.profiles ?? []) newProfile(ctx, template, p.model, structuredClone(p.ports));
  if (net) template.config = rebase(configOf(net), net.id, id);
  else if (source?.config) template.config = rebase(source.config, source.id, id);
  store.list.push(template);
  return templateJson(template);
}

// A bound network reads its settings from the template, and with autoBind its
// switches take their ports from the profile for their model.
function bind(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  if (net.template) throw badRequest(`This network is already bound to config template ${net.template.id}`);
  const template = storeOf(net.org).list.find((t) => t.id === b.configTemplateId);
  if (!template) throw badRequest(`Config template ${b.configTemplateId} was not found in this organization`);
  const missing = net.productTypes.filter((p) => !template.productTypes.includes(p));
  if (missing.length) throw badRequest(`The config template has no ${missing.join(', ')} settings for this network`);
  const autoBind = b.autoBind && net.productTypes.includes('switch') && template.productTypes.includes('switch');
  const models = template.profiles.map((p) => p.model);
  if (autoBind && (!models.length || new Set(models).size < models.length)) throw badRequest('Auto-bind needs a switch template with at least one profile and at most one profile per switch model');
  net.template = template;
  configOf(net);
  if (autoBind) for (const sw of net.switches) sw.switchProfileId = template.profiles.find((p) => p.model === sw.model)?.switchProfileId;
  return { ...networkJson(net), configTemplateId: template.id };
}

// Unbinding keeps a copy of the template's settings and switch ports when
// asked to, and otherwise starts the network over from its defaults.
function unbind(ctx) {
  const net = netOf(ctx);
  const template = net.template;
  if (!template) throw badRequest('This network is not bound to a config template');
  const retain = !!ctx.body?.retainConfigs;
  for (const sw of net.switches) {
    if (!sw.switchProfileId) continue;
    for (const port of sw.ports) {
      const { portId, linkNegotiationCapabilities, ...config } = portConfig(net, sw, port);
      port.config = retain ? config : null;
    }
    delete sw.switchProfileId;
  }
  if (retain) net.config = rebase(configOf(net), template.id, net.id);
  else delete net.config;
  delete net.template;
  return networkJson(net);
}

export default [
  {
    op: 'getOrganizationConfigTemplates',
    path: LIST,
    handler: (ctx) => storeOf(orgOf(ctx)).list.map(templateJson),
  },
  { op: 'createOrganizationConfigTemplate', method: 'POST', path: LIST, handler: createTemplate },
  {
    op: 'getOrganizationConfigTemplate',
    path: TEMPLATE,
    sample: MISSING,
    handler: (ctx) => templateJson(templateOf(ctx).template),
  },
  {
    op: 'updateOrganizationConfigTemplate',
    method: 'PUT',
    path: TEMPLATE,
    handler: (ctx) => {
      const { org, template } = templateOf(ctx);
      const b = ctx.body;
      if (b.name != null) checkName(org, b.name, template);
      if (b.timeZone != null && !validTimeZone(b.timeZone)) throw badRequest("'timeZone' must be a valid IANA time zone");
      for (const k of ['name', 'timeZone']) if (b[k] != null) template[k] = b[k];
      return templateJson(template);
    },
  },
  {
    op: 'deleteOrganizationConfigTemplate',
    method: 'DELETE',
    path: TEMPLATE,
    handler: (ctx) => {
      const { org, template } = templateOf(ctx);
      if (org.networks.some((n) => n.template === template)) throw badRequest('Networks are still bound to this config template; unbind them first');
      const list = storeOf(org).list;
      list.splice(list.indexOf(template), 1);
    },
  },
  {
    op: 'getOrganizationConfigTemplateSwitchProfiles',
    path: PROFILES,
    sample: MISSING,
    handler: (ctx) => templateOf(ctx).template.profiles.map(profileJson),
  },
  {
    op: 'getOrganizationConfigTemplateSwitchProfilePorts',
    path: `${PROFILES}/{profileId}/ports`,
    sample: { ...MISSING, profileId: '1' },
    handler: (ctx) => {
      const profile = profileOf(ctx);
      return profile.ports.map((p) => portJson(profile, p));
    },
  },
  {
    op: 'getOrganizationConfigTemplateSwitchProfilePort',
    path: PORT,
    sample: { ...MISSING, profileId: '1', portId: '1' },
    handler: (ctx) => {
      const { profile, port } = portOf(ctx);
      return portJson(profile, port);
    },
  },
  {
    op: 'updateOrganizationConfigTemplateSwitchProfilePort',
    method: 'PUT',
    path: PORT,
    handler: (ctx) => {
      const { profile, port } = portOf(ctx);
      checkPortBody({ model: profile.model, info: MODELS[profile.model] }, port, ctx.body);
      const { portId, ...patch } = ctx.body;
      port.config = merge(port.config || {}, patch);
      return portJson(profile, port);
    },
  },
  { op: 'bindNetwork', method: 'POST', path: '/networks/{networkId}/bind', status: 200, handler: bind },
  { op: 'unbindNetwork', method: 'POST', path: '/networks/{networkId}/unbind', status: 200, handler: unbind },
];
