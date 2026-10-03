// AP port profiles, zero touch deployments and RadSec certificate authorities.
// Deployments and certificate authorities run on the clock like the live
// tools; with a frozen clock they finish in the POST. Nothing is deployed:
// a deployment only records the swap it describes.

import { arrayParam, badRequest, notFound, paginate } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { isoMicro } from '../time.js';
import { collection, newId, orgOf } from './common.js';
import { apProfile, profilesOf, wirelessNet } from './wireless.js';
import { wirelessNetIn } from './wirelesslocation.js';

const PROFILES = '/networks/{networkId}/wireless/ethernet/ports/profiles';
const MAX_PROFILES = 64;
const MAX_PORTS = 8;
const MAX_USB_PORTS = 2;
const MAX_DEPLOYMENTS = 1000;
// Seconds a deployment waits for its device, then runs.
const READY = 60;
const RUNNING = 240;
// Seconds a certificate authority takes to generate.
const GENERATING = 60;

const rand = (ctx, kind, id) => new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${id}`));

// ── AP port profiles ──

// Every network starts with one default profile; each port is on SSID 1.
function portsOf(net) {
  if (net.wirelessPortProfiles) return net.wirelessPortProfiles;
  const ports = [1, 2].map((number) => ({ name: `port ${number}`, enabled: true, ssid: 1, pskGroupId: null }));
  return (net.wirelessPortProfiles = { created: 1, list: [{ profileId: '1001', name: 'Default', isDefault: true, ports, usbPorts: [{ name: 'usb port', enabled: false, ssid: 1 }] }], assignments: [] });
}

const portJson = (p, number) => ({ name: p.name, number, enabled: p.enabled, ssid: p.ssid, ...(p.pskGroupId != null ? { pskGroupId: p.pskGroupId } : {}) });

const profileJson = (x) => ({ profileId: x.profileId, name: x.name, isDefault: x.isDefault, ports: x.ports.map((p, i) => portJson(p, i + 1)), usbPorts: x.usbPorts.map((p) => ({ ...p })) });

function checkSsid(ssid, field) {
  if (ssid != null && (!Number.isInteger(ssid) || ssid < 0 || ssid > 14)) throw badRequest(`'${field}' must be an SSID number between 0 and 14`);
}

function checkPorts(list, field, max) {
  if (list == null) return;
  if (list.length > max) throw badRequest(`'${field}' is limited to ${max} ports`);
  list.forEach((p, i) => {
    if (typeof p.name !== 'string' || !p.name.trim()) throw badRequest(`'${field}[${i}].name' must not be empty`);
    checkSsid(p.ssid, `${field}[${i}].ssid`);
  });
}

function applyProfile(x, b) {
  if (b.name != null) x.name = b.name;
  if (b.ports != null) x.ports = b.ports.map((p) => ({ name: p.name, enabled: p.enabled ?? true, ssid: p.ssid ?? 0, pskGroupId: p.pskGroupId ?? null }));
  if (b.usbPorts != null) x.usbPorts = b.usbPorts.map((p) => ({ name: p.name, enabled: p.enabled ?? true, ssid: p.ssid ?? 0 }));
}

const profileOf = (net, id) => {
  const x = portsOf(net).list.find((p) => p.profileId === id);
  if (!x) throw badRequest(`AP port profile '${id}' not found in this network`);
  return x;
};

const profiles = collection({
  ops: { list: 'getNetworkWirelessEthernetPortsProfiles', create: 'createNetworkWirelessEthernetPortsProfile', get: 'getNetworkWirelessEthernetPortsProfile', update: 'updateNetworkWirelessEthernetPortsProfile', delete: 'deleteNetworkWirelessEthernetPortsProfile' },
  path: PROFILES,
  param: 'profileId',
  key: 'profileId',
  parent: wirelessNet,
  store: portsOf,
  what: 'AP port profile',
  nextId: (ctx, store) => String(1000 + ++store.created),
  max: MAX_PROFILES,
  required: ['name', 'ports'],
  check: (ctx, net, b) => {
    checkPorts(b.ports, 'ports', MAX_PORTS);
    checkPorts(b.usbPorts, 'usbPorts', MAX_USB_PORTS);
  },
  blank: () => ({ name: null, isDefault: false, ports: [], usbPorts: [] }),
  apply: applyProfile,
  json: profileJson,
  inUse: (x) => (x.isDefault ? 'The default AP port profile cannot be deleted' : undefined),
  missing: { profileId: '1284392014819', status: 404 },
});

// APs assigned to a deleted profile fall back to the default.
function deleteProfile(ctx) {
  const { parent: net } = profiles.find(ctx);
  const del = profiles.routes.find((r) => r.method === 'DELETE').handler(ctx);
  const store = portsOf(net);
  store.assignments = store.assignments.filter((a) => store.list.some((p) => p.profileId === a.profileId));
  return del;
}

function assignProfile(ctx) {
  const net = wirelessNet(ctx);
  const b = ctx.body;
  if (typeof b.profileId !== 'string') throw badRequest("'profileId' is required");
  if (!b.serials?.length) throw badRequest("'serials' must name at least one access point");
  const x = profileOf(net, b.profileId);
  const aps = [...new Set(b.serials)].map((s) => {
    const ap = net.aps.find((d) => d.serial === s);
    if (!ap) throw badRequest(`'${s}' is not an access point in this network`);
    return ap;
  });
  const store = portsOf(net);
  store.assignments = store.assignments.filter((a) => !aps.includes(a.ap));
  if (!x.isDefault) for (const ap of aps) store.assignments.push({ ap, profileId: x.profileId });
  return { serials: aps.map((ap) => ap.serial), profileId: x.profileId };
}

function setDefault(ctx) {
  const net = wirelessNet(ctx);
  const id = ctx.body.profileId;
  if (typeof id !== 'string') throw badRequest("'profileId' is required");
  const x = profileOf(net, id);
  const store = portsOf(net);
  for (const p of store.list) p.isDefault = p === x;
  store.assignments = store.assignments.filter((a) => a.profileId !== x.profileId);
  return { profileId: x.profileId };
}

// ── Zero touch deployments ──

const deploymentsOf = (org) => (org.wirelessDeployments ??= { created: 0, list: [] });

function deploymentStatus(x, now) {
  if (now < x.start) return 'ready';
  if (now < x.end) return 'in progress';
  return 'completed';
}

const rfJson = (rf) => (rf ? { id: rf.id, name: rf.name } : undefined);
const deviceJson = (d) => {
  const { rfProfile, ...rest } = d;
  return rfProfile ? { ...rest, rfProfile: rfJson(rfProfile) } : rest;
};

function deploymentJson(ctx, org, x) {
  const status = deploymentStatus(x, ctx.now);
  const net = x.networkId && org.networks.find((n) => n.id === x.networkId);
  const changed = Math.max(x.updated, status === 'ready' ? x.created : status === 'in progress' ? x.start : x.end);
  return {
    deploymentId: x.deploymentId,
    devices: { ...(x.old ? { old: deviceJson(x.old) } : {}), new: deviceJson(x.new) },
    status,
    type: x.type,
    ...(net ? { network: { id: net.id, name: net.name } } : {}),
    createdAt: isoMicro(x.created),
    requestedAt: isoMicro(x.created),
    lastUpdatedAt: isoMicro(changed),
    ...(status === 'completed' ? { completedAt: isoMicro(x.end) } : {}),
    errors: [],
  };
}

function rfProfileIn(net, rf, field) {
  if (rf?.id == null) return null;
  if (!net) throw badRequest(`'${field}.rfProfile' needs a network`);
  const p = profilesOf(net).find((r) => r.id === rf.id);
  if (!p) throw badRequest(`RF profile '${rf.id}' not found in network '${net.id}'`);
  return { id: p.id, name: p.name };
}

// Works out one item of a create or update body; `self` is the deployment an
// update changes. Nothing is stored here.
function checkDeployment(ctx, org, item, i, self, taken) {
  const at = `items[${i}]`;
  if (!['deploy', 'replace'].includes(item.type)) throw badRequest(`'${at}.type' must be 'deploy' or 'replace'`);
  if (!['ready', 'in progress', 'completed', 'failed'].includes(item.status)) throw badRequest(`'${at}.status' must be one of: ready, in progress, completed, failed`);
  const nd = item.devices?.new;
  if (typeof nd?.serial !== 'string') throw badRequest(`'${at}.devices.new.serial' is required`);
  const spare = org.spares.find((d) => d.serial === nd.serial);
  if (!spare || spare.productType !== 'wireless') throw badRequest(`'${nd.serial}' is not an access point in this organization's inventory`);
  if (taken.has(nd.serial) || deploymentsOf(org).list.some((x) => x !== self && x.new.serial === nd.serial && deploymentStatus(x, ctx.now) !== 'completed')) throw badRequest(`'${nd.serial}' already has a zero touch deployment`);
  taken.add(nd.serial);
  let old = null;
  let ap = null;
  const od = item.devices.old;
  if (item.type === 'replace') {
    if (typeof od?.serial !== 'string') throw badRequest(`'${at}.devices.old.serial' is required for a replace`);
    ap = org.devices.find((d) => d.serial === od.serial && d.productType === 'wireless');
    if (!ap) throw badRequest(`'${od.serial}' is not an access point in this organization`);
  } else if (od?.serial != null) {
    throw badRequest(`'${at}.devices.old' only applies to a replace`);
  }
  const net = item.network?.id != null ? wirelessNetIn(org, item.network.id) : (ap?.net ?? null);
  if (ap && ap.net !== net) throw badRequest(`'${od.serial}' is not in network '${net.id}'`);
  if (ap) {
    const rf = apProfile(ap);
    old = { serial: ap.serial, afterAction: od.afterAction ?? 'unclaim', name: ap.name ?? ap.serial, model: ap.model, mac: ap.mac, tags: [...ap.tags], rfProfile: { id: rf.id, name: rf.name } };
  }
  const rfProfile = rfProfileIn(net, nd.rfProfile, `${at}.devices.new`);
  const fresh = { serial: spare.serial, name: nd.name || spare.name || spare.serial, model: spare.model, mac: spare.mac, tags: nd.tags ?? [...spare.tags], rfProfile };
  return { type: item.type, old, new: fresh, networkId: net?.id ?? null };
}

