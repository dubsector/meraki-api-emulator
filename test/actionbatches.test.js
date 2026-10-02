import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, test } from 'node:test';
import { sampleUrls, start } from './helpers.js';

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

const until = async (cond) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('API identity and keys', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('the identity is the API Integration admin', async () => {
    const me = (await sb.get('/administered/identities/me')).body;
    assert.equal(me.name, 'API Integration');
    assert.equal(me.email, 'api@example.com');
    assert.equal(me.lastUsedDashboardAt, '2026-09-29T18:30:00Z');
    assert.deepEqual(me.authentication, { mode: 'email', api: { key: { created: true } }, twoFactor: { enabled: false }, saml: { enabled: false } });
  });

  test('keys list the suffixes of keys used and generated this run', async () => {
    assert.deepEqual((await sb.get('/administered/identities/me/api/keys')).body, [{ suffix: '-key', createdAt: '2026-09-29T18:30:00.000000Z' }]);
    const made = await sb.post('/administered/identities/me/api/keys/generate', {});
    assert.equal(made.status, 202);
    assert.match(made.body.key, /^[0-9a-f]{40}$/);
    const keys = (await sb.get('/administered/identities/me/api/keys')).body;
    assert.deepEqual(keys.map((k) => k.suffix), ['-key', made.body.key.slice(-4)]);
    assert.equal((await sb.get('/organizations', { key: made.body.key })).status, 200);
  });

  test('a revoked key answers 401 from then on, even after a reset', async () => {
    const key = (await sb.post('/administered/identities/me/api/keys/generate', {})).body.key;
    const revoked = await sb.post(`/administered/identities/me/api/keys/${key.slice(-4)}/revoke`, {});
    assert.equal(revoked.status, 202);
    assert.equal(revoked.body, '');
    assert.equal((await sb.get('/organizations', { key })).status, 401);
    await sb.reset();
    assert.equal((await sb.get('/organizations', { key })).status, 401);
    assert.ok(!(await sb.get('/administered/identities/me/api/keys')).body.some((k) => k.suffix === key.slice(-4)));
    assert.equal((await sb.post('/administered/identities/me/api/keys/zzzz/revoke', {})).status, 404);
  });

  test('key routes stay out of the change log', async () => {
    const org = sb.world.orgs[0];
    await sb.post('/administered/identities/me/api/keys/generate', {});
    assert.ok(!(org.apiChanges ?? []).some((c) => c.label.includes('identities')));
  });

  test('with --api-key, generated keys work alongside it', async () => {
    const locked = await start({ apiKey: 'secret-key' });
    try {
      assert.equal((await locked.get('/organizations')).status, 401);
      const key = (await locked.post('/administered/identities/me/api/keys/generate', {}, { key: 'secret-key' })).body.key;
      assert.equal((await locked.get('/organizations', { key })).status, 200);
      assert.equal((await locked.post(`/administered/identities/me/api/keys/${key.slice(-4)}/revoke`, {}, { key })).status, 202);
      assert.equal((await locked.get('/organizations', { key })).status, 401);
      assert.equal((await locked.get('/organizations', { key: 'secret-key' })).status, 200);
    } finally {
      await locked.close();
    }
  });
});

