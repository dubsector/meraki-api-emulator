import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { DAY, iso } from '../src/time.js';
import { swapDevice } from '../src/world.js';
import { NOW, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('cellular gateways', () => {
  let sb;
  let lab;
  let kgn;
  let mg52;
  let mg21;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    kgn = lab.networks.find((n) => n.name === 'Lab - Kingston');
    mg52 = kgn.devices.find((d) => d.model === 'MG52');
    mg21 = kgn.devices.find((d) => d.model === 'MG21');
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
  const C = () => `/organizations/${lab.id}/devices/cellular`;
  const D = (d, p) => `/devices/${d.serial}/${p}`;

  test('Lab - Kingston has an MG52 and an MG21 that the org cellular reads list', async () => {
    fresh();
    assert.deepEqual(kgn.productTypes, ['cellularGateway']);
    const serials = [mg21.serial, mg52.serial].sort();
    for (const p of ['data/devices', 'data/usage/byDevice', 'geolocations', 'uplinks/bands/byDevice', 'uplinks/towers/byDevice']) {
      assert.deepEqual((await ok(sb.get(`${C()}/${p}`))).items.map((x) => x.serial), serials, p);
    }
    const devices = (await ok(sb.get(`${C()}/data/devices`))).items;
    const row = devices.find((x) => x.serial === mg52.serial);
    assert.deepEqual(row.modems[0].sims.map((s) => s.slot), ['sim1', 'sim2']);
    assert.deepEqual(row.profile, { assigned: false, id: null, name: null });
    assert.deepEqual(row.network, { name: 'Lab - Kingston', id: kgn.id });
    assert.deepEqual((await ok(sb.get(`${C()}/data/devices?slots[]=sim2`))).items.map((x) => x.serial), [mg52.serial]);
    assert.deepEqual((await ok(sb.get(`${C()}/data/devices?name=kgn-02`))).items.map((x) => x.serial), [mg21.serial]);
    assert.deepEqual((await ok(sb.get(`${C()}/data/devices?excludedSerials[]=${mg21.serial}`))).items.map((x) => x.serial), [mg52.serial]);
    const bands = (await ok(sb.get(`${C()}/uplinks/bands/byDevice?serials[]=${mg21.serial}`))).items[0];
    assert.deepEqual(bands.bySlot[0].bySignalType.map((t) => t.type), ['LTE']);
    // Acme Corporation has no cellular devices.
    assert.deepEqual((await ok(sb.get(`/organizations/${sb.world.orgs[0].id}/devices/cellular/geolocations`))).items, []);
  });

  test('uplink statuses agree with the SIMs, device statuses, uplink addresses and org uplinks', async () => {
    fresh();
    const rows = await ok(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses`));
    assert.deepEqual(rows.map((r) => r.serial), [mg21.serial, mg52.serial].sort());
    const u = rows.find((r) => r.serial === mg52.serial).uplinks[0];
    const sims = await ok(sb.get(D(mg52, 'cellular/sims')));
    const primary = sims.sims.find((s) => s.isPrimary);
    assert.equal(u.iccid, primary.iccid);
    assert.equal(u.imsi, primary.imsi);
    assert.equal(u.mcc + u.mnc, primary.imsi.slice(0, 6));
    assert.equal(u.status, 'active');
    assert.equal(u.connectionType, '5g');
    const status = (await ok(sb.get(`/organizations/${lab.id}/devices/statuses?serials[]=${mg52.serial}`)))[0];
    assert.deepEqual([status.publicIp, status.gateway, status.primaryDns, status.secondaryDns], [u.publicIp, u.gateway, u.dns1, u.dns2]);
    const addr = (await ok(sb.get(`/organizations/${lab.id}/devices/uplinks/addresses/byDevice?serials[]=${mg52.serial}`)))[0].uplinks[0];
    assert.equal(addr.interface, 'cellular');
    assert.deepEqual([addr.addresses[0].address, addr.addresses[0].public.address], [u.ip, u.publicIp]);
    const org = (await ok(sb.get(`/organizations/${lab.id}/uplinks/statuses?serials[]=${mg52.serial}`)))[0].uplinks[0];
    assert.deepEqual([org.interface, org.ip, org.publicIp, org.primaryDns], ['cellular', u.ip, u.publicIp, u.dns1]);
    // The appliance-only view leaves MGs out.
    assert.deepEqual(await ok(sb.get(`/organizations/${lab.id}/appliance/uplink/statuses?serials[]=${mg52.serial}`)), []);
    assert.deepEqual((await ok(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses?iccids[]=${u.iccid}`))).map((r) => r.serial), [mg52.serial]);
    assert.deepEqual(await ok(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses?networkIds[]=${lab.networks[0].id}`)), []);
    await errorOf(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses?perPage=2`));
  });

  test('usage history adds up to the current term, which a profile rule can set', async () => {
    fresh();
    const month = Date.UTC(2026, 8, 1) / 1000;
    const cur = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=${mg52.serial}`))).items[0];
    assert.deepEqual(cur.bySlot.map((s) => [s.slot, s.startTs, s.endTs, s.limit]), [
      ['sim1', iso(month), '2026-09-30T23:59:59Z', null],
      ['sim2', iso(month), '2026-09-30T23:59:59Z', null],
    ]);
    assert.equal(cur.bySlot[1].total, '0');
    const hist = (await ok(sb.get(`${C()}/data/usage/history/byDevice/byInterval?serials[]=${mg52.serial}&t0=${iso(month)}&t1=${NOW}&interval=86400`))).items[0];
    assert.equal(hist.intervals.length, 29);
    const sum = hist.intervals.reduce((a, x) => a + x.usage.total, 0);
    assert.equal(String(sum), cur.bySlot[0].total);
    assert.ok(sum > 0);
    for (const x of hist.intervals) assert.equal(x.usage.bySim.find((s) => s.name === 'sim1').total, x.usage.total);
    // Five minute buckets add up to the hour.
    const t0 = '2026-09-29T12:00:00Z';
    const fine = (await ok(sb.get(`${C()}/data/usage/history/byDevice/byInterval?serials[]=${mg52.serial}&t0=${t0}&t1=2026-09-29T13:00:00Z&interval=300`))).items[0].intervals;
    const hour = (await ok(sb.get(`${C()}/data/usage/history/byDevice/byInterval?serials[]=${mg52.serial}&t0=${t0}&t1=2026-09-29T13:00:00Z&interval=14400`))).items[0].intervals;
    assert.equal(fine.length, 12);
    assert.equal(fine.reduce((a, x) => a + x.usage.total, 0), hour[0].usage.total);

    const p = await ok(sb.post(`${C()}/data/profiles`, { name: 'Daily', description: 'Lab SIMs', rules: [{ slot: 'sim1', uplink: { priority: 1, isPreferred: true }, cap: { value: 500, term: { resets: 'daily', starts: { hourOfDay: 6 } } } }] }));
    await ok(sb.post(`${C()}/data/profiles/assignments/batchCreate`, { items: [{ profile: { id: p.profileId }, device: { serial: mg52.serial } }] }));
    const after = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=${mg52.serial}`))).items[0].bySlot[0];
    assert.deepEqual([after.startTs, after.endTs, after.limit], ['2026-09-29T06:00:00Z', '2026-09-30T05:59:59Z', String(500 * 1048576)]);
    const day = (await ok(sb.get(`${C()}/data/usage/history/byDevice/byInterval?serials[]=${mg52.serial}&t0=2026-09-29T06:00:00Z&t1=${NOW}&interval=86400`))).items[0];
    assert.equal(String(day.intervals.reduce((a, x) => a + x.usage.total, 0)), after.total);
    const row = (await ok(sb.get(`${C()}/data/devices?serials[]=${mg52.serial}`))).items[0];
    assert.deepEqual(row.profile, { assigned: true, id: p.profileId, name: 'Daily' });
    assert.deepEqual((await ok(sb.get(`${C()}/data/devices?includeAssigned=false`))).items.map((x) => x.serial), [mg21.serial]);
  });

  test('SIM settings pick the primary SIM, keep APN passwords and move the uplink', async () => {
    fresh();
    const before = await ok(sb.get(D(mg52, 'cellular/sims')));
    assert.deepEqual(before.simOrdering, ['sim1', 'sim2']);
    assert.deepEqual(before.simFailover, { enabled: true, timeout: 300 });
    const apn = { name: 'internet', allowedIpTypes: ['ipv4'], authentication: { type: 'pap', username: 'lab', password: 'secret' } };
    let s = await ok(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim2', isPrimary: true, apns: [apn] }], simFailover: { timeout: 120 } }));
    assert.deepEqual(s.simOrdering, ['sim2', 'sim1']);
    assert.deepEqual(s.sims.map((x) => [x.slot, x.isPrimary, x.status]), [['sim1', false, 'standby'], ['sim2', true, 'active']]);
    assert.deepEqual(s.simFailover, { enabled: true, timeout: 120 });
    s = await ok(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim2', simOrder: 1, apns: [{ ...apn, authentication: { type: 'pap', username: 'lab2' } }] }] }));
    assert.deepEqual(s.sims[1].apns[0].authentication, { type: 'pap', username: 'lab2', password: 'secret' });
    const u = (await ok(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses?serials[]=${mg52.serial}`)))[0].uplinks[0];
    assert.deepEqual([u.iccid, u.apn], [s.sims[1].iccid, 'internet']);
    const usage = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=${mg52.serial}`))).items[0].bySlot;
    assert.equal(usage[0].total, '0');
    assert.notEqual(usage[1].total, '0');

    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim3', isPrimary: true }] })), /sim1, sim2/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim1' }] })), /isPrimary/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { simOrdering: ['sim1'] })), /each of/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim1', isPrimary: true }], simOrdering: ['sim2', 'sim1'] })), /primary/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim1', isPrimary: true, apns: [{ name: 'x', allowedIpTypes: ['ipv5'] }] }] })), /allowedIpTypes/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim1', isPrimary: true, apns: [{ name: 'x', allowedIpTypes: ['ipv4'], authentication: { type: 'chap' } }] }] })), /username/);
    assert.match(await errorOf(sb.put(D(mg21, 'cellular/sims'), { simFailover: { enabled: true } })), /two SIMs/);
    assert.match(await errorOf(sb.put(D(mg21, 'cellular/sims'), { sims: [{ slot: 'sim1', isPrimary: false }] })), /single-SIM/);
    assert.match(await errorOf(sb.get(D(lab.networks[0].aps[0], 'cellular/sims'))), /MG cellular gateways/);
    // The answer goes back unchanged.
    await ok(sb.put(D(mg52, 'cellular/sims'), s));
  });

  test('band masks show in the bands view, geolocation can be turned off', async () => {
    fresh();
    const r = await ok(sb.post(D(mg52, 'cellular/uplinks/bands/masks/update'), { slot: 'sim2', type: 'LTE', masked: ['71', '2', '71'] }));
    const lte = r.bySlot[1].bySignalType[0];
    assert.deepEqual(lte.masked, ['2', '71']);
    assert.ok(!lte.enabled.includes('2') && lte.enabled.length === lte.supported.length - 2);
    const all = await ok(sb.post(D(mg52, 'cellular/uplinks/bands/masks/update'), { slot: 'sim1', type: '5GSA', masked: ['all'] }));
    assert.deepEqual(all.bySlot[0].bySignalType[2].enabled, []);
    const view = (await ok(sb.get(`${C()}/uplinks/bands/byDevice?serials[]=${mg52.serial}`))).items[0];
    assert.deepEqual(view.bySlot, all.bySlot);
    assert.match(await errorOf(sb.post(D(mg21, 'cellular/uplinks/bands/masks/update'), { slot: 'sim1', type: '5GNSA', masked: [] })), /LTE/);
    assert.match(await errorOf(sb.post(D(mg21, 'cellular/uplinks/bands/masks/update'), { slot: 'sim2', type: 'LTE', masked: [] })), /sim1/);
    assert.match(await errorOf(sb.post(D(mg21, 'cellular/uplinks/bands/masks/update'), { slot: 'sim1', type: 'LTE', masked: ['n2'] })), /not supported/);
    assert.match(await errorOf(sb.post(D(mg21, 'cellular/uplinks/bands/masks/update'), { slot: 'sim1', type: 'LTE', masked: ['all', '2'] })), /all/);

    const geo = (await ok(sb.get(`${C()}/geolocations?serials[]=${mg21.serial}`))).items[0].geolocation;
    assert.equal(geo.enabled, true);
    assert.equal(geo.lastReportedAt, '2026-09-29T18:00:00Z');
    assert.ok(Math.abs(geo.latitude - 44.2312) < 0.01);
    assert.deepEqual(await ok(sb.put(D(mg21, 'cellular/geolocations'), { enabled: false })), { enabled: false });
    assert.deepEqual((await ok(sb.get(`${C()}/geolocations?serials[]=${mg21.serial}`))).items[0].geolocation, { enabled: false, latitude: null, longitude: null, lastReportedAt: null });
  });

  test('LAN settings and port forwarding rules are replaced whole and stay on the LAN', async () => {
    fresh();
    const lan = await ok(sb.get(D(mg52, 'cellularGateway/lan')));
    assert.deepEqual(lan, { deviceName: 'MG-KGN-01', deviceLanIp: '192.168.0.33', deviceSubnet: '192.168.0.32/27', fixedIpAssignments: [], reservedIpRanges: [] });
    const body = { fixedIpAssignments: [{ name: 'Camera', ip: '192.168.0.40', mac: '0B:00:00:00:00:AC' }], reservedIpRanges: [{ start: '192.168.0.50', end: '192.168.0.55', comment: 'Spare' }] };
    const got = await ok(sb.put(D(mg52, 'cellularGateway/lan'), body));
    assert.deepEqual(got.fixedIpAssignments, [{ name: 'Camera', ip: '192.168.0.40', mac: '0b:00:00:00:00:ac' }]);
    const kept = await ok(sb.put(D(mg52, 'cellularGateway/lan'), { reservedIpRanges: [] }));
    assert.deepEqual([kept.fixedIpAssignments.length, kept.reservedIpRanges.length], [1, 0]);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { reservedIpRanges: [{ start: '192.168.1.0', end: '192.168.1.1', comment: 'x' }] })), /192.168.0.32\/27/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { reservedIpRanges: [{ start: '192.168.0.45', end: '192.168.0.41', comment: 'x' }] })), /start before/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { reservedIpRanges: [{ start: '192.168.0.38', end: '192.168.0.42', comment: 'x' }] })), /inside a reserved range/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { fixedIpAssignments: [{ ip: '192.168.0.33', mac: '00:11:22:33:44:55' }] })), /own address/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { fixedIpAssignments: [{ ip: '192.168.0.41', mac: 'nope' }] })), /MAC/);
    // Each MG keeps its own.
    assert.deepEqual((await ok(sb.get(D(mg21, 'cellularGateway/lan')))).fixedIpAssignments, []);

    const rules = [
      { name: 'Web', lanIp: '192.168.0.40', publicPort: '8080-8081', localPort: '80-81', protocol: 'tcp', access: 'restricted', allowedIps: ['10.10.10.10', '203.0.113.0/24'] },
      { lanIp: '192.168.0.41', publicPort: '22', localPort: '22', protocol: 'udp', access: 'any' },
    ];
    const pf = await ok(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules }));
    assert.deepEqual(pf.rules.map((r) => [r.name, r.allowedIps]), [['Web', ['10.10.10.10', '203.0.113.0/24']], ['', ['any']]]);
    assert.deepEqual(await ok(sb.get(D(mg52, 'cellularGateway/portForwardingRules'))), pf);
    await ok(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), pf));
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ ...rules[1], lanIp: '10.0.0.5' }] })), /LAN/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ ...rules[1], publicPort: '70000' }] })), /publicPort/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ ...rules[1], protocol: 'icmp' }] })), /tcp or udp/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ ...rules[0], allowedIps: [] }] })), /allowedIps/);
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ ...rules[0], allowedIps: ['host.example.com'] }] })), /allowedIps/);
    assert.deepEqual((await ok(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [] }))).rules, []);
  });

  test('network uplink limits are a network setting kept on MG networks only', async () => {
    fresh();
    const U = `/networks/${kgn.id}/cellularGateway/uplink`;
    assert.deepEqual(await ok(sb.get(U)), { bandwidthLimits: { limitUp: null, limitDown: null } });
    assert.deepEqual(await ok(sb.put(U, { bandwidthLimits: { limitUp: 51200 } })), { bandwidthLimits: { limitUp: 51200, limitDown: null } });
    assert.deepEqual(await ok(sb.put(U, { bandwidthLimits: { limitDown: 10240, limitUp: null } })), { bandwidthLimits: { limitUp: null, limitDown: 10240 } });
    assert.deepEqual(await ok(sb.get(U)), { bandwidthLimits: { limitUp: null, limitDown: 10240 } });
    assert.match(await errorOf(sb.put(U, { bandwidthLimits: { limitUp: 0 } })), /Kbps/);
    assert.match(await errorOf(sb.get(`/networks/${lab.networks[0].id}/cellularGateway/uplink`)), /cellularGateway/);
    // A network copy takes the setting along.
    const copy = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Kingston copy', productTypes: ['cellularGateway'], copyFromNetworkId: kgn.id }), 201);
    assert.deepEqual(await ok(sb.get(`/networks/${copy.id}/cellularGateway/uplink`)), { bandwidthLimits: { limitUp: null, limitDown: 10240 } });
  });

  test('a swapped MG keeps its settings within what the new model has', async () => {
    fresh();
    await ok(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim2', isPrimary: true }] }));
    await ok(sb.post(D(mg52, 'cellular/uplinks/bands/masks/update'), { slot: 'sim1', type: 'LTE', masked: ['2'] }));
    await ok(sb.put(D(mg52, 'cellularGateway/lan'), { fixedIpAssignments: [{ ip: '192.168.0.40', mac: '00:11:22:33:44:55' }] }));
    const big = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=${mg52.serial}`))).items[0];
    const spare = { serial: 'Q2ZY-TEST-0001', model: 'MG21', mac: '2c:3f:0b:00:00:01', orderNumber: null, claimedAt: now - 400 * DAY, tags: [], name: null };
    lab.spares.push(spare);
    swapDevice(sb.world, mg52, spare, 'remove from network');
    const s = await ok(sb.get('/devices/Q2ZY-TEST-0001/cellular/sims'));
    assert.deepEqual(s.sims.map((x) => [x.slot, x.isPrimary]), [['sim1', true]]);
    assert.equal(s.simFailover.enabled, false);
    const bands = await ok(sb.get(`${C()}/uplinks/bands/byDevice?serials[]=Q2ZY-TEST-0001`));
    assert.deepEqual(bands.items[0].bySlot.map((b) => [b.slot, b.bySignalType.map((t) => [t.type, t.masked])]), [['sim1', [['LTE', ['2']]]]]);
    assert.deepEqual((await ok(sb.get('/devices/Q2ZY-TEST-0001/cellularGateway/lan'))).fixedIpAssignments.length, 1);
    // The MG21's modem moves less data than the MG52's did.
    const small = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=Q2ZY-TEST-0001`))).items[0];
    assert.ok(Number(small.bySlot[0].total) < Number(big.bySlot[1].total) + Number(big.bySlot[0].total));
    const rows = await ok(sb.get(`/organizations/${lab.id}/cellularGateway/uplink/statuses`));
    assert.deepEqual(rows.map((r) => r.model).sort(), ['MG21', 'MG21']);
  });
});