function checkItems(ctx, org, items, selves) {
  if (!items?.length) throw badRequest("'items' must hold at least one deployment");
  const taken = new Set();
  return items.map((item, i) => checkDeployment(ctx, org, item, i, selves?.[i] ?? null, taken));
}

const itemsJson = (ctx, org, list) => ({ items: list.map((x) => deploymentJson(ctx, org, x)), meta: { counts: { items: { total: list.length, remaining: 0 } } } });

function createDeployments(ctx) {
  const org = orgOf(ctx);
  const store = deploymentsOf(org);
  const items = ctx.body.items;
  if (store.list.length + (items?.length ?? 0) > MAX_DEPLOYMENTS) throw badRequest(`Organizations are limited to ${MAX_DEPLOYMENTS} zero touch deployments in the emulator`);
  const checked = checkItems(ctx, org, items);
  const now = ctx.now;
  const made = checked.map((c) => {
    const x = { deploymentId: newId(ctx, store, 'wirelessDeployment', org.id, 'deploymentId'), ...c, created: now, updated: now, start: ctx.frozen ? now : now + READY, end: ctx.frozen ? now : now + READY + RUNNING };
    store.list.push(x);
    return x;
  });
  return itemsJson(ctx, org, made);
}

function updateDeployments(ctx) {
  const org = orgOf(ctx);
  const store = deploymentsOf(org);
  const items = ctx.body.items ?? [];
  const selves = items.map((item, i) => {
    const x = store.list.find((d) => d.deploymentId === item.deploymentId);
    if (!x) throw badRequest(`'items[${i}].deploymentId' must name a zero touch deployment in this organization`);
    return x;
  });
  if (new Set(selves).size < selves.length) throw badRequest("'items' names a deployment more than once");
  const checked = checkItems(ctx, org, items, selves);
  selves.forEach((x, i) => Object.assign(x, checked[i], { updated: ctx.now }));
  return itemsJson(ctx, org, selves);
}

