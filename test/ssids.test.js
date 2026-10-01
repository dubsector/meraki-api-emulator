import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('SSID settings', () => {
  let sb;
  let org;
  let hq;
  let S;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs[0];
    hq = org.networks[0];
    S = `/networks/${hq.id}/wireless/ssids`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };

  // The request examples from the spec, which every endpoint has to take.
  const EXAMPLES = {
    bonjourForwarding: { enabled: true, rules: [{ description: 'A simple bonjour rule', vlanId: '1', services: ['All Services'] }], exception: { enabled: true } },
    deviceTypeGroupPolicies: { enabled: true, deviceTypePolicies: [{ deviceType: 'Android', devicePolicy: 'Allowed' }, { deviceType: 'iPhone', devicePolicy: 'Group policy', groupPolicyId: 101 }] },
    eapOverride: { timeout: 5, identity: { retries: 5, timeout: 5 }, maxRetries: 5, eapolKey: { retries: 5, timeoutInMs: 5000 } },
    hotspot20: {
      enabled: true,
      operator: { name: 'Meraki Product Management' },
      venue: { name: 'SF Branch', type: 'Unspecified Assembly' },
      networkAccessType: 'Private network',
      domains: ['meraki.local', 'domain2.com'],
      roamConsortOis: ['ABC123', '456EFG'],
      mccMncs: [{ mcc: '123', mnc: '456' }],
      naiRealms: [{ format: '1', realm: 'Realm 1', methods: [{ id: '1', authenticationTypes: { nonEapInnerAuthentication: ['MSCHAP'], eapInnerAuthentication: ['EAP-TTLS with MSCHAPv2'], credentials: [], tunneledEapMethodCredentials: [] } }] }],
    },
    schedules: { enabled: true, ranges: [{ startDay: 'Tuesday', startTime: '01:00', endDay: 'Tuesday', endTime: '05:00' }], rangesInSeconds: [{ start: 604800, end: 0 }] },
    'trafficShaping/rules': { trafficShapingEnabled: true, defaultRulesEnabled: true, rules: [{ definitions: [{ type: 'host', value: 'google.com' }], perClientBandwidthLimits: { settings: 'custom', bandwidthLimits: { limitUp: 1000000, limitDown: 1000000 } }, dscpTagValue: 0, pcpTagValue: 0 }] },
    vpn: { splitTunnel: { enabled: true, rules: [{ protocol: 'Any', destCidr: '1.1.1.1/32', destPort: 'any', policy: 'allow', comment: 'split tunnel rule 1' }] }, failover: { requestIp: '192.0.2.1', heartbeatInterval: 10, idleTimeout: 30 } },
  };

  test('each setting takes its GET back unchanged, then the spec example', async () => {
    fresh();
    for (const [name, example] of Object.entries(EXAMPLES)) {
      const path = `${S}/0/${name}`;
      const before = await sb.get(path);
      assert.equal(before.status, 200, name);
      const same = await sb.put(path, before.body);
      assert.equal(same.status, 200, `${name}: ${JSON.stringify(same.body)}`);
      assert.deepEqual(same.body, before.body, name);
      const put = await sb.put(path, example);
      assert.equal(put.status, 200, `${name}: ${JSON.stringify(put.body)}`);
      assert.notDeepEqual(put.body, before.body, name);
      assert.deepEqual((await sb.get(path)).body, put.body, name);
      // Only that SSID changed.
      assert.deepEqual((await sb.get(`${S}/1/${name}`)).body, before.body, name);
    }
  });

  test('settings start from their defaults and a reset brings them back', async () => {
    fresh();
    assert.deepEqual((await sb.get(`${S}/0/bonjourForwarding`)).body, { enabled: false, exception: { enabled: false }, rules: [] });
    assert.deepEqual((await sb.get(`${S}/0/eapOverride`)).body, { timeout: 5, maxRetries: 5, identity: { retries: 5, timeout: 5 }, eapolKey: { retries: 4, timeoutInMs: 5000 } });
    assert.deepEqual((await sb.get(`${S}/2/identityPsks`)).body, []);
    await sb.put(`${S}/0/bonjourForwarding`, EXAMPLES.bonjourForwarding);
    await sb.reset();
    fresh();
    assert.equal((await sb.get(`${S}/0/bonjourForwarding`)).body.enabled, false);
    // Unknown SSID numbers and networks without wireless are refused like the other SSID endpoints.
    assert.equal((await sb.get(`${S}/15/schedules`)).status, 404);
    const created = await sb.post(`/organizations/${org.id}/networks`, { name: 'Wired only', productTypes: ['switch'] });
    assert.equal((await sb.get(`/networks/${created.body.id}/wireless/ssids/0/vpn`)).status, 400);
  });

  test('identity PSKs only work on SSIDs that keep their keys in Dashboard', async () => {
    fresh();
    const list = `${S}/5/identityPsks`;
    assert.match(await errorOf(sb.post(list, { name: 'Lobby', groupPolicyId: '101' })), /ipsk-without-radius/);
    const ssid = await sb.put(`${S}/5`, { name: 'Acme-Devices', enabled: true, authMode: 'ipsk-without-radius' });
    assert.equal(ssid.status, 200, JSON.stringify(ssid.body));
    assert.equal(ssid.body.radiusServers, undefined, 'no RADIUS in this mode');
    assert.equal(ssid.body.encryptionMode, 'wpa');
    const created = await sb.post(list, { name: 'Lobby', groupPolicyId: '101' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(Object.keys(created.body), ['name', 'id', 'groupPolicyId', 'passphrase', 'wifiPersonalNetworkId', 'email', 'expiresAt']);
    assert.equal(created.body.passphrase.length, 12, 'a passphrase is made up when none is sent');
    assert.equal(created.body.expiresAt, null);
    const one = `${list}/${created.body.id}`;
    assert.deepEqual((await sb.get(one)).body, created.body);
    assert.deepEqual((await sb.get(list)).body, [created.body]);

    assert.match(await errorOf(sb.post(list, { name: 'Lobby', groupPolicyId: '101' })), /Name has already been taken/);
    assert.match(await errorOf(sb.post(list, { name: 'Kiosk', groupPolicyId: '101', passphrase: created.body.passphrase })), /Passphrase has already been taken/);
    assert.match(await errorOf(sb.post(list, { name: 'Kiosk', groupPolicyId: '999' })), /Group policy '999'/);
    assert.match(await errorOf(sb.post(list, { name: 'Kiosk', groupPolicyId: '101', passphrase: 'short' })), /8 to 63/);
    assert.match(await errorOf(sb.post(list, { name: 'Kiosk' })), /'groupPolicyId' is required/);

    const updated = await sb.put(one, { passphrase: 'lobby-screens-2026', expiresAt: '2027-01-31T00:00:00Z' });
    assert.equal(updated.body.passphrase, 'lobby-screens-2026');
    assert.equal(updated.body.expiresAt, '2027-01-31T00:00:00.000000Z');
    assert.equal((await sb.put(one, { expiresAt: null })).body.expiresAt, null);
    assert.equal((await sb.del(one)).status, 204);
    assert.equal((await sb.get(one)).status, 404);
    assert.equal((await sb.del(one)).status, 404);

    // The same calls after a reset give the same IDs.
    await sb.reset();
    fresh();
    await sb.put(`${S}/5`, { authMode: 'ipsk-without-radius' });
    assert.equal((await sb.post(list, { name: 'Lobby', groupPolicyId: '101' })).body.id, created.body.id);
  });

  test('device type policies only carry a group policy ID for Group policy', async () => {
    fresh();
    const path = `${S}/1/deviceTypeGroupPolicies`;
    const r = await sb.put(path, EXAMPLES.deviceTypeGroupPolicies);
    assert.deepEqual(r.body.deviceTypePolicies, [
      { deviceType: 'Android', devicePolicy: 'Allowed' },
      { deviceType: 'iPhone', devicePolicy: 'Group policy', groupPolicyId: 101 },
    ]);
    assert.match(await errorOf(sb.put(path, { deviceTypePolicies: [{ deviceType: 'iPad', devicePolicy: 'Group policy' }] })), /groupPolicyId' is required/);
    assert.match(await errorOf(sb.put(path, { deviceTypePolicies: [{ deviceType: 'iPad', devicePolicy: 'Group policy', groupPolicyId: 7 }] })), /does not exist/);
    assert.match(await errorOf(sb.put(path, { deviceTypePolicies: [{ deviceType: 'iPad', devicePolicy: 'Allowed' }, { deviceType: 'iPad', devicePolicy: 'Blocked' }] })), /more than one/);
    assert.match(await errorOf(sb.put(path, { deviceTypePolicies: [{ deviceType: 'Toaster', devicePolicy: 'Allowed' }] })), /must be one of/);
  });

  test('Hotspot 2.0 realms are written as realm and read back as name', async () => {
    fresh();
    const path = `${S}/0/hotspot20`;
    const put = await sb.put(path, EXAMPLES.hotspot20);
    assert.equal(put.body.naiRealms[0].name, 'Realm 1');
    assert.equal(put.body.naiRealms[0].realm, undefined);
    // A GET sent back has no realm, and the name stays.
    assert.equal((await sb.put(path, { ...put.body, enabled: false })).body.naiRealms[0].name, 'Realm 1');
    assert.match(await errorOf(sb.put(path, { venue: { type: 'Moon base' } })), /venue.type/);
    assert.match(await errorOf(sb.put(path, { mccMncs: [{ mcc: '12', mnc: '34' }] })), /mcc/);
  });

  test('EAP timers stay within their limits and merge', async () => {
    fresh();
    const path = `${S}/0/eapOverride`;
    assert.match(await errorOf(sb.put(path, { maxRetries: 9 })), /'maxRetries' must be between 1 and 5/);
    assert.match(await errorOf(sb.put(path, { eapolKey: { timeoutInMs: 9000 } })), /eapolKey.timeoutInMs/);
    const r = await sb.put(path, { identity: { timeout: 30 } });
    assert.deepEqual(r.body.identity, { retries: 5, timeout: 30 });
  });

  test('OpenRoaming needs a tenant ID to turn on', async () => {
    fresh();
    const path = `${S}/0/openRoaming`;
    assert.match(await errorOf(sb.put(path, { enabled: true })), /tenantId/);
    assert.deepEqual((await sb.put(path, { enabled: true, tenantId: '12345' })).body, { enabled: true, tenantId: '12345' });
    assert.deepEqual((await sb.put(path, { enabled: false })).body, { enabled: false, tenantId: '12345' });
    assert.equal((await sb.get(path)).status, 405, 'the spec has no GET for it');
  });

  test('outage schedules keep both range lists in step', async () => {
    fresh();
    const path = `${S}/0/schedules`;
    const days = await sb.put(path, { enabled: true, ranges: [{ startDay: 'tue', startTime: '1:00', endDay: 'Tue', endTime: '05:30' }] });
    assert.deepEqual(days.body.ranges, [{ startDay: 'Tuesday', startTime: '01:00', endDay: 'Tuesday', endTime: '05:30' }]);
    assert.deepEqual(days.body.rangesInSeconds, [{ start: 2 * 86400 + 3600, end: 2 * 86400 + 19800 }]);
    const seconds = await sb.put(path, { rangesInSeconds: [{ start: 6 * 86400, end: 7 * 86400 }] });
    assert.deepEqual(seconds.body.ranges, [{ startDay: 'Saturday', startTime: '00:00', endDay: 'Saturday', endTime: '24:00' }]);
    assert.equal(seconds.body.enabled, true);
    assert.match(await errorOf(sb.put(path, { ranges: [{ startDay: 'Someday', startTime: '01:00', endDay: 'Tuesday', endTime: '05:00' }] })), /startDay/);
    assert.match(await errorOf(sb.put(path, { ranges: [{ startDay: 'Monday', startTime: '25:00', endDay: 'Tuesday', endTime: '05:00' }] })), /startTime/);
    assert.match(await errorOf(sb.put(path, { rangesInSeconds: [{ start: 0, end: 700000 }] })), /rangesInSeconds\[0\].end/);
  });

  test('traffic shaping counts the default rules toward the limit of eight', async () => {
    fresh();
    const path = `${S}/1/trafficShaping/rules`;
    const rule = { definitions: [{ type: 'port', value: '443' }] };
    assert.match(await errorOf(sb.put(path, { rules: Array(5).fill(rule) })), /at most 8/);
    const r = await sb.put(path, { defaultRulesEnabled: false, rules: Array(8).fill(rule) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rules[0], { definitions: [{ type: 'port', value: '443' }], perClientBandwidthLimits: { settings: 'network default' }, dscpTagValue: null, pcpTagValue: null });
    assert.match(await errorOf(sb.put(path, { defaultRulesEnabled: true })), /at most 8/);
    assert.match(await errorOf(sb.put(path, { rules: [{ definitions: [] }] })), /at least one definition/);
    assert.match(await errorOf(sb.put(path, { rules: [{ definitions: [{ type: 'port', value: '70000' }] }] })), /port/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, pcpTagValue: 9 }] })), /pcpTagValue/);
  });

  test('the SSID VPN concentrator has to be an appliance network in the organization', async () => {
    fresh();
    const path = `${S}/0/vpn`;
    const austin = org.networks.find((n) => n.name === 'Branch - Austin');
    const r = await sb.put(path, { concentrator: { networkId: austin.id, vlanId: 44 }, splitTunnel: { rules: [{ destCidr: '192.0.2.0/24', policy: 'Deny' }] } });
    assert.deepEqual(r.body.concentrator, { networkId: austin.id, vlanId: 44, name: 'Branch - Austin' });
    assert.deepEqual(r.body.splitTunnel.rules, [{ protocol: 'Any', destCidr: '192.0.2.0/24', destPort: 'any', policy: 'deny', comment: '' }]);
    // The name follows the network.
    await sb.put(`/networks/${austin.id}`, { name: 'Austin Office' });
    assert.equal((await sb.get(path)).body.concentrator.name, 'Austin Office');
    const lab = sb.world.orgs[1].networks[0];
    assert.match(await errorOf(sb.put(path, { concentrator: { networkId: lab.id } })), /security appliance/);
    assert.match(await errorOf(sb.put(path, { concentrator: { vlanId: 5000 } })), /vlanId/);
    assert.match(await errorOf(sb.put(path, { splitTunnel: { rules: [{ destCidr: 'any', policy: 'maybe' }] } })), /allow or deny/);
  });
});
