// MX security appliance configuration: LAN ports, VLANs, firewall, NAT, VPN
// and threat protection, plus the device-level uplink and DHCP views.

import { configOf } from '../config.js';
import { notFound } from '../http.js';
import { derive, unit } from '../rng.js';
import { isDown } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { DAY } from '../time.js';
import { devOf, netOf, requireModel, requireProduct } from './common.js';

function mxConfig(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'appliance');
  return configOf(net);
}

// Port config only; the API has no live MX port state. Port 3 trunks to the
// core switch, the rest get a seeded mix of access, trunk and disabled.
function appliancePorts(net) {
  requireProduct(net, 'appliance');
  const [first, last] = net.mx.info.lan;
  const vlans = [...new Set(net.clients.map((c) => c.vlan))].sort((a, b) => a - b);
  const key = derive(net.mx.key, 'lan');
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
    ports.push({ ...port, sgt: { id: null, enabled: false } });
  }
  return ports;
}

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
  return { interfaces: { wan1: iface(mx.uplinks[0]), wan2: iface(mx.uplinks[1]) } };
}

const config = (op, path, pick) => ({ op, path: `/networks/{networkId}/appliance/${path}`, handler: (ctx) => pick(mxConfig(ctx)) });

export default [
  {
    op: 'getNetworkAppliancePorts',
    path: '/networks/{networkId}/appliance/ports',
    handler: (ctx) => appliancePorts(netOf(ctx)),
  },
  {
    op: 'getNetworkAppliancePort',
    path: '/networks/{networkId}/appliance/ports/{portId}',
    sample: { portId: '3' },
    handler: (ctx) => {
      const port = appliancePorts(netOf(ctx)).find((p) => String(p.number) === ctx.params.portId);
      if (!port) throw notFound('Port');
      return port;
    },
  },
  config('getNetworkApplianceVlans', 'vlans', (c) => c.vlans),
  config('getNetworkApplianceVlansSettings', 'vlans/settings', () => ({ vlansEnabled: true })),
  {
    op: 'getNetworkApplianceVlan',
    path: '/networks/{networkId}/appliance/vlans/{vlanId}',
    sample: { vlanId: '10' },
    handler: (ctx) => {
      const vlan = mxConfig(ctx).vlans.find((v) => v.id === ctx.params.vlanId);
      if (!vlan) throw notFound('VLAN');
      return vlan;
    },
  },
  config('getNetworkApplianceFirewallL3FirewallRules', 'firewall/l3FirewallRules', (c) => ({ rules: c.l3Rules })),
  config('getNetworkApplianceFirewallL7FirewallRules', 'firewall/l7FirewallRules', (c) => ({ rules: c.l7Rules })),
  config('getNetworkApplianceFirewallInboundFirewallRules', 'firewall/inboundFirewallRules', (c) => c.inbound),
  config('getNetworkApplianceFirewallPortForwardingRules', 'firewall/portForwardingRules', (c) => ({ rules: c.portForwarding })),
  config('getNetworkApplianceFirewallOneToOneNatRules', 'firewall/oneToOneNatRules', (c) => ({ rules: c.oneToOne })),
  config('getNetworkApplianceFirewallFirewalledServices', 'firewall/firewalledServices', (c) => c.firewalledServices),
  config('getNetworkApplianceStaticRoutes', 'staticRoutes', (c) => c.staticRoutes),
  config('getNetworkApplianceVpnSiteToSiteVpn', 'vpn/siteToSiteVpn', (c) => c.siteToSite),
  config('getNetworkApplianceContentFiltering', 'contentFiltering', (c) => c.contentFiltering),
  config('getNetworkApplianceSecurityIntrusion', 'security/intrusion', (c) => c.intrusion),
  config('getNetworkApplianceSecurityMalware', 'security/malware', (c) => c.malware),
  config('getNetworkApplianceSettings', 'settings', (c) => c.applianceSettings),
  {
    op: 'getDeviceApplianceDhcpSubnets',
    path: '/devices/{serial}/appliance/dhcp/subnets',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      return dhcpSubnets(dev, ctx.now);
    },
  },
  {
    op: 'getDeviceApplianceUplinksSettings',
    path: '/devices/{serial}/appliance/uplinks/settings',
    handler: (ctx) => {
      const dev = devOf(ctx);
      requireModel(dev, 'appliance');
      return uplinkSettings(dev);
    },
  },
];
