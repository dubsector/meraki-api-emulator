import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, collect, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';
const range = (a, b, interval, i = '') => `ranges[${i}]startTime=${at(a)}&ranges[${i}]endTime=${at(b)}&ranges[${i}]interval=${interval}`;
const sum = (rows, k) => rows.reduce((n, r) => n + r.results[k], 0);

describe('camera analytics, artifacts and onboarding', () => {
  let sb;
  let O;
  let cams;
  let H;
  before(async () => {
    sb = await start();
    O = `/organizations/${sb.world.orgs[0].id}`;
    H = `${O}/camera/detections/history/byBoundary/byInterval`;
    cams = sb.world.orgs[0].devices.filter((d) => d.productType === 'camera');
  });
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const boundaries = async (type) => (await sb.get(`${O}/camera/boundaries/${type}/byDevice`)).body;

  test('every camera has one area and one crossing line', async () => {
    const areas = await boundaries('areas');
    const lines = await boundaries('lines');
    assert.equal(areas.length, cams.length);
    assert.deepEqual(areas.map((a) => a.serial), lines.map((l) => l.serial));
    for (const a of areas) {
      assert.equal(a.boundaries.type, 'area');
      assert.equal(a.boundaries.vertices.length, 4);
      assert.equal(a.networkId, cams.find((d) => d.serial === a.serial).net.id);
    }
    for (const l of lines) {
      assert.equal(l.boundaries.type, 'line');
      assert.equal(l.boundaries.vertices.length, 2);
      assert.ok(l.boundaries.directionVertex.y > l.boundaries.vertices[0].y);
    }
    assert.equal(new Set([...areas, ...lines].map((x) => x.boundaries.id)).size, cams.length * 2);
    const one = (await sb.get(`${O}/camera/boundaries/lines/byDevice?serials[]=${lines[1].serial}`)).body;
    assert.deepEqual(one, [lines[1]]);
    assert.deepEqual((await sb.get(`${O}/camera/boundaries/areas/byDevice?networkIds[]=N_0`)).body, []);
  });

  test('detection counts add up across intervals and pages', async () => {
    const [area] = await boundaries('areas');
    const [line] = await boundaries('lines');
    const ids = `boundaryIds[]=${area.boundaries.id}&boundaryIds[]=${line.boundaries.id}`;
    const hourly = (await sb.get(`${H}?${ids}&${range(-3 * 3600, 0, 3600)}`)).body;
    assert.equal(hourly.length, 6);
    assert.deepEqual(hourly[0], { boundaryId: area.boundaries.id, type: 'area', results: { startTime: at(-3 * 3600), endTime: at(-2 * 3600), objectType: 'person', in: hourly[0].results.in, out: hourly[0].results.out } });
    const fine = await collect(sb.get, `${H}?${ids}&${range(-3 * 3600, 0, 900)}&perPage=1`);
    assert.equal(fine.length, 24);
    for (const id of [area.boundaries.id, line.boundaries.id]) {
      const a = hourly.filter((r) => r.boundaryId === id);
      const b = fine.filter((r) => r.boundaryId === id);
      assert.equal(sum(a, 'in'), sum(b, 'in'));
      assert.equal(sum(a, 'out'), sum(b, 'out'));
    }
    assert.ok(sum(hourly, 'in') > 0);
    // Minutes after now aren't counted yet.
    const ahead = (await sb.get(`${H}?boundaryIds[]=${area.boundaries.id}&${range(0, 3600, 3600)}`)).body;
    assert.equal(ahead[0].results.in + ahead[0].results.out, 0);
  });

  test('object types, minimum stay and two ranges', async () => {
    const [area] = await boundaries('areas');
    const [line] = await boundaries('lines');
    const both = (await sb.get(`${H}?boundaryIds[]=${area.boundaries.id}&${range(-7200, 0, 3600)}&boundaryTypes[]=vehicle&boundaryTypes[]=person`)).body;
    assert.deepEqual(both.map((r) => r.results.objectType), ['person', 'person', 'vehicle', 'vehicle']);
    const stay = async (id, d) => sum((await sb.get(`${H}?boundaryIds[]=${id}&${range(-7200, 0, 7200)}&duration=${d}`)).body, 'in');
    assert.ok((await stay(area.boundaries.id, 1200)) < (await stay(area.boundaries.id, 60)));
    assert.equal(await stay(line.boundaries.id, 1200), await stay(line.boundaries.id, 60));
    const two = (await sb.get(`${H}?boundaryIds[]=${line.boundaries.id}&${range(-7200, -3600, 3600, 0)}&${range(-1800, 0, 600, 1)}`)).body;
    assert.deepEqual(two.map((r) => r.results.startTime), [at(-7200), at(-1800), at(-1200), at(-600)]);
    assert.deepEqual((await sb.get(`${H}?boundaryIds[]=nope&${range(-3600, 0, 600)}`)).body, []);
  });

  test('a dormant camera counts nothing', async () => {
    const dev = cams.find((d) => d.dormant);
    const [area] = (await sb.get(`${O}/camera/boundaries/areas/byDevice?serials[]=${dev.serial}`)).body;
    const rows = (await sb.get(`${H}?boundaryIds[]=${area.boundaries.id}&${range(-86400, 0, 3600)}`)).body;
    assert.equal(rows.length, 24);
    assert.equal(sum(rows, 'in') + sum(rows, 'out'), 0);
  });

  test('detection history refuses bad queries', async () => {
    const id = (await boundaries('areas'))[0].boundaries.id;
    const ok = range(-3600, 0, 600);
    assert.match(await errorOf(sb.get(`${H}?${ok}`)), /'boundaryIds' is required/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}`)), /'ranges' is required/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&ranges[]startTime=${at(-60)}&ranges[]interval=60`)), /'ranges\[0\].endTime' is required/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${range(-3600, 0, 30)}`)), /at least 60/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${range(0, -3600, 60)}`)), /must be after/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${range(-40 * 86400, 0, 86400)}`)), /31 days/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${range(-2 * 86400, 0, 60)}`)), /at most 1440 intervals/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&ranges[]startTime=soon&ranges[]endTime=${at(0)}&ranges[]interval=60`)), /must be a time/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${ok}&boundaryTypes[]=cat`)), /person or vehicle/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${ok}&duration=-5`)), /'duration'/);
    assert.match(await errorOf(sb.get(`${H}?boundaryIds[]=${id}&${ok}&perPage=1001`)), /'perPage'/);
  });

  test('custom analytics artifacts', async () => {
    const A = `${O}/camera/customAnalytics/artifacts`;
    const made = await sb.post(A, { name: 'ppe' });
    assert.equal(made.status, 201);
    assert.equal(made.body.artifactId, '1');
    assert.deepEqual(made.body.status, { type: 'ready', message: 'Artifact is ready' });
    assert.match(made.body.uploadId, /^[0-9a-f]{32}$/);
    assert.equal(made.body.uploadUrl, `https://custom-analytics-upload.example.com/${made.body.uploadId}`);
    assert.equal(made.body.uploadUrlExpiry, '2026-09-29T19:30:00.000000+00:00');
    assert.equal((await sb.post(A, { name: 'count' })).body.artifactId, '2');
    const { uploadId, uploadUrl, uploadUrlExpiry, ...plain } = made.body;
    assert.deepEqual((await sb.get(`${A}/1`)).body, plain);
    assert.deepEqual((await sb.get(A)).body.map((x) => x.name), ['ppe', 'count']);
    assert.match(await errorOf(sb.post(A, { name: 'ppe' })), /already exists/);
    assert.match(await errorOf(sb.post(A, {})), /'name' is required/);
    assert.equal((await sb.del(`${A}/2`)).status, 204);
    assert.equal((await sb.get(`${A}/2`)).status, 404);
    assert.equal((await sb.post(A, { name: 'count' })).body.artifactId, '3');
  });

  test('per-camera custom analytics name an artifact', async () => {
    const A = `${O}/camera/customAnalytics/artifacts`;
    const D = `/devices/${cams[0].serial}/camera/customAnalytics`;
    assert.deepEqual((await sb.get(D)).body, { enabled: false, artifactId: null, parameters: [] });
    assert.match(await errorOf(sb.put(D, { enabled: true })), /'artifactId' is required/);
    assert.match(await errorOf(sb.put(D, { artifactId: '1' })), /must name a custom analytics artifact/);
    await sb.post(A, { name: 'ppe' });
    const set = await sb.put(D, { enabled: true, artifactId: '1', parameters: [{ name: 'detection_threshold', value: '0.5' }] });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body, { enabled: true, artifactId: '1', parameters: [{ name: 'detection_threshold', value: 0.5 }] });
    assert.deepEqual((await sb.get(D)).body, set.body);
    assert.match(await errorOf(sb.put(D, { parameters: [{ name: 'x', value: 'high' }] })), /must be a number/);
    assert.match(await errorOf(sb.put(D, { parameters: [{ name: 'x', value: '1' }, { name: 'x', value: '2' }] })), /unique/);
    assert.match(await errorOf(sb.put(D, { artifactId: null })), /'artifactId' is required/);
    assert.match(await errorOf(sb.del(`${A}/1`)), new RegExp(`used by camera ${cams[0].serial}`));
    // The camera's network can't leave the organization holding the artifact.
    const dest = (await sb.post('/organizations', { name: 'Acme West' })).body;
    const move = { network: { id: cams[0].net.id }, organizations: { target: { id: dest.id } } };
    assert.match((await sb.post(`${O}/networks/moves`, move)).body.result.reason, /custom analytics artifacts/);
    assert.deepEqual((await sb.put(D, { enabled: false, artifactId: null })).body, { enabled: false, artifactId: null, parameters: [{ name: 'detection_threshold', value: 0.5 }] });
    assert.equal((await sb.del(`${A}/1`)).status, 204);
    assert.equal((await sb.post(`${O}/networks/moves`, move)).body.result.status, 'completed');
    const sw = sb.world.devices.find((d) => d.productType === 'switch');
    assert.equal((await sb.put(`/devices/${sw.serial}/camera/customAnalytics`, {})).status, 400);
  });

  test('onboarding statuses', async () => {
    const S = `${O}/camera/onboarding/statuses`;
    const all = (await sb.get(S)).body;
    assert.equal(all.length, cams.length);
    assert.ok(all.every((x) => x.status === 'complete'));
    const net = cams[0].net.id;
    assert.deepEqual((await sb.get(`${S}?networkIds[]=${net}`)).body.map((x) => x.serial), all.filter((x) => x.networkId === net).map((x) => x.serial));
    assert.deepEqual((await sb.put(S, { serial: cams[0].serial, wirelessCredentialsSent: false })).body, { success: true });
    assert.deepEqual((await sb.get(`${S}?serials[]=${cams[0].serial}`)).body, [{ networkId: net, serial: cams[0].serial, status: 'pending onboarding', updatedAt: '2026-09-29T18:30:00.000000Z' }]);
    // A camera swapped in starts onboarded, as of its own claim.
    const spare = sb.world.orgs[0].spares.find((d) => d.productType === 'camera');
    assert.equal((await sb.post(`${O}/inventory/devices/swaps/bulk`, { swaps: [{ devices: { old: cams[0].serial, new: spare.serial }, afterAction: 'remove from network' }] })).status, 207);
    const swapped = (await sb.get(`${S}?serials[]=${spare.serial}`)).body[0];
    assert.deepEqual([swapped.status, swapped.updatedAt], ['complete', new Date(spare.claimedAt * 1000).toISOString().replace('Z', '000Z')]);
    await sb.put(S, { serial: cams[1].serial, wirelessCredentialsSent: false });
    await sb.put(S, { serial: cams[1].serial, wirelessCredentialsSent: true });
    assert.equal((await sb.get(`${S}?serials[]=${cams[1].serial}`)).body[0].status, 'complete');
    assert.match(await errorOf(sb.put(S, { wirelessCredentialsSent: true })), /'serial' is required/);
    assert.match(await errorOf(sb.put(S, { serial: cams[0].serial })), /'wirelessCredentialsSent' is required/);
    const sw = sb.world.devices.find((d) => d.productType === 'switch');
    assert.match(await errorOf(sb.put(S, { serial: sw.serial, wirelessCredentialsSent: true })), /must be a camera/);
  });
});

describe('custom analytics artifacts on a running clock', () => {
  test('an artifact waits for its upload, then is checked', async () => {
    const sb = await start({ now: null });
    try {
      const made = await sb.post(`/organizations/${sb.world.orgs[0].id}/camera/customAnalytics/artifacts`, { name: 'ppe' });
      assert.equal(made.status, 201);
      assert.deepEqual(made.body.status, { type: 'pending', message: 'Waiting for the artifact upload' });
    } finally {
      sb.close();
    }
  });
});
