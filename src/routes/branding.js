// Dashboard branding policies and early access features. Branding policies are
// stored in priority order (later ones win) and only stored: the emulator has no
// Dashboard to brand. Early access features are a fixed list; opt-ins name the
// networks they cover, which follow split and combine through repoint.

import { badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso } from '../time.js';
import { collection, orgOf } from './common.js';
import { base64Of } from './splash.js';

const POLICIES = '/organizations/{organizationId}/brandingPolicies';
const FEATURES = '/organizations/{organizationId}/earlyAccess/features';
const OPT_INS = `${FEATURES}/optIns`;
const MAX_POLICIES = 50;

// ── Branding policies ──

const HELP = ['helpTab', 'getHelpSubtab', 'communitySubtab', 'casesSubtab', 'dataProtectionRequestsSubtab', 'getHelpSubtabKnowledgeBaseSearch', 'universalSearchKnowledgeBaseSearch', 'ciscoMerakiProductDocumentation', 'supportContactInfo', 'newFeaturesSubtab', 'firewallInfoSubtab', 'apiDocsSubtab', 'hardwareReplacementsSubtab', 'smForums', 'helpWidget'];
// The fields that also take custom HTML in place of the section.
const CUSTOM_HTML = new Set(['getHelpSubtabKnowledgeBaseSearch', 'ciscoMerakiProductDocumentation', 'supportContactInfo']);
const DEFAULT = 'default or inherit';
// appliesTo values that need a list, and what the list holds.
const NEEDS_VALUES = { 'Specific admins...': 'admin IDs', 'All admins of networks...': 'network or configuration template IDs', 'All admins of networks tagged...': 'network tags' };

const policiesOf = (org) => (org.brandingPolicies ??= { created: 0, list: [] });

function nextPolicyId(ctx, store, org) {
  const start = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:brandingPolicy:${org.id}`)).int(100000, 899999);
  return String(start + ++store.created);
}

const isNetOrTemplate = (org, id) => org.networks.some((n) => n.id === id) || (org.configTemplates?.list ?? []).some((t) => t.id === id);

// Works out the admin settings and logo before anything changes. A new appliesTo
// without values starts with an empty list.
function checkPolicy(ctx, org, b, self) {
  const a = b.adminSettings ?? {};
  const appliesTo = a.appliesTo ?? self?.appliesTo ?? 'All admins';
  const values = a.values ?? (appliesTo === self?.appliesTo ? self.values : []);
  const kind = NEEDS_VALUES[appliesTo];
  if (!kind && values.length) throw badRequest(`'adminSettings.values' only applies when 'adminSettings.appliesTo' is one of: ${Object.keys(NEEDS_VALUES).join(', ')}`);
  if (kind && !values.length) throw badRequest(`'adminSettings.values' must list ${kind} when 'adminSettings.appliesTo' is '${appliesTo}'`);
  for (const v of values) {
    if (!String(v).trim()) throw badRequest("'adminSettings.values' must not hold empty strings");
    if (appliesTo === 'Specific admins...' && !org.admins.some((x) => x.id === v)) throw badRequest(`'adminSettings.values' names an admin that is not in this organization: ${v}`);
    if (appliesTo === 'All admins of networks...' && !isNetOrTemplate(org, v)) throw badRequest(`'adminSettings.values' names a network or template that is not in this organization: ${v}`);
  }
  const h = b.helpSettings ?? {};
  for (const k of CUSTOM_HTML) if (h[k] != null && !String(h[k]).trim()) throw badRequest(`'helpSettings.${k}' must be 'default or inherit', 'hide', 'show' or custom HTML`);
  if (h.smForums != null && h.smForums !== DEFAULT) throw badRequest("'helpSettings.smForums' can only be set in organizations with Systems Manager networks");
  const image = b.customLogo?.image;
  let logo = self?.logo ?? null;
  if (image != null) {
    if (image.contents == null || image.format == null) throw badRequest("'customLogo.image' needs both 'contents' and 'format'");
    const data = base64Of(image.contents, 'customLogo.image.contents');
    logo = { format: image.format, hash: (hashStr(data) >>> 0).toString(16).padStart(8, '0') };
  }
  const enabled = b.customLogo?.enabled ?? self?.logoEnabled ?? false;
  if (enabled && !logo) throw badRequest("'customLogo.enabled' needs a logo in 'customLogo.image'");
  return { appliesTo, values: [...values], logo, logoEnabled: enabled };
}

function applyPolicy(p, b, org, ctx, checked) {
  if (b.name != null) p.name = b.name;
  if (b.enabled != null) p.enabled = b.enabled;
  for (const k of HELP) if (b.helpSettings?.[k] != null) p.helpSettings[k] = b.helpSettings[k];
  Object.assign(p, checked);
}

// Admins, networks and templates that left the organization drop out of values.
function policyJson(p, org, ctx) {
  const values =
    p.appliesTo === 'Specific admins...' ? p.values.filter((v) => org.admins.some((x) => x.id === v)) : p.appliesTo === 'All admins of networks...' ? p.values.filter((v) => isNetOrTemplate(org, v)) : p.values;
  const image = p.logo ? { preview: { url: `https://meraki-na.s3.amazonaws.com/org-assets/${org.id}/${p.logo.hash}.${p.logo.format}`, expiresAt: iso(ctx.now + 3600) } } : null;
  return {
    brandingPolicyId: p.brandingPolicyId,
    name: p.name,
    enabled: p.enabled,
    adminSettings: { appliesTo: p.appliesTo, values },
    helpSettings: { ...p.helpSettings },
    customLogo: { enabled: p.logoEnabled, image },
  };
}

