import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('config templates', () => {
  let sb;
  let corp;
  let T;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp] = sb.world.orgs;
    T = `/organizations/${corp.id}/configTemplates`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const make = async (body) => {
    const r = await sb.post(T, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  test('templates are created, read, updated and deleted', async () => {
    fresh();
    assert.deepEqual((await sb.get(T)).body, []);
    const t = await make({ name: 'Branch', timeZone: 'Europe/London' });
    assert.match(t.id, /^L_\d{18}$/);
    assert.deepEqual(t, { id: t.id, name: 'Branch', productTypes: ['appliance', 'switch', 'wireless'], timeZone: 'Europe/London' });
    assert.deepEqual((await sb.get(`${T}/${t.id}`)).body, t);
    assert.match(await errorOf(sb.post(T, { name: 'Branch' })), /taken/);
    assert.match(await errorOf(sb.post(T, { name: 'Other', timeZone: 'Mars/Base' })), /timeZone/);
    await errorOf(sb.post(T, { name: 'Other', copyFromNetworkId: 'N_1' }), 404);

    const up = await sb.put(`${T}/${t.id}`, { name: 'Branch v2', timeZone: 'America/Chicago' });
    assert.deepEqual([up.body.name, up.body.timeZone], ['Branch v2', 'America/Chicago']);
    assert.deepEqual((await sb.get(T)).body.map((x) => x.name), ['Branch v2']);
    assert.deepEqual((await sb.get(`${T}/${t.id}/switch/profiles`)).body, []);
    assert.equal((await sb.del(`${T}/${t.id}`)).status, 204);
    await errorOf(sb.get(`${T}/${t.id}`), 404);
    // Templates aren't networks, so the network list doesn't change.
    assert.equal((await sb.get(`/organizations/${corp.id}/networks`)).body.length, corp.networks.length);
  });

  test('a template copied from a network has a switch profile per switch model', async () => {
    fresh();
    const hq = corp.networks[0];
    const t = await make({ name: 'Campus', copyFromNetworkId: hq.id });
    assert.deepEqual([t.productTypes, t.timeZone], [hq.productTypes, hq.timeZone]);
    const profiles = (await sb.get(`${T}/${t.id}/switch/profiles`)).body;
    const models = [...new Set(hq.switches.map((s) => s.model))];
    assert.deepEqual(profiles.map((p) => p.model), models);
    for (const p of profiles) assert.match(p.switchProfileId, /^\d{12}$/);

    const P = `${T}/${t.id}/switch/profiles/${profiles[0].switchProfileId}/ports`;
    const ports = (await sb.get(P)).body;
    const sw = hq.switches.find((s) => s.model === profiles[0].model);
    assert.equal(ports.length, sw.ports.length);
    assert.deepEqual(ports.map((p) => p.portId), sw.ports.map((p) => p.portId));
    // Template ports start from the model's defaults, without the device's PoE extras.
    const device = (await sb.get(`/devices/${sw.serial}/switch/ports/1`)).body;
    assert.deepEqual(Object.keys(ports[0]), Object.keys(device).filter((k) => k !== 'perpetualPoe' && k !== 'fastPoe'));
    const uplink = (await sb.get(`/devices/${sw.serial}/switch/ports/${ports.at(-1).portId}`)).body;
    assert.deepEqual(ports.at(-1).linkNegotiationCapabilities, uplink.linkNegotiationCapabilities);
    assert.deepEqual((await sb.get(`${P}/1`)).body, ports[0]);

    const r = await sb.put(`${P}/5`, { name: 'Desk', type: 'access', vlan: 10, voiceVlan: 20, tags: ['desk'], portId: '9' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.portId, r.body.name, r.body.type, r.body.vlan, r.body.voiceVlan, r.body.tags], ['5', 'Desk', 'access', 10, 20, ['desk']]);
    assert.deepEqual((await sb.get(`${P}/5`)).body, r.body);
    assert.match(await errorOf(sb.put(`${P}/5`, { vlan: 5000 })), /vlan/);
    assert.match(await errorOf(sb.put(`${P}/5`, { linkNegotiation: '40 Gigabit full duplex (forced)' })), /linkNegotiation/);
    await errorOf(sb.get(`${P}/99`), 404);
    await errorOf(sb.get(`${T}/${t.id}/switch/profiles/1/ports`), 404);
    // The switch the profile was made from keeps its own settings.
    assert.notEqual((await sb.get(`/devices/${sw.serial}/switch/ports/5`)).body.name, 'Desk');

    // Copying the template copies its profiles and their ports.
    const copy = await make({ name: 'Campus 2', copyFromNetworkId: t.id });
    const copied = (await sb.get(`${T}/${copy.id}/switch/profiles`)).body;
    assert.deepEqual(copied.map((p) => p.model), models);
    assert.equal((await sb.get(`${T}/${copy.id}/switch/profiles/${copied[0].switchProfileId}/ports/5`)).body.name, 'Desk');
  });

  test('a network without switches gives a template without profiles', async () => {
    fresh();
    const lab = sb.world.orgs[1];
    const r = await sb.post(`/organizations/${lab.id}/configTemplates`, { name: 'Wireless', copyFromNetworkId: lab.networks[0].id });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.id.slice(0, 2), r.body.productTypes], ['N_', ['wireless']]);
    assert.deepEqual((await sb.get(`/organizations/${lab.id}/configTemplates/${r.body.id}/switch/profiles`)).body, []);
    await errorOf(sb.post(T, { name: 'Wrong org', copyFromNetworkId: lab.networks[0].id }), 404);
  });
});
