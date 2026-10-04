// Systems Manager organization settings (limited access roles, the APNS
// certificate, VPP accounts and Sentry policies) and trusted access in an SM
// network. Sentry policies live in org.smSentryPolicies; each names a network,
// one of its group policies and an SM network, and is dropped on read once any
// of them is gone.

import { configOf } from '../config.js';
import { arrayParam, badRequest, notFound, paginate, paginateItems } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { SCOPES, idOf, lastConnected, smOf } from '../sim/sm.js';
import { DAY, iso } from '../time.js';
import { collection, newId, orgOf } from './common.js';
import { smNet } from './sm.js';

const isSm = (n) => n.productTypes.includes('systemsManager');
const smNets = (org) => org.networks.filter(isSm);
const LAB = { org: 1 };
const tagsOf = (tags, at) => {
  if (tags.some((t) => typeof t !== 'string' || !t.trim())) throw badRequest(`'${at}' must not hold empty tags`);
  return [...new Set(tags.map((t) => t.trim()))];
};

// ── Limited access roles ──

const roleJson = (x) => ({ roleId: x.roleId, name: x.name, scope: x.scope, tags: [...x.tags] });
const rolesOf = (org) => (org.smAdminRoles ??= { created: 0, list: [] });

const roles = collection({
  ops: { create: 'createOrganizationSmAdminsRole', get: 'getOrganizationSmAdminsRole', update: 'updateOrganizationSmAdminsRole', delete: 'deleteOrganizationSmAdminsRole' },
  path: '/organizations/{organizationId}/sm/admins/roles',
  param: 'roleId',
  parent: orgOf,
  store: rolesOf,
  scope: 'organization',
  what: 'limited access role',
  kind: 'smAdminRole',
  key: 'roleId',
  max: 500,
  required: ['name'],
  check: (ctx, org, b) => (b.tags == null ? null : tagsOf(b.tags, 'tags')),
  blank: () => ({ name: '', scope: 'all_tags', tags: [] }),
  apply: (x, b, org, ctx, tags) => {
    if (b.name != null) x.name = b.name;
    if (b.scope != null) x.scope = b.scope;
    if (tags) x.tags = tags;
  },
  json: roleJson,
  missing: { roleId: '1234', status: 404 },
});

function listRoles(ctx) {
  const list = [...rolesOf(orgOf(ctx)).list].sort((a, b) => (a.roleId < b.roleId ? -1 : 1));
  return paginateItems(ctx, list, (x) => x.roleId, { def: 50, min: 3, max: 1000 }, roleJson);
}

// ── APNS certificate and VPP account ──