const policies = collection({
  ops: {
    list: 'getOrganizationBrandingPolicies',
    create: 'createOrganizationBrandingPolicy',
    get: 'getOrganizationBrandingPolicy',
    update: 'updateOrganizationBrandingPolicy',
    delete: 'deleteOrganizationBrandingPolicy',
  },
  path: POLICIES,
  param: 'brandingPolicyId',
  key: 'brandingPolicyId',
  parent: orgOf,
  store: policiesOf,
  scope: 'organization',
  what: 'branding policy',
  plural: 'branding policies',
  nextId: nextPolicyId,
  max: MAX_POLICIES,
  required: ['name'],
  check: checkPolicy,
  blank: () => ({ name: null, enabled: true, helpSettings: Object.fromEntries(HELP.map((k) => [k, DEFAULT])) }),
  apply: applyPolicy,
  json: policyJson,
  missing: { brandingPolicyId: '1000000', status: 404 },
});

// The list is kept in priority order, so a new policy has the highest priority.
function updatePriorities(ctx) {
  const store = policiesOf(orgOf(ctx));
  const ids = ctx.body.brandingPolicyIds;
  if (ids != null) {
    const have = store.list.map((p) => p.brandingPolicyId);
    if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((id) => !have.includes(id))) {
      throw badRequest("'brandingPolicyIds' must list every branding policy of the organization exactly once");
    }
    store.list.sort((a, b) => ids.indexOf(a.brandingPolicyId) - ids.indexOf(b.brandingPolicyId));
  }
  return { brandingPolicyIds: store.list.map((p) => p.brandingPolicyId) };
}

// ── Early access ──

const DOCS = 'https://documentation.meraki.com/';
const feature = (shortName, name, topic, isOrgScopedOnly, short, long, advantage = false) => ({
  shortName,
  name,
  descriptions: { short, long },
  topic,
  isOrgScopedOnly,
  documentationLink: DOCS,
  supportLink: 'https://community.meraki.com/',
  privacyLink: 'https://meraki.com/privacy',
  advantage,
  advantageTrial: advantage,
});

const FEATURES_LIST = [
  feature('has_new_topology', 'New Topology', 'Dashboard', false, 'A redesigned network topology page', 'A redesigned topology page with layer 2 and layer 3 views, link details and search.'),
  feature('has_org_wide_client_search', 'Organization-wide Client Search', 'Dashboard', true, 'Search for clients across every network', 'Search for a client by name, MAC or IP address across every network in the organization at once.'),
  feature('has_api_beta', 'Dashboard API Beta Endpoints', 'API', true, 'Early access to beta API operations', 'Turns on the Dashboard API operations that are still in beta for this organization.'),
  feature('has_switch_port_insights', 'Switch Port Insights', 'Switching', false, 'Port level health and traffic views', 'Adds health scores and traffic history to every switch port page.'),
  feature('has_wireless_health_v2', 'Wireless Health v2', 'Wireless', false, 'The next version of Wireless Health', 'Shows connection, performance and roaming problems per access point, SSID and client.'),
  feature('has_sdwan_insights', 'SD-WAN Insights', 'Security & SD-WAN', false, 'Application performance across WAN links', 'Scores application performance across every WAN link and VPN path of the organization.', true),
];

