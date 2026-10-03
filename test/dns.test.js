import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('MX local and split DNS', () => {
  let sb;
  let org;
  let hq;
  let austin;
  let D;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    D = `/organizations/${org.id}/appliance/dns`;
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
  const localProfile = (name) => ok(sb.post(`${D}/local/profiles`, { name }), 201);
  const splitProfile = (name, hostnames = ['*.corp.example.com']) => ok(sb.post(`${D}/split/profiles`, { name, hostnames, nameservers: { addresses: ['10.0.0.53'] } }), 201);
  const assign = (kind, ...pairs) => sb.post(`${D}/${kind}/profiles/assignments/bulkCreate`, { items: pairs.map(([n, p]) => ({ network: { id: n.id }, profile: { id: p.profileId } })) });

  test('local profiles count IDs up and keep their names unique', async () => {
    fresh();
    const a = await localProfile('Default');
    const b = await localProfile('Lab');
    assert.equal(Number(b.profileId), Number(a.profileId) + 1);
    assert.deepEqual(Object.keys(a), ['profileId', 'name']);
    assert.match(await errorOf(sb.post(`${D}/local/profiles`, { name: 'Lab' })), /already exists/);
    assert.match(await errorOf(sb.post(`${D}/local/profiles`, {})), /'name' is required/);

    assert.equal((await ok(sb.put(`${D}/local/profiles/${b.profileId}`, { name: 'Lab 2' }))).name, 'Lab 2');
    assert.equal((await sb.put(`${D}/local/profiles/999`, { name: 'x' })).status, 404);
    assert.deepEqual((await ok(sb.get(`${D}/local/profiles`))).map((p) => p.name), ['Default', 'Lab 2']);
    assert.deepEqual((await ok(sb.get(`${D}/local/profiles?profileIds[]=${b.profileId}`))).map((p) => p.name), ['Lab 2']);

    assert.equal((await sb.del(`${D}/local/profiles/${b.profileId}`)).status, 204);
    assert.equal((await sb.del(`${D}/local/profiles/${b.profileId}`)).status, 404);
    assert.equal(Number((await localProfile('Next')).profileId), Number(b.profileId) + 1);
  });

  test('local records name a profile and check hostname and address', async () => {
    fresh();
    const a = await localProfile('Default');
    const b = await localProfile('Lab');
    const R = `${D}/local/records`;
    const rec = await ok(sb.post(R, { hostname: 'www.test.com', address: '10.1.1.10', profile: { id: a.profileId } }), 201);
    assert.deepEqual(rec, { recordId: rec.recordId, hostname: 'www.test.com', address: '10.1.1.10', profile: { id: a.profileId } });
    assert.match(await errorOf(sb.post(R, { hostname: 'WWW.test.com', address: '10.1.1.11', profile: { id: a.profileId } })), /already exists/);
    assert.match(await errorOf(sb.post(R, { hostname: 'bad_name', address: '10.1.1.11', profile: { id: a.profileId } })), /not a valid hostname/);
    assert.match(await errorOf(sb.post(R, { hostname: 'x.test.com', address: '10.1.1.0/24', profile: { id: a.profileId } })), /not a valid IPv4/);
    assert.match(await errorOf(sb.post(R, { hostname: 'x.test.com', address: '10.1.1.11', profile: { id: '1' } })), /does not exist/);
    assert.match(await errorOf(sb.post(R, { hostname: 'x.test.com', address: '10.1.1.11', profile: {} })), /'profile.id' is required/);
    assert.match(await errorOf(sb.post(R, { hostname: 'x.test.com', profile: { id: a.profileId } })), /'address' is required/);

    // The same hostname may sit in another profile.
    const other = await ok(sb.post(R, { hostname: 'www.test.com', address: '10.2.1.10', profile: { id: b.profileId } }), 201);
    assert.deepEqual((await ok(sb.get(`${R}?profileIds[]=${b.profileId}`))).map((r) => r.recordId), [other.recordId]);
    assert.match(await errorOf(sb.put(`${R}/${other.recordId}`, { profile: { id: a.profileId } })), /already exists/);
    const moved = await ok(sb.put(`${R}/${other.recordId}`, { hostname: 'lab.test.com', profile: { id: a.profileId } }));
    assert.deepEqual([moved.hostname, moved.address, moved.profile.id], ['lab.test.com', '10.2.1.10', a.profileId]);

    // A profile holding records can't go until they do.
    assert.match(await errorOf(sb.del(`${D}/local/profiles/${a.profileId}`)), /still has DNS records/);
    assert.equal((await sb.del(`${R}/${rec.recordId}`)).status, 204);
    assert.equal((await sb.del(`${R}/${other.recordId}`)).status, 204);
    assert.equal((await sb.del(`${R}/${other.recordId}`)).status, 404);
    assert.equal((await sb.del(`${D}/local/profiles/${a.profileId}`)).status, 204);
  });

  test('split profiles take hostname patterns and one nameserver', async () => {
    fresh();
    const s = await splitProfile('Corp', ['*.test1.com', 'intranet.example.com']);
    assert.deepEqual(s, { profileId: s.profileId, name: 'Corp', hostnames: ['*.test1.com', 'intranet.example.com'], nameservers: { addresses: ['10.0.0.53'] } });
    const P = `${D}/split/profiles`;
    assert.match(await errorOf(sb.post(P, { name: 'X', hostnames: ['*'], nameservers: { addresses: ['1.1.1.1'] } })), /not a valid hostname pattern/);
    assert.match(await errorOf(sb.post(P, { name: 'X', hostnames: [], nameservers: { addresses: ['1.1.1.1'] } })), /at least one/);
    assert.match(await errorOf(sb.post(P, { name: 'X', hostnames: ['a.com'], nameservers: { addresses: ['1.1.1.1', '8.8.8.8'] } })), /maximum of one/);
    assert.match(await errorOf(sb.post(P, { name: 'X', hostnames: ['a.com'], nameservers: {} })), /must hold one address/);
    assert.match(await errorOf(sb.post(P, { name: 'X', hostnames: ['a.com'] })), /'nameservers' is required/);

    const upd = await ok(sb.put(`${P}/${s.profileId}`, { nameservers: { addresses: ['10.0.0.54'] } }));
    assert.deepEqual([upd.hostnames, upd.nameservers.addresses], [['*.test1.com', 'intranet.example.com'], ['10.0.0.54']]);
    assert.match(await errorOf(sb.put(`${P}/${s.profileId}`, { nameservers: { addresses: ['nope'] } })), /not a valid IPv4/);
    assert.deepEqual(await ok(sb.get(P)), [upd]);
    assert.equal((await sb.del(`${P}/${s.profileId}`)).status, 204);
    assert.deepEqual(await ok(sb.get(P)), []);
  });

  test('assignments give a network with an MX one profile of each kind', async () => {
    fresh();
    const a = await localProfile('Default');
    const b = await localProfile('Lab');
    const s = await splitProfile('Corp');
    const made = (await ok(assign('local', [hq, a], [austin, b]))).items;
    assert.deepEqual(made.map((x) => [x.network.id, x.profile.id]), [[hq.id, a.profileId], [austin.id, b.profileId]]);
    assert.ok(made.every((x) => /^\d+$/.test(x.assignmentId)));
    // The split kind is separate.
    await ok(assign('split', [hq, s]));

    const L = `${D}/local/profiles/assignments`;
    const all = await ok(sb.get(L));
    assert.deepEqual(all.meta.counts.items, { total: 2, remaining: 0 });
    assert.deepEqual((await ok(sb.get(`${L}?networkIds[]=${austin.id}`))).items, [made[1]]);
    assert.deepEqual((await ok(sb.get(`${L}?profileIds[]=${a.profileId}`))).items, [made[0]]);

    assert.match(await errorOf(assign('local', [hq, b])), /already has a local DNS profile/);
    assert.match(await errorOf(assign('local', [hq, { profileId: '1' }])), /does not exist/);
    assert.match(await errorOf(sb.post(`${L}/bulkCreate`, { items: [] })), /at least one/);
    assert.match(await errorOf(sb.post(`${L}/bulkCreate`, { items: [{ network: { id: hq.id } }] })), /'items\[\]\.profile\.id' is required/);
    const wifi = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'Wi-Fi only', productTypes: ['wireless'] }), 201);
    assert.match(await errorOf(assign('local', [wifi, a])), /has no appliance/);
    const denver = org.networks.find((n) => n.name === 'Retail - Denver');
    assert.match(await errorOf(assign('local', [denver, a], [denver, b])), /more than once/);
    // A refused request assigns nothing.
    assert.equal((await ok(sb.get(L))).items.length, 2);

    assert.match(await errorOf(sb.del(`${D}/local/profiles/${a.profileId}`)), /is assigned to a network/);
    assert.match(await errorOf(sb.post(`${L}/bulkDelete`, { items: [{ assignmentId: '1' }] })), /does not exist/);
    const gone = await ok(sb.post(`${L}/bulkDelete`, { items: [{ assignmentId: made[0].assignmentId }] }));
    assert.deepEqual(gone.items, [made[0]]);
    assert.deepEqual((await ok(sb.get(L))).items, [made[1]]);
    assert.equal((await sb.del(`${D}/local/profiles/${a.profileId}`)).status, 204);
  });

  test('assignments follow their network through split and combine, and leave with it', async () => {
    fresh();
    const a = await localProfile('Default');
    const b = await localProfile('Lab');
    await ok(assign('local', [hq, a]));
    const L = `${D}/local/profiles/assignments`;
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const mx = parts.find((n) => n.productTypes.includes('appliance'));
    assert.deepEqual((await ok(sb.get(L))).items.map((x) => x.network.id), [mx.id]);

    // Combining the parts again moves it to the combined network.
    await ok(assign('local', [austin, b]));
    const sw = parts.find((n) => n.productTypes.includes('switch'));
    const net = (await ok(sb.post(`/organizations/${org.id}/networks/combine`, { name: 'Merged', networkIds: [mx.id, sw.id] }))).resultingNetwork;
    assert.deepEqual((await ok(sb.get(L))).items.map((x) => [x.network.id, x.profile.id]), [[net.id, a.profileId], [austin.id, b.profileId]]);

    // A deleted network drops out, and its profile can go.
    assert.equal((await sb.del(`/networks/${austin.id}`)).status, 204);
    assert.deepEqual((await ok(sb.get(L))).items.map((x) => x.network.id), [net.id]);
    assert.equal((await sb.del(`${D}/local/profiles/${b.profileId}`)).status, 204);

    // A network moved to another organization leaves its assignment behind.
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: net.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(move.result.status, 'completed', move.result.reason);
    assert.deepEqual((await ok(sb.get(L))).items, []);
  });
});
