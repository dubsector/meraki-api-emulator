import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { routingEntries } from '../src/sim/router.js';
import { NOW, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('Secure Routers', () => {
  let sb;
  let lab;
  let wpg;
  let router;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    wpg = lab.networks.find((n) => n.name === 'Lab - Winnipeg');
    router = wpg.mx;
  };
  const ok = async (res) => {
    const r = await res;
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body));
    return r.body;
  };
  const errorOf = async (res) => {
    const r = await res;
    assert.equal(r.status, 400, JSON.stringify(r.body));
    return r.body.errors[0];
  };
  const DOM = () => `/organizations/${lab.id}/appliance/devices/ports/transceivers/readings/history/byDevice`;
  const PACKETS = () => `/organizations/${lab.id}/appliance/interfaces/packets/overviews/byDevice`;
  const lookup = async (body) => {
    const job = await ok(sb.post(`/devices/${router.serial}/liveTools/routingTable/lookups`, body));
    return ok(sb.get(job.url));
  };

  test('Lab - Winnipeg holds a Secure Router that the appliance views show', async () => {
    fresh();
    assert.equal(router.model, 'C8455-G2-MX');
    assert.deepEqual(wpg.productTypes, ['appliance']);
    const dev = await ok(sb.get(`/devices/${router.serial}`));
    assert.equal(dev.productType, 'appliance');
    // The port view and the new views name the same interfaces.
    const ports = (await ok(sb.get(`/organizations/${lab.id}/appliance/devices/interfaces/ports/byDevice?serials[]=${router.serial}`))).items[0].ports;
    const packets = (await ok(sb.get(PACKETS()))).items[0];
    assert.deepEqual(
      ports.map((p) => p.interface.name),
      packets.interfaces.map((i) => i.name),
    );
    assert.equal(ports[0].interface.name, 'TenGigabitEthernet0/0/1');
    assert.equal(ports.at(-1).interface.name, 'GigabitEthernet0/0/10');
    // Acme Corporation has no Secure Routers.
    assert.deepEqual((await ok(sb.get(`/organizations/${sb.world.orgs.find((o) => o.name === 'Acme Corporation').id}/appliance/interfaces/packets/overviews/byDevice`))).items, []);
  });

  test('packet counters follow the uplink usage, and the sum type adds up', async () => {
    fresh();
    const usage = (await ok(sb.get(`/organizations/${lab.id}/appliance/uplinks/usage/byNetwork?timespan=86400`))).find((n) => n.networkId === wpg.id).byUplink;
    const row = (await ok(sb.get(`${PACKETS()}?timespan=86400&networkIds[]=${wpg.id}`))).items[0];
    assert.deepEqual(row.network, { id: wpg.id });
    for (const [i, u] of usage.entries()) {
      const iface = row.interfaces[i];
      const by = Object.fromEntries(iface.byType.map((t) => [t.type, t]));
      assert.equal(by.unicast.sent > 0, u.sent > 0);
      if (u.sent > 0) {
        const size = u.sent / (by.unicast.sent + by.multicast.sent + by.broadcast.sent);
        assert.ok(size > 400 && size < 1600, `${size} bytes per packet`);
      }
      const sum = by['broadcast unicast multicast'];
      assert.equal(sum.sent, by.broadcast.sent + by.unicast.sent + by.multicast.sent);
      assert.equal(sum.total, sum.sent + sum.recv);
      assert.equal(sum.rates.average.total, Math.round((sum.total / 86400) * 100) / 100);
      assert.equal(by['CRC errors'].total, 0);
    }
    // LAN ports have nothing cabled in the lab.
    assert.ok(row.interfaces.slice(2).every((i) => i.byType.every((t) => t.total === 0)));
    assert.equal(row.interfaces[0].byType.length, 10);
    assert.match(await errorOf(sb.get(`${PACKETS()}?timespan=1209601`)), /timespan/);
    assert.match(await errorOf(sb.get(`${PACKETS()}?perPage=2`)), /perPage/);
    assert.deepEqual((await ok(sb.get(`${PACKETS()}?serials[]=Q2PN-NONE-NONE`))).items, []);
  });

  test('DOM readings come from the seated optics, newest first', async () => {
    fresh();
    const body = await ok(sb.get(`${DOM()}?timespan=7200`));
    assert.deepEqual(body.meta.counts.items, { total: 1, remaining: 0 });
    assert.equal(body.meta.units.power.symbol, 'dBm');
    const [row] = body.items;
    assert.deepEqual(row.network, { id: wpg.id, name: 'Lab - Winnipeg' });
    assert.deepEqual(
      row.ports.map((p) => [p.portId, p.interfaceName, p.readings[0].sfpProductId]),
      [
        ['1', 'TenGigabitEthernet0/0/1', 'SFP-10G-LR-S'],
        ['3', 'TenGigabitEthernet0/0/3', 'SFP-10G-SR-S'],
      ],
    );
    const [wan, lan] = row.ports;
    // Default interval is 1200 s on aligned buckets: the newest is the partial one ending now.
    assert.equal(wan.readings.length, 7);
    assert.equal(wan.readings[0].startTs, '2026-09-29T18:20:00.000000Z');
    assert.equal(Date.parse(wan.readings[0].endTs) / 1000, now);
    assert.ok(Date.parse(wan.readings[0].startTs) > Date.parse(wan.readings[1].startTs));
    const m = wan.readings[0].byMetric;
    assert.ok(m.power.transmit.minimum <= m.power.transmit.median && m.power.transmit.median <= m.power.transmit.maximum);
    assert.ok(m.power.receive.median > -10);
    assert.equal(lan.readings[0].byMetric.power.receive.median, -40);
    assert.ok(Math.abs(m.temperature.fahrenheit.median - (m.temperature.celsius.median * 9) / 5 - 32) < 0.2);
    assert.ok(Math.abs(m.supplyVoltage.level.median - 3.28) < 0.1);
    // Five-minute readings carry one sample each.
    const fine = (await ok(sb.get(`${DOM()}?timespan=3600&interval=300&portIds[]=3`))).items[0];
    assert.deepEqual(fine.ports.map((p) => p.portId), ['3']);
    assert.equal(fine.ports[0].readings.length, 12);
    for (const r of fine.ports[0].readings) assert.equal(r.byMetric.laserBiasCurrent.draw.minimum, r.byMetric.laserBiasCurrent.draw.maximum);
    assert.match(await errorOf(sb.get(`${DOM()}?interval=600`)), /interval/);
    assert.match(await errorOf(sb.get(`${DOM()}?timespan=2592001`)), /timespan/);
    assert.match(await errorOf(sb.get(`${DOM()}?perPage=11`)), /perPage/);
  });

  test('a router that is down has no readings and fails its lookups', async () => {
    fresh();
    router.reloads = [[now - 7200, now + 3600]];
    const row = (await ok(sb.get(`${DOM()}?timespan=7200`))).items[0];
    assert.ok(row.ports.every((p) => p.readings.length === 0));
    const job = await lookup({});
    assert.equal(job.status, 'failed');
    assert.deepEqual(job.errors, ['The device is unreachable.']);
    assert.equal(job.entries, undefined);
  });

  test('the routing table holds the VLANs, static routes and the default route', async () => {
    fresh();
    const all = await lookup({});
    assert.equal(all.status, 'complete');
    assert.deepEqual(all.request, { serial: router.serial });
    assert.deepEqual(
      all.entries.map((e) => [e.type, e.subnet]),
      [
        ['direct', `10.${wpg.siteIndex}.1.0/24`],
        ['default WAN', '0.0.0.0/0'],
      ],
    );
    assert.deepEqual(all.entries[1].nextHops, router.uplinks.map((u, number) => ({ number, address: u.gateway })));
    const vlan = all.entries[0].nextHops[0].vlan;
    assert.equal(vlan.id, '1');
    // A static route shows up with the VLAN its gateway sits in.
    await ok(sb.post(`/networks/${wpg.id}/appliance/staticRoutes`, { name: 'Lab', subnet: '172.20.0.0/16', gatewayIp: `10.${wpg.siteIndex}.1.254` }));
    const statics = await lookup({ type: 'static' });
    assert.deepEqual(statics.entries, [{ type: 'static', subnet: '172.20.0.0/16', nextHops: [{ number: 0, address: `10.${wpg.siteIndex}.1.254`, vlan }], ipVersion: 'ipv4', vrf: { name: 'default' } }]);
    // An address finds its longest prefix match; a subnet the routes inside it.
    assert.deepEqual((await lookup({ destination: { address: '172.20.4.5' } })).entries.map((e) => e.subnet), ['172.20.0.0/16']);
    assert.deepEqual((await lookup({ destination: { address: '8.8.8.8' } })).entries.map((e) => e.type), ['default WAN']);
    assert.deepEqual((await lookup({ destination: { subnet: '172.16.0.0/12' } })).entries.map((e) => e.subnet), ['172.20.0.0/16']);
    assert.deepEqual((await lookup({ nextHop: { address: router.uplinks[1].gateway } })).entries.map((e) => e.type), ['default WAN']);
    assert.deepEqual((await lookup({ vrf: { names: ['default'] }, destination: { address: '10.200.0.1' } })).entries.map((e) => e.type), ['default WAN']);
    // The summary counts the same table.
    const job = await ok(sb.post(`/devices/${router.serial}/liveTools/routingTable/summaries`, {}));
    assert.equal(job.request, undefined);
    const summary = await ok(sb.get(job.url));
    assert.deepEqual(summary.counts, { total: 3, byVrf: [{ name: 'default', byProtocol: { ipv4: { total: 3 }, ipv6: { total: 0 } } }] });
  });

  test('routing table jobs refuse other devices and bad filters', async () => {
    fresh();
    const ottawa = lab.networks.find((n) => n.name === 'Lab - Ottawa').mx;
    assert.equal(await errorOf(sb.post(`/devices/${ottawa.serial}/liveTools/routingTable/lookups`, {})), 'Only Cisco Secure Routers are supported');
    assert.equal(await errorOf(sb.post(`/devices/${ottawa.serial}/liveTools/routingTable/summaries`, {})), 'Only Cisco Secure Routers are supported');
    const [ap] = lab.networks.find((n) => n.name === 'Lab - Toronto').aps;
    assert.match(await errorOf(sb.post(`/devices/${ap.serial}/liveTools/routingTable/lookups`, {})), /not supported/);
    const L = `/devices/${router.serial}/liveTools/routingTable/lookups`;
    assert.match(await errorOf(sb.post(L, { vrf: { names: ['blue'] } })), /VRF 'blue'/);
    assert.match(await errorOf(sb.post(L, { destination: { address: 'nope' } })), /destination.address/);
    assert.match(await errorOf(sb.post(L, { destination: { subnet: '10.0.0.0' } })), /destination.subnet/);
    assert.match(await errorOf(sb.post(L, { nextHop: { address: '1.2.3' } })), /nextHop.address/);
    assert.match(await errorOf(sb.post(L, { vpn: { peer: { id: 'N_1' } } })), /vpn.peer.id/);
    assert.equal((await sb.get(`${L}/1284392014819`)).status, 404);
  });

  test('VPN peers add their exported subnets as BGP routes', async () => {
    fresh();
    // No Secure Router sits in an AutoVPN organization, so read a spoke MX's table directly.
    const corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    const hq = corp.networks.find((n) => n.name === 'HQ - San Francisco');
    const [austin] = corp.networks.filter((n) => n.vpn === 'spoke');
    const bgp = routingEntries(austin.mx).filter((e) => e.type === 'BGP');
    const exported = (await ok(sb.get(`/organizations/${corp.id}/appliance/vpn/statuses`))).find((s) => s.networkId === hq.id).exportedSubnets;
    assert.deepEqual(
      bgp.map((e) => e.subnet),
      exported.map((s) => s.subnet),
    );
    assert.deepEqual(bgp[0].nextHops, [{ number: 0, vpn: { peer: { id: hq.id, name: hq.name } } }]);
  });
});
