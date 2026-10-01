import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { syslogRolesFor } from '../src/config.js';
import { crcPort } from '../src/sim/alerts.js';
import { eachOutage } from '../src/sim/outages.js';
import { DAY } from '../src/time.js';
import { NOW, relLink, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('organization device views', () => {
  let sb;
  let org;
  let lab;
  let hq;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [org, lab] = sb.world.orgs;
    hq = org.networks[0];
  };
  const byCode = (code) => org.networks.find((n) => n.code === code);

  test('power modules list the switches with power supplies, matching device statuses', async () => {
    fresh();
    const r = await sb.get(`/organizations/${org.id}/devices/powerModules/statuses/byDevice`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.map((d) => d.serial),
      [hq.switches[0].serial],
    );
    const [row] = r.body;
    assert.deepEqual(row.network, { id: hq.id });
    const status = (await sb.get(`/organizations/${org.id}/devices/statuses?serials[]=${row.serial}`)).body[0];
    assert.deepEqual(
      row.slots,
      status.components.powerSupplies.map((p) => ({ number: p.slot, serial: p.serial, model: p.model, status: 'powering' })),
    );
    assert.deepEqual((await sb.get(`/organizations/${org.id}/devices/powerModules/statuses/byDevice?productTypes[]=wireless`)).body, []);
    assert.deepEqual((await sb.get(`/organizations/${lab.id}/devices/powerModules/statuses/byDevice`)).body, []);
  });

  test('uplink addresses agree with uplink and device statuses', async () => {
    fresh();
    const rows = (await sb.get(`/organizations/${org.id}/devices/uplinks/addresses/byDevice`)).body;
    assert.equal(rows.length, org.devices.length);
    const statuses = new Map((await sb.get(`/organizations/${org.id}/devices/statuses`)).body.map((d) => [d.serial, d]));
    const uplinks = new Map((await sb.get(`/organizations/${org.id}/uplinks/statuses`)).body.map((d) => [d.serial, d]));
    for (const row of rows) {
      const s = statuses.get(row.serial);
      if (row.productType === 'appliance') {
        const u = uplinks.get(row.serial).uplinks;
        assert.deepEqual(
          row.uplinks.map((x) => [x.interface, x.addresses[0].address, x.addresses[0].assignmentMode]),
          u.map((x) => [x.interface, x.ip, x.ipAssignedBy === 'static' ? 'static' : 'dynamic']),
        );
      } else {
        assert.equal(row.uplinks.length, 1);
        const [a] = row.uplinks[0].addresses;
        assert.equal(row.uplinks[0].interface, 'man1');
        assert.deepEqual([a.address, a.gateway, a.public.address, a.vlan.id], [s.lanIp, s.gateway, s.publicIp, '1']);
      }
    }
    const aus = byCode('AUS');
    const only = (await sb.get(`/organizations/${org.id}/devices/uplinks/addresses/byDevice?networkIds[]=${aus.id}`)).body;
    assert.equal(only.length, aus.devices.length);
  });

  test('a static management address shows up in uplink addresses', async () => {
    fresh();
    const ap = hq.aps[0];
    const wan1 = { usingStaticIp: true, staticIp: '10.1.1.200', staticSubnetMask: '255.255.255.0', staticGatewayIp: '10.1.1.1', staticDns: ['10.1.5.53'], vlan: 1 };
    assert.equal((await sb.put(`/devices/${ap.serial}/managementInterface`, { wan1 })).status, 200);
    const [row] = (await sb.get(`/organizations/${org.id}/devices/uplinks/addresses/byDevice?serials[]=${ap.serial}`)).body;
    const [a] = row.uplinks[0].addresses;
    assert.deepEqual([a.assignmentMode, a.address, a.gateway, a.nameservers.addresses], ['static', '10.1.1.200', '10.1.1.1', ['10.1.5.53']]);
  });

  test('memory history defaults to two hours of five-minute intervals, newest first', async () => {
    fresh();
    const r = await sb.get(`/organizations/${org.id}/devices/system/memory/usage/history/byInterval`);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 10);
    assert.deepEqual(r.body.meta.counts.items, { total: org.devices.length, remaining: org.devices.length - 10 });
    for (const item of r.body.items) {
      if (item.serial === byCode('RNO').cameras.find((c) => c.dormant)?.serial) continue;
      const ends = item.intervals.map((i) => Date.parse(i.endTs) / 1000);
      assert.ok(ends.length <= 24 && ends.length >= 20, `${item.serial}: ${ends.length} intervals`);
      assert.ok(ends.every((t, i) => i === 0 || ends[i - 1] - t >= 300));
      for (const { startTs, endTs, memory: m } of item.intervals) {
        assert.equal(Date.parse(endTs) - Date.parse(startTs), 300000);
        assert.ok(m.used.minimum <= m.used.median && m.used.median <= m.used.maximum);
        assert.equal(m.used.minimum + m.free.maximum, item.provisioned);
        assert.ok(m.used.percentages.maximum > 0 && m.used.percentages.maximum <= 100);
      }
      assert.ok(item.used.median + item.free.median - item.provisioned <= 1);
    }
  });

  test('memory history pages through every device and leaves out downtime', async () => {
    fresh();
    const seen = [];
    let url = `/organizations/${org.id}/devices/system/memory/usage/history/byInterval?perPage=7&timespan=86400`;
    while (url) {
      const r = await sb.get(url);
      assert.equal(r.status, 200);
      seen.push(...r.body.items);
      assert.equal(r.body.meta.counts.items.remaining, org.devices.length - seen.length);
      url = relLink(r.link, 'next');
    }
    assert.deepEqual(
      seen.map((i) => i.serial),
      org.devices.map((d) => d.serial).sort(),
    );
    // One day picks five-minute intervals; each sample time a device was down is missing.
    for (const item of seen) {
      const dev = sb.world.deviceBySerial.get(item.serial);
      let expected = 0;
      for (let t = Math.ceil((now - DAY) / 300) * 300 + 300; t <= Math.floor(now / 300) * 300; t += 300) {
        let down = dev.dormant && t >= dev.dormantSince;
        eachOutage(dev, t, t + 1, () => (down = true));
        if (!down) expected++;
      }
      assert.equal(item.intervals.length, expected, item.serial);
    }
    const dormant = seen.find((i) => sb.world.deviceBySerial.get(i.serial).dormant);
    assert.deepEqual([dormant.intervals, dormant.used.median], [[], null]);
  });

  test('memory history picks a coarser interval for long windows', async () => {
    fresh();
    const q = (s) => sb.get(`/organizations/${org.id}/devices/system/memory/usage/history/byInterval?${s.includes('perPage') ? '' : 'perPage=3&'}${s}`);
    const step = (r) => (Date.parse(r.body.items[0].intervals[0].endTs) - Date.parse(r.body.items[0].intervals[0].startTs)) / 1000;
    assert.equal(step(await q('timespan=2678400')), 14400);
    assert.equal(step(await q('timespan=2678400&interval=300')), 14400);
    assert.equal(step(await q('timespan=86400&interval=3600')), 3600);
    const alone = await q('interval=1200');
    assert.equal(step(alone), 1200);
    assert.ok(alone.body.items[0].intervals.length <= 24);
    assert.equal((await q('interval=60')).status, 400);
    assert.equal((await q('perPage=21')).status, 400);
    assert.equal((await q(`t0=${now - 40 * DAY}`)).status, 400);
  });

  test('syslog servers and roles come one row per network', async () => {
    fresh();
    const servers = [{ host: '192.0.2.50', port: 6514, roles: ['switchEventLog'], transportProtocol: 'TCP', encryption: { enabled: true } }];
    assert.equal((await sb.put(`/networks/${hq.id}/devices/syslog/servers`, { servers })).status, 200);
    const r = await sb.get(`/organizations/${org.id}/devices/syslog/servers/byNetwork?perPage=3`);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 3);
    assert.deepEqual(r.body.meta.counts.items, { total: org.networks.length, remaining: org.networks.length - 3 });
    const one = (await sb.get(`/organizations/${org.id}/devices/syslog/servers/byNetwork?networkIds[]=${hq.id}`)).body.items;
    assert.deepEqual(one, [{ network: { id: hq.id }, servers }]);
    const tor = lab.networks[0];
    const roles = (await sb.get(`/organizations/${lab.id}/devices/syslog/servers/roles/byNetwork`)).body.items;
    assert.deepEqual(roles, [{ network: { id: tor.id }, available: syslogRolesFor(tor).map(({ name, value }) => ({ name, value })) }]);
    assert.ok(roles[0].available.every((x) => x.value.startsWith('wireless')));
  });

  test('the EOX overview counts what inventory reports', async () => {
    fresh();
    const inv = (await sb.get(`/organizations/${org.id}/inventory/devices`)).body;
    const r = await sb.get(`/organizations/${org.id}/inventory/devices/eox/overview`);
    assert.equal(r.status, 200);
    for (const status of ['endOfSale', 'endOfSupport', 'nearEndOfSupport']) {
      assert.equal(r.body.counts.byStatus[status].total, inv.filter((d) => d.eox.status === status).length);
    }
  });
});

