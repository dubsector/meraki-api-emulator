import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, start } from './helpers.js';

describe('packet captures', () => {
  let sb;
  let corp;
  let hq;
  let C;
  let S;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp] = sb.world.orgs;
    hq = corp.networks[0];
    C = `/organizations/${corp.id}/devices/packetCapture/captures`;
    S = `/organizations/${corp.id}/devices/packetCapture/schedules`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r, status = 201) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };

  test('a capture runs until it is stopped, then can be downloaded', async () => {
    fresh();
    const aps = hq.aps.slice(0, 2).map((d) => d.serial);
    const c = await ok(sb.post(C, { serials: aps, name: 'roaming', notes: 'lobby', filterExpression: '(icmp)' }));
    assert.match(c.captureId, /^\d{12}$/);
    assert.deepEqual([c.network.id, c.devices.map((d) => d.serial), c.device.serial, c.admin.id], [hq.id, aps, aps[0], sb.world.apiAdmin.id]);
    assert.deepEqual([c.status, c.startTs, c.duration, c.process, c.destination, c.interface, c.ports], ['capturing', NOW.replace('Z', '.000000Z'), 60, 'manual', 'upload_to_cloud', 'wireless', null]);
    assert.match(await errorOf(sb.post(`${C}/${c.captureId}/downloadUrl/generate`)), /still capturing/);
    assert.match(await errorOf(sb.post(`${C}/${c.captureId}/stop`, { serials: [hq.switches[0].serial] })), /not part of capture/);

    const stopped = await ok(sb.post(`${C}/${c.captureId}/stop`, { serials: aps }));
    assert.equal(stopped.status, 'completed');
    assert.match(await errorOf(sb.post(`${C}/${c.captureId}/stop`, { serials: aps })), /already finished/);
    const url = await ok(sb.post(`${C}/${c.captureId}/downloadUrl/generate`), 200);
    assert.deepEqual(url, { captureId: c.captureId, downloadUrl: url.url, url: url.url });
    assert.match(url.url, /^https:\/\/pcap\.example\.com\//);
    assert.equal((await sb.del(`${C}/${c.captureId}`)).status, 204);
    await errorOf(sb.del(`${C}/${c.captureId}`), 404);
  });

  test('one switch or appliance per capture, from one network, with real ports', async () => {
    fresh();
    const [core, second] = hq.switches;
    const sw = await ok(sb.post(C, { serials: [core.serial], name: 'core', ports: '1-3, 9' }));
    assert.deepEqual([sw.ports, sw.interface], ['1-3, 9', 'wired']);
    assert.match(await errorOf(sb.post(C, { serials: [core.serial, second.serial], name: 'x' })), /Only one switch/);
    assert.match(await errorOf(sb.post(C, { serials: [hq.aps[0].serial, corp.networks[1].aps[0].serial], name: 'x' })), /same network/);
    assert.match(await errorOf(sb.post(C, { serials: [hq.cameras[0].serial], name: 'x' })), /doesn't support/);
    assert.match(await errorOf(sb.post(C, { serials: [core.serial], name: 'x', ports: '999' })), /not a port/);
    assert.match(await errorOf(sb.post(C, { serials: [hq.aps[0].serial], name: 'x', ports: '1' })), /only apply to switches/);
    assert.match(await errorOf(sb.post(C, { serials: [core.serial], name: 'x', duration: 0 })), /duration/);
    assert.match(await errorOf(sb.post(C, { serials: [], name: 'x' })), /serials/);
    assert.match(await errorOf(sb.post(C, { serials: [sb.world.orgs[1].devices[0].serial], name: 'x' })), /not in a network/);
  });

  test('bulk captures make one capture per device, and the newest 10 are kept', async () => {
    fresh();
    const devices = [{ serial: hq.mx.serial, interface: 'wan2' }, { serial: hq.switches[1].serial, switchports: '4' }];
    const bulk = await ok(sb.post(`${C}/bulkCreate`, { name: 'bulk', devices }));
    assert.deepEqual(bulk.items.map((c) => [c.device.serial, c.interface, c.ports]), [[hq.mx.serial, 'wan2', null], [hq.switches[1].serial, 'wired', '4']]);
    for (let i = 0; i < 9; i++) await ok(sb.post(C, { serials: [hq.aps[i % hq.aps.length].serial], name: `ap ${i}` }));
    const all = (await sb.get(`${C}?perPage=100&sortOrder=ascending`)).body;
    assert.equal(all.meta.counts.items.total, 10);
    assert.deepEqual(all.items.map((c) => c.name), [bulk.items[1].name, ...Array.from({ length: 9 }, (_, i) => `ap ${i}`)]);
    const page = await sb.get(`${C}?perPage=3`);
    assert.deepEqual([page.body.items.length, page.body.meta.counts.items.remaining], [3, 7]);
    assert.equal((await sb.get(`${C}?serials[]=${hq.switches[1].serial}`)).body.items.length, 1);
    assert.equal((await sb.get(`${C}?captureStatus[]=completed`)).body.items.length, 0);
    const named = (await sb.get(`${C}?deviceName=${hq.aps[0].name.toLowerCase()}`)).body.items;
    assert.ok(named.length > 0 && named.every((c) => c.devices.some((d) => d.name === hq.aps[0].name)));
    await errorOf(sb.get(`${C}?sortOrder=sideways`));

    assert.match(await errorOf(sb.post(`${C}/bulkDelete`, { captureIds: [all.items[0].captureId, '1'] })), /not found/);
    assert.equal((await sb.post(`${C}/bulkDelete`, { captureIds: all.items.slice(0, 4).map((c) => c.captureId) })).status, 204);
    assert.equal((await sb.get(C)).body.meta.counts.items.total, 6);
  });

  test('schedules show their next run, conflicts and priority', async () => {
    fresh();
    const core = hq.switches[0].serial;
    const daily = await ok(sb.post(S, { devices: [{ serial: core, switchports: '1-3' }], name: 'nightly', duration: 300, schedule: { name: 'nights', startTs: '2026-09-01T02:00:00Z', frequency: 'day' } }));
    assert.deepEqual([daily.priority, daily.enabled, daily.captureCount, daily.lastCaptureId, daily.warnings], [1, true, 0, null, []]);
    assert.equal(daily.schedule.nextCaptureTs, '2026-09-30T02:00:00.000000Z');
    // NOW is a Tuesday, so the next Monday or Wednesday run is Wednesday, the same time as the daily one.
    const weekly = await ok(sb.post(S, { devices: [{ serial: core }], name: 'weekly', schedule: { startTs: '2026-09-01T02:00:00Z', frequency: 'week', weekdays: ['monday', 'Wednesday'] } }));
    assert.equal(weekly.schedule.nextCaptureTs, '2026-09-30T02:00:00.000000Z');
    assert.deepEqual(weekly.schedule.weekdays, ['Monday', 'Wednesday']);
    assert.match(weekly.warnings[0], /conflicts with the schedule nightly/);
    const monthly = await ok(sb.post(S, { devices: [{ serial: hq.aps[0].serial }], schedule: { startTs: '2026-09-15T02:00:00Z', frequency: 'month', recurrence: 2 } }));
    assert.equal(monthly.schedule.nextCaptureTs, '2026-11-15T02:00:00.000000Z');
    const ended = await ok(sb.post(S, { devices: [{ serial: core }], schedule: { startTs: '2026-09-01T02:00:00Z', endTs: '2026-09-10T00:00:00Z', frequency: 'hour' } }));
    assert.equal(ended.schedule.nextCaptureTs, null);
    assert.match(await errorOf(sb.post(S, { devices: [{ serial: core }], schedule: { frequency: 'fortnight' } })), /frequency/);
    assert.match(await errorOf(sb.post(S, { devices: [] })), /devices/);

    const off = await ok(sb.put(`${S}/${daily.scheduleId}`, { devices: [{ serial: core, switchports: '1-3' }], enabled: false }), 200);
    assert.deepEqual([off.enabled, off.schedule.nextCaptureTs, off.schedule.name], [false, null, 'nights']);
    const reorder = await ok(sb.post(`${S}/reorder`, { order: [{ scheduleId: monthly.scheduleId, priority: 1 }] }), 200);
    assert.deepEqual(reorder.updatedPriorities.map((p) => p.scheduleId), [monthly.scheduleId, daily.scheduleId, weekly.scheduleId, ended.scheduleId]);
    assert.match(await errorOf(sb.post(`${S}/reorder`, { order: [{ scheduleId: monthly.scheduleId, priority: 9 }] })), /priority/);
    const list = (await sb.get(`${S}?deviceIds[]=${core}`)).body;
    assert.deepEqual([list.items.map((s) => s.priority), list.meta.counts.items.total], [[2, 3, 4], 3]);

    assert.match(await errorOf(sb.del(`${S}/${weekly.scheduleId}`, { body: { scheduleId: daily.scheduleId } })), /must match/);
    assert.equal((await sb.del(`${S}/${weekly.scheduleId}`, { body: { scheduleId: weekly.scheduleId } })).status, 204);
    assert.equal((await sb.get(S)).body.items.length, 3);
  });
});

describe('packet captures on a running clock', () => {
  let sb;
  before(async () => (sb = await start({ now: null })));
  after(() => sb.close());

  test('a finished capture has packets and a file size', async () => {
    const [corp] = sb.world.orgs;
    const C = `/organizations/${corp.id}/devices/packetCapture/captures`;
    const c = (await sb.post(C, { serials: [corp.networks[0].aps[0].serial], name: 'short', duration: 1 })).body;
    await new Promise((r) => setTimeout(r, 1100));
    const done = (await sb.get(`${C}?captureIds[]=${c.captureId}`)).body.items[0];
    assert.equal(done.status, 'completed');
    assert.ok(done.counts.packets.total > 0 && done.file.size > done.counts.packets.total);
  });
});
