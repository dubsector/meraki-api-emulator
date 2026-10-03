// VLAN profiles: named VLANs and VLAN groups for a network's switches and
// APs. Every network starts with a default profile, built on first read.
// A device names its profile by iname in dev.vlanProfile (none means the
// default), so assignments stay with the device through swaps and splits.

import { stored } from '../config.js';
import { arrayParam, badRequest, paginate } from '../http.js';
import { checkGroupId } from './adaptivepolicy.js';
import { collection, netOf } from './common.js';

const LIST = '/networks/{networkId}/vlanProfiles';
const MAX_PROFILES = 100;
const MAX_VLANS = 1024;
const PRODUCTS = ['switch', 'wireless'];
const INAME = /^[A-Za-z0-9_-]{1,255}$/;

const DEFAULT = () => ({ iname: 'Default', name: 'Default Profile', isDefault: true, vlanNames: [{ name: 'default', vlanId: '1' }], vlanGroups: [] });

function vlanNet(ctx) {
  const net = netOf(ctx);
  if (!PRODUCTS.some((p) => net.productTypes.includes(p))) throw badRequest('VLAN profiles need a network with switches or wireless');
  return net;
}

export const profilesOf = (net) => stored(net, 'switchVlanProfiles', () => ({ list: [DEFAULT()] }));

// A device's profile; a gone iname reads as the default.
function profileOfDevice(net, dev) {
  const list = profilesOf(net).list;
  return list.find((p) => p.iname === dev.vlanProfile) ?? list.find((p) => p.isDefault);
}

const vlanId = (v) => /^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= 4094;

// "2,5-7": IDs and ranges from 1 to 4094.
function isVlanList(v) {
  return v.split(',').every((part) => {
    const m = /^\s*(\d{1,4})(?:-(\d{1,4}))?\s*$/.exec(part);
    return !!m && vlanId(m[1]) && (m[2] == null || (vlanId(m[2]) && Number(m[2]) >= Number(m[1])));
  });
}

function checkName(v, at, max) {
  if (typeof v !== 'string' || v.length < 1 || v.length > max) throw badRequest(`'${at}' must be from 1 to ${max} characters`);
}

function checkProfile(ctx, net, b) {
  checkName(b.name, 'name', 255);
  if (b.vlanNames.length + b.vlanGroups.length > MAX_VLANS) throw badRequest(`A VLAN profile can hold at most ${MAX_VLANS} named VLANs and groups`);
  const ids = new Set();
  const vlanNames = b.vlanNames.map((v, i) => {
    const at = `vlanNames[${i}]`;
    checkName(v.name, `${at}.name`, 32);
    if (typeof v.vlanId !== 'string' || !vlanId(v.vlanId)) throw badRequest(`'${at}.vlanId' must be a VLAN ID from 1 to 4094`);
    if (ids.has(Number(v.vlanId))) throw badRequest(`VLAN ${v.vlanId} is named more than once`);
    ids.add(Number(v.vlanId));
    const group = v.adaptivePolicyGroup?.id;
    checkGroupId(net.org, ctx.now, group, `${at}.adaptivePolicyGroup.id`);
    return { name: v.name, vlanId: String(Number(v.vlanId)), ...(group != null ? { adaptivePolicyGroupId: String(group) } : {}) };
  });
  const names = new Set();
  const vlanGroups = b.vlanGroups.map((g, i) => {
    const at = `vlanGroups[${i}]`;
    checkName(g.name, `${at}.name`, 32);
    if (names.has(g.name)) throw badRequest(`A VLAN group named '${g.name}' is listed more than once`);
    names.add(g.name);
    if (typeof g.vlanIds !== 'string' || !isVlanList(g.vlanIds)) throw badRequest(`'${at}.vlanIds' must list VLAN IDs or ranges from 1 to 4094, such as 2,5-7`);
    return { name: g.name, vlanIds: g.vlanIds.replace(/\s+/g, '') };
  });
  return { vlanNames, vlanGroups };
}

function profileJson(p, net) {
  const groups = net.org.adaptivePolicyGroups?.list ?? [];
  return {
    iname: p.iname,
    name: p.name,
    isDefault: p.isDefault,
    vlanNames: p.vlanNames.map((v) => {
      const g = groups.find((x) => x.groupId === v.adaptivePolicyGroupId);
      return { name: v.name, vlanId: v.vlanId, adaptivePolicyGroup: g ? { id: g.groupId, name: g.name } : null };
    }),
    vlanGroups: p.vlanGroups.map((g) => ({ ...g })),
  };
}

// Devices of the network a profile can apply to.
const vlanDevices = (net) => net.devices.filter((d) => PRODUCTS.includes(d.productType));

