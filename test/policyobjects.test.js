import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('policy objects', () => {
  let sb;
  let org;
  let hq;
  let austin;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    O = `/organizations/${org.id}/policyObjects`;
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
  const cidr = (name, value = '10.0.0.0/24', extra = {}) => ok(sb.post(O, { name, category: 'network', type: 'cidr', cidr: value, ...extra }), 201);
  const l3 = (net, rules) => sb.put(`/networks/${net.id}/appliance/firewall/l3FirewallRules`, { rules });
  const rule = (destCidr, srcCidr = 'Any') => ({ comment: 'objects', policy: 'deny', protocol: 'any', srcCidr, destCidr });

  test('objects are created, read, paged, updated and deleted', async () => {
    fresh();
    const web = await cidr('Web Servers - Datacenter 10');
    assert.match(web.id, /^\d{7}$/);
    assert.deepEqual(Object.keys(web), ['id', 'name', 'category', 'type', 'cidr', 'createdAt', 'updatedAt', 'groupIds', 'networkIds']);
    assert.deepEqual({ ...web, id: 0 }, { id: 0, name: 'Web Servers - Datacenter 10', category: 'network', type: 'cidr', cidr: '10.0.0.0/24', createdAt: web.createdAt, updatedAt: web.createdAt, groupIds: [], networkIds: [] });
    const site = await ok(sb.post(O, { name: 'Example', category: 'network', type: 'fqdn', fqdn: 'example.com' }), 201);
    assert.equal(site.fqdn, 'example.com');
    assert.equal(site.cidr, undefined);
    assert.equal(Number(site.id), Number(web.id) + 1);
    const sgt = await ok(sb.post(O, { name: 'Cameras', category: 'adaptivePolicy', type: 'adaptivePolicyIpv4Cidr', cidr: '10.9.0.0/16' }), 201);
    assert.equal(sgt.category, 'adaptivePolicy');
    assert.deepEqual(await ok(sb.get(`${O}/${web.id}`)), web);

    for (let i = 0; i < 9; i++) await cidr(`Host ${i}`, `10.1.0.${i}`);
    const all = await collect(sb.get, `${O}?perPage=10`);
    assert.equal(all.length, 12);
    assert.deepEqual(all.map((o) => o.id), [...all.map((o) => o.id)].sort());
    assert.equal((await sb.get(`${O}?perPage=9`)).status, 400);

    const moved = await ok(sb.put(`${O}/${web.id}`, { name: 'Web Servers', cidr: '10.0.1.0/24' }));
    assert.equal(moved.name, 'Web Servers');
    assert.equal(moved.cidr, '10.0.1.0/24');
    assert.equal(moved.type, 'cidr');

    assert.equal((await sb.del(`${O}/${web.id}`)).status, 204);
    assert.equal((await sb.get(`${O}/${web.id}`)).status, 404);
    assert.equal((await sb.del(`${O}/${web.id}`)).status, 404);
    assert.equal((await cidr('Web Servers')).name, 'Web Servers');
  });

  test('object bodies are checked before anything changes', async () => {
    fresh();
    const post = (b) => sb.post(O, { name: 'Thing', category: 'network', type: 'cidr', cidr: '10.0.0.0/8', ...b });
    assert.match(await errorOf(post({ type: 'ipAndMask', ip: '10.0.0.1', mask: '255.0.0.0' })), /type/);
    assert.match(await errorOf(post({ ip: '10.0.0.1' })), /deprecated/);
    assert.match(await errorOf(post({ category: 'adaptivePolicy' })), /'category' must be 'network'/);
    assert.match(await errorOf(post({ cidr: null })), /'cidr' is required/);
    assert.match(await errorOf(post({ cidr: '10.0.0.0/33' })), /'cidr' must be/);
    assert.match(await errorOf(post({ fqdn: 'example.com' })), /only used with type fqdn/);
    assert.match(await errorOf(post({ type: 'fqdn', cidr: null })), /'fqdn' is required/);
    assert.match(await errorOf(post({ type: 'fqdn', cidr: null, fqdn: 'not a host' })), /domain name/);
    assert.match(await errorOf(post({ category: 'adaptivePolicy', type: 'adaptivePolicyIpv4Cidr', cidr: '10.0.0.1' })), /CIDR/);
    assert.match(await errorOf(post({ name: 'Web/Servers' })), /letters, digits/);
    assert.match(await errorOf(post({ name: '  ' })), /must not be empty/);
    assert.match(await errorOf(post({ name: null })), /'name' is required/);
    assert.match(await errorOf(post({ groupIds: ['1234'] })), /group 1234 does not exist/);
    assert.deepEqual(await ok(sb.get(O)), []);

    const o = await cidr('Thing');
    assert.match(await errorOf(post({})), /already exists in this organization/);
    assert.match(await errorOf(sb.put(`${O}/${o.id}`, { fqdn: 'example.com' })), /only used with type fqdn/);
    assert.match(await errorOf(sb.put(`${O}/${o.id}`, { mask: '255.0.0.0' })), /deprecated/);
    assert.match(await errorOf(sb.put(`${O}/${o.id}`, { cidr: 'nope', name: 'Other' })), /'cidr' must be/);
    assert.deepEqual(await ok(sb.get(`${O}/${o.id}`)), o);
  });

  test('groups and objects share one membership', async () => {
    fresh();
    const a = await cidr('A', '10.0.0.0/24');
    const b = await cidr('B', '10.0.1.0/24');
    const g = await ok(sb.post(`${O}/groups`, { name: 'Servers', objectIds: [a.id, a.id] }), 201);
    assert.deepEqual(Object.keys(g), ['id', 'name', 'category', 'createdAt', 'updatedAt', 'objectIds', 'networkIds']);
    assert.equal(g.category, 'NetworkObjectGroup');
    assert.deepEqual(g.objectIds, [Number(a.id)]);
    assert.deepEqual((await ok(sb.get(`${O}/${a.id}`))).groupIds, [g.id]);

    const h = await ok(sb.post(`${O}/groups`, { name: 'Others' }), 201);
    await ok(sb.put(`${O}/${a.id}`, { groupIds: [h.id] }));
    await ok(sb.put(`${O}/${b.id}`, { groupIds: [g.id, h.id] }));
    assert.deepEqual((await ok(sb.get(`${O}/groups/${g.id}`))).objectIds, [Number(b.id)]);
    assert.deepEqual((await ok(sb.get(`${O}/groups/${h.id}`))).objectIds, [Number(a.id), Number(b.id)]);

    const renamed = await ok(sb.put(`${O}/groups/${h.id}`, { name: 'Renamed', objectIds: [b.id] }));
    assert.equal(renamed.name, 'Renamed');
    assert.deepEqual((await ok(sb.get(`${O}/${a.id}`))).groupIds, []);
    assert.deepEqual((await collect(sb.get, `${O}/groups?perPage=10`)).map((x) => x.id), [g.id, h.id]);

    // Deleting an object takes it out of its groups.
    assert.equal((await sb.del(`${O}/${b.id}`)).status, 204);
    assert.deepEqual((await ok(sb.get(`${O}/groups/${h.id}`))).objectIds, []);
    assert.equal((await sb.del(`${O}/groups/${h.id}`)).status, 204);
    assert.equal((await sb.get(`${O}/groups/${h.id}`)).status, 404);
  });

  test('group bodies are checked', async () => {
    fresh();
    const a = await cidr('A');
    const sgt = await ok(sb.post(O, { name: 'Tagged', category: 'adaptivePolicy', type: 'adaptivePolicyIpv4Cidr', cidr: '10.9.0.0/16' }), 201);
    const geo = await ok(sb.post(`${O}/groups`, { name: 'Places', category: 'GeoLocationGroup' }), 201);
    assert.equal(geo.category, 'GeoLocationGroup');
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Ports', category: 'PortObjectGroup', objectIds: [a.id] })), /can't hold policy objects/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'G', objectIds: ['42'] })), /Policy object 42 does not exist/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'G', objectIds: [sgt.id] })), /adaptive policy object/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'G!' })), /letters, digits/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'Places' })), /already exists/);
    assert.match(await errorOf(sb.put(`${O}/${a.id}`, { groupIds: [geo.id] })), /GeoLocationGroup and can't hold/);
    assert.match(await errorOf(sb.put(`${O}/groups/${geo.id}`, { objectIds: [a.id] })), /can't hold policy objects/);
    assert.equal((await sb.get(`${O}/groups/1000000`)).status, 404);
    assert.equal((await sb.put(`${O}/groups/1000000`, { name: 'X' })).status, 404);
  });

  test('firewall rules name objects and groups, which then cannot be deleted', async () => {
    fresh();
    const a = await cidr('A', '10.20.0.0/16');
    const b = await cidr('B', '10.30.0.0/16');
    const g = await ok(sb.post(`${O}/groups`, { name: 'Servers', objectIds: [b.id] }), 201);
    const rules = await ok(l3(hq, [rule(`OBJ(${a.id}),192.168.1.0/24`), rule(`GRP(${g.id})`)]));
    assert.equal(rules.rules[0].destCidr, `OBJ(${a.id}),192.168.1.0/24`);
    await ok(sb.put(`/networks/${austin.id}/appliance/firewall/inboundFirewallRules`, { rules: [rule('Any', `OBJ(${b.id})`)] }));

    assert.deepEqual((await ok(sb.get(`${O}/${a.id}`))).networkIds, [hq.id]);
    // B is named by Austin directly and by HQ through its group.
    assert.deepEqual((await ok(sb.get(`${O}/${b.id}`))).networkIds, [hq.id, austin.id]);
    assert.deepEqual((await ok(sb.get(`${O}/groups/${g.id}`))).networkIds, [hq.id]);

    assert.match(await errorOf(sb.del(`${O}/${a.id}`)), new RegExp(`used by firewall rules in network ${hq.id}`));
    assert.match(await errorOf(sb.del(`${O}/groups/${g.id}`)), /used by firewall rules/);
    await ok(l3(hq, []));
    assert.equal((await sb.del(`${O}/${a.id}`)).status, 204);
    assert.equal((await sb.del(`${O}/groups/${g.id}`)).status, 204);
    assert.deepEqual((await ok(sb.get(`${O}/${b.id}`))).networkIds, [austin.id]);
  });

  test('every rule set checks the references it is given', async () => {
    fresh();
    const a = await cidr('A');
    const sgt = await ok(sb.post(O, { name: 'Tagged', category: 'adaptivePolicy', type: 'adaptivePolicyIpv4Cidr', cidr: '10.9.0.0/16' }), 201);
    const geo = await ok(sb.post(`${O}/groups`, { name: 'Places', category: 'GeoLocationGroup' }), 201);
    const A = `/networks/${hq.id}/appliance/firewall`;
    assert.match(await errorOf(l3(hq, [rule('OBJ(42)')])), /rules\[0\]\.destCidr' names policy object 42, which doesn't exist/);
    assert.match(await errorOf(l3(hq, [rule('Any', `GRP(${a.id})`)])), /srcCidr' names policy object group/);
    assert.match(await errorOf(l3(hq, [rule(`OBJ(${sgt.id})`)])), /adaptive policy object/);
    assert.match(await errorOf(l3(hq, [rule(`GRP(${geo.id})`)])), /not a NetworkObjectGroup/);
    assert.match(await errorOf(sb.put(`${A}/cellularFirewallRules`, { rules: [rule('OBJ(42)')] })), /policy object 42/);
    assert.match(await errorOf(sb.put(`${A}/inboundCellularFirewallRules`, { rules: [rule('Any', 'GRP(7)')] })), /policy object group 7/);
    await ok(sb.put(`${A}/cellularFirewallRules`, { rules: [rule(`OBJ(${a.id}),example.com`, `OBJ(${a.id})`)] }));

    const vpn = `/organizations/${org.id}/appliance/vpn/vpnFirewallRules`;
    assert.match(await errorOf(sb.put(vpn, { rules: [rule('OBJ(42)')] })), /policy object 42/);
    await ok(sb.put(vpn, { rules: [rule(`OBJ(${a.id})`)] }));
    await ok(sb.put(`${A}/cellularFirewallRules`, { rules: [] }));
    assert.match(await errorOf(sb.del(`${O}/${a.id}`)), /site-to-site VPN firewall rules/);
    // VPN rules belong to the organization, not to a network.
    assert.deepEqual((await ok(sb.get(`${O}/${a.id}`))).networkIds, []);
  });

  test('a network whose rules use policy objects stays in its organization', async () => {
    fresh();
    const a = await cidr('A');
    await ok(l3(austin, [rule(`OBJ(${a.id})`)]));
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const body = { network: { id: austin.id }, organizations: { target: { id: dest.id } } };
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, body), 201);
    assert.equal(move.result.status, 'failed');
    assert.match(move.result.reason, /policy objects/);
    await ok(l3(austin, []));
    assert.equal((await ok(sb.post(`/organizations/${org.id}/networks/moves`, body), 201)).result.status, 'completed');
  });
});
