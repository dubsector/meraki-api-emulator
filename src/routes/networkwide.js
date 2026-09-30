// Network-wide settings: status page, syslog, SNMP, alerts, webhooks, group
// policies, firmware, floor plans and the link layer topology.

import { configOf } from '../config.js';
import { notFound } from '../http.js';
import { hashStr } from '../rng.js';
import { deviceStatus, lastReportedAt } from '../sim/outages.js';
import { isOnline } from '../sim/presence.js';
import { DAY, iso } from '../time.js';
import { devOf, netOf } from './common.js';

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

const setting = (op, path, pick) => ({ op, path: `/networks/{networkId}/${path}`, handler: (ctx) => pick(configOf(netOf(ctx)), netOf(ctx), ctx) });

export default [
  setting('getNetworkSettings', 'settings', (c) => c.settings),
  setting('getNetworkSyslogServers', 'syslogServers', (c) => c.syslog),
  setting('getNetworkSnmp', 'snmp', (c) => c.snmp),
  setting('getNetworkAlertsSettings', 'alerts/settings', (c) => c.alerts),
  setting('getNetworkWebhooksHttpServers', 'webhooks/httpServers', (c) => c.httpServers),
  setting('getNetworkGroupPolicies', 'groupPolicies', (c) => c.groupPolicies),
  {
    op: 'getNetworkWebhooksHttpServer',
    path: '/networks/{networkId}/webhooks/httpServers/{httpServerId}',
    sample: { httpServerId: Buffer.from('https://hooks.example.com/meraki/alerts').toString('base64') },
    handler: (ctx) => {
      const server = configOf(netOf(ctx)).httpServers.find((s) => s.id === ctx.params.httpServerId);
      if (!server) throw notFound('HTTP server');
      return server;
    },
  },
  {
    op: 'getNetworkGroupPolicy',
    path: '/networks/{networkId}/groupPolicies/{groupPolicyId}',
    sample: { groupPolicyId: '101' },
    handler: (ctx) => {
      const policy = configOf(netOf(ctx)).groupPolicies.find((p) => p.groupPolicyId === ctx.params.groupPolicyId);
      if (!policy) throw notFound('Group policy');
      return policy;
    },
  },
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
