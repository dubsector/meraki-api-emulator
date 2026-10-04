import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { DAY } from '../src/time.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

describe('wireless LAN controllers', () => {
  let sb;
  let lab;
  let hfx;
  let one;
  let two;
  let pair;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    hfx = lab.networks.find((n) => n.name === 'Lab - Halifax');
    [one, two] = hfx.devices;
    pair = hfx.wirelessControllers;
  };
  const ok = async (path) => {
    const res = await sb.get(path);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  const errorOf = async (path) => {
    const res = await sb.get(path);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const O = (p) => `/organizations/${lab.id}/wirelessController/${p}`;
  const failoverTs = () => iso(pair.failovers[0].ts);

  test('Lab - Halifax holds an SSO pair that failed over to chassis 2', async () => {
    fresh();
    assert.deepEqual(hfx.productTypes, ['wirelessController']);
    assert.deepEqual(hfx.devices.map((d) => d.model), ['C9800-40', 'C9800-40']);
    const rows = (await ok(O('overview/byDevice'))).items;
    const byRole = Object.fromEntries(rows.map((r) => [r.redundancy.role, r]));
    assert.equal(byRole.Active.serial, two.serial);
    assert.equal(byRole['Standby hot'].serial, one.serial);
    assert.deepEqual(byRole.Active.counts.connections, { total: 6, byStatus: { online: 6, offline: 0 } });
    assert.deepEqual(byRole['Standby hot'].counts, { clients: { byStatus: { online: 0 } }, connections: { total: 0, byStatus: { online: 0, offline: 0 } } });
    assert.ok(byRole.Active.counts.clients.byStatus.online > 0);
    assert.deepEqual(byRole.Active.redundancy, { role: 'Active', id: pair.id, chassisName: 'Chassis 2', redundantSerial: one.serial, management: { addresses: [{ address: two.lanIp }] } });

    const statuses = (await ok(O('devices/redundancy/statuses'))).items;
    for (const s of statuses) assert.deepEqual(s.failover, { last: { ts: failoverTs(), reason: 'Active Unit Failed' }, counts: { total: 1 } });
    assert.ok(statuses.every((s) => s.enabled && s.mode === 'SSO' && s.mobilityMac === pair.mobilityMac));

    const history = await ok(O('devices/redundancy/failover/history?timespan=2678400'));
    assert.deepEqual(history, [{ items: [{ serial: two.serial, ts: failoverTs(), reason: 'Active Unit Failed', failed: { chassis: { name: 'Chassis 1' } }, active: { chassis: { name: 'Chassis 2' } } }], meta: { counts: { items: { total: 1, remaining: 0 } } } }]);
    // The default week starts after the failover.
    assert.deepEqual((await ok(O('devices/redundancy/failover/history')))[0].items, []);
  });

  test('the failover is chassis 1 reloading, in every view of it', async () => {
    fresh();
    const ts = pair.failovers[0].ts;
    const changes = await ok(`/organizations/${lab.id}/devices/availabilities/changeHistory?serials[]=${one.serial}&timespan=2678400`);
    assert.deepEqual(changes.map((c) => [c.ts.replace('.000000', ''), c.details.new[0].value]).reverse(), [[iso(ts), 'offline'], [iso(ts + 420), 'online']]);
    // Only the active unit is listed, from the switchover on.
    const avail = (await ok(O('availabilities/changeHistory?timespan=2678400'))).items;
    assert.deepEqual(avail, [{ serial: two.serial, changes: [{ startTs: iso(ts), endTs: null, status: 'online' }] }]);
    const l2 = (await ok(O('devices/interfaces/l2/statuses/changeHistory/byDevice?timespan=2678400'))).items;
    const uplink = l2.find((r) => r.serial === one.serial).interfaces.find((i) => i.name === 'TenGigabitEthernet0/0/0');
    assert.deepEqual(uplink.changes.map((c) => [c.ts, c.status]), [[iso(ts), 'disconnected'], [iso(ts + 420), 'connected']]);
    // Chassis 2 only saw its redundancy port drop.
    assert.deepEqual(l2.find((r) => r.serial === two.serial).interfaces.map((i) => i.name), ['RedundancyPort']);
    const all = (await ok(O('devices/interfaces/l2/statuses/changeHistory/byDevice?includeInterfacesWithoutChanges=true'))).items;
    assert.ok(all.every((r) => r.interfaces.length === 6 && r.interfaces.every((i) => !i.changes.length)));
    const l3 = (await ok(O('devices/interfaces/l3/statuses/changeHistory/byDevice?timespan=2678400'))).items;
    assert.deepEqual(l3.find((r) => r.serial === one.serial).interfaces.map((i) => [i.name, i.changes.length]), [['Vlan1', 2]]);

    // Clients and CPU stop on chassis 1 at the failover and go to chassis 2.
    const t0 = iso(Math.floor(ts / 300) * 300 - 600);
    const t1 = iso(Math.floor(ts / 300) * 300 + 1200);
    const clients = (await ok(O(`clients/overview/history/byDevice/byInterval?t0=${t0}&t1=${t1}&resolution=300`))).items;
    const counts = (d) => clients.find((r) => r.serial === d.serial).readings.map((r) => r.counts.byStatus.online);
    // A slot counts the unit active when it starts, so the failover's slot is still chassis 1's.
    assert.ok(counts(one).slice(0, 3).every((n) => n > 0) && counts(one).slice(3).every((n) => n === 0), String(counts(one)));
    assert.ok(counts(two).slice(0, 3).every((n) => n === 0) && counts(two).slice(3).every((n) => n > 0), String(counts(two)));
    const cpu = (await ok(O(`devices/system/utilization/history/byInterval?t0=${t0}&t1=${t1}&serials[]=${one.serial}`))).items[0];
    assert.equal(cpu.intervals.length, 4);
    assert.equal(cpu.intervals[0].byCore.length, 8);
    const uplinks = async (a) => (await ok(O(`devices/interfaces/l2/usage/history/byInterval?t0=${iso(a)}&t1=${iso(a + 420)}&serials[]=${one.serial}`))).items[0].readings[0].recv;
    assert.ok((await uplinks(ts)) * 3 < (await uplinks(ts - 420)));
  });

  test('Catalyst APs are records on the active unit, not org devices', async () => {
    fresh();
    const aps = await collect(sb.get, `/organizations/${lab.id}/wireless/devices/wirelessControllers/byDevice?perPage=3`);
    assert.equal(aps.length, 6);
    assert.deepEqual(aps.map((a) => a.serial), pair.aps.map((a) => a.serial).sort());
    assert.ok(aps.every((a) => a.controller.serial === two.serial && a.network.id === hfx.id && a.mode === 'local' && a.countryCode === 'CA'));
    assert.deepEqual(aps[0].details[0].name, 'catalyst serial');
    const conns = (await ok(O('connections'))).items;
    assert.deepEqual(conns.map((c) => c.serial), aps.map((a) => a.serial));
    assert.deepEqual(conns[0].network, { id: hfx.id, url: hfx.url, name: 'Lab - Halifax' });
    assert.equal((await ok(O(`connections?controllerSerials[]=${one.serial}`))).items.length, 0);
    assert.equal((await ok(O(`connections?networkIds[]=${lab.networks[0].id}`))).items.length, 0);
    const one1 = await ok(`/organizations/${lab.id}/wireless/devices/wirelessControllers/byDevice?serials[]=${aps[1].serial}`);
    assert.deepEqual(one1.items.map((a) => a.serial), [aps[1].serial]);
    const devices = (await ok(`/organizations/${lab.id}/devices?productTypes[]=wirelessController`)).map((d) => d.serial);
    assert.deepEqual(devices.sort(), [one.serial, two.serial].sort());
    assert.equal((await sb.get(`/devices/${aps[0].serial}`)).status, 404);
  });

  test('clients and usage agree across the views', async () => {
    fresh();
    const overview = (await ok(O(`overview/byDevice?serials[]=${two.serial}`))).items[0];
    const history = (await ok(O(`clients/overview/history/byDevice/byInterval?timespan=3600&resolution=300&networkIds[]=${hfx.id}`))).items;
    assert.equal(history.length, 2);
    assert.equal(history.find((r) => r.serial === two.serial).readings.at(-1).counts.byStatus.online, overview.counts.clients.byStatus.online);

    // A day of five-minute rates adds up to the day's totals, and the SVI carries the uplinks.
    const q = `timespan=86400&serials[]=${two.serial}`;
    const l2 = (await ok(O(`devices/interfaces/l2/usage/history/byInterval?${q}`))).items[0].readings;
    const l3 = (await ok(O(`devices/interfaces/l3/usage/history/byInterval?${q}`))).items[0].readings;
    const rates = (await ok(O(`devices/interfaces/usage/history/byInterval?${q}`))).items[0].intervals;
    assert.equal(rates.length, 288);
    const bytes = (name, k) => rates.reduce((n, i) => n + (i.byInterface.find((b) => b.name === name).usage[k] * (Date.parse(i.endTs) - Date.parse(i.startTs))) / 8000, 0);
    for (const r of l2) {
      assert.ok(Math.abs(bytes(r.name, 'recv') - r.recv) <= Math.max(1, r.recv * 0.001), r.name);
      assert.ok(Math.abs(bytes(r.name, 'send') - r.send) <= Math.max(1, r.send * 0.001), r.name);
    }
    assert.ok(Math.abs(l3[0].recv - l2[0].recv - l2[1].recv) <= 1);
    assert.ok(Math.abs(l3[0].send - l2[0].send - l2[1].send) <= 1);
    assert.ok(l2[0].recv > 0 && l2[2].recv === 0 && l2[4].recv === 0);
    const named = (await ok(O(`devices/interfaces/usage/history/byInterval?${q}&names[]=RedundancyPort`))).items[0].intervals[0];
    assert.deepEqual(named.byInterface.map((b) => b.name), ['RedundancyPort']);
    assert.equal(named.overall.total, named.byInterface[0].usage.total);
    // The active unit sends state over the redundancy port, the standby takes it in.
    const rp = Object.fromEntries((await ok(O('devices/interfaces/l2/usage/history/byInterval?timespan=3600'))).items.map((r) => [r.serial, r.readings[5]]));
    assert.ok(rp[two.serial].send > rp[two.serial].recv && rp[one.serial].recv > rp[one.serial].send);

    const packets = (await ok(O(`devices/interfaces/packets/overview/byDevice?serials[]=${two.serial}&names[]=TenGigabitEthernet0/0/0`))).items[0].interfaces;
    assert.equal(packets.length, 1);
    const [total, unicast, broadcast, multicast] = packets[0].readings;
    assert.deepEqual([total.name, unicast.name, broadcast.name, multicast.name], ['Total', 'Unicast', 'Broadcast', 'Multicast']);
    assert.equal(total.total, unicast.total + broadcast.total + multicast.total);
    assert.equal(total.rate.total, Math.round(total.total / 3600));
  });

  test('interfaces describe a C9800-40', async () => {
    fresh();
    const l2 = (await ok(O(`devices/interfaces/l2/byDevice?serials[]=${one.serial}`))).items[0].interfaces;
    assert.deepEqual(l2.map((i) => [i.name, i.status]), [
      ['TenGigabitEthernet0/0/0', 'connected'], ['TenGigabitEthernet0/0/1', 'connected'], ['TenGigabitEthernet0/0/2', 'disabled'],
      ['TenGigabitEthernet0/0/3', 'disabled'], ['GigabitEthernet0', 'disconnected'], ['RedundancyPort', 'connected'],
    ]);
    assert.deepEqual(l2[0].channelGroup, { number: 1 });
    assert.ok(l2[5].isRedundancyPort && !l2[0].isRedundancyPort);
    assert.equal(new Set(l2.map((i) => i.mac)).size, 6);
    const l3 = (await ok(O(`devices/interfaces/l3/byDevice?serials[]=${one.serial}`))).items[0].interfaces;
    assert.deepEqual(l3[0].addresses, [{ protocol: 'ipv4', address: one.lanIp, subnet: `${one.lanIp.replace(/\.\d+$/, '.0')}/24` }]);
    assert.deepEqual(l3.map((i) => i.vrf.name), ['Global', 'Mgmt-intf']);
    // At the end of a window inside the reload, chassis 1 was down.
    const ts = pair.failovers[0].ts;
    const during = (await ok(O(`devices/interfaces/l2/byDevice?t0=${iso(ts - 3600)}&t1=${iso(ts + 60)}&serials[]=${one.serial}`))).items[0].interfaces;
    assert.equal(during[0].status, 'disconnected');
  });

  test('limits and bad input', async () => {
    fresh();
    assert.match(await errorOf(O('devices/system/utilization/history/byInterval?timespan=2678401')), /less than or equal to 2678400/);
    assert.match(await errorOf(O('devices/interfaces/packets/overview/byDevice?timespan=86401')), /less than or equal to 86400/);
    assert.match(await errorOf(O(`devices/interfaces/packets/overview/byDevice?t0=${iso(now - 2 * DAY)}`)), /within the last 1 days/);
    assert.match(await errorOf(O('devices/interfaces/usage/history/byInterval?names[]=Gi9')), /unknown interface 'Gi9'/);
    assert.match(await errorOf(O('clients/overview/history/byDevice/byInterval?resolution=60')), /resolution/);
    assert.match(await errorOf(O('overview/byDevice?perPage=2')), /perPage/);
    assert.match(await errorOf(`/organizations/${lab.id}/wireless/devices/wirelessControllers/byDevice?perPage=1001`), /perPage/);
    // Thirty-one days of five-minute client counts for both units.
    const big = (await ok(O('clients/overview/history/byDevice/byInterval?timespan=2678400&resolution=300'))).items;
    assert.equal(big[0].readings.length, 8928);
    const week = (await ok(O('devices/system/utilization/history/byInterval?timespan=2678400'))).items[0].intervals;
    assert.ok(week.length >= 743 && week.length <= 745);
    // Acme Corporation has no controllers.
    const corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    assert.deepEqual((await ok(`/organizations/${corp.id}/wirelessController/overview/byDevice`)).items, []);
  });

  test('a unit leaving the pair ends SSO and the other keeps the APs', async () => {
    fresh();
    const r = await sb.post(`/networks/${hfx.id}/devices/remove`, { serial: two.serial });
    assert.equal(r.status, 204, JSON.stringify(r.body));
    const rows = (await ok(O('overview/byDevice'))).items;
    assert.deepEqual(rows.map((x) => [x.serial, x.redundancy.role, x.redundancy.redundantSerial, x.counts.connections.total]), [[one.serial, 'Active', null, 6]]);
    assert.ok(rows[0].counts.clients.byStatus.online > 0);
    const st = (await ok(O('devices/redundancy/statuses'))).items;
    assert.deepEqual(st.map((s) => [s.enabled, s.failover.counts.total]), [[false, 0]]);
    assert.deepEqual((await ok(O('devices/redundancy/failover/history?timespan=2678400')))[0].items, []);
    const aps = (await ok(`/organizations/${lab.id}/wireless/devices/wirelessControllers/byDevice`)).items;
    assert.ok(aps.every((a) => a.controller.serial === one.serial));
    assert.deepEqual((await ok(O('availabilities/changeHistory'))).items.map((x) => x.serial), [one.serial]);
    const rp = (await ok(O('devices/interfaces/l2/byDevice'))).items[0].interfaces.at(-1);
    assert.equal(rp.status, 'disconnected');
  });
});