const SORTS = {
  afterAction: (x) => x.old?.afterAction ?? '',
  createdAt: (x) => x.created,
  deploymentId: (x) => x.deploymentId,
  name: (x) => x.new.name,
};

function listDeployments(ctx) {
  const org = orgOf(ctx);
  const q = ctx.query;
  const sortBy = q.get('sortBy') || 'status';
  if (sortBy !== 'status' && !SORTS[sortBy]) throw badRequest("'sortBy' must be one of: afterAction, createdAt, deploymentId, name, status");
  const order = q.get('sortOrder') || 'asc';
  if (order !== 'asc' && order !== 'desc') throw badRequest("'sortOrder' must be 'asc' or 'desc'");
  const type = q.get('deploymentType');
  if (type && type !== 'deploy' && type !== 'replace') throw badRequest("'deploymentType' must be 'deploy' or 'replace'");
  const search = q.get('search')?.toLowerCase();
  const keyOf = sortBy === 'status' ? (x) => deploymentStatus(x, ctx.now) : SORTS[sortBy];
  const fields = (x) => [x.new.mac, x.new.serial, x.new.name, x.new.model, x.old?.name, x.old?.serial, x.old?.mac, x.old?.model];
  const list = deploymentsOf(org)
    .list.filter((x) => (!type || x.type === type) && (!search || fields(x).some((f) => f?.toLowerCase().includes(search))))
    .map((x) => [keyOf(x), x])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x.deploymentId < y.deploymentId ? -1 : 1))
    .map(([, x]) => x);
  if (order === 'desc') list.reverse();
  const page = paginate(ctx, list, (x) => x.deploymentId, { def: 20, max: 1000 });
  const end = page.length ? list.indexOf(page[page.length - 1]) + 1 : list.length;
  // The spec wraps the page in a one-item array.
  return [{ items: page.map((x) => deploymentJson(ctx, org, x)), meta: { counts: { items: { total: list.length, remaining: list.length - end } } } }];
}

