import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { configOf } from '../src/config.js';
import { sampleUrls, start } from './helpers.js';

describe('device provisioning', () => {
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
  const unused = async (o = org) => (await sb.get(`/organizations/${o.id}/inventory/devices?usedState=unused`)).body.map((d) => d.serial);

  test('claiming a spare puts it in the network, online and without clients', async () => {
    fresh();
    const spare = org.spares.find((s) => s.model === 'MR46');
    const r = await sb.post(`/networks/${hq.id}/devices/claim`, { serials: [spare.serial] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { serials: [spare.serial], errors: [] });
    const dev = (await sb.get(`/devices/${spare.serial}`)).body;
    assert.equal(dev.networkId, hq.id);
    assert.equal(dev.model, 'MR46');
    assert.match(dev.lanIp, /^10\.1\.1\.\d+$/);
    assert.ok((await sb.get(`/networks/${hq.id}/devices`)).body.some((d) => d.serial === spare.serial));
    const status = (await sb.get(`/organizations/${org.id}/devices/statuses?serials[]=${spare.serial}`)).body[0];
    assert.equal(status.status, 'online');
    assert.deepEqual((await sb.get(`/devices/${spare.serial}/clients`)).body, []);
    assert.ok(!(await unused()).includes(spare.serial));
    assert.match((await sb.post(`/networks/${hq.id}/devices/claim`, { serials: [spare.serial] })).body.errors[0], /already claimed/);
  });

  test('a claim is all or nothing unless addAtomically is false', async () => {
    fresh();
    const [a, b] = org.spares;
    const bad = await sb.post(`/networks/${hq.id}/devices/claim`, { serials: [a.serial, 'Q2XX-NOPE-NOPE'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.errors[0], /Q2XX-NOPE-NOPE: Device not found/);
    assert.ok((await unused()).includes(a.serial), 'nothing was claimed');
    const r = await sb.post(`/networks/${hq.id}/devices/claim?addAtomically=false`, { serials: [a.serial, b.serial, hq.aps[0].serial, lab.spares[0].serial] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.serials, [a.serial, b.serial]);
    assert.deepEqual(
      r.body.errors.map((e) => e.serial),
      [hq.aps[0].serial, lab.spares[0].serial],
    );
    assert.equal((await sb.post(`/networks/${hq.id}/devices/claim`, { serials: [] })).status, 400);
  });

  test('claiming a new kind of device adds its product type', async () => {
    fresh();
    const spare = org.spares.find((s) => s.model === 'MV22');
    // Another organization's spare counts as claimed.
    assert.equal((await sb.post(`/networks/${lab.networks[0].id}/devices/claim`, { serials: [spare.serial] })).status, 400);
    const aus = byCode('AUS');
    assert.equal((await sb.post(`/networks/${aus.id}/devices/claim`, { serials: [spare.serial.toLowerCase()] })).status, 200);
    assert.deepEqual((await sb.get(`/networks/${aus.id}`)).body.productTypes, ['appliance', 'switch', 'wireless', 'camera']);
    assert.equal((await sb.get(`/organizations/${org.id}/devices/statuses?serials[]=${spare.serial}`)).body[0].productType, 'camera');
  });

  test('removing an AP moves its clients to the other APs', async () => {
    fresh();
    const ap = hq.aps.find((a) => a.name.endsWith('Lobby'));
    const wireless = hq.clients.filter((c) => !c.wired).length;
    const r = await sb.post(`/networks/${hq.id}/devices/remove`, { serial: ap.serial });
    assert.equal(r.status, 204);
    assert.equal(r.body, '');
    assert.equal((await sb.get(`/devices/${ap.serial}`)).status, 404);
    assert.equal(hq.clients.filter((c) => !c.wired).length, wireless);
    assert.ok(hq.clients.every((c) => c.wired || hq.aps.includes(c.ap)));
    assert.ok((await unused()).includes(ap.serial));
    assert.equal((await sb.post(`/networks/${hq.id}/devices/remove`, { serial: ap.serial })).status, 404);
    // A device in another network can't be removed from this one.
    assert.equal((await sb.post(`/networks/${hq.id}/devices/remove`, { serial: byCode('AUS').aps[0].serial })).status, 404);
  });

  test('the last AP takes its clients with it, and a license stays with its device', async () => {
    fresh();
    const tor = lab.networks[0];
    for (const ap of [...tor.aps]) assert.equal((await sb.post(`/networks/${tor.id}/devices/remove`, { serial: ap.serial })).status, 204);
    assert.deepEqual((await sb.get(`/networks/${tor.id}/clients`)).body, []);
    const license = (await sb.get(`/organizations/${lab.id}/licenses?deviceSerial=${lab.licenses[0].deviceSerial}`)).body[0];
    assert.equal(license.networkId, null);
  });

  test('reads keep working after devices are removed and claimed back', async () => {
    fresh();
    const aus = byCode('AUS');
    const removed = [hq.mx, hq.switches[0], hq.aps[0], hq.cameras[0], aus.mx, byCode('RNO').cameras.find((c) => c.dormant)];
    for (const d of removed) assert.equal((await sb.post(`/networks/${d.net.id}/devices/remove`, { serial: d.serial })).status, 204, d.name);
    assert.equal(org.hub, null, 'HQ was the AutoVPN hub');
    const check = async (label) => {
      for (const { url } of sampleUrls(sb.world)) {
        const r = await sb.get(url);
        assert.ok(r.status < 500, `${label} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      for (const n of org.networks) assert.equal((await sb.get(`/networks/${n.id}/events?productType=appliance&perPage=10`)).status, 200);
    };
    await check('removed');
    const back = await sb.post(`/networks/${hq.id}/devices/claim`, { serials: removed.slice(0, 4).map((d) => d.serial) });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(hq.mx.serial, removed[0].serial);
    await check('claimed');
    const uplinks = (await sb.get(`/organizations/${org.id}/appliance/uplink/statuses?networkIds[]=${hq.id}`)).body[0].uplinks;
    assert.deepEqual(
      uplinks.map((u) => u.interface),
      ['wan1'],
    );
  });

  test('a vMX only goes into an appliance network without an MX', async () => {
    fresh();
    const net = (await sb.post(`/organizations/${org.id}/networks`, { name: 'AWS us-west-2', productTypes: ['appliance'] })).body;
    const r = await sb.post(`/networks/${net.id}/devices/claim/vmx`, { size: 'small' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.model, 'VMX-S');
    assert.equal(r.body.networkId, net.id);
    assert.match(r.body.serial, /^Q2PN-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal((await sb.get(`/devices/${r.body.serial}/managementInterface`)).body.wan1.usingStaticIp, false);
    assert.equal((await sb.get(`/networks/${net.id}/appliance/ports`)).status, 200);
    assert.match((await sb.post(`/networks/${net.id}/devices/claim/vmx`, { size: 'small' })).body.errors[0], /already has an appliance/);
    assert.equal((await sb.post(`/networks/${hq.id}/devices/claim/vmx`, { size: 'large' })).status, 400);
    assert.equal((await sb.post(`/networks/${lab.networks[0].id}/devices/claim/vmx`, { size: 'small' })).status, 400);
    assert.equal((await sb.post(`/networks/${net.id}/devices/claim/vmx`, { size: 'huge' })).status, 400);
  });

  test('a swap moves the old device out and the new one into its place', async () => {
    fresh();
    const aus = byCode('AUS');
    const ap = aus.aps[0];
    const { serial: oldSerial, name } = ap;
    const clients = (await sb.get(`/devices/${oldSerial}/clients?timespan=86400`)).body.length;
    const spare = org.spares.find((s) => s.model === 'MR46');
    const r = await sb.post(`/organizations/${org.id}/inventory/devices/swaps/bulk`, { swaps: [{ devices: { old: oldSerial, new: spare.serial }, afterAction: 'remove from network' }] });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.swaps[0].status, 'pending');
    assert.equal(r.body.swaps[0].devices.old.serial, oldSerial);
    const job = (await sb.get(`/organizations/${org.id}/inventory/devices/swaps/bulk/${r.body.jobId}`)).body;
    assert.equal(job.swaps[0].status, 'complete');
    assert.equal((await sb.get(`/devices/${oldSerial}`)).status, 404);
    const dev = (await sb.get(`/devices/${spare.serial}`)).body;
    assert.equal(dev.name, name);
    assert.equal(dev.networkId, aus.id);
    assert.equal((await sb.get(`/devices/${spare.serial}/clients?timespan=86400`)).body.length, clients);
    assert.ok((await unused()).includes(oldSerial));
    assert.equal((await sb.get(`/organizations/${org.id}/inventory/devices/swaps/bulk/1`)).status, 404);
  });

  test('a swapped switch keeps its STP priority and MTU and multicast overrides', async () => {
    fresh();
    const aus = byCode('AUS');
    const sw = aus.switches[0];
    const oldSerial = sw.serial;
    const S = `/networks/${aus.id}/switch`;
    const flags = { igmpSnoopingEnabled: false, floodUnknownMulticastTrafficEnabled: false };
    assert.equal((await sb.put(`${S}/stp`, { stpBridgePriority: [{ switches: [oldSerial], stpPriority: 4096 }] })).status, 200);
    assert.equal((await sb.put(`${S}/mtu`, { overrides: [{ switches: [oldSerial], mtuSize: 1500 }] })).status, 200);
    assert.equal((await sb.put(`${S}/routing/multicast`, { overrides: [{ switches: [oldSerial], ...flags }] })).status, 200);
    const spare = org.spares.find((s) => s.model === sw.model);
    const r = await sb.post(`/organizations/${org.id}/inventory/devices/swaps/bulk`, { swaps: [{ devices: { old: oldSerial, new: spare.serial }, afterAction: 'remove from network' }] });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal((await sb.get(`/organizations/${org.id}/inventory/devices/swaps/bulk/${r.body.jobId}`)).body.swaps[0].status, 'complete');
    assert.deepEqual((await sb.get(`${S}/stp`)).body.stpBridgePriority, [{ switches: [spare.serial], stpPriority: 4096 }]);
    assert.deepEqual((await sb.get(`${S}/mtu`)).body.overrides, [{ switches: [spare.serial], mtuSize: 1500 }]);
    assert.deepEqual((await sb.get(`${S}/routing/multicast`)).body.overrides, [{ switches: [spare.serial], ...flags }]);
  });

  test('swaps that cannot happen fail on their own', async () => {
    fresh();
    const aus = byCode('AUS');
    const lon = byCode('LON');
    const sw = org.spares.find((s) => s.model === 'MS130-24P');
    const r = await sb.post(`/organizations/${org.id}/inventory/devices/swaps/bulk`, {
      swaps: [
        { devices: { old: hq.switches[1].serial, new: sw.serial }, afterAction: 'remove from network' },
        { devices: { old: aus.aps[0].serial, new: sw.serial }, afterAction: 'remove from network' },
        { devices: { old: aus.switches[1].serial, new: aus.aps[1].serial }, afterAction: 'remove from network' },
        { devices: { old: lon.switches[0].serial, new: sw.serial }, afterAction: 'release from organization inventory' },
      ],
    });
    assert.equal(r.status, 207);
    const [model, type, inUse, ok] = r.body.swaps;
    assert.match(model.errors[0], /same model/);
    assert.match(type.errors[0], /switch device/);
    assert.match(inUse.errors[0], /already in a network/);
    assert.equal(ok.status, 'pending');
    assert.equal(lon.switches[0].serial, sw.serial);
    // Released devices leave the inventory altogether.
    const inventory = (await sb.get(`/organizations/${org.id}/inventory/devices`)).body.map((d) => d.serial);
    assert.ok(!inventory.includes(ok.devices.old.serial));
    assert.equal((await sb.post(`/organizations/${org.id}/inventory/devices/swaps/bulk`, { swaps: [] })).status, 400);
  });

  test('provisioning statuses split network devices from inventory', async () => {
    fresh();
    const all = (await sb.get(`/organizations/${org.id}/devices/provisioning/statuses`)).body;
    assert.equal(all.length, org.devices.length + org.spares.length);
    assert.equal(all.filter((d) => d.status === 'unprovisioned').length, org.spares.length);
    const spare = all.find((d) => d.serial === org.spares[0].serial);
    assert.deepEqual(spare.network, null);
    const reno = byCode('RNO');
    const rows = (await sb.get(`/organizations/${org.id}/devices/provisioning/statuses?networkIds[]=${reno.id}&productTypes[]=camera`)).body;
    assert.deepEqual(rows.map((d) => d.serial).sort(), reno.cameras.map((c) => c.serial).sort());
    assert.ok(rows.every((d) => d.status === 'complete' && d.network.id === reno.id));
    assert.equal((await sb.get(`/organizations/${org.id}/devices/provisioning/statuses?status=done`)).status, 400);
  });

  test('device details take the Catalyst detail names for devices in the org', async () => {
    fresh();
    const serials = [hq.switches[0].serial, org.spares[0].serial];
    const r = await sb.post(`/organizations/${org.id}/devices/details/bulkUpdate`, { serials, details: [{ name: 'username', value: 'admin' }, { name: 'Device Mode', value: 'monitored' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { serials });
    assert.match((await sb.post(`/organizations/${org.id}/devices/details/bulkUpdate`, { serials, details: [{ name: 'color' }] })).body.errors[0], /must be one of/);
    assert.equal((await sb.post(`/organizations/${lab.id}/devices/details/bulkUpdate`, { serials, details: [{ name: 'username' }] })).status, 400);
  });

  test('syslog servers show per-product roles, and titles on the old endpoint', async () => {
    fresh();
    assert.deepEqual((await sb.get(`/networks/${hq.id}/syslogServers`)).body.servers[0].roles, ['Appliance event log', 'Switch event log', 'Wireless event log', 'Security events', 'URLs', 'Flows']);
    const server = { host: 'syslog.example.com', port: 6514, roles: ['wirelessUrlLog', 'ApplianceEventLog'], transportProtocol: 'tcp', encryption: { enabled: true, certificate: { id: '1637' } } };
    const r = await sb.put(`/networks/${hq.id}/devices/syslog/servers`, { servers: [server] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { network: { id: hq.id }, servers: [{ ...server, roles: ['wirelessUrlLog', 'applianceEventLog'], transportProtocol: 'TCP' }] });
    assert.deepEqual((await sb.get(`/networks/${hq.id}/syslogServers`)).body, { servers: [{ host: 'syslog.example.com', port: 6514, roles: ['URLs', 'Appliance event log'] }] });
    // The old PUT keeps a server's transport and spreads a title over every product.
    await sb.put(`/networks/${hq.id}/syslogServers`, { servers: [{ host: 'syslog.example.com', port: 6514, roles: ['urls'] }] });
    assert.deepEqual(configOf(hq).syslog.servers, [{ host: 'syslog.example.com', port: 6514, roles: ['applianceUrlLog', 'wirelessUrlLog'], transportProtocol: 'TCP', encryption: { enabled: true, certificate: { id: '1637' } } }]);
    const tor = lab.networks[0];
    assert.match((await sb.put(`/networks/${tor.id}/devices/syslog/servers`, { servers: [{ host: '192.0.2.9', port: 514, roles: ['switchEventLog'] }] })).body.errors[0], /not a role on this network/);
    assert.match((await sb.put(`/networks/${tor.id}/syslogServers`, { servers: [{ host: '192.0.2.9', port: 514, roles: ['IDS alerts'] }] })).body.errors[0], /not available on this network/);
  });

  test('a static management IP becomes the LAN IP, and DHCP brings the old one back', async () => {
    fresh();
    const sw = hq.switches[1];
    const path = `/devices/${sw.serial}/managementInterface`;
    const lanIp = sw.lanIp;
    const set = await sb.put(path, { wan1: { usingStaticIp: true, staticIp: '10.1.1.200', staticSubnetMask: '255.255.255.0', staticGatewayIp: '10.1.1.1', staticDns: ['10.1.5.53'], vlan: 1 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body, { wan1: { usingStaticIp: true, staticIp: '10.1.1.200', staticSubnetMask: '255.255.255.0', staticGatewayIp: '10.1.1.1', staticDns: ['10.1.5.53'], vlan: 1 } });
    assert.equal((await sb.get(`/devices/${sw.serial}`)).body.lanIp, '10.1.1.200');
    assert.deepEqual((await sb.put(path, { wan1: { usingStaticIp: false } })).body, { wan1: { usingStaticIp: false, vlan: 1 } });
    assert.equal((await sb.get(`/devices/${sw.serial}`)).body.lanIp, lanIp);
    assert.match((await sb.put(path, { wan1: { usingStaticIp: true } })).body.errors[0], /staticIp' is required/);
    assert.match((await sb.put(path, { wan2: { usingStaticIp: false } })).body.errors[0], /only supported on MX/);
  });

  test('an MX management interface round-trips and takes a second WAN', async () => {
    fresh();
    const lon = byCode('LON');
    const path = `/devices/${lon.mx.serial}/managementInterface`;
    const before = (await sb.get(path)).body;
    assert.deepEqual((await sb.put(path, before)).body, before);
    const r = await sb.put(path, { wan2: { wanEnabled: 'enabled', usingStaticIp: false, vlan: 20 } });
    assert.deepEqual(r.body.wan2, { wanEnabled: 'enabled', usingStaticIp: false, vlan: 20 });
    assert.deepEqual(r.body.wan1, before.wan1);
    assert.deepEqual(r.body.ddnsHostnames, before.ddnsHostnames);
  });
});
