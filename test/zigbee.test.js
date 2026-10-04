import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { DAY } from '../src/time.js';
import { removeDevice, swapDevice } from '../src/world.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('Zigbee door locks and electronic shelf labels', () => {
  let sb;
  let lab;
  let mtl;
  let ap;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    mtl = lab.networks.find((n) => n.name === 'Lab - Montreal');
    ap = mtl.devices.find((d) => d.model === 'CW9166I');
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
  const Z = () => `/organizations/${lab.id}/wireless/zigbee`;

  test('Montreal starts with Zigbee, two door locks and ESL on', async () => {
    fresh();
    const rows = await ok(sb.get(`${Z()}/byNetwork`));
    assert.deepEqual(rows.map((r) => r.network.id), lab.networks.filter((n) => n.productTypes.includes('wireless')).map((n) => n.id).sort());
    const m = rows.find((r) => r.network.id === mtl.id);
    assert.deepEqual(m, {
      network: { id: mtl.id },
      enabled: true,
      iotController: { name: ap.name, mac: ap.mac, serial: ap.serial, status: 'online' },
      lockManagement: { address: null, username: null, status: 'offline' },
      defaults: { transmitPowerLevel: 10, channel: 'auto' },
    });
    assert.equal(rows.find((r) => r.network.id !== mtl.id).enabled, false);
    const locks = await ok(sb.get(`${Z()}/doorLocks`));
    assert.deepEqual(locks.map((l) => l.name).sort(), ['Front Door', 'Storage Room']);
    for (const l of locks) {
      assert.deepEqual(l.gateway, { name: ap.name, serial: ap.serial });
      assert.deepEqual(l.network, { id: mtl.id, name: mtl.name });
      assert.equal(l.status, 'online');
      assert.match(l.eui64, /^[0-9A-F]{16}$/);
      assert.ok(l.enrolledAt <= l.lastSeenAt && l.lastSeenAt <= NOW);
    }
    const [g] = await ok(sb.get(`${Z()}/devices?networkIds[]=${mtl.id}`));
    assert.equal(g.gateway.serial, ap.serial);
    assert.equal(g.enrolled, true);
    assert.deepEqual(g.counts, { doorLocks: { byStatus: { online: 2, offline: 0, dormant: 0 } } });
    assert.deepEqual(await ok(sb.get(`/networks/${mtl.id}/wireless/electronicShelfLabel`)), { hostname: 'esl.acme-lab.example.com', enabled: true, mode: 'high frequency', sepioo: { hostname: null } });
    const dev = await ok(sb.get(`/devices/${ap.serial}/wireless/electronicShelfLabel`));
    assert.deepEqual(dev, { apEslId: ap.key & 0xffffff, serial: ap.serial, channel: 'Auto', enabled: true, networkId: mtl.id, hostname: 'esl.acme-lab.example.com', provider: 'imagotag' });
    assert.deepEqual(await ok(sb.get(`/networks/${mtl.id}/wireless/electronicShelfLabel/configuredDevices`)), [{ hostname: 'esl.acme-lab.example.com', enabled: true, mode: 'high frequency', sepioo: { hostname: null } }]);
  });

  test("Acme Corporation's CW9166I networks answer with everything off", async () => {
    fresh();
    const corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    const hq = corp.networks.find((n) => n.name === 'HQ - San Francisco');
    const austin = corp.networks.find((n) => n.name === 'Branch - Austin');
    assert.equal((await ok(sb.get(`/networks/${hq.id}/wireless/electronicShelfLabel`))).enabled, false);
    assert.equal((await ok(sb.get(`/networks/${hq.id}/wireless/electronicShelfLabel/configuredDevices`))).length, 10);
    assert.deepEqual(await ok(sb.get(`/networks/${austin.id}/wireless/electronicShelfLabel/configuredDevices`)), []);
    const devices = await collect(sb.get, `/organizations/${corp.id}/wireless/zigbee/devices?perPage=3`);
    assert.equal(devices.length, 10);
    assert.ok(devices.every((d) => !d.enrolled && d.counts.doorLocks.byStatus.online === 0));
    assert.deepEqual(await ok(sb.get(`/organizations/${corp.id}/wireless/zigbee/doorLocks`)), []);
    assert.match(await errorOf(sb.get(`/devices/${austin.devices.find((d) => d.productType === 'wireless').serial}/wireless/electronicShelfLabel`)), /CW916x/);
    await errorOf(sb.get(`/networks/${lab.networks.find((n) => n.name === 'Lab - Ottawa').id}/wireless/electronicShelfLabel`));
    assert.match(await errorOf(sb.post(`/devices/${hq.devices.find((d) => d.model === 'CW9166I').serial}/wireless/zigbee/enrollments`)), /not enabled/);
  });

  test('network Zigbee settings check every field and keep the password', async () => {
    fresh();
    const Nz = `/networks/${mtl.id}/wireless/zigbee`;
    const r = await ok(sb.put(Nz, { lockManagement: { address: 'locks.example.com', username: 'admin', password: 'secret' }, defaults: { transmitPowerLevel: 15, channel: '20' } }), 201);
    assert.deepEqual(r.lockManagement, { address: 'locks.example.com', username: 'admin', status: 'online' });
    assert.deepEqual(r.defaults, { transmitPowerLevel: 15, channel: '20' });
    assert.ok(!JSON.stringify(r).includes('secret'));
    assert.equal(mtl.wirelessZigbee.lockManagement.password, 'secret');
    assert.match(await errorOf(sb.put(Nz, { defaults: { channel: '10' } })), /11 to 25/);
    assert.match(await errorOf(sb.put(Nz, { defaults: { transmitPowerLevel: 9 } })), /transmitPowerLevel/);
    assert.match(await errorOf(sb.put(Nz, { lockManagement: { address: 'not a host' } })), /hostname or IP/);
    assert.match(await errorOf(sb.put(Nz, { iotController: {} })), /required/);
    const toronto = lab.networks.find((n) => n.name === 'Lab - Toronto');
    assert.match(await errorOf(sb.put(Nz, { iotController: { serial: toronto.devices[0].serial } })), /CW916x/);
    assert.match(await errorOf(sb.put(`/networks/${toronto.id}/wireless/zigbee`, { enabled: true })), /IoT controller/);
    const off = await ok(sb.put(Nz, { enabled: false }), 201);
    assert.equal(off.lockManagement.status, 'offline');
    assert.equal((await ok(sb.get(`${Z()}/devices?networkIds[]=${mtl.id}`)))[0].transmitPowerLevel, 15);
  });

  test('gateways and door locks update only the fields the spec lists', async () => {
    fresh();
    const g = await ok(sb.put(`${Z()}/devices/${ap.serial}`, { enrolled: false, channel: '15' }), 201);
    assert.equal(g.enrolled, false);
    assert.equal(g.channel, '15');
    assert.deepEqual(await ok(sb.get(`${Z()}/devices?isEnrolled=true`)), []);
    assert.equal((await ok(sb.get(`${Z()}/devices?search=MTL`))).length, 1);
    assert.deepEqual(await ok(sb.get(`${Z()}/devices?search=nothing`)), []);
    assert.match(await errorOf(sb.put(`${Z()}/devices/${ap.serial}`, { channel: 'auto' })), /enrolled/);
    await errorOf(sb.put(`${Z()}/devices/Q3AC-NONE-0000`, { enrolled: true }), 404);
    const [lock] = await ok(sb.get(`${Z()}/doorLocks`));
    const named = await ok(sb.put(`${Z()}/doorLocks/${lock.doorLockId}`, { name: 'Lobby' }), 201);
    assert.deepEqual(named, { ...lock, name: 'Lobby' });
    assert.match(await errorOf(sb.put(`${Z()}/doorLocks/${lock.doorLockId}`, { name: '' })), /empty/);
    await errorOf(sb.put(`${Z()}/doorLocks/1`, { name: 'x' }), 404);
    assert.equal((await ok(sb.get(`${Z()}/doorLocks?serial=${ap.serial}&networkIds[]=${mtl.id}`))).length, 2);
    assert.deepEqual(await ok(sb.get(`${Z()}/doorLocks?serial=Q3AC-NONE-0000`)), []);
  });

  test('an enrollment pairs one lock and a disenrollment removes the named ones', async () => {
    fresh();
    const E = `/devices/${ap.serial}/wireless/zigbee/enrollments`;
    const e = await ok(sb.post(E), 201);
    assert.deepEqual(e, { enrollmentId: e.enrollmentId, url: `${E}/${e.enrollmentId}`, request: { serial: ap.serial }, status: 'complete' });
    const job = await ok(sb.get(`${E}/${e.enrollmentId}`));
    assert.equal(job.enrollmentStartedAt, NOW.replace('.000', ''));
    assert.equal(job.doorLocks.length, 1);
    const locks = await ok(sb.get(`${Z()}/doorLocks`));
    assert.equal(locks.length, 3);
    assert.deepEqual(locks.find((l) => l.doorLockId === job.doorLocks[0].doorLockId), job.doorLocks[0]);
    await errorOf(sb.get(`${E}/1234`), 404);
    const D = `${Z()}/disenrollments`;
    const ids = [job.doorLocks[0].doorLockId, locks[0].doorLockId];
    const d = await ok(sb.post(D, { doorLockIds: [...ids, '999', ids[0]] }), 201);
    assert.deepEqual(d.request.doorLockIds, [...ids, '999']);
    assert.equal(d.status, 'complete');
    assert.deepEqual((await ok(sb.get(`${D}/${d.disenrollmentId}`))).doorLocks, [
      { doorLockId: ids[0], status: 'success' },
      { doorLockId: ids[1], status: 'success' },
      { doorLockId: '999', status: 'failure' },
    ]);
    assert.equal((await ok(sb.get(`${Z()}/doorLocks`))).length, 1);
    assert.deepEqual((await ok(sb.get(`${E}/${e.enrollmentId}`))).doorLocks, []);
    assert.match(await errorOf(sb.post(D, { doorLockIds: [] })), /at least one/);
    await errorOf(sb.get(`${D}/1234`), 404);
  });

  test('ESL settings check their fields', async () => {
    fresh();
    const N = `/networks/${mtl.id}/wireless/electronicShelfLabel`;
    const r = await ok(sb.put(N, { hostname: 'localhost:700', mode: 'Bluetooth' }));
    assert.deepEqual(r, { hostname: 'localhost:700', enabled: true, mode: 'Bluetooth', sepioo: { hostname: 'localhost:700' } });
    assert.equal((await ok(sb.get(`/devices/${ap.serial}/wireless/electronicShelfLabel`))).provider, 'sepioo');
    assert.match(await errorOf(sb.put(N, { hostname: 'bad host' })), /hostname/);
    assert.equal((await ok(sb.put(N, { hostname: null })) ).hostname, null);
    const D = `/devices/${ap.serial}/wireless/electronicShelfLabel`;
    assert.deepEqual(await ok(sb.put(D, { channel: '6', enabled: false })), { ...(await ok(sb.get(D))), channel: '6', enabled: false });
    assert.equal((await ok(sb.put(D, { channel: 'AUTO' }))).channel, 'Auto');
    assert.match(await errorOf(sb.put(D, { channel: '12' })), /1 to 11/);
    assert.deepEqual((await ok(sb.get(`/networks/${mtl.id}/wireless/electronicShelfLabel/configuredDevices`)))[0].enabled, false);
  });

  test('locks follow a gateway swap and the network through split and combine, and leave with the AP', async () => {
    fresh();
    swapDevice(sb.world, ap, { serial: 'Q3AC-TEST-0001', model: 'CW9166I', mac: '0c:8d:db:00:00:01', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    const locks = await ok(sb.get(`${Z()}/doorLocks`));
    assert.deepEqual(locks.map((l) => l.gateway.serial), ['Q3AC-TEST-0001', 'Q3AC-TEST-0001']);
    assert.equal((await ok(sb.get(`${Z()}/byNetwork?networkIds[]=${mtl.id}`)))[0].iotController.serial, 'Q3AC-TEST-0001');
    const parts = (await ok(sb.post(`/networks/${mtl.id}/split`))).resultingNetworks;
    const part = parts.find((n) => n.productTypes[0] === 'wireless');
    assert.equal((await ok(sb.get(`${Z()}/byNetwork?networkIds[]=${part.id}`)))[0].enabled, true);
    assert.equal((await ok(sb.get(`/networks/${part.id}/wireless/electronicShelfLabel`))).enabled, true);
    const back = await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Montreal', networkIds: parts.map((n) => n.id) }));
    const id = back.resultingNetwork.id;
    const row = (await ok(sb.get(`${Z()}/byNetwork?networkIds[]=${id}`)))[0];
    assert.equal(row.iotController.serial, 'Q3AC-TEST-0001');
    assert.equal((await ok(sb.get(`${Z()}/doorLocks`))).length, 2);
    removeDevice(sb.world, sb.world.deviceBySerial.get('Q3AC-TEST-0001'));
    assert.deepEqual(await ok(sb.get(`${Z()}/doorLocks`)), []);
    assert.equal((await ok(sb.get(`${Z()}/byNetwork?networkIds[]=${id}`)))[0].iotController, null);
  });

  test('an AP swapped for a model without Zigbee drops its locks and stops being the controller', async () => {
    fresh();
    await ok(sb.put(`/devices/${ap.serial}/wireless/electronicShelfLabel`, { channel: '6' }));
    swapDevice(sb.world, ap, { serial: 'Q3AC-TEST-0002', model: 'MR36', mac: '0c:8d:db:00:00:02', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    assert.deepEqual(await ok(sb.get(`${Z()}/doorLocks`)), []);
    assert.deepEqual(await ok(sb.get(`${Z()}/devices?networkIds[]=${mtl.id}`)), []);
    const row = (await ok(sb.get(`${Z()}/byNetwork?networkIds[]=${mtl.id}`)))[0];
    assert.equal(row.iotController, null);
    assert.match(await errorOf(sb.put(`/networks/${mtl.id}/wireless/zigbee`, { enabled: true })), /IoT controller/);
    // A later swap back to a CW916x starts with nothing paired.
    swapDevice(sb.world, ap, { serial: 'Q3AC-TEST-0003', model: 'CW9166I', mac: '0c:8d:db:00:00:03', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    assert.deepEqual(await ok(sb.get(`${Z()}/doorLocks`)), []);
    assert.equal((await ok(sb.get(`/devices/Q3AC-TEST-0003/wireless/electronicShelfLabel`))).channel, 'Auto');
  });

  test('network copies and clones take the ESL settings and Zigbee off', async () => {
    fresh();
    const lm = { address: 'locks.acme-lab.example.com', username: 'svc', password: 'secret' };
    await ok(sb.put(`/networks/${mtl.id}/wireless/zigbee`, { lockManagement: lm, defaults: { transmitPowerLevel: 15, channel: '20' } }), 201);
    const esl = await ok(sb.get(`/networks/${mtl.id}/wireless/electronicShelfLabel`));
    const copy = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Montreal copy', productTypes: ['wireless'], copyFromNetworkId: mtl.id }), 201);
    const clone = await ok(sb.post(`/organizations/${lab.id}/clone`, { name: 'Lab clone' }), 201);
    const cloned = (await ok(sb.get(`/organizations/${clone.id}/networks`))).find((n) => n.name === 'Lab - Montreal');
    for (const [org, id] of [[lab.id, copy.id], [clone.id, cloned.id]]) {
      assert.deepEqual(await ok(sb.get(`/networks/${id}/wireless/electronicShelfLabel`)), esl);
      const z = (await ok(sb.get(`/organizations/${org}/wireless/zigbee/byNetwork?networkIds[]=${id}`)))[0];
      assert.deepEqual(z, { network: { id }, enabled: false, iotController: null, lockManagement: { address: lm.address, username: 'svc', status: 'offline' }, defaults: { transmitPowerLevel: 15, channel: '20' } });
    }
    // A copy without wireless takes neither.
    const wired = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Montreal sensors', productTypes: ['sensor'], copyFromNetworkId: mtl.id }), 201);
    assert.equal(sb.world.networkById.get(wired.id).wirelessEsl, undefined);
  });
});

describe('Zigbee jobs on a running clock', () => {
  test('a new enrollment and disenrollment are pending and change nothing yet', async () => {
    const sb = await start({ now: null });
    try {
      const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
      const ap = sb.world.devices.find((d) => d.model === 'CW9166I' && d.net.org === lab);
      const e = (await sb.post(`/devices/${ap.serial}/wireless/zigbee/enrollments`)).body;
      assert.equal(e.status, 'pending');
      assert.deepEqual((await sb.get(`/devices/${ap.serial}/wireless/zigbee/enrollments/${e.enrollmentId}`)).body.doorLocks, []);
      const locks = (await sb.get(`/organizations/${lab.id}/wireless/zigbee/doorLocks`)).body;
      assert.equal(locks.length, 2);
      const d = (await sb.post(`/organizations/${lab.id}/wireless/zigbee/disenrollments`, { doorLockIds: [locks[0].doorLockId] })).body;
      assert.equal(d.status, 'pending');
      assert.equal((await sb.get(`/organizations/${lab.id}/wireless/zigbee/doorLocks`)).body.length, 2);
    } finally {
      await sb.close();
    }
  });
});
