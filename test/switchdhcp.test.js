import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('switch DHCP guard, ARP inspection, port schedules and clone', () => {
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
  const P = (sw, port) => `/devices/${sw.serial}/switch/ports/${port}`;
  const POLICY = () => `${N()}/dhcpServerPolicy`;
  const TRUSTED = () => `${POLICY()}/arpInspection/trustedServers`;
  const WARNINGS = (net = hq) => `${N(net)}/dhcpServerPolicy/arpInspection/warnings/byDevice`;
  const CLONE = () => `/organizations/${corp.id}/switch/devices/clone`;

  test('the DHCP server policy starts open and always allows the MX and switches', async () => {
    fresh();
    const p = await ok(sb.get(POLICY()));
    assert.deepEqual(p.alerts, { email: { enabled: false } });
    assert.deepEqual([p.defaultPolicy, p.allowedServers, p.blockedServers, p.arpInspection.enabled], ['allow', [], [], false]);
    assert.deepEqual(p.alwaysAllowedServers, [hq.mx.mac, ...[core, f2, f3].sort((a, b) => a.serial.localeCompare(b.serial)).map((d) => d.mac)]);
    assert.ok(p.arpInspection.unsupportedModels.includes('MS120-8LP'));
    // Servers seen reports the MX, which the policy can't block.
    const seen = await ok(sb.get(`${N()}/dhcp/v4/servers/seen`));
    assert.ok(seen.every((s) => p.alwaysAllowedServers.includes(s.mac) && s.isAllowed));

    const body = { alerts: { email: { enabled: true } }, defaultPolicy: 'block', allowedServers: ['00:50:56:00:00:01'], blockedServers: ['00:50:56:00:00:03'], arpInspection: { enabled: true } };
    const put = await ok(sb.put(POLICY(), body));
    assert.deepEqual([put.alerts, put.defaultPolicy, put.allowedServers, put.blockedServers, put.arpInspection.enabled], [body.alerts, 'block', body.allowedServers, body.blockedServers, true]);
    // MACs come back lower case, and a list left out stays.
    const next = await ok(sb.put(POLICY(), { allowedServers: ['00:50:56:AA:00:01'] }));
    assert.deepEqual([next.allowedServers, next.blockedServers, next.defaultPolicy], [['00:50:56:aa:00:01'], body.blockedServers, 'block']);
    assert.deepEqual((await ok(sb.put(POLICY(), { blockedServers: [] }))).blockedServers, []);

    assert.match(await errorOf(sb.put(POLICY(), { blockedServers: ['nope'] })), /MAC addresses/);
    assert.match(await errorOf(sb.put(POLICY(), { allowedServers: ['00:50:56:00:00:01', '00:50:56:00:00:01'] })), /more than once/);
    assert.match(await errorOf(sb.put(POLICY(), { blockedServers: [core.mac] })), /always allowed/);
    assert.match(await errorOf(sb.put(POLICY(), { defaultPolicy: 'maybe' })), /defaultPolicy/);
    const lab = sb.world.orgs.find((o) => o !== corp).networks[0];
    assert.equal((await sb.get(`/networks/${lab.id}/switch/dhcpServerPolicy`)).status, 400);
  });

  test('trusted servers are created, updated, paged and deleted', async () => {
    fresh();
    const a = await ok(sb.post(TRUSTED(), { mac: '00:11:22:33:44:AA', vlan: 100, ipv4: { address: '10.0.0.5' } }), 201);
    assert.match(a.trustedServerId, /^\d+$/);
    assert.deepEqual(a, { trustedServerId: a.trustedServerId, mac: '00:11:22:33:44:aa', vlan: 100, ipv4: { address: '10.0.0.5' } });
    const b = await ok(sb.post(TRUSTED(), { mac: '00:11:22:33:44:aa', vlan: 200, ipv4: { address: '10.0.0.6' } }), 201);
    const c = await ok(sb.post(TRUSTED(), { mac: '00:11:22:33:44:bb', vlan: 200, ipv4: { address: '10.0.0.7' } }), 201);
    assert.deepEqual(await ok(sb.get(TRUSTED())), [a, b, c]);
    const page = await sb.get(`${TRUSTED()}?perPage=3`);
    assert.equal(page.body.length, 3);
    assert.match(page.link, /rel=first/);

    const moved = await ok(sb.put(`${TRUSTED()}/${a.trustedServerId}`, { vlan: 300, ipv4: { address: '10.0.0.9' } }));
    assert.deepEqual(moved, { ...a, vlan: 300, ipv4: { address: '10.0.0.9' } });

    const post = (body) => errorOf(sb.post(TRUSTED(), body));
    assert.match(await post({ mac: '00:11:22:33:44:aa', vlan: 200, ipv4: { address: '10.0.0.1' } }), /already a trusted server/);
    assert.match(await post({ mac: 'zz', vlan: 1, ipv4: { address: '10.0.0.1' } }), /MAC address/);
    assert.match(await post({ mac: '00:11:22:33:44:cc', vlan: 4095, ipv4: { address: '10.0.0.1' } }), /4094/);
    assert.match(await post({ mac: '00:11:22:33:44:cc', vlan: 1, ipv4: {} }), /'ipv4.address' is required/);
    assert.match(await post({ mac: '00:11:22:33:44:cc', vlan: 1, ipv4: { address: 'x' } }), /IPv4 address/);
    assert.match(await post({ vlan: 1, ipv4: { address: '10.0.0.1' } }), /'mac' is required/);
    assert.match(await errorOf(sb.put(`${TRUSTED()}/${c.trustedServerId}`, { vlan: 200, mac: '00:11:22:33:44:aa' })), /already a trusted server/);

    await ok(sb.del(`${TRUSTED()}/${b.trustedServerId}`), 204);
    assert.equal((await sb.del(`${TRUSTED()}/${b.trustedServerId}`)).status, 404);
    assert.deepEqual(await ok(sb.get(TRUSTED())), [moved, c]);
  });

  test('ARP inspection warns about switches without a trusted port or support', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(WARNINGS())), []);
    await ok(sb.put(POLICY(), { arpInspection: { enabled: true } }));
    // The core's port to the MX is trusted; the floor switches hang off the core.
    const rows = await ok(sb.get(WARNINGS()));
    assert.deepEqual(rows.map((r) => r.serial), [f2, f3].map((d) => d.serial).sort());
    assert.deepEqual(Object.keys(rows[0]), ['serial', 'name', 'url', 'supportsInspection', 'hasTrustedPort']);
    assert.ok(rows.every((r) => r.supportsInspection && !r.hasTrustedPort));
    await ok(sb.put(P(f2, 1), { daiTrusted: true }));
    assert.deepEqual((await ok(sb.get(WARNINGS()))).map((r) => r.serial), [f3.serial]);

    // Denver's MS120 can't inspect at all, so it never has a trusted port.
    const denver = corp.networks.find((n) => n.name.startsWith('Retail'));
    await ok(sb.put(`${N(denver)}/dhcpServerPolicy`, { arpInspection: { enabled: true } }));
    const [ms120] = await ok(sb.get(WARNINGS(denver)));
    assert.deepEqual([ms120.serial, ms120.supportsInspection, ms120.hasTrustedPort], [denver.switches[0].serial, false, false]);
  });

  test('port schedules fill in missing days and check their times', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(`${N()}/portSchedules`)), []);
    const s = await ok(sb.post(`${N()}/portSchedules`, { name: 'Weekdays', portSchedule: { monday: { from: '9:00', to: '17:00' }, saturday: { active: false } } }), 201);
    assert.deepEqual([s.networkId, s.name], [hq.id, 'Weekdays']);
    assert.deepEqual(s.portSchedule.monday, { active: true, from: '9:00', to: '17:00' });
    assert.deepEqual(s.portSchedule.saturday, { active: false, from: '00:00', to: '24:00' });
    assert.deepEqual(s.portSchedule.sunday, { active: true, from: '00:00', to: '24:00' });
    // A day given on update merges over the day it had.
    const u = await ok(sb.put(`${N()}/portSchedules/${s.id}`, { name: 'Office', portSchedule: { monday: { to: '18:30' } } }));
    assert.deepEqual([u.name, u.portSchedule.monday], ['Office', { active: true, from: '9:00', to: '18:30' }]);
    assert.deepEqual(await ok(sb.get(`${N()}/portSchedules`)), [u]);

    const post = (body) => errorOf(sb.post(`${N()}/portSchedules`, body));
    assert.match(await post({ portSchedule: {} }), /'name' is required/);
    assert.match(await post({ name: 'Office' }), /already exists/);
    assert.match(await post({ name: 'x', portSchedule: { monday: { from: '9:15' } } }), /30 minute/);
    assert.match(await post({ name: 'x', portSchedule: { monday: { from: '25:00' } } }), /from '00:00' to '24:00'/);
    assert.match(await post({ name: 'x', portSchedule: { monday: { from: 'nine' } } }), /from '00:00' to '24:00'/);
    assert.match(await post({ name: 'x', portSchedule: { monday: { from: '17:00', to: '9:00' } } }), /earlier than/);
    assert.match(await errorOf(sb.put(`${N()}/portSchedules/${s.id}`, { portSchedule: { monday: { from: '19:00' } } })), /earlier than/);
    assert.equal((await sb.put(`${N()}/portSchedules/123`, { name: 'y' })).status, 404);
  });

  test('ports take schedules that exist and schedules in use cannot be deleted', async () => {
    fresh();
    const s = await ok(sb.post(`${N()}/portSchedules`, { name: 'Nights' }), 201);
    assert.equal((await ok(sb.get(P(f2, 10)))).schedule, undefined);
    const port = await ok(sb.put(P(f2, 10), { portScheduleId: s.id }));
    assert.deepEqual([port.portScheduleId, port.schedule], [s.id, { id: s.id, name: 'Nights' }]);
    // A rename shows on the port.
    await ok(sb.put(`${N()}/portSchedules/${s.id}`, { name: 'Overnight' }));
    assert.equal((await ok(sb.get(P(f2, 10)))).schedule.name, 'Overnight');
    assert.match(await errorOf(sb.put(P(f2, 11), { portScheduleId: '999' })), /does not exist/);
    // A schedule from another network doesn't count.
    const austin = corp.networks[1];
    const other = await ok(sb.post(`${N(austin)}/portSchedules`, { name: 'Elsewhere' }), 201);
    assert.match(await errorOf(sb.put(P(f2, 11), { portScheduleId: other.id })), /does not exist/);

    assert.match(await errorOf(sb.del(`${N()}/portSchedules/${s.id}`)), new RegExp(`${f2.serial}/10`));
    const cleared = await ok(sb.put(P(f2, 10), { portScheduleId: null }));
    assert.deepEqual([cleared.portScheduleId, cleared.schedule], [null, undefined]);
    await ok(sb.del(`${N()}/portSchedules/${s.id}`), 204);
    assert.deepEqual(await ok(sb.get(`${N()}/portSchedules`)), []);
  });

  test('bound networks refuse DHCP policy and schedule writes', async () => {
    fresh();
    const [, austin] = corp.networks;
    const t = await ok(sb.post(`/organizations/${corp.id}/configTemplates`, { name: 'Branch', copyFromNetworkId: austin.id }), 201);
    await ok(sb.post(`/networks/${austin.id}/bind`, { configTemplateId: t.id }));
    assert.equal((await sb.get(`${N(austin)}/dhcpServerPolicy`)).status, 200);
    assert.match(await errorOf(sb.put(`${N(austin)}/dhcpServerPolicy`, { defaultPolicy: 'block' })), /template/);
    assert.match(await errorOf(sb.post(`${N(austin)}/portSchedules`, { name: 'x' })), /template/);
    assert.match(await errorOf(sb.post(`${N(austin)}/dhcpServerPolicy/arpInspection/trustedServers`, { mac: '00:11:22:33:44:55', vlan: 1, ipv4: { address: '10.0.0.1' } })), /template/);
    // Profile ports check schedules against the template, which has none.
    const [profile] = await ok(sb.get(`/organizations/${corp.id}/configTemplates/${t.id}/switch/profiles`));
    assert.match(await errorOf(sb.put(`/organizations/${corp.id}/configTemplates/${t.id}/switch/profiles/${profile.switchProfileId}/ports/5`, { portScheduleId: '1' })), /does not exist/);
    // Clone refuses switches on bound networks.
    assert.match(await errorOf(sb.post(CLONE(), { sourceSerial: austin.switches[0].serial, targetSerials: [austin.switches[1].serial] })), /bound to a config template/);
  });

  test('clone copies ports and per-switch settings onto the targets', async () => {
    fresh();
    const s = await ok(sb.post(`${N()}/portSchedules`, { name: 'Nights' }), 201);
    await ok(sb.put(P(f2, 10), { name: 'Desk', vlan: 55, portScheduleId: s.id, daiTrusted: true, poeEnabled: false }));
    await ok(sb.put(`${N()}/stp`, { stpBridgePriority: [{ switches: [f2.serial], stpPriority: 8192 }] }));
    await ok(sb.put(`${N()}/mtu`, { overrides: [{ switches: [f2.serial], mtuSize: 1500 }] }));
    await ok(sb.put(`${N()}/routing/multicast`, { overrides: [{ switches: [f3.serial], igmpSnoopingEnabled: false, floodUnknownMulticastTrafficEnabled: false }] }));
    const ports = f2.ports.filter((p) => !p.peer && !p.isUplink).slice(0, 2).map((p) => ({ serial: f2.serial, portId: p.portId }));
    await ok(sb.post(`${N()}/linkAggregations`, { switchPorts: ports }), 201);

    const r = await ok(sb.post(CLONE(), { sourceSerial: f2.serial, targetSerials: [f3.serial] }));
    assert.deepEqual(r, { sourceSerial: f2.serial, targetSerials: [f3.serial] });
    const port = await ok(sb.get(P(f3, 10)));
    assert.deepEqual([port.name, port.vlan, port.portScheduleId, port.daiTrusted, port.poeEnabled], ['Desk', 55, s.id, true, false]);
    assert.deepEqual((await ok(sb.get(`${N()}/stp`))).stpBridgePriority, [{ switches: [f2.serial, f3.serial], stpPriority: 8192 }]);
    assert.deepEqual((await ok(sb.get(`${N()}/mtu`))).overrides, [{ switches: [f2.serial, f3.serial], mtuSize: 1500 }]);
    // The source has no multicast override, so the target loses its own.
    assert.deepEqual((await ok(sb.get(`${N()}/routing/multicast`))).overrides, []);
    const groups = await ok(sb.get(`${N()}/linkAggregations`));
    assert.deepEqual(groups.map((g) => g.switchPorts), [ports, ports.map((p) => ({ ...p, serial: f3.serial }))]);
    // The schedule is now used on both switches.
    assert.match(await errorOf(sb.del(`${N()}/portSchedules/${s.id}`)), /ports/);
  });

  test('clone across networks drops references and checks its switches', async () => {
    fresh();
    const [, austin, , , london] = corp.networks;
    const [a1, a2] = austin.switches;
    const s = await ok(sb.post(`${N(austin)}/portSchedules`, { name: 'Nights' }), 201);
    await ok(sb.put(P(a1, 5), { name: 'Kiosk', portScheduleId: s.id }));
    await ok(sb.post(CLONE(), { sourceSerial: a1.serial, targetSerials: [london.switches[0].serial, a2.serial] }));
    const far = await ok(sb.get(P(london.switches[0], 5)));
    assert.deepEqual([far.name, far.portScheduleId, far.schedule], ['Kiosk', null, undefined]);
    assert.equal((await ok(sb.get(P(a2, 5)))).portScheduleId, s.id);

    const before = await ok(sb.get(P(f3, 10)));
    const clone = (body) => errorOf(sb.post(CLONE(), body));
    assert.match(await clone({ sourceSerial: 'Q2XX-0000-0000', targetSerials: [f2.serial] }), /not a switch/);
    assert.match(await clone({ sourceSerial: hq.mx.serial, targetSerials: [f2.serial] }), /not a switch/);
    assert.match(await clone({ sourceSerial: f2.serial, targetSerials: [] }), /at least one/);
    assert.match(await clone({ sourceSerial: f2.serial, targetSerials: [f3.serial, f3.serial] }), /more than once/);
    assert.match(await clone({ sourceSerial: f2.serial, targetSerials: [f2.serial] }), /source switch/);
    assert.match(await clone({ sourceSerial: f2.serial, targetSerials: [a1.serial] }), /MS250 switches/);
    assert.match(await clone({ sourceSerial: f2.serial, targetSerials: [f3.serial, 'Q2XX-0000-0000'] }), /not a switch/);
    // A refused clone changes nothing.
    assert.deepEqual(await ok(sb.get(P(f3, 10))), before);
    assert.equal((await sb.post(`/organizations/${corp.id}/switch/devices/clone`, { sourceSerial: f2.serial })).status, 400);
  });
});
