// Organization-wide group policies. Each policy gets a group number that
// tracks it across the organization, and holds adaptive policy groups,
// appliance VLANs and organization-wide firewall rulesets. A group or VLAN
// belongs to one policy at a time. These are not the per-network group
// policies in networkwide.js.

import { configOf } from '../config.js';
import { arrayParam, badRequest, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { iso } from '../time.js';
import { inRange } from '../validate.js';
import { groupsOf } from './adaptivepolicy.js';
import { collection, orgOf } from './common.js';

const BASE = '/organizations/{organizationId}/policies/global/group/policies';
const GROUPS = `${BASE}/adaptivePolicyGroups`;
const VLANS = `${BASE}/appliance/vlans`;
const RULESETS = `${BASE}/firewall/rulesets/assignments`;
const MAX_POLICIES = 1000;
const MAX_PRIORITY = 100000;
const FIRST_NUMBER = 100;

// IDs count up from a start seeded by the organization, so creation order is ID order.
const store = (org, kind, extra = { list: [] }) => ({ start: new Rand(hashStr(`meraki-api-emulator:${kind}:${org.id}`)).int(100, 899), created: 0, ...extra });
const nextId = (s) => String(s.start + ++s.created);
const policiesOf = (org) => (org.globalGroupPolicies ??= store(org, 'globalGroupPolicy', { list: [], numbers: 0 }));
const assignmentsOf = (org) => (org.globalGroupPolicyAssignments ??= store(org, 'globalGroupPolicyAssignment', { groups: [], vlans: [] }));
const rulesetsOf = (org) => (org.globalGroupPolicyRulesets ??= store(org, 'globalGroupPolicyRuleset'));
const policyOf = (org, id) => policiesOf(org).list.find((p) => p.policyId === id);

// ── Policies ──

const policyJson = (p) => ({ policyId: p.policyId, name: p.name, description: p.description, group: { number: p.number }, createdAt: p.createdAt, lastUpdatedAt: p.lastUpdatedAt });

const policies = collection({
  ops: { create: 'createOrganizationPoliciesGlobalGroupPolicy', update: 'updateOrganizationPoliciesGlobalGroupPolicy' },
  path: BASE,
  param: 'policyId',
  parent: orgOf,
  store: policiesOf,
  scope: 'organization',
  what: 'policy',
  plural: 'organization-wide policies',
  key: 'policyId',
  nextId: (ctx, s) => nextId(s),
  max: MAX_POLICIES,
  required: ['name'],
  blank: (ctx, org) => ({ name: null, description: '', number: FIRST_NUMBER + policiesOf(org).numbers++, createdAt: iso(ctx.now), lastUpdatedAt: iso(ctx.now) }),
  apply: (p, b, org, ctx) => {
    if (b.name != null) p.name = b.name;
    if (b.description != null) p.description = b.description;
    p.lastUpdatedAt = iso(ctx.now);
  },
  json: policyJson,
});

function listPolicies(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'policyIds');
  const name = ctx.query.getAll('name').at(-1)?.toLowerCase();
  const list = policiesOf(org).list.filter((p) => (!ids.length || ids.includes(p.policyId)) && (!name || p.name.toLowerCase().includes(name)));
  return paginateItems(ctx, list, (p) => p.policyId, { def: 100, max: 100 }, policyJson);
}

// A policy goes with its assignments.
function deletePolicy(ctx) {
  const { parent: org, store: s, item } = policies.find(ctx);
  s.list.splice(s.list.indexOf(item), 1);
  const a = assignmentsOf(org);
  const keep = (x) => x.policyId !== item.policyId;
  a.groups = a.groups.filter(keep);
  a.vlans = a.vlans.filter(keep);
  const r = rulesetsOf(org);
  r.list = r.list.filter(keep);
}

// The policy an assign or remove body names.
function bodyPolicy(org, b) {
  if (b.policy?.id == null) throw badRequest("'policy.id' is required");
  const p = policyOf(org, String(b.policy.id));
  if (!p) throw badRequest(`'policy.id' names policy ${b.policy.id}, which doesn't exist in this organization`);
  return p;
}

// ── Appliance VLANs ──

// A VLAN is named by the ID getNetworkApplianceVlans gives it or, as
// organization-wide firewall rules name it, by <networkId>_vlan_<vlanId>.
const vlanKey = (networkId, vlanId) => `${networkId}_vlan_${vlanId}`;

