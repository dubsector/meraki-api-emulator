import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, start } from './helpers.js';

describe('per-device licenses', () => {
  let sb;
  let corp;
  let lab;
  let L;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp, lab] = sb.world.orgs;
    L = `/organizations/${lab.id}/licenses`;
  };
  const unusedOf = () => lab.licenses.find((l) => !l.deviceSerial);
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };

  test('one license reads the same as in the list', async () => {
    fresh();
    const list = (await sb.get(L)).body;
    for (const l of list) assert.deepEqual((await sb.get(`${L}/${l.id}`)).body, l);
    await errorOf(sb.get(`${L}/999999`), 404);
    await errorOf(sb.get(`/organizations/${corp.id}/licenses/${list[0].id}`));
  });

  test('a license for a device that has one is queued behind it', async () => {
    fresh();
    const ap = lab.devices[0];
    const head = lab.licenses.find((l) => l.deviceSerial === ap.serial);
    const unused = unusedOf();
    const r = await sb.put(`${L}/${unused.id}`, { deviceSerial: ap.serial });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const headJson = (await sb.get(`${L}/${head.id}`)).body;
    assert.equal(r.body.state, 'recentlyQueued');
    assert.equal(r.body.headLicenseId, head.id);
    assert.equal(r.body.networkId, ap.net.id);
    assert.equal(r.body.activationDate, headJson.expirationDate);
    assert.equal(r.body.durationInDays, 1095);
    assert.deepEqual(headJson.permanentlyQueuedLicenses.map((q) => [q.id, q.durationInDays]), [[unused.id, 1095]]);
    assert.equal(headJson.totalDurationInDays, headJson.durationInDays + 1095);
    assert.equal((await sb.get(`${L}/overview`)).body.states.recentlyQueued.count, 1);
    // The inventory still reports the license at the head of the queue.
    assert.equal((await sb.get(`/organizations/${lab.id}/inventory/devices/${ap.serial}`)).body.licenseExpirationDate.slice(0, 19), headJson.expirationDate.slice(0, 19));

    assert.match(await errorOf(sb.put(`${L}/${head.id}`, { deviceSerial: null })), /queued behind it/);
    const back = await sb.put(`${L}/${unused.id}`, { deviceSerial: null });
    assert.deepEqual([back.body.state, back.body.activationDate, back.body.headLicenseId, back.body.durationInDays], ['unused', null, null, 1095]);
  });

  test('an unused license starts when assigned and keeps running when taken off', async () => {
    fresh();
    const spare = lab.spares[0];
    const unused = unusedOf();
    const on = (await sb.put(`${L}/${unused.id}`, { deviceSerial: spare.serial })).body;
    assert.deepEqual([on.state, on.activationDate, on.networkId], ['active', NOW, null]);
    assert.equal(Date.parse(on.expirationDate) - Date.parse(NOW), 1095 * 86400000);
    const off = (await sb.put(`${L}/${unused.id}`, { deviceSerial: null })).body;
    assert.deepEqual([off.state, off.activationDate, off.deviceSerial], ['unusedActive', NOW, null]);
    const overview = (await sb.get(`${L}/overview`)).body.states.unusedActive;
    assert.deepEqual(overview, { count: 1, oldestActivation: { activationDate: NOW, activeCount: 1 } });
    // A license that has started can't queue behind another.
    assert.match(await errorOf(sb.put(`${L}/${unused.id}`, { deviceSerial: lab.devices[0].serial })), /already has an active license/);
    assert.match(await errorOf(sb.put(`${L}/${unused.id}`, { deviceSerial: corp.devices[0].serial })), /not in this organization/);
  });

  test('licenses move to another organization with their devices', async () => {
    fresh();
    const ap = lab.devices[0];
    const license = lab.licenses.find((l) => l.deviceSerial === ap.serial);
    const body = { destOrganizationId: corp.id, licenseIds: [license.id] };
    assert.match(await errorOf(sb.post(`${L}/move`, body)), /does not support per-device licensing/);
    const dest = (await sb.post('/organizations', { name: 'Acme Labs West' })).body;
    body.destOrganizationId = dest.id;
    const queued = unusedOf();
    await sb.put(`${L}/${queued.id}`, { deviceSerial: ap.serial });
    assert.match(await errorOf(sb.post(`${L}/move`, body)), /must move with it/);
    body.licenseIds.push(queued.id);

    const r = await sb.post(`${L}/move`, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, body);
    assert.equal((await sb.get(`/organizations/${dest.id}`)).body.licensing.model, 'per-device');
    const moved = (await sb.get(`/organizations/${dest.id}/licenses`)).body;
    assert.deepEqual(moved.map((l) => [l.deviceSerial, l.networkId]), [[ap.serial, null], [ap.serial, null]]);
    assert.equal((await sb.get(`/organizations/${dest.id}/inventory/devices/${ap.serial}`)).body.networkId, null);
    assert.equal((await sb.get(`/devices/${ap.serial}`)).status, 404);
    assert.equal((await sb.get(L)).body.length, 19);
    // A non-empty organization keeps its licensing model.
    assert.match(await errorOf(sb.post(`${L}/move`, { destOrganizationId: corp.id, licenseIds: [lab.licenses[0].id] })), /per-device/);
  });

  test('neither organization has Systems Manager seats to assign, move or renew', async () => {
    fresh();
    const id = lab.licenses[0].id;
    assert.match(await errorOf(sb.post(`${L}/assignSeats`, { licenseId: id, networkId: lab.networks[0].id, seatCount: 5 })), /not a Systems Manager license/);
    assert.match(await errorOf(sb.post(`${L}/moveSeats`, { licenseId: '1', destOrganizationId: corp.id, seatCount: 5 })), /not in this organization/);
    assert.match(await errorOf(sb.post(`${L}/moveSeats`, { licenseId: id, destOrganizationId: corp.id, seatCount: 0 })), /seatCount/);
    assert.match(await errorOf(sb.post(`/organizations/${corp.id}/licenses/renewSeats`, { licenseIdToRenew: '1', unusedLicenseId: '2' })), /not in this organization/);
  });
});

