import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { eachOutage } from '../src/sim/outages.js';
import { isoMicro } from '../src/time.js';
import { NOW, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

describe('organization wireless views', () => {
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
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const reno = () => org.networks.find((n) => n.name === 'Warehouse - Reno');

  test('client usage by network and SSID agrees with the top SSIDs summary', async () => {
    fresh();
    const q = 'timespan=86400';
    const top = (await sb.get(`${O}/summary/top/ssids/byUsage?${q}&quantity=50`)).body;
    const bySsid = (await sb.get(`${O}/wireless/clients/usage/bySsid?${q}`)).body;
    assert.deepEqual(bySsid.meta.units, { usage: { name: 'megabytes', symbol: 'MB' } });
    for (const t of top) {
      const row = bySsid.items.find((r) => r.ssid.name === t.name);
      close(row.usage.total, t.usage.total, 0.1, t.name);
      close(row.usage.upstream, t.usage.upstream, 0.1, t.name);
      assert.equal(row.clients.total, t.clients.counts.total);
    }
    // Acme-Corp is on every network, so every AP broadcasts it.
    assert.equal(bySsid.items.find((r) => r.ssid.name === 'Acme-Corp').devices.byProductType.wireless, 25);

    const byNet = (await sb.get(`${O}/wireless/clients/usage/byNetwork?${q}`)).body;
    const byNetSsid = (await sb.get(`${O}/wireless/clients/usage/byNetwork/bySsid?${q}`)).body;
    assert.equal(byNet.items.length, 5);
    for (const n of byNet.items) {
      const rows = byNetSsid.items.filter((r) => r.network.id === n.network.id);
      close(sum(rows.map((r) => r.usage.total)), n.usage.total, 0.05, n.network.name);
      assert.equal(sum(rows.map((r) => r.clients.total)), n.clients.total);
    }
    assert.equal(byNet.items.find((r) => r.network.id === hq.id).devices.byProductType.wireless, 10);
    const totals = byNet.items.map((r) => r.usage.total);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
    close(sum(byNetSsid.items.map((r) => r.usage.total)), sum(bySsid.items.map((r) => r.usage.total)), 0.1);
    const guest = byNetSsid.items.find((r) => r.network.id === hq.id && r.ssid.number === 1);
    assert.deepEqual(Object.keys(guest.ssid), ['id', 'number', 'name', 'tunneledTo']);
    assert.match(guest.ssid.id, /^\d{6}$/);
  });

  test('client usage filters, units and bad input', async () => {
    fresh();
    const mb = (await sb.get(`${O}/wireless/clients/usage/byNetwork?networkIds[]=${hq.id}`)).body.items[0];
    const kb = (await sb.get(`${O}/wireless/clients/usage/byNetwork?networkIds[]=${hq.id}&usageUnits=KB`)).body;
    assert.equal(kb.meta.units.usage.symbol, 'KB');
    close(kb.items[0].usage.total / 1024, mb.usage.total, 0.01);
    const guest = (await sb.get(`${O}/wireless/clients/usage/byNetwork/bySsid?ssidNames[]=Acme-Guest`)).body.items;
    assert.ok(guest.length >= 4 && guest.every((r) => r.ssid.name === 'Acme-Guest'));
    const one = (await sb.get(`${O}/wireless/clients/usage/byNetwork/bySsid?ssidIds[]=${guest[0].ssid.id}`)).body.items;
    assert.deepEqual(one.map((r) => r.ssid.id), [guest[0].ssid.id]);
    assert.deepEqual((await sb.get(`${O}/wireless/clients/usage/bySsid?gatewayNetworkIds[]=${hq.id}`)).body.items, []);

    const g = (await sb.post(`${O}/networks/groups`, { name: 'West' })).body;
    await sb.post(`${O}/networks/groups/${g.groupId}/bulkAssign`, { networkIds: [hq.id, reno().id] });
    const grouped = (await sb.get(`${O}/wireless/clients/usage/byNetwork?networkGroupIds[]=${g.groupId}`)).body.items;
    assert.deepEqual(grouped.map((r) => r.network.id).sort(), [hq.id, reno().id].sort());

    const paged = await sb.get(`${O}/wireless/clients/usage/byNetwork?perPage=3`);
    assert.equal(paged.body.items.length, 3);
    assert.deepEqual(paged.body.meta.counts.items, { total: 5, remaining: 2 });
    assert.match(paged.link, /rel=next/);
    assert.match(await errorOf(sb.get(`${O}/wireless/clients/usage/byNetwork?usageUnits=PB`)), /usageUnits/);
    assert.match(await errorOf(sb.get(`${O}/wireless/clients/usage/bySsid?timespan=600`)), /greater than or equal to 3600/);
    assert.match(await errorOf(sb.get(`${O}/wireless/clients/usage/byNetwork/bySsid?timespan=1209600`)), /less than or equal/);
  });

  test('packet loss by client, device and network are sums of one series', async () => {
    fresh();
    const q = 'timespan=604800';
    const clients = (await sb.get(`${O}/wireless/devices/packetLoss/byClient?${q}`)).body;
    const devices = (await sb.get(`${O}/wireless/devices/packetLoss/byDevice?${q}`)).body;
    const nets = (await sb.get(`${O}/wireless/devices/packetLoss/byNetwork?${q}`)).body;
    assert.equal(devices.length, 25);
    assert.equal(nets.length, 5);
    for (const n of nets) {
      const rows = devices.filter((d) => d.network.id === n.network.id);
      for (const dir of ['downstream', 'upstream']) {
        assert.equal(sum(rows.map((d) => d[dir].total)), n[dir].total);
        assert.equal(sum(rows.map((d) => d[dir].lost)), n[dir].lost);
        assert.equal(sum(clients.filter((c) => c.network.id === n.network.id).map((c) => c[dir].lost)), n[dir].lost);
      }
      close(n.downstream.lossPercentage, (n.downstream.lost / n.downstream.total) * 100, 0.01);
    }
    // The flaky Reno AP loses the most.
    const renoAps = devices.filter((d) => d.network.id === reno().id);
    const flaky = reno().aps.find((a) => a.flaky).serial;
    const worst = renoAps.sort((a, b) => b.downstream.lossPercentage - a.downstream.lossPercentage)[0];
    assert.equal(worst.device.serial, flaky);
    assert.deepEqual(Object.keys(clients[0]), ['downstream', 'upstream', 'client', 'network']);
    assert.deepEqual(Object.keys(devices[0]), ['downstream', 'upstream', 'network', 'device']);
  });

  test('packet loss filters and bad input', async () => {
    fresh();
    const c = hq.clients.find((x) => !x.wired && x.band === '5');
    const one = (await sb.get(`${O}/wireless/devices/packetLoss/byClient?timespan=604800&macs[]=${c.mac.toUpperCase()}`)).body;
    assert.deepEqual(one.map((r) => r.client.id), [c.id]);
    const two4 = (await sb.get(`${O}/wireless/devices/packetLoss/byNetwork?networkIds[]=${hq.id}&bands[]=2.4`)).body[0];
    const five = (await sb.get(`${O}/wireless/devices/packetLoss/byNetwork?networkIds[]=${hq.id}&bands[]=5,6`)).body[0];
    const all = (await sb.get(`${O}/wireless/devices/packetLoss/byNetwork?networkIds[]=${hq.id}`)).body[0];
    assert.equal(two4.downstream.total + five.downstream.total, all.downstream.total);
    const ap = hq.aps[0];
    const dev = (await sb.get(`${O}/wireless/devices/packetLoss/byDevice?serials[]=${ap.serial}&ssids[]=0`)).body;
    assert.equal(dev.length, 1);
    assert.ok(dev[0].downstream.total > 0);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/packetLoss/byDevice?bands[]=60`)), /bands/);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/packetLoss/byClient?ssids[]=x`)), /ssids/);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/packetLoss/byNetwork?timespan=60`)), /300/);
  });

  test('channel utilization history agrees with the totals over the same interval', async () => {
    fresh();
    const w = `t0=${at(-5400 - 1800)}&t1=${at(-1800)}`;
    const hist = (await sb.get(`${O}/wireless/devices/channelUtilization/history/byDevice/byInterval?${w}&interval=7200`)).body;
    const flat = (await sb.get(`${O}/wireless/devices/channelUtilization/byDevice?${w}`)).body;
    // 16:30 to 18:00 sits in the 16:00 to 18:00 interval.
    assert.equal(hist.length, 25);
    assert.equal(hist[0].startTs, '2026-09-29T16:00:00Z');
    assert.equal(hist[0].endTs, '2026-09-29T18:00:00Z');
    for (const r of hist) assert.deepEqual(r.byBand, flat.find((f) => f.serial === r.serial).byBand, r.serial);

    const netHist = (await sb.get(`${O}/wireless/devices/channelUtilization/history/byNetwork/byInterval?${w}&interval=7200`)).body;
    const netFlat = (await sb.get(`${O}/wireless/devices/channelUtilization/byNetwork?${w}`)).body;
    assert.equal(netHist.length, 5);
    for (const r of netHist) assert.deepEqual(r.byBand, netFlat.find((f) => f.network.id === r.network.id).byBand);
    assert.deepEqual(netHist.find((r) => r.network.id === hq.id).byBand.map((b) => b.band), ['2.4', '5', '6']);

    // A day of hourly intervals: 25 with an unaligned clock, oldest first.
    const day = await sb.get(`${O}/wireless/devices/channelUtilization/history/byNetwork/byInterval?timespan=86400&networkIds[]=${hq.id}`);
    assert.equal(day.body.length, 25);
    assert.ok(day.body.every((r, i) => !i || r.startTs > day.body[i - 1].startTs));
    const paged = await sb.get(`${O}/wireless/devices/channelUtilization/history/byDevice/byInterval?timespan=86400&perPage=30`);
    assert.equal(paged.body.length, 30);
    assert.match(paged.link, /rel=next/);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/channelUtilization/history/byDevice/byInterval?interval=900`)), /interval/);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/channelUtilization/history/byNetwork/byInterval?timespan=2764800`)), /less than or equal/);
  });

  test('ethernet statuses follow the switch port each AP is on', async () => {
    fresh();
    const rows = (await sb.get(`${O}/wireless/devices/ethernet/statuses`)).body;
    assert.equal(rows.length, 25);
    const of = (ap) => rows.find((r) => r.serial === ap.serial);
    // A CW9166I needs 802.3bt; the MS250 only gives 802.3at.
    const onUpoe = hq.aps.find((a) => a.switchPort.switch.model === 'MS390-48UX');
    const onAt = hq.aps.find((a) => a.switchPort.switch.model === 'MS250-48FP');
    assert.equal(of(onUpoe).power.mode, 'full');
    assert.equal(of(onUpoe).ports[0].poe.standard, '802.3bt');
    assert.equal(of(onAt).power.mode, 'low');
    assert.equal(of(onAt).ports[0].poe.standard, '802.3at');
    // Catalyst APs leave out link details.
    assert.deepEqual(of(onUpoe).ports[0].linkNegotiation, { duplex: null, speed: null });
    assert.deepEqual(of(onUpoe).aggregation, { enabled: null, speed: null });
    const mr46 = org.networks[1].aps[0];
    assert.deepEqual(of(mr46).ports[0], { name: 'Ethernet 0', poe: { standard: '802.3at' }, linkNegotiation: { duplex: 'full', speed: 1000 } });
    assert.deepEqual(of(mr46).power, { mode: 'full', ac: { isConnected: false }, poe: { isConnected: true } });
    const lab = sb.world.orgs[1];
    const injected = (await sb.get(`/organizations/${lab.id}/wireless/devices/ethernet/statuses`)).body;
    assert.ok(injected.every((r) => r.ports[0].poe.standard === null && r.power.mode === 'full'));
    assert.equal((await sb.get(`${O}/wireless/devices/ethernet/statuses?networkIds[]=${reno().id}`)).body.length, 6);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/ethernet/statuses?perPage=1001`)), /perPage/);
  });

  test('power mode and CPU load history', async () => {
    // A clock a day and a half back puts two of the flaky AP's outages in the last day.
    const t = T - 36.5 * 3600;
    const past = await start({ now: new Date(t * 1000).toISOString() });
    try {
      const o = past.world.orgs[0];
      const flaky = o.networks.find((n) => n.name === 'Warehouse - Reno').aps.find((a) => a.flaky);
      const res = await past.get(`/organizations/${o.id}/wireless/devices/power/mode/history?serials[]=${flaky.serial}`);
      const ends = [];
      eachOutage(flaky, t - 86400, t, (s, e) => e <= t && ends.push(e));
      assert.ok(ends.length >= 2);
      const item = res.body.items[0];
      assert.deepEqual(item.events.map((e) => e.ts), ends.map(isoMicro));
      assert.ok(item.events.every((e) => e.powerMode === 'full power'));
      assert.deepEqual(Object.keys(item), ['serial', 'model', 'name', 'mac', 'tags', 'network', 'events']);
    } finally {
      past.close();
    }
    fresh();
    const page = await sb.get(`${O}/wireless/devices/power/mode/history`);
    assert.equal(page.body.items.length, 10);
    assert.match(page.link, /rel=next/);

    const ap = hq.aps[0];
    const cpu = (await sb.get(`${O}/wireless/devices/system/cpu/load/history?serials[]=${ap.serial}`)).body.items[0];
    assert.equal(cpu.cpuCount, 4);
    assert.equal(cpu.series.length, 288);
    assert.equal(cpu.series.at(-1).ts, '2026-09-29T18:30:00.000000Z');
    assert.ok(cpu.series.every((s) => Number.isInteger(s.cpuLoad5) && s.cpuLoad5 > 0));
    const hour = (await sb.get(`${O}/wireless/devices/system/cpu/load/history?serials[]=${ap.serial}&timespan=3600`)).body.items[0];
    assert.deepEqual(hour.series, cpu.series.slice(-12));
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/system/cpu/load/history?timespan=172800`)), /less than or equal/);
    assert.match(await errorOf(sb.get(`${O}/wireless/devices/power/mode/history?perPage=21`)), /perPage/);
  });

  test('SSID statuses match each AP wireless status', async () => {
    fresh();
    const body = (await sb.get(`${O}/wireless/ssids/statuses/byDevice?networkIds[]=${hq.id}`)).body;
    assert.equal(body.items.length, 10);
    const ap = hq.aps[0];
    const status = (await sb.get(`/devices/${ap.serial}/wireless/status`)).body.basicServiceSets;
    const sets = body.items.find((r) => r.serial === ap.serial).basicServiceSets;
    assert.equal(sets.length, status.length);
    sets.forEach((s, i) => {
      assert.equal(s.bssid, status[i].bssid);
      assert.equal(s.ssid.number, status[i].ssidNumber);
      assert.equal(s.radio.channel, status[i].channel);
      assert.equal(`${s.radio.band} GHz`, status[i].band);
    });
    const all = (await sb.get(`${O}/wireless/ssids/statuses/byDevice?serials[]=${ap.serial}&hideDisabled=false`)).body.items[0];
    assert.equal(all.basicServiceSets.length, 15 * 3);
    assert.ok(all.basicServiceSets.some((s) => !s.ssid.enabled && !s.ssid.advertised));
    const one = (await sb.get(`${O}/wireless/ssids/statuses/byDevice?bssids[]=${sets[0].bssid.toLowerCase()}`)).body;
    assert.equal(one.items.length, 1);
    assert.deepEqual(one.items[0].basicServiceSets, [sets[0]]);
    assert.match(await errorOf(sb.get(`${O}/wireless/ssids/statuses/byDevice?perPage=501`)), /perPage/);
  });

  test('impacted wireless devices count AP outages per network', async () => {
    fresh();
    const rows = (await sb.get(`${O}/assurance/impactedDevice/wireless/byNetwork?timespan=1209600`)).body;
    assert.equal(rows.length, 5);
    for (const r of rows) {
      const net = org.networks.find((n) => n.id === r.network.id);
      const down = net.aps.filter((ap) => {
        let hit = false;
        eachOutage(ap, T - 1209600, T, () => (hit = true));
        return hit;
      });
      assert.equal(r.counts.total, down.length, net.name);
    }
    const renoRow = rows.find((r) => r.network.id === reno().id);
    assert.ok(renoRow.counts.byFailureType.some((f) => f.type === 'AP reboot'));
    const totals = rows.map((r) => r.counts.total);
    assert.deepEqual(totals, [...totals].sort((a, b) => b - a));
    const quiet = (await sb.get(`${O}/assurance/impactedDevice/wireless/byNetwork`)).body;
    assert.ok(quiet.every((r) => r.counts.total === 0 && r.counts.byFailureType.length === 0));
    assert.match(await errorOf(sb.get(`${O}/assurance/impactedDevice/wireless/byNetwork?timespan=3600`)), /7200/);
  });
});
