import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const mbps = (speed) => parseFloat(speed) * (speed.endsWith('Gbps') ? 1000 : 1);

describe('switch and appliance port views', () => {
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
  const switches = () => org.devices.filter((d) => d.productType === 'switch');

  test('ports overview counts every port and covers the ports connected now', async () => {
    fresh();
    const r = await sb.get(`${O}/switch/ports/overview`);
    assert.equal(r.status, 200);
    const { total, byStatus } = r.body.counts;
    assert.equal(total, sum(switches().map((s) => s.ports.length)));
    assert.equal(byStatus.active.total + byStatus.inactive.total, total);
    const { rj45, sfp } = byStatus.active.byMediaAndLinkSpeed;
    assert.equal(rj45.total + sfp.total, byStatus.active.total);
    assert.equal(rj45.total, sum(Object.entries(rj45).filter(([k]) => k !== 'total').map(([, v]) => v)));
    assert.deepEqual(Object.keys(sfp), ['100', '1000', '10000', '20000', '25000', '40000', '50000', '100000', 'total']);

    // A port connected now was active in the last day, at the speed its status shows.
    const now = { rj45: {}, sfp: {} };
    for (const sw of switches()) {
      const statuses = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses`)).body;
      for (const s of statuses.filter((x) => x.status === 'Connected')) {
        const media = sw.ports.find((p) => p.portId === s.portId).uplinkPort ? 'sfp' : 'rj45';
        now[media][mbps(s.speed)] = (now[media][mbps(s.speed)] ?? 0) + 1;
      }
    }
    for (const media of ['rj45', 'sfp']) {
      for (const [speed, n] of Object.entries(now[media])) assert.ok(byStatus.active.byMediaAndLinkSpeed[media][speed] >= n, `${media} ${speed}`);
    }
    assert.ok(now.rj45['5000'] > 0 && now.sfp['10000'] > 0);

    // Disabling a port moves it to inactive.
    const sw = switches()[0];
    const port = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses`)).body.find((s) => s.status === 'Connected' && !s.isUplink);
    assert.equal((await sb.put(`/devices/${sw.serial}/switch/ports/${port.portId}`, { enabled: false })).status, 200);
    const after = (await sb.get(`${O}/switch/ports/overview`)).body.counts.byStatus;
    assert.equal(after.active.total, byStatus.active.total - 1);
    assert.equal(after.inactive.byMedia.rj45.total, byStatus.inactive.byMedia.rj45.total + 1);
  });

  test('ports overview takes 12 hours to 186 days', async () => {
    fresh();
    assert.match(await errorOf(sb.get(`${O}/switch/ports/overview?timespan=3600`)), /greater than or equal to 43200/);
    assert.match(await errorOf(sb.get(`${O}/switch/ports/overview?timespan=${187 * 86400}`)), /less than or equal/);
    const long = await sb.get(`${O}/switch/ports/overview?timespan=${186 * 86400}`);
    assert.equal(long.status, 200);
    const day = (await sb.get(`${O}/switch/ports/overview`)).body;
    assert.ok(long.body.counts.byStatus.active.total >= day.counts.byStatus.active.total);
  });

  test('client counts match the port statuses for the same window', async () => {
    fresh();
    const r = await sb.get(`${O}/switch/ports/clients/overview/byDevice?perPage=3`);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 3);
    assert.deepEqual(r.body.meta.counts.items, { total: switches().length, remaining: switches().length - 3 });
    for (const row of r.body.items) {
      const statuses = (await sb.get(`/devices/${row.serial}/switch/ports/statuses`)).body;
      const want = statuses.filter((s) => s.clientCount > 0).map((s) => ({ portId: s.portId, counts: { byStatus: { online: s.clientCount } } }));
      assert.deepEqual(row.ports, want, row.serial);
      assert.deepEqual(Object.keys(row), ['name', 'serial', 'mac', 'network', 'model', 'ports']);
    }
    const one = switches()[1];
    const filtered = await sb.get(`${O}/switch/ports/clients/overview/byDevice?serials[]=${one.serial}&timespan=3600`);
    assert.deepEqual(
      filtered.body.items.map((x) => x.serial),
      [one.serial],
    );
    await errorOf(sb.get(`${O}/switch/ports/clients/overview/byDevice?perPage=21`));
  });

  test('topology discovery agrees with the device LLDP/CDP view', async () => {
    fresh();
    const core = hq.switches[0];
    const r = await sb.get(`${O}/switch/ports/topology/discovery/byDevice?serials[]=${core.serial}`);
    assert.equal(r.status, 200);
    const [row] = r.body.items;
    assert.equal(row.serial, core.serial);
    const live = (await sb.get(`/devices/${core.serial}/lldpCdp`)).body.ports;
    const tlv = (list, name) => list.find((x) => x.name === name)?.value;
    for (const [portId, n] of Object.entries(live)) {
      const p = row.ports.find((x) => x.portId === portId);
      assert.ok(p, portId);
      assert.equal(p.lastUpdatedAt, NOW);
      assert.equal(tlv(p.lldp, 'System name'), n.lldp.systemName);
      assert.equal(tlv(p.lldp, 'Chassis ID'), n.lldp.chassisId);
      assert.equal(tlv(p.lldp, 'Port ID'), String(n.lldp.portId));
      if (n.cdp) assert.equal(tlv(p.cdp, 'Platform'), n.cdp.platform);
    }
    // Ports seen earlier in the window but not now report when they were last seen.
    for (const p of row.ports.filter((x) => !live[x.portId])) assert.ok(Date.parse(p.lastUpdatedAt) / 1000 < T);

    const phones = [];
    for (const sw of switches()) {
      const rows = (await sb.get(`${O}/switch/ports/topology/discovery/byDevice?serials[]=${sw.serial}`)).body.items[0].ports;
      phones.push(...rows.filter((p) => p.cdp.length));
    }
    assert.ok(phones.length > 0);
    assert.equal(phones[0].cdp.find((x) => x.name === 'Platform').value, 'Cisco IP Phone 8845');
    assert.equal(phones[0].lldp.find((x) => x.name === 'System capabilities').value, 'Telephone');
    await errorOf(sb.get(`${O}/switch/ports/topology/discovery/byDevice?perPage=2`));
  });

  test('usage history totals match the port statuses for the same window', async () => {
    fresh();
    const sw = hq.switches[1];
    const r = await sb.get(`${O}/switch/ports/usage/history/byDevice/byInterval?serials[]=${sw.serial}`);
    assert.equal(r.status, 200);
    const [row] = r.body.items;
    const statuses = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses`)).body;
    assert.equal(row.ports.length, statuses.length);
    let busy = 0;
    for (const p of row.ports) {
      const s = statuses.find((x) => x.portId === p.portId);
      // 1200 s intervals over the default day, the first one starting before t0.
      assert.equal(p.intervals.length, 73);
      assert.equal(p.intervals[0].endTs, '2026-09-28T18:40:00Z');
      assert.equal(p.intervals.at(-1).endTs, '2026-09-29T18:40:00Z');
      const n = p.intervals.length;
      close(sum(p.intervals.map((i) => i.data.usage.total)), s.usageInKb.total, n, p.portId);
      close(sum(p.intervals.map((i) => i.data.usage.upstream)) + sum(p.intervals.map((i) => i.data.usage.downstream)), s.usageInKb.total, n, p.portId);
      close(sum(p.intervals.map((i) => i.energy.usage.total)), s.powerUsageInWh, 0.05 * n + 0.1, p.portId);
      if (s.usageInKb.total > 0) busy++;
    }
    assert.ok(busy > 10);
    // An access port's upstream is what its device sends, the port status's recv.
    const ap = row.ports.find((p) => sw.ports.find((x) => x.portId === p.portId).peer?.device.productType === 'wireless');
    const apStatus = statuses.find((x) => x.portId === ap.portId);
    close(sum(ap.intervals.map((i) => i.data.usage.upstream)), apStatus.usageInKb.recv, 73);
    const i = ap.intervals.slice(1).find((x) => x.data.usage.total > 0);
    close(i.bandwidth.usage.total, (i.data.usage.total * 8) / 1200, 0.2);
  });

  test('usage history intervals and windows', async () => {
    fresh();
    const path = `${O}/switch/ports/usage/history/byDevice/byInterval?serials[]=${hq.switches[0].serial}`;
    const len = async (q) => (await sb.get(`${path}&${q}`)).body.items[0].ports[0].intervals;
    assert.equal((await len('interval=300')).length, 72);
    assert.equal((await len('interval=300'))[0].startTs, '2026-09-29T12:30:00Z');
    assert.equal((await len('interval=86400')).length, 32);
    assert.equal((await len('timespan=86400&interval=300')).length, 288);
    // Too many intervals for the span: the next larger interval is used.
    const month = await len(`timespan=${31 * 86400}&interval=300`);
    assert.equal(Date.parse(month[1].startTs) - Date.parse(month[0].startTs), 14400 * 1000);
    assert.match(await errorOf(sb.get(`${path}&interval=600`)), /one of 300, 1200, 14400, 86400/);
    await errorOf(sb.get(`${path}&timespan=${32 * 86400}`));
    await errorOf(sb.get(`${O}/switch/ports/usage/history/byDevice/byInterval?perPage=51`));
    const page = await sb.get(`${O}/switch/ports/usage/history/byDevice/byInterval?perPage=3&networkIds[]=${hq.id}`);
    assert.deepEqual(page.body.meta.counts.items, { total: 3, remaining: 0 });
  });

  test('DHCP servers seen lists the MX on each DHCP VLAN', async () => {
    fresh();
    const r = await sb.get(`/networks/${hq.id}/switch/dhcp/v4/servers/seen`);
    assert.equal(r.status, 200);
    const vlans = (await sb.get(`/networks/${hq.id}/appliance/vlans`)).body;
    const leased = new Set(hq.clients.map((c) => c.vlan));
    assert.deepEqual(
      r.body.map((x) => x.vlan),
      vlans.map((v) => Number(v.id)).filter((id) => leased.has(id)),
    );
    for (const s of r.body) {
      const v = vlans.find((x) => Number(x.id) === s.vlan);
      assert.equal(s.mac, hq.mx.mac);
      assert.equal(s.type, 'device');
      assert.equal(s.device.serial, hq.mx.serial);
      assert.equal(s.device.interface.name, v.name);
      assert.deepEqual(s.ipv4, { address: v.applianceIp, subnet: v.subnet, gateway: v.applianceIp });
      assert.equal(s.lastAck.ts, s.lastSeenAt);
      const t = Date.parse(s.lastSeenAt) / 1000;
      assert.ok(t <= T && t >= T - 86400);
      const client = hq.clients.find((c) => c.ip === s.lastAck.ipv4.address);
      assert.equal(client.vlan, s.vlan);
      assert.equal(s.lastPacket.destination.mac, client.mac);
      assert.equal(s.lastPacket.fields.yiaddr, client.ip);
      assert.ok(s.seenBy.length > 0 && s.seenBy.length <= hq.switches.length);
    }

    // A VLAN that stops serving DHCP drops out.
    const id = r.body[0].vlan;
    assert.equal((await sb.put(`/networks/${hq.id}/appliance/vlans/${id}`, { dhcpHandling: 'Do not respond to DHCP requests' })).status, 200);
    const after = (await sb.get(`/networks/${hq.id}/switch/dhcp/v4/servers/seen`)).body;
    assert.equal(after.length, r.body.length - 1);
    assert.ok(!after.some((x) => x.vlan === id));

    const page = await sb.get(`/networks/${hq.id}/switch/dhcp/v4/servers/seen?perPage=3`);
    assert.equal(page.body.length, 3);
    await errorOf(sb.get(`/networks/${hq.id}/switch/dhcp/v4/servers/seen?perPage=2`));
    const lab = sb.world.orgs[1].networks[0];
    assert.match(await errorOf(sb.get(`/networks/${lab.id}/switch/dhcp/v4/servers/seen`)), /product type 'switch'/);
  });

  test('DHCP servers seen with VLANs off is the single LAN', async () => {
    fresh();
    assert.equal((await sb.put(`/networks/${hq.id}/appliance/vlans/settings`, { vlansEnabled: false })).status, 200);
    const r = await sb.get(`/networks/${hq.id}/switch/dhcp/v4/servers/seen`);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].vlan, 1);
  });

  test('appliance interface ports by device agree with the network port view', async () => {
    fresh();
    const r = await sb.get(`${O}/appliance/devices/interfaces/ports/byDevice`);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['items']);
    const mxs = org.devices.filter((d) => d.productType === 'appliance');
    assert.deepEqual(
      r.body.items.map((x) => x.serial),
      mxs.map((d) => d.serial).sort(),
    );
    for (const item of r.body.items) {
      const mx = mxs.find((d) => d.serial === item.serial);
      const wan = item.ports.filter((p) => p.personality.mode === 'wan');
      assert.deepEqual(
        wan.map((p) => p.name),
        mx.uplinks.map((u) => u.interface),
      );
      assert.equal(wan[0].uplink.primary, true);
      const lan = (await sb.get(`/networks/${mx.net.id}/appliance/ports`)).body;
      for (const p of item.ports.filter((x) => x.personality.mode === 'lan')) {
        const want = lan.find((x) => String(x.number) === p.number);
        assert.equal(p.enabled, want.enabled);
        assert.equal(p.downlink.mode, want.type);
        if (want.type === 'access') assert.equal(p.downlink.access.vlan, String(want.vlan));
        else assert.equal(p.downlink.trunk.nativeVlan, String(want.vlan));
        assert.equal(p.uplink, undefined);
      }
    }
    // The MX67's second uplink sits on its WAN/LAN port 2.
    const denver = r.body.items.find((x) => mxs.find((d) => d.serial === x.serial).model === 'MX67');
    const two = denver.ports.find((p) => p.number === '2');
    assert.equal(two.personality.mode, 'wan');
    assert.equal(two.personality.isFlexible, true);

    const mx = hq.mx;
    assert.equal((await sb.put(`/networks/${hq.id}/appliance/ports/4`, { enabled: true, type: 'access', vlan: 20 })).status, 200);
    const one = await sb.get(`${O}/appliance/devices/interfaces/ports/byDevice?serials[]=${mx.serial}&numbers[]=4&numbers[]=1`);
    assert.deepEqual(
      one.body.items[0].ports.map((p) => p.number),
      ['1', '4'],
    );
    assert.deepEqual(one.body.items[0].ports[1].downlink.access, { vlan: '20', policy: { type: 'open' } });
  });
});
