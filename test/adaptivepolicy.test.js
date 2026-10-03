import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('adaptive policy', () => {
  let sb;
  let org;
  let hq;
  let O;
  let sw;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    sw = hq.switches[0];
    O = `/organizations/${org.id}/adaptivePolicy`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const group = (name, sgt, more = {}) => ok(sb.post(`${O}/groups`, { name, sgt, ...more }), 201);
  const acl = (name, rules = [{ policy: 'deny', protocol: 'tcp', dstPort: '22' }]) => ok(sb.post(`${O}/acls`, { name, rules, ipVersion: 'ipv4' }));

  test('every organization starts with the Infrastructure and Unknown groups', async () => {
    fresh();
    const list = await ok(sb.get(`${O}/groups`));
    assert.deepEqual(list.map((g) => [g.name, g.sgt, g.isDefaultGroup, g.policyObjects, g.requiredIpMappings]), [['Infrastructure', 2, true, [], []], ['Unknown', 0, true, [], []]]);
    const [infra, unknown] = list;
    assert.match(infra.groupId, /^\d{4}$/);
    assert.equal(Number(unknown.groupId), Number(infra.groupId) + 1);
    assert.equal(infra.createdAt, '2026-09-29T18:30:00.000000Z');
    assert.deepEqual(await ok(sb.get(`${O}/groups/${infra.groupId}`)), infra);

    // Infrastructure only takes a new SGT; Unknown takes nothing and neither can go.
    assert.match(await errorOf(sb.put(`${O}/groups/${infra.groupId}`, { name: 'Infra' })), /Only the SGT/);
    assert.equal((await ok(sb.put(`${O}/groups/${infra.groupId}`, { sgt: 3 }))).sgt, 3);
    assert.match(await errorOf(sb.put(`${O}/groups/${unknown.groupId}`, { sgt: 4 })), /Unknown group cannot be changed/);
    assert.match(await errorOf(sb.del(`${O}/groups/${unknown.groupId}`)), /default group/);
    assert.equal((await sb.get(`${O}/groups/1000`)).status, 404);
  });

  test('custom groups take a unique name and SGT and adaptive policy objects', async () => {
    fresh();
    const obj = await ok(sb.post(`/organizations/${org.id}/policyObjects`, { name: 'Cameras', category: 'adaptivePolicy', type: 'adaptivePolicyIpv4Cidr', cidr: '10.5.0.0/24' }), 201);
    const net = await ok(sb.post(`/organizations/${org.id}/policyObjects`, { name: 'Web', category: 'network', type: 'cidr', cidr: '10.6.0.0/24' }), 201);
    const g = await group('Employees', 100, { description: 'Staff', policyObjects: [{ name: 'Cameras' }] });
    assert.deepEqual({ ...g, groupId: 0, createdAt: 0, updatedAt: 0 }, { groupId: 0, name: 'Employees', sgt: 100, description: 'Staff', policyObjects: [{ id: obj.id, name: 'Cameras' }], isDefaultGroup: false, requiredIpMappings: [], createdAt: 0, updatedAt: 0 });
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Employees', sgt: 101 })), /already exists/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Guests', sgt: 100 })), /SGT 100 is already used/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Guests', sgt: 2 })), /Infrastructure/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Guests', sgt: 70000 })), /between 1 and 65519/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Guests', sgt: 5, policyObjects: [{ id: net.id }] })), /does not name an adaptive policy object/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Guests', sgt: 5, policyObjects: [{}] })), /one of id, name/);

    // The object can't go while a group names it.
    assert.match(await errorOf(sb.del(`/organizations/${org.id}/policyObjects/${obj.id}`)), /adaptive policy group 'Employees'/);
    const u = await ok(sb.put(`${O}/groups/${g.groupId}`, { name: 'Staff', policyObjects: [] }));
    assert.deepEqual([u.name, u.sgt, u.policyObjects], ['Staff', 100, []]);
    await ok(sb.del(`/organizations/${org.id}/policyObjects/${obj.id}`), 204);
  });

  test('ACLs check their rules and fill in port defaults', async () => {
    fresh();
    const a = await acl('Block SSH', [{ policy: 'deny', protocol: 'tcp', srcPort: '1,33', dstPort: '22-30', log: true }, { policy: 'allow', protocol: 'tcp', tcpEstablished: true }, { policy: 'allow', protocol: 'icmp' }]);
    assert.match(a.aclId, /^\d{8}$/);
    assert.deepEqual(a.rules, [
      { policy: 'deny', protocol: 'tcp', srcPort: '1,33', dstPort: '22-30', log: true, tcpEstablished: false },
      { policy: 'allow', protocol: 'tcp', srcPort: 'any', dstPort: 'any', log: false, tcpEstablished: true },
      { policy: 'allow', protocol: 'icmp', srcPort: 'any', dstPort: 'any', log: false, tcpEstablished: false },
    ]);
    assert.deepEqual([a.description, a.ipVersion, a.createdAt], ['', 'ipv4', '2026-09-29T18:30:00Z']);
    assert.deepEqual(await ok(sb.get(`${O}/acls`)), [a]);
    const bad = (rule) => errorOf(sb.post(`${O}/acls`, { name: 'Bad', ipVersion: 'any', rules: [rule] }));
    assert.match(await bad({ policy: 'deny', protocol: 'tcp', dstPort: '70000' }), /dstPort/);
    assert.match(await bad({ policy: 'deny', protocol: 'icmp', dstPort: '22' }), /must be 'any' when the protocol is icmp/);
    assert.match(await bad({ policy: 'deny', protocol: 'tcp', tcpEstablished: true }), /allow tcp/);
    assert.match(await errorOf(sb.post(`${O}/acls`, { name: 'Bad', ipVersion: 'any', rules: Array(17).fill({ policy: 'deny', protocol: 'any' }) })), /at most 16/);
    assert.match(await errorOf(sb.post(`${O}/acls`, { name: 'Block SSH', ipVersion: 'any', rules: [] })), /already exists/);
    // An empty list clears the rules.
    const u = await ok(sb.put(`${O}/acls/${a.aclId}`, { rules: [], ipVersion: 'ipv6' }));
    assert.deepEqual([u.rules, u.ipVersion, u.name], [[], 'ipv6', 'Block SSH']);
  });

  test('policies connect two groups and go with them', async () => {
    fresh();
    const iot = await group('IoT Devices', 50);
    const servers = await group('IoT Servers', 51);
    const a = await acl('Block web');
    const b = await acl('Block SSH');
    const p = await ok(sb.post(`${O}/policies`, { sourceGroup: { name: 'IoT Devices' }, destinationGroup: { sgt: 51 }, acls: [{ id: a.aclId }, { name: 'Block SSH' }], lastEntryRule: 'deny' }), 201);
    assert.deepEqual({ ...p, adaptivePolicyId: 0, createdAt: 0, updatedAt: 0 }, {
      adaptivePolicyId: 0,
      sourceGroup: { id: iot.groupId, name: 'IoT Devices', sgt: 50 },
      destinationGroup: { id: servers.groupId, name: 'IoT Servers', sgt: 51 },
      acls: [{ id: a.aclId, name: 'Block web' }, { id: b.aclId, name: 'Block SSH' }],
      lastEntryRule: 'deny',
      createdAt: 0,
      updatedAt: 0,
    });
    assert.match(await errorOf(sb.post(`${O}/policies`, { sourceGroup: { id: iot.groupId }, destinationGroup: { id: servers.groupId } })), /already exists/);
    assert.match(await errorOf(sb.post(`${O}/policies`, { sourceGroup: { id: iot.groupId, sgt: 51 }, destinationGroup: { id: iot.groupId } })), /sourceGroup/);
    assert.match(await errorOf(sb.post(`${O}/policies`, { sourceGroup: { id: iot.groupId }, destinationGroup: { id: iot.groupId }, acls: [{ id: a.aclId }, { id: a.aclId }] })), /twice/);
    const back = await ok(sb.post(`${O}/policies`, { sourceGroup: { id: servers.groupId }, destinationGroup: { id: iot.groupId } }), 201);
    assert.deepEqual([back.acls, back.lastEntryRule], [[], 'default']);

    // The overview counts what exists.
    const ov = await ok(sb.get(`${O}/overview`));
    assert.deepEqual(ov.counts, { groups: 4, customGroups: 2, customAcls: 2, policies: 2, denyPolicies: 1, allowPolicies: 0, policyObjects: 0 });
    assert.deepEqual(ov.limits, { customGroups: 60, rulesInAnAcl: 16, aclsInAPolicy: 7, policyObjects: 8000 });

    // A renamed group shows in its policies; a deleted ACL leaves them.
    await ok(sb.put(`${O}/groups/${iot.groupId}`, { name: 'Sensors' }));
    await ok(sb.del(`${O}/acls/${a.aclId}`), 204);
    const after = await ok(sb.get(`${O}/policies/${p.adaptivePolicyId}`));
    assert.deepEqual([after.sourceGroup.name, after.acls], ['Sensors', [{ id: b.aclId, name: 'Block SSH' }]]);
    const moved = await ok(sb.put(`${O}/policies/${p.adaptivePolicyId}`, { destinationGroup: { name: 'Unknown' }, lastEntryRule: 'allow' }));
    assert.deepEqual([moved.destinationGroup.sgt, moved.lastEntryRule, moved.acls.length], [0, 'allow', 1]);

    // Deleting a group drops its policies.
    await ok(sb.del(`${O}/groups/${servers.groupId}`), 204);
    assert.deepEqual((await ok(sb.get(`${O}/policies`))).map((x) => x.adaptivePolicyId), [p.adaptivePolicyId]);
    await ok(sb.del(`${O}/policies/${p.adaptivePolicyId}`), 204);
    assert.deepEqual(await ok(sb.get(`${O}/policies`)), []);
  });

  test('settings list the networks adaptive policy is enabled on', async () => {
    fresh();
    const S = `${O}/settings`;
    assert.deepEqual(await ok(sb.get(S)), { enabledNetworks: [] });
    assert.deepEqual(await ok(sb.put(S, { enabledNetworks: [hq.id, hq.id] })), { enabledNetworks: [hq.id] });
    assert.match(await errorOf(sb.put(S, { enabledNetworks: ['L_1'] })), /doesn't exist/);
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
    assert.match(await errorOf(sb.put(S, { enabledNetworks: [lab.id] })), /doesn't exist in this organization/);
    // A network that moves away leaves the list.
    const austin = org.networks.find((n) => n.name === 'Branch - Austin');
    await ok(sb.put(S, { enabledNetworks: [hq.id, austin.id] }));
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: austin.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(move.result.status, 'completed');
    assert.deepEqual((await ok(sb.get(S))).enabledNetworks, [hq.id]);

    // A split keeps it on for the switch, wireless and appliance parts, not the cameras.
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const tagging = parts.filter((n) => !n.productTypes.includes('camera')).map((n) => n.id);
    assert.equal(tagging.length, 3);
    assert.deepEqual((await ok(sb.get(S))).enabledNetworks, tagging);
    // A deleted network leaves it too.
    assert.equal((await sb.del(`/networks/${tagging[0]}`)).status, 204);
    assert.deepEqual((await ok(sb.get(S))).enabledNetworks, tagging.slice(1));
  });

  test('switch ports and SSIDs name a group, which leaves them when deleted', async () => {
    fresh();
    const P = `/devices/${sw.serial}/switch/ports`;
    const plain = await ok(sb.get(`${P}/1`));
    assert.ok(!('adaptivePolicyGroupId' in plain) && !('peerSgtCapable' in plain));
    const g = await group('Printers', 60);
    assert.match(await errorOf(sb.put(`${P}/1`, { adaptivePolicyGroupId: '42' })), /adaptive policy group 42/);
    const port = await ok(sb.put(`${P}/1`, { type: 'trunk', adaptivePolicyGroupId: g.groupId, peerSgtCapable: true }));
    assert.deepEqual([port.adaptivePolicyGroupId, port.adaptivePolicyGroup, port.peerSgtCapable], [g.groupId, { id: g.groupId, name: 'Printers' }, true]);
    assert.match(await errorOf(sb.put(`${P}/1`, { type: 'access' })), /trunk ports/);
    await ok(sb.put(`/organizations/${org.id}/adaptivePolicy/groups/${g.groupId}`, { name: 'Print' }));
    assert.equal((await ok(sb.get(`${P}/1`))).adaptivePolicyGroup.name, 'Print');

    const S = `/networks/${hq.id}/wireless/ssids/1`;
    assert.ok(!('adaptivePolicyGroupId' in (await ok(sb.get(S)))));
    assert.match(await errorOf(sb.put(S, { adaptivePolicyGroupId: '42' })), /adaptive policy group 42/);
    assert.equal((await ok(sb.put(S, { adaptivePolicyGroupId: g.groupId }))).adaptivePolicyGroupId, g.groupId);

    // The network can't move while it uses the organization's groups.
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: hq.id }, organizations: { target: { id: dest.id } }, simulate: true }), 201);
    assert.match(move.result.reason, /adaptive policy groups/);

    await ok(sb.del(`${O}/groups/${g.groupId}`), 204);
    const gone = await ok(sb.get(`${P}/1`));
    assert.deepEqual([gone.adaptivePolicyGroupId, gone.adaptivePolicyGroup, gone.peerSgtCapable], [null, null, true]);
    assert.ok(!('adaptivePolicyGroupId' in (await ok(sb.get(S)))));
  });
});
