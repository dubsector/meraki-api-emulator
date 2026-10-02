import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

// A webhook receiver that records each POST and answers with `status`.
async function receiver(status = 200) {
  const got = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(rx.status);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rx = { got, status, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise((r) => server.close(r)) };
  return rx;
}

// A URL nothing listens on.
async function closedUrl() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return `http://127.0.0.1:${port}/gone`;
}

describe('webhooks and alert configs', () => {
  let sb;
  let rx;
  let corp;
  let hq;
  let N;
  let O;
  before(async () => {
    sb = await start({ webhooks: true });
    rx = await receiver();
  });
  afterEach(async () => {
    rx.got.length = 0;
    rx.status = 200;
    assert.equal((await sb.reset()).status, 204);
  });
  after(async () => {
    await sb.close();
    await rx.close();
  });
  const fresh = () => {
    [corp] = sb.world.orgs;
    hq = corp.networks[0];
    N = `/networks/${hq.id}/webhooks`;
    O = `/organizations/${corp.id}`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const created = async (r) => {
    const res = await r;
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const b64 = (s) => Buffer.from(s).toString('base64');
  // Polls a webhook test until it settles.
  const settled = async (id, net = hq) => {
    for (let i = 0; i < 100; i++) {
      const { body } = await sb.get(`/networks/${net.id}/webhooks/webhookTests/${id}`);
      if (body.status === 'delivered' || body.status === 'abandoned') return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('webhook test never settled');
  };

  test('payload templates list the included ones, and custom ones are created, changed and deleted', async () => {
    fresh();
    const list = (await sb.get(`${N}/payloadTemplates`)).body;
    assert.deepEqual(
      list.map((t) => t.payloadTemplateId),
      ['wpt_00001', 'wpt_00002', 'wpt_00003', 'wpt_00004', 'wpt_00005', 'wpt_00006', 'wpt_00007', 'wpt_00008', 'wpt_00009'],
    );
    assert.ok(list.every((t) => t.type === 'included'));
    assert.equal(list[0].name, 'Meraki (included)');
    assert.equal(list[4].name, 'Callback (included)');

    const t = await created(sb.post(`${N}/payloadTemplates`, { name: 'Chat', body: '{"text":"{{alertType}}"}', headers: [{ name: 'X-Token', template: '{{sharedSecret}}' }] }));
    assert.match(t.payloadTemplateId, /^wpt_\d{5}$/);
    assert.deepEqual(t, { payloadTemplateId: t.payloadTemplateId, type: 'custom', name: 'Chat', headers: [{ name: 'X-Token', template: '{{sharedSecret}}' }], body: '{"text":"{{alertType}}"}', sharing: { byNetwork: { adminsCanModify: false } } });
    assert.deepEqual((await sb.get(`${N}/payloadTemplates/${t.payloadTemplateId}`)).body, t);
    assert.equal((await sb.get(`${N}/payloadTemplates`)).body.length, 10);

    const files = await created(sb.post(`${N}/payloadTemplates`, { name: 'Files', bodyFile: b64('{"a":1}'), headersFile: b64('{"Authorization":"Bearer {{sharedSecret}}"}') }));
    assert.equal(files.body, '{"a":1}');
    assert.deepEqual(files.headers, [{ name: 'Authorization', template: 'Bearer {{sharedSecret}}' }]);
    assert.notEqual(files.payloadTemplateId, t.payloadTemplateId);

    const up = await sb.put(`${N}/payloadTemplates/${t.payloadTemplateId}`, { name: 'Chat v2', bodyFile: b64('{"b":2}') });
    assert.equal(up.status, 200);
    assert.equal(up.body.name, 'Chat v2');
    assert.equal(up.body.body, '{"b":2}');
    assert.deepEqual(up.body.headers, t.headers);

    assert.equal((await sb.del(`${N}/payloadTemplates/${files.payloadTemplateId}`)).status, 204);
    await errorOf(sb.get(`${N}/payloadTemplates/${files.payloadTemplateId}`), 404);
    await errorOf(sb.del(`${N}/payloadTemplates/${files.payloadTemplateId}`), 404);
  });

  test('payload templates check their input', async () => {
    fresh();
    assert.match(await errorOf(sb.post(`${N}/payloadTemplates`, { name: 'Empty' })), /body/);
    assert.match(await errorOf(sb.post(`${N}/payloadTemplates`, { name: ' ', body: '{}' })), /name/);
    assert.match(await errorOf(sb.post(`${N}/payloadTemplates`, { name: 'Bad', bodyFile: 'not base64!' })), /Base64/);
    assert.match(await errorOf(sb.post(`${N}/payloadTemplates`, { name: 'Bad', body: '{}', headersFile: b64('[1]') })), /headersFile/);
    assert.match(await errorOf(sb.put(`${N}/payloadTemplates/wpt_00003`, { name: 'Mine' })), /Included/);
    assert.match(await errorOf(sb.del(`${N}/payloadTemplates/wpt_00001`)), /Included/);
    await errorOf(sb.put(`${N}/payloadTemplates/wpt_99999`, { name: 'Nope' }), 404);
    // A refused update changes nothing.
    const t = await created(sb.post(`${N}/payloadTemplates`, { name: 'Kept', body: '{}' }));
    await errorOf(sb.put(`${N}/payloadTemplates/${t.payloadTemplateId}`, { name: 'Lost', bodyFile: 'not base64!' }));
    assert.equal((await sb.get(`${N}/payloadTemplates/${t.payloadTemplateId}`)).body.name, 'Kept');
  });

  test('HTTP servers point at a payload template that exists, and a template in use is kept', async () => {
    fresh();
    const t = await created(sb.post(`${N}/payloadTemplates`, { name: 'Ops', body: '{}' }));
    assert.match(await errorOf(sb.post(`${N}/httpServers`, { name: 'Hook', url: 'https://hooks.example.net/a', payloadTemplate: { payloadTemplateId: 'wpt_424242' } })), /wpt_424242/);
    const server = await created(sb.post(`${N}/httpServers`, { name: 'Hook', url: 'https://hooks.example.net/a', payloadTemplate: { name: 'Ops' } }));
    assert.deepEqual(server.payloadTemplate, { payloadTemplateId: t.payloadTemplateId, name: 'Ops' });
    const plain = await created(sb.post(`${N}/httpServers`, { name: 'Plain', url: 'https://hooks.example.net/b' }));
    assert.deepEqual(plain.payloadTemplate, { payloadTemplateId: 'wpt_00001', name: 'Meraki (included)' });

    await sb.put(`${N}/payloadTemplates/${t.payloadTemplateId}`, { name: 'Ops v2' });
    assert.equal((await sb.get(`${N}/httpServers/${server.id}`)).body.payloadTemplate.name, 'Ops v2');
    assert.match(await errorOf(sb.del(`${N}/payloadTemplates/${t.payloadTemplateId}`)), /used by HTTP server Hook/);

    await errorOf(sb.put(`${N}/httpServers/${server.id}`, { name: 'Renamed', payloadTemplate: { payloadTemplateId: 'wpt_424242' } }));
    assert.equal((await sb.get(`${N}/httpServers/${server.id}`)).body.name, 'Hook');
    const moved = await sb.put(`${N}/httpServers/${server.id}`, { payloadTemplate: { payloadTemplateId: 'wpt_00003' } });
    assert.deepEqual(moved.body.payloadTemplate, { payloadTemplateId: 'wpt_00003', name: 'Slack (included)' });
    assert.equal((await sb.del(`${N}/payloadTemplates/${t.payloadTemplateId}`)).status, 204);
  });

  test('webhook tests render the template and POST it to the URL', async () => {
    fresh();
    const t = await created(sb.post(`${N}/payloadTemplates`, { name: 'Ops', body: '{"type":"{{alertTypeId}}","net":{{networkName | jsonify}},"data":{{alertData | jsonify}}}', headers: [{ name: 'Authorization', template: 'Bearer {{sharedSecret}}' }] }));
    const job = await created(sb.post(`${N}/webhookTests`, { url: rx.url, sharedSecret: 's3cret', payloadTemplateId: t.payloadTemplateId, alertTypeId: 'settings_changed' }));
    assert.match(job.id, /^\d{13}$/);
    assert.deepEqual(job, { id: job.id, url: rx.url, status: 'enqueued' });
    assert.deepEqual(await settled(job.id), { ...job, status: 'delivered' });
    assert.equal(rx.got.length, 1);
    assert.equal(rx.got[0].headers.authorization, 'Bearer s3cret');
    assert.equal(rx.got[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(rx.got[0].body), { type: 'settings_changed', net: hq.name, data: { page: 'Alerts', label: 'Alert settings', oldValue: 'disabled', newValue: 'enabled' } });

    // With no template given, the Meraki (included) one sends the whole alert.
    const plain = await created(sb.post(`${N}/webhookTests`, { url: rx.url }));
    await settled(plain.id);
    const alert = JSON.parse(rx.got[1].body);
    assert.equal(alert.alertTypeId, 'power_supply_down');
    assert.equal(alert.sharedSecret, '');
    assert.equal(alert.sentAt, '2026-09-29T18:30:00.000000Z');
    assert.equal(alert.organizationId, corp.id);
    assert.equal(alert.networkId, hq.id);
    assert.equal(alert.deviceSerial, hq.switches[0].serial);
  });

  test('webhook tests to a URL with an HTTP server use its secret and template', async () => {
    fresh();
    await created(sb.post(`${N}/httpServers`, { name: 'Rx', url: rx.url, sharedSecret: 'from-server', payloadTemplate: { payloadTemplateId: 'wpt_00003' } }));
    const job = await created(sb.post(`${N}/webhookTests`, { url: rx.url, alertTypeId: 'failover_event' }));
    await settled(job.id);
    assert.deepEqual(JSON.parse(rx.got[0].body), { text: `Failover event in ${hq.name} (${corp.name}) at 2026-09-29T18:30:00.000000Z` });
    const meraki = await created(sb.post(`${N}/webhookTests`, { url: rx.url, payloadTemplateName: 'Meraki (included)' }));
    await settled(meraki.id);
    assert.equal(JSON.parse(rx.got[1].body).sharedSecret, 'from-server');
  });

  test('failed webhook tests retry, then are abandoned, and every attempt is logged', async () => {
    fresh();
    rx.status = 500;
    const job = await created(sb.post(`${N}/webhookTests`, { url: rx.url }));
    const seen = new Set();
    for (let i = 0; i < 100 && !seen.has('abandoned'); i++) {
      seen.add((await sb.get(`${N}/webhookTests/${job.id}`)).body.status);
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(seen.has('retrying') && seen.has('abandoned'), [...seen].join());
    assert.equal(rx.got.length, 3);

    const gone = await closedUrl();
    const lost = await created(sb.post(`${N}/webhookTests`, { url: gone }));
    assert.equal((await settled(lost.id)).status, 'abandoned');

    const logs = (await sb.get(`${O}/webhooks/logs`)).body;
    assert.equal(logs.length, 6);
    assert.deepEqual(
      logs.map((l) => l.responseCode),
      [0, 0, 0, 500, 500, 500],
    );
    assert.deepEqual(Object.keys(logs[0]), ['alertType', 'loggedAt', 'networkId', 'organizationId', 'responseCode', 'responseDuration', 'sentAt', 'url']);
    assert.equal(logs[0].alertType, 'Power supply went down');
    assert.deepEqual((await sb.get(`${O}/webhooks/logs?url=${encodeURIComponent(rx.url)}`)).body, logs.slice(3));
    const page = await sb.get(`${O}/webhooks/logs?perPage=4`);
    assert.equal(page.body.length, 4);
    const next = page.link.match(/<([^>]+)>; rel=next/)[1];
    assert.deepEqual((await sb.get(next)).body, logs.slice(4));
  });

  test('webhook tests check their input', async () => {
    fresh();
    assert.match(await errorOf(sb.post(`${N}/webhookTests`, { url: 'ftp://example.com/x' })), /url/);
    assert.match(await errorOf(sb.post(`${N}/webhookTests`, { url: rx.url, alertTypeId: 'kaboom' })), /kaboom/);
    assert.match(await errorOf(sb.post(`${N}/webhookTests`, { url: rx.url, payloadTemplateId: 'wpt_1' })), /wpt_1/);
    await errorOf(sb.get(`${N}/webhookTests/1234`), 404);
    await errorOf(sb.get(`${O}/webhooks/logs?timespan=2592001`));
    assert.equal(rx.got.length, 0);
  });

  test('a network bound to a config template can still send webhook tests', async () => {
    fresh();
    const london = corp.networks.find((n) => n.name === 'Remote - London');
    const template = await created(sb.post(`${O}/configTemplates`, { name: 'Branch' }));
    assert.equal((await sb.post(`/networks/${london.id}/bind`, { configTemplateId: template.id })).status, 200);
    await errorOf(sb.post(`/networks/${london.id}/webhooks/payloadTemplates`, { name: 'Ops', body: '{}' }));
    const job = await created(sb.post(`/networks/${london.id}/webhooks/webhookTests`, { url: rx.url }));
    assert.equal((await settled(job.id, london)).status, 'delivered');
  });

  test('alert types list example payloads, filtered by product', async () => {
    fresh();
    const all = (await sb.get(`${O}/webhooks/alertTypes`)).body;
    assert.ok(all.some((t) => t.alertTypeId === 'power_supply_down'));
    const ap = all.find((t) => t.alertType === 'APs went down');
    assert.equal(ap.alertTypeId, 'stopped_reporting');
    assert.equal(ap.example.alertTypeId, 'stopped_reporting');
    assert.equal(ap.example.deviceModel, 'MR34');
    const settings = all.find((t) => t.alertTypeId === 'settings_changed');
    assert.equal(settings.example.deviceSerial, undefined);
    const switches = (await sb.get(`${O}/webhooks/alertTypes?productType=switch`)).body;
    assert.deepEqual(
      switches.map((t) => t.alertType),
      ['Power supply went down', 'Switches went down'],
    );
    assert.deepEqual((await sb.get(`${O}/webhooks/alertTypes?productType=sensor`)).body, []);
    assert.match(await errorOf(sb.get(`${O}/webhooks/alertTypes?productType=toaster`)), /productType/);
  });

  test('callback statuses are not found until something makes a callback', async () => {
    fresh();
    await errorOf(sb.get(`${O}/webhooks/callbacks/statuses/1284392014819`), 404);
  });

  test('organization alert configs are created, updated and deleted', async () => {
    fresh();
    const P = `${O}/alerts/profiles`;
    assert.deepEqual((await sb.get(P)).body, []);
    const server = await created(sb.post(`${N}/httpServers`, { name: 'NOC', url: 'https://hooks.example.net/noc' }));
    const a = await created(sb.post(P, { type: 'wanUtilization', alertCondition: { duration: 60, window: 600, bit_rate_bps: 10000, interface: 'wan1', latency_ms: 5 }, recipients: { emails: ['noc@example.com'], httpServerIds: [server.id] }, networkTags: ['branch'], description: 'WAN 1 busy' }));
    assert.match(a.id, /^\d{13}$/);
    assert.deepEqual(a, { id: a.id, type: 'wanUtilization', enabled: true, alertCondition: { duration: 60, window: 600, bit_rate_bps: 10000, interface: 'wan1' }, recipients: { emails: ['noc@example.com'], httpServerIds: [server.id] }, networkTags: ['branch'], description: 'WAN 1 busy' });
    assert.deepEqual((await sb.get(P)).body, [a]);

    const up = await sb.put(`${P}/${a.id}`, { enabled: false, type: 'wanLatency', alertCondition: { latency_ms: 150 }, networkTags: ['hq'] });
    assert.equal(up.status, 200);
    assert.deepEqual(up.body, { ...a, enabled: false, type: 'wanLatency', alertCondition: { duration: 60, window: 600, latency_ms: 150, interface: 'wan1' }, networkTags: ['hq'] });
    assert.equal((await sb.del(`${P}/${a.id}`)).status, 204);
    assert.deepEqual((await sb.get(P)).body, []);
    await errorOf(sb.del(`${P}/${a.id}`), 404);
  });

  test('organization alert configs check their input', async () => {
    fresh();
    const P = `${O}/alerts/profiles`;
    const base = { type: 'wanStatus', alertCondition: { duration: 60 }, recipients: { emails: [] }, networkTags: [] };
    assert.equal((await sb.post(P, base)).status, 201);
    assert.match(await errorOf(sb.post(P, { ...base, type: 'wanLatency' })), /latency_ms/);
    assert.match(await errorOf(sb.post(P, { ...base, type: 'solarFlare' })), /type/);
    assert.match(await errorOf(sb.post(P, { ...base, recipients: { httpServerIds: ['aHR0cHM6Ly9ub3doZXJl'] } })), /does not exist/);
    assert.match(await errorOf(sb.post(P, { ...base, alertCondition: { interface: 'wan9' } })), /interface/);
    await errorOf(sb.put(`${P}/1`, { enabled: false }), 404);
  });
});

describe('webhooks without --webhooks', () => {
  test('webhook tests count as delivered without sending anything', async () => {
    const lines = [];
    const sb = await start({ log: (line) => lines.push(line) });
    const rx = await receiver();
    try {
      const [corp] = sb.world.orgs;
      const hq = corp.networks[0];
      const job = (await sb.post(`/networks/${hq.id}/webhooks/webhookTests`, { url: rx.url })).body;
      assert.equal(job.status, 'enqueued');
      assert.equal((await sb.get(`/networks/${hq.id}/webhooks/webhookTests/${job.id}`)).body.status, 'delivered');
      const logs = (await sb.get(`/organizations/${corp.id}/webhooks/logs`)).body;
      assert.deepEqual(
        logs.map((l) => [l.responseCode, l.responseDuration, l.url]),
        [[200, 0, rx.url]],
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(rx.got.length, 0);
      assert.ok(lines.includes(`Webhook to ${rx.url} not sent, start with --webhooks to send it`));
    } finally {
      await sb.close();
      await rx.close();
    }
  });
});
