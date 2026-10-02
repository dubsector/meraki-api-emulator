// Network configuration: VLANs, firewall rules, VPN, alerts and so on. Built
// once per network from its topology and clients, so it agrees with the
// addresses and traffic the other endpoints report.

import { CF_BLOCKS, CF_CATEGORIES, VLANS, l7Category } from './catalog.js';
import { derive } from './rng.js';

const ANY = 'Any';
export const DEFAULT_RULE = { comment: 'Default rule', policy: 'allow', protocol: 'Any', srcPort: ANY, srcCidr: ANY, destPort: ANY, destCidr: ANY, syslogEnabled: false };
// A new appliance network starts as one LAN, before VLANs are turned on.
const SINGLE_LAN = { subnet: '192.168.128.0/24', applianceIp: '192.168.128.1' };
export const GUEST_POLICY_ID = '101';
// Syslog roles per product type, with the title the deprecated
// /syslogServers endpoints roll each one up into. Only applianceEventLog,
// applianceUrlLog and wirelessEventLog are confirmed names; the rest follow them.
export const SYSLOG_ROLES = [
  { value: 'applianceEventLog', name: 'Appliance Event log', productType: 'appliance', title: 'Appliance event log' },
  { value: 'switchEventLog', name: 'Switch Event Log', productType: 'switch', title: 'Switch event log' },
  { value: 'wirelessEventLog', name: 'Wireless Event Log', productType: 'wireless', title: 'Wireless event log' },
  { value: 'applianceSecurityEvents', name: 'Appliance Security Events', productType: 'appliance', title: 'Security events' },
  { value: 'applianceUrlLog', name: 'Appliance URLs', productType: 'appliance', title: 'URLs' },
  { value: 'wirelessUrlLog', name: 'Wireless URLs', productType: 'wireless', title: 'URLs' },
  { value: 'applianceFlows', name: 'Appliance Flows', productType: 'appliance', title: 'Flows' },
  { value: 'wirelessFlows', name: 'Wireless Flows', productType: 'wireless', title: 'Flows' },
  { value: 'applianceIdsAlerts', name: 'Appliance IDS Alerts', productType: 'appliance', title: 'IDS alerts' },
  { value: 'wirelessAirMarshalEvents', name: 'Wireless Air Marshal Events', productType: 'wireless', title: 'Air Marshal events' },
];

export function syslogRolesFor(net) {
  return SYSLOG_ROLES.filter((r) => net.productTypes.includes(r.productType));
}

export const SNMP_V3 = { authentication: { protocol: 'SHA-1' }, privacy: { protocol: 'AES-128' } };

// Content filtering categories blocked everywhere; the names match the cf_block events.
export const BLOCKED_CATEGORIES = CF_CATEGORIES.filter((c) => CF_BLOCKS.some((b) => b.category === c.name));

