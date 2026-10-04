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
    // The MG52's eSIM sits in raw slot sim2, which the data views call esim.
    assert.deepEqual(row.modems[0].sims, [{ slot: 'sim1', type: 'sim', active: true }, { slot: 'esim', type: 'esim', active: true }]);
    assert.deepEqual(row.profile, { assigned: false, id: null, name: null });
    assert.deepEqual(row.network, { name: 'Lab - Kingston', id: kgn.id });
    assert.deepEqual((await ok(sb.get(`${C()}/data/devices?slots[]=esim`))).items.map((x) => x.serial), [mg52.serial]);
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
      ['esim', iso(month), '2026-09-30T23:59:59Z', null],
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
  test('the subnet pool hands each MG its LAN and refuses pools that leave one out', async () => {
    fresh();
    const P = `/networks/${kgn.id}/cellularGateway/subnetPool`;
    const pool = await ok(sb.get(P));
    assert.deepEqual(pool, {
      deploymentMode: 'routed',
      cidr: '192.168.0.0/24',
      mask: 27,
      subnets: [
        { serial: mg52.serial, name: 'MG-KGN-01', applianceIp: '192.168.0.33', subnet: '192.168.0.32/27' },
        { serial: mg21.serial, name: 'MG-KGN-02', applianceIp: '192.168.0.65', subnet: '192.168.0.64/27' },
      ],
    });
    // The LAN view answers on the address the pool gives.
    for (const [d, x] of [[mg52, pool.subnets[0]], [mg21, pool.subnets[1]]]) {
      const lan = await ok(sb.get(D(d, 'cellularGateway/lan')));
      assert.deepEqual([lan.deviceLanIp, lan.deviceSubnet], [x.applianceIp, x.subnet]);
    }
    const moved = await ok(sb.put(P, { cidr: '10.20.0.0/16', mask: 24 }));
    assert.deepEqual(moved.subnets.map((x) => [x.applianceIp, x.subnet]), [['10.20.1.1', '10.20.1.0/24'], ['10.20.2.1', '10.20.2.0/24']]);
    assert.equal((await ok(sb.get(D(mg21, 'cellularGateway/lan')))).deviceSubnet, '10.20.2.0/24');
    assert.match(await errorOf(sb.put(D(mg52, 'cellularGateway/lan'), { fixedIpAssignments: [{ ip: '192.168.0.40', mac: '00:11:22:33:44:55' }] })), /10\.20\.1\.0\/24/);
    await ok(sb.put(D(mg52, 'cellularGateway/portForwardingRules'), { rules: [{ lanIp: '10.20.1.200', publicPort: '80', localPort: '8080', protocol: 'tcp', access: 'any' }] }));
    assert.match(await errorOf(sb.put(P, { cidr: '192.168.0.0/24', mask: 27 })), /MG-KGN-01.*10\.20\.1\.200/);
    assert.match(await errorOf(sb.put(P, { mask: 16 })), /from 17 to 30/);
    assert.match(await errorOf(sb.put(P, { cidr: '10.20.0.0/26', mask: 27 })), /holds 1 \/27 subnets.*2 MGs/);
    assert.match(await errorOf(sb.put(P, { cidr: '10.20.0.1/16' })), /host bits/);
    assert.match(await errorOf(sb.put(P, { cidr: 'nope' })), /IPv4 subnet/);
    assert.match(await errorOf(sb.get(`/networks/${lab.networks[0].id}/cellularGateway/subnetPool`)), /cellularGateway/);
    assert.deepEqual(await ok(sb.get(P)), moved);
  });

  test('DHCP and connectivity monitoring destinations are network settings', async () => {
    fresh();
    const H = `/networks/${kgn.id}/cellularGateway/dhcp`;
    assert.deepEqual(await ok(sb.get(H)), { dhcpLeaseTime: '1 day', dnsNameservers: 'upstream_dns', dnsCustomNameservers: [] });
    const custom = { dhcpLeaseTime: '4 hours', dnsNameservers: 'custom', dnsCustomNameservers: ['172.16.2.111', '172.16.2.30'] };
    assert.deepEqual(await ok(sb.put(H, custom)), custom);
    assert.deepEqual(await ok(sb.put(H, { dhcpLeaseTime: '1 week' })), { ...custom, dhcpLeaseTime: '1 week' });
    assert.deepEqual(await ok(sb.put(H, { dnsNameservers: 'google_dns' })), { dhcpLeaseTime: '1 week', dnsNameservers: 'google_dns', dnsCustomNameservers: [] });
    assert.match(await errorOf(sb.put(H, { dnsNameservers: 'custom' })), /at least one/);
    assert.match(await errorOf(sb.put(H, { dnsCustomNameservers: ['1.1.1.1'] })), /only applies/);
    assert.match(await errorOf(sb.put(H, { dhcpLeaseTime: '2 hours' })), /dhcpLeaseTime/);
    assert.match(await errorOf(sb.put(H, { dnsNameservers: 'custom', dnsCustomNameservers: ['x'] })), /IPv4/);

    const M = `/networks/${kgn.id}/cellularGateway/connectivityMonitoringDestinations`;
    assert.deepEqual(await ok(sb.get(M)), { destinations: [{ ip: '8.8.8.8', description: 'Google', default: true }] });
    const set = await ok(sb.put(M, { destinations: [{ ip: '1.2.3.4', default: true }, { ip: '9.9.9.9', description: 'Quad9' }] }));
    assert.deepEqual(set, { destinations: [{ ip: '1.2.3.4', description: '', default: true }, { ip: '9.9.9.9', description: 'Quad9', default: false }] });
    assert.deepEqual(await ok(sb.get(M)), set);
    assert.match(await errorOf(sb.put(M, { destinations: [{ ip: '1.2.3.4', default: true }, { ip: '9.9.9.9', default: true }] })), /Only one/);
    assert.match(await errorOf(sb.put(M, { destinations: [{ ip: '1.2.3.4' }, { ip: '1.2.3.4' }] })), /more than once/);
    assert.match(await errorOf(sb.put(M, { destinations: [{ ip: 'nope' }] })), /IPv4/);
    // MX networks keep their own list.
    const hq = sb.world.orgs.find((o) => o.name === 'Acme Corporation').networks[0];
    assert.deepEqual((await ok(sb.get(`/networks/${hq.id}/appliance/connectivityMonitoringDestinations`))).destinations.map((d) => d.ip), ['8.8.8.8']);
    const copy = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'Kingston copy', productTypes: ['cellularGateway'], copyFromNetworkId: kgn.id }), 201);
    assert.deepEqual(await ok(sb.get(`/networks/${copy.id}/cellularGateway/connectivityMonitoringDestinations`)), set);
    assert.equal((await ok(sb.get(`/networks/${copy.id}/cellularGateway/dhcp`))).dnsNameservers, 'google_dns');
  });

  test('eSIM accounts keep their API key, plans come from the provider and swaps change the SIM', async () => {
    fresh();
    const E = `/organizations/${lab.id}/cellularGateway/esims`;
    const inv = await ok(sb.get(`${E}/inventory`));
    assert.equal(inv.items.length, 1);
    assert.deepEqual(inv.meta, { counts: { items: { total: 1, remaining: 0 } } });
    const row = inv.items[0];
    const eid = row.eid;
    assert.match(eid, /^\d{32}$/);
    assert.deepEqual(row.device, { name: 'MG-KGN-01', model: 'mg52', serial: mg52.serial, url: row.device.url, status: 'online' });
    assert.deepEqual([row.active, row.network], [false, { id: kgn.id }]);
    // The shipped profile is the SIM the SIMs view shows in sim2.
    const sims = await ok(sb.get(D(mg52, 'cellular/sims')));
    const sim2 = sims.sims.find((x) => x.slot === 'sim2');
    assert.equal(row.profiles.length, 1);
    assert.equal(row.profiles[0].iccid, sim2.iccid);
    assert.equal(row.profiles[0].status, 'activated');
    assert.deepEqual(row.profiles[0].serviceProvider.plans.map((p) => p.type), ['communication', 'rate']);
    assert.deepEqual((await ok(sb.get(`${E}/inventory?eids[]=nope`))).items, []);
    assert.deepEqual((await ok(sb.get(`/organizations/${sb.world.orgs.find((o) => o.name === 'Acme Corporation').id}/cellularGateway/esims/inventory`))).items, []);

    const providers = (await ok(sb.get(`${E}/serviceProviders`))).items;
    assert.ok(providers.some((p) => p.name === 'AT&T' && !p.isBootstrap && p.terms.name === 'AT&T Terms and Conditions'));
    assert.equal(providers.filter((p) => p.isBootstrap).length, 1);

    const A = `${E}/serviceProviders/accounts`;
    assert.deepEqual(await ok(sb.get(A)), [{ items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } }]);
    const body = { accountId: '0987654321', apiKey: 'secret', serviceProvider: { name: 'AT&T' }, title: 'My AT&T account', username: 'MerakiUser' };
    const made = await ok(sb.post(A, body));
    assert.deepEqual(made, { accountId: '0987654321', lastUpdatedAt: NOW, serviceProvider: { name: 'AT&T', logo: made.serviceProvider.logo }, title: 'My AT&T account', username: 'MerakiUser' });
    assert.equal(JSON.stringify(await ok(sb.get(A))).includes('secret'), false);
    assert.match(await errorOf(sb.post(A, body)), /already/);
    assert.match(await errorOf(sb.post(A, { ...body, accountId: '1', serviceProvider: { name: 'ATT' } })), /AT&T, Verizon/);
    assert.match(await errorOf(sb.post(A, { ...body, accountId: '1', serviceProvider: { name: 'Cisco IoT Bootstrap' } })), /must be one of/);
    assert.match(await errorOf(sb.post(A, { ...body, accountId: '1', title: ' ' })), /title/);
    // The filter is typed as integers, so the leading zero doesn't matter.
    assert.equal((await ok(sb.get(`${A}?accountIds[]=987654321`)))[0].items.length, 1);
    assert.equal((await ok(sb.get(`${A}?accountIds[]=5`)))[0].items.length, 0);
    const renamed = await ok(sb.put(`${A}/0987654321`, { title: 'Lab AT&T', apiKey: 'other' }));
    assert.equal(renamed.title, 'Lab AT&T');
    assert.equal(sb.world.orgs.find((o) => o.name === 'Acme Test Lab').esimAccounts.list[0].apiKey, 'other');
    assert.match(await errorOf(sb.put(`${A}/0987654321`, { apiKey: '' })), /apiKey/);
    await errorOf(sb.put(`${A}/nope`, { title: 'x' }), 404);

    const comm = await ok(sb.get(`${A}/communicationPlans?accountIds[]=0987654321`));
    assert.deepEqual(comm.items.map((p) => [p.accountId, p.name, p.apns.map((a) => a.name)]), [['0987654321', 'AT&T IoT Pooled Data', ['broadband']], ['0987654321', 'AT&T IoT Private APN', ['meraki.att.iot']]]);
    const rates = await ok(sb.get(`${A}/ratePlans?accountIds[]=0987654321`));
    assert.deepEqual(rates.items.map((p) => p.name), ['AT&T IoT 1 GB Shared', 'AT&T IoT 10 GB Shared', 'AT&T IoT Unlimited']);
    assert.deepEqual(rates.meta.counts.items, { total: 3, remaining: 0 });
    assert.match(await errorOf(sb.get(`${A}/ratePlans?accountIds[]=nope`)), /nope/);
    assert.match(await errorOf(sb.get(`${A}/ratePlans`)), /required/);

    // A swap under the frozen clock finishes at once and moves sim2 to AT&T.
    const S = `${E}/swap`;
    await errorOf(sb.put(`${S}/${eid}`), 404);
    const target = { accountId: '0987654321', communicationPlan: 'AT&T IoT Private APN', ratePlan: 'AT&T IoT Unlimited' };
    const swap = await ok(sb.post(S, { swaps: [{ eid, target }] }));
    assert.deepEqual([swap.eid, swap.status], [eid, 'Completed']);
    assert.deepEqual(await ok(sb.put(`${S}/${eid}`)), swap);
    const after = (await ok(sb.get(`${E}/inventory`))).items[0];
    assert.deepEqual(after.profiles.map((p) => [p.serviceProvider.name, p.status]), [['Telus', 'disabled'], ['AT&T', 'activated']]);
    assert.deepEqual(after.profiles[1].customApns, ['meraki.att.iot']);
    assert.equal(after.profiles[1].iccid, swap.iccid);
    assert.equal(after.lastUpdatedAt, NOW);
    const sim = (await ok(sb.get(D(mg52, 'cellular/sims')))).sims.find((x) => x.slot === 'sim2');
    assert.equal(sim.iccid, swap.iccid);
    assert.match(sim.imsi, /^310410/);
    // Swapping again on the same account keeps the profile and changes the plans.
    const again = await ok(sb.post(S, { swaps: [{ eid, target: { ...target, ratePlan: 'AT&T IoT 1 GB Shared' } }] }));
    assert.equal(again.iccid, swap.iccid);
    assert.equal((await ok(sb.get(`${E}/inventory`))).items[0].profiles.length, 2);
    assert.match(await errorOf(sb.post(S, { swaps: [{ eid, target: { ...target, ratePlan: 'x' } }] })), /ratePlan/);
    assert.match(await errorOf(sb.post(S, { swaps: [{ eid, target: { ...target, accountId: '5' } }] })), /accountId/);
    assert.match(await errorOf(sb.post(S, { swaps: [{ eid: '1', target }] })), /not an eSIM/);
    assert.match(await errorOf(sb.post(S, { swaps: [{ eid, target }, { eid, target }] })), /twice/);
    assert.match(await errorOf(sb.post(S, { swaps: [{ eid }] })), /target/);
    await errorOf(sb.put(`${S}/1`), 404);
    // Deleting the account leaves the profile in place.
    assert.equal((await sb.del(`${A}/0987654321`)).status, 204);
    await errorOf(sb.del(`${A}/0987654321`), 404);
    assert.equal((await ok(sb.get(`${E}/inventory`))).items[0].profiles[1].serviceProvider.name, 'AT&T');
  });

  test('a deactivated eSIM shows in the SIMs and data views and cannot be primary', async () => {
    fresh();
    const E = `/organizations/${lab.id}/cellularGateway/esims`;
    const { eid } = (await ok(sb.get(`${E}/inventory`))).items[0];
    const off = await ok(sb.put(`${E}/inventory/${eid}`, { status: 'deactivated' }));
    assert.deepEqual([off.active, off.profiles[0].status], [false, 'deactivated']);
    const sims = await ok(sb.get(D(mg52, 'cellular/sims')));
    assert.deepEqual(sims.sims.map((x) => [x.slot, x.status]), [['sim1', 'active'], ['sim2', 'not inserted']]);
    const row = (await ok(sb.get(`${C()}/data/devices?serials[]=${mg52.serial}`))).items[0];
    assert.deepEqual(row.modems[0].sims.map((x) => x.active), [true, false]);
    const usage = (await ok(sb.get(`${C()}/data/usage/byDevice?serials[]=${mg52.serial}`))).items[0];
    assert.deepEqual(usage.bySlot.map((x) => [x.slot, x.isActive]), [['sim1', true], ['esim', false]]);
    assert.match(await errorOf(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim2', isPrimary: true }] })), /deactivated/);
    await ok(sb.put(`${E}/inventory/${eid}`, { status: 'activated' }));
    await ok(sb.put(D(mg52, 'cellular/sims'), { sims: [{ slot: 'sim2', isPrimary: true }] }));
    assert.equal((await ok(sb.get(`${E}/inventory`))).items[0].active, true);
    assert.match(await errorOf(sb.put(`${E}/inventory/${eid}`, { status: 'deactivated' })), /primary SIM/);
    assert.match(await errorOf(sb.put(`${E}/inventory/${eid}`, { status: 'off' })), /activated, deactivated/);
    await errorOf(sb.put(`${E}/inventory/1`, { status: 'activated' }), 404);
    // A replacement MG52 comes with its own shipped eSIM.
    await ok(sb.put(`${E}/inventory/${eid}`, { status: 'activated' }));
    const spare = { serial: 'Q2ZY-TEST-0002', model: 'MG52', mac: '2c:3f:0b:00:00:02', orderNumber: null, claimedAt: now - 400 * DAY, tags: [], name: null };
    lab.spares.push(spare);
    mg52.esim.status = 'deactivated';
    swapDevice(sb.world, mg52, spare, 'remove from network');
    const fresh52 = (await ok(sb.get(`${E}/inventory`))).items[0];
    assert.notEqual(fresh52.eid, eid);
    assert.equal(fresh52.profiles[0].status, 'activated');
  });
});