function deleteDeployment(ctx) {
  const store = deploymentsOf(orgOf(ctx));
  const x = store.list.find((d) => d.deploymentId === ctx.params.deploymentId);
  if (!x) throw notFound('Zero touch deployment');
  store.list.splice(store.list.indexOf(x), 1);
}

// ── RadSec certificate authorities ──

const radsecOf = (org) => (org.wirelessRadsec ??= { created: 0, list: [] });

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// A PEM-shaped block of seeded characters. It is not a real certificate.
function pem(r, label, length) {
  const body = r.chars(length, B64);
  const lines = body.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

const generated = (ca, now) => now >= ca.end;

function caJson(ctx, org, ca) {
  const done = generated(ca, ctx.now);
  return { certificateAuthorityId: ca.certificateAuthorityId, status: done ? ca.status : 'generating', contents: done ? pem(rand(ctx, 'radsecCa', `${org.id}:${ca.certificateAuthorityId}`), 'CERTIFICATE', 1300) : null };
}

const caFilter = (ctx, org) => {
  const ids = arrayParam(ctx.query, 'certificateAuthorityIds');
  return radsecOf(org).list.filter((ca) => !ids.length || ids.includes(ca.certificateAuthorityId));
};

const counted = (items) => ({ items, meta: { counts: { items: { total: items.length, remaining: 0 } } } });

// One CA per organization: a second create answers the one already there.
function createAuthority(ctx) {
  const org = orgOf(ctx);
  const store = radsecOf(org);
  if (store.list.length) return caJson(ctx, org, store.list[0]);
  store.created++;
  const id = rand(ctx, 'radsecCaId', `${org.id}:${store.created}`).digits(4);
  const ca = { certificateAuthorityId: id, status: 'untrusted', end: ctx.frozen ? ctx.now : ctx.now + GENERATING };
  store.list.push(ca);
  return caJson(ctx, org, ca);
}

function updateAuthority(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  if (b.status !== 'trusted') throw badRequest("'status' must be 'trusted'");
  if (typeof b.certificateAuthorityId !== 'string') throw badRequest("'certificateAuthorityId' is required");
  const ca = radsecOf(org).list.find((x) => x.certificateAuthorityId === b.certificateAuthorityId);
  if (!ca) throw notFound('Certificate authority');
  if (!generated(ca, ctx.now)) throw badRequest('The certificate authority has not been generated yet');
  ca.status = 'trusted';
  return caJson(ctx, org, ca);
}

// Nothing is revoked, so each generated CA has an empty CRL and delta CRL.
function crls(ctx, kind, label) {
  const org = orgOf(ctx);
  const list = caFilter(ctx, org).filter((ca) => generated(ca, ctx.now));
  return counted(list.map((ca) => ({ certificateAuthorityId: ca.certificateAuthorityId, crl: pem(rand(ctx, kind, `${org.id}:${ca.certificateAuthorityId}`), label, 120) })));
}

export default [
  ...profiles.routes.filter((r) => r.method !== 'DELETE'),
  { op: 'deleteNetworkWirelessEthernetPortsProfile', method: 'DELETE', path: `${PROFILES}/{profileId}`, handler: deleteProfile },
  { op: 'assignNetworkWirelessEthernetPortsProfiles', method: 'POST', path: `${PROFILES}/assign`, handler: assignProfile },
  { op: 'setNetworkWirelessEthernetPortsProfilesDefault', method: 'POST', path: `${PROFILES}/setDefault`, status: 200, handler: setDefault },
  { op: 'getOrganizationWirelessDevicesProvisioningDeployments', path: '/organizations/{organizationId}/wireless/devices/provisioning/deployments', handler: listDeployments },
  { op: 'createOrganizationWirelessDevicesProvisioningDeployment', method: 'POST', path: '/organizations/{organizationId}/wireless/devices/provisioning/deployments', handler: createDeployments },
  { op: 'updateOrganizationWirelessDevicesProvisioningDeployments', method: 'PUT', path: '/organizations/{organizationId}/wireless/devices/provisioning/deployments', handler: updateDeployments },
  { op: 'deleteOrganizationWirelessDevicesProvisioningDeployment', method: 'DELETE', path: '/organizations/{organizationId}/wireless/devices/provisioning/deployments/{deploymentId}', handler: deleteDeployment },
  { op: 'getOrganizationWirelessDevicesRadsecCertificatesAuthorities', path: '/organizations/{organizationId}/wireless/devices/radsec/certificates/authorities', handler: (ctx) => [counted(caFilter(ctx, orgOf(ctx)).map((ca) => caJson(ctx, orgOf(ctx), ca)))] },
  { op: 'updateOrganizationWirelessDevicesRadsecCertificatesAuthorities', method: 'PUT', path: '/organizations/{organizationId}/wireless/devices/radsec/certificates/authorities', handler: updateAuthority },
  { op: 'createOrganizationWirelessDevicesRadsecCertificatesAuthority', method: 'POST', path: '/organizations/{organizationId}/wireless/devices/radsec/certificates/authorities', status: 202, handler: createAuthority },
  { op: 'getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrls', path: '/organizations/{organizationId}/wireless/devices/radsec/certificates/authorities/crls', handler: (ctx) => crls(ctx, 'radsecCrl', 'X509 CRL') },
  { op: 'getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrlsDeltas', path: '/organizations/{organizationId}/wireless/devices/radsec/certificates/authorities/crls/deltas', handler: (ctx) => crls(ctx, 'radsecCrlDelta', 'X509 CRL') },
];
