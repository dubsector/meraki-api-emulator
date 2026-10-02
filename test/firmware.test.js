import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, collect, start } from './helpers.js';

const DAY = 86400;
const HOUR = 3600;
const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';

describe('firmware upgrades', () => {
  let sb;
  let hq;
  let F;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    hq = sb.world.orgs[0].networks[0];
    F = `/networks/${hq.id}/firmwareUpgrades`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };

  test('putting back what GET returned changes nothing', async () => {
    fresh();
    const before = (await sb.get(F)).body;
    const r = await sb.put(F, before);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, before);
    assert.deepEqual((await sb.get(F)).body, before);
  });

  test('schedules an upgrade for the next upgrade window', async () => {
    fresh();
    const { body: cur } = await sb.get(F);
    const beta = cur.products.wireless.availableVersions[0];
    const r = await sb.put(F, { upgradeWindow: { dayOfWeek: 'saturday', hourOfDay: '3:00' }, products: { wireless: { nextUpgrade: { toVersion: { id: beta.id } } } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.upgradeWindow, { dayOfWeek: 'sat', hourOfDay: '3:00' });
    // NOW is Tuesday 11:30 in San Francisco, so the window is Saturday 3:00 PDT.
    assert.deepEqual(r.body.products.wireless.nextUpgrade, { time: '2026-10-03T10:00:00Z', strategy: 'minimizeUpgradeTime', predownload: { enabled: false }, toVersion: beta });
    assert.deepEqual(r.body.products.switch.nextUpgrade, { time: '', toVersion: {} });

    const s = await sb.put(F, { products: { switch: { nextUpgrade: { time: at(DAY), toVersion: { id: cur.products.switch.availableVersions[0].id } } }, wireless: { nextUpgrade: { strategy: 'minimizeClientDowntime', predownload: { enabled: true } } } } });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.products.switch.nextUpgrade, { time: at(DAY), toVersion: cur.products.switch.availableVersions[0] });
    assert.equal(s.body.products.wireless.nextUpgrade.strategy, 'minimizeClientDowntime');
    assert.equal(s.body.products.wireless.nextUpgrade.predownload.enabled, true);
    assert.equal(s.body.products.wireless.nextUpgrade.time, '2026-10-03T10:00:00Z');

    // Moving the time keeps the version; naming the current version cancels.
    const m = await sb.put(F, { products: { wireless: { nextUpgrade: { time: at(2 * DAY) } }, switch: { nextUpgrade: { toVersion: { id: cur.products.switch.currentVersion.id } } } } });
    assert.equal(m.body.products.wireless.nextUpgrade.time, at(2 * DAY));
    assert.equal(m.body.products.wireless.nextUpgrade.toVersion.id, beta.id);
    assert.deepEqual(m.body.products.switch.nextUpgrade, { time: '', toVersion: {} });

    // A full round trip with an upgrade scheduled is still a no-op.
    assert.deepEqual((await sb.put(F, m.body)).body, m.body);
  });

  test('checks products, versions and times, and changes nothing on error', async () => {
    fresh();
    const { body: cur } = await sb.get(F);
    const beta = cur.products.appliance.availableVersions[0].id;
    assert.match(await errorOf(sb.put(F, { products: { appliance: { nextUpgrade: { toVersion: { id: '1' } } } } })), /not one of the appliance firmware versions/);
    assert.match(await errorOf(sb.put(F, { products: { appliance: { nextUpgrade: { toVersion: { id: cur.products.appliance.lastUpgrade.fromVersion.id } } } } })), /rollbacks/);
    assert.match(await errorOf(sb.put(F, { products: { appliance: { nextUpgrade: { time: at(-60), toVersion: { id: beta } } } } })), /must be in the future/);
    assert.match(await errorOf(sb.put(F, { products: { appliance: { nextUpgrade: { time: at(DAY) } } } })), /toVersion.id' is required/);
    assert.match(await errorOf(sb.put(F, { timezone: 'Mars/Olympus' })), /not a valid time zone/);
    assert.match(await errorOf(sb.put(F, { upgradeWindow: { dayOfWeek: 'someday' } })), /dayOfWeek' must be one of/);
    const tor = sb.world.orgs[1].networks[0];
    assert.match(await errorOf(sb.put(`/networks/${tor.id}/firmwareUpgrades`, { products: { switch: { participateInNextBetaRelease: true } } })), /no switch devices/);
    // The appliance part is fine, but the camera part isn't, so neither is stored.
    assert.match(await errorOf(sb.put(F, { products: { appliance: { nextUpgrade: { toVersion: { id: beta } } }, camera: { nextUpgrade: { toVersion: { id: '1' } } } } })), /camera/);
    assert.deepEqual((await sb.get(F)).body, cur);
  });

  test('a scheduled upgrade counts as done once its time passes', async () => {
    fresh();
    const { body: cur } = await sb.get(F);
    const beta = cur.products.camera.availableVersions[0];
    await sb.put(F, { products: { camera: { nextUpgrade: { time: at(HOUR), toVersion: { id: beta.id } } } } });
    hq.firmware.products.camera.next.time = T - 60;
    const cam = (await sb.get(F)).body.products.camera;
    assert.deepEqual(cam.currentVersion, beta);
    assert.deepEqual(cam.lastUpgrade, { time: at(-60), fromVersion: cur.products.camera.currentVersion, toVersion: beta });
    assert.deepEqual(cam.nextUpgrade, { time: '', toVersion: {} });
    assert.equal(cam.isUpgradeAvailable, false);
    assert.deepEqual(cam.availableVersions, []);
  });

  test('rolls back a product', async () => {
    fresh();
    const R = `${F}/rollbacks`;
    const reasons = [{ category: 'performance', comment: 'Slower since the upgrade' }];
    assert.match(await errorOf(sb.post(R, { reasons })), /'product' is required/);
    assert.match(await errorOf(sb.post(R, { product: 'cellularGateway', reasons })), /no cellularGateway devices/);
    assert.match(await errorOf(sb.post(R, { product: 'switch' })), /'reasons' is required/);
    const { body: cur } = await sb.get(F);

    const later = await sb.post(R, { product: 'switch', time: at(DAY), reasons });
    assert.equal(later.status, 200, JSON.stringify(later.body));
    assert.equal(later.body.status, 'pending');
    assert.match(later.body.upgradeBatchId, /^\d{18}$/);
    assert.deepEqual(later.body.toVersion, cur.products.switch.lastUpgrade.fromVersion);
    assert.deepEqual(later.body.reasons, reasons);
    assert.deepEqual((await sb.get(F)).body.products.switch.nextUpgrade, { time: at(DAY), toVersion: cur.products.switch.lastUpgrade.fromVersion });

    // With no time it happens now.
    const now = await sb.post(R, { product: 'appliance', reasons });
    assert.equal(now.body.status, 'completed');
    assert.equal(now.body.time, NOW);
    const mx = (await sb.get(F)).body.products.appliance;
    assert.deepEqual(mx.currentVersion, cur.products.appliance.lastUpgrade.fromVersion);
    assert.deepEqual(mx.availableVersions.map((v) => v.id), [cur.products.appliance.currentVersion.id, cur.products.appliance.availableVersions[0].id]);
    assert.match(await errorOf(sb.post(R, { product: 'appliance', reasons })), /no older appliance firmware/);

    // Toronto only has access points, so the product can be left out.
    const tor = sb.world.orgs[1].networks[0];
    const t = await sb.post(`/networks/${tor.id}/firmwareUpgrades/rollbacks`, { reasons, predownload: { enabled: true } });
    assert.equal(t.body.product, 'wireless');
    assert.deepEqual(t.body.predownload, { enabled: true });
  });
});

describe('staged upgrades', () => {
  let sb;
  let hq;
  let G;
  let E;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    hq = sb.world.orgs[0].networks[0];
    G = `/networks/${hq.id}/firmwareUpgrades/staged/groups`;
    E = `/networks/${hq.id}/firmwareUpgrades/staged/events`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const group = async (body) => {
    const r = await sb.post(G, body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const betaId = async () => (await sb.get(`/networks/${hq.id}/firmwareUpgrades`)).body.products.switch.availableVersions[0].id;

  test('networks start with no groups and no event', async () => {
    fresh();
    assert.deepEqual((await sb.get(G)).body, []);
    assert.deepEqual((await sb.get(`/networks/${hq.id}/firmwareUpgrades/staged/stages`)).body, []);
    assert.deepEqual((await sb.get(E)).body, { products: {}, stages: [], reasons: [] });
    assert.equal((await sb.get(`${G}/578149602163689100`)).status, 404);
    const tor = sb.world.orgs[1].networks[0];
    assert.match(await errorOf(sb.get(`/networks/${tor.id}/firmwareUpgrades/staged/groups`)), /product type 'switch'/);
  });

  test('groups hold devices and stacks, one group each', async () => {
    fresh();
    const [core, f2, f3] = hq.switches;
    const a = await group({ name: 'Core', isDefault: true, assignedDevices: { devices: [{ serial: core.serial }] } });
    assert.match(a.groupId, /^\d{18}$/);
    assert.deepEqual(a, { groupId: a.groupId, name: 'Core', description: '', isDefault: true, assignedDevices: { devices: [{ serial: core.serial, name: core.name }], switchStacks: [] } });

    // Assigning a device moves it, and a new default takes over.
    const b = await group({ name: 'Floors', description: 'Access switches', isDefault: true, assignedDevices: { devices: [{ serial: core.serial }, { serial: f2.serial }] } });
    const list = (await sb.get(G)).body;
    assert.deepEqual(list.map((g) => [g.name, g.isDefault, g.assignedDevices.devices.length]), [['Core', false, 0], ['Floors', true, 2]]);
    assert.deepEqual((await sb.get(`${G}/${b.groupId}`)).body, b);

    assert.match(await errorOf(sb.post(G, { name: '', isDefault: false })), /1 to 255/);
    assert.match(await errorOf(sb.post(G, { name: 'X', isDefault: false, assignedDevices: { devices: [{ serial: hq.mx.serial }] } })), /not in this network/);
    assert.match(await errorOf(sb.post(G, { name: 'X', isDefault: false, assignedDevices: { devices: [{ serial: f2.serial }, { serial: f2.serial }] } })), /listed once/);

    // A stacked switch goes in through its stack, and a deleted stack drops out.
    const stack = (await sb.post(`/networks/${hq.id}/switch/stacks`, { name: 'Pair', serials: [f2.serial, f3.serial] })).body;
    assert.match(await errorOf(sb.put(`${G}/${a.groupId}`, { name: 'Core', isDefault: false, assignedDevices: { devices: [{ serial: f3.serial }] } })), /assign the stack instead/);
    const u = await sb.put(`${G}/${a.groupId}`, { name: 'Core 2', isDefault: false, assignedDevices: { switchStacks: [{ id: stack.id }] } });
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.deepEqual(u.body.assignedDevices, { devices: [], switchStacks: [{ id: stack.id, name: 'Pair' }] });
    await sb.del(`/networks/${hq.id}/switch/stacks/${stack.id}`);
    assert.deepEqual((await sb.get(`${G}/${a.groupId}`)).body.assignedDevices.switchStacks, []);

    assert.equal((await sb.del(`${G}/${a.groupId}`)).status, 204);
    assert.equal((await sb.get(`${G}/${a.groupId}`)).status, 404);
  });

  test('stages set the group order', async () => {
    fresh();
    const S = `/networks/${hq.id}/firmwareUpgrades/staged/stages`;
    const [a, b, c] = [await group({ name: 'A', isDefault: true }), await group({ name: 'B', isDefault: false }), await group({ name: 'C', isDefault: false })];
    const r = await sb.put(S, { _json: [{ group: { id: c.groupId } }, { group: { id: a.groupId } }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map((s) => s.group.name), ['C', 'A', 'B']);
    assert.deepEqual(r.body[0], { group: { id: c.groupId, name: 'C', description: '' } });
    // A bare array works too.
    assert.deepEqual((await sb.put(S, [{ group: { id: b.groupId } }])).body.map((s) => s.group.name), ['B', 'C', 'A']);
    assert.deepEqual((await sb.get(S)).body.map((s) => s.group.name), ['B', 'C', 'A']);
    assert.match(await errorOf(sb.put(S, [{ group: { id: '1' } }])), /not in this network/);
  });

  test('events run stage by stage and can be moved, deferred and rolled back', async () => {
    fresh();
    const a = await group({ name: 'A', isDefault: true });
    const b = await group({ name: 'B', isDefault: false });
    const id = await betaId();
    const body = (aTime, bTime) => ({ products: { switch: { nextUpgrade: { toVersion: { id } } } }, stages: [{ group: { id: a.groupId }, milestones: { scheduledFor: aTime } }, { group: { id: b.groupId }, milestones: { scheduledFor: bTime } }] });

    assert.match(await errorOf(sb.post(E, { ...body(at(DAY), at(2 * DAY)), products: { switch: { nextUpgrade: { toVersion: { id: '1' } } } } })), /not one of the switch firmware versions/);
    assert.match(await errorOf(sb.post(E, { ...body(at(DAY), at(2 * DAY)), products: { switchCatalyst: { nextUpgrade: { toVersion: { id: '1' } } } } })), /Catalyst/);
    assert.match(await errorOf(sb.put(E, body(at(DAY), at(2 * DAY)))), /no staged upgrade event/);

    // A started 30 minutes ago; B's time has no offset, so it's San Francisco time (UTC-7).
    const r = await sb.post(E, body(at(-30 * 60), '2026-10-01T02:00:00'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.products, { switch: { nextUpgrade: { toVersion: { id, shortName: 'MS 17.2.1' } } } });
    assert.deepEqual(r.body.stages[0], { group: { id: a.groupId, name: 'A', description: '' }, milestones: { scheduledFor: at(-30 * 60), startedAt: at(-30 * 60), completedAt: null, canceledAt: null }, status: 'In Progress' });
    assert.deepEqual(r.body.stages[1].milestones, { scheduledFor: '2026-10-01T09:00:00Z', startedAt: null, completedAt: null, canceledAt: null });
    assert.equal(r.body.stages[1].status, 'Scheduled');
    assert.deepEqual((await sb.get(E)).body, r.body);

    assert.match(await errorOf(sb.post(E, body(at(DAY), at(2 * DAY)))), /hasn't finished/);
    assert.match(await errorOf(sb.del(`${G}/${a.groupId}`)), /hasn't finished/);
    assert.match(await errorOf(sb.put(E, body(at(DAY), at(2 * DAY)))), /group 'A' has started/);

    const moved = await sb.put(E, body(at(-30 * 60), at(3 * DAY)));
    assert.equal(moved.body.stages[1].milestones.scheduledFor, at(3 * DAY));
    const deferred = await sb.post(`${E}/defer`);
    assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
    assert.equal(deferred.body.stages[0].milestones.scheduledFor, at(-30 * 60));
    assert.equal(deferred.body.stages[1].milestones.scheduledFor, at(10 * DAY));

    // Rolling back reschedules the started stage and cancels the pending one.
    const reasons = [{ category: 'stability', comment: 'Ports flapping' }];
    const R = `${E}/rollbacks`;
    assert.match(await errorOf(sb.post(R, { stages: [{ group: { id: b.groupId }, milestones: { scheduledFor: at(HOUR) } }] })), /no completed or in-progress stage/);
    assert.match(await errorOf(sb.post(R, { stages: [] })), /At least one stage/);
    const rb = await sb.post(R, { stages: [{ group: { id: a.groupId }, milestones: { scheduledFor: at(HOUR) } }], reasons });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    assert.equal(rb.body.products.switch.nextUpgrade.toVersion.shortName, 'MS 17.1.4');
    assert.deepEqual(rb.body.reasons, reasons);
    assert.deepEqual(rb.body.stages.map((s) => [s.group.name, s.status]), [['A', 'Scheduled'], ['B', 'Canceled']]);
    assert.equal(rb.body.stages[1].milestones.canceledAt, NOW);
  });

  test('a finished event can be replaced and its groups deleted', async () => {
    fresh();
    const a = await group({ name: 'A', isDefault: true });
    const id = await betaId();
    const r = await sb.post(E, { products: { switch: { nextUpgrade: { toVersion: { id } } } }, stages: [{ group: { id: a.groupId }, milestones: { scheduledFor: at(-2 * HOUR) } }] });
    assert.deepEqual(r.body.stages[0].milestones, { scheduledFor: at(-2 * HOUR), startedAt: at(-2 * HOUR), completedAt: at(-HOUR), canceledAt: null });
    assert.equal(r.body.stages[0].status, 'Completed');
    assert.equal((await sb.post(E, { products: { switch: { nextUpgrade: { toVersion: { id } } } }, stages: [{ group: { id: a.groupId }, milestones: { scheduledFor: at(DAY) } }] })).status, 200);
    assert.equal((await sb.post(`${E}/defer`)).body.stages[0].milestones.scheduledFor, at(8 * DAY));
    // The old event finished, but the new one hasn't.
    assert.match(await errorOf(sb.del(`${G}/${a.groupId}`)), /hasn't finished/);
  });
});

describe('organization firmware views', () => {
  let sb;
  let org;
  let hq;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs[0];
    hq = org.networks[0];
    O = `/organizations/${org.id}/firmware/upgrades`;
  };
  const F = () => `/networks/${hq.id}/firmwareUpgrades`;
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const mine = (rows, p) => rows.filter((u) => u.network.id === hq.id && u.productTypes === p);

  test('every network starts with the upgrade its firmware view reports as the last one', async () => {
    fresh();
    const rows = (await sb.get(O)).body;
    const products = org.networks.flatMap((n) => n.productTypes);
    assert.equal(rows.length, products.length);
    assert.ok(rows.every((u) => u.status === 'Completed'));
    const fw = (await sb.get(F())).body.products;
    for (const [p, v] of Object.entries(fw)) {
      const [u] = mine(rows, p);
      assert.deepEqual([u.time, u.fromVersion, u.toVersion], [v.lastUpgrade.time, v.lastUpgrade.fromVersion, v.lastUpgrade.toVersion]);
      assert.equal(u.completedAt, u.time.replace('T', ' ').replace('Z', ' UTC'));
      assert.match(u.upgradeId, /^\d{18}$/);
    }
    const times = rows.map((u) => u.time);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.deepEqual((await sb.get(O)).body, rows);
    assert.ok((await sb.get(`${O}?productTypes[]=camera`)).body.every((u) => u.productTypes === 'camera'));
    assert.equal((await sb.get(`${O}?perPage=3`)).body.length, 3);
  });

  test('scheduled, canceled and finished upgrades show up in both views', async () => {
    fresh();
    const { body: cur } = await sb.get(F());
    const [beta] = cur.products.switch.availableVersions;
    await sb.put(F(), { products: { switch: { nextUpgrade: { time: at(DAY), toVersion: { id: beta.id } } } } });
    let rows = mine((await sb.get(O)).body, 'switch');
    assert.deepEqual(rows.map((u) => u.status), ['Scheduled', 'Completed']);
    assert.equal(rows[0].completedAt, null);
    assert.deepEqual([rows[0].time, rows[0].fromVersion, rows[0].toVersion], [at(DAY), cur.products.switch.currentVersion, beta]);
    const sw = hq.switches[0].serial;
    let dev = (await sb.get(`${O}/byDevice?serials[]=${sw}`)).body;
    assert.deepEqual(dev.map((d) => [d.deviceStatus, d.upgrade.status, d.upgrade.id]), [['scheduled', 'Scheduled', rows[0].upgradeId], ['completed', 'Completed', rows[1].upgradeId]]);
    assert.equal(dev[0].checkinStartedAt, null);
    assert.equal(dev[0].installStatus, 'pending');
    assert.equal(dev[1].verifyStatus, 'complete');
    assert.deepEqual(Object.keys(dev[0].upgrade.toVersion), ['id', 'shortName', 'releaseDate']);
    assert.deepEqual((await sb.get(`${O}/byDevice?serials[]=${sw}&currentUpgradesOnly=true`)).body.map((d) => d.deviceStatus), ['scheduled']);

    // Naming the current version cancels it.
    await sb.put(F(), { products: { switch: { nextUpgrade: { toVersion: { id: cur.products.switch.currentVersion.id } } } } });
    rows = mine((await sb.get(O)).body, 'switch');
    assert.deepEqual(rows.map((u) => u.status), ['Cancelled', 'Completed']);
    assert.deepEqual((await sb.get(`${O}?status[]=Cancelled`)).body.map((u) => u.upgradeId), [rows[0].upgradeId]);
    dev = (await sb.get(`${O}/byDevice?serials[]=${sw}&upgradeStatuses[]=canceled`)).body;
    assert.deepEqual(dev.map((d) => [d.deviceStatus, d.downloadStatus, d.checkinFinishedAt]), [['canceled', 'canceled', null]]);

    // Scheduled again, and its time passes.
    await sb.put(F(), { products: { switch: { nextUpgrade: { time: at(HOUR), toVersion: { id: beta.id } } } } });
    hq.firmware.products.switch.next.time = T - 60;
    rows = mine((await sb.get(O)).body, 'switch');
    assert.deepEqual(rows.map((u) => [u.status, u.time]), [['Cancelled', at(DAY)], ['Completed', at(-60)], ['Completed', cur.products.switch.lastUpgrade.time]]);
    assert.deepEqual((await sb.get(F())).body.products.switch.currentVersion, beta);
    dev = (await sb.get(`${O}/byDevice?serials[]=${sw}&upgradeStatuses[]=completed&limitPerDevice=1`)).body;
    assert.deepEqual(dev.map((d) => [d.deviceStatus, d.detailedStatus, d.verifyFinishedAt]), [['completed', 'upgrade-complete', at(-60)]]);
    assert.deepEqual((await sb.get(`${O}/byDevice?serials[]=${sw}&firmwareUpgradeBatchIds[]=${rows[0].upgradeBatchId}`)).body.map((d) => d.upgrade.status), ['Cancelled']);
  });

  test('a rollback keeps its batch ID', async () => {
    fresh();
    const rb = (await sb.post(`${F()}/rollbacks`, { product: 'wireless', reasons: [{ category: 'performance', comment: 'Slow' }] })).body;
    const [u] = mine((await sb.get(O)).body, 'wireless');
    assert.deepEqual([u.upgradeBatchId, u.status, u.toVersion], [rb.upgradeBatchId, 'Completed', rb.toVersion]);
    const ap = hq.aps[0].serial;
    const [d] = (await sb.get(`${O}/byDevice?serials[]=${ap}&firmwareUpgradeBatchIds[]=${rb.upgradeBatchId}`)).body;
    assert.equal(d.upgrade.toVersion.id, rb.toVersion.id);
  });

  test('by device lists switches and access points, with staged stages', async () => {
    fresh();
    const rows = await collect(sb.get, `${O}/byDevice?perPage=7`);
    const wanted = org.devices.filter((d) => d.productType === 'switch' || d.productType === 'wireless');
    assert.deepEqual([...new Set(rows.map((r) => r.serial))], wanted.map((d) => d.serial).sort());
    assert.ok(rows.every((r) => !('staged' in r.upgrade)));
    assert.equal((await sb.get(`${O}/byDevice?networkIds[]=${hq.id}`)).body.length, hq.switches.length + hq.aps.length);

    const G = `/networks/${hq.id}/firmwareUpgrades/staged/groups`;
    const sw = hq.switches[0];
    const g = (await sb.post(G, { name: 'Core', isDefault: false, assignedDevices: { devices: [{ serial: sw.serial }] } })).body;
    const id = (await sb.get(F())).body.products.switch.availableVersions[0].id;
    await sb.post(`/networks/${hq.id}/firmwareUpgrades/staged/events`, { products: { switch: { nextUpgrade: { toVersion: { id } } } }, stages: [{ group: { id: g.groupId }, milestones: { scheduledFor: at(-30 * 60) } }] });
    const [d] = (await sb.get(`${O}/byDevice?serials[]=${sw.serial}&upgradeStatuses[]=started`)).body;
    assert.deepEqual(d.upgrade.staged, { group: { id: g.groupId } });
    assert.equal(d.upgrade.toVersion.id, id);
    // Halfway through an hour-long stage: check-in and download done, install starting.
    assert.deepEqual([d.deviceStatus, d.detailedStatus, d.downloadStatus, d.installStatus, d.verifyStatus], ['started', 'install-in-progress', 'complete', 'in-progress', 'pending']);
    assert.deepEqual([d.checkinStartedAt, d.downloadFinishedAt, d.installStartedAt, d.installFinishedAt], [at(-30 * 60), NOW, NOW, null]);

    assert.match(await errorOf(sb.get(`${O}/byDevice?upgradeStatuses[]=done`)), /upgradeStatuses/);
    assert.match(await errorOf(sb.get(`${O}/byDevice?limitPerDevice=0`)), /limitPerDevice/);
    assert.match(await errorOf(sb.get(`${O}/byDevice?perPage=2000`)), /perPage/);
  });
});