// Every appliance VLAN in the organization, in network order.
function orgVlans(org) {
  return org.networks
    .filter((n) => n.productTypes.includes('appliance'))
    .flatMap((net) => {
      const c = configOf(net);
      if (!c.vlansEnabled) return [];
      return [...c.vlans].sort((a, b) => a.id - b.id).map((v) => ({ net, vlan: v, key: vlanKey(net.id, v.id) }));
    });
}

const named = (x, id) => x.key === id || x.vlan.interfaceId === id;

function resolveVlans(org, list) {
  const all = orgVlans(org);
  return list.map((x, i) => {
    const id = x.interfaceId;
    if (typeof id !== 'string' || !id) throw badRequest(`'vlans[${i}].interfaceId' is required`);
    const found = all.filter((v) => named(v, id));
    if (!found.length) throw badRequest(`'vlans[${i}].interfaceId' names ${id}, which is not an appliance VLAN in this organization`);
    // Networks bound to one template (or copied from one network) share interface IDs.
    if (found.length > 1) throw badRequest(`'vlans[${i}].interfaceId' ${id} is a VLAN of more than one network; name it as <networkId>_vlan_<vlanId>`);
    return found[0];
  });
}

// Rows whose network or VLAN has gone drop out on read.
function liveVlanRows(org) {
  const byKey = new Map(orgVlans(org).map((v) => [v.key, v]));
  return assignmentsOf(org).vlans.flatMap((r) => {
    const v = byKey.get(vlanKey(r.networkId, r.vlanId));
    return v ? [{ row: r, v }] : [];
  });
}

const dedupe = (list, keyOf) => [...new Map(list.map((x) => [keyOf(x), x])).values()];

function assignVlans(ctx) {
  const org = orgOf(ctx);
  const p = bodyPolicy(org, ctx.body);
  const vlans = dedupe(resolveVlans(org, ctx.body.vlans ?? []), (v) => v.key);
  if (!vlans.length) throw badRequest("'vlans' must list at least one VLAN");
  const live = liveVlanRows(org);
  for (const v of vlans) {
    const held = live.find((x) => x.v.key === v.key && x.row.policyId !== p.policyId);
    if (held) throw badRequest(`VLAN ${v.key} is already assigned to policy ${held.row.policyId}`);
  }
  const a = assignmentsOf(org);
  // A row left by a deleted VLAN of the same ID gives way.
  const stale = new Set(vlans.map((v) => v.key));
  const kept = new Set(live.map((x) => x.row));
  a.vlans = a.vlans.filter((r) => kept.has(r) || !stale.has(vlanKey(r.networkId, r.vlanId)));
  for (const v of vlans) {
    if (live.some((x) => x.v.key === v.key)) continue;
    a.vlans.push({ assignmentId: nextId(a), policyId: p.policyId, networkId: v.net.id, vlanId: v.vlan.id });
  }
  return { success: true };
}

function removeVlans(ctx) {
  const org = orgOf(ctx);
  const p = bodyPolicy(org, ctx.body);
  const vlans = dedupe(resolveVlans(org, ctx.body.vlans ?? []), (v) => v.key);
  if (!vlans.length) throw badRequest("'vlans' must list at least one VLAN");
  const live = liveVlanRows(org);
  const rows = vlans.map((v) => {
    const x = live.find((y) => y.v.key === v.key && y.row.policyId === p.policyId);
    if (!x) throw badRequest(`VLAN ${v.key} is not assigned to policy ${p.policyId}`);
    return x.row;
  });
  const a = assignmentsOf(org);
  a.vlans = a.vlans.filter((r) => !rows.includes(r));
  return { success: true };
}

function listVlanAssignments(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'assignmentIds');
  const pols = arrayParam(ctx.query, 'policyIds');
  const ifaces = arrayParam(ctx.query, 'interfaceIds');
  const list = liveVlanRows(org).filter(({ row, v }) => (!ids.length || ids.includes(row.assignmentId)) && (!pols.length || pols.includes(row.policyId)) && (!ifaces.length || ifaces.some((i) => named(v, i))));
  return paginateItems(ctx, list, (x) => x.row.assignmentId, { def: 1000, max: 1000 }, ({ row, v }) => ({ assignmentId: row.assignmentId, policyId: row.policyId, interfaceId: v.key }));
}

