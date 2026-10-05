import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { AUTH_ERROR, CONNECT_HINT, ROUTES, SDK_HINT, VERSION, apiKeyOf } from '../src/server.js';
import { NOW, collect, relLink, sampleUrls, start } from './helpers.js';

// Sends a request target exactly as given; fetch would normalize or reject it first.
function raw(base, path, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, headers: { 'X-Cisco-Meraki-API-Key': 'k', ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const rawGet = async (base, path) => (await raw(base, path)).status;

describe('server', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('every route answers 200 with sample IDs', async () => {
    for (const { url, status } of sampleUrls(sb.world)) {
      const r = await sb.get(url);
      assert.equal(r.status, status, `${url}: ${JSON.stringify(r.body)}`);
      assert.match(r.headers.get('content-type'), /^application\/json/);
    }
  });

  test('every path template is reached by its own paths', async () => {
    // IDs that name nothing, so a template with fewer parameters can't take them.
    const byPath = new Map();
    for (const r of ROUTES) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
    let i = 0;
    for (const [path, routes] of byPath) {
      const url = path.replace(/\{\w+\}/g, 'x0') + (i++ % 2 ? '/' : '');
      const r = await sb.get(url);
      const get = routes.find((x) => x.method === 'GET');
      if (get) assert.equal(sb.apiLog.items.at(-1).operationId, get.op, url);
      else assert.equal(r.headers.get('allow'), routes.map((x) => x.method).join(', '), url);
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

  test('bearer parsing takes linear time on hostile headers', () => {
    assert.equal(apiKeyOf({ authorization: '  bearer   abc  ' }), 'abc');
    assert.equal(apiKeyOf({ authorization: 'Bearer' }), null);
    // The old pattern backtracked quadratically here: about 1.4 s for 50,000 spaces.
    const started = performance.now();
    assert.equal(apiKeyOf({ authorization: `Bearer${' '.repeat(50000)}x\n` }), 'x');
    assert.equal(apiKeyOf({ authorization: `Bearer${' '.repeat(50000)}\n` }), null);
    assert.equal(apiKeyOf({ authorization: `Bearer${' '.repeat(50000)}a${' '.repeat(50000)}b` }), null);
    assert.ok(performance.now() - started < 200, `${Math.round(performance.now() - started)}ms`);
  });

  test('unknown IDs are 404 and writes are 405', async () => {
    assert.equal((await sb.get('/networks/L_000/clients')).status, 404);
    assert.equal((await sb.get('/devices/Q2XX-0000-0000')).status, 404);
    assert.equal((await sb.get('/nope')).status, 404);
    const r = await sb.get(`/organizations/${sb.world.orgs[0].id}/devices`, { method: 'POST' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
  });

  test('malformed URLs are a 400, not a crash', async () => {
    assert.equal(await rawGet(sb.base, '/api/v1/organizations/%ZZ'), 400);
    assert.equal(await rawGet(sb.base, '/api/v1/networks/%E0%A4%A/clients'), 400);
    assert.equal(await rawGet(sb.base, '//['), 400);
  });

  // The Python SDK setup from the README: base_url on a meraki.com name and
  // the emulator as its HTTP proxy, so Link URLs stay on that name.
  test('proxied requests page with links on the requested host', async () => {
    const org = sb.world.orgs[0];
    const r = await raw(sb.base, `http://emulator.meraki.com/api/v1/organizations/${org.id}/devices?perPage=5`, { Host: 'emulator.meraki.com' });
    assert.equal(r.status, 200);
    assert.match(relLink(r.headers.link, 'next'), /^http:\/\/emulator\.meraki\.com\/api\/v1\/organizations\/\d+\/devices\?/);
  });

  test('a Link URL glued onto the base URL gets a 404 that explains the SDK setup', async () => {
    const r = await raw(sb.base, '/api/v1http://127.0.0.1:8765/api/v1/organizations?perPage=3&startingAfter=1');
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.body), { errors: [SDK_HINT] });
    assert.equal(await rawGet(sb.base, '/api/v1nope'), 404);
  });

  test('CONNECT gets a 501 asking for an http:// base URL', async () => {
    const { hostname, port } = new URL(sb.base);
    const res = await new Promise((resolve, reject) => {
      const req = request({ hostname, port, method: 'CONNECT', path: 'emulator.meraki.com:443' });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.statusCode, 501);
    assert.equal(res.statusMessage, CONNECT_HINT);
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
    const html = await page.text();
    assert.match(html, /Meraki API Emulator/);
    assert.ok(html.includes(`v${VERSION}</span>`), 'the page shows the package version');
    const health = await sb.get(sb.base.replace('/api/v1', '/healthz'), { key: null });
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.version, VERSION);
    assert.ok(health.body.window.requests > 0, 'earlier API calls are counted');
    assert.ok(health.body.window.p95Ms >= health.body.window.p50Ms);
    assert.ok(health.body.mostCalled.length > 0 && health.body.mostCalled.length <= 5);
    assert.equal(health.body.timeline.length, 30);
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

  test('paging back from the last page covers every item once', async () => {
    const org = sb.world.orgs[0];
    const all = (await sb.get(`/organizations/${org.id}/devices?perPage=1000`)).body.map((d) => d.serial);
    const back = [];
    let url = `/organizations/${org.id}/devices?perPage=7&endingBefore=zzzzzzzzzz`;
    while (url) {
      const r = await sb.get(url);
      back.unshift(...r.body.map((d) => d.serial));
      url = relLink(r.link, 'prev');
    }
    assert.ok(all.length % 7, 'the first page is a short one');
    assert.deepEqual(back, all);
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

  test('MX LAN ports cover the model range and trunk to the core switch', async () => {
    for (const net of sb.world.orgs[0].networks) {
      const r = await sb.get(`/networks/${net.id}/appliance/ports`);
      assert.equal(r.status, 200);
      const [first, last] = net.mx.info.lan;
      assert.deepEqual(r.body.map((p) => p.number), Array.from({ length: last - first + 1 }, (_, i) => first + i));
      assert.deepEqual(r.body.find((p) => p.number === 3), {
        number: 3, enabled: true, type: 'trunk', dropUntaggedTraffic: false, vlan: 1, allowedVlans: 'all', sgt: { id: null, enabled: false },
      });
      for (const p of r.body) assert.equal('accessPolicy' in p, p.type === 'access', `port ${p.number}`);
      assert.deepEqual((await sb.get(`/networks/${net.id}/appliance/ports/3`)).body, r.body.find((p) => p.number === 3));
    }
    const hq = sb.world.orgs[0].networks[0];
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/ports/99`)).status, 404);
  });

  test('appliance endpoints reject networks and devices without an MX', async () => {
    const lab = sb.world.orgs[1].networks[0];
    assert.equal((await sb.get(`/networks/${lab.id}/appliance/security/events`)).status, 400);
    assert.equal((await sb.get(`/networks/${lab.id}/appliance/ports`)).status, 400);
    assert.equal((await sb.get(`/devices/${lab.aps[0].serial}/lossAndLatencyHistory?ip=8.8.8.8`)).status, 400);
  });
});

describe('options', () => {
  test('--api-key only accepts that key', async () => {
    const sb = await start({ apiKey: 'secret' });
    try {
      assert.equal((await sb.get('/organizations', { key: 'wrong' })).status, 401);
      assert.equal((await sb.get('/organizations', { key: 'secret' })).status, 200);
      const page = await (await fetch(sb.base.replace('/api/v1', '/'))).text();
      assert.doesNotMatch(page, /demo-key/, 'the landing page must not suggest a key that fails');
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
