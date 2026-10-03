// Organization-wide policy firewall: rulesets and the rules in them. Rules
// match traffic by addresses, ports, services, applications, appliance VLANs
// and the organization's policy objects and groups, which can't be deleted
// while a rule names them. Priorities order the rules within a ruleset.

import { L7_CATEGORIES } from '../catalog.js';
import { configOf } from '../config.js';
import { arrayParam, badRequest, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso } from '../time.js';
import { inRange, isAddress, isIpv6, isPort, parseIp } from '../validate.js';
import { collection, orgOf } from './common.js';

const BASE = '/organizations/{organizationId}/policies/global/firewall';
const RULESETS = `${BASE}/rulesets`;
const RULES = `${RULESETS}/rules`;
const MAX_RULESETS = 100;
const MAX_RULES = 2000;
const MAX_SEGMENTS = 100;
const MAX_PRIORITY = 100000;
const PROTOCOLS = ['tcp', 'udp', 'icmp', 'icmp6', 'any'];
// Match types the request has no criteria field for.
const NO_VALUES = ['countries', 'fqdns', 'siteSpecificVlans'];

// IDs count up from a start seeded by the organization, so creation order is ID order.
const store = (org, kind) => ({ start: new Rand(hashStr(`meraki-api-emulator:${kind}:${org.id}`)).int(100, 899), created: 0, list: [] });
const nextId = (s) => String(s.start + ++s.created);
const rulesetsOf = (org) => (org.globalFirewallRulesets ??= store(org, 'globalFirewallRuleset'));
const rulesOf = (org) => (org.globalFirewallRules ??= store(org, 'globalFirewallRule'));

// ── Application categories ──

// NBAR IDs are stand-ins except Gmail's.
const nbarOf = (id) => (id === 'meraki:layer7/application/4' ? 1658 : 1500 + Number(id.split('/').pop()));
const APPLICATIONS = new Map(L7_CATEGORIES.flatMap((c) => c.applications.map((a) => [a.id, { ...a, categoryId: c.id }])));

function applicationCategories(ctx) {
  orgOf(ctx);
  return L7_CATEGORIES.map((c) => ({ id: c.id, name: c.name, applications: c.applications.map((a) => ({ id: a.id, name: a.name, nbar: { mappings: [{ id: nbarOf(a.id) }] } })) }));
}

// ── Rule criteria ──

const isRange = (v) => {
  const [a, b, ...rest] = String(v).split('-');
  return !rest.length && b != null && parseIp(a) != null && parseIp(b) != null && parseIp(a) <= parseIp(b);
};
const isIpv6Cidr = (v) => {
  const [ip, bits, ...rest] = String(v).split('/');
  return !rest.length && isIpv6(ip) && (bits == null || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128));
};
const isAddressRange = (v) => isAddress(v) || isIpv6Cidr(v) || isRange(v);
const isPortValue = (v) => isPort(v, true);

// A VLAN as rules name it: L_123_vlan_200, the network's ID and the VLAN ID.
function checkVlan(org, id, at) {
  const m = /^(.+)_vlan_(\d+)$/.exec(String(id));
  const net = m && org.networks.find((n) => n.id === m[1]);
  if (!net) throw badRequest(`'${at}' must name an appliance VLAN as <networkId>_vlan_<vlanId> of a network in this organization`);
  if (!net.productTypes.includes('appliance')) throw badRequest(`'${at}' names network ${net.id}, which has no appliance`);
  if (!vlanExists(net, m[2])) throw badRequest(`'${at}' names VLAN ${m[2]}, which doesn't exist in network ${net.id}`);
  return { networkId: net.id, vlanId: m[2] };
}
const vlanExists = (net, vlanId) => {
  const c = configOf(net);
  return c.vlansEnabled && c.vlans.some((v) => v.id === vlanId);
};

function checkObjects(org, list, at) {
  return list.map((x, i) => {
    const o = org.policyObjects?.list.find((p) => p.id === String(x.id));
    if (!o) throw badRequest(`'${at}[${i}].id' names policy object ${x.id}, which doesn't exist in this organization`);
    if (o.category !== 'network') throw badRequest(`'${at}[${i}].id' names policy object ${x.id}, which is an adaptive policy object`);
    return { id: o.id };
  });
}

