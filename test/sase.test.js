import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { linkSample } from '../src/sim/links.js';
import { activeUplink, isDown } from '../src/sim/outages.js';
import { iso } from '../src/time.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;
const KEYS = { api: { key: 'sse-key', secret: 'sse-secret' } };

describe('Secure Access', () => {
  let sb;
  let corp;
  let lab;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    O = `/organizations/${corp.id}/sase`;
  };
  const net = (name) => corp.networks.find((n) => n.name === name);
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
  const attach = (...pairs) => ok(sb.post(`${O}/sites/attach`, { items: pairs.map(([n, slug]) => ({ network: { id: n.id }, region: { slug } })) }), 202);

  test('eligible networks are the MX networks, and regions are a fixed list', async () => {
    fresh();
    const rows = await collect(sb.get, `${O}/networks/eligible?perPage=3`);
    assert.deepEqual(rows.map((r) => r.name).sort(), corp.networks.map((n) => n.name).sort());
    const hq = rows.find((r) => r.name === 'HQ - San Francisco');
    assert.deepEqual(hq, { networkId: net('HQ - San Francisco').id, type: 'Meraki hub', name: 'HQ - San Francisco', region: { name: 'US West' }, device: { primary: { model: 'MX250' } }, address: { street: 'San Francisco, CA, USA' }, vpn: { type: 'hub' }, routing: { defaultRoute: { enabled: true } } });
    assert.equal(rows.find((r) => r.name === 'Remote - London').region.name, 'EU West');
    assert.deepEqual((await ok(sb.get(`${O}/networks/eligible?search=reno`))).items.map((r) => r.name), ['Warehouse - Reno']);
    // Acme Test Lab's only MX is Ottawa's MX68W.
    const labRows = (await ok(sb.get(`/organizations/${lab.id}/sase/networks/eligible`))).items;
    assert.deepEqual(labRows.map((r) => [r.name, r.device.primary.model, r.vpn.type, r.region.name]), [['Lab - Ottawa', 'MX68W', 'off', 'Canada Central']]);
    const regions = await ok(sb.get(`${O}/regions`));
    assert.equal(regions.items.length, regions.meta.counts.items.total);
    assert.ok(regions.items.every((r) => r.connector.id === null && r.type === 'Cloud Native Head End'));
    assert.deepEqual(await ok(sb.get(`${O}/sites`)), { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    assert.deepEqual(await ok(sb.get(`${O}/connectors`)), { items: [] });
    assert.deepEqual(await ok(sb.get(`${O}/sites/connectivity/overview`)), { counts: { byStatus: { healthy: { total: 0 }, degraded: { total: 0 }, offline: { total: 0 } }, total: 0 } });
  });

  test('one integration per organization, which keeps its credentials to itself', async () => {
    fresh();
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: net('HQ - San Francisco').id }, region: { slug: 'us-west-1' } }] })), /no Secure Access integration/);
    assert.match(await errorOf(sb.post(`${O}/integrations`, { api: { key: '', secret: 's' } })), /'api.key'/);
    const made = await ok(sb.post(`${O}/integrations`, KEYS), 201);
    assert.deepEqual(made, { integrationId: made.integrationId, integrated: { by: { admin: { name: sb.world.apiAdmin.name } }, at: NOW }, lastUsedAt: NOW, external: { organization: { id: made.external.organization.id } }, status: 'active' });
    assert.ok(!JSON.stringify(made).includes('sse-secret'));
    assert.match(await errorOf(sb.post(`${O}/integrations`, KEYS)), /already has/);
    assert.deepEqual(await ok(sb.get(`${O}/integrations/${made.integrationId}`)), made);
    await errorOf(sb.get(`${O}/integrations/1`), 404);
    await errorOf(sb.get(`/organizations/${lab.id}/sase/integrations/${made.integrationId}`), 404);

    // Deleting it detaches every site.
    await attach([net('HQ - San Francisco'), 'us-west-1']);
    assert.equal((await ok(sb.del(`${O}/integrations/${made.integrationId}`), 204)), '');
    assert.deepEqual((await ok(sb.get(`${O}/sites`))).items, []);
    assert.deepEqual((await ok(sb.get(`${O}/connectors`))).items, []);
    await errorOf(sb.get(`${O}/integrations/${made.integrationId}`), 404);
    const again = await ok(sb.post(`${O}/integrations`, KEYS), 201);
    assert.notEqual(again.integrationId, made.integrationId);
  });

  test('attaching sites deploys a connector per region and checks every item first', async () => {
    fresh();
    await ok(sb.post(`${O}/integrations`, KEYS), 201);
    const hq = net('HQ - San Francisco');
    const lon = net('Remote - London');
    const reno = net('Warehouse - Reno');
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [] })), /at least one/);
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: lab.networks[0].id }, region: { slug: 'us-west-1' } }] })), /not an MX network/);
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: hq.id }, region: { slug: 'mars-1' } }] })), /region.slug/);
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: hq.id }, region: { slug: 'us-west-1' } }, { network: { id: hq.id }, region: { slug: 'us-west-1' } }] })), /listed twice/);
    // A bad second item leaves the first unattached.
    await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: hq.id }, region: { slug: 'us-west-1' } }, { network: { id: 'N_1' }, region: { slug: 'us-west-1' } }] }));
    assert.deepEqual((await ok(sb.get(`${O}/sites`))).items, []);

    const job = await attach([hq, 'us-west-1'], [lon, 'eu-west-1'], [reno, 'us-west-1']);
    const done = (n) => ({ completed: n, failed: 0, pending: 0 });
    assert.deepEqual(job, {
      pipelineId: job.pipelineId,
      operation: { id: 'attachOrganizationSaseSites' },
      status: 'completed',
      counts: {
        jobs: { total: 6, byStatus: done(6) },
        byJobOperation: [
          { name: 'enroll wired site', total: 3, byStatus: done(3) },
          { name: 'deploy CNHE SSE connector', total: 2, byStatus: done(2) },
          { name: 'complete bulk enrollment', total: 1, byStatus: done(1) },
        ],
      },
    });
    assert.match(await errorOf(sb.post(`${O}/sites/attach`, { items: [{ network: { id: hq.id }, region: { slug: 'us-west-1' } }] })), /already attached/);
    const sites = (await ok(sb.get(`${O}/sites`))).items;
    assert.deepEqual(sites.map((s) => s.network.id), [hq.id, lon.id, reno.id]);
    assert.deepEqual(sites[0], {
      siteId: sites[0].siteId,
      network: { id: hq.id },
      type: 'Meraki hub',
      name: hq.name,
      region: { slug: 'us-west-1' },
      model: 'MX250',
      address: { street: hq.address },
      vpn: { type: 'hub' },
      routing: { defaultRoute: { enabled: true } },
      devices: { primary: { name: hq.mx.name, model: 'MX250' } },
      subnets: (await ok(sb.get(`/networks/${hq.id}/appliance/vlans`))).map((v) => ({ subnet: v.subnet })),
      url: hq.url,
    });
    // Attached networks leave the eligible list.
    assert.deepEqual((await collect(sb.get, `${O}/networks/eligible`)).map((r) => r.networkId).sort(), corp.networks.filter((n) => ![hq, lon, reno].includes(n)).map((n) => n.id).sort());
    const conns = (await ok(sb.get(`${O}/connectors`))).items;
    assert.deepEqual(conns.map((c) => [c.region.slug, c.state, c.counts.sitesConnected.total]), [['us-west-1', 'deployed', 2], ['eu-west-1', 'deployed', 1]]);
    const regions = (await ok(sb.get(`${O}/regions`))).items;
    assert.equal(regions.find((r) => r.slug === 'eu-west-1').connector.id, conns[1].id);

    // Filters and paging.
    assert.deepEqual((await ok(sb.get(`${O}/sites?search=london`))).items.map((s) => s.siteId), [sites[1].siteId]);
    assert.deepEqual((await ok(sb.get(`${O}/sites?siteId=${sites[2].siteId}`))).items.map((s) => s.siteId), [sites[2].siteId]);
    assert.deepEqual((await collect(sb.get, `${O}/sites?perPage=3`)).length, 3);
    assert.match(await errorOf(sb.get(`${O}/sites?status=great`)), /'status'/);

    // Connectors with sites can't go; detaching keeps the connector.
    assert.match(await errorOf(sb.post(`${O}/connectors/batchDelete`, { items: [{ connectorId: conns[1].id }] })), /detach them first/);
    assert.match(await errorOf(sb.post(`${O}/sites/detach`, { items: [{ siteId: '42' }] })), /not a Secure Access site/);
    const off = await ok(sb.post(`${O}/sites/detach`, { items: [{ siteId: sites[1].siteId }] }), 202);
    assert.deepEqual(off.counts.byJobOperation.map((x) => [x.name, x.total]), [['detach wired site', 1], ['complete bulk detachment', 1]]);
    assert.equal((await ok(sb.get(`${O}/connectors`))).items[1].counts.sitesConnected.total, 0);
    assert.match(await errorOf(sb.post(`${O}/connectors/batchDelete`, { items: [{ connectorId: '7' }] })), /not a connector/);
    const gone = await ok(sb.post(`${O}/connectors/batchDelete`, { items: [{ connectorId: conns[1].id }] }), 202);
    assert.deepEqual(gone.counts.byJobOperation, [{ name: 'teardown CNHE SSE connector', total: 1, byStatus: done(1) }]);
    assert.deepEqual((await ok(sb.get(`${O}/connectors`))).items.map((c) => c.id), [conns[0].id]);
  });

  test('a site update changes only default route enablement', async () => {
    fresh();
    await ok(sb.post(`${O}/integrations`, KEYS), 201);
    await attach([net('Branch - Austin'), 'us-east-1']);
    const [site] = (await ok(sb.get(`${O}/sites`))).items;
    const P = `${O}/sites/${site.siteId}`;
    const upd = await ok(sb.put(P, { siteId: site.siteId, routing: { defaultRoute: { enabled: false } } }));
    const { devices, subnets, url, ...short } = site;
    assert.deepEqual(upd, { ...short, routing: { defaultRoute: { enabled: false } } });
    assert.equal((await ok(sb.get(`${O}/sites`))).items[0].routing.defaultRoute.enabled, false);
    assert.match(await errorOf(sb.put(P, { siteId: '1', routing: { defaultRoute: { enabled: true } } })), /does not match/);
    assert.match(await errorOf(sb.put(P, { routing: { defaultRoute: { enabled: 'yes' } } })), /enabled/);
    await errorOf(sb.put(`${O}/sites/99`, { routing: { defaultRoute: { enabled: true } } }), 404);
  });

  test('site connectivity agrees with the MX link sim', async () => {
    fresh();
    await ok(sb.post(`${O}/integrations`, KEYS), 201);
    await attach(...corp.networks.map((n) => [n, 'us-west-1']));
    // Pretend the sites were attached a week ago, so history has data.
    for (const s of corp.sase.sites) s.attachedAt = s.readyAt = now - 7 * 86400;
    const hist = (await ok(sb.get(`${O}/sites/connectivity/history/bySite?timespan=-7days`))).items;
    assert.equal(hist.length, 5);
    const seen = new Set();
    for (const h of hist) {
      const n = corp.networks.find((x) => x.name === h.name);
      assert.equal(h.devices.primary.id, n.mx.serial);
      assert.deepEqual(h.devices.primary.history, h.history);
      assert.equal(h.history.length, 168);
      for (const p of h.history) {
        const t = Date.parse(p.timestamp) / 1000;
        const up = activeUplink(n.mx, t);
        const l = up && linkSample(n.mx, up, t);
        const want = isDown(n.mx, t) || !up ? 'offline' : l.lossPercent < 5 && l.latencyMs < 150 ? 'good' : /bad tunnel/;
        if (typeof want === 'string') assert.equal(p.status, want, `${h.name} ${p.timestamp}`);
        else assert.match(p.status, want);
        seen.add(p.status);
      }
    }
    assert.ok(seen.has('good') && seen.size > 1, [...seen].join());
    const last = hist.map((h) => h.history.at(-1).status);
    const over = await ok(sb.get(`${O}/sites/connectivity/overview`));
    assert.equal(over.counts.byStatus.healthy.total, last.filter((s) => s === 'good').length);
    assert.equal(over.counts.byStatus.offline.total, last.filter((s) => s === 'offline').length);
    assert.equal(over.counts.total, 5);
    const good = (await ok(sb.get(`${O}/sites?status=good`))).items.length;
    assert.equal(good, over.counts.byStatus.healthy.total);

    // Two hours at five minutes by default, and only the sites asked for.
    const id = corp.sase.sites[1].siteId;
    const two = (await ok(sb.get(`${O}/sites/connectivity/history/bySite?siteIds[]=${id}`))).items;
    assert.deepEqual(two.map((x) => x.siteId), [id]);
    assert.equal(two[0].history.length, 25);
    assert.equal(two[0].history.at(-1).timestamp, iso(now));
    assert.match(await errorOf(sb.get(`${O}/sites/connectivity/history/bySite?timespan=-8days`)), /timespan/);
    assert.match(await errorOf(sb.get(`${O}/sites/connectivity/history/bySite?timespan=soon`)), /timespan/);
  });

  test('history before an attach is unknown, and a warm spare has its own history', async () => {
    fresh();
    await ok(sb.post(`${O}/integrations`, KEYS), 201);
    const hq = net('HQ - San Francisco');
    await attach([hq, 'us-west-1']);
    const [h] = (await ok(sb.get(`${O}/sites/connectivity/history/bySite?timespan=-30minutes`))).items;
    assert.deepEqual(h.history.map((p) => p.status).slice(0, -1), Array(6).fill('unknown'));
    assert.equal(h.devices.spare, undefined);
  });

  test('sites follow split, block moves and drop out with their network or template', async () => {
    fresh();
    await ok(sb.post(`${O}/integrations`, KEYS), 201);
    const hq = net('HQ - San Francisco');
    const austin = net('Branch - Austin');
    await attach([hq, 'us-west-1'], [austin, 'us-east-1']);
    const dest = (await sb.post('/organizations', { name: 'Acme West' })).body;
    const move = await ok(sb.post(`/organizations/${corp.id}/networks/moves`, { network: { id: austin.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.match(move.result.reason, /Secure Access/);

    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const mxPart = parts.find((p) => p.productTypes.includes('appliance'));
    assert.deepEqual((await ok(sb.get(`${O}/sites`))).items.map((s) => s.network.id), [mxPart.id, austin.id]);

    await ok(sb.del(`/networks/${austin.id}`), 204);
    assert.deepEqual((await ok(sb.get(`${O}/sites`))).items.map((s) => s.network.id), [mxPart.id]);

    // A template with the appliance product can attach too.
    const t = await ok(sb.post(`/organizations/${corp.id}/configTemplates`, { name: 'Branches', copyFromNetworkId: net('Retail - Denver').id }), 201);
    const row = (await collect(sb.get, `${O}/networks/eligible`)).find((r) => r.networkId === t.id);
    assert.deepEqual(row, { networkId: t.id, type: 'Meraki template', name: 'Branches', region: { name: 'US West' }, device: { primary: { model: null } }, address: { street: null }, vpn: { type: 'spoke' }, routing: { defaultRoute: { enabled: true } } });
    await ok(sb.post(`${O}/sites/attach`, { items: [{ network: { id: t.id }, region: { slug: 'us-west-1' } }] }), 202);
    const site = (await ok(sb.get(`${O}/sites`))).items.find((s) => s.network.id === t.id);
    assert.deepEqual([site.type, site.model, site.devices, site.url], ['Meraki template', null, { primary: null }, null]);
    assert.equal((await ok(sb.get(`${O}/sites/connectivity/overview`))).counts.total, 2);
    await ok(sb.del(`/organizations/${corp.id}/configTemplates/${t.id}`), 204);
    assert.deepEqual((await ok(sb.get(`${O}/sites`))).items.map((s) => s.network.id), [mxPart.id]);
  });
});

describe('Secure Access in Acme Test Lab', () => {
  test("Ottawa's site follows it into a combined network", async () => {
    const sb = await start();
    try {
      const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
      const O = `/organizations/${lab.id}/sase`;
      const ottawa = lab.networks.find((n) => n.name === 'Lab - Ottawa');
      const toronto = lab.networks.find((n) => n.name === 'Lab - Toronto');
      assert.equal((await sb.post(`${O}/integrations`, KEYS)).status, 201);
      assert.equal((await sb.post(`${O}/sites/attach`, { items: [{ network: { id: ottawa.id }, region: { slug: 'ca-central-1' } }] })).status, 202);
      const combined = await sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Lab - Combined', networkIds: [ottawa.id, toronto.id] });
      assert.equal(combined.status, 200, JSON.stringify(combined.body));
      const [site] = (await sb.get(`${O}/sites`)).body.items;
      assert.deepEqual([site.network.id, site.name, site.model], [combined.body.resultingNetwork.id, 'Lab - Combined', 'MX68W']);
    } finally {
      sb.close();
    }
  });
});

describe('Secure Access on a running clock', () => {
  test('an attach is pending until its tunnels come up', async () => {
    const sb = await start({ now: null });
    try {
      const org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
      const O = `/organizations/${org.id}/sase`;
      assert.equal((await sb.post(`${O}/integrations`, KEYS)).status, 201);
      const job = (await sb.post(`${O}/sites/attach`, { items: [{ network: { id: org.networks[1].id }, region: { slug: 'us-east-1' } }] })).body;
      assert.equal(job.status, 'active');
      assert.deepEqual(job.counts.jobs.byStatus, { completed: 0, failed: 0, pending: 3 });
      assert.equal((await sb.get(`${O}/sites?status=no%20registry`)).body.items.length, 1);
      const [c] = (await sb.get(`${O}/connectors`)).body.items;
      assert.deepEqual([c.state, c.counts.sitesConnected.total], ['provisioned', 0]);
    } finally {
      sb.close();
    }
  });
});
