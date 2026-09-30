// Network-wide settings: status page, syslog, SNMP, alerts, webhooks, group
// policies, firmware, floor plans and the link layer topology.

import { configOf } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { hashStr } from '../rng.js';
import { deviceStatus, lastReportedAt } from '../sim/outages.js';
import { isOnline } from '../sim/presence.js';
import { DAY, iso } from '../time.js';
import { merge } from '../validate.js';
import { devOf, netOf } from './common.js';

const MAX_ITEMS = 100;
const SYSLOG_ROLES = ['Wireless event log', 'Appliance event log', 'Switch event log', 'Air Marshal events', 'Flows', 'URLs', 'IDS alerts', 'Security events'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Firmware trains per product: [firmware, short name, release date].
const FIRMWARE = {
  appliance: { previous: ['wired-18-107-12', 'MX 18.107.12', '2025-04-15'], current: ['wired-18-211-2', 'MX 18.211.2', '2025-11-04'], beta: ['wired-19-1-4', 'MX 19.1.4', '2026-07-21'] },
  switch: { previous: ['switch-16-9-1', 'MS 16.9.1', '2025-03-11'], current: ['switch-17-1-4', 'MS 17.1.4', '2025-10-28'], beta: ['switch-17-2-1', 'MS 17.2.1', '2026-08-04'] },
  wireless: { previous: ['wireless-30-7-1', 'MR 30.7.1', '2025-05-06'], current: ['wireless-31-1-6', 'MR 31.1.6', '2025-12-09'], beta: ['wireless-32-1-2', 'MR 32.1.2', '2026-08-18'] },
  camera: { previous: ['camera-6-2', 'MV 6.2', '2025-06-10'], current: ['camera-6-3', 'MV 6.3', '2026-01-13'], beta: ['camera-6-4', 'MV 6.4', '2026-08-25'] },
};

function version([firmware, shortName, date], releaseType = 'stable') {
  return { id: String(hashStr(firmware) % 100000), firmware, shortName, releaseType, releaseDate: `${date}T17:00:00Z` };
}

// Every network upgraded to the current release about two weeks after it came out.
function firmwareUpgrades(net) {
  const products = {};
  for (const p of net.productTypes) {
    const f = FIRMWARE[p];
    if (!f) continue;
    const upgraded = Date.parse(`${f.current[2]}T00:00:00Z`) / 1000 + (14 + (net.key % 7)) * DAY + 3 * 3600;
    products[p] = {
      currentVersion: version(f.current),
      lastUpgrade: { time: iso(upgraded), fromVersion: version(f.previous), toVersion: version(f.current) },
      nextUpgrade: { time: '', toVersion: {} },
      isUpgradeAvailable: true,
      availableVersions: [version(f.beta, 'beta')],
      participateInNextBetaRelease: net.tags.includes('lab'),
    };
  }
  return { upgradeWindow: { dayOfWeek: 'sun', hourOfDay: '2:00' }, timezone: net.timeZone, products };
}

// Devices, phones found over LLDP/CDP, and the switch ports between them.
function topology(net, now) {
  const derivedId = (mac) => mac.replace(/:/g, '');
  const nodes = net.devices.map((d) => {
    const status = deviceStatus(d, now);
    const clients = d.productType === 'wireless' ? net.clients.filter((c) => c.ap === d && isOnline(c, now)).length : d.productType === 'switch' ? d.ports.reduce((n, p) => n + p.clients.filter((c) => isOnline(c, now)).length, 0) : 0;
    return {
      derivedId: derivedId(d.mac),
      mac: d.mac,
      type: 'device',
      root: d === net.mx || (!net.mx && d === net.devices[0]),
      device: { serial: d.serial, name: d.name, model: d.model, productType: d.productType, status, lastReportedAt: iso(lastReportedAt(d, now)), clients: { counts: { total: clients } } },
      discovered: { lldp: null, cdp: null },
    };
  });
  const links = [];
  const end = (dev, portId) => ({ node: { derivedId: derivedId(dev.mac), type: 'device' }, device: { serial: dev.serial, name: dev.name }, discovered: { lldp: { portId: String(portId) }, cdp: null } });
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

// MX WAN addressing; other devices only report that they use DHCP on the management VLAN.
function managementInterface(dev) {
  if (dev.productType !== 'appliance') return { wan1: { usingStaticIp: false, vlan: null } };
  const host = configOf(dev.net).applianceSettings.dynamicDns.url;
  const [prefix, ...rest] = host.split('.');
  const wan = (u) => {
    if (!u) return { wanEnabled: 'disabled', usingStaticIp: false, vlan: null };
    if (u.isp !== 'fiber') return { wanEnabled: 'enabled', usingStaticIp: false, vlan: null };
    return { wanEnabled: 'enabled', usingStaticIp: true, staticIp: u.publicIp, staticSubnetMask: '255.255.255.0', staticGatewayIp: u.gateway, staticDns: ['8.8.8.8', '1.1.1.1'], vlan: null };
  };
  return {
    ddnsHostnames: { activeDdnsHostname: host, ddnsHostnameWan1: [`${prefix}-1`, ...rest].join('.'), ddnsHostnameWan2: [`${prefix}-2`, ...rest].join('.') },
    wan1: wan(dev.uplinks[0]),
    wan2: wan(dev.uplinks[1]),
  };
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
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {}
  if (!parsed || !/^https?:$/.test(parsed.protocol)) throw badRequest("'url' must be an http or https URL");
  // The real API uses the base64 of the URL as the ID, so each URL can only be added once.
  const id = Buffer.from(url).toString('base64');
  if (c.httpServers.some((s) => s.id === id)) throw badRequest('This URL has already been added');
  if (c.httpServers.length >= MAX_ITEMS) throw badRequest(`Networks are limited to ${MAX_ITEMS} webhook servers in the emulator`);
  const server = { id, name, url, enabled: true, networkId: net.id, payloadTemplate: { payloadTemplateId: 'wpt_00001', name: 'Meraki (included)', ...payloadTemplate } };
  c.httpServers.push(server);
  (c.httpServerSecrets ??= {})[id] = sharedSecret ?? '';
  return server;
}

function updateServer(ctx) {
  const c = configOf(netOf(ctx));
  const server = serverOf(c, ctx.params.httpServerId);
  const { name, sharedSecret, payloadTemplate } = ctx.body;
  if (name != null) server.name = name;
  if (payloadTemplate) merge(server.payloadTemplate, payloadTemplate);
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

// Role names are matched without regard to case, as the spec allows.
function syslogServers(ctx) {
  const c = configOf(netOf(ctx));
  const servers = ctx.body.servers.map((s) => ({
    host: s.host,
    port: Number(s.port),
    roles: (s.roles || []).map((r) => {
      const role = SYSLOG_ROLES.find((x) => x.toLowerCase() === String(r).toLowerCase());
      if (!role) throw badRequest(`'${r}' is not a syslog role. Use one of: ${SYSLOG_ROLES.join(', ')}`);
      return role;
    }),
  }));
  if (servers.length > MAX_ITEMS) throw badRequest(`Networks are limited to ${MAX_ITEMS} syslog servers in the emulator`);
  c.syslog = { servers };
  return c.syslog;
}

// Only the fields for the chosen access mode are kept.
function snmp(ctx) {
  const c = configOf(netOf(ctx));
  const { access = c.snmp.access, communityString, users } = ctx.body;
  if (access === 'community') {
    const community = communityString ?? c.snmp.communityString;
    if (!community) throw badRequest("'communityString' is required when access is community");
    c.snmp = { access, communityString: community };
  } else if (access === 'users') {
    const list = users ?? c.snmp.users;
    if (!list?.length) throw badRequest("'users' is required when access is users");
    c.snmp = { access, users: list };
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
}

const setting = (op, path, pick) => ({ op, path: `/networks/{networkId}/${path}`, handler: (ctx) => pick(configOf(netOf(ctx)), netOf(ctx), ctx) });
const write = (op, method, path, handler) => ({ op, method, path: `/networks/{networkId}/${path}`, handler });

export default [
  setting('getNetworkSettings', 'settings', (c) => c.settings),
  write('updateNetworkSettings', 'PUT', 'settings', (ctx) => merge(configOf(netOf(ctx)).settings, ctx.body)),
  setting('getNetworkSyslogServers', 'syslogServers', (c) => c.syslog),
  write('updateNetworkSyslogServers', 'PUT', 'syslogServers', syslogServers),
  setting('getNetworkSnmp', 'snmp', (c) => c.snmp),
  write('updateNetworkSnmp', 'PUT', 'snmp', snmp),
  setting('getNetworkAlertsSettings', 'alerts/settings', (c) => c.alerts),
  write('updateNetworkAlertsSettings', 'PUT', 'alerts/settings', alertSettings),
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
  setting('getNetworkFirmwareUpgrades', 'firmwareUpgrades', (c, net) => firmwareUpgrades(net)),
  setting('getNetworkFloorPlans', 'floorPlans', () => []),
  setting('getNetworkTopologyLinkLayer', 'topology/linkLayer', (c, net, ctx) => topology(net, ctx.now)),
  {
    op: 'getDeviceManagementInterface',
    path: '/devices/{serial}/managementInterface',
    sample: { serial: 'appliance' },
    handler: (ctx) => managementInterface(devOf(ctx)),
  },
];
