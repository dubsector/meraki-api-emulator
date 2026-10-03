// Organization policy objects (CIDRs and domain names) and the groups that
// hold them. MX firewall rules name them in their address fields as OBJ(id)
// and GRP(id). Membership is kept once, on the groups; an object's groupIds and
// both sides' networkIds are worked out on read.

import { badRequest, paginate } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso } from '../time.js';
import { isAddress, isHostname, parseCidr } from '../validate.js';
import { collection, orgOf } from './common.js';
import { firewallRuleNaming } from './globalfirewall.js';

const OBJECTS = '/organizations/{organizationId}/policyObjects';
const GROUPS = `${OBJECTS}/groups`;
const MAX_OBJECTS = 5000;
const MAX_GROUPS = 1000;
const MAX_MEMBERS = 150;
const NAME = /^[A-Za-z0-9 _-]+$/;
const CATEGORY_OF = { cidr: 'network', fqdn: 'network', adaptivePolicyIpv4Cidr: 'adaptivePolicy' };
const GROUP_CATEGORIES = ['NetworkObjectGroup', 'GeoLocationGroup', 'PortObjectGroup', 'ApplicationGroup'];
const MISSING = { policyObjectId: '1000000', policyObjectGroupId: '1000000', status: 404 };

const objectsOf = (org) => (org.policyObjects ??= { created: 0, list: [] });
const groupsOf = (org) => (org.policyObjectGroups ??= { created: 0, list: [] });

// IDs count up from a seeded start, so creation order is ID order.
function nextId(ctx, store, org, kind) {
  const start = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${org.id}`)).int(1000000, 8999999);
  return String(start + ++store.created);
}

// ── References from firewall rules ──

export const REF = /^(OBJ|GRP)\((.*)\)$/;
const tokens = (v) => (v == null ? [] : String(v).split(',').map((x) => x.trim()));
export const isRef = (x) => REF.test(x);

// Every OBJ() and GRP() in an address list has to name a network object or a
// network object group of the organization.
export function checkRefs(org, v, at) {
  for (const x of tokens(v)) {
    const m = REF.exec(x);
    if (!m) continue;
    if (m[1] === 'OBJ') {
      const o = objectsOf(org).list.find((p) => p.id === m[2]);
      if (!o) throw badRequest(`'${at}' names policy object ${m[2]}, which doesn't exist in this organization`);
      if (o.category !== 'network') throw badRequest(`'${at}' names policy object ${m[2]}, which is an adaptive policy object`);
    } else {
      const g = groupsOf(org).list.find((p) => p.id === m[2]);
      if (!g) throw badRequest(`'${at}' names policy object group ${m[2]}, which doesn't exist in this organization`);
      if (g.category !== 'NetworkObjectGroup') throw badRequest(`'${at}' names policy object group ${m[2]}, which is not a NetworkObjectGroup`);
    }
  }
}

// The rule lists of a network's or template's settings that can name policy
// objects. Settings nobody has read yet hold none, so they aren't built.
const ruleLists = (c) => (c ? [c.l3?.rules, c.inbound?.rules, c.applianceCellularRules?.rules, c.applianceInboundCellularRules?.rules].filter(Boolean) : []);
const refsIn = (rules) => rules.flatMap((r) => [...tokens(r.srcCidr), ...tokens(r.destCidr)]).filter(isRef);
const settingsOf = (net) => (net.template ? net.template.config : net.config);

// 'OBJ(id)' and 'GRP(id)' to the IDs of the networks whose rules name them.
function usage(org) {
  const used = new Map();
  for (const net of org.networks) {
    for (const ref of ruleLists(settingsOf(net)).flatMap(refsIn)) {
      if (!used.has(ref)) used.set(ref, new Set());
      used.get(ref).add(net.id);
    }
  }
  return used;
}

export const usesPolicyObjects = (net) => ruleLists(settingsOf(net)).some((rules) => refsIn(rules).length > 0);

// Why a reference can't go away: rules of a network, a template, the VPN or
// the organization-wide firewall.
function inUse(org, ref, what) {
  const net = org.networks.find((n) => ruleLists(settingsOf(n)).some((rules) => refsIn(rules).includes(ref)));
  if (net) return `${what} is used by firewall rules in network ${net.id}`;
  const template = org.configTemplates?.list.find((t) => ruleLists(t.config).some((rules) => refsIn(rules).includes(ref)));
  if (template) return `${what} is used by firewall rules in config template ${template.id}`;
  if (refsIn(org.vpnFirewallRules?.rules ?? []).includes(ref)) return `${what} is used by the organization's site-to-site VPN firewall rules`;
  const m = REF.exec(ref);
  const reason = firewallRuleNaming(org, m[1] === 'OBJ' ? 'object' : 'group', m[2]);
  if (reason) return `${what} ${reason}`;
}

