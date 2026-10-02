// MX security appliance configuration: LAN ports, VLANs, firewall, NAT, VPN
// and threat protection, plus the device-level uplink and DHCP views.

import { CF_CATEGORIES, L7_CATEGORIES } from '../catalog.js';
import { DEFAULT_RULE, configOf, uuid } from '../config.js';
import { arrayParam, badRequest, notFound } from '../http.js';
import { derive, hashStr, unit } from '../rng.js';
import { isDown } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { DAY } from '../time.js';
import { ipInCidr, merge, parseCidr } from '../validate.js';
import { bySerial, devOf, netOf, orgOf, requireModel, requireProduct } from './common.js';

const MAX_ITEMS = 1000;
const SERVICES = ['ICMP', 'SNMP', 'web'];

function mxConfig(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'appliance');
  return configOf(net);
}

function limit(list, what) {
  if (list.length > MAX_ITEMS) throw badRequest(`${what} are limited to ${MAX_ITEMS} in the emulator`);
  return list;
}

// ── LAN ports ──

// Port config only; the API has no live MX port state. Port 3 trunks to the
// core switch, the rest get a seeded mix of access, trunk and disabled.
function appliancePorts(net) {
  requireProduct(net, 'appliance');
  if (!net.mx) return [];
  const [first, last] = net.mx.info.lan;
  const vlans = [...new Set(net.clients.map((c) => c.vlan))].sort((a, b) => a - b);
  const key = derive(net.mx.key, 'lan');
  const overrides = configOf(net).portOverrides || {};
  const ports = [];
  for (let n = first; n <= last; n++) {
    const port = { number: n, enabled: true, type: 'trunk', dropUntaggedTraffic: false, vlan: 1, allowedVlans: 'all' };
    const u = unit(key, n);
    if (n === 3 && net.switches.length) {
      // uplink to the core switch keeps the defaults
    } else if (u < 0.25) {
      Object.assign(port, { type: 'access', vlan: vlans[Math.floor(unit(key, n + 1000) * vlans.length)], accessPolicy: 'open' });
    } else if (u < 0.45) {
      port.allowedVlans = [1, ...vlans].join(',');
    } else {
      port.enabled = false;
    }
    ports.push(merge({ ...port, sgt: { id: null, enabled: false } }, overrides[n] || {}));
  }
  return ports;
}

function portOf(net, portId) {
  const port = appliancePorts(net).find((p) => String(p.number) === portId);
  if (!port) throw notFound('Port');
  return port;
}

// The org-wide port view: one WAN port per uplink, then the LAN ports. Where
// an uplink lands on a LAN port (the MX67's port 2), that port is flexible.
function interfacePorts(mx) {
  const iface = (n) => ({ name: `GigabitEthernet0/0/${n}`, slot: 0, subslot: 0, number: n });
  const lan = appliancePorts(mx.net);
  const wan = mx.uplinks.map((u, i) => ({
    number: String(i + 1),
    interface: iface(i + 1),
    enabled: true,
    name: u.interface,
    personality: { mode: 'wan', isFlexible: lan.some((p) => p.number === i + 1), layer: { mode: 3, isFlexible: false } },
    uplink: { type: 'ethernet', primary: i === 0 },
  }));
  const downlink = (p) => {
    const out = { mode: p.type, sgt: { id: p.sgt?.id == null ? null : String(p.sgt.id) } };
    if (p.type === 'access') return { ...out, access: { vlan: String(p.vlan), policy: { type: p.accessPolicy ?? 'open' } } };
    return { ...out, trunk: { nativeVlan: String(p.vlan), allowedVlans: String(p.allowedVlans).split(','), sgt: { enabled: !!p.sgt?.enabled } } };
  };
  return [
    ...wan,
    ...lan
      .filter((p) => p.number > wan.length)
      .map((p) => ({
        number: String(p.number),
        interface: iface(p.number),
        enabled: p.enabled,
        name: `port${p.number}`,
        personality: { mode: 'lan', isFlexible: false, layer: { mode: 2, isFlexible: false } },
        downlink: downlink(p),
      })),
  ];
}

