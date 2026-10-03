import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { MODELS } from '../src/catalog.js';
import { claimDevice } from '../src/world.js';
import { start } from './helpers.js';

describe('MX Wi-Fi and vMX tokens', () => {
  let sb;
  let org;
  let london;
  let hq;
  let mx;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  // No seeded MX has a radio, so London's MX68 becomes an MX68W in this world only.
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    london = org.networks.find((n) => n.name === 'Remote - London');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    Object.assign(london.mx, { model: 'MX68W', info: MODELS.MX68W });
    mx = london.mx.serial;
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
  const P = () => `/networks/${london.id}/appliance/rfProfiles`;
  const S = () => `/networks/${london.id}/appliance/ssids`;
  const radio = (serial = mx) => `/devices/${serial}/appliance/radio/settings`;

  test('MXes without a radio refuse the Wi-Fi routes', async () => {
    fresh();
    assert.match(await errorOf(sb.get(radio(hq.mx.serial))), /MX250 has no wireless radio/);
    assert.match(await errorOf(sb.put(radio(hq.mx.serial), { rfProfileId: null })), /no wireless radio/);
    assert.match(await errorOf(sb.get(radio(hq.switches[0].serial))), /appliance devices/);
    for (const path of [`/networks/${hq.id}/appliance/rfProfiles`, `/networks/${hq.id}/appliance/ssids`, `/networks/${hq.id}/appliance/ssids/1`]) {
      assert.match(await errorOf(sb.get(path)), /MX250\) has no wireless radio/);
    }
    assert.match(await errorOf(sb.post(`/networks/${hq.id}/appliance/rfProfiles`, { name: 'x' })), /no wireless radio/);
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/appliance/ssids/1`, { enabled: true })), /no wireless radio/);
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
    assert.match(await errorOf(sb.get(`/networks/${lab.id}/appliance/ssids`)), /product type 'appliance'/);
  });

  test('RF profiles take defaults, check their fields and refuse delete while assigned', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(P())), { assigned: [] });
    const p = await ok(sb.post(P(), { name: 'Office', twoFourGhzSettings: { minBitrate: 5.5 }, perSsidSettings: { 2: { bandOperationMode: '5ghz', bandSteeringEnabled: false } } }), 201);
    assert.match(p.id, /^\d{18}$/);
    const ssid = { bandOperationMode: 'dual', bandSteeringEnabled: true };
    assert.deepEqual(p, {
      id: p.id,
      networkId: london.id,
      name: 'Office',
      twoFourGhzSettings: { minBitrate: 5.5, axEnabled: true },
      fiveGhzSettings: { minBitrate: 12, axEnabled: true },
      perSsidSettings: { 1: ssid, 2: { bandOperationMode: '5ghz', bandSteeringEnabled: false }, 3: ssid, 4: ssid },
    });
    assert.deepEqual(await ok(sb.get(`${P()}/${p.id}`)), p);
    assert.deepEqual(await ok(sb.get(P())), { assigned: [p] });
    assert.match(await errorOf(sb.post(P(), {})), /name/);
    assert.match(await errorOf(sb.post(P(), { name: 'Office' })), /already exists/);
    assert.match(await errorOf(sb.post(P(), { name: 'x', twoFourGhzSettings: { minBitrate: 7 } })), /minBitrate/);
    assert.match(await errorOf(sb.post(P(), { name: 'x', fiveGhzSettings: { minBitrate: 2 } })), /minBitrate/);
    assert.match(await errorOf(sb.post(P(), { name: 'x', perSsidSettings: { 1: { bandOperationMode: 'triple' } } })), /bandOperationMode/);
    assert.equal(await errorOf(sb.get(`${P()}/1234`), 404), 'RF profile not found');
    const up = await ok(sb.put(`${P()}/${p.id}`, { name: 'Office 2', fiveGhzSettings: { axEnabled: false } }));
    assert.deepEqual([up.name, up.fiveGhzSettings], ['Office 2', { minBitrate: 12, axEnabled: false }]);

    await ok(sb.put(radio(), { rfProfileId: p.id }));
    assert.match(await errorOf(sb.del(`${P()}/${p.id}`)), new RegExp(`assigned to appliance ${mx}`));
    await ok(sb.put(radio(), { rfProfileId: null }));
    assert.equal((await sb.del(`${P()}/${p.id}`)).status, 204);
    assert.deepEqual(await ok(sb.get(P())), { assigned: [] });
  });

  test('an MX swapped for a model without a radio no longer holds its RF profile', async () => {
    fresh();
    const p = await ok(sb.post(P(), { name: 'Office' }), 201);
    // A second MX68W in London, as a warm spare would be.
    const spare = claimDevice(sb.world, london, { serial: 'Q2MW-TEST-0001', model: 'MX68W', mac: '00:18:0a:00:00:01', orderNumber: null, claimedAt: 0, tags: [], name: null });
    await ok(sb.put(radio(spare.serial), { rfProfileId: p.id }));
    assert.match(await errorOf(sb.del(`${P()}/${p.id}`)), new RegExp(`assigned to appliance ${spare.serial}`));
    // A swap keeps the device object and its settings but changes the model.
    Object.assign(spare, { model: 'MX68', info: MODELS.MX68 });
    assert.match(await errorOf(sb.get(radio(spare.serial))), /no wireless radio/);
    assert.equal((await sb.del(`${P()}/${p.id}`)).status, 204);
  });

  test('radio settings store manual values and a profile clears them', async () => {
    fresh();
    const auto = { serial: mx, rfProfileId: null, twoFourGhzSettings: { channel: null, targetPower: null }, fiveGhzSettings: { channel: null, channelWidth: null, targetPower: null } };
    assert.deepEqual(await ok(sb.get(radio())), auto);
    const manual = await ok(sb.put(radio(), { twoFourGhzSettings: { channel: 11, targetPower: 21 }, fiveGhzSettings: { channel: 149, channelWidth: 20, targetPower: 15 } }));
    assert.deepEqual(manual, { ...auto, twoFourGhzSettings: { channel: 11, targetPower: 21 }, fiveGhzSettings: { channel: 149, channelWidth: 20, targetPower: 15 } });
    assert.deepEqual(await ok(sb.get(radio())), manual);
    assert.equal((await ok(sb.put(radio(), { fiveGhzSettings: { channel: null } }))).fiveGhzSettings.channel, null);
    assert.match(await errorOf(sb.put(radio(), { twoFourGhzSettings: { channel: 15 } })), /channel/);
    assert.match(await errorOf(sb.put(radio(), { fiveGhzSettings: { channel: 38 } })), /channel/);
    assert.match(await errorOf(sb.put(radio(), { fiveGhzSettings: { channelWidth: 30 } })), /channelWidth/);
    assert.match(await errorOf(sb.put(radio(), { fiveGhzSettings: { targetPower: 40 } })), /targetPower/);
    assert.match(await errorOf(sb.put(radio(), { rfProfileId: '1234' })), /does not exist/);

    const p = await ok(sb.post(P(), { name: 'Office' }), 201);
    const set = await ok(sb.put(radio(), { rfProfileId: p.id, fiveGhzSettings: { channel: 36 } }));
    assert.deepEqual(set, { ...auto, rfProfileId: p.id, fiveGhzSettings: { channel: 36, channelWidth: null, targetPower: null } });
  });

  test('the four MX SSIDs follow their auth mode and the network VLANs', async () => {
    fresh();
    const list = await ok(sb.get(S()));
    assert.equal(list.length, 4);
    assert.deepEqual(list[0], { number: 1, name: 'Unconfigured SSID 1', enabled: false, defaultVlanId: 1, authMode: 'open', visible: true });
    assert.equal(await errorOf(sb.get(`${S()}/5`), 404), 'SSID not found');

    const psk = await ok(sb.put(`${S()}/2`, { name: 'Branch', enabled: true, authMode: 'psk', psk: 'secret123', wpaEncryptionMode: 'WPA3 Transition Mode', dot11w: { enabled: true } }));
    assert.deepEqual(psk, { number: 2, name: 'Branch', enabled: true, defaultVlanId: 1, authMode: 'psk', encryptionMode: 'wpa', wpaEncryptionMode: 'WPA3 Transition Mode', visible: true });
    assert.deepEqual(await ok(sb.get(`${S()}/2`)), psk);
    assert.match(await errorOf(sb.put(`${S()}/3`, { authMode: 'psk' })), /psk/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { authMode: 'psk', psk: 'short' })), /8 to 63/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { psk: 'secret123' })), /only valid when authMode is psk/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { encryptionMode: 'wep' })), /encryptionMode/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { wpaEncryptionMode: 'WPA2 only' })), /wpaEncryptionMode/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { authMode: '8021x-radius' })), /radiusServers/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { authMode: '8021x-radius', radiusServers: [{ host: 'radius', port: 1812 }] })), /host/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { authMode: '8021x-radius', radiusServers: [{ host: '10.0.0.5', port: 0 }] })), /port/);
    assert.match(await errorOf(sb.put(`${S()}/3`, { name: ' ' })), /name/);
    const radius = await ok(sb.put(`${S()}/3`, { authMode: '8021x-radius', radiusServers: [{ host: '10.0.0.5', port: 1812, secret: 's' }], visible: false }));
    assert.deepEqual([radius.radiusServers, radius.wpaEncryptionMode, radius.visible, 'encryptionMode' in radius], [[{ host: '10.0.0.5', port: 1812 }], 'WPA2 only', false, false]);
    const wep = await ok(sb.put(`${S()}/2`, { encryptionMode: 'wep', psk: '12345' }));
    assert.deepEqual([wep.encryptionMode, 'wpaEncryptionMode' in wep], ['wep', false]);

    // defaultVlanId names a VLAN; a deleted one, or VLANs turned off, reads as the first VLAN.
    assert.match(await errorOf(sb.put(`${S()}/1`, { defaultVlanId: 99 })), /VLAN 99/);
    assert.equal((await ok(sb.put(`${S()}/1`, { defaultVlanId: 20 }))).defaultVlanId, 20);
    assert.equal((await sb.del(`/networks/${london.id}/appliance/vlans/20`)).status, 204);
    assert.equal((await ok(sb.get(`${S()}/1`))).defaultVlanId, 1);
    await ok(sb.put(`/networks/${london.id}/appliance/vlans/settings`, { vlansEnabled: false }));
    assert.match(await errorOf(sb.put(`${S()}/1`, { defaultVlanId: 10 })), /VLANs are enabled/);
    assert.equal((await ok(sb.get(`${S()}/1`))).defaultVlanId, 1);
  });

  test('a network bound to a template takes the template RF profiles and SSIDs', async () => {
    fresh();
    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'From London', copyFromNetworkId: london.id }), 201);
    await ok(sb.post(`/networks/${london.id}/bind`, { configTemplateId: t.id }));
    assert.match(await errorOf(sb.post(P(), { name: 'x' })), /bound to a config template/);
    assert.match(await errorOf(sb.put(`${S()}/1`, { enabled: true })), /bound to a config template/);
    assert.equal((await ok(sb.get(S()))).length, 4);
    // Radio settings are the device's own.
    assert.equal((await ok(sb.put(radio(), { twoFourGhzSettings: { channel: 6 } }))).twoFourGhzSettings.channel, 6);
  });

  test('vMX authentication tokens come only from vMX appliances and expire in an hour', async () => {
    fresh();
    assert.match(await errorOf(sb.post(`/devices/${hq.mx.serial}/appliance/vmx/authenticationToken`)), /only for vMX/);
    assert.match(await errorOf(sb.post(`/devices/${hq.switches[0].serial}/appliance/vmx/authenticationToken`)), /appliance devices/);
    const net = await ok(sb.post(`/organizations/${org.id}/networks`, { name: 'Cloud', productTypes: ['appliance'] }), 201);
    const vmx = await ok(sb.post(`/networks/${net.id}/devices/claim/vmx`, { size: 'small' }));
    const a = await ok(sb.post(`/devices/${vmx.serial}/appliance/vmx/authenticationToken`), 201);
    assert.match(a.token, /^[0-9a-f]{32}\/[0-9a-f]{13}$/);
    assert.equal(a.expiresAt, '2026-09-29T19:30:00Z');
    const b = await ok(sb.post(`/devices/${vmx.serial}/appliance/vmx/authenticationToken`), 201);
    assert.notEqual(a.token, b.token);
  });
});
