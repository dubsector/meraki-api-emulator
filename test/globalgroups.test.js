import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('organization-wide group policies', () => {
  let sb;
  let org;
  let hq;
  let P;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    P = `/organizations/${org.id}/policies/global/group/policies`;
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
  const policy = (name) => ok(sb.post(P, { name }), 201);

  test('policies count group numbers up and keep their names unique', async () => {
    fresh();
    const a = await ok(sb.post(P, { name: 'Production', description: 'Prod' }), 201);
    const b = await policy('Lab');
    assert.deepEqual([a.group.number, b.group.number], [100, 101]);
    assert.equal(a.description, 'Prod');
    assert.equal(b.description, '');
    assert.match(await errorOf(sb.post(P, { name: 'Lab' })), /already exists/);
    assert.match(await errorOf(sb.post(P, {})), /'name' is required/);

    const upd = await ok(sb.put(`${P}/${b.policyId}`, { name: 'Lab 2', description: 'x' }));
    assert.deepEqual([upd.name, upd.description, upd.group.number], ['Lab 2', 'x', 101]);
    assert.equal((await sb.put(`${P}/999999`, { name: 'x' })).status, 404);

    const all = await collect(sb.get, `${P}?perPage=3`);
    assert.deepEqual(all.map((p) => p.name), ['Production', 'Lab 2']);
    assert.deepEqual((await ok(sb.get(`${P}?name=LAB`))).items.map((p) => p.policyId), [b.policyId]);
    assert.deepEqual((await ok(sb.get(`${P}?policyIds[]=${a.policyId}`))).items.map((p) => p.name), ['Production']);

    // Numbers are never handed out again.
    assert.equal((await sb.del(`${P}/${b.policyId}`)).status, 204);
    assert.equal((await policy('Next')).group.number, 102);
    assert.equal((await sb.del(`${P}/${b.policyId}`)).status, 404);
  });

  test('VLAN assignments name a VLAN either way and byVlan agrees with the VLAN list', async () => {
    fresh();
    const a = await policy('Production');
    const b = await policy('Lab');
    const vlans = (await ok(sb.get(`/networks/${hq.id}/appliance/vlans`)));
    const [v1, v2] = vlans;
    assert.deepEqual(await ok(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: a.policyId }, vlans: [{ interfaceId: v1.interfaceId }, { interfaceId: `${hq.id}_vlan_${v2.id}` }] })), { success: true });
    // Assigning again is a no-op; another policy can't take the VLAN.
    await ok(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: a.policyId }, vlans: [{ interfaceId: v1.interfaceId }] }));
    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: b.policyId }, vlans: [{ interfaceId: v1.interfaceId }] })), /already assigned/);
    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: a.policyId }, vlans: [{ interfaceId: 'L_1_vlan_1' }] })), /not an appliance VLAN/);
    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/assign`, { policy: {}, vlans: [{ interfaceId: v1.interfaceId }] })), /'policy.id' is required/);
    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: '1' }, vlans: [{ interfaceId: v1.interfaceId }] })), /doesn't exist/);
    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: a.policyId }, vlans: [] })), /at least one/);

    const rows = (await ok(sb.get(`${P}/appliance/vlans/assignments`))).items;
    assert.deepEqual(rows.map((r) => [r.policyId, r.interfaceId]), [[a.policyId, `${hq.id}_vlan_${v1.id}`], [a.policyId, `${hq.id}_vlan_${v2.id}`]]);
    assert.equal((await ok(sb.get(`${P}/appliance/vlans/assignments?interfaceIds[]=${v2.interfaceId}`))).items.length, 1);
    assert.equal((await ok(sb.get(`${P}/appliance/vlans/assignments?policyIds[]=${b.policyId}`))).items.length, 0);

    // Every appliance VLAN in the organization, the network's own list included.
    const byVlan = await collect(sb.get, `${P}/appliance/vlans/assignments/byVlan?perPage=3`);
    const mine = byVlan.filter((x) => x.network.id === hq.id);
    assert.deepEqual(mine.map((x) => [x.vlanId, x.name, x.subnet]), vlans.map((v) => [v.id, v.name, v.subnet]));
    assert.deepEqual(mine[0].policy, { id: a.policyId, name: 'Production', group: { number: a.group.number } });
    assert.equal(mine[2].policy, null);
    const nets = org.networks.filter((n) => n.productTypes.includes('appliance'));
    let total = 0;
    for (const n of nets) {
      const res = await sb.get(`/networks/${n.id}/appliance/vlans`);
      if (res.status === 200) total += res.body.length;
    }
    assert.equal(byVlan.length, total);
    const found = (await ok(sb.get(`${P}/appliance/vlans/assignments/byVlan?search=production`))).items;
    assert.deepEqual(found.map((x) => x.interfaceId), rows.map((r) => r.interfaceId));
    assert.ok((await ok(sb.get(`${P}/appliance/vlans/assignments/byVlan?vlanIds[]=${v1.id}`))).items.every((x) => x.vlanId === v1.id));

    assert.match(await errorOf(sb.post(`${P}/appliance/vlans/remove`, { policy: { id: b.policyId }, vlans: [{ interfaceId: v1.interfaceId }] })), /not assigned/);
    await ok(sb.post(`${P}/appliance/vlans/remove`, { policy: { id: a.policyId }, vlans: [{ interfaceId: v1.interfaceId }] }));
    assert.equal((await ok(sb.get(`${P}/appliance/vlans/assignments`))).items.length, 1);

    // A deleted VLAN drops out.
    assert.equal((await sb.del(`/networks/${hq.id}/appliance/vlans/${v2.id}`)).status, 204);
    assert.equal((await ok(sb.get(`${P}/appliance/vlans/assignments`))).items.length, 0);
  });

  test('VLAN assignments follow their network through a split and leave with it', async () => {
    fresh();
    const a = await policy('Production');
    const v = (await ok(sb.get(`/networks/${hq.id}/appliance/vlans`)))[1];
    await ok(sb.post(`${P}/appliance/vlans/assign`, { policy: { id: a.policyId }, vlans: [{ interfaceId: `${hq.id}_vlan_${v.id}` }] }));
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const mx = parts.find((n) => n.productTypes.includes('appliance'));
    assert.deepEqual((await ok(sb.get(`${P}/appliance/vlans/assignments`))).items.map((r) => r.interfaceId), [`${mx.id}_vlan_${v.id}`]);

    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: mx.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(move.result.status, 'completed', move.result.reason);
    assert.equal((await ok(sb.get(`${P}/appliance/vlans/assignments`))).items.length, 0);
  });

  test('adaptive policy groups belong to one policy and leave with it', async () => {
    fresh();
    const a = await policy('Production');
    const b = await policy('Lab');
    const g = await ok(sb.post(`/organizations/${org.id}/adaptivePolicy/groups`, { name: 'Cameras', sgt: 40 }), 201);
    const infra = (await ok(sb.get(`/organizations/${org.id}/adaptivePolicy/groups`))).find((x) => x.name === 'Infrastructure');
    const body = (p, ...ids) => ({ policy: { id: p.policyId }, adaptivePolicyGroups: ids.map((id) => ({ id })) });
    assert.deepEqual(await ok(sb.post(`${P}/adaptivePolicyGroups/assign`, body(a, g.groupId, infra.groupId, g.groupId))), { success: true });
    assert.match(await errorOf(sb.post(`${P}/adaptivePolicyGroups/assign`, body(b, g.groupId))), /already assigned/);
    assert.match(await errorOf(sb.post(`${P}/adaptivePolicyGroups/assign`, body(b, '1'))), /doesn't exist/);
    assert.match(await errorOf(sb.post(`${P}/adaptivePolicyGroups/assign`, body(b))), /at least one/);
    const rows = (await ok(sb.get(`${P}/adaptivePolicyGroups/assignments`))).items;
    assert.deepEqual(rows.map((r) => [r.policyId, r.adaptivePolicyGroupId]), [[a.policyId, g.groupId], [a.policyId, infra.groupId]]);
    assert.equal((await ok(sb.get(`${P}/adaptivePolicyGroups/assignments?adaptivePolicyGroupIds[]=${g.groupId}`))).items.length, 1);
    assert.equal((await ok(sb.get(`${P}/adaptivePolicyGroups/assignments?assignmentIds[]=${rows[1].assignmentId}`))).items[0].adaptivePolicyGroupId, infra.groupId);

    assert.match(await errorOf(sb.post(`${P}/adaptivePolicyGroups/remove`, body(b, infra.groupId))), /not assigned/);
    await ok(sb.post(`${P}/adaptivePolicyGroups/remove`, body(a, infra.groupId)));
    await ok(sb.post(`${P}/adaptivePolicyGroups/assign`, body(b, infra.groupId)));

    // A deleted group drops out, and a deleted policy takes its rows along.
    assert.equal((await sb.del(`/organizations/${org.id}/adaptivePolicy/groups/${g.groupId}`)).status, 204);
    assert.deepEqual((await ok(sb.get(`${P}/adaptivePolicyGroups/assignments`))).items.map((r) => r.policyId), [b.policyId]);
    assert.equal((await sb.del(`${P}/${b.policyId}`)).status, 204);
    assert.equal((await ok(sb.get(`${P}/adaptivePolicyGroups/assignments`))).items.length, 0);
  });

  test('firewall ruleset assignments', async () => {
    fresh();
    const a = await policy('Production');
    const b = await policy('Lab');
    const F = `/organizations/${org.id}/policies/global/firewall/rulesets`;
    const s1 = await ok(sb.post(F, { name: 'One' }), 201);
    const s2 = await ok(sb.post(F, { name: 'Two' }), 201);
    const R = `${P}/firewall/rulesets/assignments`;
    const x = await ok(sb.post(R, { rulesetId: s1.rulesetId, policyId: a.policyId }), 201);
    assert.deepEqual([x.rulesetId, x.policyId, x.priority], [s1.rulesetId, a.policyId, 1]);
    assert.ok(x.createdAt && x.lastUpdatedAt);
    const y = await ok(sb.post(R, { rulesetId: s2.rulesetId, policyId: a.policyId, priority: 5 }), 201);
    await ok(sb.post(R, { rulesetId: s1.rulesetId, policyId: b.policyId }), 201);
    assert.match(await errorOf(sb.post(R, { rulesetId: s1.rulesetId, policyId: a.policyId })), /already assigned/);
    assert.match(await errorOf(sb.post(R, { rulesetId: '1', policyId: a.policyId })), /ruleset 1/);
    assert.match(await errorOf(sb.post(R, { rulesetId: s1.rulesetId, policyId: '1' })), /policy 1/);
    assert.match(await errorOf(sb.post(R, { rulesetId: s2.rulesetId, policyId: b.policyId, priority: 0 })), /priority/);
    assert.match(await errorOf(sb.post(R, { policyId: b.policyId })), /'rulesetId' is required/);
    assert.match(await errorOf(sb.put(`${R}/${y.assignmentId}`, { rulesetId: s1.rulesetId })), /already assigned/);

    const upd = await ok(sb.put(`${R}/${y.assignmentId}`, { priority: 2, policyId: b.policyId }));
    assert.deepEqual([upd.priority, upd.policyId, upd.rulesetId], [2, b.policyId, s2.rulesetId]);
    assert.equal((await ok(sb.get(`${R}?policyIds[]=${b.policyId}`))).items.length, 2);
    assert.equal((await ok(sb.get(`${R}?rulesetIds[]=${s1.rulesetId}`))).items.length, 2);
    assert.equal((await collect(sb.get, `${R}?perPage=3`)).length, 3);

    // A deleted ruleset or policy takes its assignments along.
    assert.equal((await sb.del(F + `/${s2.rulesetId}`)).status, 204);
    assert.equal((await sb.get(`${R}?rulesetIds[]=${s2.rulesetId}`)).body.items.length, 0);
    assert.equal((await sb.del(`${P}/${a.policyId}`)).status, 204);
    assert.deepEqual((await ok(sb.get(R))).items.map((r) => r.policyId), [b.policyId]);
    assert.equal((await sb.del(`${R}/${x.assignmentId}`)).status, 404);
    const last = (await ok(sb.get(R))).items[0];
    assert.equal((await sb.del(`${R}/${last.assignmentId}`)).status, 204);
    assert.equal((await ok(sb.get(R))).items.length, 0);
  });
});