const networksOf = (org, ids) => org.networks.filter((n) => ids.has(n.id)).map((n) => n.id);

// ── Policy objects ──

const groupIdsOf = (org, o) => groupsOf(org).list.filter((g) => g.objectIds.includes(o.id)).map((g) => g.id);

function objectJson(o, org, used = usage(org)) {
  const groupIds = groupIdsOf(org, o);
  const nets = new Set([`OBJ(${o.id})`, ...groupIds.map((id) => `GRP(${id})`)].flatMap((ref) => [...(used.get(ref) ?? [])]));
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    type: o.type,
    ...(o.cidr != null && { cidr: o.cidr }),
    ...(o.fqdn != null && { fqdn: o.fqdn }),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    groupIds,
    networkIds: networksOf(org, nets),
  };
}

function checkGroupIds(org, ids, o, category) {
  for (const id of ids) {
    const g = groupsOf(org).list.find((x) => x.id === id);
    if (!g) throw badRequest(`Policy object group ${id} does not exist in this organization`);
    if (g.category !== 'NetworkObjectGroup') throw badRequest(`Policy object group ${id} is a ${g.category} and can't hold policy objects`);
    if (category !== 'network') throw badRequest('Only network policy objects can belong to a group');
    if (!g.objectIds.includes(o?.id) && g.objectIds.length >= MAX_MEMBERS) throw badRequest(`Policy object group ${id} already holds ${MAX_MEMBERS} policy objects, the most a group can hold in the emulator`);
  }
}

// The body fields that go with each type; the deprecated ipAndMask is refused.
function checkObject(org, b, o) {
  if (b.name != null && !NAME.test(b.name)) throw badRequest("'name' may only hold letters, digits, spaces, dashes and underscores");
  if (b.ip != null || b.mask != null) throw badRequest("'ip' and 'mask' are only used with the deprecated type ipAndMask; use type cidr");
  const type = o?.type ?? b.type;
  if (!o) {
    if (type === 'ipAndMask') throw badRequest("Type 'ipAndMask' is deprecated; use 'cidr'");
    if (!CATEGORY_OF[type]) throw badRequest(`'type' must be one of ${Object.keys(CATEGORY_OF).join(', ')}`);
    if (b.category !== CATEGORY_OF[type]) throw badRequest(`'category' must be '${CATEGORY_OF[type]}' for type ${type}`);
  }
  if (type === 'fqdn') {
    if (b.cidr != null) throw badRequest("'cidr' is only used with types cidr and adaptivePolicyIpv4Cidr");
    if (!o && b.fqdn == null) throw badRequest("'fqdn' is required for type fqdn");
    if (b.fqdn != null && !isHostname(b.fqdn)) throw badRequest("'fqdn' must be a domain name such as example.com");
  } else {
    if (b.fqdn != null) throw badRequest("'fqdn' is only used with type fqdn");
    if (!o && b.cidr == null) throw badRequest(`'cidr' is required for type ${type}`);
    const ok = type === 'adaptivePolicyIpv4Cidr' ? (x) => parseCidr(x) != null : isAddress;
    if (b.cidr != null && !ok(b.cidr)) throw badRequest(`'cidr' must be an IPv4 ${type === 'cidr' ? 'address or ' : ''}CIDR such as 10.0.0.0/24`);
  }
  if (b.groupIds != null) checkGroupIds(org, b.groupIds, o, o?.category ?? b.category);
}

// groupIds replaces the object's groups.
function applyObject(o, b, org, ctx) {
  for (const k of ['name', 'category', 'type', 'cidr', 'fqdn']) if (b[k] != null) o[k] = b[k];
  if (b.groupIds != null) {
    for (const g of groupsOf(org).list) {
      const has = g.objectIds.includes(o.id);
      if (has !== b.groupIds.includes(g.id)) g.objectIds = has ? g.objectIds.filter((id) => id !== o.id) : [...g.objectIds, o.id];
    }
  }
  o.updatedAt = iso(ctx.now);
}

const objects = collection({
  ops: { create: 'createOrganizationPolicyObject', get: 'getOrganizationPolicyObject', update: 'updateOrganizationPolicyObject' },
  path: OBJECTS,
  param: 'policyObjectId',
  parent: orgOf,
  store: objectsOf,
  scope: 'organization',
  what: 'policy object',
  nextId: (ctx, store, org) => nextId(ctx, store, org, 'policyObject'),
  max: MAX_OBJECTS,
  required: ['name', 'category', 'type'],
  check: (ctx, org, b, o) => checkObject(org, b, o),
  blank: (ctx) => ({ name: null, category: null, type: null, cidr: null, fqdn: null, createdAt: iso(ctx.now), updatedAt: iso(ctx.now) }),
  apply: applyObject,
  json: (o, org) => objectJson(o, org),
  missing: MISSING,
});

