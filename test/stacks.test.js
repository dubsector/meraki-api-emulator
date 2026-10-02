import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { claimDevice } from '../src/world.js';
import { start } from './helpers.js';

describe('switch stacks', () => {
  let sb;
  let hq;
  let S;
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
    S = `/networks/${hq.id}/switch/stacks`;
    [core, f2, f3] = hq.switches;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const makeStack = async () => {
    const r = await sb.post(S, { name: 'Floors', serials: [f2.serial, f3.serial] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.id;
  };
  const GW = { name: 'Users', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' };

  test('networks start with no stacks', async () => {
    fresh();
    assert.deepEqual((await sb.get(S)).body, []);
    assert.equal((await sb.get(`${S}/578149602163689000`)).status, 404);
    assert.equal((await sb.get(`/networks/${sb.world.orgs[1].networks[0].id}/switch/stacks`)).status, 400);
  });

  test('create answers like the spec and the stack shows in the list', async () => {
    fresh();
    const r = await sb.post(S, { name: 'Floors', serials: [f2.serial, f3.serial] });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ['id', 'name', 'serials', 'workflowId']);
    assert.match(r.body.id, /^\d{18}$/);
    const list = (await sb.get(S)).body;
    assert.equal(list.length, 1);
    const stack = list[0];
    assert.deepEqual(stack.serials, [f2.serial, f3.serial]);
    assert.equal(stack.isMonitorOnly, false);
    assert.match(stack.virtualMac, /^e0:cb:bc(:[0-9a-f]{2}){3}$/);
    assert.deepEqual(stack.members.map((m) => [m.serial, m.model, m.role]), [[f2.serial, 'MS250-48FP', 'active'], [f3.serial, 'MS250-48FP', 'standby']]);
    assert.deepEqual((await sb.get(`${S}/${r.body.id}`)).body, stack);
  });

  test('the same calls give the same IDs', async () => {
    fresh();
    const a = await makeStack();
    await sb.reset();
    fresh();
    assert.equal(await makeStack(), a);
  });

  test('members are checked', async () => {
    fresh();
    assert.match(await errorOf(sb.post(S, { name: 'x', serials: [f2.serial] })), /at least 2/);
    assert.match(await errorOf(sb.post(S, { name: 'x', serials: [f2.serial, f2.serial] })), /only be listed once/);
    assert.match(await errorOf(sb.post(S, { name: 'x', serials: [core.serial, f2.serial] })), /same series/);
    assert.match(await errorOf(sb.post(S, { name: 'x', serials: [f2.serial, 'Q2XX-0000-0000'] })), /not in this network/);
    const austin = sb.world.orgs[0].networks[1];
    const err = await errorOf(sb.post(`/networks/${austin.id}/switch/stacks`, { name: 'x', serials: austin.switches.map((s) => s.serial) }));
    assert.match(err, /MS130-24P switches do not support stacking/);
    await makeStack();
    assert.match(await errorOf(sb.post(S, { name: 'y', serials: [f3.serial, f2.serial] })), /already in stack 'Floors'/);
  });

  test('update, add, remove and delete', async () => {
    fresh();
    const id = await makeStack();
    assert.match(await errorOf(sb.put(`${S}/${id}`, {})), /At least one of/);
    assert.equal((await sb.put(`${S}/${id}`, { name: 'Upstairs' })).body.name, 'Upstairs');
    const swapped = await sb.put(`${S}/${id}`, { members: [{ serial: f3.serial }, { serial: f2.serial }] });
    assert.deepEqual(swapped.body.members.map((m) => [m.serial, m.role]), [[f3.serial, 'active'], [f2.serial, 'standby']]);

    const extra = claimDevice(sb.world, hq, { serial: 'Q2HP-AAAA-0001', model: 'MS250-48FP', mac: 'e0:cb:bc:00:00:01', orderNumber: null, claimedAt: 0, tags: [], name: 'SW-HQ-4F' });
    assert.match(await errorOf(sb.post(`${S}/${id}/add`, { serial: f2.serial })), /already in this stack/);
    assert.match(await errorOf(sb.post(`${S}/${id}/add`, { serial: core.serial })), /same series/);
    const added = await sb.post(`${S}/${id}/add`, { serial: extra.serial });
    assert.equal(added.status, 200);
    assert.deepEqual(added.body.members.map((m) => m.role), ['active', 'standby', 'member']);
    const removed = await sb.post(`${S}/${id}/remove`, { serial: extra.serial });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.serials, [f3.serial, f2.serial]);
    assert.match(await errorOf(sb.post(`${S}/${id}/remove`, { serial: f2.serial })), /at least 2/);
    assert.match(await errorOf(sb.post(`${S}/${id}/remove`, { serial: core.serial })), /not in this stack/);

    assert.equal((await sb.del(`${S}/${id}`)).status, 204);
    assert.equal((await sb.get(`${S}/${id}`)).status, 404);
    assert.deepEqual((await sb.get(S)).body, []);
  });

  test('a switch removed from the network leaves its stack', async () => {
    fresh();
    const id = await makeStack();
    assert.equal((await sb.post(`/networks/${hq.id}/devices/remove`, { serial: f3.serial })).status, 204);
    assert.deepEqual((await sb.get(`${S}/${id}`)).body.serials, [f2.serial]);
    const nodes = (await sb.get(`/networks/${hq.id}/topology/linkLayer`)).body.nodes;
    assert.deepEqual(nodes.find((n) => n.type === 'stack').stack.members.map((m) => m.serial), [f2.serial]);
  });

  test('the topology shows a stack as one node', async () => {
    fresh();
    const T = `/networks/${hq.id}/topology/linkLayer`;
    const before = (await sb.get(T)).body;
    const id = await makeStack();
    const t = (await sb.get(T)).body;
    const serials = [f2.serial, f3.serial];
    const isMember = (x) => serials.includes(x.device?.serial);
    assert.equal(t.nodes.filter(isMember).length, 0);
    const stacks = t.nodes.filter((n) => n.type === 'stack');
    assert.equal(stacks.length, 1);
    const [node] = stacks;
    assert.deepEqual(Object.keys(node), ['derivedId', 'mac', 'type', 'root', 'stack']);
    assert.equal(node.derivedId, id);
    assert.equal(node.mac, (await sb.get(`${S}/${id}`)).body.virtualMac);
    assert.equal(node.root, false);
    assert.equal(node.stack.name, 'Floors');
    // stack.id is an integer, too big for JSON.parse to keep exactly, so check the raw text.
    const raw = await (await fetch(sb.base + T, { headers: { 'X-Cisco-Meraki-API-Key': 'test-key' } })).text();
    assert.ok(raw.includes(`"stack":{"id":${id},`));
    const old = before.nodes.filter(isMember).map((n) => n.device);
    assert.deepEqual(node.stack.members, old);
    assert.equal(node.stack.clients.counts.total, old.reduce((n, d) => n + d.clients.counts.total, 0));

    // Links to a member point at the stack and keep the member's serial.
    const ends = (links) => links.flatMap((l) => l.ends).filter(isMember);
    assert.equal(t.links.length, before.links.length);
    assert.equal(ends(t.links).length, ends(before.links).length);
    assert.ok(ends(t.links).every((e) => e.node.derivedId === id && e.node.type === 'stack'));
    const ids = new Set(t.nodes.map((n) => n.derivedId));
    for (const l of t.links) for (const e of l.ends) assert.ok(ids.has(e.node.derivedId));

    assert.equal((await sb.del(`${S}/${id}`)).status, 204);
    assert.deepEqual((await sb.get(T)).body, before);
  });

  test('layer 3 interfaces', async () => {
    fresh();
    const I = `${S}/${await makeStack()}/routing/interfaces`;
    assert.match(await errorOf(sb.post(I, { ...GW, defaultGateway: undefined })), /'defaultGateway' is required/);
    assert.match(await errorOf(sb.post(I, { ...GW, mode: 'routed' })), /IOS XE/);
    assert.match(await errorOf(sb.post(I, { ...GW, interfaceIp: '198.51.100.1' })), /not in subnet/);
    assert.match(await errorOf(sb.post(I, { ...GW, defaultGateway: '198.51.100.1' })), /must be in the subnet/);

    const first = await sb.post(I, GW);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body, {
      interfaceId: first.body.interfaceId,
      name: 'Users',
      mode: 'vlan',
      subnet: '192.0.2.0/25',
      interfaceIp: '192.0.2.2',
      multicastRouting: 'disabled',
      vlanId: 10,
      uplinkV4: true,
      uplinkV6: false,
      ospfSettings: { area: 'disabled', cost: 1, isPassiveEnabled: false, networkType: 'broadcast' },
      defaultGateway: '192.0.2.1',
    });
    assert.match(await errorOf(sb.post(I, { name: 'Dup', vlanId: 10, subnet: '192.0.2.128/25', interfaceIp: '192.0.2.129' })), /VLAN 10 already/);
    assert.match(await errorOf(sb.post(I, { name: 'Over', vlanId: 20, subnet: '192.0.2.64/26', interfaceIp: '192.0.2.65' })), /overlaps/);

    const second = await sb.post(I, { name: 'Voice', vlanId: 20, subnet: '192.0.2.128/25', interfaceIp: '192.0.2.129', ipv6: { assignmentMode: 'eui-64', prefix: '2001:db8:1::/64', gateway: '2001:db8:1::1' } });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.uplinkV4, false);
    assert.equal(second.body.uplinkV6, true);
    assert.equal(second.body.defaultGateway, undefined);
    assert.deepEqual(second.body.ipv6, { assignmentMode: 'eui-64', prefix: '2001:db8:1::/64', gateway: '2001:db8:1::1' });
    assert.ok(second.body.ospfV3);

    assert.equal((await sb.get(I)).body.length, 2);
    assert.deepEqual((await sb.get(`${I}?protocol=ipv6`)).body.map((i) => i.name), ['Voice']);
    assert.deepEqual((await sb.get(`${I}?mode=routed`)).body, []);

    const one = `${I}/${first.body.interfaceId}`;
    const put = await sb.put(one, { name: 'Staff', ospfSettings: { area: '0', cost: 10 } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.ospfSettings, { area: '0', cost: 10, isPassiveEnabled: false, networkType: 'broadcast' });
    // The update answer has no defaultGateway; the GET of the gateway interface does.
    assert.deepEqual((await sb.get(one)).body, { ...put.body, defaultGateway: '192.0.2.1' });
    assert.match(await errorOf(sb.put(one, { subnet: '198.51.100.0/24', interfaceIp: '198.51.100.2' })), /would no longer be in/);
    assert.match(await errorOf(sb.del(one)), /Move the default gateway/);

    // Moving the gateway to the other interface frees the first one.
    const moved = await sb.put(`${I}/${second.body.interfaceId}`, { defaultGateway: '192.0.2.130' });
    assert.equal(moved.body.uplinkV4, true);
    assert.equal(moved.body.defaultGateway, undefined);
    assert.equal((await sb.get(`${I}/${second.body.interfaceId}`)).body.defaultGateway, '192.0.2.130');
    assert.equal((await sb.del(one)).status, 204);
    assert.equal((await sb.get(one)).status, 404);
  });

  test('interface DHCP', async () => {
    fresh();
    const I = `${S}/${await makeStack()}/routing/interfaces`;
    const D = `${I}/${(await sb.post(I, GW)).body.interfaceId}/dhcp`;
    assert.deepEqual((await sb.get(D)).body, { dhcpMode: 'dhcpDisabled' });
    assert.match(await errorOf(sb.put(D, { dhcpMode: 'dhcpRelay' })), /'dhcpRelayServerIps' is required/);
    assert.deepEqual((await sb.put(D, { dhcpMode: 'dhcpRelay', dhcpRelayServerIps: ['198.51.100.10'] })).body, { dhcpMode: 'dhcpRelay', dhcpRelayServerIps: ['198.51.100.10'] });

    const server = await sb.put(D, { dhcpMode: 'dhcpServer', fixedIpAssignments: [{ name: 'Printer', mac: '22:33:44:55:66:77', ip: '192.0.2.12' }] });
    assert.deepEqual(server.body, {
      dhcpMode: 'dhcpServer',
      dhcpLeaseTime: '1 day',
      dnsNameserversOption: 'googlePublicDns',
      bootOptionsEnabled: false,
      dhcpOptions: [],
      reservedIpRanges: [],
      fixedIpAssignments: [{ name: 'Printer', mac: '22:33:44:55:66:77', ip: '192.0.2.12' }],
    });
    assert.deepEqual((await sb.get(D)).body, server.body);
    assert.match(await errorOf(sb.put(D, { fixedIpAssignments: [{ name: 'Far', mac: '22:33:44:55:66:78', ip: '198.51.100.12' }] })), /must be inside/);
    assert.match(await errorOf(sb.put(D, { reservedIpRanges: [{ start: '192.0.2.20', end: '192.0.2.10' }] })), /must be inside/);
    assert.match(await errorOf(sb.put(D, { dnsNameserversOption: 'custom' })), /'dnsCustomNameservers' is required/);
    const custom = await sb.put(D, { dnsNameserversOption: 'custom', dnsCustomNameservers: ['198.51.100.53'], bootOptionsEnabled: true, bootNextServer: '198.51.100.69', bootFileName: 'pxe.0' });
    assert.deepEqual(custom.body.dnsCustomNameservers, ['198.51.100.53']);
    assert.equal(custom.body.bootFileName, 'pxe.0');
    assert.deepEqual((await sb.put(D, { dhcpMode: 'dhcpDisabled' })).body, { dhcpMode: 'dhcpDisabled' });
  });

  test('static routes', async () => {
    fresh();
    const id = await makeStack();
    const R = `${S}/${id}/routing/staticRoutes`;
    const route = { name: 'Lab', subnet: '198.51.100.0/24', nextHopIp: '192.0.2.10' };
    assert.match(await errorOf(sb.post(R, route)), /must be in the subnet of a layer 3 interface/);
    await sb.post(`${S}/${id}/routing/interfaces`, GW);
    const r = await sb.post(R, route);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body, { staticRouteId: r.body.staticRouteId, name: 'Lab', subnet: '198.51.100.0/24', nextHopIp: '192.0.2.10', advertiseViaOspfEnabled: false, preferOverOspfRoutesEnabled: false });
    assert.match(await errorOf(sb.post(R, route)), /already exists/);
    const one = `${R}/${r.body.staticRouteId}`;
    const put = await sb.put(one, { managementNextHop: '192.0.2.11', advertiseViaOspfEnabled: true });
    assert.equal(put.body.managementNextHop, '192.0.2.11');
    assert.equal(put.body.advertiseViaOspfEnabled, true);
    assert.deepEqual((await sb.get(R)).body, [put.body]);
    assert.equal((await sb.del(one)).status, 204);
    assert.equal((await sb.get(one)).status, 404);
  });
});