const optInsOf = (org) => (org.earlyAccessOptIns ??= { created: 0, list: [] });

function nextOptInId(ctx, store, org) {
  const start = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:earlyAccessOptIn:${org.id}`)).int(1000, 8999);
  return String(start + ++store.created);
}

function checkOptIn(ctx, org, b, self) {
  const f = self ? FEATURES_LIST.find((x) => x.shortName === self.shortName) : FEATURES_LIST.find((x) => x.shortName === b.shortName);
  if (!f) throw badRequest(`'shortName' must name an early access feature: ${FEATURES_LIST.map((x) => x.shortName).join(', ')}`);
  if (!self && optInsOf(org).list.some((x) => x.shortName === f.shortName)) throw badRequest(`The organization has already opted in to '${f.shortName}'`);
  const ids = b.limitScopeToNetworks;
  if (ids == null) return null;
  if (ids.length && f.isOrgScopedOnly) throw badRequest(`'${f.shortName}' can only be opted in for the entire organization`);
  const bad = ids.find((id) => !org.networks.some((n) => n.id === id));
  if (bad !== undefined) throw badRequest(`'limitScopeToNetworks' names a network that is not in this organization: ${bad}`);
  return [...new Set(ids)];
}

// Networks that left the organization drop out.
function optInJson(o, org) {
  const f = FEATURES_LIST.find((x) => x.shortName === o.shortName);
  return {
    id: o.id,
    shortName: o.shortName,
    limitScopeToNetworks: o.networkIds.flatMap((id) => {
      const n = org.networks.find((x) => x.id === id);
      return n ? [{ id: n.id, name: n.name }] : [];
    }),
    optOutEligibility: { eligible: true, reason: 'The feature can be turned off at any time', help: { label: 'Read more', url: f.documentationLink } },
    createdAt: iso(o.createdAt),
  };
}

const optIns = collection({
  ops: {
    list: 'getOrganizationEarlyAccessFeaturesOptIns',
    create: 'createOrganizationEarlyAccessFeaturesOptIn',
    get: 'getOrganizationEarlyAccessFeaturesOptIn',
    update: 'updateOrganizationEarlyAccessFeaturesOptIn',
    delete: 'deleteOrganizationEarlyAccessFeaturesOptIn',
  },
  path: OPT_INS,
  param: 'optInId',
  parent: orgOf,
  store: optInsOf,
  scope: 'organization',
  what: 'early access feature opt-in',
  unique: false,
  nextId: nextOptInId,
  max: FEATURES_LIST.length,
  required: ['shortName'],
  check: checkOptIn,
  blank: (ctx) => ({ shortName: null, networkIds: [], createdAt: ctx.now }),
  apply: (o, b, org, ctx, checked) => {
    if (!o.shortName) o.shortName = b.shortName;
    if (checked) o.networkIds = checked;
  },
  json: optInJson,
  missing: { optInId: '1000', status: 404 },
});

export default [
  {
    op: 'getOrganizationBrandingPoliciesPriorities',
    path: `${POLICIES}/priorities`,
    handler: (ctx) => ({ brandingPolicyIds: policiesOf(orgOf(ctx)).list.map((p) => p.brandingPolicyId) }),
  },
  { op: 'updateOrganizationBrandingPoliciesPriorities', method: 'PUT', path: `${POLICIES}/priorities`, handler: updatePriorities },
  ...policies.routes,
  {
    op: 'getOrganizationEarlyAccessFeatures',
    path: FEATURES,
    handler: (ctx) => {
      orgOf(ctx);
      return FEATURES_LIST.map((f) => ({ ...f, descriptions: { ...f.descriptions } }));
    },
  },
  ...optIns.routes.map((r) => (r.method === 'POST' ? { ...r, status: 200 } : r)),
];
