import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('switch ACLs, access policies and QoS', () => {
  let sb;
  let hq;
  let core;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    hq = sb.world.orgs[0].networks[0];
    [core] = hq.switches;
  };
  const N = () => `/networks/${hq.id}/switch`;
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const errorOf = async (r) => (await ok(r, 400)).errors[0];
  const POLICY = { name: 'Staff 802.1X', radiusServers: [{ host: '192.0.2.10', port: 1812, secret: 'shh' }], radiusAccountingEnabled: false };

  test('ACL rules keep their order with the default rule last', async () => {
    fresh();
    const A = `${N()}/accessControlLists`;
    const start = await ok(sb.get(A));
    assert.equal(start.rules.length, 1);
    assert.deepEqual(start.rules[0], { comment: 'Default rule', policy: 'allow', ipVersion: 'any', protocol: 'any', srcCidr: 'any', srcPort: 'any', dstCidr: 'any', dstPort: 'any', vlan: 'any' });
    const rules = [
      { comment: 'Deny SSH', policy: 'deny', protocol: 'tcp', srcCidr: '10.1.10.0/24', dstCidr: '172.16.30.0/24', dstPort: '22', vlan: '10' },
      { policy: 'allow', ipVersion: 'ipv6', protocol: 'udp', srcCidr: '2001:db8::/32', dstCidr: 'Any', srcPort: '53' },
    ];
    const put = await ok(sb.put(A, { rules }));
    assert.deepEqual(put, await ok(sb.get(A)));
    assert.equal(put.rules.length, 3);
    assert.deepEqual(put.rules[0], { ...rules[0], ipVersion: 'ipv4', srcPort: 'any' });
    assert.deepEqual(put.rules[1], { comment: '', policy: 'allow', ipVersion: 'ipv6', protocol: 'udp', srcCidr: '2001:db8::/32', srcPort: '53', dstCidr: 'any', dstPort: 'any', vlan: 'any' });
    // Sending back what was read doesn't add a second default rule.
    assert.deepEqual(await ok(sb.put(A, put)), put);
    assert.deepEqual((await ok(sb.put(A, { rules: [] }))).rules, start.rules);

    const bad = (r) => errorOf(sb.put(A, { rules: [{ policy: 'deny', protocol: 'tcp', srcCidr: 'any', dstCidr: 'any', ...r }] }));
    assert.match(await bad({ srcCidr: '10.0.0.0/33' }), /rules\[0\]\.srcCidr' must be 'any' or an IPv4/);
    assert.match(await bad({ dstCidr: '2001:db8::1' }), /IPv4 address/);
    assert.match(await bad({ ipVersion: 'ipv6', dstCidr: '10.0.0.1' }), /IPv6 address/);
    assert.match(await bad({ dstPort: '70000' }), /port from 1 to 65535/);
    assert.match(await bad({ protocol: 'any', srcPort: '80' }), /needs 'protocol' to be 'tcp' or 'udp'/);
    assert.match(await bad({ vlan: '4096' }), /VLAN from 1 to 4095/);
    assert.match(await bad({ policy: 'block' }), /policy/);
    assert.match(await errorOf(sb.put(A, {})), /'rules' is required/);
    assert.match(await errorOf(sb.get(`/networks/${sb.world.orgs[1].networks[0].id}/switch/accessControlLists`)), /product type 'switch'/);
  });

  test('access policies are numbered, hide RADIUS secrets and keep server IDs', async () => {
    fresh();
    const P = `${N()}/accessPolicies`;
    assert.deepEqual(await ok(sb.get(P)), []);
    const p = await ok(sb.post(P, POLICY), 201);
    assert.equal(p.accessPolicyNumber, '1');
    assert.deepEqual(p.radiusServers, [{ serverId: '1', organizationRadiusServerId: '', host: '192.0.2.10', port: 1812 }]);
    assert.equal(JSON.stringify(p).includes('shh'), false);
    assert.deepEqual([p.hostMode, p.accessPolicyType, p.dot1x.controlDirection, p.radius.authentication.mode, p.counts.ports.withThisPolicy], ['Single-Host', '802.1x', 'both', 'Open', 0]);
    assert.deepEqual(await ok(sb.get(`${P}/1`)), p);
    assert.deepEqual(await ok(sb.get(P)), [p]);

    // A server named by ID is updated in place and keeps its secret; others are new.
    const put = await ok(sb.put(`${P}/1`, { radiusServers: [{ serverId: '1', port: 1645 }, { host: '192.0.2.11', secret: 'two' }], radiusAccountingEnabled: true, radiusAccountingServers: [{ host: '192.0.2.12', secret: 'acct' }] }));
    assert.deepEqual(put.radiusServers.map((s) => [s.serverId, s.host, s.port]), [['1', '192.0.2.10', 1645], ['2', '192.0.2.11', 1812]]);
    assert.deepEqual(put.radiusAccountingServers.map((s) => [s.serverId, s.port]), [['3', 1813]]);
    assert.deepEqual(await ok(sb.get(`${P}/1`)), put);

    // Multi-Domain implies hybrid authentication; Multi-Auth drops the VLAN fallbacks.
    const md = await ok(sb.put(`${P}/1`, { hostMode: 'Multi-Domain', increaseAccessSpeed: true, radius: { failedAuthVlanId: 99 } }));
    assert.deepEqual([md.accessPolicyType, md.voiceVlanClients, md.increaseAccessSpeed, md.radius.failedAuthVlanId], ['Hybrid authentication', true, true, 99]);
    const ma = await ok(sb.put(`${P}/1`, { hostMode: 'Multi-Auth' }));
    assert.equal(ma.radius.failedAuthVlanId, null);
    assert.equal(ma.radius.cache.enabled, false);

    // Meraki authentication (no RADIUS servers) is kept but not listed.
    const meraki = await ok(sb.post(P, { name: 'Cloud auth', radiusServers: [], radiusAccountingEnabled: false }), 201);
    assert.equal(meraki.accessPolicyNumber, '2');
    assert.deepEqual((await ok(sb.get(P))).map((x) => x.accessPolicyNumber), ['1']);
    assert.equal((await ok(sb.get(`${P}/2`))).name, 'Cloud auth');
    assert.equal((await sb.del(`${P}/2`)).status, 204);
    assert.equal((await sb.get(`${P}/2`)).status, 404);
    // Numbers aren't reused.
    assert.equal((await ok(sb.post(P, POLICY), 201)).accessPolicyNumber, '3');
  });

  test('access policy bodies are checked before anything changes', async () => {
    fresh();
    const P = `${N()}/accessPolicies`;
    const bad = (b) => errorOf(sb.post(P, { ...POLICY, ...b }));
    assert.match(await bad({ name: ' ' }), /'name' must not be empty/);
    assert.match(await bad({ name: 'x'.repeat(256) }), /at most 255/);
    assert.match(await bad({ radiusServers: [{ host: 'radius.example.com', secret: 's' }] }), /radiusServers\[0\]\.host' must be an IP address/);
    assert.match(await bad({ radiusServers: [{ host: '192.0.2.1' }] }), /secret' is required/);
    assert.match(await bad({ radiusServers: [{ host: '192.0.2.1', secret: 's', port: 0 }] }), /port' must be an integer between 1 and 65535/);
    assert.match(await bad({ radiusServers: [{ organizationRadiusServerId: '42' }] }), /Organization RADIUS server '42' does not exist/);
    assert.match(await bad({ radiusAccountingEnabled: true }), /at least one server/);
    assert.match(await bad({ guestVlanId: 4095 }), /guestVlanId' must be a VLAN/);
    assert.match(await bad({ radius: { criticalAuth: { dataVlanId: 0 } } }), /criticalAuth\.dataVlanId/);
    assert.match(await bad({ guestGroupPolicyId: '999' }), /group policy '999' does not exist/);
    assert.match(await bad({ radius: { cache: { enabled: true } } }), /cache\.timeout' is required/);
    assert.match(await bad({ radius: { cache: { enabled: true, timeout: 25 } } }), /between 1 and 24/);
    assert.match(await bad({ radiusGroupAttribute: '12' }), /'' or '11'/);
    assert.match(await bad({ urlRedirectWalledGardenRanges: ['not a range'] }), /urlRedirectWalledGardenRanges\[0\]/);
    assert.match(await bad({ increaseAccessSpeed: true }), /Hybrid authentication/);
    assert.match(await bad({ hostMode: 'Any-Host' }), /hostMode/);
    // None of those used up a number or a server ID.
    const p = await ok(sb.post(P, POLICY), 201);
    assert.deepEqual([p.accessPolicyNumber, p.radiusServers[0].serverId], ['1', '1']);
    assert.match(await errorOf(sb.put(`${P}/1`, { radiusServers: [{ serverId: '9', host: '192.0.2.1', secret: 's' }] })), /not one of this policy's servers/);
    // Nulls don't clear lists or flags, but do clear optional VLANs.
    const kept = await ok(sb.put(`${P}/1`, { urlRedirectWalledGardenRanges: null, dot1x: null, guestPortBouncing: null, guestVlanId: 30 }));
    assert.deepEqual([kept.urlRedirectWalledGardenRanges, kept.dot1x, kept.guestPortBouncing, kept.guestVlanId], [[], { controlDirection: 'both' }, false, 30]);
    assert.equal((await ok(sb.put(`${P}/1`, { guestVlanId: null }))).guestVlanId, null);
    assert.equal((await sb.put(`${P}/7`, { name: 'x' })).status, 404);
    assert.equal((await sb.del(`${P}/7`)).status, 404);
  });

  test('switch ports reference access policies by number', async () => {
    fresh();
    const P = `${N()}/accessPolicies`;
    await ok(sb.post(P, POLICY), 201);
    const port = (id) => `/devices/${core.serial}/switch/ports/${id}`;
    assert.match(await errorOf(sb.put(port(10), { accessPolicyType: 'Custom access policy', accessPolicyNumber: 2 })), /Access policy '2' does not exist/);
    assert.match(await errorOf(sb.put(port(10), { accessPolicyType: 'Custom access policy' })), /'accessPolicyNumber' is required/);
    const set = await ok(sb.put(port(10), { accessPolicyType: 'Custom access policy', accessPolicyNumber: 1 }));
    assert.deepEqual([set.accessPolicyType, set.accessPolicyNumber], ['Custom access policy', 1]);
    await ok(sb.put(port(11), { accessPolicyType: 'Custom access policy', accessPolicyNumber: '1' }));
    assert.equal((await ok(sb.get(`${P}/1`))).counts.ports.withThisPolicy, 2);
    // Ports that don't touch the policy fields still write as before.
    assert.equal((await ok(sb.put(port(10), { name: 'Desk' }))).accessPolicyNumber, 1);

    assert.match(await errorOf(sb.del(`${P}/1`)), /Access policy '1' is used by 2 switch ports/);
    await ok(sb.put(port(10), { accessPolicyType: 'Open' }));
    await ok(sb.put(port(11), { accessPolicyType: 'Open' }));
    assert.equal((await ok(sb.get(`${P}/1`))).counts.ports.withThisPolicy, 0);
    assert.equal((await sb.del(`${P}/1`)).status, 204);
    // Port 10 still holds number 1, so going back to a custom policy needs one that exists.
    assert.match(await errorOf(sb.put(port(10), { accessPolicyType: 'Custom access policy' })), /Access policy '1' does not exist/);
  });

  test('a bound network reads the template and refuses writes', async () => {
    fresh();
    const org = sb.world.orgs[0];
    const austin = org.networks[1];
    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'Branches', copyFromNetworkId: austin.id }), 201);
    await ok(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id }));
    const B = `/networks/${austin.id}/switch`;
    assert.equal((await ok(sb.get(`${B}/accessControlLists`))).rules.length, 1);
    assert.deepEqual(await ok(sb.get(`${B}/qosRules`)), []);
    assert.match(await errorOf(sb.post(`${B}/qosRules`, { vlan: 10 })), /bound to a config template/);
    assert.match(await errorOf(sb.post(`${B}/accessPolicies`, POLICY)), /bound to a config template/);
    // Template ports can only name policies the template has.
    const [profile] = await ok(sb.get(`/organizations/${org.id}/configTemplates/${t.id}/switch/profiles`));
    const portPath = `/organizations/${org.id}/configTemplates/${t.id}/switch/profiles/${profile.switchProfileId}/ports/3`;
    assert.match(await errorOf(sb.put(portPath, { accessPolicyType: 'Custom access policy', accessPolicyNumber: 1 })), /Access policy '1' does not exist/);
    assert.equal((await ok(sb.put(portPath, { accessPolicyType: 'Open', name: 'Front desk' }))).name, 'Front desk');
  });

  test('QoS rules keep ports to TCP and UDP and can be reordered', async () => {
    fresh();
    const Q = `${N()}/qosRules`;
    assert.deepEqual(await ok(sb.get(Q)), []);
    const a = await ok(sb.post(Q, { vlan: 100, protocol: 'TCP', srcPort: 2000, dstPortRange: '3000-3100', dscp: 46 }), 201);
    assert.match(a.id, /^\d{18}$/);
    assert.deepEqual(a, { id: a.id, vlan: 100, protocol: 'TCP', srcPort: 2000, srcPortRange: null, dstPort: null, dstPortRange: '3000-3100', dscp: 46 });
    const b = await ok(sb.post(Q, { vlan: null }), 201);
    assert.deepEqual([b.protocol, b.dscp, b.vlan], ['ANY', 0, null]);
    assert.deepEqual(await ok(sb.get(`${Q}/${a.id}`)), a);
    assert.deepEqual(await ok(sb.get(Q)), [a, b]);

    // A port replaces a range on the same side; switching to ANY drops them all.
    const swapped = await ok(sb.put(`${Q}/${a.id}`, { srcPortRange: '70-80', dstPort: 443 }));
    assert.deepEqual([swapped.srcPort, swapped.srcPortRange, swapped.dstPort, swapped.dstPortRange], [null, '70-80', 443, null]);
    const any = await ok(sb.put(`${Q}/${a.id}`, { protocol: 'ANY' }));
    assert.deepEqual([any.srcPortRange, any.dstPort], [null, null]);

    const bad = (body) => errorOf(sb.post(Q, { vlan: 10, protocol: 'UDP', ...body }));
    assert.match(await bad({ protocol: 'ANY', dstPort: 80 }), /'dstPort' only applies when 'protocol' is 'TCP' or 'UDP'/);
    assert.match(await bad({ srcPort: 1, srcPortRange: '1-2' }), /not both/);
    assert.match(await bad({ dstPortRange: '90-80' }), /range of ports/);
    assert.match(await bad({ srcPort: 70000 }), /srcPort/);
    assert.match(await bad({ dscp: 64 }), /'dscp' must be an integer between -1 and 63/);
    assert.match(await bad({ vlan: 4095 }), /VLAN from 1 to 4094/);
    assert.match(await errorOf(sb.post(Q, { protocol: 'TCP' })), /'vlan' is required/);

    const O = `${Q}/order`;
    assert.deepEqual(await ok(sb.get(O)), { ruleIds: [a.id, b.id] });
    assert.deepEqual(await ok(sb.put(O, { ruleIds: [b.id, a.id] })), { ruleIds: [b.id, a.id] });
    assert.deepEqual((await ok(sb.get(Q))).map((r) => r.id), [b.id, a.id]);
    assert.match(await errorOf(sb.put(O, { ruleIds: [a.id] })), /every QoS rule/);
    assert.match(await errorOf(sb.put(O, { ruleIds: [a.id, a.id] })), /exactly once/);
    assert.equal((await sb.del(`${Q}/${a.id}`)).status, 204);
    assert.equal((await sb.get(`${Q}/${a.id}`)).status, 404);
    assert.deepEqual(await ok(sb.get(O)), { ruleIds: [b.id] });
  });

  test('DSCP to CoS mappings reset to the defaults with an empty list', async () => {
    fresh();
    const D = `${N()}/dscpToCosMappings`;
    const defaults = await ok(sb.get(D));
    assert.deepEqual(defaults.mappings.map((m) => [m.dscp, m.cos]), [[0, 0], [10, 1], [18, 2], [26, 3], [34, 4], [46, 5]]);
    const put = await ok(sb.put(D, { mappings: [{ dscp: 1, cos: 1, title: 'Video' }, { dscp: 2, cos: 0 }] }));
    assert.deepEqual(put, { mappings: [{ dscp: 1, cos: 1, title: 'Video' }, { dscp: 2, cos: 0, title: '' }] });
    assert.deepEqual(await ok(sb.get(D)), put);
    assert.match(await errorOf(sb.put(D, { mappings: [{ dscp: 64, cos: 1 }] })), /mappings\[0\]\.dscp/);
    assert.match(await errorOf(sb.put(D, { mappings: [{ dscp: 1, cos: 6 }] })), /mappings\[0\]\.cos/);
    assert.match(await errorOf(sb.put(D, { mappings: [{ dscp: 1, cos: 1 }, { dscp: 1, cos: 2 }] })), /DSCP 1 is mapped more than once/);
    assert.deepEqual(await ok(sb.put(D, { mappings: [] })), defaults);
  });

  test('a failed action batch rolls back policy and QoS writes', async () => {
    fresh();
    const org = sb.world.orgs[0];
    const batch = await ok(
      sb.post(`/organizations/${org.id}/actionBatches`, {
        confirmed: true,
        synchronous: true,
        actions: [
          { resource: `${N()}/accessPolicies`, operation: 'create', body: { ...POLICY, guestVlanId: 30 } },
          { resource: `${N()}/qosRules`, operation: 'create', body: { vlan: 10 } },
          { resource: `/devices/${core.serial}/switch/ports/10`, operation: 'update', body: { accessPolicyType: 'Custom access policy', accessPolicyNumber: 1 } },
        ],
      }),
      201,
    );
    assert.equal(batch.status.completed, true, JSON.stringify(batch.status));
    assert.deepEqual(batch.status.createdResources[0], { id: '1', uri: `${N()}/accessPolicies/1` });

    const failed = await ok(
      sb.post(`/organizations/${org.id}/actionBatches`, {
        confirmed: true,
        synchronous: true,
        actions: [
          { resource: `${N()}/accessPolicies`, operation: 'create', body: POLICY },
          { resource: `${N()}/qosRules`, operation: 'create', body: { vlan: 20 } },
          { resource: `${N()}/accessPolicies/1`, operation: 'destroy', body: {} },
        ],
      }),
      201,
    );
    assert.equal(failed.status.failed, true);
    assert.deepEqual((await ok(sb.get(`${N()}/accessPolicies`))).map((p) => p.accessPolicyNumber), ['1']);
    assert.equal((await ok(sb.get(`${N()}/qosRules`))).length, 1);
    // The next policy gets the number it would have had without the failed batch.
    assert.equal((await ok(sb.post(`${N()}/accessPolicies`, POLICY), 201)).accessPolicyNumber, '2');
  });
});