// An organization with an SM network has an APNS certificate and one VPP
// account, worked out from its ID.
function apnsCert(ctx) {
  const org = orgOf(ctx);
  if (!smNets(org).length) throw notFound('APNS certificate');
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:apns:${org.id}`));
  const der = Buffer.from([0x30, 0x82, 0x05, 0x76, ...Array.from({ length: 0x576 }, () => r.int(0, 255))]).toString('base64');
  return { certificate: `-----BEGIN CERTIFICATE-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n` };
}

export const vppId = (world, org) => idOf(hashStr(`${world.seed}:vpp:${org.id}`), 'vpp');

function vppAccount(world, org, now, withToken) {
  const nets = smNets(org);
  if (!nets.length) return null;
  const r = new Rand(hashStr(`meraki-api-emulator:${world.seed}:vpp:${org.id}`));
  const id = vppId(world, org);
  const expiresAt = iso(world.bootDay + 200 * DAY);
  const token = Buffer.from(JSON.stringify({ expDate: expiresAt.replace('Z', '+0000'), token: r.chars(88, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'), orgName: org.name })).toString('base64');
  // Synced once a day at the same time.
  const phase = r.int(0, DAY - 1);
  const out = {
    vppAccountId: id,
    email: 'apple-vpp@acme-lab.example.com',
    name: `${org.name} Apps and Books`,
    allowedAdmins: 'Network',
    networkIdAdmins: nets.map((n) => n.id).join(','),
    assignableNetworks: 'Some',
    assignableNetworkIds: nets.map((n) => n.id),
    vppLocationId: r.digits(11),
    vppLocationName: org.name,
    lastSyncedAt: iso(Math.floor((now - phase) / DAY) * DAY + phase),
    lastForceSyncedAt: iso(world.bootDay - r.int(20, 60) * DAY + r.int(9, 16) * 3600),
    parsedToken: { orgName: org.name, hashedToken: r.hex(40), expiresAt },
    id,
  };
  // The token only shows on the single account.
  return withToken ? { ...out, contentToken: token, vppServiceToken: token } : out;
}

function getVpp(ctx) {
  const org = orgOf(ctx);
  const a = vppAccount(ctx.world, org, ctx.now, true);
  if (!a || a.id !== ctx.params.vppAccountId) throw notFound('VPP account');
  return a;
}

// ── Sentry policies ──

const MAX_POLICIES = 100;
const NONE = { created: 0, list: [] };
const sentryNet = (n) => n.productTypes.includes('wireless') || n.productTypes.includes('appliance');
const policyNet = (org, id) => org.networks.find((n) => n.id === id);

function alive(org, p) {
  const net = policyNet(org, p.networkId);
  const sm = policyNet(org, p.smNetworkId);
  return !!(net && sentryNet(net) && sm && isSm(sm) && configOf(net).groupPolicies.some((g) => g.groupPolicyId === p.groupPolicyId));
}

const policiesOf = (org, netId) => (org.smSentryPolicies ?? NONE).list.filter((p) => p.networkId === netId && alive(org, p));

// Listed in priority order, lowest first, so the last one wins.
const policyJson = (p, i) => ({
  policyId: p.policyId,
  networkId: p.networkId,
  smNetworkId: p.smNetworkId,
  tags: [...p.tags],
  scope: p.scope,
  groupNumber: p.groupPolicyId,
  groupPolicyId: p.groupPolicyId,
  priority: String(i + 1),
  createdAt: iso(p.createdAt),
  lastUpdatedAt: iso(p.updatedAt),
});

const sentryRow = (org, netId) => ({ networkId: netId, policies: policiesOf(org, netId).map(policyJson) });

// Only policies still shown count, so one hidden by a lost group policy doesn't block a move.
export const usesSentry = (net) => (net.org.smSentryPolicies ?? NONE).list.some((p) => (p.networkId === net.id || p.smNetworkId === net.id) && alive(net.org, p));

// A deleted group policy takes the Sentry policies applying it with it. A new
// group policy drops them too, since its ID may be one a lost policy had (a
// network bound to a template and unbound again).
export function dropSentry(org, config, groupPolicyId) {
  const s = org.smSentryPolicies;
  if (!s) return;
  s.list = s.list.filter((p) => {
    const net = p.groupPolicyId === groupPolicyId && policyNet(org, p.networkId);
    return !net || configOf(net) !== config;
  });
}

function checkPolicies(org, net, list, at) {
  if (list.length > MAX_POLICIES) throw badRequest(`Networks are limited to ${MAX_POLICIES} Sentry policies in the emulator`);
  const old = (org.smSentryPolicies ?? NONE).list.filter((p) => p.networkId === net.id);
  const seen = new Set();
  return list.map((p, j) => {
    const pat = `${at}.policies[${j}]`;
    for (const k of ['smNetworkId', 'scope', 'groupPolicyId']) if (typeof p[k] !== 'string') throw badRequest(`'${pat}.${k}' is required`);
    if (!Array.isArray(p.tags)) throw badRequest(`'${pat}.tags' is required`);
    if (!SCOPES.includes(p.scope)) throw badRequest(`'${pat}.scope' must be one of ${SCOPES.join(', ')}`);
    const tags = tagsOf(p.tags, `${pat}.tags`);
    const sm = policyNet(org, p.smNetworkId);
    if (!sm || !isSm(sm)) throw badRequest(`'${pat}.smNetworkId' ${p.smNetworkId} is not a Systems Manager network in this organization`);
    if (!configOf(net).groupPolicies.some((g) => g.groupPolicyId === p.groupPolicyId)) throw badRequest(`'${pat}.groupPolicyId' ${p.groupPolicyId} is not a group policy of network ${net.id}`);
    let prev = null;
    if (p.policyId != null) {
      prev = old.find((x) => x.policyId === p.policyId);
      if (!prev) throw badRequest(`'${pat}.policyId' ${p.policyId} is not a Sentry policy of network ${net.id}`);
      if (seen.has(prev)) throw badRequest(`'${pat}.policyId' ${p.policyId} is listed more than once`);
      seen.add(prev);
    }
    return { prev, smNetworkId: sm.id, scope: p.scope, tags, groupPolicyId: p.groupPolicyId };
  });
}

// Each network named gets exactly the policies listed, in the order given;
// networks left out keep theirs.
function updateSentry(ctx) {
  const org = orgOf(ctx);
  const items = ctx.body.items;
  if (!Array.isArray(items)) throw badRequest("'items' is required");
  const plans = items.map((it, i) => {
    const at = `items[${i}]`;
    if (typeof it.networkId !== 'string') throw badRequest(`'${at}.networkId' is required`);
    const net = policyNet(org, it.networkId);
    if (!net) throw badRequest(`'${at}.networkId' ${it.networkId} is not a network in this organization`);
    if (!sentryNet(net)) throw badRequest(`'${at}.networkId' must be a network with wireless or an appliance`);
    if (items.findIndex((x) => x.networkId === it.networkId) !== i) throw badRequest(`'${at}.networkId' ${it.networkId} is listed more than once`);
    return { net, policies: checkPolicies(org, net, it.policies ?? [], at) };
  });
  const s = (org.smSentryPolicies ??= { created: 0, list: [] });
  const named = new Set(plans.map((x) => x.net.id));
  const next = s.list.filter((p) => !named.has(p.networkId));
  for (const { net, policies } of plans) {
    for (const x of policies) {
      const fields = { smNetworkId: x.smNetworkId, scope: x.scope, tags: x.tags, groupPolicyId: x.groupPolicyId };
      if (x.prev) {
        if (JSON.stringify({ ...x.prev, ...fields }) !== JSON.stringify(x.prev)) Object.assign(x.prev, fields, { updatedAt: ctx.now });
        next.push(x.prev);
        continue;
      }
      const p = { policyId: newId(ctx, s, 'smSentryPolicy', org.id, 'policyId'), networkId: net.id, ...fields, createdAt: ctx.now, updatedAt: ctx.now };
      s.list.push(p);
      next.push(p);
    }
  }
  s.list = next;
  return { items: plans.map(({ net }) => sentryRow(org, net.id)) };
}

function sentryByNetwork(ctx) {
  const org = orgOf(ctx);
  const ids = arrayParam(ctx.query, 'networkIds');
  const nets = [...new Set((org.smSentryPolicies ?? NONE).list.filter((p) => alive(org, p)).map((p) => p.networkId))].filter((id) => !ids.length || ids.includes(id)).sort();
  // The spec wraps the page in a one-item array.
  return [paginateItems(ctx, nets, (id) => id, { def: 1000, min: 3, max: 1000 }, (id) => sentryRow(org, id))];
}

// ── Trusted access ──

const PAGE = { def: 100, min: 3, max: 1000 };

const configJson = (c) => ({
  id: c.id,
  ssidName: c.ssidName,
  name: c.name,
  scope: c.scope,
  tags: [...c.tags],
  timeboundType: c.timeboundType,
  sendExpirationEmails: c.sendExpirationEmails,
  notifyTimeBeforeAccessEnds: c.notifyTimeBeforeAccessEnds,
  additionalEmailText: c.additionalEmailText,
  accessStartAt: iso(c.accessStartAt),
  accessEndAt: iso(c.accessEndAt),
});

// The device's name, tags and last check-in while it is still enrolled here,
// else what it had when it left (keepAccessRows).
function accessDeviceJson(net, u, now) {
  const dev = smOf(net).devices.find((d) => d.id === u.deviceId);
  return {
    id: u.id,
    name: dev?.name ?? u.name,
    systemType: u.systemType,
    mac: u.mac,
    username: u.username,
    email: u.email,
    tags: [...(dev?.tags ?? u.tags)],
    trustedAccessConnections: u.connections.map((c) => ({
      trustedAccessConfigId: c.trustedAccessConfigId,
      downloadedAt: iso(c.downloadedAt),
      scepCompletedAt: iso(c.scepCompletedAt),
      lastConnectedAt: iso(dev ? Math.max(c.scepCompletedAt, lastConnected(dev, net, now)) : c.scepCompletedAt),
    })),
  };
}

const SM_SAMPLE = { org: 1, networkId: (world) => world.orgs[1].networks.find((n) => n.sm).id };

export default [
  { op: 'getOrganizationSmAdminsRoles', path: '/organizations/{organizationId}/sm/admins/roles', handler: listRoles },
  ...roles.routes,
  { op: 'getOrganizationSmApnsCert', path: '/organizations/{organizationId}/sm/apnsCert', sample: LAB, handler: apnsCert },
  {
    op: 'getOrganizationSmVppAccounts',
    path: '/organizations/{organizationId}/sm/vppAccounts',
    sample: LAB,
    handler: (ctx) => {
      const a = vppAccount(ctx.world, orgOf(ctx), ctx.now, false);
      return a ? [a] : [];
    },
  },
  { op: 'getOrganizationSmVppAccount', path: '/organizations/{organizationId}/sm/vppAccounts/{vppAccountId}', sample: { ...LAB, vppAccountId: (world) => vppId(world, world.orgs[1]) }, handler: getVpp },
  { op: 'updateOrganizationSmSentryPoliciesAssignments', method: 'PUT', path: '/organizations/{organizationId}/sm/sentry/policies/assignments', sample: LAB, handler: updateSentry },
  { op: 'getOrganizationSmSentryPoliciesAssignmentsByNetwork', path: '/organizations/{organizationId}/sm/sentry/policies/assignments/byNetwork', sample: LAB, handler: sentryByNetwork },
  {
    op: 'getNetworkSmTrustedAccessConfigs',
    path: '/networks/{networkId}/sm/trustedAccessConfigs',
    sample: SM_SAMPLE,
    handler: (ctx) => paginate(ctx, smOf(smNet(ctx)).trustedAccess ?? [], (c) => c.id, PAGE).map(configJson),
  },
  {
    op: 'getNetworkSmUserAccessDevices',
    path: '/networks/{networkId}/sm/userAccessDevices',
    sample: SM_SAMPLE,
    handler: (ctx) => {
      const net = smNet(ctx);
      return paginate(ctx, smOf(net).userAccessDevices ?? [], (u) => u.id, PAGE).map((u) => accessDeviceJson(net, u, ctx.now));
    },
  },
  {
    op: 'deleteNetworkSmUserAccessDevice',
    method: 'DELETE',
    path: '/networks/{networkId}/sm/userAccessDevices/{userAccessDeviceId}',
    sample: { ...SM_SAMPLE, userAccessDeviceId: (world) => world.orgs[1].networks.find((n) => n.sm).sm.userAccessDevices[0].id },
    handler: (ctx) => {
      const list = smOf(smNet(ctx)).userAccessDevices ?? [];
      const i = list.findIndex((u) => u.id === ctx.params.userAccessDeviceId);
      if (i < 0) throw notFound('User access device');
      list.splice(i, 1);
    },
  },
];
