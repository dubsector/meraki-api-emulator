import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, collect, start } from './helpers.js';

describe('Meraki auth users, NetFlow, traffic analysis and VLAN profiles', () => {
  let sb;
  let org;
  let hq;
  let austin;
  let lab;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
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
  const MERAKI_SPLASH = 'Password-protected with Meraki RADIUS';
  const users = (net) => `/networks/${net.id}/merakiAuthUsers`;
  const guest = (net, email, more = {}) => ok(sb.post(users(net), { email, name: 'Guest', password: 'pw', accountType: 'Guest', authorizations: [{ ssidNumber: 1 }], ...more }), 201);

  test('users need an SSID set up for their account type and never show the password', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(users(hq))), []);
    assert.match(await errorOf(sb.post(users(hq), { email: 'a@example.com', name: 'A', password: 'pw', authorizations: [{ ssidNumber: 0 }] })), /8021x-meraki/);
    assert.match(await errorOf(sb.post(users(hq), { email: 'a@example.com', name: 'A', password: 'pw', accountType: 'Guest', authorizations: [{ ssidNumber: 1 }] })), /Meraki RADIUS/);
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/0`, { authMode: '8021x-meraki' }));
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: MERAKI_SPLASH }));
    const u = await ok(sb.post(users(hq), { email: 'miles@meraki.com', name: 'Miles', password: 'pw', authorizations: [{ ssidNumber: 0, expiresAt: '2026-12-01T00:00:00Z' }] }), 201);
    assert.equal(u.id, Buffer.from('miles@meraki.com').toString('base64'));
    assert.deepEqual(u, {
      id: u.id,
      email: 'miles@meraki.com',
      name: 'Miles',
      createdAt: '2026-09-29T18:30:00.000000Z',
      accountType: '802.1X',
      isAdmin: false,
      authorizations: [{ ssidNumber: 0, authorizedZone: 'Acme-Corp', expiresAt: '2026-12-01T00:00:00.000000Z', authorizedByName: 'API Integration', authorizedByEmail: 'api@example.com' }],
    });
    assert.equal(JSON.stringify(await ok(sb.get(users(hq)))).includes('pw'), false);
    const g = await guest(hq, 'guest@example.com');
    assert.equal(g.authorizations[0].expiresAt, 'Never');
    assert.deepEqual((await ok(sb.get(users(hq)))).map((x) => x.email), ['guest@example.com', 'miles@meraki.com']);
    assert.deepEqual(await ok(sb.get(`${users(hq)}/${u.id}`)), u);
    assert.equal((await sb.get(`${users(hq)}/bm9wZQ==`)).status, 404);
  });

  test('creates are checked before anything changes', async () => {
    fresh();
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: MERAKI_SPLASH }));
    const bad = (body) => errorOf(sb.post(users(hq), { email: 'g@example.com', name: 'G', password: 'pw', accountType: 'Guest', authorizations: [{ ssidNumber: 1 }], ...body }));
    assert.match(await bad({ email: 'nope' }), /email address/);
    assert.match(await bad({ name: '' }), /'name' is required/);
    assert.match(await bad({ password: null }), /'password' is required/);
    assert.match(await bad({ authorizations: [] }), /at least one/);
    assert.match(await bad({ authorizations: [{}] }), /ssidNumber' is required/);
    assert.match(await bad({ authorizations: [{ ssidNumber: 1 }, { ssidNumber: 1 }] }), /more than once/);
    assert.match(await bad({ authorizations: [{ ssidNumber: 1, expiresAt: 'soon' }] }), /'Never' or an ISO 8601/);
    assert.match(await bad({ authorizations: [{ ssidNumber: 1, expiresAt: '2020-01-01T00:00:00Z' }] }), /in the future/);
    assert.match(await bad({ accountType: 'Client VPN', authorizations: [{ ssidNumber: 1 }] }), /only applies to 802.1X and guest/);
    assert.match(await bad({ isAdmin: true }), /not a Dashboard administrator/);
    assert.deepEqual(await ok(sb.get(users(hq))), []);
    await guest(hq, 'g@example.com');
    assert.match(await bad({ email: 'G@example.com' }), /already exists/);
    // Client VPN needs an MX; wireless users need APs.
    assert.match(await errorOf(sb.post(users(lab), { email: 'v@example.com', name: 'V', password: 'pw', accountType: 'Client VPN', authorizations: [{}] })), /with an MX/);
    const cams = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'Cams', productTypes: ['camera'] }), 201);
    assert.match(await errorOf(sb.post(users(cams), { email: 'c@example.com', name: 'C', password: 'pw', authorizations: [{ ssidNumber: 0 }] })), /wireless network/);
  });

  test('administrators sign on as themselves, and updates replace the authorizations', async () => {
    fresh();
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: MERAKI_SPLASH }));
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/3`, { enabled: true, splashPage: MERAKI_SPLASH }));
    const admin = org.admins.find((a) => !a.api);
    const a = await guest(hq, admin.email, { isAdmin: true, name: undefined, password: undefined });
    assert.equal(a.name, admin.name);
    assert.equal(a.isAdmin, true);
    assert.match(await errorOf(sb.put(`${users(hq)}/${a.id}`, { name: 'Other' })), /administrator/);
    const g = await guest(hq, 'g@example.com');
    const u = await ok(sb.put(`${users(hq)}/${g.id}`, { name: 'Renamed', password: 'new', authorizations: [{ ssidNumber: 3, expiresAt: 'Never' }] }));
    assert.equal(u.name, 'Renamed');
    assert.deepEqual(u.authorizations.map((x) => x.ssidNumber), [3]);
    assert.match(await errorOf(sb.put(`${users(hq)}/${g.id}`, { authorizations: [{ ssidNumber: 0 }] })), /Meraki RADIUS/);
    assert.equal((await ok(sb.get(`${users(hq)}/${g.id}`))).name, 'Renamed');
  });

  test('client VPN users live with the MX and deletes take the delete flag', async () => {
    fresh();
    const v = await ok(sb.post(users(hq), { email: 'vpn@example.com', name: 'V', password: 'pw', accountType: 'Client VPN', authorizations: [{ expiresAt: 'Never' }] }), 201);
    assert.deepEqual(v.authorizations, [{ authorizedZone: 'Client VPN', expiresAt: 'Never', authorizedByName: 'API Integration', authorizedByEmail: 'api@example.com' }]);
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: MERAKI_SPLASH }));
    const g = await guest(hq, 'g@example.com');
    // Splitting sends client VPN users to the appliance part and wireless users to the wireless part.
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const part = (p) => parts.find((n) => n.productTypes[0] === p);
    assert.deepEqual((await ok(sb.get(users(part('appliance'))))).map((x) => x.email), ['vpn@example.com']);
    assert.deepEqual((await ok(sb.get(users(part('wireless'))))).map((x) => x.email), ['g@example.com']);
    const wl = part('wireless');
    await ok(sb.del(`${users(wl)}/${g.id}?delete=true`), 204);
    assert.equal((await sb.del(`${users(wl)}/${g.id}`)).status, 404);
    assert.deepEqual(await ok(sb.get(users(wl))), []);
  });

  test('splash login attempts come from clients on sign-on SSIDs', async () => {
    fresh();
    const L = `/networks/${hq.id}/splashLoginAttempts`;
    // The seeded guest SSIDs use a click-through page, which asks for no sign-on.
    assert.deepEqual(await ok(sb.get(`${L}?timespan=7776000`)), []);
    assert.match(await errorOf(sb.get(`${L}?timespan=7776001`)), /less than or equal/);
    assert.match(await errorOf(sb.get(`${L}?ssidNumber=15`)), /between 0 and 14/);
    assert.equal((await sb.get(`/networks/${org.networks.find((n) => n.name === 'Warehouse - Reno').id}/splashLoginAttempts`)).status, 200);
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: 'SMS authentication' }));
    const rows = await ok(sb.get(`${L}?timespan=604800`));
    assert.ok(rows.length > 0);
    const guestClients = new Map(hq.clients.filter((c) => c.ssid?.number === 1).map((c) => [c.id, c]));
    for (const r of rows) {
      const c = guestClients.get(r.clientId);
      assert.ok(c, r.clientId);
      assert.equal(r.clientMac, c.mac);
      assert.equal(r.gatewayDeviceMac, c.ap.mac);
      assert.equal(r.ssid, 'Acme-Guest');
      assert.match(r.login, /^\+1555\d{7}$/);
      assert.ok(['success', 'failure'].includes(r.authorization));
      assert.ok(Date.parse(r.loginAt) <= Date.parse(NOW));
    }
    assert.deepEqual(rows.map((r) => r.loginAt), rows.map((r) => r.loginAt).sort().reverse());
    // The default timespan is one day.
    const day = await ok(sb.get(L));
    assert.deepEqual(day, rows.filter((r) => Date.parse(r.loginAt) > Date.parse(NOW) - 86400e3));
    assert.deepEqual(await ok(sb.get(`${L}?timespan=604800&ssidNumber=0`)), []);
    const one = await ok(sb.get(`${L}?timespan=604800&loginIdentifier=${encodeURIComponent(rows[0].login)}`));
    assert.ok(one.length && one.every((r) => r.login === rows[0].login));
    // Meraki RADIUS splash pages sign on as the guest users authorized on the SSID.
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { splashPage: MERAKI_SPLASH }));
    await guest(hq, 'visitor@example.com', { name: 'Visitor' });
    const named = await ok(sb.get(`${L}?timespan=604800`));
    assert.equal(named.length, rows.length);
    assert.ok(named.every((r) => r.login === 'visitor@example.com' && r.name === 'Visitor'));
    await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1`, { enabled: false }));
    assert.deepEqual(await ok(sb.get(`${L}?timespan=604800`)), []);
    assert.equal((await sb.get(`/networks/${org.networks.find((n) => n.name === 'HQ - San Francisco').id}/splashLoginAttempts`)).status, 200);
  });

  test('NetFlow needs a collector when reporting is on', async () => {
    fresh();
    const F = `/networks/${hq.id}/netflow`;
    assert.deepEqual(await ok(sb.get(F)), { reportingEnabled: false, collectorIp: null, collectorPort: null, etaEnabled: false, etaDstPort: null });
    assert.match(await errorOf(sb.put(F, { reportingEnabled: true })), /required when NetFlow/);
    assert.match(await errorOf(sb.put(F, { collectorIp: '1.2.3' })), /IPv4/);
    assert.match(await errorOf(sb.put(F, { collectorPort: 70000 })), /port from 1/);
    assert.match(await errorOf(sb.put(F, { etaEnabled: true, etaDstPort: 443 })), /needs NetFlow reporting/);
    const body = { reportingEnabled: true, collectorIp: '1.2.3.4', collectorPort: 2055, etaEnabled: true, etaDstPort: 443 };
    assert.deepEqual(await ok(sb.put(F, body)), body);
    assert.match(await errorOf(sb.put(F, { etaDstPort: null })), /'etaDstPort' is required/);
    assert.deepEqual(await ok(sb.get(F)), body);
    assert.equal((await sb.get(`/networks/${lab.id}/netflow`)).status, 400);
  });

  test('traffic analysis checks each custom pie chart value by its type', async () => {
    fresh();
    const T = `/networks/${lab.id}/trafficAnalysis`;
    assert.deepEqual(await ok(sb.get(T)), { mode: 'detailed', customPieChartItems: [] });
    const items = [
      { name: 'Item from hostname', type: 'host', value: 'example.com' },
      { name: 'Item from port', type: 'port', value: '9090' },
      { name: 'Item from IP', type: 'ipRange', value: '192.1.0.0' },
      { name: 'Item from IP range', type: 'ipRange', value: '192.1.0.0/16' },
      { name: 'Item from IP range with port', type: 'ipRange', value: '10.1.0.0/16:80' },
    ];
    assert.deepEqual(await ok(sb.put(T, { mode: 'basic', customPieChartItems: items })), { mode: 'basic', customPieChartItems: items });
    const bad = (x) => errorOf(sb.put(T, { mode: 'disabled', customPieChartItems: [x] }));
    assert.match(await bad({ name: 'x', type: 'host', value: 'not a host' }), /hostname/);
    assert.match(await bad({ name: 'x', type: 'port', value: '0' }), /port from 1/);
    assert.match(await bad({ name: 'x', type: 'ipRange', value: '10.0.0.0/33' }), /CIDR/);
    assert.match(await bad({ name: '', type: 'host', value: 'example.com' }), /'customPieChartItems\[0\].name' is required/);
    assert.equal((await ok(sb.get(T))).mode, 'basic');
    // Traffic analysis doesn't change what the traffic routes report.
    const traffic = await ok(sb.get(`/networks/${hq.id}/traffic?timespan=86400`));
    await ok(sb.put(`/networks/${hq.id}/trafficAnalysis`, { mode: 'disabled' }));
    assert.deepEqual(await ok(sb.get(`/networks/${hq.id}/traffic?timespan=86400`)), traffic);
  });

  const V = (net) => `/networks/${net.id}/vlanProfiles`;
  const newProfile = (net, iname, more = {}) => sb.post(V(net), { iname, name: `Profile ${iname}`, vlanNames: [{ name: 'named-1', vlanId: '10' }], vlanGroups: [{ name: 'group-1', vlanIds: '2,5-7' }], ...more });
  const profile = (...args) => ok(newProfile(...args));

  test('VLAN profiles start with the default and are named by iname', async () => {
    fresh();
    const DEFAULT = { iname: 'Default', name: 'Default Profile', isDefault: true, vlanNames: [{ name: 'default', vlanId: '1', adaptivePolicyGroup: null }], vlanGroups: [] };
    assert.deepEqual(await ok(sb.get(V(hq))), [DEFAULT]);
    const p = await profile(hq, 'Profile1');
    assert.deepEqual(p, { iname: 'Profile1', name: 'Profile Profile1', isDefault: false, vlanNames: [{ name: 'named-1', vlanId: '10', adaptivePolicyGroup: null }], vlanGroups: [{ name: 'group-1', vlanIds: '2,5-7' }] });
    assert.deepEqual(await ok(sb.get(`${V(hq)}/Profile1`)), p);
    assert.equal((await sb.get(`${V(hq)}/Nope`)).status, 404);
    assert.match(await errorOf(newProfile(hq, 'profile1')), /already exists/);
    assert.match(await errorOf(newProfile(hq, 'bad iname')), /letters, digits/);
    assert.match(await errorOf(newProfile(hq, 'P2', { vlanNames: [{ name: 'x', vlanId: '4095' }] })), /1 to 4094/);
    assert.match(await errorOf(newProfile(hq, 'P2', { vlanNames: [{ name: 'a', vlanId: '3' }, { name: 'b', vlanId: '3' }] })), /more than once/);
    assert.match(await errorOf(newProfile(hq, 'P2', { vlanNames: [{ name: 'x'.repeat(33), vlanId: '3' }] })), /1 to 32/);
    assert.match(await errorOf(newProfile(hq, 'P2', { vlanGroups: [{ name: 'g', vlanIds: '7-5' }] })), /2,5-7/);
    assert.match(await errorOf(newProfile(hq, 'P2', { name: '' })), /'name'/);
    const u = await ok(sb.put(`${V(hq)}/Default`, { name: 'Base', vlanNames: [{ name: 'default', vlanId: '1' }, { name: 'voice', vlanId: '20' }], vlanGroups: [] }));
    assert.equal(u.isDefault, true);
    assert.match(await errorOf(sb.del(`${V(hq)}/Default`)), /default VLAN profile/);
    await ok(sb.del(`${V(hq)}/Profile1`), 204);
    assert.deepEqual((await ok(sb.get(V(hq)))).map((x) => x.iname), ['Default']);
    const cams = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'Cams', productTypes: ['camera'] }), 201);
    assert.equal((await sb.get(V(cams))).status, 400);
  });

  test('named VLANs take adaptive policy groups, which drop out when deleted', async () => {
    fresh();
    const O = `/organizations/${org.id}/adaptivePolicy`;
    const g = await ok(sb.post(`${O}/groups`, { name: 'Employees', sgt: 101 }), 201);
    assert.match(await errorOf(newProfile(hq, 'P1', { vlanNames: [{ name: 'emp', vlanId: '10', adaptivePolicyGroup: { id: '1' } }] })), /doesn't exist/);
    const p = await profile(hq, 'P1', { vlanNames: [{ name: 'emp', vlanId: '10', adaptivePolicyGroup: { id: g.groupId } }] });
    assert.deepEqual(p.vlanNames[0].adaptivePolicyGroup, { id: g.groupId, name: 'Employees' });
    await ok(sb.del(`${O}/groups/${g.groupId}`), 204);
    assert.equal((await ok(sb.get(`${V(hq)}/P1`))).vlanNames[0].adaptivePolicyGroup, null);
  });

  test('assignments by device follow reassign, stacks included', async () => {
    fresh();
    const A = `${V(hq)}/assignments`;
    const all = await collect(sb.get, `${A}/byDevice?perPage=3`);
    assert.deepEqual(all.map((d) => d.serial), hq.devices.filter((d) => ['switch', 'wireless'].includes(d.productType)).map((d) => d.serial).sort());
    assert.ok(all.every((d) => d.vlanProfile.iname === 'Default' && d.vlanProfile.isDefault && d.stack === null && d.configurationSource === 'Cloud'));
    await profile(hq, 'P1');
    const [, s1, s2] = hq.switches;
    const stack = await ok(sb.post(`/networks/${hq.id}/switch/stacks`, { name: 'Pair', serials: [s1.serial, s2.serial] }));
    const ap = hq.aps[0];
    assert.match(await errorOf(sb.post(`${A}/reassign`, { vlanProfile: { iname: 'Nope' }, serials: [ap.serial], stackIds: [] })), /doesn't exist/);
    assert.match(await errorOf(sb.post(`${A}/reassign`, { vlanProfile: { iname: 'P1' }, serials: [hq.mx.serial], stackIds: [] })), /not a switch or AP/);
    assert.match(await errorOf(sb.post(`${A}/reassign`, { vlanProfile: { iname: 'P1' }, serials: [ap.serial], stackIds: ['1'] })), /stack '1'/);
    assert.deepEqual(await ok(sb.post(`${A}/reassign`, { vlanProfile: { iname: 'P1' }, serials: [ap.serial], stackIds: [stack.id] })), { vlanProfile: { iname: 'P1', name: 'Profile P1' }, serials: [ap.serial], stackIds: [stack.id] });
    const byStack = await ok(sb.get(`${A}/byDevice?stackIds[]=${stack.id}`));
    assert.deepEqual(byStack.map((d) => [d.serial, d.vlanProfile.iname, d.stack.id]), [s1, s2].map((s) => [s.serial, 'P1', stack.id]).sort());
    assert.equal((await ok(sb.get(`${A}/byDevice?serials[]=${ap.serial}&productTypes[]=wireless`)))[0].vlanProfile.iname, 'P1');
    assert.deepEqual(await ok(sb.get(`${A}/byDevice?serials[]=${ap.serial}&productTypes[]=switch`)), []);
    assert.match(await errorOf(sb.get(`${A}/byDevice?productTypes[]=camera`)), /switch or wireless/);
    assert.match(await errorOf(sb.del(`${V(hq)}/P1`)), /assigned to/);
    // No iname puts devices back on the default profile.
    await ok(sb.post(`${A}/reassign`, { serials: [ap.serial], stackIds: [stack.id] }));
    await ok(sb.del(`${V(hq)}/P1`), 204);
  });

  test('VLAN profiles come from the template on a bound network', async () => {
    fresh();
    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'Switches', copyFromNetworkId: austin.id }), 201);
    const net = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'Bound', productTypes: ['switch'] }), 201);
    await ok(sb.post(`/networks/${net.id}/bind`, { configTemplateId: t.id }));
    assert.equal((await ok(sb.get(V(net))))[0].iname, 'Default');
    assert.equal((await sb.post(V(net), { iname: 'P1', name: 'P1', vlanNames: [], vlanGroups: [] })).status, 400);
    assert.equal((await sb.put(`/networks/${net.id}/trafficAnalysis`, { mode: 'basic' })).status, 400);
    // Assignments name the network's own devices, so they aren't refused.
    assert.match(await errorOf(sb.post(`${V(net)}/assignments/reassign`, { serials: ['Q2XX-0000-0000'], stackIds: [] })), /not a switch or AP/);
  });
});