describe('action batches', () => {
  let sb;
  let org;
  let hq;
  let B;
  before(async () => (sb = await start({ noWebhooks: true })));
  after(() => sb.close());
  afterEach(() => sb.reset());
  const refresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    B = `/organizations/${org.id}/actionBatches`;
  };
  const vlan = (id, third) => ({ resource: `/networks/${hq.id}/appliance/vlans`, operation: 'create', body: { id, name: `Batch ${id}`, subnet: `10.250.${third}.0/24`, applianceIp: `10.250.${third}.1` } });

  test('a confirmed batch applies every action and lists what it created', async () => {
    refresh();
    const r = await sb.post(B, { confirmed: true, synchronous: true, actions: [vlan('300', 0), { resource: `/networks/${hq.id}/groupPolicies`, operation: 'create', body: { name: 'Batch policy' } }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.organizationId, org.id);
    assert.match(r.body.id, /^\d{18}$/);
    assert.deepEqual(r.body.status, {
      completed: true,
      failed: false,
      errors: [],
      createdResources: [
        { id: '300', uri: `/networks/${hq.id}/appliance/vlans/300` },
        { id: '102', uri: `/networks/${hq.id}/groupPolicies/102` },
      ],
    });
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/vlans/300`)).body.name, 'Batch 300');
    assert.deepEqual((await sb.get(`${B}/${r.body.id}`)).body, r.body);
    // The change log shows each action, not the batch.
    const labels = (org.apiChanges ?? []).map((c) => c.label);
    assert.deepEqual(labels, [`POST /api/v1/networks/${hq.id}/appliance/vlans`, `POST /api/v1/networks/${hq.id}/groupPolicies`]);
  });

  test('an unconfirmed batch is a preview until a PUT confirms it', async () => {
    refresh();
    const r = await sb.post(B, { actions: [vlan('301', 1)] });
    assert.equal(r.body.confirmed, false);
    assert.equal(r.body.status.completed, false);
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/vlans/301`)).status, 404);
    assert.equal((await sb.get(`${B}?status=pending`)).body.length, 1);
    const confirmed = await sb.put(`${B}/${r.body.id}`, { confirmed: true });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.status.completed, true);
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/vlans/301`)).status, 200);
    assert.match((await sb.put(`${B}/${r.body.id}`, { confirmed: false })).body.errors[0], /cannot be unset/);
    assert.match((await sb.put(`${B}/${r.body.id}`, { synchronous: true })).body.errors[0], /cannot change/);
    assert.equal((await sb.get(`${B}?status=completed`)).body.length, 1);
    assert.equal((await sb.del(`${B}/${r.body.id}`)).status, 204);
    assert.equal((await sb.get(`${B}/${r.body.id}`)).status, 404);
  });

  test('other operations are a POST to resource/operation', async () => {
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    const mx = (await sb.post(`/organizations/${lab.id}/networks`, { name: 'Lab MX', productTypes: ['appliance'] })).body;
    const r = await sb.post(`/organizations/${lab.id}/actionBatches`, {
      confirmed: true,
      actions: [{ resource: `/organizations/${lab.id}/networks`, operation: 'combine', body: { name: 'Lab', networkIds: [lab.networks[0].id, mx.id] } }],
    });
    assert.equal(r.body.status.completed, true);
    assert.deepEqual(r.body.status.createdResources, []);
    assert.ok(sb.world.orgById.get(lab.id).networks.some((n) => n.name === 'Lab'));
  });

  test('a failed action rolls back the ones before it', async () => {
    refresh();
    // Writes of many kinds first, so the rebuild has something to replay.
    const net = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Branch - Boise', productTypes: ['appliance', 'switch', 'wireless'], timeZone: 'America/Boise' })).body;
    await sb.post(`/networks/${hq.id}/webhooks/httpServers`, { name: 'Hook', url: 'https://hooks.example.net/in', sharedSecret: 'x' });
    const webhookTest = (await sb.post(`/networks/${hq.id}/webhooks/webhookTests`, { url: 'https://hooks.example.net/in' })).body;
    await sb.post(B, { confirmed: true, actions: [vlan('302', 2)] });
    const [sw] = hq.switches;
    const ping = (await sb.post(`/devices/${sw.serial}/liveTools/ping`, { target: '8.8.8.8' })).body;
    await sb.put(`/networks/${net.id}`, { name: 'Branch - Boise 2' });
    const urls = sampleUrls(sb.world)
      .filter((u) => u.status === 200 && !/apiRequests|actionBatches|administered/.test(u.url))
      .map((u) => u.url)
      .concat([`/networks/${hq.id}/webhooks/webhookTests/${webhookTest.id}`, `/devices/${sw.serial}/liveTools/ping/${ping.pingId}`, `/networks/${net.id}`]);
    const read = async () => Promise.all(urls.map(async (u) => JSON.stringify((await sb.get(u)).body)));
    const before = await read();

    const r = await sb.post(B, {
      confirmed: true,
      actions: [
        { resource: `/networks/${hq.id}/appliance/vlans/302`, operation: 'update', body: { name: 'Renamed' } },
        { resource: `/organizations/${org.id}/networks`, operation: 'create', body: { name: 'Doomed', productTypes: ['wireless'] } },
        { resource: `/networks/${hq.id}/appliance/vlans/999`, operation: 'destroy' },
      ],
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.status, { completed: false, failed: true, errors: [`Action 3 (destroy /networks/${hq.id}/appliance/vlans/999) failed: VLAN not found`], createdResources: [] });
    const after = await read();
    const changed = urls.filter((u, i) => before[i] !== after[i]);
    assert.deepEqual(changed, []);
    assert.equal((await sb.get(`/networks/${hq.id}/webhooks/webhookTests/${webhookTest.id}`)).body.status, 'delivered');
    // Earlier batches are still there.
    assert.equal((await sb.get(B)).body.length, 2);
    assert.equal((await sb.get(`${B}?status=failed`)).body[0].id, r.body.id);
  });

  test('bad actions are refused before any of them runs', async () => {
    refresh();
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    const bad = await sb.post(B, {
      confirmed: true,
      actions: [
        vlan('303', 3),
        { resource: '/nope', operation: 'create' },
        { resource: `/networks/${lab.networks[0].id}/groupPolicies`, operation: 'create', body: { name: 'x' } },
        { resource: `/networks/${hq.id}/appliance/vlans`, operation: 'create', body: { id: 5 } },
        { resource: `/networks/${hq.id}/webhooks/webhookTests`, operation: 'create', body: { url: 'https://x.example' } },
        { resource: `/devices/${hq.switches[0].serial}/liveTools/ping`, operation: 'create', body: { target: '8.8.8.8' } },
        { resource: B, operation: 'create', body: { actions: [] } },
        { resource: `/networks/${hq.id}?x=1`, operation: 'update' },
        { resource: `/networks/${hq.id}`, operation: 'appliance/vlans', body: { id: '303' } },
      ],
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(
      bad.body.errors.map((e) => e.slice(0, 9)),
      ['Action 2:', 'Action 3:', 'Action 4:', 'Action 5:', 'Action 6:', 'Action 7:', 'Action 8:', 'Action 9:'],
    );
    assert.match(bad.body.errors[1], /not in this organization/);
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/vlans/303`)).status, 404);
    assert.deepEqual((await sb.get(B)).body, []);
    assert.match((await sb.post(B, { actions: [] })).body.errors[0], /at least one/);
    const many = (n) => Array.from({ length: n }, (_, i) => ({ resource: `/networks/${hq.id}`, operation: 'update', body: { notes: String(i) } }));
    assert.match((await sb.post(B, { actions: many(101) })).body.errors[0], /at most 100/);
    assert.match((await sb.post(B, { synchronous: true, actions: many(21) })).body.errors[0], /at most 20/);
    const r = await sb.post(B, { actions: many(21) });
    assert.match((await sb.put(`${B}/${r.body.id}`, { synchronous: true })).body.errors[0], /at most 20/);
    assert.match((await sb.get(`${B}?status=done`)).body.errors[0], /'status'/);
    assert.equal((await sb.get(`/organizations/${org.id}/actionBatches/1234`)).status, 404);
  });

  test('settings on a bound network fail inside a batch too', async () => {
    refresh();
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    const t = (await sb.post(`/organizations/${lab.id}/configTemplates`, { name: 'Wireless', copyFromNetworkId: lab.networks[0].id })).body;
    const fresh = (await sb.post(`/organizations/${lab.id}/networks`, { name: 'Bound', productTypes: ['wireless'] })).body;
    const r = await sb.post(`/organizations/${lab.id}/actionBatches`, {
      confirmed: true,
      actions: [
        { resource: `/networks/${fresh.id}`, operation: 'bind', body: { configTemplateId: t.id } },
        { resource: `/networks/${fresh.id}/wireless/settings`, operation: 'update', body: { ipv6BridgeEnabled: true } },
      ],
    });
    assert.match(r.body.status.errors[0], /bound to a config template/);
    assert.equal((await sb.get(`/networks/${fresh.id}`)).body.configTemplateId, undefined);
  });
});

