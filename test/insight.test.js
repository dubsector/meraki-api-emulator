import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ROUTES } from '../src/server.js';
import { NOW, start } from './helpers.js';

describe('Insight, organization tools and auto locate views', () => {
  let sb;
  let org;
  let hq;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    O = `/organizations/${org.id}`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };

  test('Insight applications list thresholds for every network with an MX', async () => {
    fresh();
    const apps = await ok(sb.get(`${O}/insight/applications`));
    assert.equal(apps.length, 8);
    const m365 = apps.find((a) => a.name === 'Microsoft 365');
    assert.equal(m365.applicationId, '13.1');
    assert.equal(m365.thresholds.type, 'smart');
    const mxIds = org.networks.filter((n) => n.productTypes.includes('appliance')).map((n) => n.id);
    assert.deepEqual(m365.thresholds.byNetwork.map((t) => t.networkId).sort(), mxIds.sort());
    for (const t of m365.thresholds.byNetwork) assert.ok(Number.isInteger(t.goodput) && Number.isInteger(t.responseDuration));
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    const ottawa = lab.networks.find((n) => n.code === 'OTT');
    assert.deepEqual((await ok(sb.get(`/organizations/${lab.id}/insight/applications`)))[0].thresholds.byNetwork.map((t) => t.networkId), [ottawa.id]);
  });

  test('application health agrees with the traffic analysis rows', async () => {
    fresh();
    const H = `/networks/${hq.id}/insight/applications/16.2/healthByTime`;
    // Two hours at five minutes by default.
    const def = await ok(sb.get(H));
    assert.equal(def.length, 24);
    assert.equal(def.at(-1).endTs, '2026-09-29T18:30:00Z');
    for (const b of def) {
      assert.deepEqual(Object.keys(b), ['startTs', 'endTs', 'wanGoodput', 'lanGoodput', 'wanLatencyMs', 'lanLatencyMs', 'wanLossPercent', 'lanLossPercent', 'responseDuration', 'sent', 'recv', 'numClients']);
      assert.ok(Number.isInteger(b.wanGoodput) && Number.isInteger(b.numClients));
    }
    // One daily bucket from midnight carries the same Zoom bytes as the traffic route.
    const t0 = '2026-09-29T00:00:00Z';
    const [day] = await ok(sb.get(`${H}?t0=${t0}&t1=${NOW}&resolution=86400`));
    const secs = 18.5 * 3600;
    const zoom = (await ok(sb.get(`/networks/${hq.id}/traffic?t0=${t0}`))).find((r) => r.application === 'Zoom');
    assert.ok(Math.abs(day.sent * secs - zoom.sent) <= secs, `${day.sent * secs} vs ${zoom.sent}`);
    assert.ok(Math.abs(day.recv * secs - zoom.recv) <= secs, `${day.recv * secs} vs ${zoom.recv}`);
    assert.ok(day.wanLatencyMs > 0 && day.responseDuration > day.wanLatencyMs);

    assert.equal((await ok(sb.get(`${H}?timespan=604800&resolution=86400`))).length, 8);
    assert.match(await errorOf(sb.get(`${H}?timespan=604801`)), /604800/);
    assert.match(await errorOf(sb.get(`${H}?resolution=600`)), /resolution/);
    assert.match(await errorOf(sb.get(`${H}?t0=2026-09-01T00:00:00Z`)), /7 days/);
    assert.equal((await sb.get(`/networks/${hq.id}/insight/applications/1.1/healthByTime`)).status, 404);
    const lab = sb.world.networks.find((n) => n.name === 'Lab - Toronto');
    assert.match(await errorOf(sb.get(`/networks/${lab.id}/insight/applications/13.1/healthByTime`)), /appliance/);
  });

  test('monitored media servers are created, updated and deleted', async () => {
    fresh();
    const M = `${O}/insight/monitoredMediaServers`;
    assert.deepEqual(await ok(sb.get(M)), []);
    const s = await ok(sb.post(M, { name: 'Sample VoIP Provider', address: '123.123.123.1', bestEffortMonitoringEnabled: true }), 201);
    assert.match(s.id, /^\d{13}$/);
    assert.deepEqual(s, { id: s.id, name: 'Sample VoIP Provider', address: '123.123.123.1', bestEffortMonitoringEnabled: true });
    const t = await ok(sb.post(M, { name: 'SIP', address: 'sip.example.com' }), 201);
    assert.equal(t.bestEffortMonitoringEnabled, false);
    assert.match(await errorOf(sb.post(M, { name: 'SIP', address: '10.0.0.1' })), /already exists/);
    assert.match(await errorOf(sb.post(M, { name: 'X' })), /'address' is required/);
    for (const address of ['2001:db8::1', '1.2.3.999', 'not a host', '']) {
      assert.match(await errorOf(sb.post(M, { name: 'X', address })), /address/, address);
    }
    assert.deepEqual(await ok(sb.put(`${M}/${s.id}`, { address: 'media.example.net', bestEffortMonitoringEnabled: false })), { ...s, address: 'media.example.net', bestEffortMonitoringEnabled: false });
    assert.match(await errorOf(sb.put(`${M}/${s.id}`, { name: 'SIP' })), /already exists/);
    assert.equal((await sb.del(`${M}/${t.id}`)).status, 204);
    assert.deepEqual((await ok(sb.get(M))).map((x) => x.id), [s.id]);
    assert.equal((await sb.get(`${M}/${t.id}`)).status, 404);
  });

  test('provisioning pipeline views are empty', async () => {
    fresh();
    const P = `${O}/api/rest/provisioning/pipelines/jobs`;
    const empty = { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } };
    assert.deepEqual(await ok(sb.get(`${P}?status=running&pipelineIds[]=1234`)), empty);
    assert.deepEqual(await ok(sb.get(`${P}/overviews/byPipeline?pipelineIds[]=1234`)), empty);
    assert.match(await errorOf(sb.get(`${P}?status=done`)), /'status'/);
    assert.match(await errorOf(sb.get(`${P}?perPage=1001`)), /perPage/);
  });

  test('the OpenAPI document lists every operation the emulator serves', async () => {
    fresh();
    const v2 = await ok(sb.get(`${O}/openapiSpec`));
    assert.equal(v2.swagger, '2.0');
    assert.equal(v2.basePath, '/api/v1');
    const ops = Object.values(v2.paths).flatMap((p) => Object.values(p).map((o) => o.operationId));
    assert.deepEqual(ops.sort(), ROUTES.map((r) => r.op).sort());
    const clone = v2.paths['/organizations/{organizationId}/clone'].post;
    assert.deepEqual(Object.keys(clone.responses), ['201']);
    assert.equal(clone.parameters.find((p) => p.in === 'body').schema.properties.name.type, 'string');
    const v3 = await ok(sb.get(`${O}/openapiSpec?version=3`));
    assert.equal(v3.openapi, '3.0.1');
    assert.match(v3.servers[0].url, /\/api\/v1$/);
    assert.equal(v3.paths['/organizations/{organizationId}/clone'].post.requestBody.required, true);
    assert.match(await errorOf(sb.get(`${O}/openapiSpec?version=1`)), /'version'/);
  });

  // Every network and device GET answers without a server error.
  const noErrors = async (nets) => {
    const now = Date.parse(NOW) / 1000;
    for (const net of nets) {
      for (const r of ROUTES.filter((x) => x.method === 'GET' && /^\/networks\/\{networkId\}[^{]*$/.test(x.path))) {
        const q = typeof r.sample?.query === 'function' ? r.sample.query(sb.world, now) : r.sample?.query;
        const url = r.path.replace('{networkId}', net.id) + (q ? `?${q}` : '');
        const res = await sb.get(url);
        assert.ok(res.status < 500, `${url}: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
  };

  test('cloning copies settings and network shells without devices', async () => {
    fresh();
    const obj = await ok(sb.post(`${O}/policyObjects`, { name: 'Printers', category: 'network', type: 'cidr', cidr: '10.9.0.0/24' }), 201);
    const rules = { rules: [{ comment: 'printers', policy: 'deny', protocol: 'any', srcCidr: 'Any', destCidr: `OBJ(${obj.id})` }] };
    await ok(sb.put(`/networks/${hq.id}/appliance/firewall/l3FirewallRules`, rules));
    const vlans = await ok(sb.get(`/networks/${hq.id}/appliance/vlans`));
    await ok(sb.post(`${O}/insight/monitoredMediaServers`, { name: 'SIP', address: 'sip.example.com' }), 201);

    const made = await ok(sb.post(`${O}/clone`, { name: 'Acme Copy' }), 201);
    assert.equal(made.name, 'Acme Copy');
    assert.equal(made.licensing.model, 'co-term');
    const copy = sb.world.orgById.get(made.id);
    assert.deepEqual(
      copy.networks.map((n) => [n.name, n.productTypes, n.tags, n.timeZone]).sort(),
      org.networks.map((n) => [n.name, n.productTypes, n.tags, n.timeZone]).sort(),
    );
    assert.equal(copy.devices.length, 0);
    for (const n of copy.networks) assert.deepEqual([n.devices.length, n.clients.length], [0, 0]);
    const hqCopy = copy.networks.find((n) => n.name === hq.name);
    assert.notEqual(hqCopy.id, hq.id);
    assert.deepEqual((await ok(sb.get(`/networks/${hqCopy.id}/appliance/vlans`))).map((v) => [v.id, v.subnet]), vlans.map((v) => [v.id, v.subnet]));
    const copied = await ok(sb.get(`/networks/${hqCopy.id}/appliance/firewall/l3FirewallRules`));
    assert.equal(copied.rules[0].destCidr, `OBJ(${obj.id})`);
    assert.deepEqual((await ok(sb.get(`/organizations/${copy.id}/policyObjects`))).map((o) => o.name), ['Printers']);
    // Media servers and inventory stay behind.
    assert.deepEqual(await ok(sb.get(`/organizations/${copy.id}/insight/monitoredMediaServers`)), []);
    assert.deepEqual(await ok(sb.get(`/organizations/${copy.id}/devices`)), []);
    await noErrors(copy.networks);

    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    const labCopy = await ok(sb.post(`/organizations/${lab.id}/clone`, { name: 'Lab Copy' }), 201);
    assert.equal(labCopy.licensing.model, 'per-device');
    assert.deepEqual(await ok(sb.get(`/organizations/${labCopy.id}/licenses`)), []);
    assert.match(await errorOf(sb.post(`${O}/clone`, { name: ' ' })), /'name'/);
    assert.match(await errorOf(sb.post(`${O}/clone`, {})), /'name'/);
    assert.equal((await sb.post('/organizations/1/clone', { name: 'X' })).status, 404);
  });

  test('cloning copies a bound network with its template settings, unbound', async () => {
    fresh();
    const tpl = await ok(sb.post(`${O}/configTemplates`, { name: 'Branches' }), 201);
    const austin = org.networks.find((n) => n.name === 'Branch - Austin');
    await ok(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: tpl.id }));
    const made = await ok(sb.post(`${O}/clone`, { name: 'Acme Copy' }), 201);
    const copy = sb.world.orgById.get(made.id).networks.find((n) => n.name === austin.name);
    assert.equal(copy.template, undefined);
    const net = await ok(sb.get(`/networks/${copy.id}`));
    assert.equal(net.isBoundToConfigTemplate, false);
    assert.equal((await sb.get(`/networks/${copy.id}/appliance/vlans`)).status, 200);
    await noErrors([copy]);
  });

  describe('auto locate views', () => {
    const plans = async (...counts) => {
      const L = `/networks/${hq.id}/floorPlans`;
      const out = [];
      let next = 0;
      for (const [i, n] of counts.entries()) {
        const p = await ok(sb.post(L, { name: `Floor ${i + 1}`, center: { lat: 37.77 + i / 100, lng: -122.42 }, imageContents: 'R0lGODlhAQABAAAAACw=' }), 201);
        const aps = hq.aps.slice(next, (next += n));
        await ok(sb.post(`${L}/devices/batchUpdate`, { assignments: aps.map((d) => ({ serial: d.serial, floorPlan: { id: p.floorPlanId } })) }));
        out.push({ ...p, aps });
      }
      return out;
    };
    const schedule = async (...jobs) => (await ok(sb.post(`/networks/${hq.id}/floorPlans/autoLocate/jobs/batch`, { jobs }))).jobs;

    test('devices and statuses follow plans and jobs', async () => {
      fresh();
      const D = `${O}/floorPlans/autoLocate/devices`;
      const S = `${O}/floorPlans/autoLocate/statuses`;
      const empty = [{ items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } }];
      assert.deepEqual(await ok(sb.get(D)), empty);
      assert.deepEqual(await ok(sb.get(S)), empty);

      const [a, b] = await plans(3, 2);
      const [done] = await schedule({ floorPlanId: a.floorPlanId, refresh: ['gnss', 'ranging'], scheduledAt: '2026-09-29T18:00:00Z' });
      const [[devs], [stats]] = [await ok(sb.get(D)), await ok(sb.get(S))];
      assert.equal(devs.items.length, 5);
      const row = devs.items.find((d) => d.serial === a.aps[0].serial);
      assert.deepEqual(row.network, { id: hq.id });
      assert.deepEqual(row.floorPlan, { id: a.floorPlanId, name: 'Floor 1' });
      assert.equal(row.type, 'suggested');
      assert.equal(row.isAnchor, false);
      assert.ok(row.autoLocate.lat !== row.lat || row.autoLocate.lng !== row.lng);
      const other = devs.items.find((d) => d.serial === b.aps[0].serial);
      assert.deepEqual([other.autoLocate, other.type], [null, null]);

      const sa = stats.items.find((s) => s.floorPlanId === a.floorPlanId);
      assert.deepEqual(sa.counts, { devices: { total: 3 } });
      assert.equal(sa.name, 'Floor 1');
      const { networkId, floorPlanId, ...job } = done;
      assert.deepEqual(sa.jobs, [job]);
      assert.deepEqual(stats.items.find((s) => s.floorPlanId === b.floorPlanId).jobs, []);

      // Publishing moves the APs to the calculated spot the devices view suggested.
      await ok(sb.post(`/networks/${hq.id}/floorPlans/autoLocate/jobs/${done.id}/publish`));
      const after = (await ok(sb.get(D)))[0].items.find((d) => d.serial === a.aps[0].serial);
      assert.equal(after.type, 'calculated');
      assert.deepEqual(after.autoLocate, row.autoLocate);
      assert.deepEqual([after.lat, after.lng], [row.autoLocate.lat, row.autoLocate.lng]);
      assert.equal((await ok(sb.get(S)))[0].items.find((s) => s.floorPlanId === a.floorPlanId).jobs[0].status, 'published');

      // An anchor saved by recalculating is the admin's own position.
      await ok(sb.post(`/networks/${hq.id}/floorPlans/autoLocate/jobs/${done.id}/recalculate`, { devices: [{ serial: a.aps[1].serial, autoLocate: { isAnchor: true, lat: 37.7749, lng: -122.4194 } }] }));
      const anchor = (await ok(sb.get(D)))[0].items.find((d) => d.serial === a.aps[1].serial);
      assert.deepEqual([anchor.autoLocate, anchor.type, anchor.isAnchor], [{ lat: 37.7749, lng: -122.4194 }, 'user', true]);

      // Filters and paging.
      assert.deepEqual((await ok(sb.get(`${D}?floorPlanIds[]=${b.floorPlanId}`)))[0].items.map((d) => d.serial).sort(), b.aps.map((d) => d.serial).sort());
      assert.equal((await ok(sb.get(`${S}?networkIds[]=${org.networks[1].id}`)))[0].items.length, 0);
      const page = await sb.get(`${D}?perPage=3`);
      assert.deepEqual([page.body[0].items.length, page.body[0].meta.counts.items], [3, { total: 5, remaining: 2 }]);
      assert.match(page.link, /rel=next/);
      assert.match(await errorOf(sb.get(`${D}?perPage=10001`)), /perPage/);
    });
  });
});
