#!/usr/bin/env node
// Compares the emulator against the official Meraki OpenAPI spec: every route
// must exist with the same operationId, and each sample response is checked
// for fields the spec's example has but we don't send, and fields we send
// that the spec doesn't define. Write routes are checked for path and operationId.
//
// node scripts/check-spec.js [path/to/spec3.json] [--all]
// Downloads the spec if no path is given. --all also lists the CONDITIONAL fields.

import { readFileSync } from 'node:fs';
import { ROUTES, createEmulator } from '../src/server.js';
import { sampleUrl } from '../src/samples.js';

const SPEC_URL = 'https://raw.githubusercontent.com/meraki/openapi/master/openapi/spec3.json';
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const specPath = args.find((a) => !a.startsWith('--'));
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : await (await fetch(SPEC_URL)).json();

// Fields in the spec's examples that the real API only sends in states the
// emulator's world doesn't have, or that the sample doesn't hit. Anything
// missing that isn't listed here is a gap worth filling.
const CONDITIONAL = [
  [/\.imei$/, null, 'cellular devices'],
  [/^\[\]\.uplinks\[\]\.(provider|signalStat|mcc|mnc|roaming|connectionType|apn|dns1|dns2|signalType|mtu|iccid|imsi|msisdn)$/, 'getOrganizationUplinksStatuses', 'cellular uplinks'],
  [/^\.(licenseCount|states|licenseTypes|systemsManager)$/, 'getOrganizationLicensesOverview', 'per-device licensing (Acme Test Lab)'],
  [/^\[\]\.client$/, 'getOrganizationConfigurationChanges', 'changes made by OAuth clients'],
  [/^\.communityString$/, 'getNetworkSnmp', 'community access'],
  [/^\.alerts\[\]\.filters\./, 'getNetworkAlertsSettings', 'each alert type has its own filters'],
  [/vlanTagging\.vlanId$/, /GroupPolic/, 'custom VLAN tagging'],
  [/^\.nodes\[\]\.stack$/, 'getNetworkTopologyLinkLayer', 'switch stacks'],
  [/^\.nodes\[\]\.device\.uplinks$/, 'getNetworkTopologyLinkLayer', "only in the spec's Meraki Go (GX20) example"],
  [/\.vrf$/, null, 'VRFs'],
  [/^\.wan2\.static/, 'getDeviceManagementInterface', 'a static WAN 2'],
  [/^\.accessPolicy$/, 'getNetworkAppliancePort', 'access ports (the sample is a trunk)'],
  [/^(\[\])?\.(templateVlanType|cidr|mask)$/, /ApplianceVlans?$/, 'template networks'],
  [/^(\[\])?\.dhcpRelayServerIps$/, /ApplianceVlans?$/, 'DHCP relay'],
  [/^(\[\])?\.dhcpBoot(NextServer|Filename)$/, /ApplianceVlans?$/, 'DHCP boot options'],
  [/^(\[\])?\.(vpnNatSubnet)$/, /ApplianceVlans?$/, 'VPN subnet translation'],
  [/^(\[\])?\.ipv6\.prefixAssignments$/, /ApplianceVlans?$/, 'IPv6'],
  [/^\.groupPolicyId$/, 'getNetworkApplianceVlan', 'VLANs with a group policy (the sample has none)'],
  [/\.sgt$|adaptivePolicyGroup|peerSgtCapable/, null, 'adaptive policy'],
  [/^\.hostTranslations$/, 'getNetworkApplianceVpnSiteToSiteVpn', 'MX 26.1.2 and later'],
  [/^\.subnets\[\]\.nat$/, 'getNetworkApplianceVpnSiteToSiteVpn', 'VPN subnet translation'],
  [/^\.protectedNetworks\.(included|excluded)Cidr$/, 'getNetworkApplianceSecurityIntrusion', 'custom protected networks'],
  [/\.vlanTagging\.vlanId$|\.svis\.ipv6\.|\.pppoe\.authentication$|^\.interfaces\.wan2\.svis\.ipv4\.(address|gateway)$/, 'getDeviceApplianceUplinksSettings', 'WAN tagging, IPv6, PPPoE or static addressing'],
  [/\.(schedule|accessPolicyNumber|macAllowList|macWhitelistLimit|stickyMacAllowList|stickyMacAllowListLimit|module|highSpeed)$/, /SwitchPort/, 'port schedules, other access policies, module and high-speed ports'],
  [/\.securePort\.configOverrides\./, 'getDeviceSwitchPortsStatuses', 'an active Secure Port'],
  [/\.(wlanIdentifier|enterpriseAdminAccess|radiusCalledStationId|radiusAuthenticationNasId|gre|campusGateway|localAuthFallback|namedVlans|wifiPersonalNetworkEnabled|security)$/, /WirelessSsids?$/, 'Meraki admins, enterprise admins, EoGRE, campus gateways, named VLANs or WPA3'],
  [/\.(localAuth|psk|radiusAccountingServers|walledGardenRanges|oauth|adminSplashUrl|splashTimeout|walledGardenEnabled|adultContentFilteringEnabled|dnsRewrite)$/, /WirelessSsids?$/, 'other auth, splash or IP assignment modes'],
  [/^\.policiesBySsid$/, 'getNetworkClientPolicy', 'per-SSID policies (the sample has a group policy)'],
  [/^\.products\.(cellularGateway|sensor|wirelessController|campusGateway|secureConnect)$|\.nextUpgrade\.(toVersion\.|strategy|predownload)/, 'getNetworkFirmwareUpgrades', 'other products, or a scheduled upgrade'],
  [/^\.products\.(switch|switchCatalyst)$/, 'getNetworkFirmwareUpgradesStagedEvents', 'a staged upgrade event (networks start with none), or Catalyst switches'],
  [/\.encryption\.certificate$/, 'getOrganizationDevicesSyslogServersByNetwork', 'encrypted syslog servers (the seeded ones are plain UDP)'],
  [/^\[\]\.destinations\.(push|sms)$/, 'getNetworkAlertsHistory', 'alerts sent to all admins or to SMS numbers (seeded settings use neither)'],
  [/^\[\]\.upgrade\.staged$/, 'getOrganizationFirmwareUpgradesByDevice', 'a staged upgrade event (networks start with none)'],
  [/^\[\]\.captureId$/, 'getNetworkWirelessClientConnectivityEvents', 'events that trigger a packet capture (the emulator triggers none)'],
  [/^\[\]\.clientId$/, 'getNetworkSwitchDhcpV4ServersSeen', 'discovered (client) servers only'],
  [/^\.rtspUrl$/, 'getDeviceCameraVideoSettings', 'external RTSP turned on (cameras start with it off)'],
  [/^\.(spareSerial|uplinkMode)$/, 'getNetworkApplianceWarmSpare', 'warm spare enabled with a second MX'],
  [/^\.spareSerial$/, 'getDeviceSwitchWarmSpare', 'switch warm spare enabled (switches start without one)'],
  [/^\.wan[12]$/, 'getNetworkApplianceWarmSpare', 'warm spare in virtual uplink mode, wan2 only on a primary with two WANs'],
  [/^\.routerId$/, 'getNetworkApplianceVpnBgp', 'a router ID set through the PUT (networks start without one)'],
  [/^\.md5AuthenticationKey$/, 'getNetworkSwitchRoutingOspf', 'MD5 authentication turned on (OSPF starts with it off)'],
  [/^\.(major|minor)$/, 'getNetworkWirelessBluetoothSettings', "'Non-unique' major and minor assignment (networks start in 'Unique' mode)"],
  [/\.ports\[\]\.pskGroupId$/, /WirelessEthernetPortsProfiles?$/, 'a PSK group set on a port (the default profile has none)'],
];

