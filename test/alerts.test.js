import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, collect, relLink, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;
const DAY = 86400;
const at = (t) => new Date(t * 1000).toISOString().slice(0, 19) + 'Z';

describe('assurance alert actions', () => {
  let sb;
  let org;
  let hq;
  let A;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs[0];
    hq = org.networks[0];
    A = `/organizations/${org.id}/assurance/alerts`;
  };
  const everything = () => collect(sb.get, `${A}?resolved=true&dismissed=true&perPage=300`);

  test('the overviews by network and by type add up to the alert list', async () => {
    fresh();
    const q = 'resolved=true';
    const alerts = await collect(sb.get, `${A}?${q}&perPage=300`);
    assert.ok(alerts.some((a) => a.resolvedAt) && alerts.some((a) => !a.resolvedAt));
    assert.equal((await sb.get(`${A}/overview?${q}`)).body.counts.total, alerts.length);

    const byNetwork = (await sb.get(`${A}/overview/byNetwork?${q}`)).body;
    assert.equal(byNetwork.meta.counts.items, byNetwork.items.length);
    assert.equal(byNetwork.items.reduce((s, n) => s + n.alertCount, 0), alerts.length);
    for (const n of byNetwork.items) {
      const mine = alerts.filter((a) => a.network.id === n.networkId);
      assert.equal(n.alertCount, mine.length);
      assert.equal(n.lastAlertedAt, mine.map((a) => a.startedAt).sort().at(-1));
      for (const s of n.severityCounts) assert.equal(s.count, mine.filter((a) => a.severity === s.type).length);
    }

    const byType = (await sb.get(`${A}/overview/byType?${q}&includeNetworks=true`)).body;
    assert.equal(byType.items.reduce((s, t) => s + t.count, 0), alerts.length);
    for (const t of byType.items) {
      const mine = alerts.filter((a) => a.type === t.type && a.severity === t.severity);
      assert.equal(t.count, mine.length);
      assert.equal(t.networkCount, new Set(mine.map((a) => a.network.id)).size);
      assert.deepEqual(t.networks.map((n) => n.id).sort(), [...new Set(mine.map((a) => a.network.id))].sort());
      assert.deepEqual(t.deviceTypes, [...new Set(mine.map((a) => a.deviceType))].sort());
      const resolved = mine.filter((a) => a.resolvedAt).map((a) => a.resolvedAt).sort();
      assert.equal(t.lastResolvedAt, resolved.at(-1));
    }
  });

  test('byType lists tags and networks only when asked, and sorts', async () => {
    fresh();
    const plain = (await sb.get(`${A}/overview/byType?resolved=true`)).body.items;
    assert.ok(plain.every((t) => t.deviceTags.length === 0 && t.networks.length === 0));
    // Only active alerts: nothing has resolved, so there is no lastResolvedAt.
    assert.ok((await sb.get(`${A}/overview/byType`)).body.items.every((t) => !('lastResolvedAt' in t)));
    const wan = (await sb.get(`${A}/overview/byType?resolved=true&includeDeviceTags=true&types[]=wan_status`)).body.items;
    assert.ok(wan.length && wan.every((t) => t.deviceTags.includes('edge')));
    const byCount = (await sb.get(`${A}/overview/byType?resolved=true&sortBy=count&sortOrder=descending`)).body.items.map((t) => t.count);
    assert.deepEqual(byCount, [...byCount].sort((a, b) => b - a));
    assert.equal((await sb.get(`${A}/overview/byType?sortBy=constructor`)).status, 400);
    assert.equal((await sb.get(`${A}/overview/byNetwork?sortOrder=sideways`)).status, 400);
  });

  test('byNetwork pages with Link headers', async () => {
    fresh();
    const all = (await sb.get(`${A}/overview/byNetwork?resolved=true`)).body.items;
    assert.ok(all.length > 3);
    const seen = [];
    let url = `${A}/overview/byNetwork?resolved=true&perPage=3`;
    while (url) {
      const r = await sb.get(url);
      assert.equal(r.body.meta.counts.items, all.length);
      seen.push(...r.body.items);
      url = relLink(r.link, 'next');
    }
    assert.deepEqual(seen, all);
    const desc = (await sb.get(`${A}/overview/byNetwork?resolved=true&sortOrder=descending`)).body.items;
    assert.deepEqual(desc, [...all].reverse());
  });

  test('historical segments count the alerts open in each one', async () => {
    fresh();
    const from = now - 5 * DAY;
    const step = 6 * 3600;
    const r = await sb.get(`${A}/overview/historical?segmentDuration=${step}&tsStart=${at(from)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.items.length, 20);
    assert.equal(r.body.meta.counts.items, 20);
    const alerts = await everything();
    const t = (s) => (s == null ? null : Date.parse(s) / 1000);
    r.body.items.forEach((seg, i) => {
      assert.equal(seg.segmentStart, at(from + i * step));
      const open = alerts.filter((a) => t(a.startedAt) < from + (i + 1) * step && (a.resolvedAt == null || t(a.resolvedAt) > from + i * step));
      for (const s of ['critical', 'warning', 'informational']) {
        assert.equal(seg.totals[s], open.filter((a) => a.severity === s).length);
        assert.equal(seg.byAlertType.reduce((sum, x) => sum + x[s], 0), seg.totals[s]);
      }
    });
    // The CRC errors alert has been open the whole time.
    assert.ok(r.body.items.every((seg) => seg.byAlertType.some((x) => x.type === 'crc_errors' && x.warning === 1)));
  });

  test('historical checks its parameters', async () => {
    fresh();
    const h = (q) => sb.get(`${A}/overview/historical?${q}`);
    assert.match((await h(`tsStart=${at(now - DAY)}`)).body.errors[0], /segmentDuration' is required/);
    assert.match((await h('segmentDuration=3600')).body.errors[0], /tsStart' is required/);
    assert.equal((await h(`segmentDuration=0&tsStart=${at(now - DAY)}`)).status, 400);
    assert.equal((await h(`segmentDuration=60&tsStart=${at(now - 30 * DAY)}`)).status, 400, 'too many segments');
    assert.equal((await h(`segmentDuration=86400&tsStart=${at(now - 40 * DAY)}`)).status, 400, 'beyond the lookback');
    assert.equal((await h(`segmentDuration=3600&tsStart=${at(now - DAY)}&tsEnd=${at(now - 2 * DAY)}`)).status, 400);
    const partial = (await h(`segmentDuration=7200&tsStart=${at(now - 5 * 3600)}`)).body.items;
    assert.equal(partial.length, 3, 'the last segment is cut short at now');
  });

  test('dismissed alerts leave the active views until restored', async () => {
    fresh();
    const active = (await sb.get(`${A}?perPage=300`)).body;
    const cam = active.find((a) => a.type === 'unreachable' && a.network.id !== hq.id);
    const total = (await sb.get(`${A}/overview`)).body.counts.total;
    const history = (await sb.get(`${A}/overview/historical?segmentDuration=86400&tsStart=${at(now - 7 * DAY)}`)).body;

    const r = await sb.post(`${A}/dismiss`, { alertIds: [cam.id] });
    assert.equal(r.status, 204);
    assert.equal(r.body, '');
    assert.ok(!(await sb.get(`${A}?perPage=300`)).body.some((a) => a.id === cam.id));
    assert.equal((await sb.get(`${A}/overview`)).body.counts.total, total - 1);
    const healthy = (await sb.get(`/networks/${cam.network.id}/health/alerts`)).body;
    assert.ok(!healthy.some((a) => a.id === cam.id));

    const dismissed = (await sb.get(`${A}?active=false&dismissed=true`)).body;
    assert.deepEqual(dismissed.map((a) => a.id), [cam.id]);
    assert.equal(dismissed[0].dismissedAt, NOW);
    assert.equal((await sb.get(`${A}/${cam.id}`)).body.dismissedAt, dismissed[0].dismissedAt);
    const both = (await sb.get(`${A}?dismissed=true&sortBy=dismissedAt&perPage=300`)).body;
    assert.equal(both.length, active.length);
    assert.equal(both.at(0).id, cam.id, 'dismissed ones sort before never dismissed ones');
    // History is about when alerts were open, so dismissing doesn't change it.
    assert.deepEqual((await sb.get(`${A}/overview/historical?segmentDuration=86400&tsStart=${at(now - 7 * DAY)}`)).body, history);

    assert.equal((await sb.post(`${A}/restore`, { alertIds: [cam.id] })).status, 204);
    const back = (await sb.get(`${A}?perPage=300`)).body;
    assert.deepEqual(back, active);
  });

  test('dismiss and restore change nothing when an ID is unknown', async () => {
    fresh();
    const [first] = (await sb.get(`${A}?perPage=300`)).body;
    const r = await sb.post(`${A}/dismiss`, { alertIds: [first.id, '12345'] });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body.errors, ['Alert 12345 not found']);
    assert.equal((await sb.get(`${A}/${first.id}`)).body.dismissedAt, null);
    assert.equal((await sb.post(`${A}/restore`, { alertIds: ['12345'] })).status, 404);
    assert.equal((await sb.post(`${A}/dismiss`, { alertIds: [] })).status, 400);
    assert.equal((await sb.post(`${A}/dismiss`, {})).status, 400);
    // Another organization's alert isn't this one's.
    const lab = sb.world.orgs[1];
    assert.equal((await sb.post(`/organizations/${lab.id}/assurance/alerts/dismiss`, { alertIds: [first.id] })).status, 404);
  });

  test('a reset brings dismissed alerts back', async () => {
    fresh();
    const [first] = (await sb.get(`${A}?perPage=300`)).body;
    await sb.post(`${A}/dismiss`, { alertIds: [first.id] });
    assert.equal((await sb.reset()).status, 204);
    fresh();
    assert.equal((await sb.get(`${A}/${first.id}`)).body.dismissedAt, null);
  });

  test('the taxonomy covers every alert the emulator raises', async () => {
    fresh();
    const types = (await sb.get(`${A}/taxonomy/types`)).body;
    const categories = (await sb.get(`${A}/taxonomy/categories`)).body.map((c) => c.type);
    assert.deepEqual(categories, ['configuration', 'connectivity', 'device_health', 'experience_metrics', 'insights']);
    for (const a of await everything()) {
      const t = types.find((x) => x.type === a.type);
      assert.ok(t, `${a.type} is in the taxonomy`);
      assert.equal(t.title, a.title);
      assert.equal(t.categoryType, a.categoryType);
      assert.ok(t.severities.some((s) => s.type === a.severity));
      assert.ok(t.deviceTypes.includes(a.deviceType));
    }
    for (const t of types) assert.ok(categories.includes(t.categoryType));
  });
});

describe('assurance alert profiles', () => {
  let sb;
  let org;
  let hq;
  let P;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs[0];
    hq = org.networks[0];
    P = `/organizations/${org.id}/assurance/alerts/profiles`;
  };
  const hook = async (net = hq, url = 'https://hooks.example.com/noc') => (await sb.post(`/networks/${net.id}/webhooks/httpServers`, { name: 'NOC', url })).body;
  const body = (fields = {}) => ({
    name: 'Core',
    networkIds: [hq.id],
    alertTypes: ['unreachable', 'vlan_mismatch'],
    configuration: { enabled: true, alertDestinations: { email: { enabled: true, recipients: ['noc@example.com'] }, webhook: { enabled: false } } },
    ...fields,
  });

  test('profiles start empty and can be created, listed, updated and deleted', async () => {
    fresh();
    assert.deepEqual((await sb.get(P)).body, { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    const server = await hook();
    const created = await sb.post(P, body({ configuration: { alertDestinations: { email: { enabled: true, recipients: ['noc@example.com'] }, webhook: { enabled: true, recipients: [server.id] } } } }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const p = created.body;
    assert.match(p.profileId, /^\d{14}$/);
    assert.equal(p.organizationId, org.id);
    assert.equal(p.alertScheduleId, null);
    assert.deepEqual(p.configuration, {
      enabled: true,
      maintenance: { silencing: { enabled: false } },
      alertDestinations: {
        email: { enabled: true, recipients: ['noc@example.com'] },
        sms: { enabled: false, recipients: [] },
        webhook: { enabled: true, recipients: [{ id: server.id, name: 'NOC', url: 'https://hooks.example.com/noc' }] },
      },
    });
    const list = (await sb.get(P)).body;
    assert.deepEqual(list.items, [p]);
    assert.equal(list.meta.counts.items.total, 1);

    // Every field is required on update, and the profile is replaced.
    assert.equal((await sb.put(`${P}/${p.profileId}`, { name: 'Renamed' })).status, 400);
    const updated = await sb.put(`${P}/${p.profileId}`, body({ name: 'Renamed', alertScheduleId: '42', configuration: { enabled: false } }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.profileId, p.profileId);
    assert.equal(updated.body.name, 'Renamed');
    assert.equal(updated.body.alertScheduleId, '42');
    assert.deepEqual(updated.body.configuration.alertDestinations.webhook, { enabled: false, recipients: [] });
    assert.deepEqual((await sb.get(P)).body.items, [updated.body]);

    assert.equal((await sb.get(`${P}/${p.profileId}`)).status, 405, 'the spec has no GET for one profile');
    assert.equal((await sb.del(`${P}/${p.profileId}`)).status, 204);
    assert.equal((await sb.del(`${P}/${p.profileId}`)).status, 404);
    assert.equal((await sb.put(`${P}/${p.profileId}`, body())).status, 404);
    assert.deepEqual((await sb.get(P)).body.items, []);
  });

  test('profiles check their networks, alert types and webhooks', async () => {
    fresh();
    const lab = sb.world.orgs[1];
    const bad = async (b) => {
      const r = await sb.post(P, b);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      return r.body.errors[0];
    };
    assert.match(await bad(body({ networkIds: [lab.networks[0].id] })), /is not in this organization/);
    assert.match(await bad(body({ alertTypes: ['unreachable', 'cosmic_rays'] })), /'cosmic_rays' is not an assurance alert type/);
    assert.match(await bad(body({ name: '  ' })), /must not be empty/);
    const labHook = await hook(lab.networks[0]);
    assert.match(await bad(body({ configuration: { alertDestinations: { email: { enabled: false }, webhook: { enabled: true, recipients: [labHook.id] } } } })), /does not exist in this organization/);
    assert.match(await bad({ name: 'x', networkIds: [], alertTypes: [] }), /'configuration' is required/);
    // A type the emulator never raises is still a real one.
    assert.equal((await sb.post(P, body({ alertTypes: ['poe_overload'] }))).status, 201);
  });

  test('deleted webhook servers and networks drop out of profiles', async () => {
    fresh();
    const denver = org.networks.find((n) => n.code === 'DEN');
    const server = await hook();
    const p = (await sb.post(P, body({ networkIds: [hq.id, denver.id], configuration: { alertDestinations: { email: { enabled: false }, webhook: { enabled: true, recipients: [server.id] } } } }))).body;
    assert.equal((await sb.del(`/networks/${hq.id}/webhooks/httpServers/${server.id}`)).status, 204);
    assert.equal((await sb.del(`/networks/${denver.id}`)).status, 204);
    const [after] = (await sb.get(P)).body.items;
    assert.equal(after.profileId, p.profileId);
    assert.deepEqual(after.networkIds, [hq.id]);
    assert.deepEqual(after.configuration.alertDestinations.webhook.recipients, []);
  });

  test('the same calls give the same profile IDs after a reset', async () => {
    fresh();
    const first = (await sb.post(P, body())).body.profileId;
    const second = (await sb.post(P, body({ name: 'Second' }))).body.profileId;
    assert.notEqual(first, second);
    assert.equal((await sb.reset()).status, 204);
    fresh();
    assert.equal((await sb.post(P, body())).body.profileId, first);
  });
});
