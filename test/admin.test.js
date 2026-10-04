import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('api request log', () => {
  let sb;
  let org;
  before(async () => {
    sb = await start();
    org = sb.world.orgs[0];
  });
  after(() => sb.close());

  const agent = { 'User-Agent': 'log-test/1.0' };

  test('records each call with its operation, query and status', async () => {
    const net = org.networks[0];
    await sb.get(`/organizations/${org.id}/devices?perPage=5`, { headers: agent });
    await sb.get(`/networks/${net.id}/events`, { headers: agent });
    await sb.get(`/organizations/${org.id}/nope`, { headers: agent });
    const r = await sb.get(`/organizations/${org.id}/apiRequests?userAgent=log-test/1.0`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.map((e) => [e.operationId, e.responseCode, e.queryString]),
      [
        [null, 404, ''],
        ['getNetworkEvents', 400, ''],
        ['getOrganizationDevices', 200, 'perPage=5'],
      ],
    );
    const admins = (await sb.get(`/organizations/${org.id}/admins`)).body;
    const apiAdmin = admins.find((a) => a.id === r.body[0].adminId);
    assert.equal(apiAdmin.email, 'api@example.com');
    assert.equal(r.body[0].method, 'GET');
    assert.equal(r.body[0].version, 1);
    // Each key gets its own client ID, which never contains the key.
    assert.equal(r.body[0].client.type, 'api_key');
    assert.ok(!r.body[0].client.id.includes('test-key'));
    await sb.get(`/organizations/${org.id}/devices`, { key: 'other-key', headers: agent });
    const [other] = (await sb.get(`/organizations/${org.id}/apiRequests?userAgent=log-test/1.0`)).body;
    assert.notEqual(other.client.id, r.body[0].client.id);
  });

  test('calls on another organization stay out of the log', async () => {
    const lab = sb.world.orgs[1];
    await sb.get(`/networks/${lab.networks[0].id}/wireless/ssids`, { headers: { 'User-Agent': 'lab-only' } });
    assert.equal((await sb.get(`/organizations/${org.id}/apiRequests?userAgent=lab-only`)).body.length, 0);
    assert.equal((await sb.get(`/organizations/${lab.id}/apiRequests?userAgent=lab-only`)).body.length, 1);
  });

  test('the overview and interval counts add up to the log', async () => {
    const all = await collect(sb.get, `/organizations/${org.id}/apiRequests?perPage=3`);
    const overview = (await sb.get(`/organizations/${org.id}/apiRequests/overview`)).body.responseCodeCounts;
    // The calls above were logged before these two were answered.
    const total = Object.values(overview).reduce((a, b) => a + b, 0);
    assert.ok(total >= all.length, `${total} >= ${all.length}`);
    assert.equal(overview['404'], all.filter((e) => e.responseCode === 404).length);
    const buckets = (await sb.get(`/organizations/${org.id}/apiRequests/overview/responseCodes/byInterval?timespan=7200`)).body;
    assert.equal(buckets[0].endTs.slice(0, 19), buckets[1].startTs.slice(0, 19));
    const counted = buckets.flatMap((b) => b.counts).reduce((a, c) => a + c.count, 0);
    assert.ok(counted >= total);
  });
});

describe('licensing and inventory', () => {
  let sb;
  let corp;
  let lab;
  before(async () => {
    sb = await start();
    [corp, lab] = sb.world.orgs;
  });
  after(() => sb.close());

  test('the corporation is co-term and the lab licenses per device', async () => {
    const orgs = (await sb.get('/organizations')).body;
    assert.equal(orgs.find((o) => o.id === corp.id).licensing.model, 'co-term');
    assert.equal(orgs.find((o) => o.id === lab.id).licensing.model, 'per-device');
    const coterm = (await sb.get(`/organizations/${corp.id}/licenses/overview`)).body;
    assert.equal(coterm.status, 'OK');
    assert.match(coterm.expirationDate, /^[A-Z][a-z]{2} \d{1,2}, \d{4} UTC$/);
    assert.equal(Object.values(coterm.licensedDeviceCounts).reduce((a, b) => a + b, 0), corp.devices.length + corp.spares.length);
    assert.equal((await sb.get(`/organizations/${corp.id}/licenses`)).status, 400);
  });

  test('per-device license states agree with the overview', async () => {
    const licenses = (await sb.get(`/organizations/${lab.id}/licenses`)).body;
    assert.deepEqual(licenses.map((l) => l.state).sort(), ['active', 'active', 'expiring', 'unused']);
    const overview = (await sb.get(`/organizations/${lab.id}/licenses/overview`)).body;
    assert.equal(overview.licenseCount, 4);
    assert.equal(overview.states.expiring.count, 1);
    assert.equal(overview.states.unused.count, 1);
    const ap = lab.devices[0];
    const inv = (await sb.get(`/organizations/${lab.id}/inventory/devices/${ap.serial}`)).body;
    assert.equal(inv.licenseExpirationDate.slice(0, 19), licenses.find((l) => l.deviceSerial === ap.serial).expirationDate.slice(0, 19));
  });

  test('inventory lists claimed devices and unassigned spares', async () => {
    const all = await collect(sb.get, `/organizations/${corp.id}/inventory/devices?perPage=5`);
    assert.equal(all.length, corp.devices.length + corp.spares.length);
    const spares = (await sb.get(`/organizations/${corp.id}/inventory/devices?usedState=unused`)).body;
    assert.deepEqual(spares.map((d) => d.networkId), [null, null, null]);
    assert.deepEqual((await sb.get(`/organizations/${corp.id}/inventory/devices?networkIds[]=null`)).body, spares);
    const byModel = (await sb.get(`/organizations/${corp.id}/devices/overview/byModel`)).body.counts;
    assert.equal(byModel.reduce((a, c) => a + c.total, 0), corp.devices.length);
  });

  test('change log entries are newest first and made by real admins', async () => {
    const admins = new Map((await sb.get(`/organizations/${corp.id}/admins`)).body.map((a) => [a.id, a]));
    const changes = (await sb.get(`/organizations/${corp.id}/configurationChanges?timespan=${30 * 86400}`)).body;
    assert.ok(changes.length > 10);
    assert.deepEqual(changes.map((c) => c.ts), changes.map((c) => c.ts).sort().reverse());
    for (const c of changes) {
      const a = admins.get(c.adminId);
      assert.ok(a && a.orgAccess !== 'read-only', c.adminId);
    }
    const net = corp.networks[2];
    const filtered = (await sb.get(`/organizations/${corp.id}/configurationChanges?timespan=${30 * 86400}&networkId=${net.id}`)).body;
    assert.deepEqual(filtered, changes.filter((c) => c.networkId === net.id));
  });
});
