import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

// A callback receiver that records each POST body.
async function receiver() {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}/cb`, close: () => new Promise((r) => server.close(r)) };
}

describe('device live tools', () => {
  let sb;
  let rx;
  let corp;
  let hq;
  let sw;
  let ap;
  let mx;
  let cam;
  before(async () => {
    sb = await start();
    rx = await receiver();
  });
  afterEach(async () => {
    rx.got.length = 0;
    assert.equal((await sb.reset()).status, 204);
  });
  after(async () => {
    await sb.close();
    await rx.close();
  });
  const fresh = () => {
    [corp] = sb.world.orgs;
    hq = corp.networks[0];
    [sw] = hq.switches;
    [ap] = hq.aps;
    mx = hq.mx;
    cam = sb.world.devices.find((d) => d.dormant);
  };
  const L = (dev, tool) => `/devices/${dev.serial}/liveTools/${tool}`;
  const created = async (r) => {
    const res = await r;
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  // Creates a job and reads it back by its URL.
  const run = async (dev, tool, body = {}) => {
    const job = await created(sb.post(L(dev, tool), body));
    const r = await sb.get(job.url);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { job, done: r.body };
  };

  test('a ping from a device reaches LAN clients and the internet, and a job is looked up by its tool', async () => {
    fresh();
    const { job, done } = await run(sw, 'ping', { target: '8.8.8.8', count: 3 });
    assert.match(job.pingId, /^\d{13}$/);
    assert.equal(job.url, `/devices/${sw.serial}/liveTools/ping/${job.pingId}`);
    assert.deepEqual(job.request, { serial: sw.serial, target: '8.8.8.8', count: 3 });
    assert.equal(job.status, 'complete');
    assert.equal(job.results, undefined);
    const r = done.results;
    assert.equal(r.sent, 3);
    assert.equal(r.received, r.replies.length);
    assert.ok(r.latencies.minimum <= r.latencies.average && r.latencies.average <= r.latencies.maximum);
    assert.ok(r.replies.every((x) => x.size === 84 && x.latency > 0));
    // A LAN client answers in a couple of milliseconds, an unused private address never does.
    const online = hq.clients.find((c) => c.wired);
    const lan = (await run(mx, 'ping', { target: online.ip })).done.results;
    assert.ok(lan.received === 0 || lan.latencies.maximum < 5);
    const nowhere = (await run(mx, 'ping', { target: '192.168.250.250' })).done.results;
    assert.deepEqual([nowhere.sent, nowhere.received, nowhere.loss.percentage, nowhere.replies.length], [5, 0, 100, 0]);
    assert.equal(nowhere.latencies.average, null);
    assert.equal((await run(mx, 'ping', { target: 'example.com' })).done.request.target, 'example.com');
    await errorOf(sb.get(`${L(sw, 'arpTable')}/${job.pingId}`), 404);
    await errorOf(sb.get(`${L(ap, 'ping')}/${job.pingId}`), 404);
    await errorOf(sb.get(`${L(sw, 'ping')}/1234`), 404);
  });

  test('ping checks its target and count', async () => {
    fresh();
    assert.match(await errorOf(sb.post(L(mx, 'ping'), {})), /'target' is required/);
    assert.match(await errorOf(sb.post(L(mx, 'ping'), { target: 'not a host' })), /FQDN/);
    assert.match(await errorOf(sb.post(L(mx, 'ping'), { target: '8.8.8.8', count: 6 })), /between 1 and 5/);
    assert.match(await errorOf(sb.post(L(mx, 'pingDevice'), { count: 0 })), /between 1 and 5/);
    await errorOf(sb.post('/devices/Q2XX-NONE-0000/liveTools/ping', { target: '8.8.8.8' }), 404);
    assert.equal((await created(sb.post(L(mx, 'ping'), { target: '2001:4860:4860::8888' }))).request.target, '2001:4860:4860::8888');
  });

  test('ping device loses every packet while the device is down, and other tools fail', async () => {
    fresh();
    const up = (await run(ap, 'pingDevice', { count: 2 })).done;
    assert.deepEqual(up.request, { serial: ap.serial, count: 2 });
    assert.equal(up.results.sent, 2);
    const down = (await run(cam, 'pingDevice')).done;
    assert.equal(down.status, 'complete');
    assert.deepEqual([down.results.sent, down.results.received, down.results.loss.percentage], [5, 0, 100]);
    const blink = (await run(cam, 'leds/blink', { duration: 10 })).done;
    assert.deepEqual([blink.status, blink.error], ['failed', 'The device is unreachable.']);
    const ping = (await run(cam, 'ping', { target: '8.8.8.8' })).done;
    assert.equal(ping.status, 'failed');
    assert.equal(ping.results, undefined);
  });

  test('ARP tables list clients in the device VLANs, and MX ARP is not supported', async () => {
    fresh();
    const { done } = await run(sw, 'arpTable');
    const gateway = done.entries.find((e) => e.mac === mx.mac && e.vlanId === 1);
    assert.equal(gateway.ip, `${hq.subnet(1)}.1`);
    const clients = done.entries.filter((e) => e.mac !== mx.mac && !sb.world.devices.some((d) => d.mac === e.mac));
    assert.ok(clients.length > 20);
    for (const e of clients) {
      const c = hq.clients.find((x) => x.mac === e.mac);
      assert.equal(c.ip, e.ip);
      assert.equal(c.vlan, e.vlanId);
      assert.equal(e.interface, null);
      assert.match(e.lastUpdatedAt, /^2026-09-29T18:2\d:\d\d\.\d{6}Z$/);
    }
    const wifi = (await run(ap, 'arpTable')).done.entries;
    assert.ok(wifi.every((e) => e.vlanId === null && e.lastUpdatedAt === null));
    assert.ok(wifi.slice(1).every((e) => hq.clients.find((c) => c.mac === e.mac).ap === ap));
    assert.match(await errorOf(sb.post(L(mx, 'arpTable'), {})), /not supported on MX250/);
  });

  test('MAC tables agree with the ports clients sit on, and filter by MAC', async () => {
    fresh();
    const { done } = await run(sw, 'macTable');
    assert.deepEqual(done.request, { serial: sw.serial });
    for (const e of done.entries) {
      const c = hq.clients.find((x) => x.mac === e.mac);
      if (c?.wired) assert.equal(c.switchport, e.port);
      if (c && !c.wired) assert.equal(c.ap.switchPort.portId, e.port);
    }
    assert.ok(done.entries.some((e) => e.mac === mx.mac && e.port === sw.ports.find((p) => p.isUplink).portId));
    const one = done.entries.find((e) => hq.clients.some((c) => c.mac === e.mac));
    const filtered = (await run(sw, 'macTable', { mac: one.mac.toUpperCase() })).done;
    assert.equal(filtered.request.mac, one.mac.toUpperCase());
    assert.deepEqual(filtered.entries, [one]);
    assert.match(await errorOf(sb.post(L(sw, 'macTable'), { mac: '0011.22a0.b1c2' })), /six-octet/);
    assert.match(await errorOf(sb.post(L(ap, 'macTable'), {})), /not supported/);
  });

  test('cable tests and port statuses agree with the port status view', async () => {
    fresh();
    const live = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses?timespan=300`)).body;
    const status = (await run(sw, 'ports/status')).done;
    assert.deepEqual(status.errors, []);
    assert.equal(status.results.length, sw.ports.length);
    for (const [i, r] of status.results.entries()) {
      assert.equal(r.portId, Number(live[i].portId));
      assert.equal(r.status, live[i].status === 'Connected' ? 'connected' : 'disconnected');
      assert.equal(r.speed, live[i].speed);
      assert.equal(r.power.isDrawing, live[i].poe.isAllocated);
    }
    assert.deepEqual(status.results[0].interface, { name: 'GigabitEthernet1/0/1', slot: 1, subslot: 0, number: 1 });
    assert.deepEqual(status.results.at(-1).interface, { name: 'TenGigabitEthernet1/1/8', slot: 1, subslot: 1, number: 8 });

    const empty = sw.ports.find((p) => !p.uplinkPort && !p.peer && !p.clients.length).portId;
    const cable = (await run(sw, 'cableTest', { ports: ['1', empty] })).done;
    assert.deepEqual(cable.request.ports, ['1', empty]);
    const [used, open] = cable.results;
    assert.equal(used.status, live[0].status === 'Connected' ? 'up' : 'down');
    assert.ok(used.pairs.every((p) => p.status === 'ok' && p.lengthMeters > 0));
    assert.deepEqual(open.pairs.map((p) => [p.index, p.status, p.lengthMeters]), [0, 1, 2, 3].map((i) => [i, 'open', 0]));
    assert.deepEqual([open.status, open.speedMbps], ['down', 0]);
    assert.match(await errorOf(sb.post(L(sw, 'cableTest'), { ports: ['99'] })), /'99' is not a port/);
    assert.match(await errorOf(sb.post(L(sw, 'cableTest'), { ports: [] })), /must not be empty/);
    await errorOf(sb.post(L(sw, 'cableTest'), {}));
  });

  test('port cycles take ports and ranges, and power usage adds PoE to the base draw', async () => {
    fresh();
    const cycle = (await run(sw, 'ports/cycle', { ports: ['1', '2-4'] })).done;
    assert.deepEqual([cycle.status, cycle.request.ports], ['complete', ['1', '2-4']]);
    assert.match(await errorOf(sb.post(L(sw, 'ports/cycle'), { ports: ['4-2'] })), /not a port or port range/);
    assert.match(await errorOf(sb.post(L(ap, 'ports/cycle'), { ports: ['1'] })), /not supported/);
    const power = (await run(sw, 'power/usage')).done;
    const { instant, peak, budget } = power.results;
    assert.ok(instant > 140 && peak >= instant && budget === 1240, JSON.stringify(power.results));
    assert.deepEqual(power.errors, []);
    const small = (await run(hq.switches[1], 'power/usage')).done.results;
    assert.ok(small.instant < instant);
  });

  test('throughput tests run on an MX, LEDs blink anywhere and wake on LAN checks the VLAN', async () => {
    fresh();
    const t = await created(sb.post(L(mx, 'throughputTest'), {}));
    assert.ok(t.result.speeds.downstream > 500 && t.result.speeds.downstream <= 4000);
    assert.equal((await sb.get(t.url)).body.result.speeds.downstream, t.result.speeds.downstream);
    assert.match(await errorOf(sb.post(L(ap, 'throughputTest'), {})), /not supported/);
    const blink = await created(sb.post(L(ap, 'leds/blink'), { duration: 30 }));
    assert.deepEqual(blink.request, { serial: ap.serial, duration: 30 });
    assert.match(await errorOf(sb.post(L(ap, 'leds/blink'), { duration: 0 })), /between 1 and 3600/);
    const wol = await created(sb.post(L(sw, 'wakeOnLan'), { vlanId: 10, mac: '00:11:22:33:44:55' }));
    assert.deepEqual(wol.request, { serial: sw.serial, vlanId: 10, mac: '00:11:22:33:44:55' });
    assert.match(await errorOf(sb.post(L(mx, 'wakeOnLan'), { vlanId: 77, mac: '00:11:22:33:44:55' })), /VLAN 77 does not exist/);
    assert.match(await errorOf(sb.post(L(mx, 'wakeOnLan'), { vlanId: 0, mac: '00:11:22:33:44:55' })), /between 1 and 4094/);
    assert.match(await errorOf(sb.post(L(mx, 'wakeOnLan'), { vlanId: 10, mac: 'nope' })), /MAC/);
    assert.match(await errorOf(sb.post(L(ap, 'wakeOnLan'), { vlanId: 10, mac: '00:11:22:33:44:55' })), /not supported/);
  });

  test('reboot answers 202, and a reset clears the jobs', async () => {
    fresh();
    const r = await sb.post(`/devices/${ap.serial}/reboot`);
    assert.deepEqual([r.status, r.body], [202, { success: true }]);
    await errorOf(sb.post('/devices/Q2XX-NONE-0000/reboot'), 404);
    const job = await created(sb.post(L(sw, 'arpTable'), {}));
    assert.equal((await sb.reset()).status, 204);
    await errorOf(sb.get(job.url), 404);
  });

  test('a callback sends the finished job to its URL or HTTP server', async () => {
    fresh();
    const job = await created(sb.post(L(sw, 'arpTable'), { callback: { url: rx.url, sharedSecret: 'shh' } }));
    assert.deepEqual(Object.keys(job.callback), ['id', 'url', 'status']);
    assert.deepEqual([job.callback.url, job.callback.status], [rx.url, 'new']);
    const S = `/organizations/${corp.id}/webhooks/callbacks/statuses/${job.callback.id}`;
    let cb;
    for (let i = 0; i < 100 && cb?.status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      cb = (await sb.get(S)).body;
    }
    assert.equal(cb.status, 'completed');
    assert.deepEqual(cb.errors, []);
    assert.deepEqual(cb.webhook.payloadTemplate, { id: 'wpt_00005' });
    assert.equal(cb.webhook.url, rx.url);
    assert.equal(cb.createdBy.adminId, sb.world.apiAdmin.id);
    const [sent] = rx.got;
    assert.equal(sent.sharedSecret, 'shh');
    assert.equal(sent.alertId, job.callback.id);
    assert.deepEqual(sent.alertData, (await sb.get(job.url)).body);

    const server = await created(sb.post(`/networks/${hq.id}/webhooks/httpServers`, { name: 'Tools', url: rx.url, sharedSecret: 'srv' }));
    const viaServer = await created(sb.post(L(ap, 'pingDevice'), { callback: { httpServer: { id: server.id }, payloadTemplate: { id: 'wpt_00001' } } }));
    const read = (await sb.get(viaServer.url)).body;
    assert.equal(read.callback.id, viaServer.callback.id);
    const status = (await sb.get(`/organizations/${corp.id}/webhooks/callbacks/statuses/${viaServer.callback.id}`)).body;
    assert.deepEqual(status.webhook.httpServer, { id: server.id });
    assert.deepEqual(status.webhook.payloadTemplate, { id: 'wpt_00001' });

    assert.match(await errorOf(sb.post(L(sw, 'arpTable'), { callback: { url: rx.url } })), /'url' and 'sharedSecret'/);
    assert.match(await errorOf(sb.post(L(sw, 'arpTable'), { callback: { url: rx.url, sharedSecret: 'x', httpServer: { id: server.id } } })), /not both/);
    assert.match(await errorOf(sb.post(L(sw, 'arpTable'), { callback: { httpServer: { id: 'nope' } } })), /HTTP server nope/);
    assert.match(await errorOf(sb.post(L(sw, 'arpTable'), { callback: { url: 'ftp://x', sharedSecret: 'x' } })), /http or https/);
    assert.match(await errorOf(sb.post(L(sw, 'arpTable'), { callback: { url: rx.url, sharedSecret: 'x', payloadTemplate: { id: 'wpt_9' } } })), /wpt_9/);
  });
});

describe('device live tools on a running clock', () => {
  let sb;
  before(async () => (sb = await start({ now: null, rateLimit: 1000, noWebhooks: true })));
  after(() => sb.close());

  test('a job is new, then runs, then completes', async () => {
    const [ap] = sb.world.orgs[0].networks[0].aps;
    const job = (await sb.post(`/devices/${ap.serial}/liveTools/leds/blink`, { duration: 5 })).body;
    assert.equal(job.status, 'new');
    await new Promise((r) => setTimeout(r, 2100));
    assert.equal((await sb.get(job.url)).body.status, 'complete');
  });

  test('live tools and reboot have per-device rate limits', async () => {
    const [a, b] = sb.world.orgs[0].networks[0].switches;
    assert.equal((await sb.post(`/devices/${a.serial}/reboot`)).status, 202);
    const again = await sb.post(`/devices/${a.serial}/reboot`);
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers.get('retry-after')) > 50);
    assert.equal((await sb.post(`/devices/${b.serial}/reboot`)).status, 202);
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await sb.post(`/devices/${a.serial}/liveTools/arpTable`, {})).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
    assert.equal((await sb.post(`/devices/${a.serial}/liveTools/macTable`, {})).status, 201);
  });
});
