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
    assert.equal((await sb.get(L)).body.length, 1);
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
