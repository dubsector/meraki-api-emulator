import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('MX ports, L3 interfaces, delegated prefixes and VRFs', () => {
  let sb;
  let org;
  let hq;
  let austin;
  let mx;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    mx = hq.mx.serial;
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
  const updatePort = (body, serial = mx) => sb.post(`/devices/${serial}/appliance/interfaces/ports/update`, body);
  const byDevice = async (n) => (await ok(sb.get(`/organizations/${org.id}/appliance/devices/interfaces/ports/byDevice?serials[]=${mx}`))).items[0].ports.find((p) => p.number === String(n));
  const L3 = () => `/networks/${hq.id}/appliance/interfaces/l3`;
  const S = () => `/networks/${hq.id}/appliance/prefixes/delegated/statics`;

  test('the device port update writes the network port and both views agree', async () => {
    fresh();
    const trunk = await ok(updatePort({ interface: { slot: 0, subslot: 0, number: 5 }, enabled: true, downlink: { mode: 'trunk', trunk: { nativeVlan: '10', allowedVlans: ['10', '20'], sgt: { enabled: true } } } }));
    assert.deepEqual(trunk.downlink, { mode: 'trunk', sgt: { id: null }, trunk: { nativeVlan: '10', allowedVlans: ['10', '20'], sgt: { enabled: true } } });
    assert.deepEqual(trunk, await byDevice(5));
    const net = await ok(sb.get(`/networks/${hq.id}/appliance/ports/5`));
    assert.deepEqual([net.enabled, net.type, net.vlan, net.allowedVlans, net.sgt.enabled], [true, 'trunk', 10, '10,20', true]);

    const infra = (await ok(sb.get(`/organizations/${org.id}/adaptivePolicy/groups`))).find((g) => g.name === 'Infrastructure');
    const access = await ok(updatePort({ interface: { number: 6 }, downlink: { mode: 'access', access: { vlan: '30', policy: { type: '802.1X' } }, sgt: { id: infra.groupId } } }));
    assert.deepEqual(access.downlink, { mode: 'access', sgt: { id: infra.groupId }, access: { vlan: '30', policy: { type: '802.1X' } } });
    const six = await ok(sb.get(`/networks/${hq.id}/appliance/ports/6`));
    assert.deepEqual([six.type, six.vlan, six.accessPolicy, six.sgt.id], ['access', 30, '8021x-radius', Number(infra.groupId)]);

    // A native VLAN of 0 drops untagged traffic.
    const drop = await ok(updatePort({ interface: { number: 5 }, downlink: { trunk: { nativeVlan: '0', allowedVlans: ['all'] } } }));
    assert.deepEqual(drop.downlink.trunk.nativeVlan, '0');
    assert.equal((await ok(sb.get(`/networks/${hq.id}/appliance/ports/5`))).dropUntaggedTraffic, true);
    // The network port's names show as the device view's policy types.
    await ok(sb.put(`/networks/${hq.id}/appliance/ports/6`, { accessPolicy: 'mac-radius' }));
    assert.equal((await byDevice(6)).downlink.access.policy.type, 'MAC RADIUS');
  });

  test('the device port update refuses what the port can not do', async () => {
    fresh();
    assert.match(await errorOf(updatePort({})), /'interface.number' is required/);
    assert.match(await errorOf(updatePort({ interface: { number: 99 } }), 404), /Port not found/);
    assert.match(await errorOf(updatePort({ interface: { slot: 1, number: 5 } }), 404), /Port not found/);
    assert.match(await errorOf(updatePort({ interface: { number: 1 }, enabled: false })), /carries uplink wan1/);
    assert.match(await errorOf(updatePort({ interface: { number: 1 }, downlink: { mode: 'access' } })), /only applies to LAN ports/);
    assert.match(await errorOf(updatePort({ interface: { number: 1 }, uplink: { type: 'cellular' } })), /must be 'ethernet'/);
    assert.equal((await ok(updatePort({ interface: { number: 1 }, enabled: true }))).name, 'wan1');
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, uplink: { type: 'ethernet' } })), /only applies to WAN ports/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, personality: { mode: 'wan' } })), /LAN port and can't be converted/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, personality: { layer: { mode: 3 } } })), /only operates at layer 2/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, downlink: { mode: 'trunk', trunk: { nativeVlan: '10', allowedVlans: ['20'] } } })), /must include the native VLAN 10/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, downlink: { mode: 'trunk', trunk: { allowedVlans: ['all', '20'] } } })), /can't be combined/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, downlink: { mode: 'access', access: { vlan: '5000' } } })), /VLAN number from 1 to 4094/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, downlink: { mode: 'access', trunk: {} } })), /doesn't apply to access ports/);
    assert.match(await errorOf(updatePort({ interface: { number: 5 } }, hq.switches[0].serial)), /only supported for appliance/);

    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'Branch', copyFromNetworkId: austin.id }), 201);
    await ok(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id }));
    assert.match(await errorOf(updatePort({ interface: { number: 5 } }, austin.mx.serial)), /bound to a config template/);
  });

  test('L3 interfaces sit on free LAN ports with subnets of their own', async () => {
    fresh();
    const a = await ok(sb.post(L3(), { ipv4: { address: '172.20.1.2', subnet: '172.20.1.0/24' }, port: { interface: { slot: 0, subslot: 0, number: 7 } } }), 201);
    assert.match(a.interfaceId, /^\d{18}$/);
    assert.deepEqual(a, { interfaceId: a.interfaceId, ipv4: { address: '172.20.1.2', subnet: '172.20.1.0/24' }, port: { interface: { name: 'GigabitEthernet0/0/7', slot: 0, subslot: 0, number: 7 } } });
    const b = await ok(sb.post(L3(), { ipv4: { address: '172.21.0.1', subnet: '172.21.0.0/30' } }), 201);
    assert.equal(b.port, null);

    assert.match(await errorOf(sb.post(L3(), {})), /'ipv4' is required/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '10.1.10.9', subnet: '10.1.10.0/28' } })), /overlaps a VLAN subnet/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.20.1.200', subnet: '172.20.1.128/25' } })), /overlaps the subnet of L3 interface/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.22.0.1', subnet: '172.23.0.0/24' } })), /inside 'ipv4.subnet'/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.22.0.0', subnet: '172.22.0.0/24' } })), /network address/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.22.0.1', subnet: '172.22.0.0/24' }, port: { interface: { slot: 0, subslot: 0, number: 7 } } })), /already holds L3 interface/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.22.0.1', subnet: '172.22.0.0/24' }, port: { interface: { slot: 0, subslot: 0, number: 1 } } })), /WAN port/);
    assert.match(await errorOf(sb.post(L3(), { ipv4: { address: '172.22.0.1', subnet: '172.22.0.0/24' }, port: { interface: { slot: 0, subslot: 0, number: 90 } } })), /names no port/);
    // VLANs can't take an interface's subnet either.
    assert.match(await errorOf(sb.post(`/networks/${hq.id}/appliance/vlans`, { id: '77', name: 'x', subnet: '172.20.1.0/26', applianceIp: '172.20.1.1' })), /L3 interface/);

    const moved = await ok(sb.put(`${L3()}/${a.interfaceId}`, { ipv4: { address: '172.20.1.3' }, port: null }));
    assert.deepEqual([moved.ipv4, moved.port], [{ address: '172.20.1.3', subnet: '172.20.1.0/24' }, null]);
    assert.equal((await sb.put(`${L3()}/1`, { port: null })).status, 404);

    const list = await ok(sb.get(`/organizations/${org.id}/appliance/devices/interfaces/l3?perPage=3`));
    assert.deepEqual(list.items.map((x) => [x.interfaceId, x.network.id]), [[a.interfaceId, hq.id], [b.interfaceId, hq.id]]);
    assert.deepEqual(list.meta.counts.items, { total: 2, remaining: 0 });
    assert.deepEqual((await ok(sb.get(`/organizations/${org.id}/appliance/devices/interfaces/l3?networkIds[]=${austin.id}`))).items, []);

    assert.equal((await sb.del(`${L3()}/${a.interfaceId}`)).status, 204);
    assert.equal((await sb.del(`${L3()}/${a.interfaceId}`)).status, 404);
    assert.equal((await ok(sb.get(`/organizations/${org.id}/appliance/devices/interfaces/l3`))).items.length, 1);
  });

  test('MX ports name adaptive policy groups of the organization', async () => {
    fresh();
    const G = `/organizations/${org.id}/adaptivePolicy/groups`;
    const g = await ok(sb.post(G, { name: 'Cameras', sgt: 40 }), 201);
    assert.match(await errorOf(updatePort({ interface: { number: 5 }, downlink: { sgt: { id: '999999' } } })), /'downlink.sgt.id' names adaptive policy group 999999/);
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/appliance/ports/6`, { sgt: { id: 999999 } })), /'sgt.id' names adaptive policy group 999999/);
    assert.equal((await byDevice(5)).downlink.sgt.id, null);
    await ok(updatePort({ interface: { number: 5 }, downlink: { sgt: { id: g.groupId } } }));
    assert.equal((await ok(sb.put(`/networks/${hq.id}/appliance/ports/6`, { sgt: { id: Number(g.groupId) } }))).sgt.id, Number(g.groupId));
    assert.equal((await byDevice(6)).downlink.sgt.id, g.groupId);

    // A network whose MX ports name a group can't move to another organization.
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: hq.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.match(move.result.reason, /appliance ports, SSIDs or VLAN profiles use adaptive policy groups/);

    // Deleting the group clears it from both ports.
    assert.equal((await sb.del(`${G}/${g.groupId}`)).status, 204);
    assert.deepEqual([(await byDevice(5)).downlink.sgt.id, (await byDevice(6)).downlink.sgt.id], [null, null]);
    assert.equal((await ok(sb.get(`/networks/${hq.id}/appliance/ports/6`))).sgt.id, null);
    const again = await ok(sb.post(`/organizations/${org.id}/networks/moves`, { network: { id: hq.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(again.result.status, 'completed', again.result.reason);
  });

  test('a port holding an L3 interface routes and VLANs turning on keep clear of interfaces', async () => {
    fresh();
    const a = await ok(sb.post(L3(), { ipv4: { address: '172.20.1.2', subnet: '172.20.1.0/24' }, port: { interface: { slot: 0, subslot: 0, number: 7 } } }), 201);
    const seven = await byDevice(7);
    assert.deepEqual([seven.personality.layer.mode, seven.downlink], [3, undefined]);
    assert.match(await errorOf(updatePort({ interface: { number: 7 }, downlink: { mode: 'access' } })), /holds an L3 interface/);
    assert.equal((await ok(updatePort({ interface: { number: 7 }, enabled: false }))).enabled, false);
    await ok(sb.put(`${L3()}/${a.interfaceId}`, { port: null }));
    assert.equal((await byDevice(7)).personality.layer.mode, 2);

    // With VLANs off, an interface can take a kept VLAN's subnet, and VLANs then stay off.
    const V = `/networks/${hq.id}/appliance/vlans`;
    const kept = (await ok(sb.get(V))).at(-1);
    await ok(sb.put(`${V}/settings`, { vlansEnabled: false }));
    const b = await ok(sb.post(L3(), { ipv4: { address: kept.applianceIp, subnet: kept.subnet } }), 201);
    assert.match(await errorOf(sb.put(`${V}/settings`, { vlansEnabled: true })), new RegExp(`VLAN ${kept.id} overlaps the subnet of L3 interface ${b.interfaceId}`));
    assert.equal((await ok(sb.get(`${V}/settings`))).vlansEnabled, false);
    assert.equal((await sb.del(`${L3()}/${b.interfaceId}`)).status, 204);
    assert.equal((await ok(sb.put(`${V}/settings`, { vlansEnabled: true }))).vlansEnabled, true);
  });

  test('the organization L3 interface list pages through network copies sharing IDs', async () => {
    fresh();
    const made = [];
    for (const n of [7, 8]) made.push(await ok(sb.post(L3(), { ipv4: { address: `172.2${n}.0.1`, subnet: `172.2${n}.0.0/24` }, port: { interface: { slot: 0, subslot: 0, number: n } } }), 201));
    const copy = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'HQ copy', productTypes: ['appliance'], copyFromNetworkId: hq.id }), 201);
    const all = await collect(sb.get, `/organizations/${org.id}/appliance/devices/interfaces/l3?perPage=3`);
    const want = [hq.id, copy.id].sort().flatMap((id) => made.map((x) => [id, x.interfaceId]));
    assert.deepEqual(all.map((x) => [x.network.id, x.interfaceId]), want);
  });

  test('static delegated prefixes list on the device and feed IPv6 VLANs', async () => {
    fresh();
    const D = `/devices/${mx}/appliance/prefixes/delegated`;
    assert.deepEqual(await ok(sb.get(S())), []);
    assert.deepEqual(await ok(sb.get(D)), []);
    assert.deepEqual(await ok(sb.get(`${D}/vlanAssignments`)), []);

    const a = await ok(sb.post(S(), { prefix: '2001:DB8:3C4D:0::/48', origin: { type: 'internet', interfaces: ['wan1'] }, description: 'ISP A' }), 201);
    assert.match(a.staticDelegatedPrefixId, /^\d{13}$/);
    assert.deepEqual([a.prefix, a.origin, a.description, a.createdAt], ['2001:db8:3c4d::/48', { type: 'internet', interfaces: ['wan1'] }, 'ISP A', '2026-09-29T18:30:00Z']);
    const b = await ok(sb.post(S(), { prefix: '2001:db8:aa00::/56', origin: { type: 'independent' } }), 201);
    assert.deepEqual(await ok(sb.get(`${S()}/${b.staticDelegatedPrefixId}`)), b);

    assert.match(await errorOf(sb.post(S(), { prefix: '2001:db8:3c4d::/48', origin: { type: 'independent' } })), /already in this network/);
    assert.match(await errorOf(sb.post(S(), { prefix: '10.0.0.0/8', origin: { type: 'independent' } })), /IPv6 prefix/);
    assert.match(await errorOf(sb.post(S(), { prefix: '2001:db8::/32', origin: { type: 'independent' } })), /from \/48 to \/64/);
    assert.match(await errorOf(sb.post(S(), { prefix: '2001:db9::/48', origin: { type: 'internet' } })), /required when the origin type is internet/);
    assert.match(await errorOf(sb.post(S(), { prefix: '2001:db9::/48', origin: { type: 'internet', interfaces: ['wan3'] } })), /uplinks of this network: wan1, wan2/);
    assert.match(await errorOf(sb.post(S(), { prefix: '2001:db9::/48', origin: { type: 'independent', interfaces: ['wan1'] } })), /only applies/);
    assert.equal((await sb.get(`${S()}/1284392014819`)).status, 404);

    // Two VLANs take /64s from the wan1 prefix in order; one names its own.
    const ipv6 = (prefixAssignments) => ({ ipv6: { enabled: true, prefixAssignments } });
    await ok(sb.put(`/networks/${hq.id}/appliance/vlans/10`, ipv6([{ autonomous: true, origin: { type: 'internet', interfaces: ['wan1'] } }])));
    await ok(sb.put(`/networks/${hq.id}/appliance/vlans/20`, ipv6([{ autonomous: true, origin: { type: 'internet', interfaces: ['wan1'] } }, { autonomous: false, staticPrefix: '2001:db8:aa00:5::/64', origin: { type: 'independent' } }])));
    await ok(sb.put(`/networks/${hq.id}/appliance/vlans/30`, ipv6([{ autonomous: true, origin: { type: 'internet', interfaces: ['wan2'] } }])));
    const rows = await ok(sb.get(`${D}/vlanAssignments`));
    assert.deepEqual(rows.map((r) => [r.vlan.id, r.origin.interface, r.origin.prefix, r.status, r.ipv6?.prefix, r.ipv6?.address]), [
      [10, 'wan1', '2001:db8:3c4d::/48', 'Active', '2001:db8:3c4d::/64', '2001:db8:3c4d::1'],
      [20, 'wan1', '2001:db8:3c4d::/48', 'Active', '2001:db8:3c4d:1::/64', '2001:db8:3c4d:1::1'],
      [20, 'independent', '2001:db8:aa00::/56', 'Active', '2001:db8:aa00:5::/64', '2001:db8:aa00:5::1'],
      [30, 'wan2', undefined, 'Not assigned', undefined, undefined],
    ]);
    assert.match(rows[0].ipv6.linkLocal.address, /^fe80::[0-9a-f:]+$/);
    assert.equal(rows[0].ipv6.solicitedNodeMulticast.address, 'ff02::1:ff00:1');

    const dev = await ok(sb.get(D));
    assert.deepEqual(dev.map((r) => [r.origin.interface, r.prefix, r.counts, r.method, r.staticDelegatedPrefixId]), [
      ['wan1', '2001:db8:3c4d::/48', { assigned: 2, available: 65534 }, 'manual', a.staticDelegatedPrefixId],
      ['independent', '2001:db8:aa00::/56', { assigned: 0, available: 256 }, 'manual', b.staticDelegatedPrefixId],
    ]);

    const c = await ok(sb.put(`${S()}/${a.staticDelegatedPrefixId}`, { origin: { type: 'internet', interfaces: ['wan1', 'wan2'] }, description: 'Both' }));
    assert.deepEqual([c.origin.interfaces, c.description, c.prefix], [['wan1', 'wan2'], 'Both', '2001:db8:3c4d::/48']);
    assert.equal((await ok(sb.get(`${D}/vlanAssignments`)))[3].status, 'Active');
    assert.deepEqual((await ok(sb.get(D))).map((r) => r.origin.interface), ['wan1', 'wan2', 'independent']);
    assert.equal((await sb.del(`${S()}/${a.staticDelegatedPrefixId}`)).status, 204);
    assert.deepEqual((await ok(sb.get(S()))).map((x) => x.staticDelegatedPrefixId), [b.staticDelegatedPrefixId]);
    assert.match(await errorOf(sb.get(`/devices/${hq.switches[0].serial}/appliance/prefixes/delegated`)), /only supported for appliance/);
  });

  test('VRFs are an organization setting that starts off', async () => {
    fresh();
    const V = `/organizations/${org.id}/appliance/routing/vrfs/settings`;
    assert.deepEqual(await ok(sb.get(V)), { enabled: false });
    assert.match(await errorOf(sb.put(V, {})), /'enabled' is required/);
    assert.deepEqual(await ok(sb.put(V, { enabled: true })), { enabled: true });
    assert.deepEqual(await ok(sb.get(V)), { enabled: true });
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    assert.deepEqual(await ok(sb.get(`/organizations/${lab.id}/appliance/routing/vrfs/settings`)), { enabled: false });
  });
});
