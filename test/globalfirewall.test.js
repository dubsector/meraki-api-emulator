import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('client policy views and organization-wide firewall', () => {
  let sb;
  let org;
  let hq;
  let F;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    F = `/organizations/${org.id}/policies/global/firewall`;
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
  const any = { matchCriteria: ['any'] };
  const rule = (rulesetId, extra = {}) => ({ name: 'Rule', rulesetId, policy: 'deny', sources: any, destinations: any, ...extra });

  test('policies by client agree with the client policy route', async () => {
    fresh();
    const rows = await collect(sb.get, `/networks/${hq.id}/policies/byClient?perPage=3`);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      const p = await ok(sb.get(`/networks/${hq.id}/clients/${r.clientId}/policy`));
      assert.equal(p.devicePolicy, 'Group policy');
      assert.deepEqual(r.assigned.map((a) => [a.name, a.type, a.groupPolicyId]), [['Guest', 'ssid', p.groupPolicyId]]);
    }

    // A network-wide policy replaces the Guest one and applies everywhere.
    const c = rows[0].clientId;
    await ok(sb.put(`/networks/${hq.id}/clients/${c}/policy`, { devicePolicy: 'Blocked' }));
    const mine = (await collect(sb.get, `/networks/${hq.id}/policies/byClient`)).find((r) => r.clientId === c);
    assert.deepEqual(mine.assigned, [{ name: 'Blocked', type: 'network' }]);
    const orgRows = await collect(sb.get, `/organizations/${org.id}/policies/assignments/byClient?networkIds[]=${hq.id}&perPage=3`);
    assert.equal(orgRows.length, rows.length);
    const row = orgRows.find((r) => r.clientId === c);
    assert.equal(row.networkId, hq.id);
    assert.deepEqual(row.assigned, [{ name: 'Blocked', type: 'Blocked', limitTo: [{ appliance: true, ssids: hq.ssids.map((s) => ({ number: s.number })) }] }]);

    // Normal clients drop out.
    await ok(sb.put(`/networks/${hq.id}/clients/${c}/policy`, { devicePolicy: 'Normal' }));
    assert.ok(!(await collect(sb.get, `/networks/${hq.id}/policies/byClient`)).some((r) => r.clientId === c));
  });

  test('the organization view needs networks and can include undetected clients', async () => {
    fresh();
    const url = `/organizations/${org.id}/policies/assignments/byClient`;
    assert.match(await errorOf(sb.get(url)), /networkIds/);
    assert.match(await errorOf(sb.get(`${url}?networkIds[]=N_1`)), /does not exist/);
    const mac = '00:11:22:33:44:55';
    await ok(sb.post(`/networks/${hq.id}/clients/provision`, { clients: [{ mac, name: 'New laptop' }], devicePolicy: 'Allowed' }), 201);
    assert.ok(!(await collect(sb.get, `${url}?networkIds[]=${hq.id}`)).some((r) => r.mac === mac));
    const rows = await collect(sb.get, `${url}?networkIds[]=${hq.id}&includeUndetectedClients=true`);
    const row = rows.find((r) => r.mac === mac);
    assert.equal(row.name, 'New laptop');
    assert.deepEqual(row.assigned.map((a) => a.type), ['Allowed']);
  });

  test('application categories', async () => {
    fresh();
    const cats = await ok(sb.get(`${F}/applicationCategories`));
    const email = cats.find((c) => c.name === 'Email');
    assert.equal(email.id, 'meraki:layer7/category/1');
    assert.deepEqual(email.applications[0], { id: 'meraki:layer7/application/4', name: 'Gmail', nbar: { mappings: [{ id: 1658 }] } });
  });

  test('rulesets and rules', async () => {
    fresh();
    const set = await ok(sb.post(`${F}/rulesets`, { name: 'Block Social Media', description: 'Social' }), 201);
    assert.match(set.rulesetId, /^\d+$/);
    assert.match(await errorOf(sb.post(`${F}/rulesets`, { name: 'Block Social Media' })), /already exists/);
    const other = await ok(sb.post(`${F}/rulesets`, { name: 'Other' }), 201);
    const listed = await ok(sb.get(`${F}/rulesets?name=social`));
    assert.deepEqual(listed.items.map((s) => s.name), ['Block Social Media']);
    assert.deepEqual(listed.meta.counts.items, { total: 1, remaining: 0 });
    assert.equal((await ok(sb.put(`${F}/rulesets/${set.rulesetId}`, { description: 'New' }))).description, 'New');

    // Rules go last without a priority; a taken priority moves the others down.
    const a = await ok(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { name: 'A' })), 201);
    const b = await ok(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { name: 'B' })), 201);
    assert.deepEqual([a.priority, b.priority, a.enabled], [1, 2, true]);
    const c = await ok(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { name: 'C', priority: 1, policy: 'allow' })), 201);
    await ok(sb.post(`${F}/rulesets/rules`, rule(other.rulesetId, { name: 'D' })), 201);
    const rules = await collect(sb.get, `${F}/rulesets/rules?perPage=3`);
    assert.deepEqual(rules.map((r) => [r.name, r.priority]), [['C', 1], ['A', 2], ['B', 3], ['D', 1]]);
    const only = await ok(sb.get(`${F}/rulesets/rules?rulesetIds[]=${other.rulesetId}`));
    assert.deepEqual(only.items.map((r) => r.name), ['D']);
    const moved = await ok(sb.put(`${F}/rulesets/rules/${c.ruleId}`, { priority: 9, enabled: false }));
    assert.deepEqual([moved.priority, moved.enabled, moved.policy], [9, false, 'allow']);
    assert.equal((await sb.del(`${F}/rulesets/rules/${a.ruleId}`)).status, 204);
    assert.equal((await sb.del(`${F}/rulesets/rules/${a.ruleId}`)).status, 404);

    // Moving a rule into a full ruleset is refused like creating one there.
    const store = org.globalFirewallRules;
    const filler = Array.from({ length: 1999 }, (_, i) => ({ ...store.list.find((r) => r.ruleId === b.ruleId), ruleId: `x${i}`, rulesetId: other.rulesetId }));
    store.list.push(...filler);
    assert.match(await errorOf(sb.put(`${F}/rulesets/rules/${b.ruleId}`, { rulesetId: other.rulesetId })), /limited to 2000 rules/);
    store.list = store.list.filter((r) => !filler.includes(r));

    // A ruleset goes with its rules.
    assert.equal((await sb.del(`${F}/rulesets/${set.rulesetId}`)).status, 204);
    assert.deepEqual((await collect(sb.get, `${F}/rulesets/rules`)).map((r) => r.name), ['D']);
    assert.match(await errorOf(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId))), /does not exist/);
  });

  test('rule criteria', async () => {
    fresh();
    const set = await ok(sb.post(`${F}/rulesets`, { name: 'Criteria' }), 201);
    const obj = await ok(sb.post(`/organizations/${org.id}/policyObjects`, { name: 'Web', category: 'network', type: 'cidr', cidr: '10.1.0.0/24' }), 201);
    const grp = await ok(sb.post(`/organizations/${org.id}/policyObjects/groups`, { name: 'Servers', objectIds: [obj.id] }), 201);
    const sources = {
      matchCriteria: ['addressRanges', 'ports', 'policyObjects', 'policyObjectGroups', 'applianceVlans'],
      criteria: { addressRanges: ['1.1.1.1', '10.0.0.0/8', '10.0.0.1-10.0.0.9'], ports: ['22', '42-46'], policyObjects: [{ id: obj.id }], policyObjectGroups: [{ id: grp.id }], applianceVlans: [{ interfaceId: `${hq.id}_vlan_10` }] },
    };
    const destinations = {
      matchCriteria: ['services', 'applications', 'applicationCategories'],
      criteria: { services: [{ protocol: 'TCP', ports: ['80', '443'] }], applications: [{ id: 'meraki:layer7/application/5' }], applicationCategories: [{ id: 'meraki:layer7/category/24', applications: [{ id: 'meraki:layer7/application/66' }] }] },
    };
    const r = await ok(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { sources, destinations })), 201);
    assert.deepEqual(r.sources, sources);
    assert.deepEqual(r.destinations.criteria, {
      services: [{ protocol: 'tcp', ports: ['80', '443'] }],
      applications: [{ id: 'meraki:layer7/application/5', name: 'Advertising.com' }],
      applicationCategories: [{ id: 'meraki:layer7/category/24' }],
    });
    assert.deepEqual(r.destinations.matchCriteria, destinations.matchCriteria);

    // Named policy objects and groups can't be deleted.
    assert.match(await errorOf(sb.del(`/organizations/${org.id}/policyObjects/groups/${grp.id}`)), new RegExp(`firewall rule ${r.ruleId}`));
    assert.match(await errorOf(sb.del(`/organizations/${org.id}/policyObjects/${obj.id}`)), /firewall rule/);

    const bad = (b) => errorOf(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { sources: b })));
    assert.match(await bad({ matchCriteria: ['any', 'ports'] }), /can't combine/);
    assert.match(await bad({ matchCriteria: ['any'], criteria: { ports: ['22'] } }), /left out/);
    assert.match(await bad({ matchCriteria: [] }), /at least one/);
    assert.match(await bad({ matchCriteria: ['ports'] }), /at least one value/);
    assert.match(await bad({ matchCriteria: ['ports'], criteria: { ports: ['22'], addressRanges: ['1.1.1.1'] } }), /doesn't hold/);
    assert.match(await bad({ matchCriteria: ['siteSpecificVlans'] }), /no criteria field/);
    assert.match(await bad({ matchCriteria: ['ports'], criteria: { ports: ['0'] } }), /port/);
    assert.match(await bad({ matchCriteria: ['addressRanges'], criteria: { addressRanges: ['10.0.0.9-10.0.0.1'] } }), /range/);
    assert.match(await bad({ matchCriteria: ['policyObjects'], criteria: { policyObjects: [{ id: '1' }] } }), /doesn't exist/);
    assert.match(await bad({ matchCriteria: ['applianceVlans'], criteria: { applianceVlans: [{ interfaceId: `${hq.id}_vlan_999` }] } }), /VLAN 999/);
    assert.match(await bad({ matchCriteria: ['ports'], criteria: { ports: Array.from({ length: 101 }, (_, i) => String(i + 1)) } }), /100 port values/);
    assert.match(await bad({ matchCriteria: ['addressRanges'], criteria: { addressRanges: Array.from({ length: 101 }, (_, i) => `10.0.0.${i}`) } }), /100 segment values/);
    const badDest = (d) => errorOf(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { destinations: d })));
    assert.match(await badDest({ matchCriteria: ['applications'], criteria: { applications: [{ id: 'meraki:layer7/application/9999' }] } }), /application ID/);
    assert.match(await badDest({ matchCriteria: ['applicationCategories'], criteria: { applicationCategories: [{ id: 'meraki:layer7/category/1', applications: [{ id: 'meraki:layer7/application/5' }] }] } }), /not an application of/);
    assert.match(await badDest({ matchCriteria: ['services'], criteria: { services: [{ protocol: 'gre', ports: ['1'] }] } }), /protocol/);
    assert.match(await errorOf(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { priority: 0 }))), /priority/);
  });

  test('rule VLANs follow their network through a split and leave with it', async () => {
    fresh();
    const set = await ok(sb.post(`${F}/rulesets`, { name: 'VLANs' }), 201);
    const sources = { matchCriteria: ['applianceVlans'], criteria: { applianceVlans: [{ interfaceId: `${hq.id}_vlan_10` }] } };
    const r = await ok(sb.post(`${F}/rulesets/rules`, rule(set.rulesetId, { sources })), 201);
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const mx = parts.find((n) => n.productTypes.includes('appliance'));
    const after = (await ok(sb.get(`${F}/rulesets/rules?ruleIds[]=${r.ruleId}`))).items[0];
    assert.deepEqual(after.sources.criteria.applianceVlans, [{ interfaceId: `${mx.id}_vlan_10` }]);

    // Moving the network to another organization drops its VLANs from the rule.
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: mx.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(move.result.status, 'completed', move.result.reason);
    const gone = (await ok(sb.get(`${F}/rulesets/rules?ruleIds[]=${r.ruleId}`))).items[0];
    assert.deepEqual(gone.sources.criteria.applianceVlans, []);
  });
});
