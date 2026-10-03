import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ROUTES } from '../src/server.js';
import { NOW, start } from './helpers.js';

describe('network groups, moves and combining', () => {
  let sb;
  let corp;
  let lab;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    [corp, lab] = sb.world.orgs;
    O = `/organizations/${corp.id}/networks`;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const created = async (r, status = 201) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  // Every network and device read answers without a 5xx for the networks given.
  const noErrors = async (nets) => {
    const now = Date.parse(NOW) / 1000;
    for (const net of nets) {
      for (const r of ROUTES.filter((x) => x.method === 'GET' && /^\/(networks\/\{networkId\}|devices\/\{serial\})[^{]*$/.test(x.path))) {
        const q = typeof r.sample?.query === 'function' ? r.sample.query(sb.world, now) : r.sample?.query;
        for (const d of r.path.includes('{serial}') ? net.devices : [null]) {
          const url = r.path.replace('{networkId}', net.id).replace('{serial}', d?.serial) + (q ? `?${q}` : '');
          const res = await sb.get(url);
          assert.ok(res.status < 500, `${url}: ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
    }
  };

  test('groups are created, renamed, filled and deleted', async () => {
    fresh();
    assert.deepEqual((await sb.get(`${O}/groups`)).body, { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    const west = await created(sb.post(`${O}/groups`, { name: 'West' }));
    assert.deepEqual(Object.keys(west), ['groupId', 'organizationId', 'name']);
    assert.match(west.groupId, /^\d{13}$/);
    assert.match(await errorOf(sb.post(`${O}/groups`, { name: 'West' })), /taken/);
    const east = await created(sb.post(`${O}/groups`, { name: 'East' }));
    assert.deepEqual((await created(sb.put(`${O}/groups/${east.groupId}`, { name: 'East and EU' }), 200)).name, 'East and EU');
    const page = await sb.get(`${O}/groups?perPage=3&groupIds[]=${east.groupId}`);
    assert.deepEqual(page.body.items.map((g) => g.name), ['East and EU']);

    const [hq, austin, ...rest] = corp.networks;
    assert.deepEqual((await created(sb.post(`${O}/groups/${west.groupId}/bulkAssign`, { networkIds: [hq.id, austin.id, austin.id] }), 200)).networkIds, [hq.id, austin.id]);
    // A network is in one group at a time.
    await created(sb.post(`${O}/groups/${east.groupId}/bulkAssign`, { networkIds: [austin.id, ...rest.map((n) => n.id)] }), 200);
    let overview = (await sb.get(`${O}/groups/overview/byGroup`)).body;
    const counts = (g) => g.statuses.byProductType.reduce((sum, p) => sum + Object.values(p.counts).reduce((a, b) => a + b, 0), 0);
    const byName = Object.fromEntries(overview.items.map((g) => [g.name, g]));
    assert.equal(counts(byName.West), hq.devices.length);
    assert.equal(counts(byName['East and EU']), corp.devices.length - hq.devices.length);
    assert.deepEqual(byName.West.productTypes, hq.productTypes);
    assert.ok(byName.West.clients.counts.total > 0 && byName.West.clients.usage.downstream > 0);
    assert.equal(overview.meta.counts.items.total, 2);
    assert.match(await errorOf(sb.post(`${O}/groups/${west.groupId}/bulkAssign`, { networkIds: [lab.networks[0].id] })), /not in this organization/);
    assert.match(await errorOf(sb.get(`${O}/groups/overview/byGroup?sortBy=name`)), /sortBy/);

    assert.equal((await sb.post(`${O}/groups/${west.groupId}/bulkUnassign`, { networkIds: [hq.id] })).status, 204);
    overview = (await sb.get(`${O}/groups/overview/byGroup`)).body;
    const west2 = overview.items.find((g) => g.name === 'West');
    assert.deepEqual([counts(west2), west2.productTypes, west2.statuses.overall], [0, [], 'online']);
    assert.equal((await sb.del(`${O}/groups/${west.groupId}`)).status, 204);
    await errorOf(sb.del(`${O}/groups/${west.groupId}`), 404);
    await errorOf(sb.put(`${O}/groups/${west.groupId}`, { name: 'x' }), 404);
  });

  test('a network moves to another organization with its devices and clients', async () => {
    fresh();
    const dest = (await sb.post('/organizations', { name: 'Acme West' })).body;
    const austin = corp.networks.find((n) => n.vpn === 'spoke');
    const devices = austin.devices.length;
    const group = await created(sb.post(`${O}/groups`, { name: 'Spokes' }));
    await sb.post(`${O}/groups/${group.groupId}/bulkAssign`, { networkIds: [austin.id] });

    // A simulated move checks the move and leaves the network where it was.
    const sim = await created(sb.post(`${O}/moves`, { network: { id: austin.id }, organizations: { target: { id: dest.id } }, simulate: true }));
    assert.equal(sim.result.status, 'completed');
    assert.equal((await sb.get(`/networks/${austin.id}`)).body.organizationId, corp.id);

    const move = await created(sb.post(`${O}/moves`, { network: { id: austin.id }, organizations: { target: { id: dest.id } } }));
    assert.deepEqual(move, {
      moveId: move.moveId,
      initiator: { admin: { id: sb.world.apiAdmin.id } },
      organizations: { source: { id: corp.id }, target: { id: dest.id } },
      network: { id: austin.id },
      createdAt: NOW.replace('Z', '.000Z'),
      lastUpdatedAt: NOW.replace('Z', '.000Z'),
      result: { status: 'completed', reason: null },
    });
    assert.equal((await sb.get(`/networks/${austin.id}`)).body.organizationId, dest.id);
    assert.equal((await sb.get(`/organizations/${dest.id}/devices`)).body.length, devices);
    assert.ok((await sb.get(`/networks/${austin.id}/clients`)).body.length > 0);
    assert.ok(!(await sb.get(`/organizations/${corp.id}/devices`)).body.some((d) => d.networkId === austin.id));
    // It leaves AutoVPN and its old organization's groups.
    assert.equal((await sb.get(`/networks/${austin.id}/appliance/vpn/siteToSiteVpn`)).body.mode, 'none');
    assert.ok(!(await sb.get(`/organizations/${corp.id}/appliance/vpn/statuses`)).body.some((r) => r.networkId === austin.id));
    assert.equal((await sb.get(`${O}/groups/overview/byGroup`)).body.items[0].productTypes.length, 0);

    // Both organizations list the move; the simulated one isn't kept.
    for (const org of [corp, dest]) assert.deepEqual((await sb.get(`/organizations/${org.id}/networks/moves`)).body.items.map((m) => m.moveId), [move.moveId]);
    assert.equal((await sb.get(`${O}/moves?moveIds[]=1`)).body.items.length, 0);
    await errorOf(sb.get(`${O}/moves?perPage=5`));
    await noErrors([austin]);
  });

  test('moves that cannot happen are kept as failed', async () => {
    fresh();
    const hq = corp.networks[0];
    const bad = await created(sb.post(`${O}/moves`, { network: { id: hq.id }, organizations: { target: { id: '1' } } }));
    assert.deepEqual(bad.result, { status: 'failed', reason: 'Cannot move network: Target organization is invalid or inaccessible.' });
    const lic = await created(sb.post(`${O}/moves`, { network: { id: hq.id }, organizations: { target: { id: lab.id } } }));
    assert.match(lic.result.reason, /licensing/);
    assert.equal((await sb.get(`${O}/moves`)).body.items.length, 2);
    assert.match(await errorOf(sb.post(`${O}/moves`, { network: { id: lab.networks[0].id }, organizations: { target: { id: lab.id } } })), /not in this organization/);
    assert.match(await errorOf(sb.post(`${O}/moves`, { network: {}, organizations: { target: { id: lab.id } } })), /network\.id/);
  });

  test('moving the hub takes the spokes out of AutoVPN', async () => {
    fresh();
    const dest = (await sb.post('/organizations', { name: 'Acme HQ' })).body;
    const hub = corp.hub;
    const spoke = corp.networks.find((n) => n.vpn === 'spoke');
    await created(sb.post(`${O}/moves`, { network: { id: hub.id }, organizations: { target: { id: dest.id } } }));
    assert.deepEqual((await sb.get(`/networks/${spoke.id}/appliance/vpn/siteToSiteVpn`)).body.hubs, []);
    assert.deepEqual((await sb.get(`/organizations/${corp.id}/appliance/vpn/statuses`)).body, []);
    await noErrors([hub, spoke]);
  });

  test('networks with different product types combine into one', async () => {
    fresh();
    const toronto = lab.networks[0];
    const L = `/organizations/${lab.id}/networks`;
    const mx = (await sb.post(L, { name: 'Toronto MX', productTypes: ['appliance'] })).body;
    const clients = toronto.clients.length;
    assert.match(await errorOf(sb.post(`${L}/combine`, { name: 'Toronto', networkIds: [toronto.id] })), /at least two/);
    const wifi = (await sb.post(L, { name: 'Toronto Guest', productTypes: ['wireless'] })).body;
    assert.match(await errorOf(sb.post(`${L}/combine`, { name: 'Toronto', networkIds: [toronto.id, wifi.id] })), /both have wireless/);
    assert.match(await errorOf(sb.post(`${L}/combine`, { name: 'Toronto Guest', networkIds: [toronto.id, mx.id] })), /taken/);

    const r = await created(sb.post(`${L}/combine`, { name: 'Toronto', networkIds: [toronto.id, mx.id], enrollmentString: 'toronto' }), 200);
    const net = r.resultingNetwork;
    assert.match(net.id, /^L_\d{18}$/);
    assert.deepEqual([net.name, net.productTypes, net.timeZone, net.enrollmentString], ['Toronto', ['wireless', 'appliance'], toronto.timeZone, 'toronto']);
    for (const id of [toronto.id, mx.id]) await errorOf(sb.get(`/networks/${id}`), 404);
    assert.equal((await sb.get(`/networks/${net.id}/devices`)).body.length, toronto.devices.length);
    assert.equal((await sb.get(`/networks/${net.id}/clients?timespan=2592000&perPage=1000`)).body.length, clients);
    assert.equal((await sb.get(`/networks/${net.id}/wireless/ssids/0`)).body.name, toronto.config.ssids[0].name);
    assert.equal((await sb.get(`/organizations/${lab.id}/licenses`)).body.filter((l) => l.networkId === net.id).length, lab.devices.filter((d) => d.net.id === net.id).length);

    // Naming the combined network adds the others to it and keeps its ID.
    const cam = (await sb.post(L, { name: 'Toronto Cameras', productTypes: ['camera'] })).body;
    const again = await created(sb.post(`${L}/combine`, { name: 'Toronto Site', networkIds: [cam.id, net.id] }), 200);
    assert.deepEqual([again.resultingNetwork.id, again.resultingNetwork.productTypes], [net.id, ['wireless', 'appliance', 'camera']]);
    await noErrors([sb.world.networkById.get(net.id)]);
  });

  test('a combined network splits into one network per product type', async () => {
    fresh();
    const hq = corp.networks[0];
    const austin = corp.networks[1];
    const types = [...hq.productTypes];
    const devices = Object.fromEntries(types.map((p) => [p, hq.devices.filter((d) => d.productType === p).map((d) => d.serial).sort()]));
    const wireless = hq.clients.filter((c) => !c.wired).length;
    const ssid = (await sb.get(`/networks/${hq.id}/wireless/ssids/0`)).body;
    assert.match(await errorOf(sb.post(`/networks/${lab.networks[0].id}/split`)), /combined network/);

    const r = await created(sb.post(`/networks/${hq.id}/split`), 200);
    const parts = r.resultingNetworks;
    assert.deepEqual(parts.map((n) => [n.name, n.productTypes]), types.map((p) => [`${hq.name} - ${p}`, [p]]));
    assert.ok(parts.every((n) => /^N_\d{18}$/.test(n.id) && n.timeZone === hq.timeZone && n.organizationId === corp.id && !n.isBoundToConfigTemplate));
    await errorOf(sb.get(`/networks/${hq.id}`), 404);
    for (const [i, p] of types.entries()) {
      const list = (await sb.get(`/networks/${parts[i].id}/devices`)).body;
      assert.deepEqual(list.map((d) => d.serial).sort(), devices[p]);
    }
    const wl = parts[types.indexOf('wireless')];
    assert.equal((await sb.get(`/networks/${wl.id}/clients?timespan=2592000&perPage=1000`)).body.length, wireless);
    assert.deepEqual((await sb.get(`/networks/${wl.id}/wireless/ssids/0`)).body, ssid);

    // HQ was the VPN hub; its spokes now point at the appliance network.
    const mx = parts[types.indexOf('appliance')];
    const vpn = (await sb.get(`/networks/${austin.id}/appliance/vpn/siteToSiteVpn`)).body;
    assert.deepEqual(vpn.hubs.map((h) => h.hubId), [mx.id]);
    await noErrors(parts.map((n) => sb.world.networkById.get(n.id)));

    // Each part keeps only its own product's syslog roles, so its servers can be sent back.
    for (const part of parts) {
      const path = `/networks/${part.id}/syslogServers`;
      const servers = (await sb.get(path)).body;
      const put = await sb.put(path, servers);
      assert.equal(put.status, 200, `${part.name}: ${JSON.stringify(put.body)}`);
    }
    const [row] = (await sb.get(`/organizations/${corp.id}/devices/syslog/servers/byNetwork?networkIds[]=${wl.id}`)).body.items;
    const roles = row.servers.flatMap((s) => s.roles);
    assert.ok(roles.length && roles.every((r) => r.startsWith('wireless')), roles.join(', '));

    // The parts combine back into one network.
    const again = await created(sb.post(`${O}/combine`, { name: hq.name, networkIds: parts.map((n) => n.id) }), 200);
    assert.deepEqual(again.resultingNetwork.productTypes, types);
    assert.equal((await sb.get(`/networks/${again.resultingNetwork.id}/devices`)).body.length, hq.devices.length);
  });

  test('settings kept outside the config, and peers naming the network, follow split and combine', async () => {
    fresh();
    const hq = corp.networks[0];
    const core = hq.switches[0];
    const mx = sb.world.unclaimed.devices.find((d) => d.model === 'MX250');
    await created(sb.post(`/organizations/${corp.id}/inventory/claim`, { orders: [mx.orderNumber] }), 200);
    await created(sb.post(`/networks/${hq.id}/devices/claim`, { serials: [mx.serial] }), 200);
    await created(sb.post(`/devices/${core.serial}/switch/routing/interfaces`, { name: 'Users', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' }));
    const reads = {
      appliance: ['appliance/warmSpare', await created(sb.put(`/networks/${hq.id}/appliance/warmSpare`, { enabled: true, spareSerial: mx.serial }), 200)],
      switch: ['switch/routing/multicast/rendezvousPoints', [await created(sb.post(`/networks/${hq.id}/switch/routing/multicast/rendezvousPoints`, { interfaceIp: '192.0.2.2', multicastGroup: 'Any' }))]],
      camera: ['mqttBrokers', [await created(sb.post(`/networks/${hq.id}/mqttBrokers`, { name: 'Broker', host: '192.0.2.50', port: 1883 }))]],
    };
    const profile = await created(sb.post(`/networks/${hq.id}/camera/qualityRetentionProfiles`, { name: 'Lobby' }));
    const P = `/organizations/${corp.id}/appliance/vpn/thirdPartyVPNPeers`;
    await created(sb.put(P, { peers: [{ name: 'Branch', publicIp: '198.51.100.7', secret: 's', privateSubnets: ['10.9.0.0/16'], network: { ids: [hq.id] } }] }), 200);
    const peerNet = async () => (await sb.get(P)).body.peers[0].network.ids;
    const check = async (net, p) => assert.deepEqual((await sb.get(`/networks/${net.id}/${reads[p][0]}`)).body, reads[p][1], p);

    const parts = (await created(sb.post(`/networks/${hq.id}/split`), 200)).resultingNetworks;
    for (const part of parts) if (reads[part.productTypes[0]]) await check(part, part.productTypes[0]);
    assert.deepEqual(await peerNet(), [parts.find((n) => n.productTypes[0] === 'appliance').id]);
    const cam = parts.find((n) => n.productTypes[0] === 'camera');
    assert.deepEqual((await sb.get(`/networks/${cam.id}/camera/qualityRetentionProfiles`)).body.map((p) => p.id), [profile.id]);

    const net = (await created(sb.post(`/organizations/${corp.id}/networks/combine`, { name: hq.name, networkIds: parts.map((n) => n.id) }), 200)).resultingNetwork;
    for (const p of Object.keys(reads)) await check(net, p);
    assert.deepEqual(await peerNet(), [net.id]);
    assert.deepEqual((await sb.get(`/networks/${net.id}/camera/qualityRetentionProfiles`)).body.map((p) => p.id), [profile.id]);
  });

  test('a network bound to a template answers every read', async () => {
    fresh();
    const [hq, austin] = corp.networks;
    const t = (await sb.post(`/organizations/${corp.id}/configTemplates`, { name: 'HQ', copyFromNetworkId: hq.id })).body;
    await created(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id, autoBind: false }), 200);
    assert.match(await errorOf(sb.post(`/networks/${austin.id}/split`)), /unbind it first/);
    await noErrors([austin]);
  });
});