function interfacesByDevice(ctx) {
  const serials = arrayParam(ctx.query, 'serials');
  const numbers = arrayParam(ctx.query, 'numbers');
  const items = orgOf(ctx)
    .devices.filter((d) => d.productType === 'appliance' && (!serials.length || serials.includes(d.serial)))
    .sort(bySerial)
    .map((mx) => ({ serial: mx.serial, ports: interfacePorts(mx).filter((p) => !numbers.length || numbers.includes(p.number)) }));
  return { items };
}

// ── VLANs and addressing ──

function overlaps(a, b) {
  const [na, ba] = parseCidr(a);
  const [nb, bb] = parseCidr(b);
  const size = 2 ** (32 - Math.min(ba, bb));
  return Math.floor(na / size) === Math.floor(nb / size);
}

function checkAddressing(v, others) {
  if (!parseCidr(v.subnet)) throw badRequest("'subnet' must be an IPv4 CIDR such as 192.168.10.0/24");
  if (!ipInCidr(v.applianceIp, v.subnet)) throw badRequest("'applianceIp' must be an address inside 'subnet'");
  for (const o of others) if (overlaps(o.subnet, v.subnet)) throw badRequest(`'subnet' overlaps the subnet of VLAN ${o.id}`);
}

function vlansOf(ctx) {
  const c = mxConfig(ctx);
  if (!c.vlansEnabled) throw badRequest('VLANs are not enabled for this network');
  return c;
}

function vlanOf(c, id) {
  const v = c.vlans.find((x) => x.id === String(id));
  if (!v) throw notFound('VLAN');
  return v;
}

function newVlan(net, id, name, subnet, applianceIp) {
  return {
    id: String(id),
    interfaceId: String(1e12 + derive(net.key, `vlan${id}`)),
    name,
    subnet,
    applianceIp,
    dhcpHandling: 'Run a DHCP server',
    dhcpLeaseTime: '1 day',
    dhcpBootOptionsEnabled: false,
    dhcpOptions: [],
    fixedIpAssignments: {},
    reservedIpRanges: [],
    dnsNameservers: 'upstream_dns',
    mandatoryDhcp: { enabled: false },
    ipv6: { enabled: false },
  };
}

// New VLANs join the site-to-site subnet list turned off, like the Dashboard does.
function createVlan(ctx) {
  const c = vlansOf(ctx);
  const { id, name, subnet, applianceIp, ...rest } = ctx.body;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || n > 4094) throw badRequest("'id' must be a VLAN number from 1 to 4094");
  if (c.vlans.some((v) => v.id === String(n))) throw badRequest(`VLAN ${n} already exists`);
  if (!subnet || !applianceIp) throw badRequest("'subnet' and 'applianceIp' are required");
  const v = merge(newVlan(netOf(ctx), n, name, subnet, applianceIp), rest);
  checkAddressing(v, c.vlans);
  c.vlans.push(v);
  c.vlans.sort((a, b) => Number(a.id) - Number(b.id));
  limit(c.vlans, 'VLANs');
  c.siteToSite.subnets.push({ localSubnet: v.subnet, useVpn: false });
  return v;
}

function updateVlan(ctx) {
  const c = vlansOf(ctx);
  const v = vlanOf(c, ctx.params.vlanId);
  const { id, ...patch } = ctx.body;
  const next = merge(structuredClone(v), patch);
  checkAddressing(next, c.vlans.filter((o) => o !== v));
  const vpn = c.siteToSite.subnets.find((s) => s.localSubnet === v.subnet);
  if (vpn) vpn.localSubnet = next.subnet;
  return Object.assign(v, next);
}