// Every appliance VLAN in the organization with the policy it belongs to, or null.
function listByVlan(ctx) {
  const org = orgOf(ctx);
  const vlanIds = arrayParam(ctx.query, 'vlanIds');
  const ifaces = arrayParam(ctx.query, 'interfaceIds');
  const search = ctx.query.get('search')?.toLowerCase();
  const held = new Map(liveVlanRows(org).map(({ row, v }) => [v.key, policyOf(org, row.policyId)]));
  const list = orgVlans(org)
    .map((v) => ({ ...v, policy: held.get(v.key) ?? null }))
    .filter((x) => (!vlanIds.length || vlanIds.includes(x.vlan.id)) && (!ifaces.length || ifaces.some((i) => named(x, i))))
    .filter((x) => !search || [x.vlan.name, x.vlan.subnet, x.net.name, x.policy?.name].some((s) => s?.toLowerCase().includes(search)));
  return paginateItems(ctx, list, (x) => x.key, { def: 100, max: 100 }, (x) => ({
    network: { id: x.net.id, name: x.net.name },
    name: x.vlan.name,
    subnet: x.vlan.subnet,
    interfaceId: x.key,
    vlanId: x.vlan.id,
    policy: x.policy && { id: x.policy.policyId, name: x.policy.name, group: { number: x.policy.number } },
  }));
}

// ── Adaptive policy groups ──

function bodyGroups(org, ctx) {
  const ids = (ctx.body.adaptivePolicyGroups ?? []).map((g, i) => {
    if (g.id == null || g.id === '') throw badRequest(`'adaptivePolicyGroups[${i}].id' is required`);
    const id = String(g.id);
    if (!groupsOf(org, ctx.now).list.some((x) => x.groupId === id)) throw badRequest(`'adaptivePolicyGroups[${i}].id' names adaptive policy group ${id}, which doesn't exist in this organization`);
    return id;
  });
  if (!ids.length) throw badRequest("'adaptivePolicyGroups' must list at least one group");
  return [...new Set(ids)];
}

const groupRows = (org) => assignmentsOf(org).groups;

function assignGroups(ctx) {
  const org = orgOf(ctx);
  const p = bodyPolicy(org, ctx.body);
  const ids = bodyGroups(org, ctx);
  const live = groupRows(org);
  for (const id of ids) {
    const held = live.find((r) => r.groupId === id && r.policyId !== p.policyId);
    if (held) throw badRequest(`Adaptive policy group ${id} is already assigned to policy ${held.policyId}`);
  }
  const a = assignmentsOf(org);
  for (const id of ids) if (!live.some((r) => r.groupId === id)) a.groups.push({ assignmentId: nextId(a), policyId: p.policyId, groupId: id });
  return { success: true };
}

function removeGroups(ctx) {
  const org = orgOf(ctx);
  const p = bodyPolicy(org, ctx.body);
  const ids = bodyGroups(org, ctx);
  const live = groupRows(org);
  const rows = ids.map((id) => {
    const r = live.find((x) => x.groupId === id && x.policyId === p.policyId);
    if (!r) throw badRequest(`Adaptive policy group ${id} is not assigned to policy ${p.policyId}`);
    return r;
  });
  const a = assignmentsOf(org);
  a.groups = a.groups.filter((r) => !rows.includes(r));
  return { success: true };
}

function listGroupAssignments(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'assignmentIds');
  const pols = arrayParam(ctx.query, 'policyIds');
  const groups = arrayParam(ctx.query, 'adaptivePolicyGroupIds');
  const list = groupRows(org).filter((r) => (!ids.length || ids.includes(r.assignmentId)) && (!pols.length || pols.includes(r.policyId)) && (!groups.length || groups.includes(r.groupId)));
  return paginateItems(ctx, list, (r) => r.assignmentId, { def: 1000, max: 1000 }, (r) => ({ assignmentId: r.assignmentId, policyId: r.policyId, adaptivePolicyGroupId: r.groupId }));
}

// ── Firewall ruleset assignments ──

const rulesetExists = (org, id) => org.globalFirewallRulesets?.list.some((s) => s.rulesetId === id);

const rulesetJson = (r) => ({ assignmentId: r.assignmentId, rulesetId: r.rulesetId, policyId: r.policyId, priority: r.priority, createdAt: r.createdAt, lastUpdatedAt: r.lastUpdatedAt });

