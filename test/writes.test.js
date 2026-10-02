import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ROUTES } from '../src/server.js';
import { schemaOf } from '../src/validate.js';
import { NOW, start } from './helpers.js';

describe('writes', () => {
  let sb;
  let org;
  let hq;
  before(async () => (sb = await start()));
  // Every test starts from the seeded world.
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs[0];
    hq = org.networks[0];
  };

  test('a PUT answers with what a later GET returns', async () => {
    fresh();
    const put = await sb.put(`/networks/${hq.id}/appliance/security/intrusion`, { mode: 'detection' });
    assert.equal(put.status, 200);
    assert.equal(put.body.mode, 'detection');
    assert.deepEqual((await sb.get(`/networks/${hq.id}/appliance/security/intrusion`)).body, put.body);
  });

  test('an object read with GET can be sent back unchanged', async () => {
    fresh();
    for (const path of [`/networks/${hq.id}/appliance/vlans/10`, `/networks/${hq.id}/wireless/ssids/0`, `/devices/${hq.switches[0].serial}/switch/ports/5`, `/networks/${hq.id}`]) {
      const before = (await sb.get(path)).body;
      const put = await sb.put(path, before);
      assert.equal(put.status, 200, `${path}: ${JSON.stringify(put.body)}`);
      assert.deepEqual(put.body, before, path);
    }
  });

  test('bodies are checked against the spec', async () => {
    fresh();
    const bad = async (path, body, message) => {
      const r = await sb.put(path, body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.errors[0], message);
    };
    await bad(`/networks/${hq.id}/appliance/security/malware`, {}, /'mode' is required/);
    await bad(`/networks/${hq.id}/appliance/security/malware`, { mode: 'sometimes' }, /'mode' must be one of: disabled, enabled/);
    await bad(`/networks/${hq.id}/appliance/vlans/10`, { dhcpLeaseTime: 'forever' }, /dhcpLeaseTime/);
    await bad(`/devices/${hq.aps[0].serial}`, { tags: 'not-a-list' }, /'tags' must be an array/);
    await bad(`/networks/${hq.id}/settings`, '{"broken', /not valid JSON/);
    await bad(`/networks/${hq.id}/settings`, '[1, 2]', /must be a JSON object/);
    // Numbers and numeric strings are interchangeable, as with the real API.
    assert.equal((await sb.put(`/devices/${hq.switches[0].serial}/switch/ports/5`, { vlan: '20' })).body.vlan, 20);
  });

  test('prototype keys in a body are ignored', async () => {
    fresh();
    const r = await sb.put(`/networks/${hq.id}/settings`, '{"__proto__": {"polluted": 1}, "fips": {"constructor": {"prototype": {"polluted": 1}}}}');
    assert.equal(r.status, 200);
    assert.equal({}.polluted, undefined);
  });

  test('methods a path lacks answer 405 with Allow', async () => {
    fresh();
    const r = await sb.del(`/networks/${hq.id}/appliance/vlans/settings`);
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, PUT, HEAD');
    assert.equal((await sb.post(`/networks/${hq.id}/settings`, {})).status, 405);
  });

  test('oversized bodies are refused', async () => {
    fresh();
    const r = await sb.put(`/networks/${hq.id}/settings`, JSON.stringify({ notes: 'x'.repeat(1100000) }));
    assert.equal(r.status, 413);
  });

  test('VLANs keep their addressing valid and follow into the VPN settings', async () => {
    fresh();
    const base = `/networks/${hq.id}/appliance/vlans`;
    assert.match((await sb.post(base, { id: 70, name: 'Lab', subnet: '10.1.10.0/25', applianceIp: '10.1.10.1' })).body.errors[0], /overlaps/);
    assert.match((await sb.post(base, { id: 70, name: 'Lab', subnet: '10.1.70.0/24', applianceIp: '10.1.71.1' })).body.errors[0], /inside/);
    assert.match((await sb.post(base, { id: 10, name: 'Dup', subnet: '10.1.99.0/24', applianceIp: '10.1.99.1' })).body.errors[0], /already exists/);
    const created = await sb.post(base, { id: 70, name: 'Lab', subnet: '10.1.70.0/24', applianceIp: '10.1.70.1' });
    assert.equal(created.status, 201);
    assert.equal(created.body.dhcpHandling, 'Run a DHCP server');
    const vpn = `/networks/${hq.id}/appliance/vpn/siteToSiteVpn`;
    assert.ok((await sb.get(vpn)).body.subnets.some((s) => s.localSubnet === '10.1.70.0/24' && !s.useVpn));
    await sb.put(vpn, { mode: 'hub', subnets: [{ localSubnet: '10.1.70.0/24', useVpn: true }] });
    const statuses = (await sb.get(`/organizations/${org.id}/appliance/vpn/statuses`)).body;
    assert.ok(statuses.find((s) => s.networkId === hq.id).exportedSubnets.some((s) => s.subnet === '10.1.70.0/24' && s.name === 'Lab'));
    assert.equal((await sb.del(`${base}/70`)).status, 204);
    assert.equal((await sb.get(`${base}/70`)).status, 404);
    assert.ok(!(await sb.get(vpn)).body.subnets.some((s) => s.localSubnet === '10.1.70.0/24'));
  });

  test('the default firewall rule stays last and is never duplicated', async () => {
    fresh();
    const path = `/networks/${hq.id}/appliance/firewall/l3FirewallRules`;
    const current = (await sb.get(path)).body.rules;
    const rule = { comment: 'Block SMB', policy: 'deny', protocol: 'tcp', srcCidr: 'Any', destPort: '445', destCidr: 'Any' };
    const r = await sb.put(path, { rules: [rule, ...current], syslogDefaultRule: true });
    assert.equal(r.body.rules.length, current.length + 1);
    assert.equal(r.body.rules[0].srcPort, 'Any');
    assert.equal(r.body.rules.filter((x) => x.comment === 'Default rule').length, 1);
    assert.equal(r.body.rules.at(-1).syslogEnabled, true);
  });

  test('a new network is empty but every read works on it', async () => {
    fresh();
    const created = await sb.post(`/organizations/${org.id}/networks`, { name: 'Branch - Boise', productTypes: ['appliance', 'switch', 'wireless'], timeZone: 'America/Boise', tags: ['branch'] });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^L_\d{18}$/);
    assert.equal((await sb.post(`/organizations/${org.id}/networks`, { name: 'Branch - Boise', productTypes: ['wireless'] })).status, 400);
    const id = created.body.id;
    for (const route of ROUTES.filter((r) => r.method === 'GET' && r.path.startsWith('/networks/{networkId}') && !r.path.includes('{', 20))) {
      const r = await sb.get(route.path.replace('{networkId}', id) + (route.path.endsWith('/events') ? '?productType=wireless' : route.path.endsWith('signalQualityHistory') ? '?clientId=none' : ''));
      assert.ok([200, 400, 404].includes(r.status), `${route.path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.deepEqual((await sb.get(`/networks/${id}/clients`)).body, []);
    assert.equal((await sb.get(`/networks/${id}/appliance/vlans`)).status, 400, 'VLANs start off');
    assert.equal((await sb.put(`/networks/${id}/appliance/vlans/settings`, { vlansEnabled: true })).body.vlansEnabled, true);
    assert.deepEqual((await sb.get(`/networks/${id}/appliance/vlans`)).body.map((v) => v.subnet), ['192.168.128.0/24']);
    assert.ok((await sb.get(`/organizations/${org.id}/networks`)).body.some((n) => n.id === id));
  });

  test('deleting a network returns its devices to inventory', async () => {
    fresh();
    const reno = org.networks.find((n) => n.code === 'RNO');
    const serials = reno.devices.map((d) => d.serial);
    assert.equal((await sb.del(`/networks/${reno.id}`)).status, 204);
    assert.equal((await sb.get(`/networks/${reno.id}`)).status, 404);
    assert.equal((await sb.get(`/devices/${serials[0]}`)).status, 404);
    const unused = (await sb.get(`/organizations/${org.id}/inventory/devices?usedState=unused`)).body.map((d) => d.serial);
    for (const s of serials) assert.ok(unused.includes(s));
    const statuses = (await sb.get(`/organizations/${org.id}/devices/statuses`)).body;
    assert.ok(!statuses.some((d) => serials.includes(d.serial)));
    assert.equal((await sb.get(`/organizations/${org.id}/configurationChanges?timespan=604800`)).status, 200);
  });

  test('renames reach events, statuses and clients', async () => {
    fresh();
    const ap = hq.aps[0];
    await sb.put(`/devices/${ap.serial}`, { name: 'AP-HQ-Atrium', notes: 'moved' });
    const events = (await sb.get(`/networks/${hq.id}/events?productType=wireless&perPage=5&deviceSerial=${ap.serial}`)).body.events;
    assert.ok(events.length && events.every((e) => e.deviceName === 'AP-HQ-Atrium'));
    const byName = (await sb.get(`/networks/${hq.id}/events?productType=wireless&perPage=5&deviceName=AP-HQ-Atrium`)).body.events;
    assert.ok(byName.length);
    const statuses = (await sb.get(`/organizations/${org.id}/devices/statuses?serials[]=${ap.serial}`)).body;
    assert.equal(statuses[0].name, 'AP-HQ-Atrium');
    await sb.put(`/networks/${hq.id}/wireless/ssids/0`, { name: 'Acme-Corporate' });
    const clients = (await sb.get(`/networks/${hq.id}/clients?perPage=200&recentDeviceConnections[]=Wireless`)).body;
    assert.ok(clients.some((c) => c.ssid === 'Acme-Corporate'));
    assert.ok(!clients.some((c) => c.ssid === 'Acme-Corp'));
  });

  test('SSID auth modes keep only their own fields', async () => {
    fresh();
    const path = `/networks/${hq.id}/wireless/ssids/5`;
    assert.match((await sb.put(path, { authMode: 'psk', psk: 'short' })).body.errors[0], /psk/);
    const psk = await sb.put(path, { name: 'Acme-Staff', enabled: true, authMode: 'psk', psk: 'correct horse battery' });
    assert.equal(psk.body.encryptionMode, 'wpa');
    assert.deepEqual(psk.body.dot11w, { enabled: false, required: false });
    const open = await sb.put(path, { authMode: 'open' });
    assert.equal(open.body.psk, undefined);
    assert.equal(open.body.dot11w, undefined);
    const status = (await sb.get(`/devices/${hq.aps[0].serial}/wireless/status`)).body.basicServiceSets;
    assert.ok(status.some((b) => b.ssidName === 'Acme-Staff' && b.ssidNumber === 5));
    // RADIUS modes get the RADIUS settings, and shared secrets are never sent back.
    assert.match((await sb.put(path, { authMode: 'open-with-radius' })).body.errors[0], /radiusServers/);
    const radius = await sb.put(path, { authMode: 'open-with-radius', radiusServers: [{ host: '192.0.2.10', port: 1812, secret: 'hunter22' }] });
    assert.equal(radius.body.radiusServerTimeout, 1);
    assert.equal(radius.body.radiusServers[0].secret, undefined);
    assert.ok(radius.body.radiusServers[0].id);
    assert.equal(radius.body.encryptionMode, undefined, 'open-with-radius has no encryption');
    const bridged = await sb.put(path, { ipAssignmentMode: 'Bridge mode', useVlanTagging: true, defaultVlanId: 10 });
    assert.equal(bridged.body.dnsRewrite, undefined);
    assert.equal(bridged.body.lanIsolationEnabled, false);
    assert.equal(bridged.body.defaultVlanId, 10);
    const untagged = await sb.put(path, { useVlanTagging: false });
    assert.equal(untagged.body.defaultVlanId, undefined);
  });

  test('SNMP v3 settings only show with SNMP users', async () => {
    fresh();
    const path = `/networks/${hq.id}/snmp`;
    assert.deepEqual((await sb.get(path)).body.authentication, { protocol: 'SHA-1' });
    assert.deepEqual((await sb.put(path, { privacy: { protocol: 'DES' } })).body.privacy, { protocol: 'DES' });
    assert.deepEqual((await sb.put(path, { access: 'community', communityString: 'example' })).body, { access: 'community', communityString: 'example' });
  });

  test('a switch port only takes speeds it supports', async () => {
    fresh();
    const path = `/devices/${hq.switches[1].serial}/switch/ports/5`;
    const r = await sb.put(path, { linkNegotiation: '100 Megabit full duplex (forced)' });
    assert.equal(r.body.linkNegotiation, '100 Megabit full duplex (forced)');
    assert.match((await sb.put(path, { linkNegotiation: '10 Gigabit full duplex (forced)' })).body.errors[0], /linkNegotiation/);
  });

  test('a disabled switch port reports Disabled', async () => {
    fresh();
    const sw = hq.switches[0];
    await sb.put(`/devices/${sw.serial}/switch/ports/5`, { enabled: false, name: 'Spare' });
    const status = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses`)).body.find((p) => p.portId === '5');
    assert.equal(status.status, 'Disabled');
    assert.equal(status.usageInKb.total, 0);
    assert.equal((await sb.get(`/devices/${sw.serial}/switch/ports/5`)).body.name, 'Spare');
  });

  test('a radio channel set by hand shows in status and settings', async () => {
    fresh();
    const ap = hq.aps[1];
    const r = await sb.put(`/devices/${ap.serial}/wireless/radio/settings`, { fiveGhzSettings: { channel: 149, targetPower: 17 } });
    assert.equal(r.body.fiveGhzSettings.channel, 149);
    assert.equal((await sb.put(`/devices/${ap.serial}/wireless/radio/settings`, { fiveGhzSettings: { channel: 13 } })).status, 400);
    const sets = (await sb.get(`/devices/${ap.serial}/wireless/status`)).body.basicServiceSets.filter((b) => b.band === '5 GHz');
    assert.ok(sets.every((b) => b.channel === 149 && b.power === '17 dBm'));
  });

  test('writes land in the change log as via API', async () => {
    fresh();
    const admins = (await sb.get(`/organizations/${org.id}/admins`)).body;
    const apiAdmin = admins.find((a) => a.email === 'api@example.com');
    await sb.put(`/networks/${hq.id}/wireless/ssids/0`, { minBitrate: 24 });
    const [change] = (await sb.get(`/organizations/${org.id}/configurationChanges?timespan=3600`)).body;
    assert.equal(change.page, 'via API');
    assert.equal(change.label, `PUT /api/v1/networks/${hq.id}/wireless/ssids/0`);
    assert.equal(change.adminId, apiAdmin.id);
    assert.equal(change.networkId, hq.id);
    assert.equal(change.ssidNumber, 0);
    assert.equal(JSON.parse(change.oldValue).minBitrate, 12);
    assert.equal(JSON.parse(change.newValue).minBitrate, 24);
    const logged = (await sb.get(`/organizations/${org.id}/apiRequests?method=PUT`)).body[0];
    assert.equal(logged.operationId, 'updateNetworkWirelessSsid');
    assert.equal(logged.responseCode, 200);
    // Changes outside an SSID still carry the SSID fields, as null.
    await sb.put(`/networks/${hq.id}/settings`, { localStatusPageEnabled: false });
    const [latest] = (await sb.get(`/organizations/${org.id}/configurationChanges?timespan=3600`)).body;
    assert.deepEqual([latest.ssidName, latest.ssidNumber], [null, null]);
  });

  test('admins can be added, changed and removed, but not the API admin', async () => {
    fresh();
    const base = `/organizations/${org.id}/admins`;
    const created = await sb.post(base, { name: 'Pat Doe', email: 'pat.doe@example.com', orgAccess: 'read-only' });
    assert.equal(created.status, 201);
    assert.equal(created.body.accountStatus, 'unverified');
    assert.equal((await sb.post(base, { name: 'Pat', email: 'PAT.DOE@example.com', orgAccess: 'full' })).status, 400);
    assert.equal((await sb.put(`${base}/${created.body.id}`, { orgAccess: 'full' })).body.orgAccess, 'full');
    assert.equal((await sb.del(`${base}/${created.body.id}`)).status, 204);
    const apiAdmin = (await sb.get(base)).body.find((a) => a.email === 'api@example.com');
    assert.equal((await sb.del(`${base}/${apiAdmin.id}`)).status, 400);
  });

  test('an organization can only be deleted once it is empty', async () => {
    fresh();
    const created = await sb.post('/organizations', { name: 'Acme Partner' });
    assert.equal(created.status, 201);
    const net = await sb.post(`/organizations/${created.body.id}/networks`, { name: 'Partner', productTypes: ['wireless'] });
    assert.equal((await sb.del(`/organizations/${created.body.id}`)).status, 400);
    await sb.del(`/networks/${net.body.id}`);
    assert.equal((await sb.del(`/organizations/${created.body.id}`)).status, 204);
    assert.equal((await sb.get(`/organizations/${created.body.id}`)).status, 404);
  });

  test('deleting a webhook server takes it out of the alert settings', async () => {
    fresh();
    const server = await sb.post(`/networks/${hq.id}/webhooks/httpServers`, { name: 'Hook', url: 'https://hooks.example.net/in', sharedSecret: 'x' });
    assert.equal(server.status, 201);
    assert.equal(server.body.sharedSecret, undefined);
    assert.equal((await sb.post(`/networks/${hq.id}/webhooks/httpServers`, { name: 'Again', url: 'https://hooks.example.net/in' })).status, 400);
    await sb.put(`/networks/${hq.id}/alerts/settings`, { defaultDestinations: { httpServerIds: [server.body.id] } });
    await sb.del(`/networks/${hq.id}/webhooks/httpServers/${server.body.id}`);
    assert.deepEqual((await sb.get(`/networks/${hq.id}/alerts/settings`)).body.defaultDestinations.httpServerIds, []);
  });

  test('reset puts the seeded world back', async () => {
    fresh();
    await sb.put(`/networks/${hq.id}`, { name: 'Renamed' });
    await sb.post(`/organizations/${org.id}/networks`, { name: 'Extra', productTypes: ['wireless'] });
    await sb.reset();
    fresh();
    assert.equal((await sb.get(`/networks/${hq.id}`)).body.name, 'HQ - San Francisco');
    assert.equal((await sb.get(`/organizations/${org.id}/networks`)).body.length, 5);
  });

  test('guests start on the Guest group policy and a PUT changes a client policy', async () => {
    fresh();
    const guest = hq.clients.find((c) => c.kindName === 'guest');
    const laptop = hq.clients.find((c) => c.kindName === 'laptop');
    const path = (c) => `/networks/${hq.id}/clients/${c}/policy`;
    assert.deepEqual((await sb.get(path(guest.id))).body, { mac: guest.mac, devicePolicy: 'Group policy', groupPolicyId: '101' });
    assert.deepEqual((await sb.get(path(laptop.mac))).body, { mac: laptop.mac, devicePolicy: 'Normal' });
    const put = await sb.put(path(laptop.id), { devicePolicy: 'Blocked' });
    assert.deepEqual(put.body, { mac: laptop.mac, devicePolicy: 'Blocked' });
    assert.deepEqual((await sb.get(path(laptop.ip))).body, put.body);
    assert.equal((await sb.put(path(laptop.id), { devicePolicy: 'Group policy' })).status, 400);
    assert.equal((await sb.put(path(laptop.id), { devicePolicy: 'Group policy', groupPolicyId: '999' })).status, 400);
    assert.equal((await sb.put(path(laptop.id), { devicePolicy: 'Sometimes' })).status, 400);
    assert.equal((await sb.put(path(guest.id), { devicePolicy: 'Normal' })).body.groupPolicyId, undefined);
    // Without the Guest policy, guests fall back to Normal.
    await sb.del(`/networks/${hq.id}/groupPolicies/101`);
    const other = hq.clients.filter((c) => c.kindName === 'guest')[1];
    assert.equal((await sb.get(path(other.id))).body.devicePolicy, 'Normal');
  });

  test('provisioning gives new MACs a client key and sets the policy', async () => {
    fresh();
    const known = hq.clients[0];
    const path = `/networks/${hq.id}/clients/provision`;
    const r = await sb.post(path, { clients: [{ mac: '02:00:5E:10:00:01', name: 'Kiosk' }, { mac: known.mac }], devicePolicy: 'Group policy', groupPolicyId: '101' });
    assert.equal(r.status, 201);
    assert.equal(r.body.groupPolicyId, '101');
    const [added, existing] = r.body.clients;
    assert.match(added.clientId, /^k[0-9a-f]{6}$/);
    assert.deepEqual([added.mac, added.name], ['02:00:5e:10:00:01', 'Kiosk']);
    assert.deepEqual([existing.clientId, existing.name], [known.id, known.description]);
    assert.equal((await sb.get(`/networks/${hq.id}/clients/${added.clientId}/policy`)).body.groupPolicyId, '101');
    assert.equal((await sb.get(`/networks/${hq.id}/clients/${known.id}/policy`)).body.devicePolicy, 'Group policy');
    // Provisioning the same MAC again keeps its key.
    const again = await sb.post(path, { clients: [{ mac: '02:00:5e:10:00:01' }], devicePolicy: 'Blocked' });
    assert.equal(again.body.clients[0].clientId, added.clientId);
    assert.ok(again.body.clients[0].message);
    const perSsid = await sb.post(path, { clients: [{ mac: '02:00:5e:10:00:01' }], devicePolicy: 'Per connection', policiesBySsid: { 1: { devicePolicy: 'Blocked' } } });
    assert.equal(perSsid.status, 201);
    assert.deepEqual((await sb.get(`/networks/${hq.id}/clients/${added.clientId}/policy`)).body, {
      mac: '02:00:5e:10:00:01',
      devicePolicy: 'Different policies by SSID',
      policiesBySsid: [{ ssidNumber: 1, devicePolicy: 'Blocked' }],
    });
    assert.equal((await sb.post(path, { clients: [{ mac: 'not-a-mac' }], devicePolicy: 'Normal' })).status, 400);
    assert.equal((await sb.post(path, { clients: [], devicePolicy: 'Normal' })).status, 400);
    assert.equal((await sb.post(path, { clients: [{ mac: '02:00:5e:10:00:02' }], devicePolicy: 'Group policy' })).status, 400);
    assert.equal((await sb.get(`/networks/${hq.id}/clients/k000000/policy`)).status, 404);
  });

  test('splash authorization follows sign-ons and API changes', async () => {
    fresh();
    const now = Date.parse(NOW) / 1000;
    const path = (c) => `/networks/${hq.id}/clients/${c.id}/splashAuthorizationStatus`;
    let guest;
    let status;
    for (const c of hq.clients.filter((x) => x.kindName === 'guest')) {
      status = (await sb.get(path(c))).body.ssids[c.ssid.number];
      if (status?.isAuthorized) {
        guest = c;
        break;
      }
    }
    assert.ok(guest, 'some guest signed on in the last day');
    const n = guest.ssid.number;
    assert.equal(Date.parse(status.expiresAt) - Date.parse(status.authorizedAt), 1440 * 60 * 1000);
    // The sign-on is the client's latest splash_auth event.
    const events = (await sb.get(`/networks/${hq.id}/events?productType=wireless&includedEventTypes[]=splash_auth&clientMac=${guest.mac}&perPage=3`)).body.events;
    assert.equal(events[0].occurredAt.slice(0, 19), status.authorizedAt.slice(0, 19));

    const off = await sb.put(path(guest), { ssids: { [n]: { isAuthorized: false } } });
    assert.deepEqual(off.body.ssids[n], { isAuthorized: false, authorizedAt: null, expiresAt: null });
    const on = await sb.put(path(guest), { ssids: { [n]: { isAuthorized: true } } });
    assert.equal(Date.parse(on.body.ssids[n].authorizedAt) / 1000, Math.floor(now));
    assert.deepEqual((await sb.get(path(guest))).body, on.body);
    assert.equal((await sb.put(path(guest), { ssids: { 0: { isAuthorized: true } } })).status, 400);
    const laptop = hq.clients.find((c) => c.kindName === 'laptop' && !c.wired);
    assert.deepEqual((await sb.get(path(laptop))).body, { ssids: {} });
    // Turning the splash page off hides the SSID.
    await sb.put(`/networks/${hq.id}/wireless/ssids/${n}`, { splashPage: 'None' });
    assert.deepEqual((await sb.get(path(guest))).body, { ssids: {} });
  });
});

describe('read-only mode', () => {
  test('refuses every write', async () => {
    const sb = await start({ readOnly: true });
    try {
      const hq = sb.world.orgs[0].networks[0];
      const r = await sb.put(`/networks/${hq.id}`, { name: 'Nope' });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'GET, HEAD');
      assert.equal((await sb.get(`/networks/${hq.id}`)).body.name, 'HQ - San Francisco');
    } finally {
      await sb.close();
    }
  });
});

test('every PUT and POST route has its request schema', () => {
  for (const r of ROUTES) {
    if (r.method === 'PUT' || r.method === 'POST') assert.notEqual(schemaOf(r.op), undefined, `${r.op} has no schema; run node scripts/schemas.js`);
  }
});