function deleteVlan(ctx) {
  const c = vlansOf(ctx);
  const v = vlanOf(c, ctx.params.vlanId);
  if (c.vlans.length === 1) throw badRequest('A network needs at least one VLAN');
  c.vlans.splice(c.vlans.indexOf(v), 1);
  c.siteToSite.subnets = c.siteToSite.subnets.filter((s) => s.localSubnet !== v.subnet);
}

// Turning VLANs on makes the single LAN VLAN 1; turning them off keeps the
// VLANs for later and moves the first one's addressing to the single LAN.
function setVlansEnabled(ctx) {
  const c = mxConfig(ctx);
  const on = ctx.body.vlansEnabled;
  if (on === true && !c.vlansEnabled) {
    if (!c.vlans.length) {
      c.vlans.push(newVlan(netOf(ctx), 1, 'Default', c.singleLan.subnet, c.singleLan.applianceIp));
      c.siteToSite.subnets = [{ localSubnet: c.singleLan.subnet, useVpn: false }];
    }
  } else if (on === false && c.vlansEnabled && c.vlans.length) {
    Object.assign(c.singleLan, { subnet: c.vlans[0].subnet, applianceIp: c.vlans[0].applianceIp });
  }
  if (on != null) c.vlansEnabled = on;
  return { vlansEnabled: c.vlansEnabled };
}

function singleLanOf(ctx) {
  const c = mxConfig(ctx);
  if (c.vlansEnabled) throw badRequest('Single LAN settings are not available while VLANs are enabled');
  return c.singleLan;
}

function localSubnets(c) {
  return c.vlansEnabled ? c.vlans.map((v) => v.subnet) : [c.singleLan.subnet];
}

// ── Firewall and NAT ──

// The default rule is always last and can't be edited, so clients that send it back have it dropped.
function l3Json(c) {
  return { rules: [...c.l3.rules, { ...DEFAULT_RULE, syslogEnabled: c.l3.syslogDefaultRule }] };
}

function inboundJson(c) {
  return { rules: [...c.inbound.rules, { ...DEFAULT_RULE, syslogEnabled: c.inbound.syslogDefaultRule }], syslogDefaultRule: c.inbound.syslogDefaultRule };
}

function normalizeRules(rules) {
  return limit(rules, 'Rules')
    .filter((r) => r.comment !== DEFAULT_RULE.comment)
    .map((r) => ({ comment: r.comment ?? '', policy: r.policy, protocol: r.protocol, srcPort: r.srcPort ?? 'Any', srcCidr: r.srcCidr ?? 'Any', destPort: r.destPort ?? 'Any', destCidr: r.destCidr ?? 'Any', syslogEnabled: r.syslogEnabled ?? false }));
}

function putRuleSet(set, body) {
  if (body.rules) set.rules = normalizeRules(body.rules);
  if (body.syslogDefaultRule != null) set.syslogDefaultRule = body.syslogDefaultRule;
}

function firewalledService(c, name) {
  const s = c.firewalledServices.find((x) => x.service === name);
  if (!s) throw notFound(`Service (use one of ${SERVICES.join(', ')})`);
  return s;
}

// Next hops have to sit on one of the network's own subnets.
function checkRoute(c, r) {
  if (!parseCidr(r.subnet)) throw badRequest("'subnet' must be an IPv4 CIDR such as 10.100.0.0/16");
  if (!localSubnets(c).some((s) => ipInCidr(r.gatewayIp, s))) throw badRequest("'gatewayIp' must be inside one of the network's subnets");
  if (r.gatewayVlanId != null && !c.vlans.some((v) => v.id === String(r.gatewayVlanId))) throw badRequest(`VLAN ${r.gatewayVlanId} does not exist`);
}

function routeOf(c, id) {
  const r = c.staticRoutes.find((x) => x.id === id);
  if (!r) throw notFound('Static route');
  return r;
}