// A version 4 style UUID that stays the same for the same key and salt.
export function uuid(key, salt) {
  const hex = [0, 1, 2, 3].map((i) => derive(key, `${salt}:${i}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

// A network bound to a config template uses the template's settings. A
// template that has none yet takes them from the first network bound to it.
export function configOf(net) {
  if (net.template) return (net.template.config ||= rebase(buildConfig(net), net.id, net.template.id));
  return (net.config ||= buildConfig(net));
}

// A copy of a network's or template's settings with its own ID swapped for another.
export const rebase = (config, fromId, toId) => JSON.parse(JSON.stringify(config).replaceAll(fromId, toId));

// A setting kept on the network from its first read, so writes to it stick.
export function stored(net, key, build) {
  const c = configOf(net);
  return (c[key] ??= build());
}

const APPLIANCE_SETTINGS = new Set(['vlansEnabled', 'vlans', 'singleLan', 'l3', 'l7Rules', 'portForwarding', 'oneToOne', 'inbound', 'firewalledServices', 'staticRoutes', 'siteToSite', 'contentFiltering', 'intrusion', 'malware', 'applianceSettings', 'portOverrides']);
const WIRELESS_SETTINGS = new Set(['ssids', 'rfProfiles', 'wirelessSettings', 'identityPsks', 'splash', 'splashAuthorizations']);

// The product a setting belongs to, or null for a network-wide one.
export function settingProduct(key) {
  if (APPLIANCE_SETTINGS.has(key)) return 'appliance';
  if (key.startsWith('switch')) return 'switch';
  if (WIRELESS_SETTINGS.has(key) || key.startsWith('ssid')) return 'wireless';
  return null;
}

// VLANs this network shares over AutoVPN, as the VPN status endpoint lists them.
export function exportedSubnets(net) {
  const c = configOf(net);
  return c.vlans.filter((v) => c.siteToSite.subnets.some((s) => s.localSubnet === v.subnet && s.useVpn)).map((v) => ({ subnet: v.subnet, name: v.name }));
}

function vlanSpan(net) {
  // Clients fill 250 addresses per /24, then spill into the next third octet.
  const top = new Map([[1, 1]]);
  for (const c of net.clients) {
    const third = Number(c.ip.split('.')[2]);
    top.set(c.vlan, Math.max(top.get(c.vlan) ?? 0, third));
  }
  return [...top.entries()].sort((a, b) => a[0] - b[0]);
}

function buildVlans(net) {
  const fixed = net.clients.filter((c) => ['printer', 'nas', 'pos'].includes(c.kindName));
  return vlanSpan(net).map(([id, top]) => {
    const octets = Math.max(1, top - id + 1);
    const bits = Math.ceil(Math.log2(octets));
    const v = {
      id: String(id),
      interfaceId: String(1e12 + derive(net.key, `vlan${id}`)),
      name: VLANS[id] ?? `VLAN ${id}`,
      subnet: `${net.subnet(id)}.0/${24 - bits}`,
      applianceIp: `${net.subnet(id)}.1`,
      dhcpHandling: 'Run a DHCP server',
      dhcpLeaseTime: '1 day',
      dhcpBootOptionsEnabled: false,
      dhcpOptions: [],
      fixedIpAssignments: Object.fromEntries(fixed.filter((c) => c.vlan === id).map((c) => [c.mac, { ip: c.ip, name: c.description }])),
      reservedIpRanges: id === 1 ? [] : [{ start: `${net.subnet(id)}.2`, end: `${net.subnet(id)}.9`, comment: 'Infrastructure' }],
      dnsNameservers: 'upstream_dns',
      mandatoryDhcp: { enabled: false },
      ipv6: { enabled: false },
    };
    if (id === 30) v.groupPolicyId = GUEST_POLICY_ID;
    return v;
  });
}

function l3Rules(net, vlans) {
  const has = (id) => vlans.some((v) => v.id === String(id));
  const cidr = (id) => vlans.find((v) => v.id === String(id)).subnet;
  const hub = net.org.hub;
  const rule = (comment, policy, protocol, srcCidr, destPort, destCidr, syslogEnabled = false) => ({ comment, policy, protocol, srcPort: ANY, srcCidr, destPort, destCidr, syslogEnabled });
  const rules = [];
  if (has(20)) rules.push(rule('Voice to SIP provider', 'allow', 'udp', cidr(20), '5060-5061', '192.0.2.50/32'));
  if (has(50) && hub) rules.push(rule('Scanners to warehouse system', 'allow', 'tcp', cidr(50), '443', `${hub.subnet(5)}.0/24`));
  if (has(50)) rules.push(rule('Scanners stay off the LAN', 'deny', 'any', cidr(50), ANY, '10.0.0.0/8', true));
  if (has(60)) rules.push(rule('POS to payment processor', 'allow', 'tcp', cidr(60), '443', '198.51.100.200/32'));
  if (has(60)) rules.push(rule('Isolate POS', 'deny', 'any', cidr(60), ANY, '10.0.0.0/8', true));
  if (has(30)) rules.push(rule('Block guest Wi-Fi from internal networks', 'deny', 'any', cidr(30), ANY, '10.0.0.0/8', true));
  if (has(40)) rules.push(rule('IoT to internet only', 'deny', 'any', cidr(40), ANY, '10.0.0.0/8'));
  return rules;
}

function l7Rules(net) {
  const rules = [{ policy: 'deny', type: 'applicationCategory', value: l7Category('Peer-to-peer (P2P)') }];
  if (net.kind !== 'office') rules.push({ policy: 'deny', type: 'applicationCategory', value: l7Category('Gaming') });
  rules.push({ policy: 'deny', type: 'host', value: 'games.example.com' });
  return rules;
}

// Only HQ publishes services to the internet.
function inbound(net) {
  if (net.vpn !== 'hub') return { portForwarding: [], oneToOne: [] };
  const servers = net.subnet(5);
  return {
    portForwarding: [
      { name: 'Web server', lanIp: `${servers}.30`, allowedIps: ['any'], protocol: 'tcp', publicPort: '443', localPort: '443', uplink: 'both' },
      { name: 'Remote access gateway', lanIp: `${servers}.31`, allowedIps: ['198.51.100.0/24', '203.0.113.0/24'], protocol: 'udp', publicPort: '4500', localPort: '4500', uplink: 'internet1' },
    ],
    oneToOne: [
      {
        name: 'Mail relay',
        publicIp: `198.51.100.${50 + net.siteIndex}`,
        lanIp: `${servers}.25`,
        uplink: 'internet1',
        allowedInbound: [{ protocol: 'tcp', destinationPorts: ['25', '587'], allowedIps: ['any'] }],
      },
    ],
  };
}

function siteToSite(net, vlans) {
  const exported = new Set(net.vpn === 'hub' ? ['5', '10', '20'] : ['10', '20', '50']);
  return {
    mode: net.org.hub ? net.vpn : 'none',
    hubs: net.vpn === 'spoke' && net.org.hub ? [{ hubId: net.org.hub.id, useDefaultRoute: false }] : [],
    subnets: vlans.map((v) => ({ localSubnet: v.subnet, useVpn: exported.has(v.id) })),
    sgt: { enabled: false },
    subnet: { nat: { isAllowed: false } },
  };
}

function groupPolicies(net) {
  if (!net.ssids.some((s) => s.key === 'guest')) return [];
  const day = { active: true, from: '00:00', to: '24:00' };
  const days = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, day]));
  const byDefault = { settings: 'network default' };
  return [
    {
      name: 'Guest',
      groupPolicyId: GUEST_POLICY_ID,
      scheduling: { enabled: false, ...days },
      bandwidth: { settings: 'custom', bandwidthLimits: { limitUp: 5120, limitDown: 20480 } },
      firewallAndTrafficShaping: { settings: 'custom', trafficShapingRules: [], l3FirewallRules: [{ comment: 'No LAN access', policy: 'deny', protocol: 'any', destPort: ANY, destCidr: '10.0.0.0/8' }], l7FirewallRules: [] },
      contentFiltering: { allowedUrlPatterns: { ...byDefault, patterns: [] }, blockedUrlPatterns: { ...byDefault, patterns: [] }, blockedUrlCategories: { ...byDefault, categories: [] } },
      splashAuthSettings: 'network default',
      vlanTagging: byDefault,
      bonjourForwarding: { ...byDefault, rules: [] },
    },
  ];
}

function webhookServers(net) {
  const url = 'https://hooks.example.com/meraki/alerts';
  return [
    {
      id: Buffer.from(url).toString('base64'),
      name: 'NetOps alerts',
      url,
      enabled: true,
      networkId: net.id,
      payloadTemplate: { payloadTemplateId: 'wpt_00001', name: 'Meraki (included)' },
    },
  ];
}

// Alert types from the Dashboard's alert settings page, one per product in the network.
const ALERTS = [
  ['gatewayDown', 'appliance', { timeout: 5 }],
  ['vpnConnectivityChange', 'appliance', {}],
  ['failoverEvent', 'appliance', {}],
  ['ampMalwareBlocked', 'appliance', {}],
  ['switchDown', 'switch', { timeout: 5 }],
  ['portDown', 'switch', { timeout: 5, selector: 'any port' }],
  ['portError', 'switch', { selector: 'any port' }],
  ['repeaterDown', 'wireless', { timeout: 10 }],
  ['rogueAp', 'wireless', {}],
  ['cameraDown', 'camera', { timeout: 30 }],
  ['settingsChanged', null, {}],
  ['usageAlert', null, { period: 1200, threshold: 104857600 }],
];

function alertSettings(net, servers) {
  const quiet = { emails: [], smsNumbers: [], allAdmins: false, snmp: false, httpServerIds: [] };
  return {
    defaultDestinations: { emails: net.created ? [] : ['netops@example.com'], allAdmins: false, snmp: false, httpServerIds: servers.map((s) => s.id) },
    alerts: ALERTS.filter(([, product]) => !product || net.productTypes.includes(product)).map(([type, , filters]) => ({
      type,
      enabled: type !== 'usageAlert' && type !== 'rogueAp',
      alertDestinations: structuredClone(quiet),
      filters,
    })),
    muting: { byPortSchedules: { enabled: false } },
  };
}

const RADIUS_KEYS = ['radiusServers', 'radiusAccountingServers', 'radiusAccountingEnabled', 'radiusEnabled', 'radiusAttributeForGroupPolicies', 'radiusTestingEnabled', 'radiusCalledStationId', 'radiusAuthenticationNasId', 'radiusServerTimeout', 'radiusServerAttemptsLimit', 'radiusFallbackEnabled', 'radiusProxyEnabled', 'radiusCoaEnabled', 'radiusOverride'];
const RADIUS_DEFAULTS = { radiusEnabled: true, radiusAccountingEnabled: false, radiusAttributeForGroupPolicies: 'Filter-Id', radiusTestingEnabled: false, radiusServerTimeout: 1, radiusServerAttemptsLimit: 3, radiusFallbackEnabled: false, radiusProxyEnabled: false, radiusCoaEnabled: false, radiusOverride: false };

// Modes that authenticate against RADIUS servers. ipsk-without-radius keeps its keys in Dashboard.
export function usesRadius(mode) {
  return /^8021x-radius$|with-radius/.test(mode);
}

function setDefaults(obj, defaults) {
  for (const [k, v] of Object.entries(defaults)) obj[k] ??= structuredClone(v);
}

// The real API only returns the fields that apply to an SSID's auth mode, IP
// assignment mode and splash page. Adds the defaults for its modes and drops
// fields left over from other ones.
export function shapeSsid(s) {
  const mode = String(s.authMode);
  if (mode === 'psk') setDefaults(s, { encryptionMode: 'wpa', wpaEncryptionMode: 'WPA2 only' });
  else delete s.psk;
  if (mode.startsWith('8021x')) setDefaults(s, { encryptionMode: 'wpa-eap', wpaEncryptionMode: 'WPA2 only' });
  if (mode.startsWith('ipsk')) setDefaults(s, { encryptionMode: 'wpa', wpaEncryptionMode: 'WPA2 only' });
  if (/^(psk|8021x|ipsk)/.test(mode)) setDefaults(s, { dot11w: { enabled: false, required: false }, dot11r: { enabled: false, adaptive: false } });
  else for (const k of ['encryptionMode', 'wpaEncryptionMode', 'dot11w', 'dot11r']) delete s[k];
  if (mode === '8021x-nac') s.localAuth ??= false;
  else delete s.localAuth;

  if (usesRadius(mode)) {
    setDefaults(s, RADIUS_DEFAULTS);
    // Shared secrets are write-only.
    const server = ({ secret, ...r }) => ({ ...r, openRoamingCertificateId: r.openRoamingCertificateId ?? null, caCertificate: r.caCertificate ?? null });
    s.radiusServers = (s.radiusServers || []).map((r) => ({ ...server(r), radsecEnabled: r.radsecEnabled ?? false }));
    if (s.radiusAccountingEnabled) s.radiusAccountingServers = (s.radiusAccountingServers || []).map(server);
    else delete s.radiusAccountingServers;
  } else {
    for (const k of RADIUS_KEYS) delete s[k];
  }
  if (!usesRadius(mode) && !/RADIUS/.test(s.splashPage)) {
    delete s.radiusFailoverPolicy;
    delete s.radiusLoadBalancingPolicy;
  }

  const ip = s.ipAssignmentMode;
  if (ip === 'NAT mode') setDefaults(s, { adultContentFilteringEnabled: false, dnsRewrite: { enabled: false, dnsCustomNameservers: [] } });
  else for (const k of ['adultContentFilteringEnabled', 'dnsRewrite']) delete s[k];
  if (ip === 'Bridge mode') s.lanIsolationEnabled ??= false;
  else delete s.lanIsolationEnabled;
  if (ip === 'Bridge mode' || ip === 'Layer 3 roaming') s.useVlanTagging ??= false;
  else delete s.useVlanTagging;
  if (!s.useVlanTagging) delete s.defaultVlanId;
  if (ip !== 'Ethernet over GRE') delete s.gre;
  if (ip !== 'Campus Gateway') delete s.campusGateway;

  if (s.splashPage && s.splashPage !== 'None') setDefaults(s, { adminSplashUrl: '', splashTimeout: '1440 minutes', walledGardenEnabled: false });
  else for (const k of ['adminSplashUrl', 'splashTimeout', 'walledGardenEnabled']) delete s[k];
  if (!s.walledGardenEnabled) delete s.walledGardenRanges;
  if (s.splashPage === 'Google OAuth') s.oauth ??= { allowedDomains: [] };
  else delete s.oauth;
  return s;
}

function ssidJson(net, number) {
  const s = net.ssids.find((x) => x.number === number);
  const common = {
    number,
    ssidAdminAccessible: false,
    minBitrate: 11,
    bandSelection: 'Dual band operation',
    perClientBandwidthLimitUp: 0,
    perClientBandwidthLimitDown: 0,
    perSsidBandwidthLimitUp: 0,
    perSsidBandwidthLimitDown: 0,
    mandatoryDhcpEnabled: false,
    visible: true,
    availableOnAllAps: true,
    availabilityTags: [],
    speedBurst: { enabled: false },
  };
  if (!s) return shapeSsid({ ...common, name: `Unconfigured SSID ${number + 1}`, enabled: false, splashPage: 'None', authMode: 'open', ipAssignmentMode: 'NAT mode' });
  const out = {
    ...common,
    name: s.name,
    enabled: true,
    splashPage: s.splashPage || 'None',
    authMode: s.authMode,
    ipAssignmentMode: s.nat ? 'NAT mode' : 'Bridge mode',
    bandSelection: 'Dual band operation with Band Steering',
    minBitrate: 12,
  };
  if (s.authMode === 'psk') out.psk = 'example-passphrase';
  if (s.authMode === '8021x-radius') {
    Object.assign(out, {
      radiusServers: [{ id: String(net.key % 1e9), host: `${net.org.hub ? net.org.hub.subnet(5) : net.subnet(5)}.20`, port: 1812 }],
      radiusFailoverPolicy: 'Deny access',
      radiusLoadBalancingPolicy: 'Round robin',
    });
  }
  if (!s.nat) Object.assign(out, { useVlanTagging: true, defaultVlanId: s.vlan });
  return shapeSsid(out);
}

function buildConfig(net) {
  const org = net.org;
  const seeded = !net.created;
  const vlans = net.mx ? buildVlans(net) : [];
  const syslogHost = org.hub ? `${org.hub.subnet(5)}.40` : `${net.subnet(1)}.40`;
  const servers = seeded ? webhookServers(net) : [];
  const { portForwarding, oneToOne } = inbound(net);
  return {
    vlansEnabled: vlans.length > 0,
    vlans,
    singleLan: { ...SINGLE_LAN, ipv6: { enabled: false }, mandatoryDhcp: { enabled: false } },
    l3: { rules: net.mx ? l3Rules(net, vlans) : [], syslogDefaultRule: false },
    l7Rules: net.mx ? l7Rules(net) : [],
    portForwarding,
    oneToOne,
    inbound: { rules: [], syslogDefaultRule: false },
    firewalledServices: [
      { service: 'ICMP', access: 'unrestricted' },
      { service: 'web', access: 'restricted', allowedIps: [`${net.subnet(1)}.0/24`] },
      { service: 'SNMP', access: 'blocked' },
    ],
    staticRoutes:
      net.vpn === 'hub'
        ? [{ id: uuid(net.key, 'route'), ipVersion: 4, networkId: net.id, enabled: true, name: 'Lab network', subnet: '10.100.0.0/16', gatewayIp: `${net.subnet(5)}.254`, gatewayVlanId: 5, fixedIpAssignments: {}, reservedIpRanges: [] }]
        : [],
    siteToSite: net.mx ? siteToSite(net, vlans) : { mode: 'none', hubs: [], subnets: [], sgt: { enabled: false }, subnet: { nat: { isAllowed: false } } },
    contentFiltering: { allowedUrlPatterns: [], blockedUrlPatterns: ['games.example.com'], blockedUrlCategories: BLOCKED_CATEGORIES, urlCategoryListSize: 'topSites' },
    intrusion: { mode: 'prevention', idsRulesets: 'balanced', protectedNetworks: { useDefault: true } },
    malware: { mode: 'enabled', allowedUrls: [], allowedFiles: [] },
    applianceSettings: {
      clientTrackingMethod: 'MAC address',
      deploymentMode: 'routed',
      dynamicDns: { enabled: true, prefix: `acme-${net.code.toLowerCase()}`, url: `acme-${net.code.toLowerCase()}-${org.slug.toLowerCase()}.dynamic-m.com` },
    },
    groupPolicies: groupPolicies(net),
    syslog: { servers: !seeded ? [] : [{ host: syslogHost, port: 514, roles: syslogRolesFor(net).filter((r) => !/IdsAlerts|AirMarshal/.test(r.value)).map((r) => r.value), transportProtocol: 'UDP', encryption: { enabled: false } }] },
    ssids: Array.from({ length: 15 }, (_, n) => ssidJson(net, n)),
    snmp: net.vpn === 'hub' ? { access: 'users', users: [{ username: 'netmon', passphrase: 'example-passphrase' }], ...structuredClone(SNMP_V3) } : { access: 'none' },
    httpServers: servers,
    alerts: alertSettings(net, servers),
    settings: {
      localStatusPageEnabled: true,
      remoteStatusPageEnabled: false,
      localStatusPage: { authentication: { enabled: true, username: 'admin' } },
      securePort: { enabled: false },
      fips: { enabled: false },
      namedVlans: { enabled: false },
    },
    switchSettings: {
      vlan: 1,
      useCombinedPower: false,
      powerExceptions: [],
      uplinkClientSampling: { enabled: false },
      macBlocklist: { enabled: false },
      portChannelFallback: false,
      uplinkSelection: { failback: { enabled: true }, candidates: 'all' },
    },
  };
}