function checkGroups(org, list, at) {
  return list.map((x, i) => {
    const g = org.policyObjectGroups?.list.find((p) => p.id === String(x.id));
    if (!g) throw badRequest(`'${at}[${i}].id' names policy object group ${x.id}, which doesn't exist in this organization`);
    if (g.category !== 'NetworkObjectGroup') throw badRequest(`'${at}[${i}].id' names policy object group ${x.id}, which is not a NetworkObjectGroup`);
    return { id: g.id };
  });
}

function checkStrings(list, at, ok, what) {
  list.forEach((v, i) => {
    if (typeof v !== 'string' || !ok(v)) throw badRequest(`'${at}[${i}]' must be ${what}`);
  });
  return [...list];
}

function checkServices(list, at) {
  return list.map((s, i) => {
    const protocol = typeof s.protocol === 'string' ? s.protocol.toLowerCase() : null;
    if (!PROTOCOLS.includes(protocol)) throw badRequest(`'${at}[${i}].protocol' must be one of ${PROTOCOLS.join(', ')}`);
    if (s.ports == null || !s.ports.length) throw badRequest(`'${at}[${i}].ports' must list at least one port`);
    return { protocol, ports: checkStrings(s.ports, `${at}[${i}].ports`, (p) => p === 'any' || isPortValue(p), "'any', a port or a range like 42-46") };
  });
}

function checkApplications(list, at) {
  return list.map((x, i) => {
    if (!APPLICATIONS.has(x.id)) throw badRequest(`'${at}[${i}].id' must be an application ID from the application categories list`);
    return { id: x.id };
  });
}

function checkCategories(list, at) {
  return list.map((x, i) => {
    const c = L7_CATEGORIES.find((y) => y.id === x.id);
    if (!c) throw badRequest(`'${at}[${i}].id' must be a category ID from the application categories list`);
    (x.applications ?? []).forEach((a, j) => {
      if (APPLICATIONS.get(a.id)?.categoryId !== c.id) throw badRequest(`'${at}[${i}].applications[${j}].id' is not an application of category ${c.id}`);
    });
    return { id: c.id };
  });
}

const SEGMENTS = {
  addressRanges: (org, v, at) => checkStrings(v, at, isAddressRange, 'an IP address, a CIDR or a range like 10.0.0.1-10.0.0.9'),
  ports: (org, v, at) => checkStrings(v, at, isPortValue, 'a port or a range like 42-46'),
  policyObjects: (org, v, at) => checkObjects(org, v, at),
  policyObjectGroups: (org, v, at) => checkGroups(org, v, at),
  applianceVlans: (org, v, at) => v.map((x, i) => checkVlan(org, x.interfaceId, `${at}[${i}].interfaceId`)),
  services: (org, v, at) => checkServices(v, at),
  applicationCategories: (org, v, at) => checkCategories(v, at),
  applications: (org, v, at) => checkApplications(v, at),
};

// Every match type but 'any' needs values, and every value needs its type.
// Ports have their own cap; every other value counts toward the bloc's cap.
function checkBloc(org, bloc, at) {
  const types = [...new Set(bloc.matchCriteria ?? [])];
  const criteria = bloc.criteria ?? {};
  const given = Object.keys(criteria).filter((k) => criteria[k] != null);
  if (!types.length) throw badRequest(`'${at}.matchCriteria' must list at least one match type`);
  if (types.includes('any')) {
    if (types.length > 1) throw badRequest(`'${at}.matchCriteria' can't combine 'any' with other match types`);
    if (given.some((k) => criteria[k].length)) throw badRequest(`'${at}.criteria' must be left out when '${at}.matchCriteria' is 'any'`);
    return { matchCriteria: ['any'], criteria: null };
  }
  const out = {};
  for (const t of types) {
    if (NO_VALUES.includes(t)) throw badRequest(`'${at}.matchCriteria' can't hold '${t}': the request has no criteria field for it`);
    if (!criteria[t]?.length) throw badRequest(`'${at}.criteria.${t}' must list at least one value when '${at}.matchCriteria' holds '${t}'`);
    out[t] = SEGMENTS[t](org, criteria[t], `${at}.criteria.${t}`);
  }
  const extra = given.find((k) => !types.includes(k) && criteria[k].length);
  if (extra) throw badRequest(`'${at}.criteria.${extra}' is set but '${at}.matchCriteria' doesn't hold '${extra}'`);
  const ports = (out.ports?.length ?? 0) + (out.services ?? []).reduce((n, s) => n + s.ports.length, 0);
  if (ports > MAX_SEGMENTS) throw badRequest(`'${at}' can hold at most ${MAX_SEGMENTS} port values`);
  const values = Object.entries(out).filter(([k]) => k !== 'ports').reduce((n, [, v]) => n + v.length, 0);
  if (values > MAX_SEGMENTS) throw badRequest(`'${at}' can hold at most ${MAX_SEGMENTS} segment values`);
  return { matchCriteria: types, criteria: out };
}

