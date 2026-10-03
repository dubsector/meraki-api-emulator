import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('wireless Bluetooth, location scanning, billing and MQTT', () => {
  let sb;
  let corp;
  let lab;
  let hq;
  let austin;
  let ap;
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
    ap = hq.aps[0];
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
  const UUID = 'abcdef00-0000-0000-0000-000000000001';

  test('network Bluetooth settings start off and show major and minor in Non-unique mode', async () => {
    fresh();
    const B = `/networks/${hq.id}/wireless/bluetooth/settings`;
    const s = await ok(sb.get(B));
    assert.deepEqual(Object.keys(s), ['scanningEnabled', 'advertisingEnabled', 'uuid', 'majorMinorAssignmentMode', 'eslEnabled']);
    assert.deepEqual([s.scanningEnabled, s.advertisingEnabled, s.majorMinorAssignmentMode, s.eslEnabled], [false, false, 'Unique', false]);
    assert.match(s.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    assert.notEqual((await ok(sb.get(`/networks/${austin.id}/wireless/bluetooth/settings`))).uuid, s.uuid);
    assert.match(await errorOf(sb.put(B, { major: 5 })), /only be set in 'Non-unique' mode/);
    assert.match(await errorOf(sb.put(B, { uuid: 'nope' })), /must be a UUID/);
    assert.match(await errorOf(sb.put(B, { majorMinorAssignmentMode: 'Non-unique', minor: 70000 })), /'minor' must be an integer between 0 and 65535/);
    const n = await ok(sb.put(B, { majorMinorAssignmentMode: 'Non-unique', major: 7, uuid: UUID.toUpperCase(), advertisingEnabled: true }));
    assert.deepEqual([n.uuid, n.major, n.minor, n.advertisingEnabled], [UUID, 7, 1, true]);
    // A null UUID goes back to the network's own.
    assert.equal((await ok(sb.put(B, { uuid: null }))).uuid, s.uuid);
  });

  test('AP Bluetooth settings follow the network unless set on the AP', async () => {
    fresh();
    const D = (x) => `/devices/${x.serial}/wireless/bluetooth/settings`;
    const [a, b] = [await ok(sb.get(D(ap))), await ok(sb.get(D(hq.aps[1])))];
    const net = await ok(sb.get(`/networks/${hq.id}/wireless/bluetooth/settings`));
    // Unique mode: one major per network, a minor per AP.
    assert.equal(a.uuid, net.uuid);
    assert.equal(a.major, b.major);
    assert.notEqual(a.minor, b.minor);
    await ok(sb.put(`/networks/${hq.id}/wireless/bluetooth/settings`, { majorMinorAssignmentMode: 'Non-unique', major: 3, minor: 4 }));
    assert.deepEqual(await ok(sb.get(D(hq.aps[1]))), { uuid: net.uuid, major: 3, minor: 4 });
    assert.deepEqual(await ok(sb.put(D(ap), { minor: 99, uuid: UUID })), { uuid: UUID, major: 3, minor: 99 });
    assert.deepEqual(await ok(sb.put(D(ap), { minor: null, uuid: null })), { uuid: net.uuid, major: 3, minor: 4 });
    assert.match(await errorOf(sb.put(D(ap), { major: -1 })), /'major' must be an integer/);
    assert.match(await errorOf(sb.get(D(hq.switches[0]))), /only supported for wireless devices/);
  });

  test('Bluetooth clients are empty and a client ID is not found', async () => {
    fresh();
    const C = `/networks/${hq.id}/bluetoothClients`;
    assert.deepEqual(await ok(sb.get(`${C}?includeConnectivityHistory=true`)), []);
    assert.match(await errorOf(sb.get(`${C}?perPage=4`)), /between 5 and 1000/);
    assert.match(await errorOf(sb.get(`${C}?timespan=604801`)), /604800/);
    assert.match(await errorOf(sb.get(`${C}/1284392014819`), 404), /Bluetooth client not found/);
  });

  test('the alternate management interface gives APs addresses', async () => {
    fresh();
    const A = `/networks/${hq.id}/wireless/alternateManagementInterface`;
    assert.deepEqual(await ok(sb.get(A)), { enabled: false, vlanId: null, protocols: [], accessPoints: [] });
    assert.match(await errorOf(sb.put(A, { enabled: true })), /'vlanId' and 'protocols' must be set/);
    const entry = { serial: ap.serial, alternateManagementIp: '10.9.0.5', subnetMask: '255.255.255.0', gateway: '10.9.0.1', dns1: '8.8.8.8' };
    const a = await ok(sb.put(A, { enabled: true, vlanId: 100, protocols: ['ldap', 'radius'], accessPoints: [entry] }));
    assert.deepEqual(a, { enabled: true, vlanId: 100, protocols: ['radius', 'ldap'], accessPoints: [{ ...entry, dns2: null }] });
    const at = (x) => sb.put(A, { accessPoints: [x] });
    assert.match(await errorOf(at({ ...entry, gateway: '10.8.0.1' })), /same subnet/);
    assert.match(await errorOf(at({ ...entry, subnetMask: '255.0.255.0' })), /subnet mask/);
    assert.match(await errorOf(at({ ...entry, dns2: 'x' })), /'accessPoints\[0\]\.dns2' must be an IPv4 address/);
    assert.match(await errorOf(at({ ...entry, serial: hq.switches[0].serial })), /not in this network/);
    assert.match(await errorOf(at({ ...entry, alternateManagementIp: hq.switches[0].lanIp })), /LAN address/);
    assert.match(await errorOf(sb.put(A, { accessPoints: [entry, { ...entry, serial: hq.aps[1].serial }] })), /more than one access point/);
    // Leaving the list out keeps the assignments; an empty address removes one.
    assert.equal((await ok(sb.put(A, { vlanId: 200 }))).accessPoints.length, 1);
    assert.deepEqual((await ok(at({ serial: ap.serial, alternateManagementIp: '' }))).accessPoints, []);
  });

  test('the alternate management interface stays writable on a bound network', async () => {
    fresh();
    const toronto = lab.networks[0];
    const t = await ok(sb.post(`/organizations/${lab.id}/configTemplates`, { name: 'Blank' }), 201);
    await ok(sb.post(`/networks/${toronto.id}/bind`, { configTemplateId: t.id }));
    const A = `/networks/${toronto.id}/wireless/alternateManagementInterface`;
    assert.equal((await ok(sb.put(A, { vlanId: 30, protocols: ['syslog'], enabled: true }))).vlanId, 30);
    assert.match(await errorOf(sb.put(`/networks/${toronto.id}/wireless/billing`, { currency: 'EUR' })), /bound to a config template/);
  });

  test('per-AP IPv6 addresses are stored and echoed back', async () => {
    fresh();
    const P = `/devices/${ap.serial}/wireless/alternateManagementInterface/ipv6`;
    const v6 = { protocol: 'ipv6', assignmentMode: 'static', address: '2001:db8:3c4d:15::1', gateway: 'fe80::1', prefix: '2001:db8:3c4d:15::/64', nameservers: { addresses: ['2001:4860:4860::8888'] } };
    assert.deepEqual(await ok(sb.put(P, { addresses: [v6, { protocol: 'ipv4', assignmentMode: 'dynamic' }] })), {
      addresses: [v6, { protocol: 'ipv4', assignmentMode: 'dynamic', address: null, gateway: null, prefix: null, nameservers: { addresses: [] } }],
    });
    assert.equal((await ok(sb.put(P, {}))).addresses.length, 2);
    assert.match(await errorOf(sb.put(P, { addresses: [{ ...v6, prefix: '64' }] })), /IPv6 prefix/);
    assert.match(await errorOf(sb.put(P, { addresses: [{ ...v6, address: '10.0.0.1' }] })), /must be an ipv6 address/);
    assert.match(await errorOf(sb.put(P, { addresses: [v6, v6] })), /more than one ipv6/);
    assert.match(await errorOf(sb.put(P, { addresses: [{ ...v6, nameservers: { addresses: ['::1', '::2', '::3'] } }] })), /up to 2/);
  });

  test('billing plans get IDs and replace the old list', async () => {
    fresh();
    const B = `/networks/${hq.id}/wireless/billing`;
    assert.deepEqual(await ok(sb.get(B)), { currency: 'USD', plans: [] });
    const plan = (price, timeLimit, extra = {}) => ({ price, timeLimit, bandwidthLimits: { limitUp: 1000, limitDown: null }, ...extra });
    const b = await ok(sb.put(B, { currency: 'EUR', plans: [plan(5, '1 hour'), plan(20, '1 day')] }));
    assert.deepEqual(b.plans.map((p) => [p.id, p.price, p.timeLimit]), [['1', 5, '1 hour'], ['2', 20, '1 day']]);
    assert.deepEqual(b.plans[0].bandwidthLimits, { limitUp: 1000, limitDown: null });
    const c = await ok(sb.put(B, { plans: [plan(25, '1 week', { id: '2' }), plan(1, '30 days')] }));
    assert.deepEqual([c.currency, c.plans.map((p) => [p.id, p.price])], ['EUR', [['2', 25], ['3', 1]]]);
    assert.match(await errorOf(sb.put(B, { plans: [plan(1, '1 day', { id: '1' })] })), /Billing plan '1' does not exist/);
    assert.match(await errorOf(sb.put(B, { plans: Array.from({ length: 6 }, () => plan(1, '1 day')) })), /limited to 5/);
    assert.match(await errorOf(sb.put(B, { plans: [plan(-1, '1 day')] })), /at least 0/);
    assert.match(await errorOf(sb.put(B, { currency: 'euro' })), /currency code/);
    assert.match(await errorOf(sb.put(B, { plans: [plan(1, '2 days')] })), /timeLimit/);
  });

  test('location scanning reads back across the organization', async () => {
    fresh();
    const S = `/networks/${hq.id}/wireless/location/scanning`;
    const L = `/organizations/${corp.id}/wireless/location/scanning/byNetwork`;
    const rows = await collect(sb.get, `${L}?perPage=3`);
    assert.deepEqual(rows.map((r) => r.networkId), corp.networks.filter((n) => n.productTypes.includes('wireless')).map((n) => n.id).sort());
    const row = rows.find((r) => r.networkId === hq.id);
    assert.equal(row.enabled, false);
    assert.match(row.api.validator.string, /^[0-9a-f]{40}$/);
    assert.match(await errorOf(sb.put(S, { api: { enabled: true } })), /analytics is enabled/);
    const s = await ok(sb.put(S, { enabled: true, api: { enabled: true } }));
    assert.deepEqual(s, { enabled: true, api: { enabled: true, validator: row.api.validator } });
    assert.deepEqual((await ok(sb.get(`${L}?networkIds[]=${hq.id}`))).items, [{ networkId: hq.id, name: hq.name, ...s }]);
    assert.equal((await ok(sb.put(S, { enabled: false }))).api.enabled, false);
  });

  test('scanning receivers keep their secret and follow their network', async () => {
    fresh();
    const toronto = lab.networks[0];
    const R = `/organizations/${lab.id}/wireless/location/scanning/receivers`;
    const body = { network: { id: toronto.id }, url: 'https://rx.example.com/scan', version: '3', radio: { type: 'Wi-Fi' }, sharedSecret: 'secret' };
    const r = await ok(sb.post(R, body), 201);
    assert.deepEqual(r, { network: { id: toronto.id, name: toronto.name }, receiverId: r.receiverId, url: body.url, version: '3', radio: { type: 'Wi-Fi' } });
    assert.match(r.receiverId, /^\d{7}$/);
    assert.match(await errorOf(sb.post(R, { ...body, url: 'ftp://rx' })), /http or https URL/);
    assert.match(await errorOf(sb.post(R, { ...body, version: '4' })), /'version' must be one of/);
    assert.match(await errorOf(sb.post(R, { ...body, radio: { type: 'BLE' } })), /'radio.type'/);
    assert.match(await errorOf(sb.post(R, { ...body, sharedSecret: '' })), /sharedSecret/);
    assert.match(await errorOf(sb.post(R, { ...body, network: { id: hq.id } })), /not in this organization/);
    const u = await ok(sb.put(`${R}/${r.receiverId}`, { url: 'http://new.example.com', radio: { type: 'Bluetooth' } }));
    assert.deepEqual([u.url, u.radio.type, u.version], ['http://new.example.com', 'Bluetooth', '3']);
    await errorOf(sb.put(`${R}/1`, { version: '2' }), 404);

    // Combining the network moves the receiver to the combined one.
    const mx = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Toronto MX', productTypes: ['appliance'] }), 201);
    const net = (await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Toronto', networkIds: [toronto.id, mx.id] }))).resultingNetwork;
    const list = await ok(sb.get(`${R}?networkIds[]=${net.id}`));
    assert.deepEqual([list.items.map((x) => x.receiverId), list.meta.counts.items.total], [[r.receiverId], 1]);
    assert.equal(list.items[0].network.name, 'Toronto');
    await ok(sb.del(`${R}/${r.receiverId}`), 204);
    assert.deepEqual((await ok(sb.get(R))).items, []);
  });

  test('MQTT settings name one of the network\'s brokers', async () => {
    fresh();
    const M = `/organizations/${corp.id}/wireless/mqtt/settings`;
    const rows = await collect(sb.get, `${M}?perPage=3`);
    assert.equal(rows.length, 5);
    const row = rows.find((r) => r.network.id === austin.id);
    assert.deepEqual([row.mqtt.enabled, row.mqtt.broker, row.mqtt.publishing, row.ble.type, row.wifi.type], [false, null, { frequency: 1, qos: 0 }, 'all', 'associated']);
    assert.match(row.mqtt.settingsId, /^\d{7}$/);
    const put = (b) => sb.put(M, { network: { id: austin.id }, mqtt: {}, ...b });
    assert.match(await errorOf(put({ mqtt: { enabled: true } })), /must name one of the network's MQTT brokers/);
    assert.match(await errorOf(put({ mqtt: { broker: { name: 'Hub' } } })), /MQTT broker 'Hub' does not exist/);
    // Wireless networks keep MQTT brokers too.
    const broker = await ok(sb.post(`/networks/${austin.id}/mqttBrokers`, { name: 'Hub', host: 'mqtt.example.com', port: 1883 }), 201);
    const m = await ok(
      put({
        mqtt: { enabled: true, topic: 'meraki', messageFields: ['Timestamp', 'RSSI'], publishing: { qos: 2 }, broker: { name: 'Hub' } },
        ble: { enabled: true, allowLists: { uuids: [UUID.toUpperCase()], macs: ['AA:BB:CC:DD:EE:FF'] }, hysteresis: { threshold: 3 } },
        wifi: { type: 'visible', flush: { frequency: 30 } },
      }),
      201,
    );
    assert.deepEqual(m.mqtt, { settingsId: row.mqtt.settingsId, enabled: true, topic: 'meraki', messageFields: ['RSSI', 'Timestamp'], publishing: { frequency: 1, qos: 2 }, broker: { id: broker.id, name: 'Hub' } });
    assert.deepEqual(m.ble.allowLists, { uuids: [UUID], macs: ['aa:bb:cc:dd:ee:ff'] });
    assert.deepEqual([m.ble.hysteresis, m.wifi.type, m.wifi.flush.frequency], [{ enabled: false, threshold: 3 }, 'visible', 30]);
    assert.deepEqual((await ok(sb.get(`${M}?networkIds[]=${austin.id}`))).items, [m]);
    assert.match(await errorOf(put({ mqtt: { messageFields: ['Bogus'] } })), /must be some of/);
    assert.match(await errorOf(put({ ble: { flush: { frequency: 0 } } })), /between 1 and 2147483647/);
    assert.match(await errorOf(put({ wifi: { allowLists: { macs: ['zz'] } } })), /MAC addresses/);
    assert.match(await errorOf(put({ network: { id: 'L_1' } })), /not in this organization/);
    // A deleted broker drops out and turns MQTT off.
    await ok(sb.del(`/networks/${austin.id}/mqttBrokers/${broker.id}`), 204);
    const gone = (await ok(sb.get(`${M}?networkIds[]=${austin.id}`))).items[0].mqtt;
    assert.deepEqual([gone.enabled, gone.broker], [false, null]);
    assert.equal((await ok(put({ mqtt: { topic: 'other' } }), 201)).mqtt.topic, 'other');
  });

  test('wireless MQTT keeps its broker when networks split and combine', async () => {
    fresh();
    const M = (org) => `/organizations/${org.id}/wireless/mqtt/settings`;
    const enable = async (org, net) => {
      await ok(sb.post(`/networks/${net.id}/mqttBrokers`, { name: 'Hub', host: 'mqtt.example.com', port: 1883 }), 201);
      return (await ok(sb.put(M(org), { network: { id: net.id }, mqtt: { enabled: true, broker: { name: 'Hub' } } }), 201)).mqtt;
    };
    // HQ's brokers serve its cameras and its APs, so both parts keep them.
    const before = await enable(corp, hq);
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    const cam = parts.find((n) => n.productTypes[0] === 'camera');
    const after = (await ok(sb.get(`${M(corp)}?networkIds[]=${wl.id}`))).items[0].mqtt;
    assert.deepEqual([after.enabled, after.broker], [true, before.broker]);
    for (const n of [wl, cam]) assert.deepEqual((await ok(sb.get(`/networks/${n.id}/mqttBrokers`))).map((b) => b.id), [before.broker.id]);
    // A wireless-only network's brokers survive combining with an MX.
    const toronto = lab.networks[0];
    const own = await enable(lab, toronto);
    const mx = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Toronto MX', productTypes: ['appliance'] }), 201);
    const net = (await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Toronto', networkIds: [mx.id, toronto.id] }))).resultingNetwork;
    const combined = (await ok(sb.get(`${M(lab)}?networkIds[]=${net.id}`))).items[0].mqtt;
    assert.deepEqual([combined.enabled, combined.broker], [true, own.broker]);
  });
});