function conditional(op, field) {
  return CONDITIONAL.some(([re, ops]) => re.test(field) && (ops == null || (typeof ops === 'string' ? ops === op : ops.test(op))));
}

// Folds every item of a list into one object, so a field only some items carry
// (beaconIdParams on APs, psk on PSK SSIDs) still counts as present.
function mergeItems(items) {
  const present = items.filter((x) => x != null);
  const objects = present.filter((x) => typeof x === 'object' && !Array.isArray(x));
  if (!objects.length || objects.length < present.length) return present[0] ?? items[0];
  const out = {};
  for (const k of new Set(objects.flatMap(Object.keys))) {
    const values = objects.filter((o) => k in o).map((o) => o[k]);
    out[k] = values.every(Array.isArray) ? values.flat() : mergeItems(values);
  }
  return out;
}

// Walks the example and schema alongside our response, collecting key differences.
function compare(ours, example, schema, at, out) {
  if (Array.isArray(ours)) {
    if (ours.length && Array.isArray(example) && example.length) compare(mergeItems(ours), example[0], schema?.items, `${at}[]`, out);
    return;
  }
  if (!ours || typeof ours !== 'object' || !example || typeof example !== 'object' || Array.isArray(example)) return;
  const props = schema?.properties || {};
  // Maps keyed by number (SSIDs, ports) hold the same shape under every key,
  // so all our entries are checked against the example's first one.
  const numbered = (o) => Object.keys(o).length > 0 && Object.keys(o).every((k) => /^\d+$/.test(k));
  if (numbered(ours) && numbered(example)) {
    const k = Object.keys(example)[0];
    compare(mergeItems(Object.values(ours)), example[k], props[k], `${at}.${k}`, out);
    return;
  }
  const free = schema?.additionalProperties;
  for (const k of Object.keys(example)) if (!(k in ours) && !free) out.missing.push(`${at}.${k}`);
  for (const k of Object.keys(ours)) {
    if (!(k in example) && !(k in props) && !free) out.extra.push(`${at}.${k}`);
    else compare(ours[k], example[k] ?? null, props[k], `${at}.${k}`, out);
  }
}

