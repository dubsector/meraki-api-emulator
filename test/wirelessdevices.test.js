import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { relLink, start } from './helpers.js';

describe('AP port profiles, zero touch deployments and RadSec', () => {
  let sb;
  let corp;
  let lab;
  let hq;
  let P;
  let D;
  let C;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    hq = corp.networks[0];
    P = `/networks/${hq.id}/wireless/ethernet/ports/profiles`;
    D = `/organizations/${corp.id}/wireless/devices/provisioning/deployments`;
    C = `/organizations/${corp.id}/wireless/devices/radsec/certificates/authorities`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const spare = () => corp.spares.find((d) => d.productType === 'wireless');
  const replace = (extra = {}) => ({ items: [{ devices: { new: { serial: spare().serial }, old: { serial: hq.aps[0].serial } }, status: 'ready', type: 'replace', ...extra }] });

  test('every network starts with a default port profile on SSID 1', async () => {
    fresh();
    const list = await ok(sb.get(P));
    assert.deepEqual(list, [
      {
        profileId: '1001',
        name: 'Default',
        isDefault: true,
        ports: [
          { name: 'port 1', number: 1, enabled: true, ssid: 1 },
          { name: 'port 2', number: 2, enabled: true, ssid: 1 },
        ],
        usbPorts: [{ name: 'usb port', enabled: false, ssid: 1 }],
      },
    ]);
    assert.deepEqual(await ok(sb.get(`${P}/1001`)), list[0]);
    assert.match(await errorOf(sb.get(`${P}/9999`), 404), /AP port profile not found/);
    assert.match(await errorOf(sb.get(`/networks/${corp.networks.find((n) => !n.productTypes.includes('wireless'))?.id ?? 'N_1'}/wireless/ethernet/ports/profiles`), 404), /not found/i);
  });

  test('profiles are created, numbered, updated and deleted', async () => {
    fresh();
    const p = await ok(sb.post(P, { name: 'Lobby', ports: [{ name: 'Kiosk', ssid: 2, pskGroupId: '100' }, { name: 'Phone', enabled: false }] }), 201);
    assert.deepEqual(p, {
      profileId: '1002',
      name: 'Lobby',
      isDefault: false,
      ports: [
        { name: 'Kiosk', number: 1, enabled: true, ssid: 2, pskGroupId: '100' },
        { name: 'Phone', number: 2, enabled: false, ssid: 0 },
      ],
      usbPorts: [],
    });
    const u = await ok(sb.put(`${P}/1002`, { name: 'Lobby 2', usbPorts: [{ name: 'usb', ssid: 3 }] }));
    assert.deepEqual([u.name, u.ports.length, u.usbPorts], ['Lobby 2', 2, [{ name: 'usb', enabled: true, ssid: 3 }]]);
    assert.match(await errorOf(sb.post(P, { name: 'Lobby 2', ports: [] })), /already exists/);
    assert.match(await errorOf(sb.post(P, { name: 'X', ports: [{ name: 'p', ssid: 15 }] })), /'ports\[0\]\.ssid' must be an SSID number between 0 and 14/);
    assert.match(await errorOf(sb.post(P, { name: 'X', ports: [{ name: ' ' }] })), /'ports\[0\]\.name' must not be empty/);
    assert.match(await errorOf(sb.post(P, { name: 'X', ports: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}` })) })), /limited to 8 ports/);
    assert.match(await errorOf(sb.post(P, { name: 'X' })), /'ports' is required/);
    assert.match(await errorOf(sb.del(`${P}/1001`)), /default AP port profile cannot be deleted/);
    await ok(sb.del(`${P}/1002`), 204);
    assert.deepEqual((await ok(sb.get(P))).map((x) => x.profileId), ['1001']);
    // A deleted ID isn't handed out again.
    assert.equal((await ok(sb.post(P, { name: 'Next', ports: [] }), 201)).profileId, '1003');
  });

  test('assign and setDefault take profiles of this network and APs in it', async () => {
    fresh();
    await ok(sb.post(P, { name: 'Lobby', ports: [{ name: 'Kiosk' }] }), 201);
    const [a, b] = hq.aps.map((d) => d.serial);
    assert.deepEqual(await ok(sb.post(`${P}/assign`, { serials: [a, b, a], profileId: '1002' }), 201), { serials: [a, b], profileId: '1002' });
    assert.equal(sb.world.networkById.get(hq.id).wirelessPortProfiles.assignments.length, 2);
    assert.match(await errorOf(sb.post(`${P}/assign`, { serials: [hq.switches[0].serial], profileId: '1002' })), /is not an access point in this network/);
    assert.match(await errorOf(sb.post(`${P}/assign`, { serials: [a], profileId: '42' })), /AP port profile '42' not found/);
    assert.match(await errorOf(sb.post(`${P}/assign`, { serials: [], profileId: '1002' })), /at least one access point/);
    assert.deepEqual(await ok(sb.post(`${P}/setDefault`, { profileId: '1002' })), { profileId: '1002' });
    assert.deepEqual((await ok(sb.get(P))).map((x) => [x.profileId, x.isDefault]), [['1001', false], ['1002', true]]);
    assert.match(await errorOf(sb.post(`${P}/setDefault`, { profileId: '7' })), /not found/);
    // The old default can go now; APs on it fall back to the new default.
    await ok(sb.post(`${P}/assign`, { serials: [a], profileId: '1001' }), 201);
    await ok(sb.del(`${P}/1001`), 204);
    assert.deepEqual(sb.world.networkById.get(hq.id).wirelessPortProfiles.assignments, []);
  });

  test('port profiles stay writable on a bound network and follow split and combine', async () => {
    fresh();
    const toronto = lab.networks[0];
    const t = await ok(sb.post(`/organizations/${lab.id}/configTemplates`, { name: 'Blank' }), 201);
    await ok(sb.post(`/networks/${toronto.id}/bind`, { configTemplateId: t.id }));
    await ok(sb.post(`/networks/${toronto.id}/wireless/ethernet/ports/profiles`, { name: 'Bound', ports: [] }), 201);

    await ok(sb.post(P, { name: 'Lobby', ports: [] }), 201);
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    assert.deepEqual((await ok(sb.get(`/networks/${wl.id}/wireless/ethernet/ports/profiles`))).map((x) => x.name), ['Default', 'Lobby']);
    const net = (await ok(sb.post(`/organizations/${corp.id}/networks/combine`, { name: hq.name, networkIds: parts.map((n) => n.id) }))).resultingNetwork;
    assert.deepEqual((await ok(sb.get(`/networks/${net.id}/wireless/ethernet/ports/profiles`))).map((x) => x.name), ['Default', 'Lobby']);
  });

  test('a zero touch deployment fills in both devices and finishes on a frozen clock', async () => {
    fresh();
    const ap = hq.aps[0];
    const res = await ok(sb.post(D, replace()), 201);
    const [x] = res.items;
    assert.match(x.deploymentId, /^\d{18}$/);
    assert.deepEqual(res.meta, { counts: { items: { total: 1, remaining: 0 } } });
    const rf = (await ok(sb.get(`/networks/${hq.id}/wireless/rfProfiles`))).find((p) => p.isIndoorDefault);
    assert.deepEqual(x, {
      deploymentId: x.deploymentId,
      devices: {
        old: { serial: ap.serial, afterAction: 'unclaim', name: ap.name, model: ap.model, mac: ap.mac, tags: ap.tags, rfProfile: { id: rf.id, name: rf.name } },
        new: { serial: spare().serial, name: spare().serial, model: spare().model, mac: spare().mac, tags: [] },
      },
      status: 'completed',
      type: 'replace',
      network: { id: hq.id, name: hq.name },
      createdAt: '2026-09-29T18:30:00.000000Z',
      requestedAt: '2026-09-29T18:30:00.000000Z',
      lastUpdatedAt: '2026-09-29T18:30:00.000000Z',
      completedAt: '2026-09-29T18:30:00.000000Z',
      errors: [],
    });
    const [page] = await ok(sb.get(D));
    assert.deepEqual(page.items, [x]);
    // A completed deployment frees its device for another one.
    const again = await ok(sb.post(D, { items: [{ devices: { new: { serial: spare().serial, name: 'Kiosk AP', rfProfile: { id: rf.id } } }, status: 'ready', type: 'deploy', network: { id: hq.id } }] }), 201);
    assert.deepEqual(again.items[0].devices, { new: { serial: spare().serial, name: 'Kiosk AP', model: spare().model, mac: spare().mac, tags: [], rfProfile: { id: rf.id, name: rf.name } } });
  });

  test('deployment bodies are checked before anything is stored', async () => {
    fresh();
    const item = (devices, extra = {}) => ({ items: [{ devices, status: 'ready', type: 'deploy', ...extra }] });
    const s = spare().serial;
    assert.match(await errorOf(sb.post(D, { items: [] })), /at least one deployment/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: hq.aps[0].serial } }))), /not an access point in this organization's inventory/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: corp.spares.find((d) => d.productType === 'switch').serial } }))), /inventory/);
    assert.match(await errorOf(sb.post(D, item({ new: {} }))), /'items\[0\]\.devices\.new\.serial' is required/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s } }, { type: 'move' }))), /'items\[0\]\.type' must be 'deploy' or 'replace'/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s } }, { status: 'done' }))), /'items\[0\]\.status' must be one of/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s } }, { type: 'replace' }))), /old\.serial' is required for a replace/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s }, old: { serial: hq.aps[0].serial } }))), /only applies to a replace/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s }, old: { serial: hq.switches[0].serial } }, { type: 'replace' }))), /not an access point in this organization/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s, rfProfile: { id: '1' } } }))), /needs a network/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s, rfProfile: { id: '1' } } }, { network: { id: hq.id } }))), /RF profile '1' not found/);
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s } }, { network: { id: lab.networks[0].id } }))), /is not in this organization/);
    const austin = corp.networks.find((n) => n.name === 'Branch - Austin');
    assert.match(await errorOf(sb.post(D, item({ new: { serial: s }, old: { serial: hq.aps[0].serial } }, { type: 'replace', network: { id: austin.id } }))), /is not in network/);
    const two = { items: [replace().items[0], replace().items[0]] };
    assert.match(await errorOf(sb.post(D, two)), /already has a zero touch deployment/);
    assert.deepEqual((await ok(sb.get(D)))[0].items, []);
  });

  test('deployments are updated, filtered, sorted, paged and deleted', async () => {
    fresh();
    const [x] = (await ok(sb.post(D, replace()), 201)).items;
    const u = await ok(sb.put(D, { items: [{ deploymentId: x.deploymentId, devices: { new: { serial: spare().serial, name: 'Lobby AP', tags: ['lobby'] }, old: { serial: hq.aps[1].serial, afterAction: 'release' } }, status: 'ready', type: 'replace' }] }));
    assert.deepEqual([u.items[0].devices.new.name, u.items[0].devices.new.tags, u.items[0].devices.old.serial, u.items[0].devices.old.afterAction], ['Lobby AP', ['lobby'], hq.aps[1].serial, 'release']);
    assert.match(await errorOf(sb.put(D, { items: [{ deploymentId: '1', devices: { new: { serial: spare().serial } }, status: 'ready', type: 'deploy' }] })), /must name a zero touch deployment/);
    // A second deployment for the other organization's spare can't be made here.
    assert.match(await errorOf(sb.post(D, { items: [{ devices: { new: { serial: lab.spares[0].serial } }, status: 'ready', type: 'deploy' }] })), /inventory/);
    // Filters and sorting.
    const list = async (q) => (await ok(sb.get(`${D}?${q}`)))[0].items.map((d) => d.deploymentId);
    assert.deepEqual(await list('search=lobby'), [x.deploymentId]);
    assert.deepEqual(await list(`search=${hq.aps[1].mac.toUpperCase()}`), [x.deploymentId]);
    assert.deepEqual(await list('search=nothing'), []);
    assert.deepEqual(await list(`search=${hq.aps[1].serial}`), [x.deploymentId]);
    assert.deepEqual(await list('deploymentType=deploy'), []);
    assert.match(await errorOf(sb.get(`${D}?sortBy=size`)), /'sortBy' must be one of/);
    assert.match(await errorOf(sb.get(`${D}?sortOrder=up`)), /'sortOrder'/);
    assert.match(await errorOf(sb.get(`${D}?deploymentType=swap`)), /'deploymentType'/);
    assert.match(await errorOf(sb.get(`${D}?perPage=2`)), /'perPage' must be an integer between 3 and 1000/);
    await ok(sb.del(`${D}/${x.deploymentId}`), 204);
    assert.match(await errorOf(sb.del(`${D}/${x.deploymentId}`), 404), /Zero touch deployment not found/);
  });

  test('deployment pages walk with rel=next and keep the network through split', async () => {
    fresh();
    // Completed deployments free the spare, so one serial can be deployed many times.
    for (let i = 0; i < 5; i++) await ok(sb.post(D, { items: [{ devices: { new: { serial: spare().serial, name: `AP ${i}` } }, status: 'ready', type: 'deploy', network: { id: hq.id } }] }), 201);
    const pages = [];
    let url = `${D}?perPage=3&sortBy=name&sortOrder=desc`;
    while (url) {
      const res = await sb.get(url);
      pages.push(res.body[0]);
      url = relLink(res.link, 'next');
    }
    assert.deepEqual(pages.map((p) => p.meta.counts.items), [{ total: 5, remaining: 2 }, { total: 5, remaining: 0 }]);
    assert.deepEqual(pages.flatMap((p) => p.items.map((d) => d.devices.new.name)), ['AP 4', 'AP 3', 'AP 2', 'AP 1', 'AP 0']);
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    assert.deepEqual(new Set((await ok(sb.get(`${D}?perPage=10`)))[0].items.map((d) => d.network.id)), new Set([wl.id]));
    await ok(sb.del(`/networks/${wl.id}`), 204);
    assert.ok((await ok(sb.get(`${D}?perPage=10`)))[0].items.every((d) => !('network' in d)));
  });

  test('a RadSec CA is generated once, then trusted, with empty CRLs', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(C)), [{ items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } }]);
    assert.deepEqual(await ok(sb.get(`${C}/crls`)), { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    const ca = await ok(sb.post(C), 202);
    assert.match(ca.certificateAuthorityId, /^\d{4}$/);
    assert.equal(ca.status, 'untrusted');
    assert.match(ca.contents, /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/]{64}\n)+[A-Za-z0-9+/]+\n-----END CERTIFICATE-----\n$/);
    assert.deepEqual(await ok(sb.post(C), 202), ca);
    assert.deepEqual((await ok(sb.get(C)))[0].items, [ca]);
    assert.deepEqual((await ok(sb.get(`${C}?certificateAuthorityIds[]=1`)))[0].items, []);
    assert.match(await errorOf(sb.put(C, { status: 'untrusted', certificateAuthorityId: ca.certificateAuthorityId })), /'status' must be 'trusted'/);
    assert.match(await errorOf(sb.put(C, { status: 'trusted' })), /'certificateAuthorityId' is required/);
    assert.match(await errorOf(sb.put(C, { status: 'trusted', certificateAuthorityId: '1' }), 404), /Certificate authority not found/);
    assert.deepEqual(await ok(sb.put(C, { status: 'trusted', certificateAuthorityId: ca.certificateAuthorityId })), { ...ca, status: 'trusted' });
    const crls = await ok(sb.get(`${C}/crls`));
    const deltas = await ok(sb.get(`${C}/crls/deltas?certificateAuthorityIds[]=${ca.certificateAuthorityId}`));
    assert.equal(crls.items[0].certificateAuthorityId, ca.certificateAuthorityId);
    assert.match(crls.items[0].crl, /^-----BEGIN X509 CRL-----\n/);
    assert.notEqual(crls.items[0].crl, deltas.items[0].crl);
    assert.deepEqual((await ok(sb.get(`${C}/crls?certificateAuthorityIds[]=9`))).items, []);
    // Each organization has its own.
    assert.notDeepEqual((await ok(sb.post(`/organizations/${lab.id}/wireless/devices/radsec/certificates/authorities`), 202)).contents, ca.contents);
  });
});

describe('zero touch deployments and RadSec on a running clock', () => {
  let sb;
  before(async () => (sb = await start({ now: null })));
  after(() => sb.close());

  test('a deployment starts ready and a CA starts generating with no contents', async () => {
    const corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    const spare = corp.spares.find((d) => d.productType === 'wireless');
    const D = `/organizations/${corp.id}/wireless/devices/provisioning/deployments`;
    const [x] = (await sb.post(D, { items: [{ devices: { new: { serial: spare.serial } }, status: 'ready', type: 'deploy' }] })).body.items;
    assert.equal(x.status, 'ready');
    assert.ok(!('completedAt' in x));
    assert.match((await sb.post(D, { items: [{ devices: { new: { serial: spare.serial } }, status: 'ready', type: 'deploy' }] })).body.errors[0], /already has/);
    const C = `/organizations/${corp.id}/wireless/devices/radsec/certificates/authorities`;
    const ca = (await sb.post(C)).body;
    assert.deepEqual([ca.status, ca.contents], ['generating', null]);
    assert.match((await sb.put(C, { status: 'trusted', certificateAuthorityId: ca.certificateAuthorityId })).body.errors[0], /not been generated yet/);
    assert.deepEqual((await sb.get(`${C}/crls`)).body.items, []);
  });
});
