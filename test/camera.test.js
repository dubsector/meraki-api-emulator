import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, start } from './helpers.js';

const T = Date.parse(NOW) / 1000;
const at = (s) => new Date((T + s) * 1000).toISOString().slice(0, 19) + 'Z';

describe('cameras and MQTT brokers', () => {
  let sb;
  let hq;
  let austin;
  let cam;
  let C;
  let N;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    const org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    cam = hq.cameras[0];
    C = `/devices/${cam.serial}/camera`;
    N = `/networks/${hq.id}`;
  };
  const errorOf = async (r) => {
    const res = await r;
    assert.equal(res.status, 400, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const newBroker = async (body = {}) => {
    const r = await sb.post(`${N}/mqttBrokers`, { name: 'Sense', host: 'mqtt.example.com', port: 8883, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const newProfile = async (body = {}) => {
    const r = await sb.post(`${N}/camera/qualityRetentionProfiles`, { name: 'Lobby', ...body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };

  test('per-camera settings start at the defaults and refuse other products', async () => {
    fresh();
    assert.deepEqual((await sb.get(`${C}/qualityAndRetention`)).body, {
      profileId: null,
      motionBasedRetentionEnabled: false,
      audioRecordingEnabled: false,
      restrictedBandwidthModeEnabled: false,
      quality: 'Standard',
      resolution: '1280x720',
      motionDetectorVersion: 2,
    });
    assert.deepEqual((await sb.get(`${C}/video/settings`)).body, { externalRtspEnabled: false });
    assert.deepEqual((await sb.get(`${C}/sense`)).body, { senseEnabled: false, mqttBrokerId: null, mqttTopics: [], audioDetection: { enabled: false }, detectionModelId: '0' });
    const models = (await sb.get(`${C}/sense/objectDetectionModels`)).body;
    assert.ok(models.length > 1 && models.every((m) => typeof m.id === 'string' && m.description));
    const sw = hq.switches[0].serial;
    assert.match(await errorOf(sb.get(`/devices/${sw}/camera/sense`)), /only supported for camera devices/);
    assert.match(await errorOf(sb.put(`/devices/${sw}/camera/video/settings`, { externalRtspEnabled: true })), /camera devices/);
    assert.equal((await sb.get('/devices/Q2FV-AAAA-AAAA/camera/sense')).status, 404);
  });

  test('quality and retention checks what the model supports', async () => {
    fresh();
    assert.match(await errorOf(sb.put(`${C}/qualityAndRetention`, { quality: 'Ultra' })), /not supported by MV22/);
    assert.match(await errorOf(sb.put(`${C}/qualityAndRetention`, { quality: 'High', resolution: '3840x2160' })), /Resolution '3840x2160'/);
    assert.match(await errorOf(sb.put(`${C}/qualityAndRetention`, { quality: 'Best' })), /must be one of/);
    // A refused write changes nothing.
    assert.equal((await sb.get(`${C}/qualityAndRetention`)).body.quality, 'Standard');
    const r = await sb.put(`${C}/qualityAndRetention`, { quality: 'High', resolution: '1920x1080', audioRecordingEnabled: true, motionDetectorVersion: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.quality, r.body.resolution, r.body.audioRecordingEnabled, r.body.motionDetectorVersion], ['High', '1920x1080', true, 1]);
    assert.equal((await sb.get(`/devices/${hq.cameras[1].serial}/camera/qualityAndRetention`)).body.quality, 'Standard');
  });

  test('a profile overrides the camera settings until it is unassigned or deleted', async () => {
    fresh();
    await sb.put(`${C}/qualityAndRetention`, { quality: 'High', resolution: '1920x1080' });
    const p = await newProfile({ motionBasedRetentionEnabled: true, maxRetentionDays: 7, videoSettings: { 'MV12/MV22/MV72': { quality: 'Enhanced', resolution: '1280x720' } } });
    assert.match(await errorOf(sb.put(`${C}/qualityAndRetention`, { profileId: '123' })), /does not exist in this network/);
    let q = (await sb.put(`${C}/qualityAndRetention`, { profileId: p.id })).body;
    assert.deepEqual([q.profileId, q.motionBasedRetentionEnabled, q.quality, q.resolution], [p.id, true, 'Enhanced', '1280x720']);
    // Without video settings for the model, the camera keeps its own.
    await sb.put(`${N}/camera/qualityRetentionProfiles/${p.id}`, { videoSettings: { 'MV12/MV22/MV72': null } });
    q = (await sb.get(`${C}/qualityAndRetention`)).body;
    assert.deepEqual([q.quality, q.resolution], ['High', '1920x1080']);
    assert.equal((await sb.del(`${N}/camera/qualityRetentionProfiles/${p.id}`)).status, 204);
    q = (await sb.get(`${C}/qualityAndRetention`)).body;
    assert.deepEqual([q.profileId, q.motionBasedRetentionEnabled, q.quality], [null, false, 'High']);
    q = (await sb.put(`${C}/qualityAndRetention`, { profileId: (await newProfile()).id })).body;
    assert.equal((await sb.put(`${C}/qualityAndRetention`, { profileId: null })).body.profileId, null);
  });

  test('external RTSP adds the stream URL', async () => {
    fresh();
    const r = await sb.put(`${C}/video/settings`, { externalRtspEnabled: true });
    assert.deepEqual(r.body, { externalRtspEnabled: true, rtspUrl: `rtsp://${cam.lanIp}:9000/live` });
    assert.deepEqual((await sb.put(`${C}/video/settings`, { externalRtspEnabled: false })).body, { externalRtspEnabled: false });
  });

  test('sense publishes to a broker in the network and stops when it is deleted', async () => {
    fresh();
    const broker = await newBroker();
    assert.match(await errorOf(sb.put(`${C}/sense`, { mqttBrokerId: '123' })), /MQTT broker 123 does not exist/);
    assert.match(await errorOf(sb.put(`${C}/sense`, { senseEnabled: true, detectionModelId: '99' })), /detection model 99/);
    assert.equal((await sb.get(`${C}/sense`)).body.senseEnabled, false);
    let s = (await sb.put(`${C}/sense`, { mqttBrokerId: broker.id })).body;
    assert.deepEqual([s.mqttBrokerId, s.mqttTopics], [broker.id, []]);
    s = (await sb.put(`${C}/sense`, { senseEnabled: true, audioDetection: { enabled: true }, detectionModelId: '1' })).body;
    assert.ok(s.mqttTopics.every((t) => t.startsWith(`/merakimv/${cam.serial}/`)));
    assert.ok(s.mqttTopics.includes(`/merakimv/${cam.serial}/raw_detections`) && s.mqttTopics.includes(`/merakimv/${cam.serial}/audio_detections`));
    assert.deepEqual([s.audioDetection, s.detectionModelId], [{ enabled: true }, '1']);
    // A broker in another camera network doesn't count.
    const reno = hq.org.networks.find((n) => n.name === 'Warehouse - Reno');
    const other = (await sb.post(`/networks/${reno.id}/mqttBrokers`, { name: 'Yard', host: '10.2.0.9', port: 1883 })).body;
    assert.match(await errorOf(sb.put(`${C}/sense`, { mqttBrokerId: other.id })), /does not exist in this network/);
    assert.equal((await sb.del(`${N}/mqttBrokers/${broker.id}`)).status, 204);
    s = (await sb.get(`${C}/sense`)).body;
    assert.deepEqual([s.senseEnabled, s.mqttBrokerId, s.mqttTopics], [true, null, []]);
    assert.equal((await sb.put(`${C}/sense`, { mqttBrokerId: null })).status, 200);
  });

  test('video links point at the camera and the requested time', async () => {
    fresh();
    const r = await sb.get(`${C}/videoLink?timestamp=${at(-3600)}`);
    assert.equal(r.status, 200);
    const ms = (T - 3600) * 1000;
    assert.ok(r.body.url.startsWith(hq.url.replace('/usage/list', '/nodes/new_list/')) && r.body.url.endsWith(`?timestamp=${ms}`), r.body.url);
    assert.match(r.body.visionUrl, new RegExp(`^https://vision\\.meraki\\.com/n/\\d+/cameras/\\d+\\?ts=${ms}$`));
    assert.ok((await sb.get(`${C}/videoLink`)).body.url.endsWith(`?timestamp=${T * 1000}`));
    assert.match(await errorOf(sb.get(`${C}/videoLink?timestamp=yesterday`)), /ISO 8601/);
  });

  test('snapshots need footage in retention and a camera that is up', async () => {
    fresh();
    const live = await sb.post(`${C}/generateSnapshot`, {});
    assert.equal(live.status, 202);
    assert.match(live.body.url, /^https:\/\/camera\.example\.com\/stream\/jpeg\/snapshot\/[0-9a-f]+$/);
    assert.equal(live.body.expiry, `Access to the image will expire at ${at(1800)}.`);
    assert.deepEqual((await sb.post(`${C}/generateSnapshot`, {})).body, live.body);
    const past = await sb.post(`${C}/generateSnapshot`, { timestamp: at(-86400) });
    assert.equal(past.status, 202);
    assert.notEqual(past.body.url, live.body.url);
    assert.equal((await sb.post(`${C}/generateSnapshot`, { fullframe: true })).status, 202);
    assert.match(await errorOf(sb.post(`${C}/generateSnapshot`, { timestamp: at(-60), fullframe: true })), /fullframe/);
    assert.match(await errorOf(sb.post(`${C}/generateSnapshot`, { timestamp: at(-31 * 86400) })), /30 day retention/);
    assert.match(await errorOf(sb.post(`${C}/generateSnapshot`, { timestamp: at(600) })), /future/);
    assert.match(await errorOf(sb.post(`${C}/generateSnapshot`, { timestamp: 'soon' })), /ISO 8601/);
    // A profile's retention cap applies.
    const p = await newProfile({ maxRetentionDays: 3 });
    await sb.put(`${C}/qualityAndRetention`, { profileId: p.id });
    assert.match(await errorOf(sb.post(`${C}/generateSnapshot`, { timestamp: at(-4 * 86400) })), /3 day retention/);
    const dormant = sb.world.devices.find((d) => d.productType === 'camera' && d.dormant);
    assert.match(await errorOf(sb.post(`/devices/${dormant.serial}/camera/generateSnapshot`, {})), /offline/);
    assert.match(await errorOf(sb.get(`/devices/${dormant.serial}/camera/clip?startTimestamp=${at(-20 * 86400)}&endTimestamp=${at(-20 * 86400 + 60)}`)), /offline/);
  });

  test('clips are up to 5 minutes from one imager', async () => {
    fresh();
    const q = (a, b, extra = '') => `${C}/clip?startTimestamp=${at(a)}&endTimestamp=${at(b)}${extra}`;
    const r = await sb.get(q(-600, -300));
    assert.equal(r.status, 202);
    assert.match(r.body.url, /^https:\/\/camera\.example\.com\/video\/mp4\/clip\/[0-9a-f]+\.mp4$/);
    assert.equal((await sb.get(q(-600, -300, '&imagerId=0'))).status, 202);
    assert.match(await errorOf(sb.get(q(-600, -299))), /at most 5 minutes/);
    assert.match(await errorOf(sb.get(q(-300, -600))), /after 'startTimestamp'/);
    assert.match(await errorOf(sb.get(q(-600, -300, '&imagerId=1'))), /single-imager/);
    assert.match(await errorOf(sb.get(q(-60, 60))), /future/);
    assert.match(await errorOf(sb.get(`${C}/clip?startTimestamp=${at(-60)}`)), /'endTimestamp' is required/);
  });

  test('quality retention profiles', async () => {
    fresh();
    const schedules = (await sb.get(`${N}/camera/schedules`)).body;
    assert.ok(schedules.length > 1 && schedules.every((s) => /^\d+$/.test(s.id) && s.name));
    assert.deepEqual((await sb.get(`${N}/camera/schedules`)).body, schedules);
    assert.deepEqual((await sb.get(`${N}/camera/qualityRetentionProfiles`)).body, []);
    const p = await newProfile({ scheduleId: schedules[0].id, cloudArchiveEnabled: true, smartRetention: { enabled: true }, maxRetentionDays: 14 });
    assert.deepEqual(p, {
      id: p.id,
      networkId: hq.id,
      name: 'Lobby',
      restrictedBandwidthModeEnabled: false,
      motionBasedRetentionEnabled: false,
      audioRecordingEnabled: false,
      cloudArchiveEnabled: true,
      maxRetentionDays: 14,
      scheduleId: schedules[0].id,
      motionDetectorVersion: 2,
      smartRetention: { enabled: true },
      axisVideoQuality: 'standard',
      videoSettings: {},
    });
    assert.deepEqual((await sb.get(`${N}/camera/qualityRetentionProfiles/${p.id}`)).body, p);
    assert.match(await errorOf(sb.post(`${N}/camera/qualityRetentionProfiles`, { name: 'Lobby' })), /already exists/);
    assert.match(await errorOf(sb.post(`${N}/camera/qualityRetentionProfiles`, {})), /'name' is required/);
    assert.match(await errorOf(sb.post(`${N}/camera/qualityRetentionProfiles`, { name: 'x', maxRetentionDays: 0 })), /between 1 and 90/);
    assert.match(await errorOf(sb.post(`${N}/camera/qualityRetentionProfiles`, { name: 'x', scheduleId: '1' })), /Schedule 1/);
    assert.match(await errorOf(sb.post(`${N}/camera/qualityRetentionProfiles`, { name: 'x', videoSettings: { MV32: { quality: 'High', resolution: '1280x720' } } })), /MV32\.resolution/);
    const second = await newProfile({ name: 'Yard' });
    assert.notEqual(second.id, p.id);
    // A refused update changes nothing, even fields that were fine.
    assert.match(await errorOf(sb.put(`${N}/camera/qualityRetentionProfiles/${p.id}`, { name: 'Lobby 2', motionDetectorVersion: 3 })), /1 or 2/);
    assert.equal((await sb.get(`${N}/camera/qualityRetentionProfiles/${p.id}`)).body.name, 'Lobby');
    assert.match(await errorOf(sb.put(`${N}/camera/qualityRetentionProfiles/${p.id}`, { name: 'Yard' })), /already exists/);
    const u = (await sb.put(`${N}/camera/qualityRetentionProfiles/${p.id}`, { name: 'Lobby 2', scheduleId: null, maxRetentionDays: null })).body;
    assert.deepEqual([u.name, u.scheduleId, u.maxRetentionDays, u.cloudArchiveEnabled], ['Lobby 2', null, null, true]);
    assert.equal((await sb.get(`${N}/camera/qualityRetentionProfiles`)).body.length, 2);
    assert.equal((await sb.del(`${N}/camera/qualityRetentionProfiles/${p.id}`)).status, 204);
    assert.equal((await sb.get(`${N}/camera/qualityRetentionProfiles/${p.id}`)).status, 404);
    assert.equal((await sb.del(`${N}/camera/qualityRetentionProfiles/${p.id}`)).status, 404);
    assert.match(await errorOf(sb.get(`/networks/${austin.id}/camera/qualityRetentionProfiles`)), /product type 'camera'/);
    assert.match(await errorOf(sb.get(`/networks/${austin.id}/camera/schedules`)), /product type 'camera'/);
  });

  test('MQTT brokers keep their secrets', async () => {
    fresh();
    assert.deepEqual((await sb.get(`${N}/mqttBrokers`)).body, []);
    const b = await newBroker({ security: { mode: 'tls', tls: { caCertificate: 'LS0tLS1CRUdJTg==', verifyHostnames: false } }, authentication: { username: 'cams', password: 'hunter2' } });
    assert.deepEqual(b, { id: b.id, name: 'Sense', host: 'mqtt.example.com', port: 8883, security: { mode: 'tls', tls: { hasCaCertificate: true, verifyHostnames: false } }, authentication: { username: 'cams' } });
    assert.ok(!JSON.stringify((await sb.get(`${N}/mqttBrokers`)).body).includes('hunter2'));
    assert.deepEqual((await sb.get(`${N}/mqttBrokers/${b.id}`)).body, b);
    assert.match(await errorOf(sb.post(`${N}/mqttBrokers`, { name: 'Sense', host: '10.0.0.1', port: 1883 })), /already exists/);
    assert.match(await errorOf(sb.post(`${N}/mqttBrokers`, { name: 'x', host: '10.0.0.1' })), /'port' is required/);
    assert.match(await errorOf(sb.post(`${N}/mqttBrokers`, { name: 'x', host: '10.0.0.1', port: 0 })), /between 1 and 65535/);
    assert.match(await errorOf(sb.post(`${N}/mqttBrokers`, { name: 'x', host: 'not a host', port: 1883 })), /host name or IP/);
    assert.match(await errorOf(sb.post(`${N}/mqttBrokers`, { name: 'x', host: '10.0.0.1', port: 1883, security: { mode: 'ssl' } })), /none, tls/);
    assert.match(await errorOf(sb.put(`${N}/mqttBrokers/${b.id}`, { name: 'Renamed', port: 99999 })), /65535/);
    assert.equal((await sb.get(`${N}/mqttBrokers/${b.id}`)).body.name, 'Sense');
    const u = (await sb.put(`${N}/mqttBrokers/${b.id}`, { port: 1883, security: { mode: 'none', tls: { caCertificate: null } } })).body;
    assert.deepEqual([u.port, u.security, u.authentication], [1883, { mode: 'none', tls: { hasCaCertificate: false, verifyHostnames: false } }, { username: 'cams' }]);
    assert.equal((await sb.del(`${N}/mqttBrokers/${b.id}`)).status, 204);
    assert.equal((await sb.get(`${N}/mqttBrokers/${b.id}`)).status, 404);
    assert.equal((await sb.get(`/networks/${austin.id}/mqttBrokers`)).status, 200);
    const mx = (await sb.post(`/organizations/${austin.org.id}/networks`, { name: 'MX only', productTypes: ['appliance'] })).body;
    assert.match(await errorOf(sb.get(`/networks/${mx.id}/mqttBrokers`)), /'camera', 'sensor' or 'wireless'/);
  });

  test('reset clears camera settings, profiles and brokers', async () => {
    fresh();
    const broker = await newBroker();
    await newProfile();
    await sb.put(`${C}/video/settings`, { externalRtspEnabled: true });
    assert.equal((await sb.reset()).status, 204);
    fresh();
    assert.deepEqual((await sb.get(`${N}/mqttBrokers`)).body, []);
    assert.deepEqual((await sb.get(`${N}/camera/qualityRetentionProfiles`)).body, []);
    assert.equal((await sb.get(`${C}/video/settings`)).body.externalRtspEnabled, false);
    // The same calls give the same IDs after a reset.
    assert.equal((await newBroker()).id, broker.id);
  });
});