describe('action batch callbacks', () => {
  let sb;
  let hook;
  before(async () => {
    sb = await start();
    hook = await receiver();
  });
  after(async () => {
    await sb.close();
    await hook.close();
  });

  test('a batch calls back with its final state', async () => {
    const org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    const hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    const server = (await sb.post(`/networks/${hq.id}/webhooks/httpServers`, { name: 'Hook', url: hook.url, sharedSecret: 's3cret' })).body;
    const r = await sb.post(`/organizations/${org.id}/actionBatches`, { confirmed: true, callback: { httpServer: { id: server.id } }, actions: [{ resource: `/networks/${hq.id}`, operation: 'update', body: { notes: 'batched' } }] });
    assert.equal(r.body.callback.status, 'new');
    assert.equal(r.body.callback.url, hook.url);
    await until(() => hook.got.length);
    const [got] = hook.got;
    assert.equal(got.alertData.id, r.body.id);
    assert.equal(got.alertData.status.completed, true);
    assert.equal(got.sharedSecret, 's3cret');
    assert.equal(got.organizationId, org.id);
    const status = (await sb.get(`/organizations/${org.id}/webhooks/callbacks/statuses/${r.body.callback.id}`)).body;
    assert.equal(status.status, 'completed');
    assert.equal((await sb.get(`/organizations/${org.id}/actionBatches/${r.body.id}`)).body.callback.status, 'completed');
    assert.match((await sb.post(`/organizations/${org.id}/actionBatches`, { callback: { httpServer: { id: 'nope' } }, actions: [{ resource: `/networks/${hq.id}`, operation: 'update' }] })).body.errors[0], /does not exist/);
  });
});

