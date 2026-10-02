import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { start } from './helpers.js';

// A blank grayscale PNG of the given size.
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((w + 1) * h))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// Metres between two points, east and north, on the same flat grid the emulator uses.
const metres = (a, b) => [(b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111320];
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);
const nearPoint = (a, b) => {
  near(a.lat, b.lat);
  near(a.lng, b.lng);
};

describe('floor plans', () => {
  let sb;
  let hq;
  let L;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    hq = sb.world.orgs[0].networks[0];
    L = `/networks/${hq.id}/floorPlans`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const CENTER = { lat: 37.7749, lng: -122.4194 };
  const makePlan = async (extra = {}) => {
    const r = await sb.post(L, { name: 'HQ 2F', center: CENTER, imageContents: png(400, 300), ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  test('networks start with no floor plans', async () => {
    fresh();
    assert.deepEqual((await sb.get(L)).body, []);
    assert.equal((await sb.get(`${L}/g_578149602163689000`)).status, 404);
  });

  test('a plan placed by its center is 100 m wide with no rotation', async () => {
    fresh();
    const p = await makePlan({ floorNumber: 2 });
    assert.match(p.floorPlanId, /^g_\d{18}$/);
    assert.deepEqual(Object.keys(p), ['floorPlanId', 'imageUrl', 'imageUrlExpiresAt', 'imageExtension', 'imageMd5', 'name', 'devices', 'width', 'height', 'center', 'bottomLeftCorner', 'bottomRightCorner', 'topLeftCorner', 'topRightCorner', 'floorNumber']);
    assert.equal(p.imageMd5, createHash('md5').update(Buffer.from(png(400, 300), 'base64')).digest('hex'));
    assert.equal(p.imageExtension, 'png');
    assert.equal(p.imageUrlExpiresAt, '2026-09-29 19:00:00 +00:00');
    assert.deepEqual([p.name, p.floorNumber, p.devices, p.width, p.height], ['HQ 2F', 2, [], 100, 75]);
    assert.deepEqual(p.center, CENTER);
    near(p.topLeftCorner.lng, p.bottomLeftCorner.lng);
    near(p.topLeftCorner.lat, p.topRightCorner.lat);
    const [w, h] = metres(p.bottomLeftCorner, p.topRightCorner);
    near(w, 100, 1e-3);
    near(h, 75, 1e-3);

    assert.deepEqual((await sb.get(`${L}/${p.floorPlanId}`)).body, p);
    assert.deepEqual((await sb.get(L)).body, [p]);
    // The same calls give the same ID after a reset.
    await sb.reset();
    fresh();
    assert.equal((await makePlan()).floorPlanId, p.floorPlanId);
  });

  test('two adjacent corners line the plan up with them', async () => {
    fresh();
    // Top edge running north-east, 2:1 image.
    const tl = { lat: 37.775, lng: -122.42 };
    const tr = { lat: 37.7755, lng: -122.4194 };
    const p = (await sb.post(L, { name: 'Tilted', topLeftCorner: tl, topRightCorner: tr, imageContents: png(200, 100) })).body;
    nearPoint(p.topLeftCorner, tl);
    nearPoint(p.topRightCorner, tr);
    const top = metres(tl, tr);
    const left = metres(p.topLeftCorner, p.bottomLeftCorner);
    near(Math.hypot(...top), p.width, 0.01);
    near(Math.hypot(...left), p.width / 2, 0.01);
    near(top[0] * left[0] + top[1] * left[1], 0, 1e-6); // a right angle
    assert.ok(left[0] > 0 && left[1] < 0, 'the plan hangs below its top edge');

    // A left edge sets the height.
    const bl = { lat: 37.7745, lng: -122.42 };
    const q = (await sb.put(`${L}/${p.floorPlanId}`, { topLeftCorner: tl, bottomLeftCorner: bl })).body;
    assert.deepEqual([q.topLeftCorner, q.bottomLeftCorner], [tl, bl]);
    assert.deepEqual([q.height, q.width], [55.66, 111.32]);
    near(q.topRightCorner.lat, tl.lat);

    // With more corners, the top pair goes first, then bottom, left and right.
    const east = { lat: 37.775, lng: -122.419 };
    const r = (await sb.put(`${L}/${p.floorPlanId}`, { topLeftCorner: tl, topRightCorner: east, bottomLeftCorner: { lat: 1, lng: 1 } })).body;
    assert.deepEqual([r.topLeftCorner, r.topRightCorner], [tl, east]);
    near(r.bottomLeftCorner.lng, tl.lng);
  });

  test('bad placements and images are refused', async () => {
    fresh();
    const img = png(10, 10);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: img })), /'center' or two adjacent corners/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: img, topLeftCorner: CENTER, bottomRightCorner: { lat: 37.77, lng: -122.41 } })), /two adjacent corners/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: img, topLeftCorner: CENTER, topRightCorner: CENTER })), /No two points/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: img, center: { lat: 37.77 } })), /'center' needs both/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: img, center: { lat: 95, lng: 0 } })), /not a valid location/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: 'not base64!', center: CENTER })), /base 64/);
    assert.match(await errorOf(sb.post(L, { name: 'x', imageContents: Buffer.from('hello').toString('base64'), center: CENTER })), /PNG, GIF or JPG/);
    assert.match(await errorOf(sb.post(L, { name: ' ', imageContents: img, center: CENTER })), /'name' must not be empty/);
    assert.match(await errorOf(sb.post(L, { name: 'x', center: CENTER })), /'imageContents' is required/);
    assert.deepEqual((await sb.get(L)).body, []);
  });

  test('GIF and JPEG images keep their aspect ratio', async () => {
    fresh();
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([4, 0, 2, 0]), Buffer.alloc(8)]);
    // SOI, an APP0 segment, then a baseline frame header 300 wide and 100 high.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 100, 1, 44, 1, 1, 0x11, 0]);
    const g = await makePlan({ imageContents: gif.toString('base64') });
    const j = await makePlan({ imageContents: jpeg.toString('base64') });
    assert.deepEqual([g.width, g.height, g.imageExtension], [100, 50, 'png']);
    assert.deepEqual([j.width, j.height], [100, 33.33]);
  });

  test('updates rename, move and swap the image', async () => {
    fresh();
    const tl = { lat: 37.775, lng: -122.42 };
    const p = (await sb.post(L, { name: 'A', topLeftCorner: tl, topRightCorner: { lat: 37.7755, lng: -122.4194 }, imageContents: png(200, 100) })).body;
    const P = `${L}/${p.floorPlanId}`;
    const renamed = (await sb.put(P, { name: 'B', floorNumber: 3 })).body;
    assert.deepEqual({ ...renamed, name: p.name, floorNumber: p.floorNumber }, p);

    // A new image alone keeps the center and width and drops the rotation.
    const swapped = (await sb.put(P, { imageContents: png(100, 100) })).body;
    nearPoint(swapped.center, p.center);
    assert.equal(swapped.width, p.width);
    assert.equal(swapped.height, p.width);
    near(swapped.topLeftCorner.lat, swapped.topRightCorner.lat);
    assert.notEqual(swapped.imageMd5, p.imageMd5);

    const moved = (await sb.put(P, { center: CENTER })).body;
    assert.deepEqual(moved.center, CENTER);
    assert.equal(moved.width, swapped.width);
    assert.equal((await sb.put(`${L}/g_1`, { name: 'x' })).status, 404);
  });

  test('devices are assigned in batches and by device update', async () => {
    fresh();
    const p = await makePlan();
    const [ap1, ap2] = hq.aps;
    const sw = hq.switches[0];
    const B = `${L}/devices/batchUpdate`;
    const assign = (serial, id) => ({ serial, floorPlan: { id } });
    const r = await sb.post(B, { assignments: [assign(ap1.serial, p.floorPlanId), assign(sw.serial, p.floorPlanId)] });
    assert.deepEqual([r.status, r.body], [200, { success: true }]);
    const got = (await sb.get(`${L}/${p.floorPlanId}`)).body;
    assert.deepEqual(got.devices.map((d) => d.serial).sort(), [ap1.serial, sw.serial].sort());
    const { url, floorPlanId, beaconIdParams, ...listed } = (await sb.get(`/devices/${ap1.serial}`)).body;
    assert.deepEqual(got.devices.find((d) => d.serial === ap1.serial), listed);
    assert.equal(floorPlanId, p.floorPlanId);

    // One bad assignment and nothing changes.
    const other = sb.world.orgs[0].networks[1].aps[0];
    assert.match(await errorOf(sb.post(B, { assignments: [assign(ap2.serial, p.floorPlanId), assign(other.serial, p.floorPlanId)] })), /not in this network/);
    assert.match(await errorOf(sb.post(B, { assignments: [assign(ap2.serial, 'g_1')] })), /does not exist/);
    assert.match(await errorOf(sb.post(B, { assignments: Array(101).fill(assign(ap2.serial, null)) })), /at most 100/);
    assert.equal((await sb.get(`/devices/${ap2.serial}`)).body.floorPlanId, null);

    await sb.post(B, { assignments: [assign(ap1.serial, null)] });
    assert.equal((await sb.get(`/devices/${ap1.serial}`)).body.floorPlanId, null);
    assert.match(await errorOf(sb.put(`/devices/${ap2.serial}`, { floorPlanId: 'g_1' })), /does not exist/);
    assert.equal((await sb.put(`/devices/${ap2.serial}`, { floorPlanId: p.floorPlanId })).body.floorPlanId, p.floorPlanId);
    assert.equal((await sb.put(`/devices/${ap2.serial}`, { floorPlanId: null })).body.floorPlanId, null);
  });

  test('deleting a plan takes its devices off it', async () => {
    fresh();
    const p = await makePlan();
    const ap = hq.aps[0];
    await sb.post(`${L}/devices/batchUpdate`, { assignments: [{ serial: ap.serial, floorPlan: { id: p.floorPlanId } }] });
    assert.equal((await sb.del(`${L}/${p.floorPlanId}`)).status, 204);
    assert.equal((await sb.get(`${L}/${p.floorPlanId}`)).status, 404);
    assert.equal((await sb.get(`/devices/${ap.serial}`)).body.floorPlanId, null);
  });

  describe('auto locate jobs', () => {
    const J = () => `${L}/autoLocate/jobs`;
    // Plans with the given number of HQ APs on each.
    const plans = async (...counts) => {
      const out = [];
      let next = 0;
      for (const n of counts) {
        const p = await makePlan();
        const aps = hq.aps.slice(next, (next += n));
        await sb.post(`${L}/devices/batchUpdate`, { assignments: aps.map((d) => ({ serial: d.serial, floorPlan: { id: p.floorPlanId } })) });
        out.push({ ...p, aps });
      }
      return out;
    };
    const schedule = async (...jobs) => {
      const r = await sb.post(`${J()}/batch`, { jobs });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.jobs;
    };
    const step = (status, percentage) => ({ status, completed: { percentage } });

    test('status and progress come from the clock', async () => {
      fresh();
      const [a, b, c, d] = await plans(3, 2, 2, 1);
      const refresh = ['ranging', 'gnss'];
      const [done, later, running, lonely] = await schedule(
        { floorPlanId: a.floorPlanId, refresh, scheduledAt: '2026-09-29T18:00:00Z' },
        { floorPlanId: b.floorPlanId, scheduledAt: '2026-09-30T00:00:00Z' },
        { floorPlanId: c.floorPlanId, refresh, scheduledAt: '2026-09-29T18:26:00Z' },
        { floorPlanId: d.floorPlanId, refresh: [], scheduledAt: '2026-09-29T18:00:00Z' },
      );
      assert.match(done.id, /^\d{18}$/);
      assert.deepEqual(done, { id: done.id, networkId: hq.id, floorPlanId: a.floorPlanId, status: 'finished', scheduledAt: '2026-09-29T18:00:00Z', completed: { percentage: 100 }, ranging: step('finished', 100), gnss: step('finished', 100), errors: [] });
      assert.deepEqual([later.status, later.completed, later.ranging, later.gnss], ['scheduled', { percentage: 0 }, step('scheduled', 0), step('not applicable', 0)]);
      // Four minutes into a ten minute run.
      assert.deepEqual([running.status, running.completed, running.ranging, running.gnss], ['in progress', { percentage: 40 }, step('in progress', 50), step('in progress', 80)]);
      assert.deepEqual([lonely.status, lonely.ranging, lonely.errors], ['error', step('no neighbors', 0), [{ source: 'ranging', type: 'no neighbors' }]]);
    });

    test('bad jobs are refused', async () => {
      fresh();
      const [a] = await plans(2);
      await schedule({ floorPlanId: a.floorPlanId, scheduledAt: '2026-10-01T00:00:00Z' });
      assert.match(await errorOf(sb.post(`${J()}/batch`, { jobs: [{ floorPlanId: a.floorPlanId }] })), /already has an auto locate job/);
      assert.match(await errorOf(sb.post(`${J()}/batch`, { jobs: [{ floorPlanId: 'g_1' }] })), /does not exist/);
      const [b] = await plans(0);
      assert.match(await errorOf(sb.post(`${J()}/batch`, { jobs: [{ floorPlanId: b.floorPlanId, refresh: ['gnss'] }] })), /both 'gnss' and 'ranging'/);
      assert.match(await errorOf(sb.post(`${J()}/batch`, { jobs: [{ floorPlanId: b.floorPlanId, scheduledAt: 'soon' }] })), /ISO8601/);
      assert.match(await errorOf(sb.post(`${J()}/batch`, { jobs: [{ floorPlanId: b.floorPlanId }, { floorPlanId: b.floorPlanId }] })), /already has/);
      assert.equal((await sb.post(`${J()}/123/cancel`)).status, 404);
    });

    test('cancel, publish and recalculate follow the job status', async () => {
      fresh();
      const [a, b, c] = await plans(3, 2, 2);
      const [done, later, running] = await schedule(
        { floorPlanId: a.floorPlanId, refresh: ['gnss', 'ranging'], scheduledAt: '2026-09-29T18:00:00Z' },
        { floorPlanId: b.floorPlanId, scheduledAt: '2026-10-01T00:00:00Z' },
        { floorPlanId: c.floorPlanId, refresh: ['gnss', 'ranging'], scheduledAt: '2026-09-29T18:26:00Z' },
      );
      const act = (job, what, body) => sb.post(`${J()}/${job.id}/${what}`, body);

      assert.equal((await act(later, 'cancel')).status, 204);
      assert.match(await errorOf(act(later, 'cancel')), /is canceled/);
      assert.match(await errorOf(act(later, 'recalculate')), /is canceled/);
      assert.match(await errorOf(act(done, 'cancel')), /is finished/);
      assert.match(await errorOf(act(running, 'publish')), /in progress; only a finished job/);

      // With no devices named, every AP moves to its calculated spot on the plan.
      const r = await act(done, 'publish');
      assert.deepEqual([r.status, r.body], [200, { success: true }]);
      const corners = [a.bottomLeftCorner, a.bottomRightCorner, a.topLeftCorner, a.topRightCorner];
      const lats = corners.map((p) => p.lat);
      const lngs = corners.map((p) => p.lng);
      for (const ap of a.aps) {
        const { lat, lng } = (await sb.get(`/devices/${ap.serial}`)).body;
        assert.ok(lat > Math.min(...lats) && lat < Math.max(...lats) && lng > Math.min(...lngs) && lng < Math.max(...lngs), `${ap.serial} is on the plan`);
        assert.notDeepEqual({ lat, lng }, CENTER);
      }
      assert.match(await errorOf(act(done, 'publish')), /is published/);

      // Recalculating saves anchors and runs again.
      assert.match(await errorOf(act(done, 'recalculate', { devices: [{ serial: hq.switches[0].serial, autoLocate: { isAnchor: true } }] })), /not an access point on floor plan/);
      assert.equal((await act(done, 'recalculate', { devices: [{ serial: a.aps[0].serial, autoLocate: { isAnchor: true, lat: 37.7749, lng: -122.4194 } }] })).status, 200);
      assert.equal(sb.world.deviceBySerial.get(a.aps[0].serial).autoLocate.isAnchor, true);
      assert.match(await errorOf(act(done, 'publish')), /in progress/);
      assert.match(await errorOf(act(done, 'recalculate')), /in progress/);
    });

    test('publishing named devices moves only those', async () => {
      fresh();
      const [a] = await plans(2);
      const [job] = await schedule({ floorPlanId: a.floorPlanId, refresh: ['gnss', 'ranging'], scheduledAt: '2026-09-29T17:00:00Z' });
      const [ap1, ap2] = a.aps;
      const before = (await sb.get(`/devices/${ap2.serial}`)).body;
      assert.match(await errorOf(sb.post(`${J()}/${job.id}/publish`, { devices: [{ serial: hq.aps[5].serial, lat: 1, lng: 1 }] })), /not an access point/);
      const r = await sb.post(`${J()}/${job.id}/publish`, { devices: [{ serial: ap1.serial, lat: 37.775, lng: -122.4195, autoLocate: { isAnchor: true } }] });
      assert.equal(r.status, 200);
      const moved = (await sb.get(`/devices/${ap1.serial}`)).body;
      assert.deepEqual([moved.lat, moved.lng], [37.775, -122.4195]);
      assert.deepEqual((await sb.get(`/devices/${ap2.serial}`)).body, before);
    });

    test('jobs go with their plan', async () => {
      fresh();
      const [a] = await plans(2);
      const [job] = await schedule({ floorPlanId: a.floorPlanId, scheduledAt: '2026-10-01T00:00:00Z' });
      await sb.del(`${L}/${a.floorPlanId}`);
      assert.equal((await sb.post(`${J()}/${job.id}/cancel`)).status, 404);
    });
  });
});
