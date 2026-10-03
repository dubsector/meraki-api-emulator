// Organization sign-in settings: login security, SAML SSO with its IdPs and
// roles, and the organization's SNMP access. Nothing here is enforced on
// requests to the emulator; the settings are stored and read back.

import { badRequest } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { parseIp } from '../validate.js';
import { checkHttpUrl } from '../webhooks.js';
import { orgJson } from '../format.js';
import { checkPrivileges } from './admin.js';
import { collection, orgOf } from './common.js';

const ORG = '/organizations/{organizationId}';

// ── Login security ──

const loginOf = (org) =>
  (org.loginSecurity ??= {
    enforcePasswordExpiration: false,
    passwordExpirationDays: 90,
    enforceDifferentPasswords: false,
    numDifferentPasswords: 3,
    enforceStrongPasswords: true,
    minimumPasswordLength: 12,
    enforceAccountLockout: false,
    accountLockoutAttempts: 3,
    enforceIdleTimeout: false,
    idleTimeoutMinutes: 30,
    enforceTwoFactorAuth: false,
    enforceLoginIpRanges: false,
    loginIpRanges: [],
    apiAuthentication: { ipRestrictionsForKeys: { enabled: false, ranges: [] } },
    enforceLockedIpSessions: false,
  });

const COUNTS = { passwordExpirationDays: [1, 365], numDifferentPasswords: [1, 20], minimumPasswordLength: [8, 16], accountLockoutAttempts: [1, 100], idleTimeoutMinutes: [1, 1440] };

// A single address, a CIDR subnet or a range like 10.0.0.1-10.0.0.9.
function isIpRange(v) {
  const s = String(v);
  if (parseIp(s) != null) return true;
  const c = /^([\d.]+)\/(\d{1,2})$/.exec(s);
  if (c) return parseIp(c[1]) != null && Number(c[2]) <= 32;
  const [a, b, extra] = s.split('-');
  return extra === undefined && b !== undefined && parseIp(a) != null && parseIp(b) != null && parseIp(a) <= parseIp(b);
}

function checkRanges(list, name) {
  list.forEach((v, i) => {
    if (!isIpRange(v)) throw badRequest(`'${name}[${i}]' must be an IP address, an IP address range or a CIDR subnet`);
  });
}

function updateLogin(ctx) {
  const org = orgOf(ctx);
  const s = loginOf(org);
  const b = ctx.body;
  for (const [k, [min, max]] of Object.entries(COUNTS)) {
    if (b[k] != null && !(Number.isInteger(b[k]) && b[k] >= min && b[k] <= max)) throw badRequest(`'${k}' must be an integer between ${min} and ${max}`);
  }
  if (b.loginIpRanges) checkRanges(b.loginIpRanges, 'loginIpRanges');
  const keys = b.apiAuthentication?.ipRestrictionsForKeys;
  if (keys?.ranges) checkRanges(keys.ranges, 'apiAuthentication.ipRestrictionsForKeys.ranges');
  const loginRanges = b.loginIpRanges ?? s.loginIpRanges;
  if ((b.enforceLoginIpRanges ?? s.enforceLoginIpRanges) && !loginRanges.length) throw badRequest("'loginIpRanges' must list at least one range when 'enforceLoginIpRanges' is true");
  const old = s.apiAuthentication.ipRestrictionsForKeys;
  const keyRanges = keys?.ranges ?? old.ranges;
  if ((keys?.enabled ?? old.enabled) && !keyRanges.length) throw badRequest("'apiAuthentication.ipRestrictionsForKeys.ranges' must list at least one range when it is enabled");
  for (const k of Object.keys(s)) {
    // Strong passwords are always on; false is ignored, as the spec says.
    if (k === 'apiAuthentication' || k === 'enforceStrongPasswords' || b[k] == null) continue;
    s[k] = Array.isArray(b[k]) ? [...b[k]] : b[k];
  }
  s.apiAuthentication.ipRestrictionsForKeys = { enabled: keys?.enabled ?? old.enabled, ranges: [...keyRanges] };
  return loginJson(s);
}

const loginJson = (s) => ({ ...s, loginIpRanges: [...s.loginIpRanges], apiAuthentication: { ipRestrictionsForKeys: { ...s.apiAuthentication.ipRestrictionsForKeys, ranges: [...s.apiAuthentication.ipRestrictionsForKeys.ranges] } } });

// ── SAML ──

const samlOf = (org) => (org.saml ??= { enabled: false, subdomain: null, idpId: null });
const idpsOf = (org) => (org.samlIdps ??= { created: 0, list: [] });
const rolesOf = (org) => (org.samlRoles ??= { created: 0, list: [] });

const samlJson = (s) => ({ enabled: s.enabled, spInitiated: { subdomain: s.subdomain, idpId: s.idpId } });

const SUBDOMAIN = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

