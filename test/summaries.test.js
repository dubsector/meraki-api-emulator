import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { clientUsage } from '../src/sim/usage.js';
import { NOW, collect, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

describe('organization summaries', () => {
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
    org = sb.world.orgs[0];
    hq = org.networks[0];
    O = `/organizations/${org.id}`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };

  test('top appliances score the same as appliance performance', async () => {
    fresh();
    const q = `t0=${at(-3600)}&t1=${NOW}`;
    const rows = (await sb.get(`${O}/summary/top/appliances/byUtilization?${q}`)).body;
    assert.equal(rows.length, org.networks.filter((n) => n.mx).length);
    for (const r of rows) {
      const perf = (await sb.get(`/devices/${r.serial}/appliance/performance?${q}`)).body;
      assert.equal(r.utilization.average.percentage, perf.perfScore);
    }
    const scores = rows.map((r) => r.utilization.average.percentage);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal((await sb.get(`${O}/summary/top/appliances/byUtilization?quantity=2`)).body.length, 2);
    assert.deepEqual((await sb.get(`${O}/summary/top/appliances/byUtilization?networkTag=emea`)).body.map((r) => r.network.name), ['Remote - London']);
    assert.match(await errorOf(sb.get(`${O}/summary/top/appliances/byUtilization?timespan=600`)), /greater than or equal to 1500/);
    assert.match(await errorOf(sb.get(`${O}/summary/top/appliances/byUtilization?quantity=51`)), /quantity/);
  });

  test('application categories add up to the top applications', async () => {
    fresh();
    const cats = (await sb.get(`${O}/summary/top/applications/categories/byUsage?quantity=50`)).body;
    const apps = (await sb.get(`${O}/summary/top/applications/byUsage?quantity=50`)).body;
    close(sum(cats.map((c) => c.total)), sum(apps.map((a) => a.total)), 2);
    close(sum(cats.map((c) => c.percentage)), 100, 0.01);
    const zoom = apps.filter((a) => ['Zoom', 'Webex'].includes(a.application));
    close(cats.find((c) => c.category === 'VoIP & video conferencing').total, sum(zoom.map((a) => a.total)), 0.2);
    // Apps the Layer 7 list doesn't have keep their own category.
    assert.ok(cats.some((c) => c.category === 'Miscellaneous'));
    assert.deepEqual(Object.keys(cats[0]), ['category', 'total', 'downstream', 'upstream', 'percentage']);
    assert.match(await errorOf(sb.get(`${O}/summary/top/applications/categories/byUsage?timespan=60`)), /1500/);
  });

  test('manufacturers group the clients that used data', async () => {
    fresh();
    const rows = (await sb.get(`${O}/summary/top/clients/manufacturers/byUsage?quantity=50&timespan=86400`)).body;
    const used = org.networks.flatMap((n) => n.clients).filter((c) => {
      const u = clientUsage(c, T - 86400, T);
      return u.sent + u.recv > 0;
    });
    assert.equal(sum(rows.map((r) => r.clients.counts.total)), used.length);
    const apple = used.filter((c) => c.manufacturer === 'Apple');
    assert.equal(rows.find((r) => r.name === 'Apple').clients.counts.total, apple.length);
    close(rows.find((r) => r.name === 'Apple').usage.total, sum(apple.map((c) => {
      const u = clientUsage(c, T - 86400, T);
      return (u.sent + u.recv) / 1024;
    })), 0.1);
    const guest = (await sb.get(`${O}/summary/top/clients/manufacturers/byUsage?quantity=50&ssidName=${encodeURIComponent(hq.ssids.find((s) => s.key === 'guest').name)}`)).body;
    assert.ok(sum(guest.map((r) => r.clients.counts.total)) < used.length);
  });

  test('device models add up to the top devices', async () => {
    fresh();
    const models = (await sb.get(`${O}/summary/top/devices/models/byUsage?quantity=50`)).body;
    const devices = (await sb.get(`${O}/summary/top/devices/byUsage?quantity=50`)).body;
    for (const m of models) {
      const mine = devices.filter((d) => d.model === m.model);
      assert.equal(m.count, mine.length, m.model);
      close(m.usage.total, sum(mine.map((d) => d.usage.total)), 0.1 * mine.length + 0.1, m.model);
      close(m.usage.average, m.usage.total / m.count, 0.1);
    }
    assert.equal(sum(models.map((m) => m.count)), org.devices.filter((d) => d.productType !== 'camera').length);
    assert.match(await errorOf(sb.get(`${O}/summary/top/devices/models/byUsage?timespan=3600`)), /28800/);
  });

  test('networks by status match device statuses and network groups', async () => {
    fresh();
    const rows = (await sb.get(`${O}/summary/top/networks/byStatus`)).body;
    assert.equal(rows.length, org.networks.length);
    const statuses = (await sb.get(`${O}/devices/statuses?perPage=1000`)).body;
    for (const r of rows) {
      const net = org.networks.find((n) => n.id === r.networkId);
      assert.deepEqual(r.productTypes, net.productTypes);
      assert.equal(r.group, null);
      for (const p of r.statuses.byProductType) {
        const mine = statuses.filter((s) => s.networkId === net.id && s.productType === p.productType);
        assert.equal(p.counts.online + p.counts.offline + p.counts.alerting + p.counts.dormant, mine.length);
        assert.equal(p.counts.offline, mine.filter((s) => s.status === 'offline').length);
      }
    }
    // Worst first: anything offline comes before alerting, alerting before online.
    const order = ['offline', 'alerting', 'online'];
    const ranks = rows.map((r) => order.indexOf(r.statuses.overall));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));

    const g = (await sb.post(`${O}/networks/groups`, { name: 'West' })).body;
    await sb.post(`${O}/networks/groups/${g.groupId}/bulkAssign`, { networkIds: [hq.id] });
    const overview = (await sb.get(`${O}/networks/groups/overview/byGroup`)).body.items[0];
    const mine = (await sb.get(`${O}/summary/top/networks/byStatus`)).body.find((r) => r.networkId === hq.id);
    assert.deepEqual(mine.group, { id: g.groupId });
    assert.deepEqual(mine.clients, overview.clients);
    assert.deepEqual(mine.statuses, overview.statuses);

    const page = await sb.get(`${O}/summary/top/networks/byStatus?perPage=3`);
    assert.equal(page.body.length, 3);
    assert.match(page.link, /rel=next/);
    assert.equal((await sb.get(`${O}/summary/top/networks/byStatus?networkTag=emea`)).body.length, 1);
    assert.match(await errorOf(sb.get(`${O}/summary/top/networks/byStatus?perPage=2`)), /perPage/);
  });

  test('switch energy matches port power, and power history adds up to it', async () => {
    fresh();
    const sw = hq.switches[0];
    const rows = (await sb.get(`${O}/summary/top/switches/byEnergyUsage?timespan=3600&quantity=50`)).body;
    assert.equal(rows.length, org.devices.filter((d) => d.productType === 'switch').length);
    const ports = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses?timespan=3600`)).body;
    const wh = sum(ports.map((p) => p.powerUsageInWh));
    close(rows.find((r) => r.mac === sw.mac).usage.total, wh * 3600, ports.length * 0.05 * 3600);

    // Twenty minute intervals over a day, newest first.
    const t0 = '2026-09-28T18:20:00Z';
    const t1 = '2026-09-29T18:20:00Z';
    const history = (await sb.get(`${O}/summary/switch/power/history?t0=${t0}&t1=${t1}`)).body;
    assert.equal(history.length, 72);
    assert.equal(history[0].ts, '2026-09-29T18:00:00Z');
    assert.equal(history[71].ts, t0);
    const day = (await sb.get(`${O}/summary/top/switches/byEnergyUsage?t0=${t0}&t1=${t1}&quantity=50`)).body;
    close(sum(history.map((h) => h.draw / 3)), sum(day.map((r) => r.usage.total)) / 3600, 0.5);
    const week = (await sb.get(`${O}/summary/switch/power/history?timespan=${7 * 86400}`)).body;
    assert.equal(Date.parse(week[0].ts) - Date.parse(week[1].ts), 4 * 3600 * 1000);
    const month = (await sb.get(`${O}/summary/switch/power/history?timespan=${30 * 86400}`)).body;
    assert.equal(Date.parse(month[0].ts) - Date.parse(month[1].ts), 86400 * 1000);
    assert.match(await errorOf(sb.get(`${O}/summary/switch/power/history?timespan=${200 * 86400}`)), /timespan/);
  });

  test('uplink overview counts the uplink statuses', async () => {
    fresh();
    const { body } = await sb.get(`${O}/appliance/uplinks/statuses/overview`);
    const all = (await sb.get(`${O}/appliance/uplink/statuses`)).body.flatMap((d) => d.uplinks);
    const count = (s) => all.filter((u) => u.status === s).length;
    assert.deepEqual(body, { counts: { byStatus: { active: count('active'), ready: count('ready'), failed: count('failed'), connecting: 0, notConnected: count('not connected') } } });
    assert.equal(sum(Object.values(body.counts.byStatus)), all.length);
    const one = (await sb.get(`${O}/appliance/uplinks/statuses/overview?networkIds[]=${hq.id}`)).body;
    assert.equal(sum(Object.values(one.counts.byStatus)), hq.mx.uplinks.length);
  });

  test('organization bandwidth is the sum of the network histories', async () => {
    fresh();
    const rows = (await sb.get(`${O}/clients/bandwidthUsageHistory`)).body;
    assert.equal(rows.length, 288);
    const nets = await Promise.all(org.networks.map(async (n) => (await sb.get(`/networks/${n.id}/clients/bandwidthUsageHistory?perPage=1000`)).body));
    for (const [i, r] of rows.entries()) {
      for (const k of ['upstream', 'downstream']) close(r[k], sum(nets.map((n) => n[i][k])), 0.001, `${r.ts} ${k}`);
      assert.equal(r.ts, nets[0][i].ts);
    }
    const week = (await sb.get(`${O}/clients/bandwidthUsageHistory?timespan=${7 * 86400}`)).body;
    assert.equal(Date.parse(week[1].ts) - Date.parse(week[0].ts), 3600 * 1000);
    const tagged = (await sb.get(`${O}/clients/bandwidthUsageHistory?networkTag=emea`)).body;
    assert.ok(tagged[100].total < rows[100].total);
    assert.match(await errorOf(sb.get(`${O}/clients/bandwidthUsageHistory?t0=${NOW}`)), /past/);
  });

  test('security events: the organization list merges the networks, the client list filters one', async () => {
    fresh();
    const q = `timespan=${7 * 86400}&perPage=1000`;
    const all = (await sb.get(`${O}/appliance/security/events?${q}`)).body;
    const perNet = (await Promise.all(org.networks.map(async (n) => (await sb.get(`/networks/${n.id}/appliance/security/events?${q}`)).body))).flat();
    assert.equal(all.length, perNet.length);
    assert.deepEqual(all, [...perNet].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)));
    const desc = (await sb.get(`${O}/appliance/security/events?${q}&sortOrder=descending`)).body;
    assert.deepEqual(desc, [...all].reverse());
    const paged = await collect(sb.get, `${O}/appliance/security/events?timespan=${7 * 86400}&perPage=7`);
    assert.deepEqual(paged, all);

    const mac = all[0].clientMac;
    const c = org.networks.flatMap((n) => n.clients).find((x) => x.mac === mac);
    const C = `/networks/${c.net.id}/appliance/clients/${c.id}/security/events?${q}`;
    const mine = (await sb.get(C)).body;
    assert.ok(mine.length > 0);
    assert.deepEqual(mine, all.filter((e) => e.clientMac === mac));
    assert.deepEqual((await sb.get(`/networks/${c.net.id}/appliance/clients/${encodeURIComponent(c.mac)}/security/events?${q}`)).body, mine);
    assert.equal((await sb.get(`/networks/${c.net.id}/appliance/clients/k0000000/security/events`)).status, 404);
    const tor = sb.world.orgs[1].networks[0];
    assert.match(await errorOf(sb.get(`/networks/${tor.id}/appliance/clients/${tor.clients[0].id}/security/events`)), /appliance/);
    assert.match(await errorOf(sb.get(`${O}/appliance/security/events?sortOrder=sideways`)), /sortOrder/);
    assert.match(await errorOf(sb.get(`${O}/appliance/security/events?timespan=${400 * 86400}`)), /timespan/);
  });

  test('client search finds a client by MAC across the organization', async () => {
    fresh();
    const c = org.networks[2].clients[3];
    const r = await sb.get(`${O}/clients/search?mac=${encodeURIComponent(c.mac.toUpperCase())}`);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.clientId, r.body.mac, r.body.manufacturer], [c.id, c.mac, c.manufacturer]);
    assert.equal(r.body.records.length, 1);
    const [rec] = r.body.records;
    assert.deepEqual(rec.network, (await sb.get(`/networks/${c.net.id}`)).body);
    const one = (await sb.get(`/networks/${c.net.id}/clients/${c.id}`)).body;
    for (const k of ['ip', 'description', 'firstSeen', 'lastSeen', 'os', 'user', 'vlan', 'ssid', 'switchport', 'status', 'recentDeviceMac']) assert.deepEqual(rec[k], one[k], k);
    assert.equal((await sb.get(`${O}/clients/search?mac=02:00:00:00:00:01`)).status, 404);
    assert.match(await errorOf(sb.get(`${O}/clients/search`)), /mac/);
    assert.match(await errorOf(sb.get(`${O}/clients/search?mac=${encodeURIComponent(c.mac)}&perPage=10`)), /perPage/);
  });
});