// VLANs whose network or VLAN has gone drop out on read.
function blocJson(org, bloc) {
  if (!bloc.criteria) return { matchCriteria: [...bloc.matchCriteria] };
  const criteria = {};
  for (const [k, v] of Object.entries(bloc.criteria)) {
    if (k === 'applianceVlans') {
      criteria[k] = v.filter((x) => {
        const net = org.networks.find((n) => n.id === x.networkId);
        return net && vlanExists(net, x.vlanId);
      }).map((x) => ({ interfaceId: `${x.networkId}_vlan_${x.vlanId}` }));
    } else if (k === 'applications') {
      criteria[k] = v.map((x) => ({ id: x.id, name: APPLICATIONS.get(x.id).name }));
    } else {
      criteria[k] = structuredClone(v);
    }
  }
  return { matchCriteria: [...bloc.matchCriteria], criteria };
}

// ── References from other stores ──

const blocs = (r) => [r.sources, r.destinations].map((b) => b.criteria ?? {});

// Why a policy object or group can't be deleted, or nothing.
export function firewallRuleNaming(org, kind, id) {
  const key = kind === 'object' ? 'policyObjects' : 'policyObjectGroups';
  const rule = org.globalFirewallRules?.list.find((r) => blocs(r).some((c) => c[key]?.some((x) => x.id === id)));
  if (rule) return `is used by organization-wide firewall rule ${rule.ruleId}`;
}

// ── Rulesets ──

const rulesetJson = (s) => ({ rulesetId: s.rulesetId, name: s.name, description: s.description, createdAt: s.createdAt, lastUpdatedAt: s.lastUpdatedAt });

const rulesets = collection({
  ops: { create: 'createOrganizationPoliciesGlobalFirewallRuleset', update: 'updateOrganizationPoliciesGlobalFirewallRuleset' },
  path: RULESETS,
  param: 'rulesetId',
  parent: orgOf,
  store: rulesetsOf,
  scope: 'organization',
  what: 'firewall ruleset',
  key: 'rulesetId',
  nextId: (ctx, s) => nextId(s),
  max: MAX_RULESETS,
  required: ['name'],
  blank: (ctx) => ({ name: null, description: '', createdAt: iso(ctx.now), lastUpdatedAt: iso(ctx.now) }),
  apply: (s, b, org, ctx) => {
    if (b.name != null) s.name = b.name;
    if (b.description != null) s.description = b.description;
    s.lastUpdatedAt = iso(ctx.now);
  },
  json: rulesetJson,
});

function listRulesets(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'rulesetIds');
  const name = ctx.query.getAll('name').at(-1)?.toLowerCase();
  const list = rulesetsOf(org).list.filter((s) => (!ids.length || ids.includes(s.rulesetId)) && (!name || s.name.toLowerCase().includes(name)));
  return paginateItems(ctx, list, (s) => s.rulesetId, { def: 100, max: 100 }, rulesetJson);
}

// A ruleset goes with its rules and its group policy assignments.
function deleteRuleset(ctx) {
  const { parent: org, store: s, item } = rulesets.find(ctx);
  s.list.splice(s.list.indexOf(item), 1);
  const rules = rulesOf(org);
  rules.list = rules.list.filter((r) => r.rulesetId !== item.rulesetId);
  const a = org.globalGroupPolicyRulesets;
  if (a) a.list = a.list.filter((r) => r.rulesetId !== item.rulesetId);
}

// ── Rules ──

function ruleJson(r, org) {
  return {
    ruleId: r.ruleId,
    name: r.name,
    rulesetId: r.rulesetId,
    policy: r.policy,
    enabled: r.enabled,
    priority: r.priority,
    description: r.description,
    sources: blocJson(org, r.sources),
    destinations: blocJson(org, r.destinations),
    createdAt: r.createdAt,
    lastUpdatedAt: r.lastUpdatedAt,
  };
}

