import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, start } from './helpers.js';

describe('cellular data profiles', () => {
  let sb;
  let corp;
  let B;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp] = sb.world.orgs;
    B = `/organizations/${corp.id}/devices/cellular`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const rule = (slot, priority, term = { resets: 'monthly', starts: { dayOfMonth: 1 } }) => ({ slot, uplink: { priority, isPreferred: priority === 1 }, cap: { value: 5000, threshold: 0.9, term }, actions: [{ type: 'failover' }] });
  const EMPTY = { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } };

  test('no device in the catalog is cellular, so the device reads are empty', async () => {
    fresh();
    for (const p of ['data/devices', 'data/usage/byDevice', 'geolocations', 'uplinks/bands/byDevice', 'uplinks/towers/byDevice', 'data/profiles/assignments']) {
      assert.deepEqual((await sb.get(`${B}/${p}`)).body, EMPTY, p);
    }
    const serial = corp.devices[0].serial;
    assert.deepEqual((await sb.get(`${B}/data/usage/history/byDevice/byInterval?serials[]=${serial}&interval=300&timespan=86400`)).body, EMPTY);
    assert.match(await errorOf(sb.get(`${B}/data/usage/history/byDevice/byInterval`)), /serials/);
    assert.match(await errorOf(sb.get(`${B}/data/usage/history/byDevice/byInterval?serials[]=${serial}&interval=60`)), /interval/);
    assert.match(await errorOf(sb.get(`${B}/data/usage/history/byDevice/byInterval?serials[]=${serial}&timespan=5000000`)), /timespan/);
    assert.match(await errorOf(sb.get(`${B}/data/devices?slots[]=sim9`)), /slots/);
  });

  test('profiles are created, listed, replaced and deleted', async () => {
    fresh();
    const P = `${B}/data/profiles`;
    const daily = rule('sim2', 2, { resets: 'daily', starts: { hourOfDay: 0 } });
    const r = await sb.post(P, { name: 'Fleet', description: 'Fleet SIMs', rules: [rule('sim1', 1), daily] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body;
    assert.deepEqual([p.name, p.description, p.lastUpdatedAt, p.rules.length], ['Fleet', 'Fleet SIMs', NOW, 2]);
    assert.deepEqual(p.rules[1].cap.term, { resets: 'daily', starts: { hourOfDay: 0 } });
    assert.notEqual(p.rules[0].ruleId, p.rules[1].ruleId);
    assert.match(await errorOf(sb.post(P, { name: 'Fleet', description: '', rules: [rule('sim1', 1)] })), /taken/);
    assert.match(await errorOf(sb.post(P, { name: 'Two', description: '', rules: [rule('sim1', 1), rule('sim1', 2)] })), /different SIM slots/);
    assert.match(await errorOf(sb.post(P, { name: 'Two', description: '', rules: [rule('sim1', 1), rule('sim2', 1)] })), /different uplink priorities/);
    assert.match(await errorOf(sb.post(P, { name: 'Two', description: '', rules: [rule('sim1', 1, { resets: 'weekly', starts: { dayOfMonth: 3 } })] })), /dayOfWeek/);
    assert.match(await errorOf(sb.post(P, { name: 'Two', description: '', rules: [] })), /one or two rules/);

    const list = (await sb.get(P)).body;
    assert.deepEqual(list.items.map((x) => [x.profileId, x.counts.devices.assigned]), [[p.profileId, 0]]);
    const up = await sb.put(`${P}/${p.profileId}`, { description: 'Just one', rules: [rule('esim', 1)] });
    assert.deepEqual([up.body.description, up.body.rules.map((x) => x.slot)], ['Just one', ['esim']]);
    assert.match(await errorOf(sb.put(`${P}/${p.profileId}`, { profileId: '1', rules: [rule('esim', 1)] })), /must match/);

    const item = { profile: { id: p.profileId }, device: { serial: corp.devices[0].serial } };
    assert.match(await errorOf(sb.post(`${P}/assignments/batchCreate`, { items: [item] })), /not a cellular device/);
    assert.match(await errorOf(sb.post(`${P}/assignments/batchCreate`, { items: [{ ...item, profile: { id: '1' } }] })), /not found/);
    assert.match(await errorOf(sb.post(`${P}/assignments/bulkDelete`, { items: [item] })), /not a cellular device/);
    assert.equal((await sb.del(`${P}/${p.profileId}`)).status, 204);
    await errorOf(sb.del(`${P}/${p.profileId}`), 404);
    assert.deepEqual((await sb.get(P)).body, EMPTY);
  });
});

describe('controller migrations', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('access points can be moved to a wireless controller', async () => {
    const [corp] = sb.world.orgs;
    const hq = corp.networks[0];
    const M = `/organizations/${corp.id}/devices/controller/migrations`;
    const aps = hq.aps.slice(0, 2).map((d) => d.serial);
    const r = await sb.post(M, { serials: aps, target: 'wirelessController' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body, aps.map((serial) => ({ serial, target: 'wirelessController', createdAt: NOW, migratedAt: null })));
    for (const [serials, re] of [[aps.slice(0, 1), /already migrating/], [[hq.switches[0].serial], /not an access point/], [[sb.world.orgs[1].devices[0].serial], /not in a network/]]) {
      const bad = await sb.post(M, { serials, target: 'wirelessController' });
      assert.equal(bad.status, 400);
      assert.match(bad.body.errors[0], re);
    }
    assert.equal((await sb.post(M, { serials: aps, target: 'cloud' })).status, 400);
    const list = (await sb.get(`${M}?networkIds[]=${hq.id}&perPage=3`)).body;
    assert.deepEqual(list.items.map((m) => m.serial), [...aps].sort());
    assert.deepEqual(list.meta.counts.items, { total: 2, remaining: 0 });
    assert.equal((await sb.get(`${M}?serials[]=${aps[0]}`)).body.items.length, 1);
    assert.equal((await sb.get(`${M}?networkIds[]=${corp.networks[1].id}`)).body.items.length, 0);
  });
});
