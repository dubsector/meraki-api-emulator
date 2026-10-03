import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('switch STP, MTU, storm control, link aggregation and warm spare', () => {
  let sb;
  let corp;
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
    corp = sb.world.orgs[0];
    hq = corp.networks[0];
    [core, f2, f3] = hq.switches;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const N = (net = hq) => `/networks/${net.id}/switch`;
  const stackOf = async (serials) => ok(sb.post(`${N()}/stacks`, { name: 'Floors', serials }));
  // A client-facing port, so it is free to aggregate.
  const accessPorts = (sw, n) => sw.ports.filter((p) => !p.peer && !p.isUplink).slice(0, n).map((p) => ({ serial: sw.serial, portId: p.portId }));

  test('STP starts with RSTP on and takes bridge priorities for switches and stacks', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(`${N()}/stp`)), { rstpEnabled: true, stpBridgePriority: [] });
    const stack = await stackOf([f2.serial, f3.serial]);
    const body = { rstpEnabled: false, stpBridgePriority: [{ switches: [core.serial], stpPriority: 4096 }, { stacks: [stack.id], stpPriority: 8192 }] };
    assert.deepEqual(await ok(sb.put(`${N()}/stp`, body)), body);
    assert.deepEqual(await ok(sb.get(`${N()}/stp`)), body);
    // Only rstpEnabled changes when the list is left out.
    assert.deepEqual((await ok(sb.put(`${N()}/stp`, { rstpEnabled: true }))).stpBridgePriority, body.stpBridgePriority);

    const put = (stpBridgePriority) => errorOf(sb.put(`${N()}/stp`, { stpBridgePriority }));
    assert.match(await put([{ switches: [core.serial], stpPriority: 1000 }]), /multiple of 4096/);
    assert.match(await put([{ switches: [core.serial], stpPriority: 65536 }]), /multiple of 4096/);
    assert.match(await put([{ switches: [f2.serial], stpPriority: 4096 }]), /list the stack instead/);
    assert.match(await put([{ switches: ['Q2XX-0000-0000'], stpPriority: 4096 }]), /not in this network/);
    assert.match(await put([{ stacks: ['123'], stpPriority: 4096 }]), /does not exist/);
    assert.match(await put([{ switches: [core.serial], stpPriority: 0 }, { switches: [core.serial], stpPriority: 4096 }]), /more than one entry/);
    assert.match(await put([{ switchProfiles: ['1098'], stpPriority: 4096 }]), /config template networks/);
    assert.match(await put([{ stpPriority: 4096 }]), /needs at least one/);

    // A deleted stack drops out of its entry, and the empty entry goes.
    await ok(sb.del(`${N()}/stacks/${stack.id}`), 204);
    assert.deepEqual((await ok(sb.get(`${N()}/stp`))).stpBridgePriority, [{ switches: [core.serial], stpPriority: 4096 }]);
  });

  test('MTU has a network default and per-switch overrides', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(`${N()}/mtu`)), { defaultMtuSize: 9578, overrides: [] });
    const body = { defaultMtuSize: 9000, overrides: [{ switches: [core.serial, f2.serial], mtuSize: 1500 }] };
    assert.deepEqual(await ok(sb.put(`${N()}/mtu`, body)), body);
    assert.deepEqual(await ok(sb.put(`${N()}/mtu`, { overrides: [] })), { defaultMtuSize: 9000, overrides: [] });

    assert.match(await errorOf(sb.put(`${N()}/mtu`, { defaultMtuSize: 10000 })), /between 1280 and 9578/);
    assert.match(await errorOf(sb.put(`${N()}/mtu`, { overrides: [{ switches: [core.serial], mtuSize: 100 }] })), /overrides\[0\]\.mtuSize/);
    assert.match(await errorOf(sb.put(`${N()}/mtu`, { overrides: [{ switches: [core.serial] }] })), /mtuSize' is required/);
    assert.match(await errorOf(sb.put(`${N()}/mtu`, { overrides: [{ switchProfiles: ['1'], mtuSize: 1500 }] })), /config template networks/);
    // A failed write changes nothing.
    assert.equal((await ok(sb.get(`${N()}/mtu`))).defaultMtuSize, 9000);
  });

  test('storm control thresholds, grouped traffic types and bad input', async () => {
    fresh();
    const S = `${N()}/stormControl`;
    assert.deepEqual(await ok(sb.get(S)), { broadcastThreshold: 100, multicastThreshold: 100, unknownUnicastThreshold: 100, treatTheseTrafficTypesAsOneThreshold: [] });
    const body = { broadcastThreshold: 30, multicastThreshold: 30, unknownUnicastThreshold: 50, treatTheseTrafficTypesAsOneThreshold: ['broadcast', 'multicast'] };
    assert.deepEqual(await ok(sb.put(S, body)), body);
    assert.match(await errorOf(sb.put(S, { multicastThreshold: 40 })), /same threshold/);
    assert.match(await errorOf(sb.put(S, { broadcastThreshold: 0 })), /between 1 and 100/);
    assert.match(await errorOf(sb.put(S, { treatTheseTrafficTypesAsOneThreshold: ['broadcast'] })), /at least two/);
    assert.match(await errorOf(sb.put(S, { treatTheseTrafficTypesAsOneThreshold: ['broadcast', 'broadcast'] })), /more than once/);
    assert.match(await errorOf(sb.put(S, { treatTheseTrafficTypesAsOneThreshold: ['broadcast', 'anycast'] })), /must only hold/);
    // 100 percent clears a threshold; ungrouping lets the thresholds differ again.
    const cleared = await ok(sb.put(S, { broadcastThreshold: 100, treatTheseTrafficTypesAsOneThreshold: [] }));
    assert.deepEqual(cleared, { ...body, broadcastThreshold: 100, treatTheseTrafficTypesAsOneThreshold: [] });
  });

  test('STP, MTU and storm control come from the template on a bound network', async () => {
    fresh();
    const austin = corp.networks[1];
    const t = await ok(sb.post(`/organizations/${corp.id}/configTemplates`, { name: 'HQ', copyFromNetworkId: hq.id }), 201);
    await ok(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id, autoBind: false }));
    for (const p of ['stp', 'mtu', 'stormControl']) {
      assert.equal((await sb.get(`${N(austin)}/${p}`)).status, 200);
      assert.match(await errorOf(sb.put(`${N(austin)}/${p}`, {})), /bound to a config template/);
    }
    // Link aggregations name the network's own ports, so they stay writable.
    assert.equal((await sb.post(`${N(austin)}/linkAggregations`, { switchPorts: accessPorts(austin.switches[0], 2) })).status, 201);
  });

  test('the alternate management interface checks VLANs, protocols and addresses', async () => {
    fresh();
    const A = `${N()}/alternateManagementInterface`;
    assert.deepEqual(await ok(sb.get(A)), { enabled: false, useOobMgmt: false, vlanId: null, protocols: [], switches: [] });
    const body = {
      enabled: true,
      vlanId: 10,
      protocols: ['syslog', 'radius'],
      switches: [
        { serial: f2.serial, alternateManagementIp: '10.1.10.20' },
        { serial: core.serial, alternateManagementIp: '10.1.10.21', subnetMask: '255.255.255.0', gateway: '10.1.10.1' },
      ],
    };
    const got = await ok(sb.put(A, body));
    assert.deepEqual(got, {
      enabled: true,
      useOobMgmt: false,
      vlanId: 10,
      protocols: ['radius', 'syslog'],
      switches: [
        { serial: f2.serial, alternateManagementIp: '10.1.10.20', subnetMask: null, gateway: null },
        { serial: core.serial, alternateManagementIp: '10.1.10.21', subnetMask: '255.255.255.0', gateway: '10.1.10.1' },
      ],
    });
    // Switches stay when left out; an empty address removes one.
    assert.equal((await ok(sb.put(A, { protocols: ['snmp'] }))).switches.length, 2);
    assert.deepEqual((await ok(sb.put(A, { switches: [{ serial: f2.serial, alternateManagementIp: '' }] }))).switches, []);

    const put = (b) => errorOf(sb.put(A, b));
    const sw = (s) => ({ switches: [{ serial: f2.serial, alternateManagementIp: '10.1.10.30', ...s }] });
    assert.match(await put(sw({ alternateManagementIp: '10.9.9.9' })), /VLAN 10's subnet/);
    assert.match(await put(sw({ alternateManagementIp: '10.1.10.1' })), /MX's address/);
    assert.match(await put(sw({ alternateManagementIp: 'nope' })), /IPv4 address/);
    assert.match(await put(sw({ subnetMask: '255.0.255.0' })), /subnet mask/);
    assert.match(await put(sw({ subnetMask: '255.255.255.0', gateway: '10.1.11.1' })), /same subnet/);
    assert.match(await put({ switches: [{ serial: core.serial, alternateManagementIp: '10.1.10.30' }] }), /need 'subnetMask' and 'gateway'/);
    assert.match(await put({ switches: [{ serial: 'Q2XX-0000-0000', alternateManagementIp: '10.1.10.30' }] }), /not in this network/);
    assert.match(await put(sw({ alternateManagementIp: f3.lanIp })), /LAN address/);
    const twice = [{ serial: f2.serial, alternateManagementIp: '10.1.10.30' }, { serial: f3.serial, alternateManagementIp: '10.1.10.30' }];
    assert.match(await put({ switches: twice }), /more than one switch/);
    assert.match(await put({ vlanId: 0 }), /between 1 and 4094/);
    assert.match(await put({ protocols: ['snmp', 'snmp'] }), /more than once/);

    // Enabling needs a VLAN and at least one protocol.
    await ok(sb.put(A, { enabled: false, protocols: [] }));
    assert.match(await put({ enabled: true }), /must be set to enable/);
  });

  test('link aggregations take 2 to 8 free ports of one switch or stack', async () => {
    fresh();
    const L = `${N()}/linkAggregations`;
    assert.deepEqual(await ok(sb.get(L)), []);
    const ports = accessPorts(core, 2);
    const g = await ok(sb.post(L, { switchPorts: ports }), 201);
    assert.match(g.id, /^[A-Za-z0-9]+=*$/);
    assert.deepEqual(g.switchPorts, ports);
    assert.deepEqual(await ok(sb.get(L)), [g]);

    const post = (switchPorts) => errorOf(sb.post(L, { switchPorts }));
    assert.match(await post(ports), /already in a link aggregation/);
    assert.match(await post(accessPorts(core, 3).slice(2)), /2 to 8 ports/);
    assert.match(await post(accessPorts(core, 11).slice(2)), /2 to 8 ports/);
    const toMx = core.ports.find((p) => p.peer?.device.productType === 'appliance');
    assert.match(await post([{ serial: core.serial, portId: toMx.portId }, ...accessPorts(core, 3).slice(2)]), /uplink to the MX/);
    assert.match(await post([...accessPorts(f2, 1), ...accessPorts(f3, 1)]), /one switch or one switch stack/);
    assert.match(await post([{ serial: core.serial, portId: '99' }, ...accessPorts(core, 3).slice(2)]), /does not exist/);
    const dup = accessPorts(core, 3)[2];
    assert.match(await post([dup, dup]), /only be listed once/);
    assert.match(await errorOf(sb.post(L, { switchProfilePorts: [{ profile: '1', portId: '1' }, { profile: '1', portId: '2' }] })), /config template networks/);
    assert.match(await errorOf(sb.post(L, {})), /exactly one/);

    // Ports across a stack's members are fine.
    const stack = await stackOf([f2.serial, f3.serial]);
    const cross = await ok(sb.post(L, { switchPorts: [...accessPorts(f2, 1), ...accessPorts(f3, 1)] }), 201);
    assert.notEqual(cross.id, g.id);

    // An update can keep its own ports; a delete frees them.
    const moved = [...ports.slice(1), ...accessPorts(core, 3).slice(2)];
    assert.deepEqual((await ok(sb.put(`${L}/${g.id}`, { switchPorts: moved }))).switchPorts, moved);
    assert.equal((await sb.put(`${L}/nope`, { switchPorts: moved })).status, 404);
    await ok(sb.del(`${L}/${g.id}`), 204);
    assert.equal((await sb.del(`${L}/${g.id}`)).status, 404);
    assert.equal((await sb.post(L, { switchPorts: ports })).status, 201);

    // A switch leaving the network takes its ports, and a group left with one port splits.
    await ok(sb.del(`${N()}/stacks/${stack.id}`), 204);
    await ok(sb.post(`/networks/${hq.id}/devices/remove`, { serial: f3.serial }), 204);
    assert.equal((await ok(sb.get(L))).some((x) => x.id === cross.id), false);
  });

  test('warm spare pairs two lone routing switches of one model', async () => {
    fresh();
    const W = (dev) => `/devices/${dev.serial}/switch/warmSpare`;
    assert.deepEqual(await ok(sb.get(W(f2))), { enabled: false, primarySerial: f2.serial });
    await ok(sb.post(`/devices/${f3.serial}/switch/routing/interfaces`, { name: 'Users', vlanId: 10, subnet: '192.0.2.0/25', interfaceIp: '192.0.2.2', defaultGateway: '192.0.2.1' }), 201);
    const pair = { enabled: true, primarySerial: f2.serial, spareSerial: f3.serial };
    assert.deepEqual(await ok(sb.put(W(f2), { enabled: true, spareSerial: f3.serial })), pair);
    assert.deepEqual(await ok(sb.get(W(f3))), pair);
    // The spare's own layer 3 settings are gone, and it takes none of its own.
    assert.match(await errorOf(sb.get(`/devices/${f3.serial}/switch/routing/interfaces`)), /warm spare for/);
    assert.match(await errorOf(sb.put(W(f3), { enabled: false })), /change it on the primary/);
    assert.match(await errorOf(sb.post(`${N()}/stacks`, { name: 'S', serials: [f2.serial, f3.serial] })), /warm spare pair/);
    // Enabling again keeps the spare.
    assert.deepEqual(await ok(sb.put(W(f2), { enabled: true })), pair);

    assert.match(await errorOf(sb.put(W(core), { enabled: true, spareSerial: f2.serial })), /same model/);
    assert.match(await errorOf(sb.put(W(core), { enabled: true })), /spareSerial' is required/);
    assert.match(await errorOf(sb.put(W(f2), { enabled: true, spareSerial: f2.serial })), /must not be the primary/);
    assert.match(await errorOf(sb.put(W(core), { enabled: true, spareSerial: 'Q2XX-0000-0000' })), /not a switch in this network/);
    const austin = corp.networks[1];
    assert.match(await errorOf(sb.put(W(austin.switches[0]), { enabled: true, spareSerial: austin.switches[1].serial })), /do not support warm spare/);
    assert.match(await errorOf(sb.get(`/devices/${hq.mx.serial}/switch/warmSpare`)), /only supported for switch/);

    assert.deepEqual(await ok(sb.put(W(f2), { enabled: false })), { enabled: false, primarySerial: f2.serial });
    assert.deepEqual(await ok(sb.get(W(f3))), { enabled: false, primarySerial: f3.serial });
    // A spare that leaves the network ends the pair.
    await ok(sb.put(W(f2), { enabled: true, spareSerial: f3.serial }));
    await ok(sb.post(`/networks/${hq.id}/devices/remove`, { serial: f3.serial }), 204);
    assert.deepEqual(await ok(sb.get(W(f2))), { enabled: false, primarySerial: f2.serial });
  });

  test('link aggregations and the alternate management interface follow split and combine', async () => {
    fresh();
    const g = await ok(sb.post(`${N()}/linkAggregations`, { switchPorts: accessPorts(core, 2) }), 201);
    const ami = await ok(sb.put(`${N()}/alternateManagementInterface`, { enabled: true, vlanId: 10, protocols: ['snmp'], switches: [{ serial: f2.serial, alternateManagementIp: '10.1.10.20' }] }));
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const part = parts.find((n) => n.productTypes[0] === 'switch');
    assert.deepEqual(await ok(sb.get(`/networks/${part.id}/switch/linkAggregations`)), [g]);
    assert.deepEqual(await ok(sb.get(`/networks/${part.id}/switch/alternateManagementInterface`)), ami);
    const net = (await ok(sb.post(`/organizations/${corp.id}/networks/combine`, { name: hq.name, networkIds: parts.map((n) => n.id) }))).resultingNetwork;
    assert.deepEqual(await ok(sb.get(`/networks/${net.id}/switch/linkAggregations`)), [g]);
    assert.deepEqual(await ok(sb.get(`/networks/${net.id}/switch/alternateManagementInterface`)), ami);
  });
});