function checkRule(org, b, r) {
  if (b.name != null && !b.name.trim()) throw badRequest("'name' must not be empty");
  if (b.rulesetId != null && !rulesetsOf(org).list.some((s) => s.rulesetId === String(b.rulesetId))) throw badRequest(`Firewall ruleset ${b.rulesetId} does not exist in this organization`);
  inRange(b.priority, 1, MAX_PRIORITY, 'priority');
  const rulesetId = b.rulesetId != null ? String(b.rulesetId) : r?.rulesetId;
  if (rulesetId !== r?.rulesetId && rulesOf(org).list.filter((x) => x.rulesetId === rulesetId).length >= MAX_RULES) throw badRequest(`Firewall rulesets are limited to ${MAX_RULES} rules in the emulator`);
  return {
    sources: b.sources != null ? checkBloc(org, b.sources, 'sources') : null,
    destinations: b.destinations != null ? checkBloc(org, b.destinations, 'destinations') : null,
  };
}

// A priority another rule of the ruleset holds moves that rule and the ones
// after it down by one. Without one, a rule goes last.
function place(list, r, priority) {
  const others = list.filter((x) => x !== r && x.rulesetId === r.rulesetId);
  if (priority == null) {
    if (r.priority == null) r.priority = Math.max(0, ...others.map((x) => x.priority)) + 1;
    if (!others.some((x) => x.priority === r.priority)) return;
    priority = r.priority;
  }
  r.priority = priority;
  if (others.some((x) => x.priority === priority)) for (const x of others) if (x.priority >= priority) x.priority++;
}

function applyRule(r, b, org, ctx, checked) {
  for (const k of ['name', 'policy', 'enabled', 'description']) if (b[k] != null) r[k] = b[k];
  if (b.rulesetId != null) r.rulesetId = String(b.rulesetId);
  if (checked.sources) r.sources = checked.sources;
  if (checked.destinations) r.destinations = checked.destinations;
  place(rulesOf(org).list, r, b.priority ?? null);
  r.lastUpdatedAt = iso(ctx.now);
}

const rules = collection({
  ops: { create: 'createOrganizationPoliciesGlobalFirewallRulesetsRule', update: 'updateOrganizationPoliciesGlobalFirewallRulesetsRule', delete: 'deleteOrganizationPoliciesGlobalFirewallRulesetsRule' },
  path: RULES,
  param: 'ruleId',
  parent: orgOf,
  store: rulesOf,
  scope: 'organization',
  what: 'firewall rule',
  key: 'ruleId',
  nextId: (ctx, s) => nextId(s),
  max: MAX_RULESETS * MAX_RULES,
  unique: false,
  required: ['name', 'rulesetId', 'policy', 'sources', 'destinations'],
  check: (ctx, org, b, r) => checkRule(org, b, r),
  blank: (ctx) => ({ name: null, rulesetId: null, policy: null, enabled: true, priority: null, description: '', sources: null, destinations: null, createdAt: iso(ctx.now), lastUpdatedAt: iso(ctx.now) }),
  apply: applyRule,
  json: ruleJson,
});

// Rules by ruleset, in ruleset order, then by priority.
function listRules(ctx) {
  const org = orgOf(ctx);
  const sets = arrayParam(ctx.query, 'rulesetIds');
  const ids = arrayParam(ctx.query, 'ruleIds');
  const order = rulesetsOf(org).list.map((s) => s.rulesetId);
  const list = rulesOf(org)
    .list.filter((r) => (!sets.length || sets.includes(r.rulesetId)) && (!ids.length || ids.includes(r.ruleId)))
    .sort((a, b) => order.indexOf(a.rulesetId) - order.indexOf(b.rulesetId) || a.priority - b.priority || a.ruleId - b.ruleId);
  return paginateItems(ctx, list, (r) => r.ruleId, { def: 100, max: 100 }, (r) => ruleJson(r, org));
}

export default [
  { op: 'getOrganizationPoliciesGlobalFirewallApplicationCategories', path: `${BASE}/applicationCategories`, handler: applicationCategories },
  { op: 'getOrganizationPoliciesGlobalFirewallRulesets', path: RULESETS, handler: listRulesets },
  ...rulesets.routes,
  { op: 'deleteOrganizationPoliciesGlobalFirewallRuleset', method: 'DELETE', path: `${RULESETS}/{rulesetId}`, handler: deleteRuleset },
  { op: 'getOrganizationPoliciesGlobalFirewallRulesetsRules', path: RULES, handler: listRules },
  ...rules.routes,
];