// A ruleset is assigned to a policy once.
function checkRulesetAssignment(org, b, self) {
  if (b.rulesetId === '' || (b.rulesetId != null && !rulesetExists(org, String(b.rulesetId)))) throw badRequest(`'rulesetId' names firewall ruleset ${b.rulesetId}, which doesn't exist in this organization`);
  if (b.policyId === '' || (b.policyId != null && !policyOf(org, String(b.policyId)))) throw badRequest(`'policyId' names policy ${b.policyId}, which doesn't exist in this organization`);
  inRange(b.priority, 1, MAX_PRIORITY, 'priority');
  const rulesetId = b.rulesetId != null ? String(b.rulesetId) : self?.rulesetId;
  const policyId = b.policyId != null ? String(b.policyId) : self?.policyId;
  if (rulesetsOf(org).list.some((r) => r !== self && r.rulesetId === rulesetId && r.policyId === policyId)) throw badRequest(`Firewall ruleset ${rulesetId} is already assigned to policy ${policyId}`);
}

const rulesetAssignments = collection({
  ops: { create: 'createOrganizationPoliciesGlobalGroupPoliciesFirewallRulesetsAssignment', update: 'updateOrganizationPoliciesGlobalGroupPoliciesFirewallRulesetsAssignment', delete: 'deleteOrganizationPoliciesGlobalGroupPoliciesFirewallRulesetsAssignment' },
  path: RULESETS,
  param: 'assignmentId',
  parent: orgOf,
  store: rulesetsOf,
  scope: 'organization',
  what: 'ruleset assignment',
  key: 'assignmentId',
  nextId: (ctx, s) => nextId(s),
  max: MAX_POLICIES * 100,
  unique: false,
  required: ['rulesetId', 'policyId'],
  check: (ctx, org, b, self) => checkRulesetAssignment(org, b, self),
  blank: (ctx) => ({ rulesetId: null, policyId: null, priority: 1, createdAt: iso(ctx.now), lastUpdatedAt: iso(ctx.now) }),
  apply: (r, b, org, ctx) => {
    if (b.rulesetId != null) r.rulesetId = String(b.rulesetId);
    if (b.policyId != null) r.policyId = String(b.policyId);
    if (b.priority != null) r.priority = b.priority;
    r.lastUpdatedAt = iso(ctx.now);
  },
  json: rulesetJson,
});

function listRulesetAssignments(ctx) {
  const org = orgOf(ctx);
  const sets = arrayParam(ctx.query, 'rulesetIds');
  const pols = arrayParam(ctx.query, 'policyIds');
  const ids = arrayParam(ctx.query, 'assignmentIds');
  const list = rulesetsOf(org).list.filter((r) => (!sets.length || sets.includes(r.rulesetId)) && (!pols.length || pols.includes(r.policyId)) && (!ids.length || ids.includes(r.assignmentId)));
  return paginateItems(ctx, list, (r) => r.assignmentId, { def: 100, max: 100 }, rulesetJson);
}

const ok = { status: 200 };

export default [
  { op: 'getOrganizationPoliciesGlobalGroupPolicies', path: BASE, handler: listPolicies },
  ...policies.routes,
  { op: 'deleteOrganizationPoliciesGlobalGroupPolicy', method: 'DELETE', path: `${BASE}/{policyId}`, handler: deletePolicy },
  { op: 'assignOrganizationPoliciesGlobalGroupPoliciesAdaptivePolicyGroups', method: 'POST', path: `${GROUPS}/assign`, handler: assignGroups, ...ok },
  { op: 'getOrganizationPoliciesGlobalGroupPoliciesAdaptivePolicyGroupsAssignments', path: `${GROUPS}/assignments`, handler: listGroupAssignments },
  { op: 'removeOrganizationPoliciesGlobalGroupPoliciesAdaptivePolicyGroups', method: 'POST', path: `${GROUPS}/remove`, handler: removeGroups, ...ok },
  { op: 'assignOrganizationPoliciesGlobalGroupPoliciesApplianceVlans', method: 'POST', path: `${VLANS}/assign`, handler: assignVlans, ...ok },
  { op: 'getOrganizationPoliciesGlobalGroupPoliciesApplianceVlansAssignments', path: `${VLANS}/assignments`, handler: listVlanAssignments },
  { op: 'getOrganizationPoliciesGlobalGroupPoliciesApplianceVlansAssignmentsByVlan', path: `${VLANS}/assignments/byVlan`, handler: listByVlan },
  { op: 'removeOrganizationPoliciesGlobalGroupPoliciesApplianceVlans', method: 'POST', path: `${VLANS}/remove`, handler: removeVlans, ...ok },
  { op: 'getOrganizationPoliciesGlobalGroupPoliciesFirewallRulesetsAssignments', path: RULESETS, handler: listRulesetAssignments },
  ...rulesetAssignments.routes,
];