describe('action batches on a running clock', () => {
  let sb;
  before(async () => (sb = await start({ now: null, noWebhooks: true })));
  after(() => sb.close());

  test('an asynchronous batch runs a moment after it is confirmed', async () => {
    const org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    const hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    const B = `/organizations/${org.id}/actionBatches`;
    const update = (notes) => ({ actions: [{ resource: `/networks/${hq.id}`, operation: 'update', body: { notes } }] });
    const r = await sb.post(B, { confirmed: true, ...update('later') });
    assert.deepEqual(r.body.status, { completed: false, failed: false, errors: [], createdResources: [] });
    assert.notEqual((await sb.get(`/networks/${hq.id}`)).body.notes, 'later');
    const now = await sb.post(B, { confirmed: true, synchronous: true, ...update('now') });
    assert.equal(now.body.status.completed, true);
    for (let i = 0; i < 4; i++) await sb.post(B, { confirmed: true, ...update(`queued ${i}`) });
    assert.match((await sb.post(B, { confirmed: true, ...update('too many') })).body.errors[0], /at most 5 running/);
    assert.match((await sb.del(`${B}/${r.body.id}`)).body.errors[0], /running/);
    await new Promise((res) => setTimeout(res, 2700));
    assert.equal((await sb.get(`${B}/${r.body.id}`)).body.status.completed, true);
    // Batches run in the order they were confirmed.
    assert.equal((await sb.get(`/networks/${hq.id}`)).body.notes, 'queued 3');
    assert.equal((await sb.get(`${B}?status=pending`)).body.length, 0);
  });
});
