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

  test('a bound network reads its settings from the template', async () => {
    fresh();
    const [hq, austin, reno] = corp.networks;
    const t = await make({ name: 'From HQ', copyFromNetworkId: hq.id });
    const bind = (net, body) => sb.post(`/networks/${net.id}/bind`, body);
    assert.match(await errorOf(bind(austin, { configTemplateId: 'L_1' })), /not found/);
    const blank = await make({ name: 'Blank' });
    assert.match(await errorOf(bind(reno, { configTemplateId: blank.id })), /no camera settings/);
    assert.match(await errorOf(bind(austin, { configTemplateId: blank.id, autoBind: true })), /Auto-bind/);

    const r = await sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.id, r.body.isBoundToConfigTemplate, r.body.configTemplateId], [austin.id, true, t.id]);
    assert.match(await errorOf(bind(austin, { configTemplateId: t.id })), /already bound/);
    assert.equal((await sb.get(`/networks/${austin.id}`)).body.isBoundToConfigTemplate, true);
    const N = `/organizations/${corp.id}/networks`;
    assert.deepEqual((await sb.get(`${N}?isBoundToConfigTemplate=true`)).body.map((n) => n.id), [austin.id]);
    assert.deepEqual((await sb.get(`${N}?configTemplateId=${t.id}`)).body.map((n) => n.id), [austin.id]);
    assert.equal((await sb.get(`${N}?isBoundToConfigTemplate=false`)).body.length, corp.networks.length - 1);
    assert.match(await errorOf(sb.get(`${N}?configTemplateId=${t.id}&isBoundToConfigTemplate=false`)), /cannot be false/);

    // HQ's third SSID comes with the template; settings writes go to the template.
    const hqSsid = (await sb.get(`/networks/${hq.id}/wireless/ssids/2`)).body;
    assert.equal((await sb.get(`/networks/${austin.id}/wireless/ssids/2`)).body.name, hqSsid.name);
    assert.match(await errorOf(sb.put(`/networks/${austin.id}/wireless/ssids/2`, { name: 'Local' })), /bound to a config template/);
    assert.match(await errorOf(sb.put(`/networks/${austin.id}/appliance/vlans/settings`, { vlansEnabled: false })), /bound to a config template/);
    assert.equal((await sb.put(`/networks/${austin.id}`, { notes: 'still mine' })).status, 200);
    assert.equal((await sb.put(`/devices/${austin.aps[0].serial}`, { name: 'AP 1' })).status, 200);
    assert.match(await errorOf(sb.del(`${T}/${t.id}`)), /unbind them first/);
    assert.match(await errorOf(sb.post(`${N}/combine`, { name: 'Both', networkIds: [austin.id, corp.networks[4].id] })), /bound to a config template/);
    const move = await sb.post(`${N}/moves`, { network: { id: austin.id }, organizations: { target: { id: (await sb.post('/organizations', { name: 'Elsewhere' })).body.id } } });
    assert.match(move.body.result.reason, /bound to a configuration template/);

    // Unbinding without retaining the settings starts over from Austin's own defaults.
    const u = await sb.post(`/networks/${austin.id}/unbind`, {});
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(u.body.isBoundToConfigTemplate, false);
    assert.equal('configTemplateId' in u.body, false);
    assert.match(await errorOf(sb.post(`/networks/${austin.id}/unbind`, {})), /not bound/);
    assert.equal((await sb.get(`/networks/${austin.id}/wireless/ssids/2`)).body.enabled, false);
    assert.equal((await sb.del(`${T}/${t.id}`)).status, 204);
  });

  test('retaining configs keeps a copy, and auto-bind uses switch profiles', async () => {
    fresh();
    const [, austin, , , london] = corp.networks;
    const t = await make({ name: 'Branch', copyFromNetworkId: austin.id });
    const [profile] = (await sb.get(`${T}/${t.id}/switch/profiles`)).body;
    assert.equal(profile.model, 'MS130-24P');
    const sw = london.switches[0];
    const P = `/devices/${sw.serial}/switch/ports/5`;
    const before = (await sb.get(P)).body;

    const r = await sb.post(`/networks/${london.id}/bind`, { configTemplateId: t.id, autoBind: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await sb.put(`${T}/${t.id}/switch/profiles/${profile.switchProfileId}/ports/5`, { name: 'From profile', vlan: 77 })).status, 200);
    const bound = (await sb.get(P)).body;
    assert.deepEqual([bound.name, bound.vlan], ['From profile', 77]);
    assert.match(await errorOf(sb.put(P, { vlan: 5 })), /switch profile/);
    const ssid = (await sb.get(`/networks/${austin.id}/wireless/ssids/1`)).body.name;
    assert.equal((await sb.get(`/networks/${london.id}/wireless/ssids/1`)).body.name, ssid);

    const u = await sb.post(`/networks/${london.id}/unbind`, { retainConfigs: true });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal((await sb.get(`/networks/${london.id}/wireless/ssids/1`)).body.name, ssid);
    assert.equal((await sb.put(`/networks/${london.id}/wireless/ssids/1`, { name: 'London Guest' })).status, 200);
    assert.equal((await sb.get(`/networks/${austin.id}/wireless/ssids/1`)).body.name, ssid);
    const kept = (await sb.get(P)).body;
    assert.deepEqual([kept.name, kept.vlan], ['From profile', 77]);
    assert.equal((await sb.put(P, { vlan: 5 })).status, 200);
    assert.notDeepEqual(before, kept);
  });
});
