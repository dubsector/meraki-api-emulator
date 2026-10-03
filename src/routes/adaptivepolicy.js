// Organization adaptive policy: groups (security group tags), ACLs, the
// policies between groups and the networks it's enabled on. Switch ports and
// SSIDs name a group by its ID. Every organization starts with the two default
// groups, Infrastructure and Unknown, built on first read.

import { badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso, isoMicro } from '../time.js';
import { isPort } from '../validate.js';
import { collection, orgOf } from './common.js';

const ORG = '/organizations/{organizationId}/adaptivePolicy';
const LIMITS = { customGroups: 60, rulesInAnAcl: 16, aclsInAPolicy: 7, policyObjects: 8000 };
const MAX_SGT = 65519;
const MISSING = { aclId: '1000', id: '1000', status: 404 };

// IDs count up from a start seeded by the organization, so creation order is ID order.
const store = (org, kind, min, max) => ({ start: new Rand(hashStr(`meraki-api-emulator:${kind}:${org.id}`)).int(min, max), created: 0, list: [] });
const nextId = (s) => String(s.start + ++s.created);

export function groupsOf(org, now) {
  if (org.adaptivePolicyGroups) return org.adaptivePolicyGroups;
  const s = (org.adaptivePolicyGroups = store(org, 'adaptivePolicyGroup', 1000, 8999));
  const group = (name, sgt, description) => ({ groupId: nextId(s), name, sgt, description, policyObjectIds: [], isDefaultGroup: true, createdAt: isoMicro(now), updatedAt: isoMicro(now) });
  s.list.push(group('Infrastructure', 2, 'Network infrastructure devices'), group('Unknown', 0, 'Traffic without a security group tag'));
  return s;
}
const aclsOf = (org) => (org.adaptivePolicyAcls ??= store(org, 'adaptivePolicyAcl', 10000000, 89999999));
const policiesOf = (org) => (org.adaptivePolicies ??= store(org, 'adaptivePolicy', 100, 899));
const settingsOf = (org) => (org.adaptivePolicySettings ??= { enabledNetworks: [] });

// Builds the default groups before any route reads the organization's stores.
const parent = (ctx) => {
  const org = orgOf(ctx);
  groupsOf(org, ctx.now);
  return org;
};

// A reference holding any of id, name and sgt names the one item matching all
// it gives ("requires one unique attribute").
function pick(list, ref, fields, what, at) {
  const given = Object.keys(fields).filter((f) => ref?.[f] != null);
  if (!given.length) throw badRequest(`'${at}' must give one of ${Object.keys(fields).join(', ')}`);
  const found = list.find((x) => given.every((f) => String(x[fields[f]]) === String(ref[f])));
  if (!found) throw badRequest(`'${at}' does not name ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what} in this organization`);
  return found;
}

const GROUP_FIELDS = { id: 'groupId', name: 'name', sgt: 'sgt' };
const ACL_FIELDS = { id: 'aclId', name: 'name' };

// ── References from switch ports and SSIDs ──

export function checkGroupId(org, now, id, at = 'adaptivePolicyGroupId') {
  if (id != null && !groupsOf(org, now).list.some((g) => g.groupId === String(id))) throw badRequest(`'${at}' names adaptive policy group ${id}, which doesn't exist in this organization`);
}

// A port that set a group or peer SGT shows both, with the group's name.
export function withGroup(org, out) {
  if (!('adaptivePolicyGroupId' in out) && !('peerSgtCapable' in out)) return out;
  const g = org.adaptivePolicyGroups?.list.find((x) => x.groupId === out.adaptivePolicyGroupId);
  return { ...out, adaptivePolicyGroupId: g ? g.groupId : null, adaptivePolicyGroup: g ? { id: g.groupId, name: g.name } : null, peerSgtCapable: out.peerSgtCapable ?? false };
}

// Port configs and SSID settings of the organization's networks and templates.
function* holders(org) {
  for (const net of org.networks) {
    for (const sw of net.switches ?? []) for (const p of sw.ports) if (p.config) yield p.config;
    yield* net.config?.ssids ?? [];
  }
  for (const t of org.configTemplates?.list ?? []) yield* t.config?.ssids ?? [];
}

export const usesAdaptivePolicy = (net) => (net.switches ?? []).some((sw) => sw.ports.some((p) => p.config?.adaptivePolicyGroupId != null)) || (net.config?.ssids ?? []).some((s) => s.adaptivePolicyGroupId != null);

