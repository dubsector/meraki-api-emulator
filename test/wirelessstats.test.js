import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { networkEventsOnDay } from '../src/sim/events.js';
import { isOnline } from '../src/sim/presence.js';
import { DAY } from '../src/time.js';
import { NOW, collect, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

describe('wireless client stats', () => {
  let sb;
  let org;
  let lab;
  let hq;
  let N;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [org, lab] = sb.world.orgs;
    hq = org.networks[0];
    N = `/networks/${hq.id}`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const laptop = () => hq.clients.find((c) => !c.wired && c.kindName === 'laptop');
  const reno = () => org.networks.find((n) => n.name === 'Warehouse - Reno');

  test('per-client connection stats add up to the network and AP totals', async () => {
    fresh();
    const q = 'timespan=604800';
    const rows = (await sb.get(`${N}/wireless/clients/connectionStats?${q}`)).body;
    const net = (await sb.get(`${N}/wireless/connectionStats?${q}`)).body;
    for (const k of Object.keys(net)) assert.equal(sum(rows.map((r) => r.connectionStats[k])), net[k], k);
    assert.ok(rows.every((r) => r.connectionStats.success > 0));
    assert.deepEqual(rows.map((r) => r.mac), rows.map((r) => r.mac).sort());

    const ap = hq.aps[0];
    const onAp = new Set(hq.clients.filter((c) => c.ap === ap).map((c) => c.mac));
    const dev = (await sb.get(`/devices/${ap.serial}/wireless/connectionStats?${q}`)).body.connectionStats;
    assert.equal(sum(rows.filter((r) => onAp.has(r.mac)).map((r) => r.connectionStats.success)), dev.success);

    const band5 = (await sb.get(`${N}/wireless/clients/connectionStats?${q}&band=5`)).body;
    assert.equal(sum(band5.map((r) => r.connectionStats.success)), (await sb.get(`${N}/wireless/connectionStats?${q}&band=5`)).body.success);

    const row = rows.find((r) => r.connectionStats.auth + r.connectionStats.assoc + r.connectionStats.dhcp > 0) ?? rows[0];
    const one = (await sb.get(`${N}/wireless/clients/${row.mac}/connectionStats?${q}`)).body;
    const { dns, ...rest } = row.connectionStats;
    assert.deepEqual(one, { mac: row.mac, connectionStats: rest });
    // A client outside the filters counts nothing.
    const other = hq.clients.find((c) => c.mac === row.mac).band === '5' ? '2.4' : '5';
    assert.deepEqual(Object.values((await sb.get(`${N}/wireless/clients/${row.mac}/connectionStats?${q}&band=${other}`)).body.connectionStats), [0, 0, 0, 0]);

    const wired = hq.clients.find((c) => c.wired);
    assert.equal(await errorOf(sb.get(`${N}/wireless/clients/${wired.mac}/connectionStats`), 404), 'Client not found');
    assert.equal(await errorOf(sb.get(`${N}/wireless/clients/02:00:00:00:00:01/connectionStats`), 404), 'Client not found');
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/connectionStats?band=7`)), /band/);
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/connectionStats?timespan=700000`)), /timespan/);
  });

  test("a client's latency is its AP's, sampled by its airtime", async () => {
    fresh();
    const q = `t0=${at(-3600)}&t1=${NOW}`;
    const rows = (await sb.get(`${N}/wireless/clients/latencyStats?${q}`)).body;
    assert.ok(rows.length > 50);
    const c = hq.clients.find((x) => x.mac === rows[0].mac);
    const dev = (await sb.get(`/devices/${c.ap.serial}/wireless/latencyStats?${q}`)).body.latencyStats;
    for (const k of Object.keys(dev)) assert.equal(rows[0].latencyStats[k].avg, dev[k].avg, k);

    // The AP's samples are its clients' samples, give or take rounding.
    const onAp = rows.filter((r) => hq.clients.find((x) => x.mac === r.mac).ap === c.ap);
    const count = (d) => sum(Object.values(d));
    const clients = sum(onAp.map((r) => count(r.latencyStats.bestEffortTraffic.rawDistribution)));
    assert.ok(Math.abs(clients - count(dev.bestEffortTraffic.rawDistribution)) <= onAp.length * 7, `${clients} vs ${count(dev.bestEffortTraffic.rawDistribution)}`);

    const one = (await sb.get(`${N}/wireless/clients/${c.mac}/latencyStats?${q}`)).body;
    assert.deepEqual(one, rows[0]);
    const avg = (await sb.get(`${N}/wireless/clients/${c.mac}/latencyStats?${q}&fields=avg`)).body;
    assert.deepEqual(Object.keys(avg.latencyStats.voiceTraffic), ['avg']);
    const vlan = (await sb.get(`${N}/wireless/clients/latencyStats?${q}&vlan=${c.vlan}`)).body;
    assert.ok(vlan.length < rows.length && vlan.some((r) => r.mac === c.mac));
    const none = (await sb.get(`${N}/wireless/clients/${c.mac}/latencyStats?${q}&vlan=${c.vlan === 10 ? 30 : 10}`)).body;
    assert.deepEqual(none.latencyStats.bestEffortTraffic, { rawDistribution: {}, avg: 0 });
  });

  test('connectivity events tell the same story as connection stats and the event log', async () => {
    fresh();
    const c = laptop();
    const q = 'timespan=604800';
    const all = await collect(sb.get, `${N}/wireless/clients/${c.mac}/connectivityEvents?${q}&perPage=3`);
    const full = (await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?${q}`)).body;
    assert.deepEqual(all, full);
    assert.deepEqual(Object.keys(full[0]), ['occurredAt', 'band', 'ssidNumber', 'type', 'subtype', 'severity', 'durationMs', 'channel', 'rssi', 'eventData', 'deviceSerial']);
    assert.ok(full.every((e) => e.band === c.band && e.deviceSerial === c.ap.serial && e.ssidNumber === c.ssid.number));

    const assoc = full.filter((e) => e.type === 'assoc' && e.subtype === 'success');
    const stats = (await sb.get(`${N}/wireless/clients/${c.mac}/connectionStats?${q}`)).body.connectionStats;
    assert.equal(assoc.length, stats.success);
    for (const step of ['assoc', 'auth', 'dhcp']) assert.equal(full.filter((e) => e.type === step && e.severity === 'bad').length, stats[step], step);
    // Sessions can straddle the window, so disassociations may be one off either way.
    assert.ok(Math.abs(full.filter((e) => e.type === 'disassoc').length - assoc.length) <= 1);

    // Associations happen at the same instants the event log records them.
    const logged = [];
    for (let d = Math.floor((T - 7 * DAY) / DAY); d <= Math.floor(T / DAY); d++) {
      for (const e of networkEventsOnDay(hq, d)) if (e.clientMac === c.mac && e.type === 'association' && e.t >= T - 7 * DAY) logged.push(e.t);
    }
    assert.deepEqual(assoc.map((e) => Date.parse(e.occurredAt)), logged.map((t) => Math.floor(t * 1000)));

    const desc = (await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?${q}&sortOrder=descending`)).body;
    assert.deepEqual(desc, [...full].reverse());
    const some = (await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?${q}&types[]=disassoc&types[]=dhcp`)).body;
    assert.ok(some.length && some.every((e) => e.type === 'disassoc' || e.type === 'dhcp'));
    assert.ok((await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?${q}&includedSeverities[]=info`)).body.every((e) => e.severity === 'info'));
    assert.deepEqual((await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?${q}&deviceSerial=${hq.aps.find((a) => a !== c.ap).serial}`)).body, []);
    // The default window is one day.
    assert.ok((await sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents`)).body.every((e) => Date.parse(e.occurredAt) / 1000 >= T - DAY));
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?types[]=hello`)), /types/);
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?includedSeverities[]=fine`)), /includedSeverities/);
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?sortOrder=up`)), /sortOrder/);
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/${c.mac}/connectivityEvents?timespan=2678401`)), /timespan/);
  });

  test('failed attempts show up as bad events of their step', async () => {
    fresh();
    const net = reno();
    const flaky = net.aps.find((a) => a.flaky);
    const q = 'timespan=604800';
    const rows = (await sb.get(`/networks/${net.id}/wireless/clients/connectionStats?${q}`)).body;
    const failing = rows.find((r) => net.clients.find((c) => c.mac === r.mac).ap === flaky && r.connectionStats.success && r.connectionStats.assoc + r.connectionStats.auth + r.connectionStats.dhcp + r.connectionStats.dns > 0);
    assert.ok(failing);
    const bad = (await sb.get(`/networks/${net.id}/wireless/clients/${failing.mac}/connectivityEvents?${q}&includedSeverities[]=bad`)).body;
    const s = failing.connectionStats;
    assert.equal(bad.length, s.assoc + s.auth + s.dhcp + s.dns);
    assert.ok(bad.every((e) => e.subtype === 'failure'));
  });

  test('client latency history uses the same distribution as latency stats', async () => {
    fresh();
    const c = laptop();
    const rows = (await sb.get(`${N}/wireless/clients/${c.mac}/latencyHistory?timespan=${7 * DAY}`)).body;
    assert.equal(rows.length, 8);
    assert.ok(rows.every((r) => r.t1 - r.t0 === DAY && r.t0 % DAY === 0));
    const day = rows[rows.length - 2];
    const stats = (await sb.get(`${N}/wireless/clients/${c.mac}/latencyStats?t0=${day.t0}&t1=${day.t1}`)).body.latencyStats;
    const bins = day.latencyBinsByCategory.bestEffortTraffic;
    assert.deepEqual(Object.keys(bins), ['0.5', '1.0', '2.0', '4.0', '8.0', '16.0', '32.0', '64.0', '128.0', '256.0', '512.0', '1024.0', '2048.0']);
    assert.deepEqual(Object.values(bins), Object.values(stats.bestEffortTraffic.rawDistribution));
    // The default is one day, and the lookback goes back 791 days.
    assert.equal((await sb.get(`${N}/wireless/clients/${c.mac}/latencyHistory`)).body.length, 2);
    assert.equal((await sb.get(`${N}/wireless/clients/${c.ip}/latencyHistory?t0=${T - 790 * DAY}&t1=${T - 789 * DAY}`)).status, 200);
    assert.match(await errorOf(sb.get(`${N}/wireless/clients/${c.mac}/latencyHistory?resolution=3600`)), /resolution/);
  });

  test('latency history matches the latency stats of the same AP and window', async () => {
    fresh();
    const ap = hq.aps[1];
    const t0 = Math.floor(T / 3600) * 3600 - 3 * 3600;
    const rows = (await sb.get(`${N}/wireless/latencyHistory?t0=${t0}&t1=${t0 + 3600}&resolution=3600&deviceSerial=${ap.serial}&accessCategory=voiceTraffic`)).body;
    assert.equal(rows.length, 1);
    const stats = (await sb.get(`/devices/${ap.serial}/wireless/latencyStats?t0=${t0}&t1=${t0 + 3600}`)).body.latencyStats;
    assert.equal(rows[0].avgLatencyMs, Math.round(stats.voiceTraffic.avg));

    const day = (await sb.get(`${N}/wireless/latencyHistory?timespan=86400&resolution=3600`)).body;
    assert.equal(day.length, 25);
    assert.ok(day.every((r) => Number.isInteger(r.avgLatencyMs)));
    const c = laptop();
    const mine = (await sb.get(`${N}/wireless/latencyHistory?timespan=86400&resolution=3600&clientId=${c.id}`)).body;
    assert.ok(mine.some((r) => r.avgLatencyMs === null) && mine.some((r) => r.avgLatencyMs > 0));
    assert.equal((await sb.get(`${N}/wireless/latencyHistory`)).body.length, 8);
    assert.match(await errorOf(sb.get(`${N}/wireless/latencyHistory?accessCategory=bulk`)), /accessCategory/);
    assert.equal(await errorOf(sb.get(`${N}/wireless/latencyHistory?deviceSerial=Q2XX-0000-0000`), 404), 'Device not found');
  });

  test('data rates follow the band and the clients connected', async () => {
    fresh();
    const rows = (await sb.get(`${N}/wireless/dataRateHistory?timespan=86400&resolution=3600`)).body;
    assert.equal(rows.length, 25);
    assert.deepEqual(Object.keys(rows[0]), ['startTs', 'endTs', 'averageKbps', 'downloadKbps', 'uploadKbps']);
    for (const r of rows) {
      assert.ok(r.uploadKbps < r.downloadKbps);
      assert.equal(r.averageKbps, Math.round((r.downloadKbps + r.uploadKbps) / 2));
    }
    const rate = async (band) => (await sb.get(`${N}/wireless/dataRateHistory?t0=${at(-3600)}&t1=${NOW}&resolution=3600&band=${band}`)).body[0].downloadKbps;
    const [two, five, six] = [await rate('2.4'), await rate('5'), await rate('6')];
    assert.ok(two < five && five < six, `${two} ${five} ${six}`);
    assert.ok(six <= 1200800);
    const c = laptop();
    const mine = (await sb.get(`${N}/wireless/dataRateHistory?timespan=86400&resolution=3600&clientId=${c.mac}`)).body;
    assert.ok(mine.some((r) => r.downloadKbps === null) && mine.some((r) => r.downloadKbps > 0));
    assert.equal((await sb.get(`${N}/wireless/dataRateHistory`)).body.length, 8);
    assert.equal((await sb.get(`${N}/wireless/dataRateHistory?timespan=86400&autoResolution=true`)).body.length, 288);
    assert.match(await errorOf(sb.get(`${N}/wireless/dataRateHistory?resolution=60`)), /resolution/);
    assert.equal(await errorOf(sb.get(`${N}/wireless/dataRateHistory?clientId=nobody`), 404), 'Client not found');
  });

  test('network health channel utilization matches the utilization history per radio', async () => {
    fresh();
    const aps = await collect(sb.get, `${N}/networkHealth/channelUtilization?timespan=3600&perPage=3`);
    assert.deepEqual(aps.map((a) => a.serial), hq.aps.map((a) => a.serial).sort());
    assert.equal((await sb.get(`${N}/networkHealth/channelUtilization`)).body.length, 10);
    const lobby = aps.find((a) => a.tags === ' lobby ');
    assert.ok(lobby && aps.filter((a) => a.tags === '').length === 9);
    assert.deepEqual(Object.keys(lobby), ['serial', 'model', 'tags', 'wifi0', 'wifi1']);
    assert.equal(lobby.wifi0.length, 6);
    for (const [radio, band] of [['wifi0', '2.4'], ['wifi1', '5']]) {
      const hist = (await sb.get(`${N}/wireless/channelUtilizationHistory?timespan=3600&resolution=600&band=${band}&deviceSerial=${lobby.serial}`)).body;
      assert.deepEqual(lobby[radio].map((u) => [u.startTime, u.utilizationTotal, u.utilization80211, u.utilizationNon80211]), hist.map((h) => [h.startTs, h.utilizationTotal, h.utilization80211, h.utilizationNon80211]));
    }
    // A day of 10-minute intervals by default.
    assert.equal((await sb.get(`${N}/networkHealth/channelUtilization?perPage=3`)).body[0].wifi1.length, 144);
    assert.match(await errorOf(sb.get(`${N}/networkHealth/channelUtilization?resolution=3600`)), /resolution/);
    assert.match(await errorOf(sb.get(`${N}/networkHealth/channelUtilization?perPage=101`)), /perPage/);
  });

  test('no AP is a mesh repeater', async () => {
    fresh();
    const r = await sb.get(`${N}/wireless/meshStatuses`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
    assert.match(await errorOf(sb.get(`${N}/wireless/meshStatuses?perPage=501`)), /perPage/);
    const made = await sb.post(`/organizations/${org.id}/networks`, { name: 'Switches only', productTypes: ['switch'] });
    assert.match(await errorOf(sb.get(`/networks/${made.body.id}/wireless/meshStatuses`)), /wireless/);
  });

  test('impacted clients count the same failures as failed connections', async () => {
    fresh();
    const q = `t0=${at(-3 * DAY)}&t1=${NOW}`;
    const { items, meta } = (await sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?${q}`)).body;
    assert.equal(meta.counts.items.total, items.length);
    assert.deepEqual(items.map((i) => i.clients.impacted.total), items.map((i) => i.clients.impacted.total).sort((a, b) => b - a));
    const step = { assoc: 'association', auth: 'authentication', dhcp: 'ipAssignment' };
    for (const net of org.networks) {
      const failed = (await sb.get(`/networks/${net.id}/wireless/failedConnections?${q}`)).body;
      for (const s of net.ssids) {
        const row = items.find((i) => i.network.id === net.id && i.ssid.number === s.number);
        const mine = failed.filter((f) => f.ssidNumber === s.number && step[f.failureStep]);
        if (!row) {
          assert.equal(mine.length, 0);
          continue;
        }
        assert.equal(row.ssid.name, s.name);
        assert.match(row.ssid.id, /^\d{6}$/);
        for (const [k, v] of Object.entries(step)) assert.equal(row.clients.impacted.byStep[v], new Set(mine.filter((f) => f.failureStep === k).map((f) => f.clientMac)).size, `${net.name} ${s.name} ${v}`);
        assert.equal(row.clients.impacted.total, new Set(mine.map((f) => f.clientMac)).size);
        assert.ok(row.clients.total >= row.clients.impacted.total);
      }
    }
    assert.ok(items[0].clients.impacted.total > 0);

    const paged = (await sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?${q}&perPage=3`)).body;
    assert.deepEqual(paged.items, items.slice(0, 3));
    assert.equal(paged.meta.counts.items.remaining, items.length - 3);
    const one = (await sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?${q}&networkIds[]=${hq.id}`)).body.items;
    assert.deepEqual(one, items.filter((i) => i.network.id === hq.id));
    const group = (await sb.post(`/organizations/${org.id}/networks/groups`, { name: 'West' })).body;
    await sb.post(`/organizations/${org.id}/networks/groups/${group.groupId}/bulkAssign`, { networkIds: [hq.id] });
    const grouped = (await sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?${q}&networkGroupIds[]=${group.groupId}`)).body.items;
    assert.deepEqual(grouped, one);
    // Two hours by default.
    const recent = (await sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid`)).body.items;
    assert.ok(sum(recent.map((i) => i.clients.total)) < sum(items.map((i) => i.clients.total)));
    assert.match(await errorOf(sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?timespan=60`)), /300/);
    assert.match(await errorOf(sb.get(`/organizations/${org.id}/wireless/clients/connections/impacted/byNetwork/bySsid?t0=${at(-9 * DAY)}`)), /8 days/);
  });

  test('client counts by AP match the online clients', async () => {
    fresh();
    const { items, meta } = (await sb.get(`/organizations/${org.id}/wireless/clients/overview/byDevice`)).body;
    const aps = org.networks.flatMap((n) => n.aps);
    assert.equal(items.length, aps.length);
    assert.equal(meta.counts.items.remaining, 0);
    const clients = (await sb.get(`${N}/clients?perPage=1000&timespan=86400`)).body;
    for (const ap of hq.aps) {
      const row = items.find((i) => i.serial === ap.serial);
      assert.deepEqual(row.network, { id: hq.id });
      assert.equal(row.counts.byStatus.online, clients.filter((c) => c.recentDeviceSerial === ap.serial && c.status === 'Online').length);
      assert.equal(row.counts.byStatus.online, hq.clients.filter((c) => c.ap === ap && !c.wired && isOnline(c, T)).length);
    }
    assert.ok(sum(items.map((i) => i.counts.byStatus.online)) > 100);
    const two = (await sb.get(`/organizations/${org.id}/wireless/clients/overview/byDevice?serials[]=${hq.aps[0].serial}&serials[]=${hq.aps[1].serial}`)).body.items;
    assert.equal(two.length, 2);
    assert.equal((await sb.get(`/organizations/${lab.id}/wireless/clients/overview/byDevice?networkIds[]=${hq.id}`)).body.items.length, 0);
    assert.deepEqual((await sb.get(`/organizations/${org.id}/wireless/clients/overview/byDevice?campusGatewayClusterIds[]=1`)).body.items, []);
    const page = await sb.get(`/organizations/${org.id}/wireless/clients/overview/byDevice?perPage=3`);
    assert.equal(page.body.items.length, 3);
    assert.equal(page.body.meta.counts.items.remaining, items.length - 3);
  });
});