function updateSaml(ctx) {
  const org = orgOf(ctx);
  const s = samlOf(org);
  const sp = ctx.body.spInitiated ?? {};
  if (sp.subdomain != null) {
    if (!SUBDOMAIN.test(sp.subdomain)) throw badRequest("'spInitiated.subdomain' must be letters, digits, '-' or '_', up to 63 characters");
    const taken = ctx.world.orgs.some((o) => o !== org && o.saml?.subdomain?.toLowerCase() === sp.subdomain.toLowerCase());
    if (taken) throw badRequest(`The subdomain '${sp.subdomain}' is already in use`);
  }
  if (sp.idpId != null && !idpsOf(org).list.some((x) => x.idpId === sp.idpId)) throw badRequest("'spInitiated.idpId' must name a SAML IdP in this organization");
  if (ctx.body.enabled != null) s.enabled = ctx.body.enabled;
  if (sp.subdomain != null) s.subdomain = sp.subdomain;
  if (sp.idpId != null) s.idpId = sp.idpId;
  return samlJson(s);
}

// IDs are 13 digits like the spec's examples, from a seeded stream per kind.
const nextId = (kind, key) => (ctx, store, org) => {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${org.id}:${store.created}`));
  let id;
  do id = r.digits(13);
  while (store.list.some((x) => x[key] === id));
  return id;
};

// The consumer URL sits on the organization's Dashboard host.
function idpJson(x, org) {
  const consumerUrl = `${new URL(orgJson(org).url).origin}/saml/login/${org.slug}/${x.idpId}`;
  return { idpId: x.idpId, consumerUrl, visionConsumerUrl: `${consumerUrl}?appTarget=MerakiVision`, x509certSha1Fingerprint: x.x509certSha1Fingerprint, ssoLoginUrl: x.ssoLoginUrl, sloLogoutUrl: x.sloLogoutUrl };
}

const FINGERPRINT = /^[0-9a-f]{2}(:?[0-9a-f]{2}){19}$/i;

function checkIdp(b) {
  if (b.x509certSha1Fingerprint != null && !FINGERPRINT.test(b.x509certSha1Fingerprint)) throw badRequest("'x509certSha1Fingerprint' must be a SHA1 fingerprint of 20 hex bytes, like 00:11:22:...");
  for (const k of ['ssoLoginUrl', 'sloLogoutUrl']) if (b[k]) checkHttpUrl(b[k], k);
}

const idps = collection({
  ops: {
    list: 'getOrganizationSamlIdps',
    create: 'createOrganizationSamlIdp',
    get: 'getOrganizationSamlIdp',
    update: 'updateOrganizationSamlIdp',
    delete: 'deleteOrganizationSamlIdp',
  },
  path: `${ORG}/saml/idps`,
  param: 'idpId',
  parent: orgOf,
  store: idpsOf,
  scope: 'organization',
  what: 'SAML IdP',
  key: 'idpId',
  nextId: nextId('samlIdp', 'idpId'),
  max: 20,
  required: ['x509certSha1Fingerprint'],
  unique: false,
  check: (ctx, org, b) => checkIdp(b),
  blank: () => ({ x509certSha1Fingerprint: null, ssoLoginUrl: '', sloLogoutUrl: '' }),
  apply: (x, b) => {
    for (const k of ['x509certSha1Fingerprint', 'ssoLoginUrl', 'sloLogoutUrl']) if (b[k] != null) x[k] = b[k];
  },
  json: idpJson,
  inUse: (x, org) => (samlOf(org).idpId === x.idpId ? 'The SAML IdP is used for SP-initiated SSO' : null),
  missing: { idpId: '1000000000000', status: 404 },
});

const ORG_ACCESS = ['none', 'read-only', 'full', 'enterprise'];
const TAG_ACCESS = ['full', 'read-only', 'guest-ambassador', 'monitor-only'];
const NETWORK_ACCESS = [...TAG_ACCESS, 'ssid-admin', 'port-tags'];

function checkAccess(v, allowed, name, custom) {
  if (allowed.includes(v) || custom.test(v)) return;
  throw badRequest(`'${name}' must be one of ${allowed.map((a) => `'${a}'`).join(', ')} or a custom role`);
}

function checkRole(org, store, b, self) {
  if (b.role != null) {
    if (!b.role.trim()) throw badRequest("'role' must not be empty");
    if (store.list.some((x) => x !== self && x.role === b.role)) throw badRequest(`A SAML role named '${b.role}' already exists in this organization`);
  }
  if (b.orgAccess != null) checkAccess(b.orgAccess, ORG_ACCESS, 'orgAccess', /^custom-role:\d+:.+$/);
  (b.tags ?? []).forEach((t, i) => {
    if (typeof t.tag !== 'string' || !t.tag.trim()) throw badRequest(`'tags[${i}].tag' must not be empty`);
    checkAccess(t.access, TAG_ACCESS, `tags[${i}].access`, /^custom-role:\d+$/);
  });
  (b.networks ?? []).forEach((n, i) => checkAccess(n.access, NETWORK_ACCESS, `networks[${i}].access`, /^custom-role:\d+$/));
  checkPrivileges(org, b);
}

// Networks that left the organization drop out on read.
function roleJson(r, org) {
  const networks = r.networks.filter((n) => org.networks.some((x) => x.id === n.id));
  return { id: r.id, role: r.role, orgAccess: r.orgAccess, networks: networks.map((n) => ({ ...n })), tags: r.tags.map((t) => ({ ...t })), camera: [] };
}

const roles = collection({
  ops: {
    list: 'getOrganizationSamlRoles',
    create: 'createOrganizationSamlRole',
    get: 'getOrganizationSamlRole',
    update: 'updateOrganizationSamlRole',
    delete: 'deleteOrganizationSamlRole',
  },
  path: `${ORG}/samlRoles`,
  param: 'samlRoleId',
  parent: orgOf,
  store: rolesOf,
  scope: 'organization',
  what: 'SAML role',
  nextId: nextId('samlRole', 'id'),
  max: 100,
  required: ['role', 'orgAccess'],
  unique: false,
  check: (ctx, org, b, self) => checkRole(org, rolesOf(org), b, self),
  blank: () => ({ role: null, orgAccess: null, networks: [], tags: [] }),
  apply: (r, b) => {
    if (b.role != null) r.role = b.role;
    if (b.orgAccess != null) r.orgAccess = b.orgAccess;
    if (b.networks) r.networks = b.networks.map((n) => ({ id: n.id, access: n.access }));
    if (b.tags) r.tags = b.tags.map((t) => ({ tag: t.tag, access: t.access }));
  },
  json: roleJson,
  missing: { samlRoleId: '1000000000000', status: 404 },
});

// ── SNMP ──

const snmpOf = (org) => (org.snmp ??= { v2cEnabled: false, v3Enabled: false, v3AuthMode: 'SHA', v3PrivMode: 'AES128', v3AuthPass: null, v3PrivPass: null, peerIps: [] });

// The community string and the v3 user are the same per-organization name.
function snmpUser(ctx, org) {
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:snmp:${org.id}`));
  return `o/${r.chars(8, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')}`;
}