const emulator = createEmulator({ rateLimit: 0 });
await new Promise((r) => emulator.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${emulator.server.address().port}/api/v1`;
let problems = 0;
let skipped = 0;
for (const route of ROUTES) {
  const op = spec.paths[route.path]?.[route.method.toLowerCase()];
  if (!op) {
    console.log(`${route.method} ${route.path}: not in the spec`);
    problems++;
    continue;
  }
  if (op.operationId !== route.op) {
    console.log(`${route.method} ${route.path}: operationId is ${op.operationId}, not ${route.op}`);
    problems++;
  }
  // Writes change state, so only reads get their responses compared.
  if (route.method !== 'GET') continue;
  const expected = route.sample?.status ?? route.status ?? 200;
  const url = sampleUrl(route, emulator.world, Date.now() / 1000);
  const res = await fetch(base + url, { headers: { 'X-Cisco-Meraki-API-Key': 'spec-check' } });
  if (res.status !== expected) {
    console.log(`${route.op}: sample ${url} answered ${res.status}`);
    problems++;
    continue;
  }
  if (res.status !== (route.status ?? 200)) continue;
  const content = (op.responses[res.status] || op.responses['200'] || op.responses['201'])?.content?.['application/json'];
  const out = { missing: [], extra: [] };
  compare(await res.json(), content?.example, content?.schema, '', out);
  const skip = out.missing.filter((f) => conditional(route.op, f));
  skipped += skip.length;
  if (!showAll) out.missing = out.missing.filter((f) => !skip.includes(f));
  if (out.missing.length || out.extra.length) {
    console.log(`${route.op}`);
    if (out.missing.length) console.log(`  missing: ${out.missing.join(', ')}`);
    if (out.extra.length) console.log(`  not in spec: ${out.extra.join(', ')}`);
  }
}
emulator.server.close();
console.log(`${ROUTES.length} routes checked against spec ${spec.info.version}, ${problems} broken`);
if (skipped && !showAll) console.log(`${skipped} conditional fields not shown, see CONDITIONAL or pass --all`);
process.exitCode = problems ? 1 : 0;
