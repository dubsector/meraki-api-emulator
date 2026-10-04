// Camera permission scopes and the organization's camera roles. Scopes are a
// fixed list; roles apply them to devices, networks or the whole organization.
// Devices are kept as objects, so a swap keeps the entry and a removed camera
// drops out on read. Network IDs follow split and combine through repoint.

import { badRequest, notFound } from '../http.js';
import { collection, countingId, orgOf } from './common.js';

const PERMISSIONS = '/organizations/{organizationId}/camera/permissions';
const ROLES = '/organizations/{organizationId}/camera/roles';
const MAX_ROLES = 100;
const MISSING = { roleId: '1000000', status: 404 };
const LISTS = ['appliedOnDevices', 'appliedOnNetworks', 'appliedOrgWide'];

// The scope level, and the permission level roles show for it.
const SCOPES = [
  { id: '1', name: 'camera_video', level: 'live_video', permissionLevel: 'view_live' },
  { id: '2', name: 'camera_video', level: 'video', permissionLevel: 'view' },
  { id: '3', name: 'camera_video', level: 'video_and_export', permissionLevel: 'view_and_export' },
  { id: '4', name: 'camera_settings', level: 'read_only', permissionLevel: 'read_only' },
  { id: '5', name: 'camera_settings', level: 'full_access', permissionLevel: 'full_access' },
];

const scopeJson = (s) => ({ id: s.id, name: s.name, level: s.level });

function permission(ctx) {
  orgOf(ctx);
  const s = SCOPES.find((x) => x.id === ctx.params.permissionScopeId);
  if (!s) throw notFound('Permission scope');
  return scopeJson(s);
}

const rolesOf = (org) => (org.cameraRoles ??= { created: 0, list: [] });

const nextId = (ctx, store, org) => countingId(ctx, store, 'cameraRole', org.id, 7);

// Legacy numeric network IDs are the digits after the prefix.
const networkIn = (org, id) => org.networks.find((n) => n.id === id || n.id.replace(/^[A-Z]_/, '') === id);

function scopeOf(e, at) {
  const s = SCOPES.find((x) => x.id === e.permissionScopeId);
  if (!s) throw badRequest(`'${at}.permissionScopeId' must name a camera permission scope`);
  return s.id;
}

function oneOf(e, at) {
  const tag = e.tag || null;
  const id = e.id || null;
  if (!tag === !id) throw badRequest(`'${at}' needs either 'tag' or 'id'`);
  return { tag, id };
}

// Works every list out before anything changes. Lists the body leaves out stay.
function checkRole(org, b) {
  const out = {};
  if (b.appliedOnDevices != null) {
    out.appliedOnDevices = b.appliedOnDevices.map((e, i) => {
      const at = `appliedOnDevices[${i}]`;
      const { tag, id } = oneOf(e, at);
      const dev = id && org.devices.find((d) => d.serial === id);
      if (id && dev?.productType !== 'camera') throw badRequest(`'${at}.id' must be the serial of a camera in this organization`);
      let networkId = null;
      if (e.inNetworksWithId) {
        if (!tag) throw badRequest(`'${at}.inNetworksWithId' only applies to device tags`);
        networkId = networkIn(org, e.inNetworksWithId)?.id;
        if (!networkId) throw badRequest(`'${at}.inNetworksWithId' must name a network in this organization`);
      }
      if (e.inNetworksWithTag && !tag) throw badRequest(`'${at}.inNetworksWithTag' only applies to device tags`);
      return { tag, dev: dev || null, inNetworksWithTag: e.inNetworksWithTag || null, inNetworksWithId: networkId, scopeId: scopeOf(e, at) };
    });
  }
  if (b.appliedOnNetworks != null) {
    out.appliedOnNetworks = b.appliedOnNetworks.map((e, i) => {
      const at = `appliedOnNetworks[${i}]`;
      const { tag, id } = oneOf(e, at);
      const networkId = id && networkIn(org, id)?.id;
      if (id && !networkId) throw badRequest(`'${at}.id' must name a network in this organization`);
      return { tag, networkId: networkId || null, scopeId: scopeOf(e, at) };
    });
  }
  if (b.appliedOrgWide != null) out.appliedOrgWide = b.appliedOrgWide.map((e, i) => ({ scopeId: scopeOf(e, `appliedOrgWide[${i}]`) }));
  return out;
}

function scopeFields(id) {
  const s = SCOPES.find((x) => x.id === id);
  return { permissionScopeId: s.id, permissionScope: s.name, permissionLevel: s.permissionLevel };
}

// Entries naming a camera or a network that left the organization drop out.
function roleJson(r, org) {
  const has = (id) => !id || org.networks.some((n) => n.id === id);
  return {
    id: r.id,
    name: r.name,
    appliedOnDevices: r.appliedOnDevices.filter((e) => (!e.dev || org.devices.includes(e.dev)) && has(e.inNetworksWithId)).map((e) => ({ tag: e.tag ?? '', id: e.dev?.serial ?? '', ...scopeFields(e.scopeId) })),
    appliedOnNetworks: r.appliedOnNetworks.filter((e) => has(e.networkId)).map((e) => ({ tag: e.tag ?? '', id: e.networkId ?? '', ...scopeFields(e.scopeId) })),
    appliedOrgWide: r.appliedOrgWide.map((e) => ({ tag: '', ...scopeFields(e.scopeId) })),
  };
}

const roles = collection({
  ops: {
    list: 'getOrganizationCameraRoles',
    create: 'createOrganizationCameraRole',
    get: 'getOrganizationCameraRole',
    update: 'updateOrganizationCameraRole',
    delete: 'deleteOrganizationCameraRole',
  },
  path: ROLES,
  param: 'roleId',
  parent: orgOf,
  store: rolesOf,
  scope: 'organization',
  what: 'camera role',
  nextId,
  max: MAX_ROLES,
  required: ['name'],
  check: (ctx, org, b) => checkRole(org, b),
  blank: () => ({ name: null, appliedOnDevices: [], appliedOnNetworks: [], appliedOrgWide: [] }),
  apply: (r, b, org, ctx, checked) => {
    if (b.name != null) r.name = b.name;
    for (const k of LISTS) if (checked[k]) r[k] = checked[k];
  },
  json: roleJson,
  missing: MISSING,
});

export default [
  {
    op: 'getOrganizationCameraPermissions',
    path: PERMISSIONS,
    handler: (ctx) => {
      orgOf(ctx);
      return SCOPES.map(scopeJson);
    },
  },
  { op: 'getOrganizationCameraPermission', path: `${PERMISSIONS}/{permissionScopeId}`, sample: { permissionScopeId: '1' }, handler: permission },
  ...roles.routes,
];
