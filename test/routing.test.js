import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('switch layer 3 routing and multicast', () => {
  let sb;
  let hq;
  let core;
  let f2;
  let f3;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    hq = sb.world.orgs[0].networks[0];
    [core, f2, f3] = hq.switches;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const I = (dev) => `/devices/${dev.serial}/switch/routing/interfaces`;
  const N = () => `/networks/${hq.id}/switch/routing`;
  const GW = { name: 'Users', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' };

  test('switches start with no interfaces, and only layer 3 switches route', async () => {
    fresh();
    assert.deepEqual((await sb.get(I(core))).body, []);
    assert.deepEqual((await sb.get(`/devices/${core.serial}/switch/routing/staticRoutes`)).body, []);
    const austin = sb.world.orgs[0].networks[1].switches[0];
    assert.match(await errorOf(sb.get(I(austin))), /MS130-24P switches do not support layer 3 routing/);
    assert.match(await errorOf(sb.get(I(hq.aps[0]))), /only supported for switch devices/);
    assert.equal((await sb.get(`${I(core)}/578149602163689001`)).status, 404);
  });

  test('a lone switch has the same interfaces, DHCP and static routes as a stack', async () => {
    fresh();
    assert.match(await errorOf(sb.post(I(core), { ...GW, interfaceIp: core.lanIp, subnet: `${core.lanIp}/32`, defaultGateway: core.lanIp })), /management IP/);
    const made = await sb.post(I(core), GW);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body, {
      interfaceId: made.body.interfaceId,
      name: 'Users',
      mode: 'vlan',
      subnet: '192.0.2.0/25',
      interfaceIp: '192.0.2.2',
      serial: core.serial,
      multicastRouting: 'disabled',
      vlanId: 10,
      uplinkV4: true,
      uplinkV6: false,
      ospfSettings: { area: 'disabled', cost: 1, isPassiveEnabled: false, networkType: 'broadcast' },
      defaultGateway: '192.0.2.1',
    });
    const one = `${I(core)}/${made.body.interfaceId}`;
    // Unlike the stack route, the device update answers with the gateway.
    const put = await sb.put(one, { name: 'Staff', mtu: 9000 });
    assert.equal(put.body.defaultGateway, '192.0.2.1');
    assert.equal(put.body.mtu, 9000);
    assert.deepEqual((await sb.get(one)).body, put.body);
    assert.match(await errorOf(sb.post(I(core), { ...GW, name: 'Dup', subnet: '192.0.2.128/25', interfaceIp: '192.0.2.129' })), /VLAN 10 already has a layer 3 interface on this switch/);

    const D = `${one}/dhcp`;
    assert.deepEqual((await sb.get(D)).body, { dhcpMode: 'dhcpDisabled' });
    assert.deepEqual((await sb.put(D, { dhcpMode: 'dhcpRelay', dhcpRelayServerIps: ['198.51.100.10'] })).body, { dhcpMode: 'dhcpRelay', dhcpRelayServerIps: ['198.51.100.10'] });

    const R = `/devices/${core.serial}/switch/routing/staticRoutes`;
    const route = await sb.post(R, { name: 'Lab', subnet: '198.51.100.0/24', nextHopIp: '192.0.2.10' });
    assert.equal(route.status, 200, JSON.stringify(route.body));
    assert.deepEqual(route.body, { staticRouteId: route.body.staticRouteId, name: 'Lab', subnet: '198.51.100.0/24', nextHopIp: '192.0.2.10', advertiseViaOspfEnabled: false, preferOverOspfRoutesEnabled: false });
    assert.match(await errorOf(sb.post(R, { subnet: '203.0.113.0/24', nextHopIp: '203.0.113.1' })), /layer 3 interface on this switch/);
    const moved = await sb.put(`${R}/${route.body.staticRouteId}`, { managementNextHop: '192.0.2.11' });
    assert.equal(moved.status, 201);
    assert.equal(moved.body.managementNextHop, '192.0.2.11');
    assert.deepEqual((await sb.get(R)).body, [moved.body]);
    // The route's next hop needs the interface's subnet.
    assert.equal(await errorOf(sb.del(one)), 'Change or delete static route 198.51.100.0/24 (next hop 192.0.2.10) before deleting this interface');
    assert.equal(await errorOf(sb.put(one, { subnet: '192.0.2.0/29', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' })), 'Next hop 192.0.2.10 of static route 198.51.100.0/24 would no longer be in a layer 3 interface subnet');
    assert.equal((await sb.del(`${R}/${route.body.staticRouteId}`)).status, 204);
    assert.equal((await sb.del(one)).status, 204);
    assert.deepEqual((await sb.get(I(core))).body, []);
  });

  test('stacked switches use the stack routes', async () => {
    fresh();
    assert.equal((await sb.post(I(f2), GW)).status, 201);
    const S = `/networks/${hq.id}/switch/stacks`;
    assert.match(await errorOf(sb.post(S, { name: 'Floors', serials: [f2.serial, f3.serial] })), /Delete the layer 3 interfaces on switch/);
    await sb.del(`${I(f2)}/${(await sb.get(I(f2))).body[0].interfaceId}`);
    assert.equal((await sb.post(S, { name: 'Floors', serials: [f2.serial, f3.serial] })).status, 200);
    assert.match(await errorOf(sb.get(I(f3))), /is in stack 'Floors'/);
  });

  test('OSPF settings, and interface areas that must exist', async () => {
    fresh();
    const O = `${N()}/ospf`;
    const backbone = { areaId: '0', areaName: 'Backbone', areaType: 'normal' };
    assert.deepEqual((await sb.get(O)).body, {
      enabled: false,
      helloTimerInSeconds: 10,
      deadTimerInSeconds: 40,
      areas: [backbone],
      v3: { enabled: false, helloTimerInSeconds: 10, deadTimerInSeconds: 40, areas: [backbone] },
      md5AuthenticationEnabled: false,
    });
    assert.match(await errorOf(sb.get(`${O}?vrf=Blue`)), /IOS XE/);
    assert.match(await errorOf(sb.put(O, { helloTimerInSeconds: 0 })), /between 1 and 255/);
    assert.match(await errorOf(sb.put(O, { md5AuthenticationEnabled: true })), /needs an 'id' and a 'passphrase'/);
    assert.match(await errorOf(sb.put(O, { areas: [backbone, backbone] })), /more than once/);
    assert.match(await errorOf(sb.put(O, { areas: [{ ...backbone, areaId: 'x' }] })), /must be a number/);

    const areas = [backbone, { areaId: '10', areaName: 'Floors', areaType: 'stub' }];
    const put = await sb.put(O, { enabled: true, areas, md5AuthenticationEnabled: true, md5AuthenticationKey: { id: 7, passphrase: 'secret' }, v3: { enabled: true } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.areas, areas);
    assert.deepEqual(put.body.md5AuthenticationKey, { id: 7, passphrase: 'secret' });
    assert.equal(put.body.v3.enabled, true);
    assert.deepEqual((await sb.get(O)).body, put.body);

    assert.match(await errorOf(sb.post(I(core), { ...GW, ospfSettings: { area: '20' } })), /OSPF area '20' does not exist/);
    assert.equal((await sb.post(I(core), { ...GW, ospfSettings: { area: '10' } })).status, 201);
    assert.match(await errorOf(sb.put(O, { areas: [backbone] })), /OSPF area '10' is used by layer 3 interface 'Users'/);
    assert.match(await errorOf(sb.get(`/networks/${sb.world.orgs[1].networks[0].id}/switch/routing/ospf`)), /product type 'switch'/);
  });

  test('a bound network takes OSPF and multicast from its template and keeps its rendezvous points', async () => {
    fresh();
    const org = sb.world.orgs[0];
    const austin = org.networks[1];
    const t = (await sb.post(`/organizations/${org.id}/configTemplates`, { name: 'Branches', copyFromNetworkId: austin.id })).body;
    assert.equal((await sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id })).status, 200);
    const B = `/networks/${austin.id}/switch/routing`;
    assert.equal((await sb.get(`${B}/ospf`)).body.enabled, false);
    assert.match(await errorOf(sb.put(`${B}/ospf`, { enabled: true })), /bound to a config template/);
    assert.equal((await sb.get(`${B}/multicast`)).status, 200);
    const [profile] = (await sb.get(`/organizations/${org.id}/configTemplates/${t.id}/switch/profiles`)).body;
    const overrides = [{ switchProfiles: [profile.switchProfileId], igmpSnoopingEnabled: false, floodUnknownMulticastTrafficEnabled: false }];
    assert.match(await errorOf(sb.put(`${B}/multicast`, { overrides })), /bound to a config template/);
    // Rendezvous points name the network's own interfaces, so they stay writable.
    assert.equal((await sb.get(`${B}/multicast/rendezvousPoints`)).status, 200);
    assert.match(await errorOf(sb.post(`${B}/multicast/rendezvousPoints`, { interfaceIp: '192.0.2.2', multicastGroup: 'Any' })), /No layer 3 interface/);
  });

  test('multicast settings and overrides', async () => {
    fresh();
    const M = `${N()}/multicast`;
    assert.deepEqual((await sb.get(M)).body, { defaultSettings: { igmpSnoopingEnabled: true, floodUnknownMulticastTrafficEnabled: true }, overrides: [] });
    const stack = (await sb.post(`/networks/${hq.id}/switch/stacks`, { name: 'Floors', serials: [f2.serial, f3.serial] })).body;
    const flags = { igmpSnoopingEnabled: false, floodUnknownMulticastTrafficEnabled: true };
    const body = { defaultSettings: { floodUnknownMulticastTrafficEnabled: false }, overrides: [{ switches: [core.serial], ...flags }, { stacks: [stack.id], ...flags }] };
    const put = await sb.put(M, body);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body, { defaultSettings: { igmpSnoopingEnabled: true, floodUnknownMulticastTrafficEnabled: false }, overrides: body.overrides });
    assert.deepEqual((await sb.get(M)).body, put.body);

    assert.match(await errorOf(sb.put(M, { overrides: [{ switches: [f2.serial], ...flags }] })), /is in stack 'Floors', so list the stack instead/);
    assert.match(await errorOf(sb.put(M, { overrides: [{ switches: [core.serial], stacks: [stack.id], ...flags }] })), /exactly one of/);
    assert.match(await errorOf(sb.put(M, { overrides: [{ switches: ['Q2XX-0000-0000'], ...flags }] })), /is not in this network/);
    assert.match(await errorOf(sb.put(M, { overrides: [{ switchProfiles: ['1234'], ...flags }] })), /config template/);
    assert.match(await errorOf(sb.put(M, { overrides: [{ switches: [core.serial], ...flags }, { switches: [core.serial], ...flags }] })), /more than one entry of 'overrides'/);

    // A deleted stack drops out of the overrides.
    assert.equal((await sb.del(`/networks/${hq.id}/switch/stacks/${stack.id}`)).status, 204);
    assert.deepEqual((await sb.get(M)).body.overrides, [body.overrides[0]]);
    assert.deepEqual((await sb.put(M, { overrides: [] })).body.overrides, []);
  });

  test('rendezvous points name a layer 3 interface in the network', async () => {
    fresh();
    const P = `${N()}/multicast/rendezvousPoints`;
    assert.deepEqual((await sb.get(P)).body, []);
    assert.match(await errorOf(sb.post(P, { interfaceIp: '192.0.2.2', multicastGroup: 'Any' })), /No layer 3 interface in this network has the IP 192.0.2.2/);
    const iface = (await sb.post(I(core), GW)).body;
    assert.match(await errorOf(sb.post(P, { interfaceIp: '192.0.2.2', multicastGroup: '10.0.0.1' })), /'multicastGroup' must be 'Any' or a multicast IP/);
    assert.match(await errorOf(sb.post(P, { interfaceIp: '192.0.2.2', multicastGroup: 'Any', vrf: { name: 'Blue' } })), /IOS XE/);

    const rp = await sb.post(P, { interfaceIp: '192.0.2.2', multicastGroup: 'Any' });
    assert.equal(rp.status, 201, JSON.stringify(rp.body));
    assert.deepEqual(rp.body, { rendezvousPointId: rp.body.rendezvousPointId, serial: core.serial, interfaceName: 'Users', interfaceIp: '192.0.2.2', multicastGroup: 'Any' });
    assert.match(await errorOf(sb.post(P, { interfaceIp: '192.0.2.2', multicastGroup: 'Any' })), /already exists/);
    const one = `${P}/${rp.body.rendezvousPointId}`;
    const put = await sb.put(one, { interfaceIp: '192.0.2.2', multicastGroup: '239.1.1.1' });
    assert.equal(put.body.multicastGroup, '239.1.1.1');
    assert.deepEqual((await sb.get(P)).body, [put.body]);

    // The point follows its interface, and goes when the interface does.
    await sb.put(`${I(core)}/${iface.interfaceId}`, { name: 'Staff' });
    assert.equal((await sb.get(one)).body.interfaceName, 'Staff');
    await sb.del(`${I(core)}/${iface.interfaceId}`);
    assert.equal((await sb.get(one)).status, 404);
    assert.deepEqual((await sb.get(P)).body, []);
  });

  test('the multicast routing live tool reads the routing settings', async () => {
    fresh();
    const tool = (dev) => sb.post(`/devices/${dev.serial}/liveTools/multicastRouting`, {});
    const off = await tool(core);
    assert.equal(off.status, 201, JSON.stringify(off.body));
    assert.equal(off.body.status, 'complete');
    assert.deepEqual((await sb.get(off.body.url)).body, { multicastRoutingId: off.body.multicastRoutingId, url: off.body.url, request: { serial: core.serial }, status: 'complete', interfaces: [], routes: [] });
    assert.match(await errorOf(sb.post(`/devices/${hq.aps[0].serial}/liveTools/multicastRouting`, {})), /not supported/);

    await sb.post(I(core), { ...GW, multicastRouting: 'enabled' });
    await sb.post(I(core), { name: 'Video', vlanId: 20, subnet: '192.0.2.128/25', interfaceIp: '192.0.2.129', multicastRouting: 'enabled' });
    await sb.post(I(f2), { name: 'Peer', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.3', defaultGateway: '192.0.2.1', multicastRouting: 'enabled' });
    await sb.post(`${N()}/multicast/rendezvousPoints`, { interfaceIp: '192.0.2.3', multicastGroup: '239.1.1.1' });
    const job = (await sb.get((await tool(core)).body.url)).body;
    assert.deepEqual(job.interfaces, [
      { ip: '192.0.2.2', name: 'Vlan10', subnet: '192.0.2.0/25', flags: ['PIM'], neighbors: ['192.0.2.3'] },
      { ip: '192.0.2.129', name: 'Vlan20', subnet: '192.0.2.128/25', flags: ['PIM', 'NO-NBR', 'DR'], neighbors: [] },
    ]);
    assert.deepEqual(job.routes, [{ source: 'Any', group: '239.1.1.1', rendezvousPoint: '192.0.2.3', incomingInterfaceName: 'Vlan10', outgoingInterfaceNames: ['Vlan20'], flags: ['WC'] }]);
    const peer = (await sb.get((await tool(f2)).body.url)).body;
    assert.deepEqual(peer.interfaces[0].flags, ['PIM', 'DR']);
    assert.deepEqual(peer.routes, [{ source: 'Any', group: '239.1.1.1', rendezvousPoint: '192.0.2.3', incomingInterfaceName: 'Null', outgoingInterfaceNames: ['Vlan10'], flags: ['WC', 'RP'] }]);
  });
});