function listObjects(ctx) {
  const org = orgOf(ctx);
  const used = usage(org);
  return paginate(ctx, objectsOf(org).list, (o) => o.id, { def: 5000, max: 5000, min: 10 }).map((o) => objectJson(o, org, used));
}

// An object in a group can go; it leaves the group. One a rule or an adaptive
// policy group names can't.
function deleteObject(ctx) {
  const { parent: org, store, item: o } = objects.find(ctx);
  const reason = inUse(org, `OBJ(${o.id})`, `Policy object ${o.id}`);
  if (reason) throw badRequest(reason);
  const tagged = org.adaptivePolicyGroups?.list.find((g) => g.policyObjectIds.includes(o.id));
  if (tagged) throw badRequest(`Policy object ${o.id} is used by adaptive policy group '${tagged.name}'`);
  for (const g of groupsOf(org).list) g.objectIds = g.objectIds.filter((id) => id !== o.id);
  store.list.splice(store.list.indexOf(o), 1);
}

// ── Policy object groups ──

function groupJson(g, org, used = usage(org)) {
  return {
    id: g.id,
    name: g.name,
    category: g.category,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    objectIds: g.objectIds.map(Number),
    networkIds: networksOf(org, used.get(`GRP(${g.id})`) ?? new Set()),
  };
}

function checkGroup(org, b, g) {
  if (b.name != null && !NAME.test(b.name)) throw badRequest("'name' may only hold letters, digits, spaces, dashes and underscores");
  const category = g?.category ?? b.category ?? 'NetworkObjectGroup';
  if (!GROUP_CATEGORIES.includes(category)) throw badRequest(`'category' must be one of ${GROUP_CATEGORIES.join(', ')}`);
  if (b.objectIds == null) return;
  const ids = [...new Set(b.objectIds.map(String))];
  if (ids.length && category !== 'NetworkObjectGroup') throw badRequest(`A ${category} can't hold policy objects`);
  if (ids.length > MAX_MEMBERS) throw badRequest(`A policy object group can hold at most ${MAX_MEMBERS} policy objects in the emulator`);
  for (const id of ids) {
    const o = objectsOf(org).list.find((x) => x.id === id);
    if (!o) throw badRequest(`Policy object ${id} does not exist in this organization`);
    if (o.category !== 'network') throw badRequest(`Policy object ${id} is an adaptive policy object and can't belong to a group`);
  }
}

function applyGroup(g, b, org, ctx) {
  if (b.name != null) g.name = b.name;
  if (b.category != null) g.category = b.category;
  if (b.objectIds != null) g.objectIds = [...new Set(b.objectIds.map(String))];
  g.updatedAt = iso(ctx.now);
}

const groups = collection({
  ops: { create: 'createOrganizationPolicyObjectsGroup', get: 'getOrganizationPolicyObjectsGroup', update: 'updateOrganizationPolicyObjectsGroup', delete: 'deleteOrganizationPolicyObjectsGroup' },
  path: GROUPS,
  param: 'policyObjectGroupId',
  parent: orgOf,
  store: groupsOf,
  scope: 'organization',
  what: 'policy object group',
  nextId: (ctx, store, org) => nextId(ctx, store, org, 'policyObjectGroup'),
  max: MAX_GROUPS,
  required: ['name'],
  check: (ctx, org, b, g) => checkGroup(org, b, g),
  blank: (ctx) => ({ name: null, category: 'NetworkObjectGroup', createdAt: iso(ctx.now), updatedAt: iso(ctx.now), objectIds: [] }),
  apply: applyGroup,
  json: (g, org) => groupJson(g, org),
  inUse: (g, org) => inUse(org, `GRP(${g.id})`, `Policy object group ${g.id}`),
  missing: MISSING,
});

function listGroups(ctx) {
  const org = orgOf(ctx);
  const used = usage(org);
  return paginate(ctx, groupsOf(org).list, (g) => g.id, { def: 1000, max: 1000, min: 10 }).map((g) => groupJson(g, org, used));
}

export default [
  { op: 'getOrganizationPolicyObjects', path: OBJECTS, handler: listObjects },
  ...objects.routes,
  { op: 'deleteOrganizationPolicyObject', method: 'DELETE', path: `${OBJECTS}/{policyObjectId}`, handler: deleteObject },
  { op: 'getOrganizationPolicyObjectsGroups', path: GROUPS, handler: listGroups },
  ...groups.routes,
];