// ── Groups ──

function groupJson(g, org) {
  const objects = org.policyObjects?.list ?? [];
  return {
    groupId: g.groupId,
    name: g.name,
    sgt: g.sgt,
    description: g.description,
    policyObjects: g.policyObjectIds.flatMap((id) => objects.filter((o) => o.id === id).map((o) => ({ id: o.id, name: o.name }))),
    isDefaultGroup: g.isDefaultGroup,
    requiredIpMappings: [],
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

// Infrastructure only takes a new SGT; Unknown takes nothing.
function checkGroup(org, b, g) {
  if (g?.isDefaultGroup) {
    if (g.sgt === 0) throw badRequest('The Unknown group cannot be changed');
    if (['name', 'description', 'policyObjects'].some((k) => b[k] != null)) throw badRequest('Only the SGT of the Infrastructure group can be changed');
  }
  if (!g && org.adaptivePolicyGroups.list.filter((x) => !x.isDefaultGroup).length >= LIMITS.customGroups) throw badRequest(`Organizations are limited to ${LIMITS.customGroups} custom adaptive policy groups`);
  if (b.sgt != null) {
    if (!Number.isInteger(b.sgt) || b.sgt < 1 || b.sgt > MAX_SGT) throw badRequest(`'sgt' must be an integer between 1 and ${MAX_SGT}`);
    const taken = org.adaptivePolicyGroups.list.find((x) => x !== g && x.sgt === b.sgt);
    if (taken) throw badRequest(`SGT ${b.sgt} is already used by adaptive policy group '${taken.name}'`);
  }
  if (b.policyObjects == null) return undefined;
  const objects = (org.policyObjects?.list ?? []).filter((o) => o.category === 'adaptivePolicy');
  const ids = b.policyObjects.map((ref, i) => pick(objects, ref, { id: 'id', name: 'name' }, 'adaptive policy object', `policyObjects[${i}]`).id);
  return [...new Set(ids)];
}

function applyGroup(g, b, org, ctx, ids) {
  for (const k of ['name', 'sgt', 'description']) if (b[k] != null) g[k] = b[k];
  if (ids) g.policyObjectIds = ids;
  g.updatedAt = isoMicro(ctx.now);
}

const groups = collection({
  ops: { list: 'getOrganizationAdaptivePolicyGroups', create: 'createOrganizationAdaptivePolicyGroup', get: 'getOrganizationAdaptivePolicyGroup', update: 'updateOrganizationAdaptivePolicyGroup' },
  path: `${ORG}/groups`,
  param: 'id',
  parent,
  store: (org) => org.adaptivePolicyGroups,
  scope: 'organization',
  what: 'adaptive policy group',
  key: 'groupId',
  nextId: (ctx, s) => nextId(s),
  required: ['name', 'sgt'],
  check: (ctx, org, b, g) => checkGroup(org, b, g),
  blank: (ctx) => ({ name: null, sgt: null, description: '', policyObjectIds: [], isDefaultGroup: false, createdAt: isoMicro(ctx.now), updatedAt: isoMicro(ctx.now) }),
  apply: applyGroup,
  json: groupJson,
  missing: MISSING,
});

// Policies from or to the group go with it, and ports, SSIDs and
// organization-wide group policies drop it.
function deleteGroup(ctx) {
  const { parent: org, store: s, item: g } = groups.find(ctx);
  if (g.isDefaultGroup) throw badRequest(`The ${g.name} group is a default group and cannot be deleted`);
  s.list.splice(s.list.indexOf(g), 1);
  const p = policiesOf(org);
  p.list = p.list.filter((x) => x.sourceGroupId !== g.groupId && x.destinationGroupId !== g.groupId);
  const a = org.globalGroupPolicyAssignments;
  if (a) a.groups = a.groups.filter((x) => x.groupId !== g.groupId);
  for (const c of holders(org)) if (c.adaptivePolicyGroupId === g.groupId) delete c.adaptivePolicyGroupId;
}

// ── ACLs ──

const PORTED = ['tcp', 'udp'];

function checkPorts(v, at, protocol) {
  if (v == null || v === 'any') return;
  if (!PORTED.includes(protocol)) throw badRequest(`'${at}' must be 'any' when the protocol is ${protocol}`);
  const ok = String(v).split(',').every((x) => isPort(x.trim(), true));
  if (!ok) throw badRequest(`'${at}' must be 'any', a port such as 22, a list such as 1,2 or a range such as 1-10, from 1 to 65535`);
}

function checkRules(rules) {
  if (rules.length > LIMITS.rulesInAnAcl) throw badRequest(`An adaptive policy ACL can hold at most ${LIMITS.rulesInAnAcl} rules`);
  return rules.map((r, i) => {
    const at = `rules[${i}]`;
    if (!['allow', 'deny'].includes(r.policy)) throw badRequest(`'${at}.policy' must be 'allow' or 'deny'`);
    if (!['any', 'icmp', 'tcp', 'udp'].includes(r.protocol)) throw badRequest(`'${at}.protocol' must be one of any, icmp, tcp, udp`);
    checkPorts(r.srcPort, `${at}.srcPort`, r.protocol);
    checkPorts(r.dstPort, `${at}.dstPort`, r.protocol);
    if (r.tcpEstablished && !(r.policy === 'allow' && r.protocol === 'tcp')) throw badRequest(`'${at}.tcpEstablished' can only be enabled on an allow tcp rule`);
    return { policy: r.policy, protocol: r.protocol, srcPort: String(r.srcPort ?? 'any'), dstPort: String(r.dstPort ?? 'any'), log: r.log ?? false, tcpEstablished: r.tcpEstablished ?? false };
  });
}

const acls = collection({
  ops: { list: 'getOrganizationAdaptivePolicyAcls', create: 'createOrganizationAdaptivePolicyAcl', get: 'getOrganizationAdaptivePolicyAcl', update: 'updateOrganizationAdaptivePolicyAcl' },
  path: `${ORG}/acls`,
  param: 'aclId',
  parent,
  store: aclsOf,
  scope: 'organization',
  what: 'adaptive policy ACL',
  key: 'aclId',
  nextId: (ctx, s) => nextId(s),
  required: ['name', 'rules', 'ipVersion'],
  check: (ctx, org, b) => (b.rules != null ? checkRules(b.rules) : undefined),
  blank: (ctx) => ({ name: null, description: '', ipVersion: null, rules: [], createdAt: iso(ctx.now), updatedAt: iso(ctx.now) }),
  apply: (a, b, org, ctx, rules) => {
    for (const k of ['name', 'description', 'ipVersion']) if (b[k] != null) a[k] = b[k];
    if (rules) a.rules = rules;
    a.updatedAt = iso(ctx.now);
  },
  json: (a) => ({ aclId: a.aclId, name: a.name, description: a.description, ipVersion: a.ipVersion, rules: a.rules.map((r) => ({ ...r })), createdAt: a.createdAt, updatedAt: a.updatedAt }),
  missing: MISSING,
});

// Policies using the ACL lose it.
function deleteAcl(ctx) {
  const { parent: org, store: s, item: a } = acls.find(ctx);
  s.list.splice(s.list.indexOf(a), 1);
  for (const p of policiesOf(org).list) p.aclIds = p.aclIds.filter((id) => id !== a.aclId);
}

// ── Policies ──

function policyJson(p, org) {
  const ref = (id) => {
    const g = org.adaptivePolicyGroups.list.find((x) => x.groupId === id);
    return { id: g.groupId, name: g.name, sgt: g.sgt };
  };
  const all = aclsOf(org).list;
  return {
    adaptivePolicyId: p.adaptivePolicyId,
    sourceGroup: ref(p.sourceGroupId),
    destinationGroup: ref(p.destinationGroupId),
    acls: p.aclIds.flatMap((id) => all.filter((a) => a.aclId === id).map((a) => ({ id: a.aclId, name: a.name }))),
    lastEntryRule: p.lastEntryRule,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// One policy per source and destination pair.
function checkPolicy(org, b, p) {
  const all = org.adaptivePolicyGroups.list;
  const source = b.sourceGroup != null ? pick(all, b.sourceGroup, GROUP_FIELDS, 'adaptive policy group', 'sourceGroup').groupId : p?.sourceGroupId;
  const destination = b.destinationGroup != null ? pick(all, b.destinationGroup, GROUP_FIELDS, 'adaptive policy group', 'destinationGroup').groupId : p?.destinationGroupId;
  if (policiesOf(org).list.some((x) => x !== p && x.sourceGroupId === source && x.destinationGroupId === destination)) throw badRequest('An adaptive policy for this source and destination group already exists');
  let aclIds;
  if (b.acls != null) {
    if (b.acls.length > LIMITS.aclsInAPolicy) throw badRequest(`An adaptive policy can have at most ${LIMITS.aclsInAPolicy} ACLs`);
    aclIds = b.acls.map((ref, i) => pick(aclsOf(org).list, ref, ACL_FIELDS, 'adaptive policy ACL', `acls[${i}]`).aclId);
    if (new Set(aclIds).size < aclIds.length) throw badRequest("'acls' must not name the same ACL twice");
  }
  return { source, destination, aclIds };
}

const policies = collection({
  ops: { list: 'getOrganizationAdaptivePolicyPolicies', create: 'createOrganizationAdaptivePolicyPolicy', get: 'getOrganizationAdaptivePolicyPolicy', update: 'updateOrganizationAdaptivePolicyPolicy', delete: 'deleteOrganizationAdaptivePolicyPolicy' },
  path: `${ORG}/policies`,
  param: 'id',
  parent,
  store: policiesOf,
  scope: 'organization',
  what: 'adaptive policy',
  plural: 'adaptive policies',
  key: 'adaptivePolicyId',
  nextId: (ctx, s) => nextId(s),
  unique: false,
  required: ['sourceGroup', 'destinationGroup'],
  check: (ctx, org, b, p) => checkPolicy(org, b, p),
  blank: (ctx) => ({ sourceGroupId: null, destinationGroupId: null, aclIds: [], lastEntryRule: 'default', createdAt: isoMicro(ctx.now), updatedAt: isoMicro(ctx.now) }),
  apply: (p, b, org, ctx, c) => {
    p.sourceGroupId = c.source;
    p.destinationGroupId = c.destination;
    if (c.aclIds) p.aclIds = c.aclIds;
    if (b.lastEntryRule != null) p.lastEntryRule = b.lastEntryRule;
    p.updatedAt = isoMicro(ctx.now);
  },
  json: policyJson,
  missing: MISSING,
});

// ── Overview and settings ──

function overview(ctx) {
  const org = parent(ctx);
  const all = policiesOf(org).list;
  const groupList = org.adaptivePolicyGroups.list;
  return {
    counts: {
      groups: groupList.length,
      customGroups: groupList.filter((g) => !g.isDefaultGroup).length,
      customAcls: aclsOf(org).list.length,
      policies: all.length,
      denyPolicies: all.filter((p) => p.lastEntryRule === 'deny').length,
      allowPolicies: all.filter((p) => p.lastEntryRule === 'allow').length,
      policyObjects: (org.policyObjects?.list ?? []).filter((o) => o.category === 'adaptivePolicy').length,
    },
    limits: { ...LIMITS },
  };
}

// Networks whose devices tag traffic: switches, wireless and appliances.
function updateSettings(ctx) {
  const org = orgOf(ctx);
  const ids = ctx.body.enabledNetworks;
  if (ids != null) {
    for (const [i, id] of ids.entries()) {
      const net = org.networks.find((n) => n.id === id);
      if (!net) throw badRequest(`'enabledNetworks[${i}]' names network ${id}, which doesn't exist in this organization`);
      if (!net.productTypes.some((t) => ['switch', 'wireless', 'appliance'].includes(t))) throw badRequest(`'enabledNetworks[${i}]' names network ${id}, which has no switches, access points or appliances`);
    }
    settingsOf(org).enabledNetworks = [...new Set(ids)];
  }
  return { enabledNetworks: [...settingsOf(org).enabledNetworks] };
}

export default [
  ...acls.routes.map((r) => (r.method === 'POST' ? { ...r, status: 200 } : r)),
  { op: 'deleteOrganizationAdaptivePolicyAcl', method: 'DELETE', path: `${ORG}/acls/{aclId}`, handler: deleteAcl },
  ...groups.routes,
  { op: 'deleteOrganizationAdaptivePolicyGroup', method: 'DELETE', path: `${ORG}/groups/{id}`, handler: deleteGroup },
  { op: 'getOrganizationAdaptivePolicyOverview', path: `${ORG}/overview`, handler: overview },
  ...policies.routes,
  { op: 'getOrganizationAdaptivePolicySettings', path: `${ORG}/settings`, handler: (ctx) => ({ enabledNetworks: [...settingsOf(orgOf(ctx)).enabledNetworks] }) },
  { op: 'updateOrganizationAdaptivePolicySettings', method: 'PUT', path: `${ORG}/settings`, handler: updateSettings },
];
