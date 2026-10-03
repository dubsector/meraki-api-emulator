// Organization-wide network tools: network groups, moving networks to another
// organization, and combining networks into one.

import { networkJson } from '../format.js';
import { arrayParam, badRequest, notFound, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { deviceStatus } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { WD_RECV, WD_SENT, WL_RECV, WL_SENT, networkTotals } from '../sim/usage.js';
import { DAY, iso } from '../time.js';
import { combineNetworks, moveNetwork, splitNetwork } from '../world.js';
import { netOf, orgOf, round } from './common.js';
import { usesPolicyObjects } from './policyobjects.js';

const GROUPS = '/organizations/{organizationId}/networks/groups';
const GROUP = `${GROUPS}/{groupId}`;
const MAX_GROUPS = 1000;
const MAX_NETWORKS = 500;
const MAX_MOVES = 1000;
const STATUS_ORDER = ['offline', 'alerting', 'online'];

const groupsOf = (org) => (org.networkGroups ??= { created: 0, list: [] });

function groupOf(ctx) {
  const org = orgOf(ctx);
  const group = groupsOf(org).list.find((g) => g.groupId === ctx.params.groupId);
  if (!group) throw notFound('Network group');
  return { org, group };
}

const groupJson = (org, g) => ({ groupId: g.groupId, organizationId: org.id, name: g.name });

function checkName(org, name, group) {
  if (!name?.trim()) throw badRequest("'name' must not be empty");
  if (groupsOf(org).list.some((g) => g !== group && g.name === name)) throw badRequest('Name has already been taken');
}

// The body's networks, each checked against the organization.
function networksIn(org, ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw badRequest("'networkIds' must not be empty");
  for (const id of unique) if (!org.networks.some((n) => n.id === id)) throw badRequest(`Network ${id} is not in this organization`);
  return unique;
}

function createGroup(ctx) {
  const org = orgOf(ctx);
  const store = groupsOf(org);
  checkName(org, ctx.body.name, null);
  if (store.list.length >= MAX_GROUPS) throw badRequest(`Organizations are limited to ${MAX_GROUPS} network groups in the emulator`);
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:networkGroup:${org.id}:${store.created}`));
  let groupId;
  do groupId = r.digits(13);
  while (store.list.some((g) => g.groupId === groupId));
  const group = { groupId, name: ctx.body.name, networkIds: [] };
  store.list.push(group);
  return groupJson(org, group);
}

// A network is in one group at most, so assigning it takes it out of any other.
function assignNetworks(ctx) {
  const { org, group } = groupOf(ctx);
  const ids = networksIn(org, ctx.body.networkIds);
  for (const g of groupsOf(org).list) g.networkIds = g.networkIds.filter((id) => !ids.includes(id));
  group.networkIds.push(...ids);
  return { networkIds: ids };
}

// Status counts, clients and usage over the last seven days for a set of
// networks. Also used by the top networks by status summary.
export function statusOverview(nets, now) {
  const productTypes = [...new Set(nets.flatMap((n) => n.productTypes))];
  const t0 = now - 7 * DAY;
  let up = 0;
  let down = 0;
  let clients = 0;
  for (const n of nets) {
    const [ws, wr, ds, dr] = networkTotals(n, t0, now, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
    up += ws + ds;
    down += wr + dr;
    for (const c of n.clients) if (presenceIn(c, t0, now)) clients++;
  }
  const byProductType = productTypes.map((productType) => {
    const counts = { online: 0, offline: 0, alerting: 0, dormant: 0 };
    for (const n of nets) for (const d of n.devices) if (d.productType === productType) counts[deviceStatus(d, now)]++;
    return { productType, counts };
  });
  const seen = (s) => byProductType.some((p) => p.counts[s] > 0);
  return {
    clients: { counts: { total: clients }, usage: { upstream: round(up, 2), downstream: round(down, 2) } },
    statuses: { overall: STATUS_ORDER.find(seen) ?? 'online', byProductType },
    productTypes,
  };
}

// Worst status first, then by name.
export const byStatus = (a, b) => STATUS_ORDER.indexOf(a.statuses.overall) - STATUS_ORDER.indexOf(b.statuses.overall) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// The group a network is in, if any. Reading doesn't create the group store.
export const groupOfNetwork = (org, id) => org.networkGroups?.list.find((g) => g.networkIds.includes(id)) ?? null;

function groupOverview(org, g, now) {
  return { groupId: g.groupId, name: g.name, ...statusOverview(org.networks.filter((n) => g.networkIds.includes(n.id)), now) };
}

// ── Moves ──

const movesOf = (world) => (world.networkMoves ??= { created: 0, list: [] });
const msIso = (t) => iso(t).replace('Z', '.000Z');

// Why a move can't go ahead, or null when it can.
function moveProblem(org, net, dest) {
  if (!dest || dest === org) return 'Cannot move network: Target organization is invalid or inaccessible.';
  if (dest.licensing !== org.licensing) return 'Cannot move network: The source and target organizations use different licensing models.';
  if (net.template) return 'Cannot move network: The network is bound to a configuration template.';
  if (usesPolicyObjects(net)) return "Cannot move network: The network's firewall rules use policy objects of the source organization.";
  if (dest.networks.some((n) => n.name === net.name)) return 'Cannot move network: A network with the same name already exists in the target organization.';
  if (dest.networks.length >= MAX_NETWORKS) return 'Cannot move network: The target organization has reached its network limit.';
  return null;
}

const moveJson = (m) => ({
  moveId: m.moveId,
  initiator: { admin: { id: m.adminId } },
  organizations: { source: { id: m.sourceId }, target: { id: m.targetId } },
  network: { id: m.networkId },
  createdAt: msIso(m.createdAt),
  lastUpdatedAt: msIso(m.createdAt),
  result: { status: m.status, reason: m.reason },
});

// Moves happen at once, so a move is completed or failed as soon as it's
// made. A simulated one is checked the same way but neither done nor kept.
function createMove(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const networkId = b.network?.id;
  const targetId = b.organizations?.target?.id;
  if (networkId == null) throw badRequest("'network.id' is required");
  if (targetId == null) throw badRequest("'organizations.target.id' is required");
  const net = org.networks.find((n) => n.id === networkId);
  if (!net) throw badRequest(`Network ${networkId} is not in this organization`);
  const dest = ctx.world.orgById.get(targetId);
  const problem = moveProblem(org, net, dest);
  const store = movesOf(ctx.world);
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:networkMove:${store.created}`));
  let moveId;
  do moveId = r.digits(6);
  while (store.list.some((m) => m.moveId === moveId));
  const move = { moveId, adminId: ctx.world.apiAdmin.id, sourceId: org.id, targetId, networkId, createdAt: ctx.now, status: problem ? 'failed' : 'completed', reason: problem };
  if (b.simulate) {
    if (!problem) move.reason = 'Simulated move: the network can be moved and was left in place.';
    return moveJson(move);
  }
  if (!problem) moveNetwork(ctx.world, net, dest);
  store.list.push(move);
  store.list.splice(0, Math.max(0, store.list.length - MAX_MOVES));
  return moveJson(move);
}

