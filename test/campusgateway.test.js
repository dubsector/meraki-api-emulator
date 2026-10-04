import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { DAY } from '../src/time.js';
import { removeDevice, swapDevice } from '../src/world.js';
import { NOW, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('campus gateways', () => {
  let sb;
  let lab;
  let cal;
  let tor;
  let gws;
  let cluster;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    cal = lab.networks.find((n) => n.name === 'Lab - Calgary');
    tor = lab.networks.find((n) => n.name === 'Lab - Toronto');
    gws = cal.devices.filter((d) => d.productType === 'campusGateway');
    cluster = cal.campusGatewayClusters.list[0];
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
  const O = (p) => `/organizations/${lab.id}/campusGateway/${p}`;
  const N = (p) => `/networks/${cal.id}/campusGateway/${p}`;
  const body = (extra = {}) => ({
    name: 'North Campus',
    uplinks: [{ interface: 'man1', vlan: 5, addresses: [{ assignmentMode: 'dynamic' }] }],
    tunnels: [{ uplink: { interface: 'man1' } }],
    nameservers: { addresses: ['8.8.8.8'] },
    portChannels: [{ name: 'Port-channel1', vlan: 5, allowedVlans: '5,10-20' }],
    ...extra,
  });

  test('Lab - Calgary has two CW9800H1 gateways in one cluster that both SSIDs tunnel through', async () => {
    fresh();
    assert.deepEqual(cal.productTypes, ['wireless', 'campusGateway']);
    assert.deepEqual(gws.map((d) => d.model), ['CW9800H1', 'CW9800H1']);
    const [c] = (await ok(sb.get(O('clusters')))).items;
    assert.equal(c.network.id, cal.id);
    assert.equal(c.name, 'Calgary Campus');
    assert.deepEqual(c.devices.map((d) => [d.serial, d.memberId]), gws.map((d, i) => [d.serial, String(i + 1)]));
    assert.match(c.clusterId, /^[1-9]\d{12}$/);
    const ssids = (await ok(sb.get(O('clusters/ssids')))).items;
    assert.deepEqual(ssids.map((s) => [s.number, s.name, s.cluster.id]), [[0, 'Acme-Corp', c.clusterId], [1, 'Acme-Guest', c.clusterId]]);
    const ssid = await ok(sb.get(`/networks/${cal.id}/wireless/ssids/0`));
    assert.equal(ssid.ipAssignmentMode, 'Campus Gateway');
    assert.deepEqual(ssid.campusGateway, { cluster: { id: c.clusterId } });
    // Acme Corporation has none.
    const corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    assert.deepEqual((await ok(sb.get(`/organizations/${corp.id}/campusGateway/clusters`))).items, []);
    assert.deepEqual((await ok(sb.get(`/organizations/${corp.id}/campusGateway/connections`))).items, []);
  });

  test('connections, overviews and client usage agree with the wireless views', async () => {
    fresh();
    const conns = (await ok(sb.get(O('connections')))).items;
    assert.deepEqual(conns.map((r) => r.serial), cal.aps.map((a) => a.serial).sort());
    for (const r of conns) {
      assert.deepEqual(r.campusGateways.map((g) => g.priority), [0, 1]);
      assert.deepEqual(r.campusGateways.map((g) => g.serial).sort(), gws.map((g) => g.serial).sort());
      const status = (await ok(sb.get(`/organizations/${lab.id}/devices/statuses?serials[]=${r.serial}`)))[0].status;
      assert.equal(r.status, status);
    }
    // APs spread their primary gateway across the members.
    assert.equal(new Set(conns.map((r) => r.campusGateways[0].serial)).size, 2);
    const overview = await ok(sb.get(O('connections/overview')));
    assert.equal(overview.counts.total, 3);
    assert.equal(overview.counts.byTunnelStatus.up, conns.filter((r) => r.tunnelStatus !== 'down').length);
    const byDevice = (await ok(sb.get(`/organizations/${lab.id}/wireless/clients/overview/byDevice?campusGatewayClusterIds[]=${cluster.clusterId}`))).items;
    assert.deepEqual(byDevice.map((r) => r.serial), conns.map((r) => r.serial));
    for (const r of conns) assert.equal(r.counts.clients.total, byDevice.find((d) => d.serial === r.serial).counts.byStatus.online);
    const [ov] = (await ok(sb.get(O('clusters/networks/overviews')))).items;
    assert.deepEqual(ov.counts, { connections: { total: 3 }, clients: { total: conns.reduce((n, r) => n + r.counts.clients.total, 0) }, ssids: { total: 2 } });
    assert.ok(ov.counts.clients.total > 0);
    const q = 'timespan=86400&usageUnits=KB';
    const [u] = (await ok(sb.get(O(`clients/usage/byNetwork/byCluster?${q}`)))).items;
    const bySsid = (await ok(sb.get(`/organizations/${lab.id}/wireless/clients/usage/byNetwork/bySsid?${q}&networkIds[]=${cal.id}`))).items;
    const total = bySsid.reduce((s, r) => s + r.usage.total, 0);
    assert.ok(Math.abs(u.usage.total - total) < 0.1, `${u.usage.total} vs ${total}`);
    assert.equal(u.clients.total, bySsid.reduce((s, r) => s + r.clients.total, 0));
    assert.deepEqual(u.devices, { byProductType: { campusGateway: 2 }, tunneled: { byProductType: { wireless: 3 } } });
    assert.deepEqual(bySsid[0].ssid.tunneledTo, { network: { id: cal.id, name: cal.name }, cluster: { id: cluster.clusterId, name: cluster.name } });
    // Only SSIDs tunneling to clusters in the given networks count.
    assert.equal((await ok(sb.get(`/organizations/${lab.id}/wireless/clients/usage/byNetwork/bySsid?${q}&gatewayNetworkIds[]=${cal.id}`))).items.length, 2);
    assert.deepEqual((await ok(sb.get(`/organizations/${lab.id}/wireless/clients/usage/byNetwork/bySsid?gatewayNetworkIds[]=${tor.id}`))).items, []);
    assert.match(await errorOf(sb.get(O('connections?sortBy=nope'))), /sortBy/);
    assert.equal((await ok(sb.get(O(`connections?search=${cal.aps[0].lanIp}`)))).items.length, 1);
  });

  test('the cluster gives its gateways their uplink address in every device view', async () => {
    fresh();
    const [g] = gws;
    const status = (await ok(sb.get(`/organizations/${lab.id}/devices/statuses?serials[]=${g.serial}`)))[0];
    assert.equal(status.ipType, 'static');
    assert.equal(status.gateway, cluster.uplinks[0].addresses[0].gateway);
    const mgmt = await ok(sb.get(`/devices/${g.serial}/managementInterface`));
    assert.equal(mgmt.wan1.staticIp, status.lanIp);
    assert.deepEqual(await ok(sb.put(`/devices/${g.serial}/managementInterface`, mgmt)), mgmt);
    assert.match(await errorOf(sb.put(`/devices/${g.serial}/managementInterface`, { wan1: { usingStaticIp: false } })), /from its cluster/);
    // A new static address reaches the statuses and the uplink addresses.
    const devices = gws.map((d, i) => ({ serial: d.serial, uplinks: [{ interface: 'man1', addresses: [{ address: `${cal.subnet(1)}.${50 + i}` }] }] }));
    await ok(sb.put(N(`clusters/${cluster.clusterId}`), { devices }));
    const addr = (await ok(sb.get(`/organizations/${lab.id}/devices/uplinks/addresses/byDevice?serials[]=${g.serial}`)))[0].uplinks[0].addresses[0];
    assert.equal(addr.address, `${cal.subnet(1)}.50`);
    assert.equal(addr.assignmentMode, 'static');
    assert.equal((await ok(sb.get(`/devices/${g.serial}`))).lanIp, `${cal.subnet(1)}.50`);
    // Dynamic uplinks hand the gateways back to DHCP.
    await ok(sb.put(N(`clusters/${cluster.clusterId}`), { uplinks: [{ interface: 'man1', addresses: [{ assignmentMode: 'dynamic' }] }] }));
    assert.equal((await ok(sb.get(`/devices/${g.serial}`))).lanIp, g.dhcpLanIp);
    assert.equal((await ok(sb.get(`/devices/${g.serial}/managementInterface`))).wan1.usingStaticIp, false);
    assert.ok(!(await ok(sb.get(`/organizations/${lab.id}/summary/top/devices/byUsage`))).some((d) => d.productType === 'campusGateway'));
  });

  test('cluster writes check every field before changing anything', async () => {
    fresh();
    const c = await ok(sb.post(N('clusters'), body()), 201);
    assert.equal(c.name, 'North Campus');
    assert.deepEqual(c.devices, []);
    assert.match(c.portChannels[0].id, /^\d{13}$/);
    assert.match(await errorOf(sb.post(N('clusters'), body())), /already exists/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', uplinks: [{ interface: 'man2', vlan: 5, addresses: [{ assignmentMode: 'dynamic' }] }] }))), /man1/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', uplinks: [{ interface: 'man1', vlan: 5, addresses: [{ assignmentMode: 'static', gateway: '10.0.0.1', subnetMask: '255.0.255.0' }] }] }))), /subnet mask/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', tunnels: [{ uplink: { interface: 'man3' } }] }))), /uplinks/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', tunnels: [{ interface: 'tun1', vlan: 6 }] }))), /addresses/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', portChannels: [{ name: 'P', vlan: 5, allowedVlans: '10-5' }] }))), /VLAN list/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', devices: [{ serial: gws[0].serial }] }))), /already in cluster 'Calgary Campus'/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', devices: [{ serial: cal.aps[0].serial }] }))), /not a campus gateway/);
    assert.match(await errorOf(sb.post(N('clusters'), body({ name: 'X', notes: 'x'.repeat(512) }))), /511/);
    assert.match(await errorOf(sb.post(`/networks/${tor.id}/campusGateway/clusters`, body())), /campusGateway/);
    assert.equal(tor.campusGatewayClusters, undefined);
    // Moving a gateway: out of the seeded cluster, into the new one with a static uplink.
    const others = { devices: [{ serial: gws[1].serial }] };
    assert.deepEqual((await ok(sb.put(N(`clusters/${cluster.clusterId}`), others))).devices.map((d) => [d.serial, d.memberId]), [[gws[1].serial, '2']]);
    const statics = { uplinks: [{ interface: 'man1', vlan: 5, addresses: [{ assignmentMode: 'static', gateway: '10.5.0.1', subnetMask: '255.255.255.0' }] }] };
    assert.match(await errorOf(sb.put(N(`clusters/${c.clusterId}`), { ...statics, devices: [{ serial: gws[0].serial }] })), /needs an address/);
    assert.match(await errorOf(sb.put(N(`clusters/${c.clusterId}`), { ...statics, devices: [{ serial: gws[0].serial, uplinks: [{ interface: 'man1', addresses: [{ address: '10.6.0.2' }] }] }] })), /not a host address/);
    const moved = await ok(sb.put(N(`clusters/${c.clusterId}`), { ...statics, devices: [{ serial: gws[0].serial, uplinks: [{ interface: 'man1', addresses: [{ address: '10.5.0.2' }] }] }], portChannels: [{ name: 'Port-channel1', allowedVlans: 'all' }] }));
    assert.deepEqual(moved.devices.map((d) => [d.serial, d.memberId]), [[gws[0].serial, '1']]);
    // A port channel named again keeps its ID and the fields left out.
    assert.deepEqual(moved.portChannels, [{ id: c.portChannels[0].id, name: 'Port-channel1', vlan: 5, allowedVlans: 'all' }]);
    assert.equal((await ok(sb.get(`/devices/${gws[0].serial}`))).lanIp, '10.5.0.2');
    // A cluster SSIDs tunnel through can't be deleted.
    assert.match(await errorOf(sb.del(N(`clusters/${cluster.clusterId}`))), /SSID 0 of network 'Lab - Calgary'/);
    assert.equal((await sb.del(N(`clusters/${c.clusterId}`))).status, 204);
    assert.equal((await sb.del(N(`clusters/${c.clusterId}`))).status, 404);
  });

  test('SSIDs tunnel through clusters of one campus gateway network, with mDNS and encryption settings', async () => {
    fresh();
    const S = `/networks/${tor.id}/wireless/ssids/1`;
    assert.match(await errorOf(sb.put(S, { ipAssignmentMode: 'Campus Gateway' })), /cluster\.id/);
    assert.match(await errorOf(sb.put(S, { ipAssignmentMode: 'Campus Gateway', campusGateway: { cluster: { id: '123' } } })), /not in this organization/);
    await ok(sb.put(S, { ipAssignmentMode: 'Campus Gateway', campusGateway: { cluster: { id: cluster.clusterId } } }));
    const rows = (await ok(sb.get(O(`clusters/ssids?networkIds[]=${tor.id}`)))).items;
    assert.deepEqual(rows.map((r) => [r.network.id, r.number]), [[tor.id, 1]]);
    const tunnelable = (await ok(sb.get(O(`clusters/tunnelable?fromNetworkIds[]=${tor.id}`)))).items;
    assert.deepEqual(tunnelable.map((r) => [r.clusterId, r.network.id, r.source.network.id]), [[cluster.clusterId, cal.id, tor.id]]);
    assert.match(await errorOf(sb.get(O('clusters/tunnelable'))), /fromNetworkIds/);
    // The overview lists Toronto too, with its one SSID.
    const ov = (await ok(sb.get(O('clusters/networks/overviews?sortBy=networkId&sortOrder=desc')))).items;
    assert.deepEqual(ov.map((r) => r.networkId), [cal.id, tor.id].sort().reverse());
    // mDNS settings belong to the SSID and its cluster.
    const M = (net, n) => `/networks/${net.id}/campusGateway/ssids/${n}/mdns`;
    assert.deepEqual(await ok(sb.put(M(tor, 1), { enabled: true, rules: [{ services: ['airplay', 'ftp'] }] })), { enabled: true, rules: [{ services: ['airplay', 'ftp'] }] });
    assert.deepEqual(await ok(sb.put(M(tor, 1), { enabled: false })), { enabled: false, rules: [{ services: ['airplay', 'ftp'] }] });
    assert.match(await errorOf(sb.put(M(tor, 0), { enabled: true })), /does not tunnel/);
    assert.match(await errorOf(sb.put(M(tor, 1), { rules: [{ services: ['ftp', 'ftp'] }] })), /repeat/);
    // Data plane encryption per network and cluster.
    const T = O('clusters/tunneling/batchUpdate');
    const enc = { items: [{ cluster: { id: cluster.clusterId }, network: { id: tor.id }, data: { encryption: { enabled: true } } }] };
    assert.deepEqual(await ok(sb.post(T, enc)), enc);
    assert.match(await errorOf(sb.post(T, { items: [{ ...enc.items[0], cluster: { id: '1' } }] })), /not in this organization/);
    const settings = (await ok(sb.get(O('clusters/tunneling/byCluster/byNetwork')))).items;
    assert.deepEqual(settings.map((r) => [r.network.id, r.data.encryption.enabled]).sort(), [[cal.id, false], [tor.id, true]].sort());
    assert.deepEqual((await ok(sb.get(O('clusters/tunneling/byCluster/byNetwork?dataEncryptionEnabled=true')))).items.map((r) => r.network.id), [tor.id]);
    const conns = (await ok(sb.get(O(`connections?networkIds[]=${tor.id}`)))).items;
    assert.equal(conns.length, tor.aps.length);
    for (const r of conns) for (const g of r.campusGateways) assert.equal(g.data.encryption.status, g.tunnel.status);
    assert.equal((await ok(sb.get(O(`connections?networkIds[]=${tor.id}&dataEncryptionStatuses[]=up`)))).items.length, conns.filter((r) => r.tunnelStatus !== 'down').length);
    // Toronto names Calgary's cluster, so neither can leave the organization alone.
    const dest = await ok(sb.post('/organizations', { name: 'Lab West' }), 201);
    Object.assign(sb.world.orgById.get(dest.id), { licensing: lab.licensing });
    const move = await ok(sb.post(`/organizations/${lab.id}/networks/moves`, { network: { id: tor.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.match(move.result.reason, /campus gateway/);
  });

  test('provisioning updates the cluster and sets its failover target', async () => {
    fresh();
    const c = await ok(sb.post(N('clusters'), body({ devices: [] })), 201);
    const P = O('clusters/provision');
    const full = { clusterId: cluster.clusterId, network: { id: cal.id }, ...body({ name: 'Calgary Campus' }), devices: gws.map((g) => ({ serial: g.serial })), failover: { targets: [{ clusterId: c.clusterId, priority: 1 }] } };
    const r = await ok(sb.post(P, full), 202);
    assert.deepEqual(r.failover, { targets: [{ clusterId: c.clusterId, name: 'North Campus', priority: 1, allowedVlans: '5,10-20' }] });
    assert.equal(r.uplinks[0].vlan, 5);
    assert.match(await errorOf(sb.post(P, { ...full, clusterId: '999' }), 404), /Cluster/);
    assert.match(await errorOf(sb.post(P, { ...full, failover: { targets: [{ clusterId: cluster.clusterId }] } })), /own failover target/);
    assert.match(await errorOf(sb.post(P, { ...full, network: { id: tor.id } })), /campusGateway/);
    const targets = await ok(sb.get(O('clusters/failover/targets')));
    assert.deepEqual(targets.find((t) => t.clusterId === cluster.clusterId).failover.targets.map((t) => t.clusterId), [c.clusterId]);
    const byCluster = (await ok(sb.get(O(`clusters/failover/targets/byCluster?clusterIds[]=${cluster.clusterId}`)))).items;
    assert.deepEqual(byCluster[0].available.map((a) => a.clusterId), [c.clusterId]);
    assert.equal(byCluster[0].model, 'CW9800H1');
    // A deleted target drops out.
    assert.equal((await sb.del(N(`clusters/${c.clusterId}`))).status, 204);
    assert.deepEqual((await ok(sb.get(O('clusters/failover/targets'))))[0].failover.targets, []);
  });

  test('swaps keep a gateway in its cluster and removals drop it', async () => {
    fresh();
    const [a, b] = gws;
    lab.spares.push({ serial: 'Q5CG-TEST-0001', model: 'CW9800H1', productType: 'campusGateway', mac: 'cc:9c:3e:00:00:01', orderNumber: null, claimedAt: now - DAY, tags: [], name: null });
    swapDevice(sb.world, a, lab.spares.at(-1), 'remove from network');
    assert.deepEqual((await ok(sb.get(O('clusters')))).items[0].devices.map((d) => d.serial), ['Q5CG-TEST-0001', b.serial]);
    removeDevice(sb.world, b);
    const [c] = (await ok(sb.get(O('clusters')))).items;
    assert.deepEqual(c.devices.map((d) => d.serial), ['Q5CG-TEST-0001']);
    assert.ok((await ok(sb.get(O('connections')))).items.every((r) => r.campusGateways.length === 1));
    assert.deepEqual((await ok(sb.get(O('devices/uplinks/localOverrides/byDevice')))).items, []);
  });
});
