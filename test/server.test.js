import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { AUTH_ERROR } from '../src/server.js';
import { NOW, collect, relLink, sampleUrls, start } from './helpers.js';

// Sends a path exactly as given; fetch would normalize or reject it first.
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers: { 'X-Cisco-Meraki-API-Key': 'k' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('every route answers 200 with sample IDs', async () => {
    for (const url of sampleUrls(sb.world)) {
      const r = await sb.get(url);
      assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
      assert.match(r.headers.get('content-type'), /^application\/json/);
    }
  });

  test('missing key gets the real 401 body', async () => {
    const r = await sb.get('/organizations', { key: null });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { errors: [AUTH_ERROR] });
  });

  test('bearer auth is accepted', async () => {
    const r = await sb.get('/organizations', { key: null, headers: { Authorization: 'Bearer abc' } });
    assert.equal(r.status, 200);
  });

  test('unknown IDs are 404 and writes are 405', async () => {
    assert.equal((await sb.get('/networks/L_000/clients')).status, 404);
    assert.equal((await sb.get('/devices/Q2XX-0000-0000')).status, 404);
    assert.equal((await sb.get('/nope')).status, 404);
    assert.equal((await sb.get('/organizations', { method: 'POST' })).status, 405);
  });

  test('malformed URLs are a 400, not a crash', async () => {
    assert.equal(await rawGet(sb.base, '/api/v1/organizations/%ZZ'), 400);
    assert.equal(await rawGet(sb.base, '/api/v1/networks/%E0%A4%A/clients'), 400);
    assert.equal(await rawGet(sb.base, '//['), 400);
  });

  test('HEAD sends headers only and OPTIONS answers the CORS preflight', async () => {
    const head = await fetch(`${sb.base}/organizations`, { method: 'HEAD', headers: { 'X-Cisco-Meraki-API-Key': 'k' } });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers.get('content-length')) > 0);
    assert.equal(await head.text(), '');
    const pre = await fetch(`${sb.base}/organizations`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /X-Cisco-Meraki-API-Key/);
  });

  test('landing page and health check', async () => {
    const page = await fetch(sb.base.replace('/api/v1', '/'));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Meraki API Emulator/);
    const health = await sb.get(sb.base.replace('/api/v1', '/healthz'), { key: null });
    assert.deepEqual(health.body, { status: 'ok' });
  });

  test('Link headers use unquoted rel values and paging covers every item once', async () => {
    const org = sb.world.orgs[0];
    const first = await sb.get(`/organizations/${org.id}/devices?perPage=5`);
    assert.match(first.link, /<[^>]+>; rel=first, <[^>]+>; rel=next, <[^>]+>; rel=last/);
    assert.doesNotMatch(first.link, /rel="/);
    const all = await collect(sb.get, `/organizations/${org.id}/devices?perPage=5`);
    assert.equal(all.length, org.devices.length);
    assert.equal(new Set(all.map((d) => d.serial)).size, all.length);
  });

  test('last page has no next link', async () => {
    const org = sb.world.orgs[0];
    const r = await sb.get(`/organizations/${org.id}/devices?perPage=1000`);
    assert.equal(relLink(r.link, 'next'), null);
  });

  test('time windows are validated', async () => {
    const net = sb.world.orgs[0].networks[0];
    assert.equal((await sb.get(`/networks/${net.id}/wireless/connectionStats?timespan=${8 * 86400}`)).status, 400);
    assert.equal((await sb.get(`/networks/${net.id}/clients?t0=2020-01-01T00:00:00Z`)).status, 400);
    assert.equal((await sb.get(`/networks/${net.id}/wireless/clientCountHistory?resolution=7`)).status, 400);
    assert.equal((await sb.get(`/networks/${net.id}/clients?perPage=2`)).status, 400);
  });

  test('windows that start in the future are rejected', async () => {
    const net = sb.world.orgs[0].networks[0];
    const soon = Date.parse(NOW) / 1000 + 3600;
    for (const url of [
      `/devices/${net.mx.serial}/appliance/performance?t0=${soon}&t1=${soon + 3600}`,
      `/devices/${net.switches[0].serial}/switch/ports/statuses?t0=${soon}`,
      `/networks/${net.id}/clients/bandwidthUsageHistory?t0=${soon}`,
    ]) {
      const r = await sb.get(url);
      assert.equal(r.status, 400, url);
      assert.deepEqual(r.body, { errors: ["'t0' must be in the past"] });
    }
    // A t1 alone in the future just means now.
    assert.equal((await sb.get(`/networks/${net.id}/wireless/connectionStats?t1=${soon}`)).status, 200);
  });

  test('timespans below the spec minimum are rejected', async () => {
    const org = sb.world.orgs[0];
    const mx = org.networks[0].mx.serial;
    assert.equal((await sb.get(`/devices/${mx}/appliance/performance?timespan=600`)).status, 400);
    assert.equal((await sb.get(`/devices/${mx}/appliance/performance?timespan=1800`)).status, 200);
    assert.equal((await sb.get(`/organizations/${org.id}/summary/top/clients/byUsage?timespan=3600`)).status, 400);
    assert.equal((await sb.get(`/organizations/${org.id}/summary/top/devices/byUsage?timespan=3600`)).status, 400);
    assert.equal((await sb.get(`/organizations/${org.id}/summary/top/applications/byUsage?timespan=3600`)).status, 200);
  });

  test('uplink loss and latency ends two minutes before now', async () => {
    const r = await sb.get(`/organizations/${sb.world.orgs[0].id}/devices/uplinksLossAndLatency`);
    const last = r.body[0].timeSeries.at(-1).ts;
    assert.ok(Date.parse(last) <= Date.parse(NOW) - 120000, last);
  });

  test('events require productType on multi-product networks', async () => {
    const net = sb.world.orgs[0].networks[0];
    const r = await sb.get(`/networks/${net.id}/events`);
    assert.equal(r.status, 400);
    const wirelessOnly = sb.world.orgs[1].networks[0];
    assert.equal((await sb.get(`/networks/${wirelessOnly.id}/events`)).status, 200);
  });

  test('appliance endpoints reject networks and devices without an MX', async () => {
    const lab = sb.world.orgs[1].networks[0];
    assert.equal((await sb.get(`/networks/${lab.id}/appliance/security/events`)).status, 400);
    assert.equal((await sb.get(`/devices/${lab.aps[0].serial}/lossAndLatencyHistory?ip=8.8.8.8`)).status, 400);
  });
});

describe('options', () => {
  test('--api-key only accepts that key', async () => {
    const sb = await start({ apiKey: 'secret' });
    try {
      assert.equal((await sb.get('/organizations', { key: 'wrong' })).status, 401);
      assert.equal((await sb.get('/organizations', { key: 'secret' })).status, 200);
    } finally {
      await sb.close();
    }
  });

  test('rate limit answers 429 with Retry-After once the burst is spent', async () => {
    const sb = await start({ rateLimit: 1, burst: 3 });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await sb.get('/organizations')).status);
      assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
      const r = await sb.get('/organizations');
      assert.equal(r.status, 429);
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
      // Buckets are per key.
      assert.equal((await sb.get('/organizations', { key: 'other' })).status, 200);
    } finally {
      await sb.close();
    }
  });

  test('fault rate 1 turns every API call into a 5xx', async () => {
    const sb = await start({ faultRate: 1 });
    try {
      const r = await sb.get('/organizations');
      assert.ok(r.status >= 500 && r.status <= 503);
    } finally {
      await sb.close();
    }
  });

  test('bad options are rejected', async () => {
    await assert.rejects(start({ faultRate: 2 }));
    await assert.rejects(start({ now: 'yesterday' }));
  });
});
