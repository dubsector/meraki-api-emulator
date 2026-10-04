// Network-wide settings: status page, syslog, SNMP, alerts and their history, webhooks, group
// policies, floor plans and the link layer topology.

import { SNMP_V3, SYSLOG_ROLES, configOf, syslogRolesFor } from '../config.js';
import { arrayParam, badRequest, notFound, paginate, paginateItems } from '../http.js';
import { LOOKBACK } from '../sim/alerts.js';
import { changesOnDay } from '../sim/changes.js';
import { eachFailover, eachVpnChange, securityEventsOnDay } from '../sim/events.js';
import { deviceStatus, eachOutage, lastReportedAt } from '../sim/outages.js';
import { isOnline } from '../sim/presence.js';
import { DAY, MIN, iso } from '../time.js';
import { merge } from '../validate.js';
import { checkHttpUrl, pickTemplate } from '../webhooks.js';
import { dropSentry } from './smorg.js';
import { byId, devOf, netOf, orgOf } from './common.js';

const MAX_ITEMS = 100;
const SYSLOG_TITLES = ['Wireless event log', 'Appliance event log', 'Switch event log', 'Air Marshal events', 'Flows', 'URLs', 'IDS alerts', 'Security events'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Devices, phones found over LLDP/CDP, and the switch ports between them.
// A switch stack's members merge into one stack node.
function topology(net, now) {
  const derivedId = (mac) => mac.replace(/:/g, '');
  const clientsOf = (d) => (d.productType === 'wireless' ? net.clients.filter((c) => c.ap === d && isOnline(c, now)).length : d.productType === 'switch' ? d.ports.reduce((n, p) => n + p.clients.filter((c) => isOnline(c, now)).length, 0) : 0);
  const deviceInfo = (d) => ({ serial: d.serial, name: d.name, model: d.model, productType: d.productType, status: deviceStatus(d, now), lastReportedAt: iso(lastReportedAt(d, now)), clients: { counts: { total: clientsOf(d) } } });
  const isRoot = (d) => d === net.mx || (!net.mx && d === net.devices[0]);
  const stackOf = new Map();
  for (const stack of net.switchStacks?.list ?? []) {
    const members = stack.members.filter((d) => net.switches.includes(d));
    for (const d of members) stackOf.set(d, { stack, members });
  }
  const nodes = [];
  for (const d of net.devices) {
    const s = stackOf.get(d);
    if (!s) {
      nodes.push({ derivedId: derivedId(d.mac), mac: d.mac, type: 'device', root: isRoot(d), device: deviceInfo(d), discovered: { lldp: null, cdp: null } });
      continue;
    }
    // The stack takes its first member's place. Its ID is a number here but a string in the stacks API.
    if (d !== s.members[0]) continue;
    const members = s.members.map(deviceInfo);
    nodes.push({
      derivedId: s.stack.id,
      mac: s.stack.virtualMac,
      type: 'stack',
      root: s.members.some(isRoot),
      stack: { id: JSON.rawJSON(s.stack.id), name: s.stack.name, members, clients: { counts: { total: members.reduce((n, m) => n + m.clients.counts.total, 0) } } },
    });
  }
  const links = [];
  const nodeRef = (dev) => (stackOf.has(dev) ? { derivedId: stackOf.get(dev).stack.id, type: 'stack' } : { derivedId: derivedId(dev.mac), type: 'device' });
  const end = (dev, portId) => ({ node: nodeRef(dev), device: { serial: dev.serial, name: dev.name }, discovered: { lldp: { portId: String(portId) }, cdp: null } });
  for (const sw of net.switches) {
    for (const port of sw.ports) {
      const peer = port.peer?.device;
      // Switch-to-switch links show up on both ends; keep the downstream switch's copy.
      if (peer && !(peer.productType === 'switch' && !port.isUplink)) {
        const up = !['offline', 'dormant'].includes(deviceStatus(peer, now)) && !['offline', 'dormant'].includes(deviceStatus(sw, now));
        if (up) links.push({ ends: [end(sw, port.portId), end(peer, port.peer.portId)], lastReportedAt: iso(lastReportedAt(sw, now)) });
      }
      const phone = port.clients.find((c) => c.kindName === 'deskPhone');
      if (phone && isOnline(phone, now)) {
        nodes.push({
          derivedId: derivedId(phone.mac),
          mac: phone.mac,
          type: 'discovered',
          root: false,
          discovered: { lldp: { chassisId: phone.mac, systemName: phone.description, systemDescription: 'Cisco IP Phone 8845', systemCapabilities: ['telephone'], managementAddress: phone.ip }, cdp: { platform: 'Cisco IP Phone 8845', deviceId: phone.description, address: phone.ip, capabilities: ['host', 'phone'], managementAddress: phone.ip } },
        });
        links.push({
          ends: [end(sw, port.portId), { node: { derivedId: derivedId(phone.mac), type: 'discovered' }, discovered: { lldp: { portId: phone.mac, portDescription: 'SW PORT' }, cdp: { portId: 'Port 1', nativeVlan: 10 } } }],
          lastReportedAt: iso(lastReportedAt(sw, now)),
        });
      }
    }
  }
  return { nodes, links, errors: [] };
}

// Static fields only show with a static IP, and wanEnabled only on an MX.
function shapeWan(w, mx) {
  const out = mx ? { wanEnabled: w.wanEnabled ?? 'not configured', usingStaticIp: !!w.usingStaticIp } : { usingStaticIp: !!w.usingStaticIp };
  if (w.usingStaticIp) Object.assign(out, { staticIp: w.staticIp, staticSubnetMask: w.staticSubnetMask, staticGatewayIp: w.staticGatewayIp, staticDns: w.staticDns ?? [] });
  out.vlan = w.vlan ?? null;
  return out;
}

// MX WAN addressing; other devices use DHCP on the management VLAN until a PUT says otherwise.
export function managementInterface(dev) {
  const mx = dev.productType === 'appliance';
  let wans = dev.managementInterface;
  if (!wans && !mx) wans = { wan1: shapeWan({ usingStaticIp: false }, false) };
  if (!wans) {
    const wan = (u) => {
      if (!u) return { wanEnabled: 'disabled', usingStaticIp: false };
      if (u.isp !== 'fiber') return { wanEnabled: 'enabled', usingStaticIp: false };
      return { wanEnabled: 'enabled', usingStaticIp: true, staticIp: u.publicIp, staticSubnetMask: '255.255.255.0', staticGatewayIp: u.gateway, staticDns: ['8.8.8.8', '1.1.1.1'] };
    };
    wans = { wan1: shapeWan(wan(dev.uplinks[0]), true), wan2: shapeWan(wan(dev.uplinks[1]), true) };
  }
  if (!mx) return structuredClone(wans);
  const host = configOf(dev.net).applianceSettings.dynamicDns.url;
  const [prefix, ...rest] = host.split('.');
  return {
    ddnsHostnames: { activeDdnsHostname: host, ddnsHostnameWan1: [`${prefix}-1`, ...rest].join('.'), ddnsHostnameWan2: [`${prefix}-2`, ...rest].join('.') },
    ...structuredClone(wans),
  };
}

// Sensors reach the cloud through a gateway AP, so they have no IP settings.
function ipDevice(ctx) {
  const dev = devOf(ctx);
  if (dev.productType === 'sensor') throw badRequest('Sensors have no management interface; they connect through a gateway');
  return dev;
}

// A static IP on a switch, AP or camera becomes its LAN IP.
function updateManagementInterface(ctx) {
  const dev = ipDevice(ctx);
  if (dev.productType === 'cellularGateway' && ctx.body.wan1?.usingStaticIp) throw badRequest('Cellular gateways take their address from the carrier and cannot use a static IP');
  const mx = dev.productType === 'appliance';
  if (!mx && ctx.body.wan2) throw badRequest("'wan2' is only supported on MX appliances");
  const current = managementInterface(dev);
  const next = {};
  for (const k of mx ? ['wan1', 'wan2'] : ['wan1']) {
    const w = { ...current[k], ...ctx.body[k] };
    if (w.usingStaticIp) {
      for (const f of ['staticIp', 'staticSubnetMask', 'staticGatewayIp']) if (!w[f]) throw badRequest(`'${k}.${f}' is required when usingStaticIp is true`);
      if ((w.staticDns?.length ?? 0) > 2) throw badRequest(`'${k}.staticDns' takes at most two addresses`);
    }
    next[k] = shapeWan(w, mx);
  }
  dev.managementInterface = next;
  if (!mx) {
    dev.dhcpLanIp ??= dev.lanIp;
    dev.lanIp = next.wan1.usingStaticIp ? next.wan1.staticIp : dev.dhcpLanIp;
  }
  return managementInterface(dev);
}

// ── Writes ──

function serverOf(c, id) {
  const server = c.httpServers.find((s) => s.id === id);
  if (!server) throw notFound('HTTP server');
  return server;
}

function policyOf(c, id) {
  const policy = c.groupPolicies.find((p) => p.groupPolicyId === id);
  if (!policy) throw notFound('Group policy');
  return policy;
}

function createServer(ctx) {
  const net = netOf(ctx);
  const c = configOf(net);
  const { name, url, sharedSecret, payloadTemplate } = ctx.body;
  checkHttpUrl(url, 'url');
  // The real API uses the base64 of the URL as the ID, so each URL can only be added once.
  const id = Buffer.from(url).toString('base64');
  if (c.httpServers.some((s) => s.id === id)) throw badRequest('This URL has already been added');
  if (c.httpServers.length >= MAX_ITEMS) throw badRequest(`Networks are limited to ${MAX_ITEMS} webhook servers in the emulator`);
  const template = pickTemplate(net, payloadTemplate);
  const server = { id, name, url, enabled: true, networkId: net.id, payloadTemplate: { payloadTemplateId: template.payloadTemplateId, name: template.name } };
  c.httpServers.push(server);
  (c.httpServerSecrets ??= {})[id] = sharedSecret ?? '';
  return server;
}

function updateServer(ctx) {
  const net = netOf(ctx);
  const c = configOf(net);
  const server = serverOf(c, ctx.params.httpServerId);
  const { name, sharedSecret, payloadTemplate } = ctx.body;
  const template = payloadTemplate?.payloadTemplateId != null || payloadTemplate?.name != null ? pickTemplate(net, payloadTemplate) : null;
  if (name != null) server.name = name;
  if (template) server.payloadTemplate = { payloadTemplateId: template.payloadTemplateId, name: template.name };
  if (sharedSecret != null) (c.httpServerSecrets ??= {})[server.id] = sharedSecret;
  return server;
}

// Alert settings stop sending to a deleted server too.
function deleteServer(ctx) {
  const c = configOf(netOf(ctx));
  const server = serverOf(c, ctx.params.httpServerId);
  c.httpServers.splice(c.httpServers.indexOf(server), 1);
  for (const d of [c.alerts.defaultDestinations, ...c.alerts.alerts.map((a) => a.alertDestinations)]) d.httpServerIds = d.httpServerIds.filter((id) => id !== server.id);
}

// Servers are stored with per-product role values. The deprecated endpoints
// show each role's title once, and a title stands for every role behind it
// that the network's products have.
function legacySyslog(c) {
  const title = (v) => SYSLOG_ROLES.find((r) => r.value === v).title;
  return { servers: c.syslog.servers.map((s) => ({ host: s.host, port: s.port, roles: [...new Set(s.roles.map(title))] })) };
}

function setSyslog(net, servers) {
  if (servers.length > MAX_ITEMS) throw badRequest(`Networks are limited to ${MAX_ITEMS} syslog servers in the emulator`);
  configOf(net).syslog = { servers };
}

// Role titles are matched without regard to case, as the spec allows.
function legacySyslogServers(ctx) {
  const net = netOf(ctx);
  const c = configOf(net);
  const available = syslogRolesFor(net);
  setSyslog(
    net,
    ctx.body.servers.map((s) => {
      const roles = (s.roles || []).flatMap((r) => {
        const title = SYSLOG_TITLES.find((x) => x.toLowerCase() === String(r).toLowerCase());
        if (!title) throw badRequest(`'${r}' is not a syslog role. Use one of: ${SYSLOG_TITLES.join(', ')}`);
        const values = available.filter((x) => x.title === title).map((x) => x.value);
        if (!values.length) throw badRequest(`'${title}' is not available on this network`);
        return values;
      });
      // This endpoint can't set the transport or encryption, so a server that was already there keeps its own.
      const was = c.syslog.servers.find((x) => x.host === s.host && x.port === Number(s.port));
      return { host: s.host, port: Number(s.port), roles: [...new Set(roles)], transportProtocol: was?.transportProtocol ?? 'UDP', encryption: structuredClone(was?.encryption ?? { enabled: false }) };
    }),
  );
  return legacySyslog(c);
}

function deviceSyslogServers(ctx) {
  const net = netOf(ctx);
  const available = syslogRolesFor(net);
  const servers = ctx.body.servers.map((s, i) => {
    const roles = s.roles.map((r) => {
      const role = available.find((x) => x.value.toLowerCase() === String(r).toLowerCase());
      if (!role) throw badRequest(`'servers[${i}].roles' has '${r}', which is not a role on this network. Use one of: ${available.map((x) => x.value).join(', ')}`);
      return role.value;
    });
    const enc = s.encryption?.enabled ? { enabled: true, ...(s.encryption.certificate?.id != null && { certificate: { id: s.encryption.certificate.id } }) } : { enabled: false };
    return { host: s.host, port: Number(s.port), roles: [...new Set(roles)], transportProtocol: s.transportProtocol ?? 'UDP', encryption: enc };
  });
  setSyslog(net, servers);
  return { network: { id: net.id }, servers: structuredClone(servers) };
}

// One row per network in the organization, including networks without servers.
function syslogByNetwork(ctx, row) {
  const networkIds = arrayParam(ctx.query, 'networkIds');
  const nets = orgOf(ctx).networks.filter((n) => !networkIds.length || networkIds.includes(n.id)).sort(byId);
  return paginateItems(ctx, nets, (n) => n.id, { def: 10, max: 1000 }, row);
}

// Only the fields for the chosen access mode are kept.
function snmp(ctx) {
  const c = configOf(netOf(ctx));
  const { access = c.snmp.access, communityString, users, authentication, privacy } = ctx.body;
  if (access === 'community') {
    const community = communityString ?? c.snmp.communityString;
    if (!community) throw badRequest("'communityString' is required when access is community");
    c.snmp = { access, communityString: community };
  } else if (access === 'users') {
    const list = users ?? c.snmp.users;
    if (!list?.length) throw badRequest("'users' is required when access is users");
    c.snmp = {
      access,
      users: list,
      authentication: { ...SNMP_V3.authentication, ...c.snmp.authentication, ...authentication },
      privacy: { ...SNMP_V3.privacy, ...c.snmp.privacy, ...privacy },
    };
  } else {
    c.snmp = { access: 'none' };
  }
  return c.snmp;
}

// Each alert in the body updates the stored alert of the same type.
function alertSettings(ctx) {
  const c = configOf(netOf(ctx));
  const { alerts, ...rest } = ctx.body;
  const ids = new Set(c.httpServers.map((s) => s.id));
  const check = (d) => {
    for (const id of d?.httpServerIds || []) if (!ids.has(id)) throw badRequest(`HTTP server ${id} does not exist in this network`);
  };
  check(rest.defaultDestinations);
  for (const a of alerts || []) check(a.alertDestinations);
  merge(c.alerts, rest);
  for (const a of alerts || []) {
    const cur = c.alerts.alerts.find((x) => x.type === a.type);
    if (cur) merge(cur, a);
    else c.alerts.alerts.push(merge({ type: a.type, enabled: false, alertDestinations: { emails: [], smsNumbers: [], allAdmins: false, snmp: false, httpServerIds: [] }, filters: {} }, a));
  }
  return c.alerts;
}

// The alert setting that covers a device going down, and the title it's sent with.
const DOWN = {
  appliance: ['gatewayDown', 'Appliances went down'],
  switch: ['switchDown', 'Switches went down'],
  wireless: ['repeaterDown', 'APs went down'],
  camera: ['cameraDown', 'Cameras went down'],
};

// Each channel the alert went out on: email and push for the default
// recipients or all admins, SMS for the alert's own numbers, and webhooks.
function alertDestinations(def, own, sent) {
  const at = () => ({ sentAt: iso(sent) });
  const out = {};
  if (def.emails?.length || def.allAdmins || own.emails?.length || own.allAdmins) out.email = at();
  if (def.allAdmins || own.allAdmins) out.push = at();
  if (own.smsNumbers?.length) out.sms = at();
  if (def.httpServerIds?.length || own.httpServerIds?.length) out.webhook = at();
  return out;
}

// Alerts the network's alert settings would have sent over the last 31 days,
// from what the sim records: devices down past the alert's timeout, failovers,
// VPN peers coming and going, blocked malware and settings changes. Newest first.
function alertHistory(ctx) {
  const net = netOf(ctx);
  const alerts = configOf(net).alerts;
  const now = ctx.now;
  const from = now - LOOKBACK;
  const rows = [];
  const add = (type, t, sent, alertTypeId, alertType, dev, alertData) => {
    const a = alerts.alerts.find((x) => x.type === type && x.enabled);
    if (!a || t < from || sent > now) return;
    rows.push({ t, row: { occurredAt: iso(t), alertTypeId, alertType, device: dev ? { serial: dev.serial } : null, destinations: alertDestinations(alerts.defaultDestinations, a.alertDestinations ?? {}, sent), alertData } });
  };
  for (const dev of net.devices) {
    const [type, title] = DOWN[dev.productType] ?? [];
    if (!type) continue;
    const timeout = alerts.alerts.find((x) => x.type === type)?.filters?.timeout ?? 5;
    const down = (s, e) => {
      if (e - s >= timeout * MIN) add(type, s, s + timeout * MIN, 'stopped_reporting', title, dev, { minutes: timeout });
    };
    eachOutage(dev, from, now, down);
    if (dev.dormant) down(dev.dormantSince, Infinity);
  }
  if (net.mx) {
    eachFailover(net, from, now, (t, data) => add('failoverEvent', t, t, 'failover_event', 'Failover event', net.mx, data));
    eachVpnChange(net, from, now, (t, data) => add('vpnConnectivityChange', t, t, 'vpn_connectivity_change', 'VPN connectivity changed', net.mx, data));
    for (let d = Math.floor(from / DAY); d <= Math.floor(now / DAY); d++) {
      for (const e of securityEventsOnDay(net, d)) {
        if (e.eventType === 'File Scanned') add('ampMalwareBlocked', e.t, e.t, 'amp_malware_blocked', 'Malware blocked', net.mx, { clientMac: e.clientMac, fileHash: e.fileHash, fileType: e.fileType, canonicalName: e.canonicalName });
      }
    }
  }
  const changes = [];
  for (let d = Math.floor(from / DAY); d <= Math.floor(now / DAY); d++) changes.push(...changesOnDay(net.org, d));
  for (const e of [...changes, ...(net.org.apiChanges ?? [])]) {
    if (e.net === net) add('settingsChanged', e.t, e.t, 'settings_changed', 'Settings changed', null, { page: e.page, label: e.label, oldValue: e.oldValue, newValue: e.newValue });
  }
  rows.sort((a, b) => b.t - a.t);
  // Cursors are the time plus a count for alerts at the same moment.
  const keys = new Map();
  const seen = new Map();
  for (const { row } of rows) {
    const n = seen.get(row.occurredAt) ?? 0;
    seen.set(row.occurredAt, n + 1);
    keys.set(row, `${row.occurredAt}_${n}`);
  }
  return paginate(ctx, rows.map((r) => r.row), (r) => keys.get(r), { def: 100, max: 1000 });
}

function createPolicy(ctx) {
  const c = configOf(netOf(ctx));
  const b = ctx.body;
  if (c.groupPolicies.some((p) => p.name === b.name)) throw badRequest('Name has already been taken');
  if (c.groupPolicies.length >= MAX_ITEMS) throw badRequest(`Networks are limited to ${MAX_ITEMS} group policies in the emulator`);
  const id = String(Math.max(100, ...c.groupPolicies.map((p) => Number(p.groupPolicyId))) + 1);
  const byDefault = { settings: 'network default' };
  const policy = {
    name: b.name,
    groupPolicyId: id,
    scheduling: { enabled: false, ...Object.fromEntries(DAYS.map((d) => [d, { active: true, from: '00:00', to: '24:00' }])) },
    bandwidth: { settings: 'network default', bandwidthLimits: { limitUp: null, limitDown: null } },
    firewallAndTrafficShaping: { settings: 'network default', trafficShapingRules: [], l3FirewallRules: [], l7FirewallRules: [] },
    contentFiltering: { allowedUrlPatterns: { ...byDefault, patterns: [] }, blockedUrlPatterns: { ...byDefault, patterns: [] }, blockedUrlCategories: { ...byDefault, categories: [] } },
    splashAuthSettings: 'network default',
    vlanTagging: byDefault,
    bonjourForwarding: { ...byDefault, rules: [] },
  };
  c.groupPolicies.push(merge(policy, b));
  return policy;
}

function updatePolicy(ctx) {
  const c = configOf(netOf(ctx));
  const policy = policyOf(c, ctx.params.groupPolicyId);
  const { groupPolicyId, ...patch } = ctx.body;
  if (patch.name && patch.name !== policy.name && c.groupPolicies.some((p) => p.name === patch.name)) throw badRequest('Name has already been taken');
  return merge(policy, patch);
}

// VLANs that used a deleted policy go back to none.
function deletePolicy(ctx) {
  const c = configOf(netOf(ctx));
  const policy = policyOf(c, ctx.params.groupPolicyId);
  c.groupPolicies.splice(c.groupPolicies.indexOf(policy), 1);
  for (const v of c.vlans) if (v.groupPolicyId === policy.groupPolicyId) delete v.groupPolicyId;
  dropSentry(netOf(ctx).org, c, policy.groupPolicyId);
}

const setting = (op, path, pick) => ({ op, path: `/networks/{networkId}/${path}`, handler: (ctx) => pick(configOf(netOf(ctx)), netOf(ctx), ctx) });
const write = (op, method, path, handler) => ({ op, method, path: `/networks/{networkId}/${path}`, handler });

export default [
  setting('getNetworkSettings', 'settings', (c) => c.settings),
  write('updateNetworkSettings', 'PUT', 'settings', (ctx) => merge(configOf(netOf(ctx)).settings, ctx.body)),
  setting('getNetworkSyslogServers', 'syslogServers', legacySyslog),
  write('updateNetworkSyslogServers', 'PUT', 'syslogServers', legacySyslogServers),
  write('updateNetworkDevicesSyslogServers', 'PUT', 'devices/syslog/servers', deviceSyslogServers),
  {
    op: 'getOrganizationDevicesSyslogServersByNetwork',
    path: '/organizations/{organizationId}/devices/syslog/servers/byNetwork',
    handler: (ctx) => syslogByNetwork(ctx, (n) => ({ network: { id: n.id }, servers: structuredClone(configOf(n).syslog.servers) })),
  },
  {
    op: 'getOrganizationDevicesSyslogServersRolesByNetwork',
    path: '/organizations/{organizationId}/devices/syslog/servers/roles/byNetwork',
    handler: (ctx) => syslogByNetwork(ctx, (n) => ({ network: { id: n.id }, available: syslogRolesFor(n).map(({ name, value }) => ({ name, value })) })),
  },
  setting('getNetworkSnmp', 'snmp', (c) => c.snmp),
  write('updateNetworkSnmp', 'PUT', 'snmp', snmp),
  setting('getNetworkAlertsSettings', 'alerts/settings', (c) => c.alerts),
  write('updateNetworkAlertsSettings', 'PUT', 'alerts/settings', alertSettings),
  { op: 'getNetworkAlertsHistory', path: '/networks/{networkId}/alerts/history', handler: alertHistory },
  setting('getNetworkWebhooksHttpServers', 'webhooks/httpServers', (c) => c.httpServers),
  write('createNetworkWebhooksHttpServer', 'POST', 'webhooks/httpServers', createServer),
  {
    op: 'getNetworkWebhooksHttpServer',
    path: '/networks/{networkId}/webhooks/httpServers/{httpServerId}',
    sample: { httpServerId: Buffer.from('https://hooks.example.com/meraki/alerts').toString('base64') },
    handler: (ctx) => serverOf(configOf(netOf(ctx)), ctx.params.httpServerId),
  },
  write('updateNetworkWebhooksHttpServer', 'PUT', 'webhooks/httpServers/{httpServerId}', updateServer),
  write('deleteNetworkWebhooksHttpServer', 'DELETE', 'webhooks/httpServers/{httpServerId}', deleteServer),
  setting('getNetworkGroupPolicies', 'groupPolicies', (c) => c.groupPolicies),
  write('createNetworkGroupPolicy', 'POST', 'groupPolicies', createPolicy),
  {
    op: 'getNetworkGroupPolicy',
    path: '/networks/{networkId}/groupPolicies/{groupPolicyId}',
    sample: { groupPolicyId: '101' },
    handler: (ctx) => policyOf(configOf(netOf(ctx)), ctx.params.groupPolicyId),
  },
  write('updateNetworkGroupPolicy', 'PUT', 'groupPolicies/{groupPolicyId}', updatePolicy),
  write('deleteNetworkGroupPolicy', 'DELETE', 'groupPolicies/{groupPolicyId}', deletePolicy),
  setting('getNetworkTopologyLinkLayer', 'topology/linkLayer', (c, net, ctx) => topology(net, ctx.now)),
  {
    op: 'getDeviceManagementInterface',
    path: '/devices/{serial}/managementInterface',
    sample: { serial: 'appliance' },
    handler: (ctx) => managementInterface(ipDevice(ctx)),
  },
  {
    op: 'updateDeviceManagementInterface',
    method: 'PUT',
    path: '/devices/{serial}/managementInterface',
    handler: updateManagementInterface,
  },
];
