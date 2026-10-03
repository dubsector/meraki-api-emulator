import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('SSID profiles, isolation allowlist and OpenRoaming', () => {
  let sb;
  let corp;
  let lab;
  let hq;
  let austin;
  let P;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    hq = corp.networks[0];
    austin = corp.networks.find((n) => n.name === 'Branch - Austin');
    P = `/organizations/${corp.id}/wireless/ssids`;
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

  test('profiles are created with defaults, updated in part and keep the passphrase hidden', async () => {
    fresh();
    const p = await ok(sb.post(`${P}/profiles`, { name: 'Corp', ssid: { name: 'Corp-WiFi', security: { mode: 'psk', protocol: 'WPA3 only', encryption: { passphrase: 'correct horse', akms: ['SAE'] } } } }));
    assert.deepEqual(Object.keys(p), ['id', 'name', 'precedence', 'ssid']);
    assert.match(p.id, /^\d{18}$/);
    assert.deepEqual(p.precedence, { radius: 'network' });
    assert.deepEqual(p.ssid.security, { mode: 'psk', protocol: 'WPA3 only', encryption: { ciphers: [], akms: ['SAE'] }, dhcp: { mandatory: { enabled: false } } });
    assert.deepEqual(Object.keys(p.ssid), ['name', 'advertisement', 'security', 'radius', 'addressing', 'splash']);
    assert.ok(!JSON.stringify(p).includes('correct horse'));

    const u = await ok(sb.put(`${P}/profiles/${p.id}`, { name: 'Corporate', ssid: { advertisement: { enabled: false }, addressing: { mode: 'NAT mode', bonjourForwarding: { enabled: true, rules: [{ vlan: { id: 10 }, services: ['AirPlay'] }] } }, splash: { mode: 'click-through', timeout: 30 } } }));
    assert.equal(u.name, 'Corporate');
    assert.equal(u.ssid.name, 'Corp-WiFi');
    assert.equal(u.ssid.advertisement.enabled, false);
    assert.equal(u.ssid.security.mode, 'psk');
    assert.deepEqual(u.ssid.addressing.bonjourForwarding, { enabled: true, rules: [{ description: '', vlan: { id: 10 }, services: ['AirPlay'] }] });
    assert.deepEqual([u.ssid.splash.mode, u.ssid.splash.timeout, u.ssid.splash.preAccess.mode], ['click-through', 30, 'block-all']);
    // A null leaves the field as it was.
    assert.equal((await ok(sb.put(`${P}/profiles/${p.id}`, { ssid: { name: null, security: null } }))).ssid.name, 'Corp-WiFi');
  });

  test('profile writes are checked before anything changes', async () => {
    fresh();
    const p = await ok(sb.post(`${P}/profiles`, { name: 'Guest', ssid: {} }));
    assert.equal(p.ssid.name, 'Guest');
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'Guest', ssid: {} })), /already exists/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X' })), /'ssid' is required/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X', ssid: { security: { mode: 'psk' } } })), /passphrase' is required/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X', ssid: { security: { mode: 'psk', encryption: { passphrase: 'short' } } } })), /8 to 63/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X', ssid: { security: { encryption: { ciphers: ['GCMP 256'] } } } })), /WPA3/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X', ssid: { radius: { servers: [{ id: '7' }] } } })), /RADIUS server '7'/);
    assert.match(await errorOf(sb.post(`${P}/profiles`, { name: 'X', ssid: { security: { mode: 'wep' } } })), /must be one of/);
    const B = `${P}/profiles/${p.id}`;
    assert.match(await errorOf(sb.put(B, { ssid: { addressing: { bonjourForwarding: { rules: [{ vlan: { id: 5000 }, services: ['AirPlay'] }] } } } })), /VLAN ID/);
    assert.match(await errorOf(sb.put(B, { ssid: { addressing: { mdns: { rules: [{ services: [] }] } } } })), /at least one service/);
    assert.match(await errorOf(sb.put(B, { ssid: { splash: { captivePortal: { external: { url: 'ftp://x' } } } } })), /http or https/);
    assert.match(await errorOf(sb.put(B, { ssid: { splash: { auth: { oauth: { domains: ['not a domain'] } } } } })), /invalid domain/);
    assert.match(await errorOf(sb.put(B, { ssid: { splash: { preAccess: { walledGarden: { ranges: ['10.0.0.0/8', '*.example.com', 'bad'] } } } } })), /invalid range/);
    assert.match(await errorOf(sb.put(B, { ssid: { name: ' ' } })), /must not be empty/);
    assert.match(await errorOf(sb.put(B, { ssid: { radius: { accounting: { updateInterval: 0 } } } })), /between 1 and 86400/);
    assert.deepEqual(await ok(sb.get(`${P}/profiles`)), [p]);
    await errorOf(sb.put(`${P}/profiles/123`, { name: 'Y' }), 404);
  });

  test('profiles list sorted by name, filtered and paged, and overviews show the same', async () => {
    fresh();
    const made = [];
    for (const name of ['Delta', 'alpha', 'Charlie', 'Bravo']) made.push(await ok(sb.post(`${P}/profiles`, { name, ssid: {} })));
    const names = (list) => list.map((p) => p.name);
    assert.deepEqual(names(await collect(sb.get, `${P}/profiles?perPage=3`)), ['Bravo', 'Charlie', 'Delta', 'alpha']);
    assert.deepEqual(names(await ok(sb.get(`${P}/profiles?sortOrder=desc`))), ['alpha', 'Delta', 'Charlie', 'Bravo']);
    assert.deepEqual(names(await ok(sb.get(`${P}/profiles?name=AL`))), ['alpha']);
    assert.deepEqual(names(await ok(sb.get(`${P}/profiles?profileIds[]=${made[0].id}&profileIds[]=${made[3].id}`))), ['Bravo', 'Delta']);
    assert.deepEqual(await ok(sb.get(`${P}/profiles/overviews?perPage=1000`)), await ok(sb.get(`${P}/profiles`)));
    assert.match(await errorOf(sb.get(`${P}/profiles?sortBy=id`)), /sortBy/);
    assert.match(await errorOf(sb.get(`${P}/profiles?perPage=2`)), /perPage/);
    assert.deepEqual(await ok(sb.get(`/organizations/${lab.id}/wireless/ssids/profiles`)), []);
  });

  test('assignments name SSIDs by ID or number, replace each other and block deleting the profile', async () => {
    fresh();
    const corpP = await ok(sb.post(`${P}/profiles`, { name: 'Corp', ssid: {} }));
    const guest = await ok(sb.post(`${P}/profiles`, { name: 'Guest', ssid: {} }));
    const A = `${P}/profiles/assignments`;
    const a = await ok(sb.post(A, { profile: { id: corpP.id }, ssid: { number: 1 }, network: { id: hq.id } }), 201);
    const ssid = (await ok(sb.get(`/networks/${hq.id}/wireless/ssids/1`))).name;
    assert.deepEqual(a, { ssid: { id: a.ssid.id, number: 1, name: ssid }, profile: { id: corpP.id, name: 'Corp' }, network: { id: hq.id, encryptedId: hq.url.split('/')[5], name: hq.name } });
    assert.match(a.ssid.id, /^\d+$/);
    // The same SSID by its ID alone, now with another profile.
    const b = await ok(sb.post(A, { profile: { id: guest.id }, ssid: { id: a.ssid.id } }), 201);
    assert.equal(b.profile.id, guest.id);
    await ok(sb.post(A, { profile: { id: corpP.id }, ssid: { number: 0 }, network: { id: austin.id } }), 201);
    const list = await ok(sb.get(A));
    assert.deepEqual(list.items.map((x) => [x.network.id, x.ssid.number, x.profile.name]), [
      [hq.id, 1, 'Guest'],
      [austin.id, 0, 'Corp'],
    ]);
    assert.deepEqual(list.meta.counts.items, { total: 2, remaining: 0 });
    assert.equal((await ok(sb.get(`${A}?profileIds[]=${corpP.id}`))).items.length, 1);
    assert.equal((await ok(sb.get(`${A}?networkIds[]=${hq.id}`))).items[0].profile.id, guest.id);
    assert.equal((await ok(sb.get(`${A}?ssidIds[]=${a.ssid.id}`))).items.length, 1);

    assert.match(await errorOf(sb.post(A, { profile: { id: '1' }, ssid: { number: 0 }, network: { id: hq.id } })), /profile '1' does not exist/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: { number: 0 } })), /network.id' is required/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: { number: 15 }, network: { id: hq.id } })), /0 to 14/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: { id: a.ssid.id, number: 2 } })), /different SSIDs/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: { id: 'x' } })), /does not exist/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: { number: 0 }, network: { id: lab.networks[0].id } })), /not in this organization/);
    assert.match(await errorOf(sb.post(A, { profile: { id: corpP.id }, ssid: {} })), /'ssid.id' or 'ssid.number'/);

    assert.match(await errorOf(sb.del(`${P}/profiles/${corpP.id}`)), /assigned to 1 SSID/);
    await ok(sb.del(A, { body: { ssid: { number: 0 }, network: { id: austin.id } } }), 204);
    assert.match(await errorOf(sb.del(A, { body: { ssid: { number: 0 }, network: { id: austin.id } } })), /no SSID profile/);
    await ok(sb.del(`${P}/profiles/${corpP.id}`), 204);
    // An assignment doesn't change the SSID's own settings.
    assert.equal((await ok(sb.get(`/networks/${hq.id}/wireless/ssids/1`))).name, ssid);
  });

  test('assignments by network carry network groups, search, sorting and all networks', async () => {
    fresh();
    const p = await ok(sb.post(`${P}/profiles`, { name: 'Corp', ssid: {} }));
    const q = await ok(sb.post(`${P}/profiles`, { name: 'IoT', ssid: {} }));
    const A = `${P}/profiles/assignments`;
    await ok(sb.post(A, { profile: { id: p.id }, ssid: { number: 0 }, network: { id: hq.id } }), 201);
    await ok(sb.post(A, { profile: { id: q.id }, ssid: { number: 2 }, network: { id: hq.id } }), 201);
    await ok(sb.post(A, { profile: { id: p.id }, ssid: { number: 1 }, network: { id: austin.id } }), 201);
    const g = await ok(sb.post(`/organizations/${corp.id}/networks/groups`, { name: 'West' }), 201);
    await ok(sb.post(`/organizations/${corp.id}/networks/groups/${g.groupId}/bulkAssign`, { networkIds: [hq.id] }));
    const N = `${A}/byNetwork`;

    const rows = await ok(sb.get(N));
    assert.deepEqual(rows.map((r) => r.name), ['Branch - Austin', 'HQ - San Francisco']);
    const h = rows[1];
    assert.deepEqual(Object.keys(h), ['id', 'name', 'group', 'clientsUrl', 'assignments']);
    assert.deepEqual(h.group, { id: g.groupId, name: 'West' });
    assert.match(h.clientsUrl, /\/manage\/clients$/);
    assert.deepEqual(h.assignments.map((x) => [x.ssid.number, x.profile.name]), [
      [0, 'Corp'],
      [2, 'IoT'],
    ]);
    assert.ok(!('group' in rows[0]));
    assert.equal((await collect(sb.get, `${N}?includeAllNetworks=true&perPage=3`)).length, corp.networks.length);
    assert.deepEqual((await ok(sb.get(`${N}?search=west`))).map((r) => r.id), [hq.id]);
    assert.deepEqual((await ok(sb.get(`${N}?sortBy=group&sortOrder=desc`))).map((r) => r.id), [hq.id, austin.id]);
    assert.deepEqual((await ok(sb.get(`${N}?networkGroupIds[]=${g.groupId}`))).map((r) => r.id), [hq.id]);
    assert.deepEqual((await ok(sb.get(`${N}?excludeProfileIds[]=${p.id}`))).map((r) => r.assignments.length), [1]);
    assert.deepEqual((await ok(sb.get(`${N}?profileIds[]=${p.id}&networkIds[]=${austin.id}`))).map((r) => r.id), [austin.id]);
    assert.match(await errorOf(sb.get(`${N}?sortBy=name`)), /sortBy/);
  });

  test('assignments and allowlist entries follow split and combine, and leave with the network', async () => {
    fresh();
    const p = await ok(sb.post(`${P}/profiles`, { name: 'Corp', ssid: {} }));
    await ok(sb.post(`${P}/profiles/assignments`, { profile: { id: p.id }, ssid: { number: 1 }, network: { id: hq.id } }), 201);
    const E = `${P}/firewall/isolation/allowlist/entries`;
    await ok(sb.post(E, { client: { mac: '00:11:22:33:44:55' }, ssid: { number: 1 }, network: { id: hq.id } }), 201);
    // Scanning receivers go to the wireless part on a split too.
    const R = `/organizations/${corp.id}/wireless/location/scanning/receivers`;
    await ok(sb.post(R, { network: { id: hq.id }, url: 'https://rx.example.com', version: '3', radio: { type: 'Wi-Fi' }, sharedSecret: 's' }), 201);
    const nets = async () => [(await ok(sb.get(`${P}/profiles/assignments`))).items.map((x) => x.network.id), (await ok(sb.get(E))).items.map((x) => x.network.id), (await ok(sb.get(R))).items.map((x) => x.network.id)];

    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    assert.deepEqual(await nets(), [[wl.id], [wl.id], [wl.id]]);
    const net = (await ok(sb.post(`/organizations/${corp.id}/networks/combine`, { name: hq.name, networkIds: parts.map((n) => n.id) }))).resultingNetwork;
    assert.deepEqual(await nets(), [[net.id], [net.id], [net.id]]);
    await ok(sb.del(`/networks/${net.id}`), 204);
    assert.deepEqual(await nets(), [[], [], []]);
    await ok(sb.del(`${P}/profiles/${p.id}`), 204);
  });

  test('isolation allowlist entries are created, filtered, updated and deleted', async () => {
    fresh();
    const E = `${P}/firewall/isolation/allowlist/entries`;
    const e = await ok(sb.post(E, { description: 'Printer', client: { mac: 'A1:B2:C3:D4:E5:F6' }, ssid: { number: 2 }, network: { id: hq.id } }), 201);
    const ssid = await ok(sb.get(`/networks/${hq.id}/wireless/ssids/2`));
    assert.deepEqual(e, {
      entryId: '1',
      createdAt: '2026-09-29T18:30:00Z',
      lastUpdatedAt: '2026-09-29T18:30:00Z',
      description: 'Printer',
      client: { mac: 'a1:b2:c3:d4:e5:f6' },
      ssid: { id: e.ssid.id, name: ssid.name, number: 2 },
      network: { id: hq.id, name: hq.name },
    });
    const f = await ok(sb.post(E, { client: { mac: 'a1:b2:c3:d4:e5:f6' }, ssid: { number: 0 }, network: { id: austin.id } }), 201);
    assert.equal(f.entryId, '2');
    for (let i = 0; i < 3; i++) await ok(sb.post(E, { client: { mac: `00:00:00:00:00:0${i}` }, ssid: { number: 0 }, network: { id: hq.id } }), 201);
    assert.equal((await collect(sb.get, `${E}?perPage=3`)).length, 5);
    assert.deepEqual((await ok(sb.get(`${E}?networkIds[]=${austin.id}`))).items.map((x) => x.entryId), ['2']);
    assert.deepEqual((await ok(sb.get(`${E}?ssids[]=2`))).items.map((x) => x.entryId), ['1']);

    assert.match(await errorOf(sb.post(E, { client: { mac: 'A1:B2:C3:D4:E5:F6' }, ssid: { number: 2 }, network: { id: hq.id } })), /already on the allowlist/);
    assert.match(await errorOf(sb.post(E, { client: { mac: 'nope' }, ssid: { number: 2 }, network: { id: hq.id } })), /MAC address/);
    assert.match(await errorOf(sb.post(E, { client: {}, ssid: { number: 2 }, network: { id: hq.id } })), /client.mac' is required/);
    assert.match(await errorOf(sb.post(E, { client: { mac: '00:11:22:33:44:55' }, ssid: {}, network: { id: hq.id } })), /0 to 14/);
    assert.match(await errorOf(sb.post(E, { client: { mac: '00:11:22:33:44:55' }, ssid: { number: 1 }, network: {} })), /network.id' is required/);
    assert.match(await errorOf(sb.post(E, { client: { mac: '00:11:22:33:44:55' }, ssid: { number: 1 }, network: { id: lab.networks[0].id } })), /not in this organization/);
    assert.match(await errorOf(sb.post(E, { client: { mac: '00:11:22:33:44:55' }, ssid: { number: 1 } })), /'network' is required/);

    const u = await ok(sb.put(`${E}/1`, { description: 'Lab printer', client: { mac: '00:11:22:33:44:66' } }));
    assert.deepEqual([u.description, u.client.mac, u.ssid.number, u.createdAt], ['Lab printer', '00:11:22:33:44:66', 2, e.createdAt]);
    assert.match(await errorOf(sb.put(`${E}/2`, { client: { mac: 'zz' } })), /MAC address/);
    await ok(sb.del(`${E}/1`), 204);
    await errorOf(sb.del(`${E}/1`), 404);
    await errorOf(sb.put(`${E}/1`, { description: 'x' }), 404);
  });

  test('OpenRoaming by network shows what the SSID OpenRoaming write stored', async () => {
    fresh();
    const set = await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1/openRoaming`, { enabled: true, tenantId: '42' }));
    const O = `${P}/openRoaming/byNetwork`;
    const page = await ok(sb.get(`${O}?networkIds[]=${hq.id}`));
    assert.equal(page.items.length, 1);
    const row = page.items[0];
    assert.deepEqual([row.networkId, row.networkName], [hq.id, hq.name]);
    const ssids = await ok(sb.get(`/networks/${hq.id}/wireless/ssids`));
    assert.deepEqual(
      row.ssid.map((s) => s.number),
      ssids.filter((s) => s.enabled).map((s) => s.number),
    );
    assert.deepEqual(row.ssid[1], { name: ssids[1].name, number: 1, enabled: true, openRoaming: set });
    assert.deepEqual(row.ssid[0].openRoaming, { enabled: false, tenantId: null });
    assert.equal((await ok(sb.get(`${O}?networkIds[]=${hq.id}&includeDisabledSsids=true`))).items[0].ssid.length, 15);
    const all = await collect(sb.get, `${O}?perPage=3`);
    assert.deepEqual(
      all.map((r) => r.networkId),
      corp.networks.filter((n) => n.productTypes.includes('wireless')).map((n) => n.id),
    );
  });
});
