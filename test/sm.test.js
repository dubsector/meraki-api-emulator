import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { DAY, iso } from '../src/time.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('Systems Manager devices and owners', () => {
  let sb;
  let lab;
  let net;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    net = lab.networks.find((n) => n.name === 'Lab - Systems Manager');
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const N = (p = '') => `/networks/${net.id}/sm${p}`;
  const D = (d, p) => N(`/devices/${d.id}/${p}`);
  const devices = async (fields = []) => ok(sb.get(N(`/devices?${fields.map((f) => `fields[]=${f}`).join('&')}`)));
  const byKind = (kind) => net.sm.devices.find((d) => d.kind === kind);

  test('Lab - Systems Manager is an SM network whose devices stay out of the inventory', async () => {
    fresh();
    const json = await ok(sb.get(`/networks/${net.id}`));
    assert.deepEqual(json.productTypes, ['systemsManager']);
    assert.equal(net.devices.length, 0);
    const list = await devices();
    assert.equal(list.length, 13);
    assert.deepEqual(Object.keys(list[0]), ['id', 'name', 'tags', 'ssid', 'wifiMac', 'osName', 'systemModel', 'uuid', 'serialNumber', 'serial', 'ip', 'notes']);
    assert.deepEqual(list.map((d) => d.id), [...list.map((d) => d.id)].sort());
    const serials = new Set(list.map((d) => d.serialNumber));
    const inventory = await collect(sb.get, `/organizations/${lab.id}/inventory/devices?perPage=1000`);
    assert.ok(!inventory.some((d) => serials.has(d.serial)));
    const orgDevices = await ok(sb.get(`/organizations/${lab.id}/devices`));
    assert.ok(!orgDevices.some((d) => d.networkId === net.id));
    const overview = await ok(sb.get(`/organizations/${lab.id}/licenses/overview`));
    assert.equal(overview.systemsManager.counts.orgwideEnrolledDevices, 13);
  });

  test('the device list takes extra fields, filters and pages', async () => {
    fresh();
    const all = await devices(['systemType', 'ownerEmail', 'ownerUsername', 'lastConnected', 'cellular', 'osBuild']);
    assert.deepEqual([...new Set(all.map((d) => d.systemType))].sort(), ['android', 'chrome', 'ipad', 'iphone', 'mac', 'windows']);
    const kiosk = all.find((d) => d.tags.includes('kiosk'));
    assert.equal(kiosk.ownerEmail, null);
    assert.match(all.find((d) => d.ownerEmail).ownerEmail, /@acme-lab\.example\.com$/);
    assert.ok(all.every((d) => typeof d.lastConnected === 'number' && d.lastConnected <= now));
    const mac = all.find((d) => d.systemType === 'mac');
    const one = async (q) => (await ok(sb.get(N(`/devices?${q}`)))).map((d) => d.id);
    assert.deepEqual(await one(`serials[]=${mac.serialNumber}`), [mac.id]);
    assert.deepEqual(await one(`wifiMacs[]=${mac.wifiMac.toUpperCase()}`), [mac.id]);
    assert.deepEqual(await one(`uuids[]=${mac.uuid.toLowerCase()}`), [mac.id]);
    assert.deepEqual(await one(`ids[]=${mac.id}`), [mac.id]);
    assert.equal((await one('systemTypes[]=mac')).length, 3);
    assert.equal((await one('scope[]=withAny&scope[]=byod')).length, 2);
    assert.equal((await one('scope[]=withoutAny&scope[]=byod')).length, 11);
    assert.equal((await one('scope[]=withAll&scope[]=corporate&scope[]=remote')).length, 3);
    assert.equal((await one('scope[]=none')).length, 0);
    assert.equal((await one('scope[]=all')).length, 13);
    const paged = await collect(sb.get, N('/devices?perPage=3'));
    assert.deepEqual(paged.map((d) => d.id), all.map((d) => d.id));
    assert.match(await errorOf(sb.get(N('/devices?fields[]=bogus'))), /bogus/);
    assert.match(await errorOf(sb.get(N('/devices?scope[]=someOf&scope[]=x'))), /scope/);
    assert.match(await errorOf(sb.get(N('/devices?perPage=2'))), /perPage/);
    const toronto = lab.networks.find((n) => n.name === 'Lab - Toronto');
    assert.match(await errorOf(sb.get(`/networks/${toronto.id}/sm/devices`)), /systemsManager/);
    assert.match(await errorOf(sb.get(N('/devices/123/softwares')), 404), /not found/);
  });

  test('device fields agree with the per-device views', async () => {
    fresh();
    const fields = ['lastConnected', 'cellularDataUsed', 'missingAppsCount', 'avName', 'fwName', 'diskEncryptionEnabled', 'kioskAppName', 'lastUser'];
    for (const d of await devices(fields)) {
      const dev = net.sm.devices.find((x) => x.id === d.id);
      const conn = await collect(sb.get, D(dev, 'connectivity?perPage=1000'));
      assert.equal(d.lastConnected, Date.parse(conn.at(-1).lastSeenAt) / 1000, d.name);
      const cell = await ok(sb.get(D(dev, 'cellularUsageHistory')));
      assert.equal(d.cellularDataUsed, dev.cellular ? cell.reduce((s, x) => s + x.received + x.sent, 0) : null);
      if (dev.cellular) assert.equal(cell.at(-1).ts, iso(Math.floor(now / DAY) * DAY));
      else assert.deepEqual(cell, []);
      const soft = await ok(sb.get(D(dev, 'softwares')));
      assert.equal(d.missingAppsCount, soft.filter((s) => s.toInstall && !s.installedAt).length);
      assert.ok(soft.every((s) => s.deviceId === d.id));
      const [adapter] = await ok(sb.get(D(dev, 'networkAdapters')));
      assert.equal(adapter.mac, d.wifiMac);
      assert.equal(adapter.ip, d.ip);
      const centers = await ok(sb.get(D(dev, 'securityCenters')));
      if (dev.kind === 'Windows') assert.deepEqual([centers[0].antiVirusName, centers[0].fireWallName, centers[0].isDiskEncrypted], [d.avName, d.fwName, d.diskEncryptionEnabled]);
      else assert.deepEqual(centers, []);
      const perf = await ok(sb.get(D(dev, 'performanceHistory')));
      const logs = await ok(sb.get(D(dev, 'desktopLogs')));
      if (dev.kind === 'Mac' || dev.kind === 'Windows') {
        assert.ok(perf.length > 50 && logs.length > 20);
        assert.ok(logs.every((l) => l.ip === d.ip && l.wifiSsid === d.ssid && l.user === d.lastUser));
        // Every sample falls in a time the device was online.
        assert.ok(perf.every((p) => conn.some((c) => c.firstSeenAt <= p.ts && p.ts <= c.lastSeenAt)));
      } else assert.deepEqual([perf, logs], [[], []]);
    }
    assert.equal((await devices(['missingAppsCount'])).filter((d) => d.missingAppsCount).length, 1);
  });

  test('profiles on devices and owners come from the network list', async () => {
    fresh();
    const profiles = await ok(sb.get(N('/profiles')));
    assert.equal(profiles.length, 6);
    assert.deepEqual((await ok(sb.get(N('/profiles?payloadTypes[]=Vpn')))).map((p) => p.name), ['Remote VPN']);
    assert.equal((await collect(sb.get, N('/profiles?perPage=3'))).length, 6);
    assert.match(await errorOf(sb.get(N('/profiles?perPage=51'))), /perPage/);
    const kiosk = net.sm.devices.find((d) => d.tags.includes('kiosk'));
    const installed = await ok(sb.get(D(kiosk, 'deviceProfiles')));
    assert.deepEqual(installed.map((p) => p.name).sort(), ['Device restrictions', 'Front desk kiosk']);
    for (const p of installed) assert.equal(profiles.find((x) => x.id === p.id).name, p.name);
    const restrictions = await ok(sb.get(D(kiosk, 'restrictions')));
    assert.deepEqual(restrictions.restrictions.map((r) => r.profile).sort(), installed.map((p) => p.profileIdentifier).sort());
    const [kioskJson] = await ok(sb.get(N(`/devices?ids[]=${kiosk.id}&fields[]=kioskAppName`)));
    assert.equal(kioskJson.kioskAppName, 'Acme Sign In');
    // The Wi-Fi profile carries a certificate, so corporate devices have one.
    const mac = byKind('Mac');
    const certs = await ok(sb.get(D(mac, 'certs')));
    assert.equal(certs.length, 1);
    assert.match(certs[0].certPem, /^-----BEGIN CERTIFICATE-----\n/);
    assert.deepEqual(await ok(sb.get(D(kiosk, 'certs'))), []);
    const [wlan] = await ok(sb.get(D(mac, 'wlanLists')));
    assert.match(wlan.xml, /\tAcme-Corp\n/);
    // An owner's profiles and software are those on their devices.
    const users = await ok(sb.get(N('/users')));
    for (const u of users) {
      const mine = net.sm.devices.filter((d) => d.ownerId === u.id);
      const expected = [];
      const apps = [];
      for (const d of mine) {
        expected.push(...(await ok(sb.get(D(d, 'deviceProfiles')))));
        apps.push(...(await ok(sb.get(D(d, 'softwares')))));
      }
      assert.deepEqual(await ok(sb.get(N(`/users/${u.id}/deviceProfiles`))), expected);
      assert.deepEqual(await ok(sb.get(N(`/users/${u.id}/softwares`))), apps);
    }
    assert.match(await errorOf(sb.get(N('/users/1/softwares')), 404), /not found/);
  });

  test('owners filter by ID, username, email and tag scope', async () => {
    fresh();
    const users = await ok(sb.get(N('/users')));
    assert.equal(users.length, 7);
    const u = users[0];
    assert.equal(u.displayName, `${u.fullName} <${u.email}>`);
    assert.match(u.tags, /^ \w+ $/);
    const one = async (q) => (await ok(sb.get(N(`/users?${q}`)))).map((x) => x.id);
    assert.deepEqual(await one(`ids[]=${u.id}`), [u.id]);
    assert.deepEqual(await one(`usernames[]=${u.username}`), [u.id]);
    assert.deepEqual(await one(`emails[]=${u.email.toUpperCase()}`), [u.id]);
    assert.equal((await one('scope[]=withAny&scope[]=engineering&scope[]=sales')).length, 4);
    assert.equal((await one('scope[]=withoutAny&scope[]=engineering')).length, 5);
  });

  test('command logs start with the enrollment and page in order', async () => {
    fresh();
    const mac = byKind('Mac');
    const logs = await collect(sb.get, D(mac, 'deviceCommandLogs?perPage=3'));
    assert.equal(logs[0].action, 'DeviceInformation');
    assert.ok(logs.some((l) => l.action === 'InstallProfile' && l.name === 'Acme Wi-Fi'));
    assert.deepEqual(logs.map((l) => l.ts), [...logs.map((l) => l.ts)].sort());
    assert.ok(logs.every((l) => l.dashboardUser === null));
  });

  test('the SM store follows its network through a combine and a split', async () => {
    fresh();
    const toronto = lab.networks.find((n) => n.name === 'Lab - Toronto');
    const before = await devices();
    const combined = await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Toronto combined', networkIds: [toronto.id, net.id] }));
    const id = combined.resultingNetwork.id;
    assert.deepEqual(combined.resultingNetwork.productTypes.sort(), ['systemsManager', 'wireless']);
    assert.deepEqual(await ok(sb.get(`/networks/${id}/sm/devices`)), before);
    const split = await ok(sb.post(`/networks/${id}/split`));
    const part = split.resultingNetworks.find((n) => n.productTypes.includes('systemsManager'));
    assert.deepEqual(await ok(sb.get(`/networks/${part.id}/sm/devices`)), before);
  });

  test('network copies and clones take profiles, target groups and trusted access configs', async () => {
    fresh();
    const group = await ok(sb.post(N('/targetGroups'), { name: 'Remote staff', scope: 'withAny, remote' }), 201);
    const settings = async (id) => Promise.all(['profiles', 'targetGroups', 'trustedAccessConfigs'].map((p) => ok(sb.get(`/networks/${id}/sm/${p}`))));
    const want = await settings(net.id);
    assert.deepEqual(want[1], [group]);
    const copy = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'SM copy', productTypes: ['systemsManager'], copyFromNetworkId: net.id }), 201);
    assert.deepEqual(await settings(copy.id), want);
    for (const p of ['devices', 'users', 'userAccessDevices']) assert.deepEqual(await ok(sb.get(`/networks/${copy.id}/sm/${p}`)), []);
    // A device moved into the copy keeps its profiles.
    const mac = byKind('Mac');
    const installed = await ok(sb.get(D(mac, 'deviceProfiles')));
    assert.ok(installed.length);
    await ok(sb.post(N('/devices/move'), { ids: [mac.id], newNetwork: copy.id }));
    assert.deepEqual(await ok(sb.get(`/networks/${copy.id}/sm/devices/${mac.id}/deviceProfiles`)), installed);
    assert.ok(!(await logs(mac, copy.id)).some((c) => c.action === 'RemoveProfile'));
    const clone = await ok(sb.post(`/organizations/${lab.id}/clone`, { name: 'Lab clone' }), 201);
    const cloned = sb.world.orgById.get(clone.id).networks.find((n) => n.name === net.name);
    assert.deepEqual(await settings(cloned.id), want);
    assert.deepEqual(await ok(sb.get(`/networks/${cloned.id}/sm/devices`)), []);
    // Writes to the copy leave the source alone.
    await ok(sb.del(`/networks/${copy.id}/sm/targetGroups/${group.id}`), 204);
    assert.deepEqual(await ok(sb.get(N('/targetGroups'))), [group]);
  });

  const logs = async (d, netId = net.id) => ok(sb.get(`/networks/${netId}/sm/devices/${d.id}/deviceCommandLogs`));
  const byName = (name) => net.sm.devices.find((d) => d.name === name);

  test('set actions answer the devices they reached and log the command', async () => {
    fresh();
    const mac = byKind('Mac');
    const android = byKind('Android');
    assert.match(await errorOf(sb.post(N('/devices/checkin'), {})), /Name the devices/);
    assert.match(await errorOf(sb.post(N('/devices/checkin'), { scope: ['some', 'tag'] })), /must start with one of/);
    assert.deepEqual(await ok(sb.post(N('/devices/checkin'), { ids: [mac.id, '999'], wifiMacs: [android.wifiMac.toUpperCase()] })), { ids: [mac.id, android.id].sort() });
    const [m] = await devices(['lastConnected']).then((rows) => rows.filter((r) => r.id === mac.id));
    assert.equal(m.lastConnected, now);
    const last = (await logs(mac)).at(-1);
    assert.deepEqual(last, { action: 'DeviceInformation', name: mac.name, details: '{}', dashboardUser: 'API Integration', ts: NOW });

    const corp = net.sm.devices.filter((d) => d.tags.includes('corporate')).map((d) => d.id).sort();
    assert.match(await errorOf(sb.post(N('/devices/lock'), { scope: ['withAny', 'corporate'] })), /'pin' is required to lock macOS/);
    assert.match(await errorOf(sb.post(N('/devices/lock'), { serials: [mac.serialNumber], pin: 1234567 })), /six digit/);
    assert.deepEqual(await ok(sb.post(N('/devices/lock'), { scope: ['withAny', 'corporate'], pin: 123456 })), { ids: corp });
    assert.equal((await logs(mac)).at(-1).action, 'DeviceLock');

    // Reboot skips Android and unsupervised iOS, shutdown takes macOS and Windows only.
    const reboot = await ok(sb.post(N('/devices/reboot'), { scope: ['all'], notifyUser: true }));
    assert.deepEqual(reboot.ids, net.sm.devices.filter((d) => d.kind !== 'Android' && (d.supervised || !['iPhone', 'iPad'].includes(d.kind))).map((d) => d.id));
    assert.equal(JSON.parse((await logs(mac)).at(-1).details).notifyUser, true);
    const shutdown = await ok(sb.post(N('/devices/shutdown'), { scope: ['all'] }));
    assert.deepEqual(shutdown.ids, net.sm.devices.filter((d) => ['Mac', 'Windows'].includes(d.kind)).map((d) => d.id));
    assert.deepEqual(await ok(sb.post(N('/devices/shutdown'), { ids: [android.id] })), { ids: [] });
  });

  test('device fields and tags change what the views show', async () => {
    fresh();
    const phone = byName("Sam's iPhone");
    assert.match(await errorOf(sb.put(N('/devices/fields'), { deviceFields: { name: 'x' } })), /Name the device/);
    await errorOf(sb.put(N('/devices/fields'), { serial: 'NOPE', deviceFields: { name: 'x' } }), 404);
    assert.match(await errorOf(sb.put(N('/devices/fields'), { id: phone.id, deviceFields: { name: ' ' } })), /must not be empty/);
    const f = await ok(sb.put(N('/devices/fields'), { id: phone.id, deviceFields: { name: 'Sam phone', notes: 'Cracked screen' } }));
    assert.deepEqual(f, [{ id: phone.id, name: 'Sam phone', wifiMac: phone.wifiMac, serial: phone.serialNumber, notes: 'Cracked screen' }]);
    const row = (await devices()).find((d) => d.id === phone.id);
    assert.equal(row.name, 'Sam phone');
    assert.equal(row.notes, 'Cracked screen');

    assert.match(await errorOf(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['a b'], updateAction: 'add' })), /without spaces/);
    assert.match(await errorOf(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['x'], updateAction: 'replace' })), /updateAction/);
    const before = (await ok(sb.get(D(phone, 'deviceProfiles')))).map((p) => p.name);
    const added = await ok(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['corporate'], updateAction: 'add' }));
    assert.deepEqual(added, [{ id: phone.id, tags: ['byod', 'corporate'], wifiMac: phone.wifiMac, serial: phone.serialNumber }]);
    assert.deepEqual(await ok(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['corporate'], updateAction: 'add' })), []);
    const after = (await ok(sb.get(D(phone, 'deviceProfiles')))).map((p) => p.name);
    assert.deepEqual(after.filter((n) => !before.includes(n)), ['Acme Wi-Fi']);
    assert.deepEqual((await logs(phone)).at(-1).name, 'Acme Wi-Fi');
    // Dropping byod brings the iOS restrictions in.
    await ok(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['byod'], updateAction: 'delete' }));
    assert.equal((await ok(sb.get(D(phone, 'restrictions')))).restrictions.length, 1);
    await ok(sb.post(N('/devices/modifyTags'), { ids: [phone.id], tags: ['kiosk'], updateAction: 'update' }));
    assert.deepEqual(phone.tags, ['kiosk']);
    const listed = await ok(sb.get(N('/devices?scope[]=withAll&scope[]=kiosk')));
    assert.ok(listed.some((d) => d.id === phone.id));
  });

  test('moving devices takes them and their owner to another SM network', async () => {
    fresh();
    const mac = byKind('Mac');
    const toronto = lab.networks.find((n) => n.name === 'Lab - Toronto');
    const other = await ok(sb.post(`/organizations/${lab.id}/networks`, { name: 'SM two', productTypes: ['systemsManager'] }), 201);
    assert.match(await errorOf(sb.post(N('/devices/move'), { ids: [mac.id], newNetwork: toronto.id })), /Systems Manager network/);
    assert.match(await errorOf(sb.post(N('/devices/move'), { ids: [mac.id], newNetwork: net.id })), /already/);
    assert.match(await errorOf(sb.post(N('/devices/move'), { ids: [mac.id], newNetwork: 'N_1' })), /not a network/);
    assert.deepEqual(await ok(sb.post(N('/devices/move'), { ids: ['999'], newNetwork: other.id })), { ids: [], newNetwork: other.id });
    assert.equal(sb.world.networkById.get(other.id).sm, undefined);
    const owner = net.sm.users.find((u) => u.id === mac.ownerId);
    assert.deepEqual(await ok(sb.post(N('/devices/move'), { ids: [mac.id], newNetwork: other.id })), { ids: [mac.id], newNetwork: other.id });
    assert.ok(!(await devices()).some((d) => d.id === mac.id));
    const moved = await ok(sb.get(`/networks/${other.id}/sm/devices`));
    assert.deepEqual(moved.map((d) => d.id), [mac.id]);
    const users = await ok(sb.get(`/networks/${other.id}/sm/users`));
    assert.deepEqual(users.map((u) => u.id), [owner.id]);
    // The new network has no profiles, so the old ones come off.
    assert.deepEqual(await ok(sb.get(`/networks/${other.id}/sm/devices/${mac.id}/deviceProfiles`)), []);
    const log = await ok(sb.get(`/networks/${other.id}/sm/devices/${mac.id}/deviceCommandLogs`));
    assert.ok(log.at(-1).action === 'RemoveProfile');
  });

  test('wipe and unenroll take a device out of the network', async () => {
    fresh();
    const mac = byKind('Mac');
    const ipad = byKind('iPad');
    const owner = net.sm.users.find((u) => u.id === mac.ownerId);
    const count = net.sm.devices.length;
    assert.match(await errorOf(sb.post(N('/devices/wipe'), {})), /Name the device/);
    assert.match(await errorOf(sb.post(N('/devices/wipe'), { id: mac.id })), /'pin' is required to wipe macOS/);
    await errorOf(sb.post(N('/devices/wipe'), { id: '999' }), 404);
    assert.deepEqual(await ok(sb.post(N('/devices/wipe'), { serial: mac.serialNumber, pin: 654321 })), { id: mac.id });
    assert.deepEqual(await ok(sb.post(D(ipad, 'unenroll'))), { success: true });
    assert.equal((await devices()).length, count - 2);
    await errorOf(sb.get(D(mac, 'softwares')), 404);
    const softwares = await ok(sb.get(N(`/users/${owner.id}/softwares`)));
    assert.ok(!softwares.some((s) => s.deviceId === mac.id));
    await errorOf(sb.post(D(ipad, 'unenroll')), 404);
  });

  test('installing and uninstalling apps changes the software list', async () => {
    fresh();
    const pc = byKind('Windows');
    const apps = (await ok(sb.get(D(pc, 'softwares')))).filter((s) => s.appId);
    const chrome = apps.find((s) => s.name === 'Google Chrome');
    assert.match(await errorOf(sb.post(D(pc, 'installApps'), { appIds: [] })), /at least one/);
    assert.match(await errorOf(sb.post(D(pc, 'installApps'), { appIds: ['999'] })), /Unknown apps/);
    assert.deepEqual(await ok(sb.post(D(pc, 'uninstallApps'), { appIds: [chrome.appId] })), {});
    assert.match(await errorOf(sb.post(D(pc, 'uninstallApps'), { appIds: [chrome.appId] })), /Not installed/);
    assert.ok(!(await ok(sb.get(D(pc, 'softwares')))).some((s) => s.appId === chrome.appId));
    // Installing an app already there is skipped unless forced.
    const other = apps.find((s) => s !== chrome);
    const logged = (await logs(pc)).length;
    await ok(sb.post(D(pc, 'installApps'), { appIds: [chrome.appId, other.appId] }));
    assert.equal((await logs(pc)).length, logged + 1);
    await ok(sb.post(D(pc, 'installApps'), { appIds: [other.appId], force: true }));
    assert.equal((await logs(pc)).length, logged + 2);
    const back = (await ok(sb.get(D(pc, 'softwares')))).find((s) => s.appId === chrome.appId);
    assert.equal(back.installedAt, NOW);
    assert.equal(back.uninstalledAt, null);

    // The Mac still waiting for an app counts it missing until it is installed.
    const mac = net.sm.devices.find((d) => d.softwares.some((s) => s.toInstall));
    const pending = mac.softwares.find((s) => s.toInstall);
    const missing = async () => (await devices(['missingAppsCount'])).find((d) => d.id === mac.id).missingAppsCount;
    assert.equal(await missing(), 1);
    await ok(sb.post(D(mac, 'installApps'), { appIds: [pending.appId] }));
    assert.equal(await missing(), 0);

    assert.deepEqual(await ok(sb.post(D(pc, 'refreshDetails'))), {});
    assert.deepEqual((await logs(pc)).slice(-3).map((l) => l.action), ['DeviceInformation', 'InstalledApplicationList', 'CertificateList']);
  });

  test('activation lock bypass reports each device once complete', async () => {
    fresh();
    const supervised = net.sm.devices.find((d) => d.supervised);
    const byod = byName("Sam's iPhone");
    assert.match(await errorOf(sb.post(N('/bypassActivationLockAttempts'), { ids: [] })), /at least one/);
    assert.match(await errorOf(sb.post(N('/bypassActivationLockAttempts'), { ids: ['999'] })), /Unknown devices: 999/);
    const a = await ok(sb.post(N('/bypassActivationLockAttempts'), { ids: [supervised.id, byod.id] }), 201);
    assert.deepEqual(a.data, { [supervised.id]: { success: true }, [byod.id]: { success: false, errors: ['Activation lock bypass code not known for this device'] } });
    assert.equal(a.status, 'complete');
    assert.deepEqual(await ok(sb.get(N(`/bypassActivationLockAttempts/${a.id}`))), a);
    await errorOf(sb.get(N('/bypassActivationLockAttempts/1234')), 404);
  });

  test('target groups keep a tag scope and list what it covers', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(N('/targetGroups'))), []);
    assert.equal(net.sm.targetGroups, undefined);
    assert.match(await errorOf(sb.post(N('/targetGroups'), { scope: 'all' })), /'name' is required/);
    assert.match(await errorOf(sb.post(N('/targetGroups'), { name: 'Bad', scope: 'some, tag' })), /must start with one of/);
    assert.equal(net.sm.targetGroups, undefined);
    const g = await ok(sb.post(N('/targetGroups'), { name: 'Remote staff', scope: 'withAny, remote' }), 201);
    assert.deepEqual(g, { id: g.id, name: 'Remote staff', scope: 'withAny', tags: ['remote'] });
    const plain = await ok(sb.post(N('/targetGroups'), { name: 'Nobody' }), 201);
    assert.equal(plain.scope, 'none');
    assert.match(await errorOf(sb.post(N('/targetGroups'), { name: 'Nobody' })), /already exists/);
    const detailed = await ok(sb.get(N(`/targetGroups/${g.id}?withDetails=true`)));
    assert.deepEqual(detailed.deviceIds, net.sm.devices.filter((d) => d.tags.includes('remote')).map((d) => d.id));
    assert.deepEqual(detailed.userIds, net.sm.users.filter((u) => u.tags.includes('remote')).map((u) => u.id));
    const listed = await ok(sb.get(N(`/devices?scope[]=withAny&scope[]=remote`)));
    assert.deepEqual(listed.map((d) => d.id), detailed.deviceIds);
    const u = await ok(sb.put(N(`/targetGroups/${g.id}`), { scope: 'all' }));
    assert.deepEqual([u.name, u.scope, u.tags], ['Remote staff', 'all', []]);
    await ok(sb.del(N(`/targetGroups/${g.id}`)), 204);
    await errorOf(sb.get(N(`/targetGroups/${g.id}`)), 404);
    assert.deepEqual((await ok(sb.get(N('/targetGroups')))).map((x) => x.id), [plain.id]);
  });
});

describe('Systems Manager activation lock bypass on a running clock', () => {
  test('an attempt is pending until it completes', async () => {
    const sb = await start({ now: null });
    try {
      const net = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks.find((n) => n.sm);
      const dev = net.sm.devices.find((d) => d.supervised);
      const a = (await sb.post(`/networks/${net.id}/sm/bypassActivationLockAttempts`, { ids: [dev.id] })).body;
      assert.deepEqual([a.status, a.data], ['pending', {}]);
    } finally {
      sb.close();
    }
  });
});
