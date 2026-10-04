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
});