describe('switch port packets and cycling', () => {
  let sb;
  let org;
  before(async () => {
    sb = await start();
    org = sb.world.orgs[0];
  });
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
    org = sb.world.orgs[0];
  });
  after(() => sb.close());
  const DESCS = ['Total', 'Broadcast', 'Multicast', 'CRC align errors', 'Fragments', 'Collisions', 'Topology changes'];

  test('every port has the seven counters, and only the CRC port has errors', async () => {
    for (const sw of org.devices.filter((d) => d.productType === 'switch')) {
      const r = await sb.get(`/devices/${sw.serial}/switch/ports/statuses/packets`);
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.body.map((p) => p.portId),
        sw.ports.map((p) => p.portId),
      );
      for (const { portId, packets } of r.body) {
        assert.deepEqual(
          packets.map((p) => p.desc),
          DESCS,
        );
        const [total, bcast, mcast, crc] = packets;
        for (const p of packets) assert.equal(p.total, p.sent + p.recv);
        assert.ok(total.sent >= bcast.sent + mcast.sent - 1 && total.recv >= bcast.recv + mcast.recv - 1);
        assert.equal(packets[5].total, 0, 'full duplex, no collisions');
        const port = sw.ports.find((p) => p.portId === portId);
        assert.equal(crc.total > 0, !!sw.alerting && port === crcPort(sw), `${sw.name} ${portId}`);
        // A topology change each time the device on the port came back up.
        let changes = 0;
        if (port.peer) eachOutage(port.peer.device, now - DAY, now, (s, e) => e >= now - DAY && e < now && changes++);
        assert.equal(packets[6].total, changes);
        if (!port.peer && !port.clients.length) assert.equal(total.total, 0);
      }
    }
  });

  test('a disabled port counts nothing and the window snaps to a preset length', async () => {
    const sw = org.networks[0].switches[1];
    assert.equal((await sb.put(`/devices/${sw.serial}/switch/ports/1`, { enabled: false })).status, 200);
    const base = `/devices/${sw.serial}/switch/ports/statuses/packets`;
    const day = (await sb.get(base)).body;
    assert.ok(day[0].packets.every((p) => p.total === 0));
    assert.ok(day[1].packets[0].total > 0);
    assert.deepEqual((await sb.get(`${base}?timespan=600`)).body, (await sb.get(`${base}?timespan=300`)).body);
    assert.deepEqual((await sb.get(`${base}?t0=${new Date((now - 7000) * 1000).toISOString()}`)).body, (await sb.get(`${base}?timespan=3600`)).body);
    assert.equal((await sb.get(`${base}?timespan=90000`)).status, 400);
    assert.equal((await sb.get(`${base}?timespan=300&t0=${now - 300}`)).status, 400);
    assert.equal((await sb.get(`/devices/${org.networks[0].aps[0].serial}/switch/ports/statuses/packets`)).status, 400);
  });

  test("the flaky AP's port counts a topology change after each drop, unless it is disabled", async () => {
    const ap = org.networks.find((n) => n.code === 'RNO').aps.find((a) => a.flaky);
    let end = null;
    eachOutage(ap, now - 30 * DAY, now, (s, e) => (end ??= e));
    // Outages only depend on the seed, so another emulator ten minutes after the drop sees it too.
    const other = await start({ now: new Date((end + 600) * 1000).toISOString() });
    try {
      const sw = other.world.deviceBySerial.get(ap.switchPort.switch.serial);
      const path = `/devices/${sw.serial}/switch/ports/statuses/packets?timespan=900`;
      const port = (r) => r.body.find((p) => p.portId === ap.switchPort.portId).packets;
      assert.ok(port(await other.get(path))[6].total >= 1);
      assert.equal((await other.put(`/devices/${sw.serial}/switch/ports/${ap.switchPort.portId}`, { enabled: false })).status, 200);
      assert.ok(port(await other.get(path)).every((p) => p.total === 0));
    } finally {
      await other.close();
    }
  });

  test('cycling takes ports and ranges the switch has', async () => {
    const sw = org.networks[0].switches[0];
    const path = `/devices/${sw.serial}/switch/ports/cycle`;
    const r = await sb.post(path, { ports: ['1', '2-5', '56'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ports: ['1', '2-5', '56'] });
    for (const ports of [['57'], ['5-2'], ['1-99'], ['abc'], []]) assert.equal((await sb.post(path, { ports })).status, 400, JSON.stringify(ports));
    assert.equal((await sb.post(path, {})).status, 400);
    assert.equal((await sb.post(`/devices/${org.networks[0].aps[0].serial}/switch/ports/cycle`, { ports: ['1'] })).status, 400);
    assert.equal((await sb.get(path)).status, 405);
  });
});