const profiles = collection({
  ops: { list: 'getNetworkVlanProfiles', create: 'createNetworkVlanProfile', get: 'getNetworkVlanProfile', update: 'updateNetworkVlanProfile', delete: 'deleteNetworkVlanProfile' },
  path: LIST,
  param: 'iname',
  key: 'iname',
  parent: vlanNet,
  store: profilesOf,
  what: 'VLAN profile',
  nextId: (ctx) => ctx.body.iname,
  max: MAX_PROFILES,
  required: ['name', 'vlanNames', 'vlanGroups', 'iname'],
  check: (ctx, net, b, self) => {
    if (!self) {
      if (typeof b.iname !== 'string' || !INAME.test(b.iname)) throw badRequest("'iname' must be 1 to 255 letters, digits, hyphens or underscores");
      if (profilesOf(net).list.some((p) => p.iname.toLowerCase() === b.iname.toLowerCase())) throw badRequest(`A VLAN profile with iname '${b.iname}' already exists in this network`);
    }
    return checkProfile(ctx, net, b);
  },
  blank: () => ({ isDefault: false }),
  apply: (p, b, net, ctx, checked) => Object.assign(p, { name: b.name, ...checked }),
  json: profileJson,
  inUse: (p, net) => {
    if (p.isDefault) return 'The default VLAN profile cannot be deleted';
    const devs = vlanDevices(net).filter((d) => d.vlanProfile === p.iname);
    if (devs.length) return `VLAN profile '${p.iname}' is assigned to ${devs.map((d) => d.serial).join(', ')}`;
  },
  missing: { iname: 'NoSuchProfile', status: 404 },
});

// ── Assignments ──

function byDevice(ctx) {
  const net = vlanNet(ctx);
  const q = ctx.query;
  const serials = arrayParam(q, 'serials');
  const types = arrayParam(q, 'productTypes');
  const bad = types.find((t) => !PRODUCTS.includes(t));
  if (bad) throw badRequest(`'productTypes' must be switch or wireless, not '${bad}'`);
  const stackIds = arrayParam(q, 'stackIds');
  const stacks = net.switchStacks?.list ?? [];
  const stackOf = (d) => stacks.find((s) => s.members.includes(d));
  const rows = vlanDevices(net)
    .filter((d) => (!serials.length || serials.includes(d.serial)) && (!types.length || types.includes(d.productType)))
    .filter((d) => !stackIds.length || stackIds.includes(stackOf(d)?.id))
    .sort((a, b) => (a.serial < b.serial ? -1 : 1));
  return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 }).map((d) => {
    const p = profileOfDevice(net, d);
    const stack = stackOf(d);
    return {
      name: d.name,
      serial: d.serial,
      mac: d.mac,
      productType: d.productType,
      configurationSource: 'Cloud',
      vlanProfile: { iname: p.iname, name: p.name, isDefault: p.isDefault },
      stack: stack ? { id: stack.id } : null,
    };
  });
}

// Stacks take the profile on every member. Every serial and stack is checked first.
function reassign(ctx) {
  const net = vlanNet(ctx);
  const b = ctx.body;
  const iname = b.vlanProfile?.iname;
  const list = profilesOf(net).list;
  const profile = iname == null ? list.find((p) => p.isDefault) : list.find((p) => p.iname === iname);
  if (!profile) throw badRequest(`'vlanProfile.iname' names VLAN profile '${iname}', which doesn't exist in this network`);
  if (!b.serials.length && !b.stackIds.length) throw badRequest("'serials' or 'stackIds' must name at least one device");
  const devs = b.serials.map((serial) => {
    const d = vlanDevices(net).find((x) => x.serial === serial);
    if (!d) throw badRequest(`'${serial}' is not a switch or AP in this network`);
    return d;
  });
  const stacks = net.switchStacks?.list ?? [];
  for (const id of b.stackIds) {
    const s = stacks.find((x) => x.id === id);
    if (!s) throw badRequest(`Switch stack '${id}' is not in this network`);
    devs.push(...s.members.filter((d) => net.switches.includes(d)));
  }
  for (const d of devs) {
    if (profile.isDefault) delete d.vlanProfile;
    else d.vlanProfile = profile.iname;
  }
  return { vlanProfile: { iname: profile.iname, name: profile.name }, serials: [...b.serials], stackIds: [...b.stackIds] };
}

export default [
  ...profiles.routes.map((r) => (r.method === 'POST' ? { ...r, status: 200 } : r)),
  { op: 'getNetworkVlanProfilesAssignmentsByDevice', path: `${LIST}/assignments/byDevice`, handler: byDevice },
  { op: 'reassignNetworkVlanProfilesAssignments', method: 'POST', status: 200, path: `${LIST}/assignments/reassign`, handler: reassign },
];