describe('eSIM swaps on a running clock', () => {
  test('a swap is in progress until it finishes, and the SIM keeps its profile meanwhile', async () => {
    const sb = await start({ now: null });
    try {
      const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
      const mg52 = lab.devices.find((d) => d.model === 'MG52');
      const E = `/organizations/${lab.id}/cellularGateway/esims`;
      const { eid } = (await sb.get(`${E}/inventory`)).body.items[0];
      const before = (await sb.get(`/devices/${mg52.serial}/cellular/sims`)).body.sims[1].iccid;
      await sb.post(`${E}/serviceProviders/accounts`, { accountId: '42', apiKey: 'k', serviceProvider: { name: 'Verizon' }, title: 'VZ', username: 'u' });
      const target = { accountId: '42', communicationPlan: 'Verizon IoT Pooled Data', ratePlan: 'Verizon IoT Unlimited' };
      const swap = await sb.post(`${E}/swap`, { swaps: [{ eid, target }] });
      assert.equal(swap.status, 200, JSON.stringify(swap.body));
      assert.equal(swap.body.status, 'In progress');
      assert.equal((await sb.put(`${E}/swap/${eid}`)).body.status, 'In progress');
      assert.equal((await sb.get(`/devices/${mg52.serial}/cellular/sims`)).body.sims[1].iccid, before);
      assert.match((await sb.post(`${E}/swap`, { swaps: [{ eid, target }] })).body.errors[0], /in progress/);
    } finally {
      sb.close();
    }
  });
});
