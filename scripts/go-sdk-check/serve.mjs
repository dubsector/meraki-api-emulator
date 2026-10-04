// Starts an emulator for main.go and prints its base URL and a sample URL for
// every GET route as one JSON line. Stops when stdin closes.
//
// Reads of one created item (a branding policy, a stack) have nothing to find
// in the default world, so STEPS creates each through the API first and points
// the samples at it.
import { createEmulator, ROUTES } from '../../src/server.js';
import { sampleUrl } from '../../src/samples.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const CALLBACK = { url: 'https://hooks.example.net/callback', sharedSecret: 'go-sdk-check' };

// Each step names the GET of the item it makes. The item is posted to that
// sample's parent path unless `at` gives another, and its ID is read from `id`
// (default: the GET's last path parameter, then `id`). `body` can be a
// function of the step context. `use` replaces the sample outright, and `keep`
// leaves it as it is.
const STEPS = [
  { get: '/devices/{serial}/liveTools/arpTable/{arpTableId}', body: {} },
  { get: '/devices/{serial}/liveTools/cableTest/{id}', body: { ports: ['1'] }, id: 'cableTestId' },
  { get: '/devices/{serial}/liveTools/leds/blink/{ledsBlinkId}', body: { duration: 5 } },
  { get: '/devices/{serial}/liveTools/ping/{id}', body: { target: '8.8.8.8' }, id: 'pingId' },
  { get: '/devices/{serial}/liveTools/pingDevice/{id}', body: {}, id: 'pingId' },
  { get: '/devices/{serial}/liveTools/throughputTest/{throughputTestId}', body: {} },
  { get: '/devices/{serial}/liveTools/wakeOnLan/{wakeOnLanId}', body: { vlanId: 1, mac: '00:11:22:33:44:55' } },
  { get: '/organizations/{organizationId}/webhooks/callbacks/statuses/{callbackId}', at: (c) => c.parent('/devices/{serial}/liveTools/ping/{id}'), body: { target: '8.8.8.8', callback: CALLBACK }, id: (r) => r.callback.id },
  { get: '/devices/{serial}/sensor/commands/{commandId}', body: { operation: 'refreshData' } },
  { get: '/devices/{serial}/switch/routing/interfaces/{interfaceId}', body: { name: 'Go', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' } },
  { get: '/devices/{serial}/switch/routing/staticRoutes/{staticRouteId}', body: { subnet: '198.51.100.0/24', nextHopIp: '192.0.2.10' } },
  { get: '/networks/{networkId}/switch/routing/multicast/rendezvousPoints/{rendezvousPointId}', body: { interfaceIp: '192.0.2.2', multicastGroup: 'Any' } },
  { get: '/networks/{networkId}/appliance/prefixes/delegated/statics/{staticDelegatedPrefixId}', body: { prefix: '2001:db8:1::/48', origin: { type: 'internet', interfaces: ['wan1'] } } },
  { get: '/networks/{networkId}/appliance/rfProfiles/{rfProfileId}', body: { name: 'Go' } },
  { get: '/networks/{networkId}/appliance/trafficShaping/customPerformanceClasses/{customPerformanceClassId}', body: { name: 'Go' } },
  { get: '/networks/{networkId}/camera/qualityRetentionProfiles/{qualityRetentionProfileId}', body: { name: 'Go' } },
  { get: '/networks/{networkId}/camera/wirelessProfiles/{wirelessProfileId}', body: { name: 'Go', ssid: { name: 'go-cams', authMode: 'psk', psk: 'go-sdk-check' } } },
  { get: '/networks/{networkId}/firmwareUpgrades/staged/groups/{groupId}', body: { name: 'Go', isDefault: false } },
  { get: '/networks/{networkId}/floorPlans/{floorPlanId}', body: { name: 'Go', imageContents: PNG, center: { lat: 37.77, lng: -122.42 } } },
  { get: '/networks/{networkId}/merakiAuthUsers/{merakiAuthUserId}', body: { email: 'go@example.com', name: 'Go', password: 'go-sdk-check-1', accountType: 'Client VPN', authorizations: [{ expiresAt: 'Never' }] } },
  { get: '/networks/{networkId}/mqttBrokers/{mqttBrokerId}', body: { name: 'Go', host: 'mqtt.example.com', port: 8883 } },
  { get: '/networks/{networkId}/sensor/mqttBrokers/{mqttBrokerId}', at: (c) => c.parent('/networks/{networkId}/sensor/mqttBrokers/{mqttBrokerId}').replace('/sensor/', '/'), body: { name: 'Go', host: 'mqtt.example.com', port: 8883 } },
  { get: '/networks/{networkId}/pii/requests/{requestId}', body: { type: 'restrict processing', mac: '00:11:22:33:44:55' } },
  { get: '/networks/{networkId}/sensor/alerts/profiles/{id}', body: { name: 'Go', conditions: [{ metric: 'temperature', threshold: { temperature: { celsius: 30 } }, direction: 'above' }] }, id: 'profileId' },
  { get: '/networks/{networkId}/sm/bypassActivationLockAttempts/{attemptId}', body: async (c) => ({ ids: [(await c.api('GET', c.parent('/networks/{networkId}/sm/bypassActivationLockAttempts/{attemptId}').replace('bypassActivationLockAttempts', 'devices'))).body[0].id] }) },
  { get: '/networks/{networkId}/sm/targetGroups/{targetGroupId}', body: { name: 'Go', scope: 'all' } },
  { get: '/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}', body: { name: 'Go', radiusServers: [{ host: '192.0.2.50', port: 1812, secret: 'go-sdk-check' }], radiusTestingEnabled: false, radiusCoaSupportEnabled: false, radiusAccountingEnabled: false, hostMode: 'Single-Host', urlRedirectWalledGardenEnabled: false } },
  { get: '/networks/{networkId}/switch/qosRules/{qosRuleId}', body: { vlan: 10, dscp: 0 } },
  { get: '/networks/{networkId}/switch/stacks/{switchStackId}', body: (c) => ({ name: 'Go', serials: c.world.orgs[0].networks[0].switches.filter((s) => s.model.startsWith('MS250')).map((s) => s.serial) }) },
  { get: '/networks/{networkId}/switch/stacks/{switchStackId}/routing/interfaces/{interfaceId}', body: { name: 'Go', vlanId: 20, subnet: '198.51.100.0/24', interfaceIp: '198.51.100.2', defaultGateway: '198.51.100.1' } },
  { get: '/networks/{networkId}/switch/stacks/{switchStackId}/routing/staticRoutes/{staticRouteId}', body: { subnet: '203.0.113.0/24', nextHopIp: '198.51.100.10' } },
  { get: '/networks/{networkId}/vlanProfiles/{iname}', body: { iname: 'Go', name: 'Go', vlanNames: [{ name: 'default', vlanId: '1' }], vlanGroups: [] }, id: 'iname' },
  { get: '/networks/{networkId}/webhooks/webhookTests/{webhookTestId}', body: { url: 'https://hooks.example.net/in' }, id: 'id' },
  { get: '/networks/{networkId}/wireless/ethernet/ports/profiles/{profileId}', body: { name: 'Go', ports: [] } },
  { get: '/networks/{networkId}/wireless/ssids/{number}/identityPsks/{identityPskId}', body: async (c) => {
    const ssid = c.parent('/networks/{networkId}/wireless/ssids/{number}/identityPsks/{identityPskId}').replace(/\/identityPsks$/, '');
    await c.api('PUT', ssid, { authMode: 'ipsk-without-radius' });
    return { name: 'Go', groupPolicyId: '101', passphrase: 'go-sdk-check' };
  }, id: 'id' },
  { get: '/organizations/{organizationId}/actionBatches/{actionBatchId}', body: (c) => ({ confirmed: false, actions: [{ resource: `${c.parent('/organizations/{organizationId}/actionBatches/{actionBatchId}').replace('/actionBatches', '')}/policyObjects`, operation: 'create', body: { name: 'Go', category: 'network', type: 'cidr', cidr: '10.9.0.0/24' } }] }), id: 'id' },
  { get: '/organizations/{organizationId}/adaptivePolicy/acls/{aclId}', body: { name: 'Go', ipVersion: 'ipv4', rules: [{ policy: 'allow', protocol: 'any' }] } },
  { get: '/organizations/{organizationId}/adaptivePolicy/groups/{id}', body: { name: 'Go', sgt: 41 }, id: 'groupId' },
  { get: '/organizations/{organizationId}/adaptivePolicy/policies/{id}', body: async (c) => {
    const groups = (await c.api('GET', c.parent('/organizations/{organizationId}/adaptivePolicy/policies/{id}').replace('policies', 'groups'))).body;
    return { sourceGroup: { id: groups[0].groupId }, destinationGroup: { id: groups[1].groupId } };
  }, id: 'adaptivePolicyId' },
  { get: '/organizations/{organizationId}/brandingPolicies/{brandingPolicyId}', body: { name: 'Go', enabled: true, adminSettings: { appliesTo: 'All organization admins' } } },
  { get: '/organizations/{organizationId}/camera/customAnalytics/artifacts/{artifactId}', body: { name: 'Go' } },
  { get: '/organizations/{organizationId}/camera/roles/{roleId}', body: { name: 'Go' }, id: 'id' },
  { get: '/organizations/{organizationId}/configTemplates/{configTemplateId}', body: (c) => ({ name: 'Go', copyFromNetworkId: c.world.orgs[0].networks[0].id }), id: 'id' },
  { get: '/organizations/{organizationId}/configTemplates/{configTemplateId}/switch/profiles/{profileId}/ports/{portId}', list: '/organizations/{organizationId}/configTemplates/{configTemplateId}/switch/profiles', id: 'switchProfileId', fake: '/switch/profiles/1' },
  { get: '/organizations/{organizationId}/earlyAccess/features/optIns/{optInId}', body: async (c) => ({ shortName: (await c.api('GET', c.parent('/organizations/{organizationId}/earlyAccess/features/optIns/{optInId}').replace('/optIns', ''))).body[0].shortName }), id: 'id' },
  { get: '/organizations/{organizationId}/insight/monitoredMediaServers/{monitoredMediaServerId}', body: { name: 'Go', address: 'sip.example.com' }, id: 'id' },
  { get: '/organizations/{organizationId}/policyObjects/{policyObjectId}', body: { name: 'Go', category: 'network', type: 'cidr', cidr: '10.5.0.0/24' }, id: 'id' },
  { get: '/organizations/{organizationId}/policyObjects/groups/{policyObjectGroupId}', body: { name: 'Go' }, id: 'id' },
  { get: '/organizations/{organizationId}/saml/idps/{idpId}', body: { x509certSha1Fingerprint: '00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99' } },
  { get: '/organizations/{organizationId}/samlRoles/{samlRoleId}', body: { role: 'Go', orgAccess: 'read-only' }, id: 'id' },
  { get: '/organizations/{organizationId}/sm/admins/roles/{roleId}', body: { name: 'Go', scope: 'all_tags', tags: ['go'] } },
  { get: '/organizations/{organizationId}/inventory/devices/swaps/bulk/{id}', body: (c) => {
    const org = c.world.orgs[0];
    // Not the first camera, which the camera samples read.
    const old = org.networks[0].cameras.at(-1);
    const spare = org.spares.find((d) => d.productType === 'camera');
    return { swaps: [{ devices: { old: old.serial, new: spare.serial }, afterAction: 'remove from network' }] };
  }, id: 'jobId' },
  // Every network starts with VLANs on, so this reads Branch - Austin with them off.
  { get: '/networks/{networkId}/appliance/singleLan', method: 'PUT', at: (c) => `/networks/${c.world.orgs[0].networks[1].id}/appliance/vlans/settings`, body: { vlansEnabled: false }, use: (c) => `/networks/${c.world.orgs[0].networks[1].id}/appliance/singleLan` },
  // The sample already names this account; it only has to exist.
  { get: '/organizations/{organizationId}/cellularGateway/esims/serviceProviders/accounts/communicationPlans', at: (c) => c.parent('/organizations/{organizationId}/cellularGateway/esims/serviceProviders/accounts/communicationPlans'), body: { accountId: '0987654321', apiKey: 'go-sdk-check', serviceProvider: { name: 'Verizon' }, title: 'Go', username: 'go' }, keep: true },
];

const emu = createEmulator({ rateLimit: 0 });
await new Promise((r) => emu.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${emu.server.address().port}`;
const now = Date.now() / 1000;
const samples = {};
for (const route of ROUTES.filter((r) => r.method === 'GET')) {
  try {
    samples[route.path] = sampleUrl(route, emu.world, now);
  } catch {
    // Routes whose sample needs state the world doesn't have yet.
  }
}

const api = async (method, path, body) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'X-Cisco-Meraki-API-Key': 'go-sdk-check', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const pathOf = (url) => url.split('?')[0];
const parent = (get) => pathOf(samples[get]).split('/').slice(0, -1).join('/');
// Points every sample under `fake` at `real` instead.
const repoint = (fake, real) => {
  for (const [p, url] of Object.entries(samples)) {
    if (url === fake || url.startsWith(fake + '/') || url.startsWith(fake + '?')) samples[p] = real + url.slice(fake.length);
  }
};
const ctx = { world: emu.world, api, parent };
const setupErrors = [];
for (const step of STEPS) {
  try {
    if (!samples[step.get]) throw new Error('no sample');
    if (step.list) {
      const at = pathOf(samples[step.get]);
      const listPath = at.slice(0, at.indexOf(step.fake));
      const res = await api('GET', listPath.replace(/\/switch$/, '') + step.fake.replace(/\/\w+$/, ''));
      const id = res.body?.[0]?.[step.id];
      if (res.status !== 200 || id == null) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
      repoint(listPath + step.fake, `${listPath}${step.fake.replace(/\/\w+$/, '')}/${id}`);
      continue;
    }
    const body = typeof step.body === 'function' ? await step.body(ctx) : step.body;
    const res = await api(step.method || 'POST', step.at ? step.at(ctx) : parent(step.get), body);
    if (res.status >= 300) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    if (step.use) samples[step.get] = step.use(ctx);
    if (step.keep || step.use) continue;
    const field = step.id ?? step.get.match(/\{(\w+)\}$/)[1];
    const id = typeof field === 'function' ? field(res.body) : res.body[field] ?? res.body.id;
    if (id == null) throw new Error(`no ${field} in ${JSON.stringify(res.body).slice(0, 200)}`);
    const fake = pathOf(samples[step.get]);
    repoint(fake, `${fake.split('/').slice(0, -1).join('/')}/${encodeURIComponent(id)}`);
  } catch (e) {
    setupErrors.push(`${step.get}: ${e.message.slice(0, 300)}`);
  }
}
console.log(JSON.stringify({ base, samples, setupErrors }));
process.stdin.on('end', () => process.exit(0)).resume();