describe('co-term licenses and inventory claims', () => {
  let sb;
  let corp;
  let lab;
  let C;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp, lab] = sb.world.orgs;
    C = `/organizations/${corp.id}/licensing/coterm/licenses`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r) => {
    const res = await r;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const overview = async (org = corp) => (await sb.get(`/organizations/${org.id}/licenses/overview`)).body;
  const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  const claim = (org, body) => sb.post(`/organizations/${org.id}/inventory/claim`, body);
  const inventory = async (org, q = '') => (await sb.get(`/organizations/${org.id}/inventory/devices${q}`)).body;

  test('the seeded licenses add up to the licenses overview', async () => {
    fresh();
    const list = await ok(sb.get(C));
    assert.equal(list.length, corp.networks.length + 1);
    assert.ok(list.every((l) => /^Z2\w{2}-\w{4}-\w{4}$/.test(l.key) && l.organizationId === corp.id && !l.invalidated && !l.expired && l.invalidatedAt === null));
    assert.deepEqual(list.map((l) => l.key), list.map((l) => l.key).sort());
    const counted = list.flatMap((l) => l.counts).reduce((n, c) => n + c.count, 0);
    const o = await overview();
    assert.equal(o.status, 'OK');
    assert.equal(counted, sum(o.licensedDeviceCounts));
    assert.equal(counted, corp.devices.length + corp.spares.length);
    assert.deepEqual(list.find((l) => l.counts.some((c) => c.model === 'MV')).editions.map((e) => e.productType).sort(), ['appliance', 'camera', 'switch', 'wireless']);

    const page = await sb.get(`${C}?perPage=3`);
    assert.deepEqual(page.body, list.slice(0, 3));
    assert.match(page.link, /rel=next/);
    assert.equal((await ok(sb.get(`${C}?invalidated=true`))).length, 0);
    assert.equal((await ok(sb.get(`${C}?expired=false`))).length, list.length);
    await errorOf(sb.get(`${C}?perPage=2`));
    assert.match(await errorOf(sb.get(`/organizations/${lab.id}/licensing/coterm/licenses`)), /co-term/);
  });

  test('claiming an order brings its devices and license in', async () => {
    fresh();
    const order = sb.world.unclaimed.devices[0].orderNumber;
    const devices = sb.world.unclaimed.devices.filter((d) => d.orderNumber === order);
    const before = await overview();
    assert.match(await errorOf(claim(corp, {})), /at least one/i);
    assert.match(await errorOf(claim(corp, { orders: ['4C0000000'] })), /not found/);
    assert.match(await errorOf(claim(corp, { serials: ['Q2XX-0000-0000'] })), /not found/);
    assert.match(await errorOf(claim(corp, { serials: [corp.devices[0].serial] })), /already been claimed/);
    assert.match(await errorOf(claim(lab, { orders: [order] })), /per-device/);
    assert.equal((await inventory(lab)).length, lab.devices.length + lab.spares.length);

    assert.deepEqual(await ok(claim(corp, { orders: [order] })), { orders: [order], serials: [], licenses: [] });
    const rows = await inventory(corp, `?orderNumbers[]=${order}`);
    assert.deepEqual(rows.map((d) => d.serial).sort(), devices.map((d) => d.serial).sort());
    assert.ok(rows.every((d) => d.networkId === null && d.claimedAt.startsWith('2026-09-29T18:30:00')));
    const after = await overview();
    assert.equal(after.status, 'OK');
    assert.equal(after.expirationDate, before.expirationDate);
    assert.equal(sum(after.licensedDeviceCounts), sum(before.licensedDeviceCounts) + devices.length);
    assert.equal(after.licensedDeviceCounts.MR, before.licensedDeviceCounts.MR + 2);
    assert.equal((await ok(sb.get(C))).length, corp.networks.length + 2);
    assert.match(await errorOf(claim(corp, { orders: [order] })), /already been claimed/);
    assert.match(await errorOf(claim(corp, { serials: [devices[0].serial] })), /already been claimed/);

    // The new devices go into a network like any other inventory device.
    const net = corp.networks[1];
    assert.equal((await ok(sb.post(`/networks/${net.id}/devices/claim`, { serials: [devices[2].serial] }))).serials[0], devices[2].serial);
  });

  test('a renewal pushes the co-term date out and keeps the counts', async () => {
    fresh();
    const l = sb.world.unclaimed.licenses[0];
    const before = await overview();
    assert.match(await errorOf(claim(corp, { licenses: [{ key: l.key, mode: 'renew' }, { key: 'Z2AA-BBBB-CCCC', mode: 'addDevices' }] })), /same mode/);
    assert.match(await errorOf(claim(corp, { licenses: [{ key: 'Z2AA-BBBB-CCCC' }] })), /not found/);
    await errorOf(claim(corp, { licenses: [{ key: l.key, mode: 'later' }] }));
    assert.match(await errorOf(claim(corp, { licenses: [{ key: l.key }, { key: l.key }] })), /more than once/);
    assert.deepEqual(await ok(claim(corp, { licenses: [{ key: l.key, mode: 'renew' }] })), { orders: [], serials: [], licenses: [{ key: l.key, mode: 'renew' }] });
    const after = await overview();
    assert.equal(Date.parse(after.expirationDate.replace(' UTC', 'Z')) - Date.parse(before.expirationDate.replace(' UTC', 'Z')), 1095 * 86400e3);
    const row = (await ok(sb.get(C))).find((x) => x.key === l.key);
    assert.deepEqual([row.mode, row.claimedAt, row.duration], ['renew', '2026-09-29T18:30:00Z', 1095]);
    // Claiming the order now only brings its devices.
    assert.equal(sum(after.licensedDeviceCounts), sum(before.licensedDeviceCounts) + 4);
    await ok(claim(corp, { orders: [l.orderNumber] }));
    assert.equal((await ok(sb.get(C))).length, corp.networks.length + 2);
  });

  test('released devices go back to the unclaimed pool', async () => {
    fresh();
    const spare = lab.spares[0];
    const license = lab.licenses.find((l) => !l.deviceSerial);
    await ok(sb.put(`/organizations/${lab.id}/licenses/${license.id}`, { deviceSerial: spare.serial }));
    const R = `/organizations/${lab.id}/inventory/release`;
    assert.match(await errorOf(sb.post(R, { serials: [] })), /must not be empty/);
    assert.match(await errorOf(sb.post(R, { serials: [lab.devices[0].serial] })), /remove it from the network/);
    assert.match(await errorOf(sb.post(R, { serials: [corp.spares[0].serial] })), /not in this organization/);
    assert.deepEqual(await ok(sb.post(R, { serials: [spare.serial.toLowerCase()] })), { serials: [spare.serial] });
    assert.equal((await inventory(lab, `?serials[]=${spare.serial}`)).length, 0);
    assert.equal((await ok(sb.get(`/organizations/${lab.id}/licenses/${license.id}`))).deviceSerial, null);

    // Anyone can claim it back, by serial or by its order.
    await ok(claim(corp, { orders: [spare.orderNumber] }));
    const [row] = await inventory(corp, `?serials[]=${spare.serial}`);
    assert.deepEqual([row.orderNumber, row.claimedAt.slice(0, 19)], [spare.orderNumber, '2026-09-29T18:30:00']);
  });

  test('moving counts leaves a remainder and invalidates the license', async () => {
    fresh();
    const M = `${C}/move`;
    const org = (await sb.post('/organizations', { name: 'Acme Spinoff' })).body;
    const l = corp.cotermLicenses[0];
    const move = (licenses, destination = { organizationId: org.id }) => sb.post(M, { destination, licenses });
    const mr = l.counts.find((c) => c.model === 'MR Enterprise');
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: 1 }] }], {})), /organizationId/);
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: 1 }] }], { organizationId: corp.id })), /different organization/);
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: 1 }] }], { organizationId: lab.id })), /co-term/);
    assert.match(await errorOf(move([{ key: 'Z2AA-BBBB-CCCC', counts: [{ model: 'MR Enterprise', count: 1 }] }])), /not an active license/);
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MS999', count: 1 }] }])), /no MS999 counts/);
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: mr.count + 1 }] }])), /between 1 and/);
    assert.match(await errorOf(sb.post(`/organizations/${lab.id}/licensing/coterm/licenses/move`, { destination: { organizationId: org.id }, licenses: [] })), /co-term/);

    const r = await ok(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: 2 }] }], { organizationId: org.id, mode: 'addDevices' }));
    const [rest] = r.remainderLicenses;
    const [moved] = r.movedLicenses;
    assert.deepEqual(rest.counts, l.counts.map((c) => (c.model === 'MR Enterprise' ? { ...c, count: c.count - 2 } : c)));
    assert.deepEqual([moved.organizationId, moved.counts, moved.mode, moved.claimedAt], [org.id, [{ model: 'MR Enterprise', count: 2 }], 'addDevices', '2026-09-29T18:30:00Z']);
    assert.deepEqual(moved.editions, [{ edition: 'Enterprise', productType: 'wireless' }]);
    assert.notEqual(rest.key, l.key);
    assert.equal(rest.startedAt, moved.startedAt);
    const [old] = await ok(sb.get(`${C}?invalidated=true`));
    assert.deepEqual([old.key, old.invalidatedAt], [l.key, '2026-09-29T18:30:00Z']);
    assert.match(await errorOf(move([{ key: l.key, counts: [{ model: 'MR Enterprise', count: 1 }] }])), /not an active license/);

    // The counts left behind no longer cover every AP.
    const o = await overview();
    assert.deepEqual([o.status, o.licensedDeviceCounts.MR], ['License Required', corp.devices.concat(corp.spares).filter((d) => d.productType === 'wireless').length - 2]);
    assert.deepEqual((await overview(org)).licensedDeviceCounts, { MR: 2 });
    assert.deepEqual((await ok(sb.get(`/organizations/${org.id}/licensing/coterm/licenses`))).map((x) => x.key), [moved.key]);

    // Moving all of a license's counts leaves no remainder.
    const all = await ok(sb.post(`/organizations/${org.id}/licensing/coterm/licenses/move`, { destination: { organizationId: corp.id }, licenses: [{ key: moved.key, counts: moved.counts }] }));
    assert.deepEqual([all.remainderLicenses.length, all.movedLicenses[0].organizationId], [0, corp.id]);
    assert.equal((await overview()).status, 'OK');
  });
});