function combine(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const ids = networksIn(org, b.networkIds);
  if (ids.length < 2) throw badRequest("'networkIds' must list at least two networks");
  const nets = ids.map((id) => org.networks.find((n) => n.id === id));
  const bound = nets.find((n) => n.template);
  if (bound) throw badRequest(`Network ${bound.id} is bound to a config template; unbind it first`);
  for (const n of nets) {
    const other = nets.find((x) => x !== n && x.productTypes.some((p) => n.productTypes.includes(p)));
    if (other) throw badRequest(`Networks ${n.id} and ${other.id} both have ${other.productTypes.find((p) => n.productTypes.includes(p))} devices; only networks with different product types can be combined`);
  }
  if (!b.name?.trim()) throw badRequest("'name' must not be empty");
  if (org.networks.some((n) => !nets.includes(n) && n.name === b.name)) throw badRequest('Name has already been taken');
  return { resultingNetwork: networkJson(combineNetworks(ctx.world, org, nets, b)) };
}

function split(ctx) {
  const net = netOf(ctx);
  if (net.productTypes.length < 2) throw badRequest('Only a combined network can be split');
  if (net.template) throw badRequest('This network is bound to a config template; unbind it first');
  return { resultingNetworks: splitNetwork(ctx.world, net).map(networkJson) };
}