function snmpJson(ctx, org) {
  const s = snmpOf(org);
  const user = snmpUser(ctx, org);
  return {
    v2cEnabled: s.v2cEnabled,
    ...(s.v2cEnabled ? { v2CommunityString: user } : {}),
    v3Enabled: s.v3Enabled,
    ...(s.v3Enabled ? { v3User: user, v3AuthMode: s.v3AuthMode, v3PrivMode: s.v3PrivMode } : {}),
    peerIps: [...s.peerIps],
    hostname: 'snmp.meraki.com',
    port: 16100,
  };
}

function updateSnmp(ctx) {
  const org = orgOf(ctx);
  const s = snmpOf(org);
  const b = ctx.body;
  for (const k of ['v3AuthPass', 'v3PrivPass']) if (b[k] != null && b[k].length < 8) throw badRequest(`'${k}' must be at least 8 characters`);
  (b.peerIps ?? []).forEach((ip, i) => {
    if (parseIp(ip) == null) throw badRequest(`'peerIps[${i}]' must be an IPv4 address`);
  });
  if ((b.v3Enabled ?? s.v3Enabled) && !(b.v3AuthPass ?? s.v3AuthPass)) throw badRequest("'v3AuthPass' is required to enable SNMP version 3");
  if ((b.v3Enabled ?? s.v3Enabled) && !(b.v3PrivPass ?? s.v3PrivPass)) throw badRequest("'v3PrivPass' is required to enable SNMP version 3");
  for (const k of ['v2cEnabled', 'v3Enabled', 'v3AuthMode', 'v3PrivMode', 'v3AuthPass', 'v3PrivPass']) if (b[k] != null) s[k] = b[k];
  if (b.peerIps) s.peerIps = [...b.peerIps];
  return snmpJson(ctx, org);
}

export default [
  { op: 'getOrganizationLoginSecurity', path: `${ORG}/loginSecurity`, handler: (ctx) => loginJson(loginOf(orgOf(ctx))) },
  { op: 'updateOrganizationLoginSecurity', method: 'PUT', path: `${ORG}/loginSecurity`, handler: updateLogin },
  { op: 'getOrganizationSaml', path: `${ORG}/saml`, handler: (ctx) => samlJson(samlOf(orgOf(ctx))) },
  { op: 'updateOrganizationSaml', method: 'PUT', path: `${ORG}/saml`, handler: updateSaml },
  ...idps.routes,
  ...roles.routes,
  { op: 'getOrganizationSnmp', path: `${ORG}/snmp`, handler: (ctx) => snmpJson(ctx, orgOf(ctx)) },
  { op: 'updateOrganizationSnmp', method: 'PUT', path: `${ORG}/snmp`, handler: updateSnmp },
];