function updateSiteToSite(ctx) {
  const net = netOf(ctx);
  const c = mxConfig(ctx);
  const b = ctx.body;
  const s2s = c.siteToSite;
  if (b.hubs) {
    for (const h of b.hubs) {
      const hub = net.org.networks.find((n) => n.id === h.hubId);
      if (!hub || hub === net || !hub.productTypes.includes('appliance')) throw badRequest(`Hub ${h.hubId} is not an appliance network in this organization`);
    }
  }
  const mode = b.mode;
  const hubs = mode === 'spoke' ? (b.hubs ?? s2s.hubs) : [];
  if (mode === 'spoke' && !hubs.length) throw badRequest('A spoke needs at least one hub');
  const local = localSubnets(c);
  for (const s of b.subnets || []) {
    if (!local.includes(s.localSubnet)) throw badRequest(`${s.localSubnet} is not one of this network's subnets`);
    const cur = s2s.subnets.find((x) => x.localSubnet === s.localSubnet);
    if (cur) merge(cur, s);
    else s2s.subnets.push({ useVpn: false, ...s });
  }
  Object.assign(s2s, { mode, hubs: hubs.map((h) => ({ hubId: h.hubId, useDefaultRoute: h.useDefaultRoute ?? false })) });
  if (b.subnet) merge(s2s.subnet, b.subnet);
  if (b.sgt) merge(s2s.sgt, b.sgt);
  return s2s;
}

// PUT takes category IDs; GET shows each with its name.
function categoryOf(id) {
  const known = CF_CATEGORIES.find((c) => c.id === id);
  return known ? { ...known } : { id, name: `Category ${id.split('/').pop()}` };
}

// ── Device level ──

function hostCount(cidr) {
  return 2 ** (32 - Number(cidr.split('/')[1])) - 2;
}

// Leases last a day, so a lease is in use if the client was seen in the last day.
function dhcpSubnets(dev, now) {
  const net = dev.net;
  return configOf(net).vlans.map((v) => {
    const id = Number(v.id);
    let used = net.clients.filter((c) => c.vlan === id && presenceIn(c, now - DAY, now)).length;
    if (id === 1) used += net.devices.filter((d) => d !== dev && !isDown(d, now)).length;
    const reserved = v.reservedIpRanges.length ? 8 : 0;
    return { subnet: v.subnet, vlanId: id, usedCount: used, freeCount: Math.max(0, hostCount(v.subnet) - 1 - reserved - used) };
  });
}

function uplinkSettings(mx) {
  const iface = (u) => {
    if (!u) return { enabled: false, vlanTagging: { enabled: false }, svis: { ipv4: { assignmentMode: 'dynamic' }, ipv6: { assignmentMode: 'dynamic' } }, pppoe: { enabled: false } };
    const nameservers = { addresses: ['8.8.8.8', '1.1.1.1'] };
    const ipv4 = u.isp === 'fiber' ? { assignmentMode: 'static', address: `${u.publicIp}/24`, gateway: u.gateway, nameservers } : { assignmentMode: 'dynamic', nameservers };
    return { enabled: true, vlanTagging: { enabled: false }, svis: { ipv4, ipv6: { assignmentMode: 'dynamic' } }, pppoe: { enabled: false } };
  };
  return (mx.uplinkSettings ??= { interfaces: { wan1: iface(mx.uplinks[0]), wan2: iface(mx.uplinks[1]) } });
}

function mxDevice(ctx) {
  const dev = devOf(ctx);
  requireModel(dev, 'appliance');
  return dev;
}

// GET and PUT on a settings object that PUT merges into.
const settings = (name, path, pick, after) => [
  { op: `getNetworkAppliance${name}`, path: `/networks/{networkId}/appliance/${path}`, handler: (ctx) => pick(mxConfig(ctx)) },
  {
    op: `updateNetworkAppliance${name}`,
    method: 'PUT',
    path: `/networks/{networkId}/appliance/${path}`,
    handler: (ctx) => {
      const target = pick(mxConfig(ctx));
      merge(target, ctx.body);
      after?.(target, netOf(ctx));
      return target;
    },
  },
];