export default [
  {
    op: 'combineOrganizationNetworks',
    method: 'POST',
    path: '/organizations/{organizationId}/networks/combine',
    status: 200,
    handler: combine,
  },
  {
    op: 'getOrganizationNetworksGroups',
    path: GROUPS,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const ids = arrayParam(ctx.query, 'groupIds');
      const rows = groupsOf(org)
        .list.filter((g) => !ids.length || ids.includes(g.groupId))
        .sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
      return paginateItems(ctx, rows, (g) => g.groupId, { def: 100, max: 1000 }, (g) => groupJson(org, g));
    },
  },
  { op: 'createOrganizationNetworksGroup', method: 'POST', path: GROUPS, handler: createGroup },
  {
    op: 'updateOrganizationNetworksGroup',
    method: 'PUT',
    path: GROUP,
    handler: (ctx) => {
      const { org, group } = groupOf(ctx);
      checkName(org, ctx.body.name, group);
      group.name = ctx.body.name;
      return groupJson(org, group);
    },
  },
  {
    op: 'deleteOrganizationNetworksGroup',
    method: 'DELETE',
    path: GROUP,
    handler: (ctx) => {
      const { org, group } = groupOf(ctx);
      const list = groupsOf(org).list;
      list.splice(list.indexOf(group), 1);
    },
  },
  { op: 'bulkOrganizationNetworksGroupAssign', method: 'POST', path: `${GROUP}/bulkAssign`, status: 200, handler: assignNetworks },
  {
    op: 'bulkOrganizationNetworksGroupUnassign',
    method: 'POST',
    path: `${GROUP}/bulkUnassign`,
    status: 204,
    handler: (ctx) => {
      const { org, group } = groupOf(ctx);
      const ids = networksIn(org, ctx.body.networkIds);
      group.networkIds = group.networkIds.filter((id) => !ids.includes(id));
    },
  },
  {
    op: 'getOrganizationNetworksGroupsOverviewByGroup',
    path: `${GROUPS}/overview/byGroup`,
    handler: (ctx) => {
      const org = orgOf(ctx);
      const sortBy = ctx.query.get('sortBy');
      if (sortBy != null && sortBy !== 'status') throw badRequest("'sortBy' must be one of: status");
      const rows = groupsOf(org)
        .list.map((g) => groupOverview(org, g, ctx.now))
        .sort(byStatus);
      return paginateItems(ctx, rows, (g) => g.groupId, { def: 5000, max: 5000 });
    },
  },
  { op: 'createNetworkMove', method: 'POST', path: '/organizations/{organizationId}/networks/moves', handler: createMove },
  {
    op: 'getNetworkMoves',
    path: '/organizations/{organizationId}/networks/moves',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const ids = arrayParam(ctx.query, 'moveIds');
      const rows = movesOf(ctx.world).list.filter((m) => (m.sourceId === org.id || m.targetId === org.id) && (!ids.length || ids.includes(m.moveId)));
      return paginateItems(ctx, rows, (m) => m.moveId, { def: 50, max: 100, min: 10 }, moveJson);
    },
  },
  { op: 'splitNetwork', method: 'POST', path: '/networks/{networkId}/split', status: 200, handler: split },
];