export default [
  { op: 'getOrganizationApplianceDevicesInterfacesPortsByDevice', path: '/organizations/{organizationId}/appliance/devices/interfaces/ports/byDevice', handler: interfacesByDevice },
  {
    op: 'getNetworkAppliancePorts',
    path: '/networks/{networkId}/appliance/ports',
    handler: (ctx) => appliancePorts(netOf(ctx)),
  },
  {
    op: 'getNetworkAppliancePort',
    path: '/networks/{networkId}/appliance/ports/{portId}',
    sample: { portId: '3' },
    handler: (ctx) => portOf(netOf(ctx), ctx.params.portId),
  },
  {
    op: 'updateNetworkAppliancePort',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/ports/{portId}',
    handler: (ctx) => {
      const net = netOf(ctx);
      const port = portOf(net, ctx.params.portId);
      const overrides = (configOf(net).portOverrides ??= {});
      overrides[port.number] = merge(overrides[port.number] || {}, ctx.body);
      return portOf(net, ctx.params.portId);
    },
  },
  {
    op: 'getNetworkApplianceVlans',
    path: '/networks/{networkId}/appliance/vlans',
    handler: (ctx) => vlansOf(ctx).vlans,
  },
  { op: 'createNetworkApplianceVlan', method: 'POST', path: '/networks/{networkId}/appliance/vlans', handler: createVlan },
  { op: 'getNetworkApplianceVlansSettings', path: '/networks/{networkId}/appliance/vlans/settings', handler: (ctx) => ({ vlansEnabled: mxConfig(ctx).vlansEnabled }) },
  { op: 'updateNetworkApplianceVlansSettings', method: 'PUT', path: '/networks/{networkId}/appliance/vlans/settings', handler: setVlansEnabled },
  {
    op: 'getNetworkApplianceVlan',
    path: '/networks/{networkId}/appliance/vlans/{vlanId}',
    sample: { vlanId: '10' },
    handler: (ctx) => vlanOf(vlansOf(ctx), ctx.params.vlanId),
  },
  { op: 'updateNetworkApplianceVlan', method: 'PUT', path: '/networks/{networkId}/appliance/vlans/{vlanId}', handler: updateVlan },
  { op: 'deleteNetworkApplianceVlan', method: 'DELETE', path: '/networks/{networkId}/appliance/vlans/{vlanId}', handler: deleteVlan },
  {
    op: 'getNetworkApplianceSingleLan',
    path: '/networks/{networkId}/appliance/singleLan',
    // Every seeded MX network uses VLANs, so the example shows the error.
    sample: { status: 400 },
    handler: singleLanOf,
  },
  {
    op: 'updateNetworkApplianceSingleLan',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/singleLan',
    handler: (ctx) => {
      const lan = singleLanOf(ctx);
      const next = merge(structuredClone(lan), ctx.body);
      checkAddressing(next, []);
      return Object.assign(lan, next);
    },
  },
  { op: 'getNetworkApplianceFirewallL3FirewallRules', path: '/networks/{networkId}/appliance/firewall/l3FirewallRules', handler: (ctx) => l3Json(mxConfig(ctx)) },
  {
    op: 'updateNetworkApplianceFirewallL3FirewallRules',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/l3FirewallRules',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      putRuleSet(c.l3, ctx.body);
      return l3Json(c);
    },
  },
  { op: 'getNetworkApplianceFirewallL7FirewallRules', path: '/networks/{networkId}/appliance/firewall/l7FirewallRules', handler: (ctx) => ({ rules: mxConfig(ctx).l7Rules }) },
  {
    op: 'updateNetworkApplianceFirewallL7FirewallRules',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/l7FirewallRules',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      if (ctx.body.rules) c.l7Rules = limit(ctx.body.rules, 'Rules');
      return { rules: c.l7Rules };
    },
  },
  {
    op: 'getNetworkApplianceFirewallL7FirewallRulesApplicationCategories',
    path: '/networks/{networkId}/appliance/firewall/l7FirewallRules/applicationCategories',
    handler: (ctx) => {
      mxConfig(ctx);
      return { applicationCategories: structuredClone(L7_CATEGORIES) };
    },
  },
  { op: 'getNetworkApplianceFirewallInboundFirewallRules', path: '/networks/{networkId}/appliance/firewall/inboundFirewallRules', handler: (ctx) => inboundJson(mxConfig(ctx)) },
  {
    op: 'updateNetworkApplianceFirewallInboundFirewallRules',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/inboundFirewallRules',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      putRuleSet(c.inbound, ctx.body);
      return inboundJson(c);
    },
  },
  { op: 'getNetworkApplianceFirewallPortForwardingRules', path: '/networks/{networkId}/appliance/firewall/portForwardingRules', handler: (ctx) => ({ rules: mxConfig(ctx).portForwarding }) },
  {
    op: 'updateNetworkApplianceFirewallPortForwardingRules',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/portForwardingRules',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      c.portForwarding = limit(ctx.body.rules, 'Rules').map((r) => ({ name: r.name ?? '', lanIp: r.lanIp, allowedIps: r.allowedIps ?? ['any'], protocol: r.protocol, publicPort: r.publicPort, localPort: r.localPort, uplink: r.uplink ?? 'both' }));
      return { rules: c.portForwarding };
    },
  },
  { op: 'getNetworkApplianceFirewallOneToOneNatRules', path: '/networks/{networkId}/appliance/firewall/oneToOneNatRules', handler: (ctx) => ({ rules: mxConfig(ctx).oneToOne }) },
  {
    op: 'updateNetworkApplianceFirewallOneToOneNatRules',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/oneToOneNatRules',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      c.oneToOne = limit(ctx.body.rules, 'Rules').map((r) => ({ name: r.name ?? '', publicIp: r.publicIp, lanIp: r.lanIp, uplink: r.uplink ?? 'internet1', allowedInbound: r.allowedInbound ?? [] }));
      return { rules: c.oneToOne };
    },
  },
  { op: 'getNetworkApplianceFirewallFirewalledServices', path: '/networks/{networkId}/appliance/firewall/firewalledServices', handler: (ctx) => mxConfig(ctx).firewalledServices },
  {
    op: 'getNetworkApplianceFirewallFirewalledService',
    path: '/networks/{networkId}/appliance/firewall/firewalledServices/{service}',
    sample: { service: 'web' },
    handler: (ctx) => firewalledService(mxConfig(ctx), ctx.params.service),
  },
  {
    op: 'updateNetworkApplianceFirewallFirewalledService',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/firewall/firewalledServices/{service}',
    handler: (ctx) => {
      const s = firewalledService(mxConfig(ctx), ctx.params.service);
      const { access, allowedIps } = ctx.body;
      if (access === 'restricted' && !(allowedIps ?? s.allowedIps)?.length) throw badRequest("'allowedIps' is required when access is restricted");
      s.access = access;
      if (access === 'restricted') s.allowedIps = allowedIps ?? s.allowedIps;
      else delete s.allowedIps;
      return s;
    },
  },
  { op: 'getNetworkApplianceStaticRoutes', path: '/networks/{networkId}/appliance/staticRoutes', handler: (ctx) => mxConfig(ctx).staticRoutes },
  {
    op: 'createNetworkApplianceStaticRoute',
    method: 'POST',
    path: '/networks/{networkId}/appliance/staticRoutes',
    handler: (ctx) => {
      const net = netOf(ctx);
      const c = mxConfig(ctx);
      const b = ctx.body;
      const r = { id: uuid(hashStr(net.id), `route:${ctx.world.created++}`), ipVersion: 4, networkId: net.id, enabled: true, name: b.name, subnet: b.subnet, gatewayIp: b.gatewayIp, fixedIpAssignments: {}, reservedIpRanges: [] };
      if (b.gatewayVlanId != null) r.gatewayVlanId = b.gatewayVlanId;
      checkRoute(c, r);
      c.staticRoutes.push(r);
      limit(c.staticRoutes, 'Static routes');
      return r;
    },
  },
  {
    op: 'getNetworkApplianceStaticRoute',
    path: '/networks/{networkId}/appliance/staticRoutes/{staticRouteId}',
    sample: { staticRouteId: (world) => configOf(world.orgs[0].networks[0]).staticRoutes[0].id },
    handler: (ctx) => routeOf(mxConfig(ctx), ctx.params.staticRouteId),
  },
  {
    op: 'updateNetworkApplianceStaticRoute',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/staticRoutes/{staticRouteId}',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      const r = routeOf(c, ctx.params.staticRouteId);
      const next = merge(structuredClone(r), ctx.body);
      checkRoute(c, next);
      return Object.assign(r, next);
    },
  },
  {
    op: 'deleteNetworkApplianceStaticRoute',
    method: 'DELETE',
    path: '/networks/{networkId}/appliance/staticRoutes/{staticRouteId}',
    handler: (ctx) => {
      const c = mxConfig(ctx);
      c.staticRoutes.splice(c.staticRoutes.indexOf(routeOf(c, ctx.params.staticRouteId)), 1);
    },
  },
  { op: 'getNetworkApplianceVpnSiteToSiteVpn', path: '/networks/{networkId}/appliance/vpn/siteToSiteVpn', handler: (ctx) => mxConfig(ctx).siteToSite },
  { op: 'updateNetworkApplianceVpnSiteToSiteVpn', method: 'PUT', path: '/networks/{networkId}/appliance/vpn/siteToSiteVpn', handler: updateSiteToSite },
  { op: 'getNetworkApplianceContentFiltering', path: '/networks/{networkId}/appliance/contentFiltering', handler: (ctx) => mxConfig(ctx).contentFiltering },
  {
    op: 'updateNetworkApplianceContentFiltering',
    method: 'PUT',
    path: '/networks/{networkId}/appliance/contentFiltering',
    handler: (ctx) => {
      const cf = mxConfig(ctx).contentFiltering;
      const { blockedUrlCategories, ...rest } = ctx.body;
      merge(cf, rest);
      if (blockedUrlCategories) cf.blockedUrlCategories = blockedUrlCategories.map(categoryOf);
      return cf;
    },
  },
  {
    op: 'getNetworkApplianceContentFilteringCategories',
    path: '/networks/{networkId}/appliance/contentFiltering/categories',
    handler: (ctx) => {
      mxConfig(ctx);
      return { categories: structuredClone(CF_CATEGORIES) };
    },
  },
  ...settings('SecurityIntrusion', 'security/intrusion', (c) => c.intrusion),
  ...settings('SecurityMalware', 'security/malware', (c) => c.malware),
  ...settings('Settings', 'settings', (c) => c.applianceSettings, (s, net) => {
    s.dynamicDns.url = `${s.dynamicDns.prefix}-${net.org.slug.toLowerCase()}.dynamic-m.com`;
  }),
  {
    op: 'getDeviceApplianceDhcpSubnets',
    path: '/devices/{serial}/appliance/dhcp/subnets',
    handler: (ctx) => dhcpSubnets(mxDevice(ctx), ctx.now),
  },
  {
    op: 'getDeviceApplianceUplinksSettings',
    path: '/devices/{serial}/appliance/uplinks/settings',
    handler: (ctx) => uplinkSettings(mxDevice(ctx)),
  },
  {
    op: 'updateDeviceApplianceUplinksSettings',
    method: 'PUT',
    path: '/devices/{serial}/appliance/uplinks/settings',
    handler: (ctx) => merge(uplinkSettings(mxDevice(ctx)), ctx.body),
  },
];
