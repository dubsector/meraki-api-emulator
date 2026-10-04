import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { ROUTES } from '../src/server.js';
import { deviceOutagesOnDay } from '../src/sim/outages.js';
import { DAY } from '../src/time.js';
import { claimDevice, swapDevice } from '../src/world.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('sensors', () => {
  let sb;
  let lab;
  let mtl;
  let sensor;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    mtl = lab.networks.find((n) => n.name === 'Lab - Montreal');
    sensor = (model) => mtl.devices.find((d) => d.model === model);
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
  const O = () => `/organizations/${lab.id}/sensor`;
  const P = () => `/networks/${mtl.id}/sensor/alerts/profiles`;
  const hot = (serials, extra = {}) => ({ name: 'Hot', conditions: [{ metric: 'temperature', threshold: { temperature: { celsius: -100 } }, direction: 'above', duration: 0 }], serials, ...extra });

  test('Lab - Montreal has a gateway AP and a sensor of each kind', async () => {
    fresh();
    const net = await ok(sb.get(`/networks/${mtl.id}`));
    assert.deepEqual(net.productTypes, ['wireless', 'sensor']);
    const devices = await ok(sb.get(`/networks/${mtl.id}/devices`));
    assert.deepEqual(devices.map((d) => d.model).sort(), ['CW9166I', 'MT10', 'MT10', 'MT11', 'MT12', 'MT14', 'MT15', 'MT20', 'MT30', 'MT40']);
    for (const d of devices.filter((x) => x.productType === 'sensor')) {
      assert.match(d.serial, /^Q3CA-/);
      assert.equal(d.lanIp, null);
      assert.equal(d.firmware, 'sensor-2-6');
    }
    const statuses = await ok(sb.get(`/organizations/${lab.id}/devices/statuses?productTypes[]=sensor`));
    assert.equal(statuses.length, 9);
    // Sensors have no addressing of their own, report no memory and pass no traffic.
    assert.ok(statuses.every((x) => x.lanIp === null && x.publicIp === null && x.gateway === null && x.ipType === null));
    const addresses = await ok(sb.get(`/organizations/${lab.id}/devices/uplinks/addresses/byDevice?productTypes[]=sensor`));
    assert.deepEqual(addresses.map((x) => x.uplinks), Array(9).fill([]));
    const memory = await collect(sb.get, `/organizations/${lab.id}/devices/system/memory/usage/history/byInterval`);
    assert.ok(memory.length && memory.every((x) => !x.serial.startsWith('Q3CA-')));
    const top = await ok(sb.get(`/organizations/${lab.id}/summary/top/devices/byUsage`));
    assert.ok(top.every((x) => x.productType !== 'sensor'));
    assert.match(await errorOf(sb.get(`/devices/${sensor('MT10').serial}/managementInterface`)), /no management interface/);
  });

  test('the latest readings are the history\'s last point for each metric', async () => {
    fresh();
    const latest = await ok(sb.get(`${O()}/readings/latest`));
    assert.deepEqual(latest.map((x) => x.serial), mtl.devices.filter((d) => d.productType === 'sensor').map((d) => d.serial).sort());
    const history = await collect(sb.get, `${O()}/readings/history?timespan=604800&perPage=1000`);
    for (const item of latest) {
      for (const r of item.readings) {
        if (r.metric === 'button' || r.metric === 'door') continue;
        const last = history.filter((h) => h.serial === item.serial && h.metric === r.metric).at(-1);
        assert.deepEqual(last, { serial: item.serial, network: item.network, ...r }, `${item.serial} ${r.metric}`);
      }
    }
    const mt15 = latest.find((x) => x.serial === sensor('MT15').serial);
    assert.deepEqual(mt15.readings.map((r) => r.metric), ['co2', 'humidity', 'indoorAirQuality', 'noise', 'pm25', 'temperature', 'tvoc']);
    const freezer = latest.find((x) => x.serial === sensor('MT11').serial).readings.find((r) => r.metric === 'temperature');
    assert.ok(freezer.temperature.celsius < -15);
    assert.equal(freezer.temperature.fahrenheit, Math.round((freezer.temperature.celsius * 1.8 + 32) * 100) / 100);
  });

  test('history pages, filters and refuses bad input', async () => {
    fresh();
    const all = await ok(sb.get(`${O()}/readings/history`));
    assert.ok(all.length > 50);
    assert.deepEqual(await collect(sb.get, `${O()}/readings/history?perPage=3`), all);
    const ts = all.map((r) => r.ts);
    assert.deepEqual([...ts].sort(), ts);
    assert.ok(ts.every((t) => Date.parse(t) / 1000 >= now - 7200 && Date.parse(t) / 1000 <= now));
    const water = await ok(sb.get(`${O()}/readings/history?metrics[]=water&timespan=86400`));
    assert.equal(water.length, 24);
    assert.ok(water.every((r) => r.water.present === false && r.serial === sensor('MT12').serial));
    assert.deepEqual(await ok(sb.get(`${O()}/readings/history?networkIds[]=${lab.networks[0].id}`)), []);
    const one = await ok(sb.get(`${O()}/readings/history?serials[]=${sensor('MT20').serial}&timespan=604800`));
    assert.ok(one.length && one.every((r) => r.metric === 'door' || r.metric === 'battery'));
    assert.match(await errorOf(sb.get(`${O()}/readings/history?metrics[]=bogus`)), /metrics/);
    assert.match(await errorOf(sb.get(`${O()}/readings/history?timespan=700000`)), /timespan/);
    assert.match(await errorOf(sb.get(`${O()}/readings/history?perPage=2`)), /perPage/);
  });

  test('a sensor that is down reports nothing', async () => {
    fresh();
    let found = null;
    for (const d of mtl.devices.filter((x) => x.productType === 'sensor')) {
      for (let day = Math.floor(now / DAY) - 1; day > Math.floor(now / DAY) - 300 && !found; day--) {
        const o = deviceOutagesOnDay(d, day).find(([a, b]) => b - a > 1200 && b < now);
        if (o) found = { d, o };
      }
    }
    assert.ok(found);
    const [a, b] = found.o;
    const rows = await ok(sb.get(`${O()}/readings/history?serials[]=${found.d.serial}&t0=${Math.floor(a) - 3600}&t1=${Math.ceil(b) + 3600}`));
    assert.ok(rows.length);
    assert.ok(rows.every((r) => Date.parse(r.ts) / 1000 < a || Date.parse(r.ts) / 1000 >= b));
  });

  test('every sensor connects to the AP in its network', async () => {
    fresh();
    const r = await ok(sb.get(`${O()}/gateways/connections/latest`));
    assert.equal(r.items.length, 9);
    assert.deepEqual(r.meta.counts.items, { total: 9, remaining: 0 });
    const ap = mtl.aps[0];
    for (const x of r.items) {
      assert.deepEqual(x.gateway, { serial: ap.serial, name: ap.name, mac: ap.mac });
      assert.ok(x.rssi <= -45 && x.rssi > -85);
      assert.ok(Date.parse(x.lastConnectedAt) <= Date.parse(x.lastReportedAt));
    }
    const one = await ok(sb.get(`${O()}/gateways/connections/latest?sensorSerials[]=${sensor('MT40').serial}`));
    assert.deepEqual(one.items.map((x) => x.sensor.serial), [sensor('MT40').serial]);
    assert.deepEqual(await collect(sb.get, `${O()}/gateways/connections/latest?perPage=3`), r.items);
  });

  test('alert profiles are created, read, updated and deleted', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(P())), []);
    const body = {
      name: 'Server room',
      conditions: [
        { metric: 'temperature', threshold: { temperature: { fahrenheit: 80.6 } }, direction: 'above', duration: 300 },
        { metric: 'noise', threshold: { noise: { ambient: { quality: 'poor' } } } },
        { metric: 'door', threshold: { door: { open: true } }, duration: 60 },
      ],
      recipients: { emails: ['ops@example.com'], smsNumbers: ['+15555550100'] },
      serials: [sensor('MT10').serial, sensor('MT20').serial],
      message: 'Check the room',
    };
    const p = await ok(sb.post(P(), body));
    assert.match(p.profileId, /^\d{18}$/);
    assert.deepEqual(p.conditions, [
      { metric: 'temperature', threshold: { temperature: { celsius: 27, fahrenheit: 80.6 } }, direction: 'above', duration: 300 },
      { metric: 'noise', threshold: { noise: { ambient: { quality: 'poor' } } }, duration: 0 },
      { metric: 'door', threshold: { door: { open: true } }, duration: 60 },
    ]);
    assert.deepEqual(p.recipients, { emails: ['ops@example.com'], smsNumbers: ['+15555550100'], httpServerIds: [] });
    assert.equal(p.includeSensorUrl, true);
    assert.deepEqual(await ok(sb.get(`${P()}/${p.profileId}`)), p);
    assert.deepEqual(await ok(sb.get(P())), [p]);
    // Its own answer goes back unchanged.
    assert.deepEqual(await ok(sb.put(`${P()}/${p.profileId}`, p)), p);
    const renamed = await ok(sb.put(`${P()}/${p.profileId}`, { name: 'Renamed', serials: [], includeSensorUrl: false }));
    assert.deepEqual([renamed.name, renamed.serials, renamed.includeSensorUrl, renamed.conditions], ['Renamed', [], false, p.conditions]);
    assert.match(await errorOf(sb.post(P(), { ...body, name: 'Renamed' })), /already exists/);
    assert.equal((await sb.del(`${P()}/${p.profileId}`)).status, 204);
    await errorOf(sb.get(`${P()}/${p.profileId}`), 404);
    await errorOf(sb.get(`/networks/${lab.networks[0].id}/sensor/alerts/profiles`));
  });

  test('alert profiles refuse bad conditions and recipients', async () => {
    fresh();
    const cond = (c) => sb.post(P(), { name: 'x', conditions: [c] });
    assert.match(await errorOf(cond({ metric: 'temperature', threshold: { humidity: { relativePercentage: 50 } }, direction: 'above' })), /matching/);
    assert.match(await errorOf(cond({ metric: 'temperature', threshold: { temperature: { celsius: 30 } } })), /direction/);
    assert.match(await errorOf(cond({ metric: 'door', threshold: { door: { open: true } }, direction: 'above' })), /direction/);
    assert.match(await errorOf(cond({ metric: 'door', threshold: { door: { open: false } } })), /must be true/);
    assert.match(await errorOf(cond({ metric: 'co2', threshold: { co2: {} } })), /needs one of/);
    assert.match(await errorOf(cond({ metric: 'co2', threshold: { co2: { concentration: 900, quality: 'poor' } } })), /not both/);
    assert.match(await errorOf(cond({ metric: 'voltage', threshold: { voltage: { level: 300 } }, direction: 'above' })), /between 0 and 250/);
    assert.match(await errorOf(sb.post(P(), { name: 'x', conditions: [] })), /must not be empty/);
    assert.match(await errorOf(sb.post(P(), { ...hot([]), schedule: { id: '5' } })), /schedule/);
    assert.match(await errorOf(sb.post(P(), hot([mtl.aps[0].serial]))), /not a sensor in this network/);
    assert.match(await errorOf(sb.post(P(), hot([], { recipients: { httpServerIds: ['aHR0cHM6Ly93d3cuZXhhbXBsZS5jb20='] } }))), /webhook HTTP servers/);
    assert.match(await errorOf(sb.post(P(), hot([], { recipients: { emails: ['nope'] } }))), /email/);
    // Webhook servers of the network are taken.
    const server = await ok(sb.post(`/networks/${mtl.id}/webhooks/httpServers`, { name: 'Hook', url: 'https://hooks.example.com/mt' }), 201);
    const p = await ok(sb.post(P(), hot([], { recipients: { httpServerIds: [server.id] } })));
    assert.deepEqual(p.recipients.httpServerIds, [server.id]);
    assert.deepEqual(await ok(sb.get(P())), [p]);
  });

  test('the current overview counts sensors breaking a condition now', async () => {
    fresh();
    const empty = await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/current/overview/byMetric`));
    assert.deepEqual(empty.supportedMetrics, ['apparentPower', 'co2', 'current', 'door', 'frequency', 'humidity', 'indoorAirQuality', 'noise', 'pm25', 'powerFactor', 'realPower', 'temperature', 'tvoc', 'voltage', 'water']);
    assert.equal(empty.counts.temperature, 0);
    assert.deepEqual(empty.counts.noise, { ambient: 0 });
    const temps = mtl.devices.filter((d) => d.info.metrics?.includes('temperature')).map((d) => d.serial);
    await ok(sb.post(P(), hot(temps)));
    await ok(sb.post(P(), { name: 'Freezer', conditions: [{ metric: 'temperature', threshold: { temperature: { celsius: -100 } }, direction: 'above' }], serials: [temps[0]] }));
    const now1 = await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/current/overview/byMetric`));
    assert.equal(now1.counts.temperature, temps.length);
    assert.equal(now1.counts.humidity, 0);
  });

  test('the overview over time counts each breaking run from the history', async () => {
    fresh();
    const door = sensor('MT20');
    await ok(sb.post(P(), { name: 'Door', conditions: [{ metric: 'door', threshold: { door: { open: true } } }], serials: [door.serial] }));
    const opens = (await ok(sb.get(`${O()}/readings/history?serials[]=${door.serial}&metrics[]=door&timespan=604800`))).filter((r) => r.door.open);
    const week = await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric`));
    assert.equal(week.length, 1);
    assert.equal(week[0].counts.door, opens.length);
    assert.equal(week[0].endTs, '2026-09-29T18:29:59Z');
    const days = await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric?timespan=604800&interval=86400`));
    assert.equal(days.length, 7);
    assert.equal(days.reduce((a, x) => a + x.counts.door, 0), opens.length);
    // Without an interval the span picks the largest that fits.
    assert.equal((await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric?timespan=7200`))).length, 2);
    // A door left open a minute alerts less often than any opening.
    await ok(sb.put(`${P()}/${(await ok(sb.get(P())))[0].profileId}`, { conditions: [{ metric: 'door', threshold: { door: { open: true } }, duration: 60 }] }));
    const longer = await ok(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric`));
    assert.ok(longer[0].counts.door < opens.length);
    assert.match(await errorOf(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric?interval=60`)), /interval/);
    assert.match(await errorOf(sb.get(`/networks/${mtl.id}/sensor/alerts/overview/byMetric?timespan=40000000`)), /timespan/);
  });

  test('commands run on the right sensors and change what an MT40 reports', async () => {
    fresh();
    const mt40 = sensor('MT40').serial;
    const C = `/devices/${mt40}/sensor/commands`;
    assert.match(await errorOf(sb.post(`/devices/${sensor('MT10').serial}/sensor/commands`, { operation: 'disableDownstreamPower' })), /MT40/);
    assert.match(await errorOf(sb.post(`/devices/${sensor('MT10').serial}/sensor/commands`, { operation: 'refreshData' })), /MT15 and MT40/);
    assert.match(await errorOf(sb.post(`/devices/${mtl.aps[0].serial}/sensor/commands`, { operation: 'refreshData' })), /sensor devices/);
    assert.match(await errorOf(sb.post(C, {})), /operation/);
    const c = await ok(sb.post(C, { operation: 'disableDownstreamPower' }), 201);
    assert.match(c.commandId, /^\d{13}$/);
    assert.deepEqual({ ...c, createdBy: undefined }, { commandId: c.commandId, createdAt: NOW, completedAt: NOW, createdBy: undefined, operation: 'disableDownstreamPower', status: 'completed', errors: [] });
    assert.equal(c.createdBy.name, 'API Integration');
    assert.deepEqual(await ok(sb.get(`${C}/${c.commandId}`)), c);
    await errorOf(sb.get(`${C}/1284392014819`), 404);
    const latest = (await ok(sb.get(`${O()}/readings/latest?serials[]=${mt40}&metrics[]=realPower&metrics[]=downstreamPower`)))[0].readings;
    assert.deepEqual(latest, [
      { ts: '2026-09-29T18:30:00.000000Z', metric: 'downstreamPower', downstreamPower: { enabled: false } },
      { ts: '2026-09-29T18:30:00.000000Z', metric: 'realPower', realPower: { draw: 0 } },
    ]);
    const refresh = await ok(sb.post(C, { operation: 'refreshData' }), 201);
    assert.deepEqual((await ok(sb.get(C))).map((x) => x.commandId), [refresh.commandId, c.commandId]);
    assert.deepEqual((await ok(sb.get(`${C}?sortOrder=ascending&operations[]=refreshData`))).map((x) => x.commandId), [refresh.commandId]);
    assert.match(await errorOf(sb.get(`${C}?operations[]=reboot`)), /operations/);
  });

  test('livestream roles link sensors and cameras in one network', async () => {
    fresh();
    const cam = claimDevice(sb.world, mtl, { serial: 'Q2FV-TEST-0001', model: 'MV22', mac: '34:56:fe:00:00:01', orderNumber: null, claimedAt: now - DAY, tags: [], name: 'CAM-MTL' });
    const mt10 = sensor('MT10').serial;
    const R = (s) => `/devices/${s}/sensor/relationships`;
    assert.deepEqual(await ok(sb.get(R(mt10))), { livestream: { relatedDevices: [] } });
    const set = await ok(sb.put(R(mt10), { livestream: { relatedDevices: [{ serial: cam.serial }, { serial: cam.serial }] } }));
    assert.deepEqual(set, { livestream: { relatedDevices: [{ serial: cam.serial, productType: 'camera' }] } });
    assert.deepEqual(await ok(sb.get(R(cam.serial))), { livestream: { relatedDevices: [{ serial: mt10, productType: 'sensor' }] } });
    const list = await ok(sb.get(`/networks/${mtl.id}/sensor/relationships`));
    assert.equal(list.length, 10);
    assert.deepEqual(list.find((x) => x.device.serial === cam.serial), { device: { name: 'CAM-MTL', serial: cam.serial, productType: 'camera' }, relationships: { livestream: { relatedDevices: [{ serial: mt10, productType: 'sensor' }] } } });
    // A camera's PUT sets which sensors name it.
    const mt40 = sensor('MT40').serial;
    await ok(sb.put(R(cam.serial), { livestream: { relatedDevices: [{ serial: mt40 }] } }));
    assert.deepEqual(await ok(sb.get(R(mt10))), { livestream: { relatedDevices: [] } });
    assert.deepEqual((await ok(sb.get(R(mt40)))).livestream.relatedDevices, [{ serial: cam.serial, productType: 'camera' }]);
    assert.match(await errorOf(sb.put(R(mt10), { livestream: { relatedDevices: [{ serial: mt40 }] } })), /camera in this device's network/);
    const hqCam = sb.world.orgs[0].networks[0].cameras[0].serial;
    assert.match(await errorOf(sb.put(R(mt10), { livestream: { relatedDevices: [{ serial: hqCam }] } })), /camera in this device's network/);
    assert.match(await errorOf(sb.get(R(mtl.aps[0].serial))), /sensor and camera/);
    // Removing the camera drops it from the roles.
    assert.equal((await sb.post(`/networks/${mtl.id}/devices/remove`, { serial: cam.serial })).status, 204);
    assert.deepEqual(await ok(sb.get(R(mt40))), { livestream: { relatedDevices: [] } });
    // HQ has cameras and no sensors.
    const hq = sb.world.orgs[0].networks[0];
    assert.equal((await ok(sb.get(`/networks/${hq.id}/sensor/relationships`))).length, hq.cameras.length);
  });

  test('one MQTT broker at a time gets sensor data', async () => {
    fresh();
    const M = `/networks/${mtl.id}/sensor/mqttBrokers`;
    assert.deepEqual(await ok(sb.get(M)), []);
    const a = await ok(sb.post(`/networks/${mtl.id}/mqttBrokers`, { name: 'a', host: 'a.example.com', port: 1883 }), 201);
    const b = await ok(sb.post(`/networks/${mtl.id}/mqttBrokers`, { name: 'b', host: 'b.example.com', port: 1883 }), 201);
    assert.deepEqual(await ok(sb.get(M)), [{ mqttBrokerId: a.id, enabled: false }, { mqttBrokerId: b.id, enabled: false }]);
    assert.deepEqual(await ok(sb.put(`${M}/${a.id}`, { enabled: true })), { mqttBrokerId: a.id, enabled: true });
    assert.match(await errorOf(sb.put(`${M}/${b.id}`, { enabled: true })), /Only one/);
    assert.match(await errorOf(sb.put(`${M}/${b.id}`, {})), /enabled/);
    await ok(sb.put(`${M}/${a.id}`, { enabled: false }));
    await ok(sb.put(`${M}/${b.id}`, { enabled: true }));
    assert.deepEqual(await ok(sb.get(`${M}/${b.id}`)), { mqttBrokerId: b.id, enabled: true });
    await errorOf(sb.get(`${M}/1234`), 404);
    await errorOf(sb.get(`/networks/${lab.networks[0].id}/sensor/mqttBrokers`));
  });

  test('profiles follow a sensor swap and the network through split and combine', async () => {
    fresh();
    const mt10 = sensor('MT10');
    const p = await ok(sb.post(P(), hot([mt10.serial])));
    swapDevice(sb.world, mt10, { serial: 'Q3CA-TEST-0001', model: 'MT10', mac: 'c4:8b:a3:00:00:01', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    assert.deepEqual((await ok(sb.get(`${P()}/${p.profileId}`))).serials, ['Q3CA-TEST-0001']);
    const parts = (await ok(sb.post(`/networks/${mtl.id}/split`))).resultingNetworks;
    const part = parts.find((n) => n.productTypes[0] === 'sensor');
    assert.deepEqual((await ok(sb.get(`/networks/${part.id}/sensor/alerts/profiles`))).map((x) => x.serials), [['Q3CA-TEST-0001']]);
    const back = await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Montreal', networkIds: parts.map((n) => n.id) }));
    const id = back.resultingNetwork.id;
    assert.deepEqual((await ok(sb.get(`/networks/${id}/sensor/alerts/profiles`))).map((x) => x.serials), [['Q3CA-TEST-0001']]);
    // Every network and device read answers on the combined network.
    for (const r of ROUTES.filter((x) => x.method === 'GET' && /^\/(networks\/\{networkId\}|devices\/\{serial\})[^{]*$/.test(x.path))) {
      for (const d of r.path.includes('{serial}') ? sb.world.networkById.get(id).devices : [null]) {
        const url = r.path.replace('{networkId}', id).replace('{serial}', d?.serial);
        const res = await sb.get(url);
        assert.ok(res.status < 500, `${url}: ${res.status}`);
      }
    }
  });

  test('a sensor swapped for another model reports its own metrics, with no commands', async () => {
    fresh();
    const mt40 = sensor('MT40');
    const L = (serial) => `${O()}/readings/latest?serials[]=${serial}`;
    await ok(sb.post(`/devices/${mt40.serial}/sensor/commands`, { operation: 'disableDownstreamPower' }), 201);
    await ok(sb.get(L(mt40.serial)));
    swapDevice(sb.world, mt40, { serial: 'Q3CA-TEST-0002', model: 'MT10', mac: 'c4:8b:a3:00:00:02', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    const readings = (await ok(sb.get(L('Q3CA-TEST-0002'))))[0].readings;
    assert.deepEqual(readings.map((r) => r.metric), ['battery', 'humidity', 'temperature']);
    for (const r of readings) assert.ok(now - Date.parse(r.ts) / 1000 <= 3600, r.ts);
    assert.deepEqual(await ok(sb.get('/devices/Q3CA-TEST-0002/sensor/commands')), []);
    swapDevice(sb.world, mt40, { serial: 'Q3CA-TEST-0003', model: 'MT40', mac: 'c4:8b:a3:00:00:03', orderNumber: null, claimedAt: now - DAY, tags: [], name: null }, 'remove from network');
    const power = (await ok(sb.get(`${L('Q3CA-TEST-0003')}&metrics[]=downstreamPower`)))[0].readings;
    assert.equal(power[0].downstreamPower.enabled, true);
  });

  test('the outlet stays off once the command that turned it off is no longer kept', async () => {
    fresh();
    const mt40 = sensor('MT40').serial;
    const C = `/devices/${mt40}/sensor/commands`;
    await ok(sb.post(C, { operation: 'disableDownstreamPower' }), 201);
    for (let i = 0; i < 500; i++) await ok(sb.post(C, { operation: 'refreshData' }), 201);
    assert.ok(!(await collect(sb.get, `${C}?perPage=1000`)).some((c) => c.operation === 'disableDownstreamPower'));
    const latest = (await ok(sb.get(`${O()}/readings/latest?serials[]=${mt40}&metrics[]=downstreamPower&metrics[]=realPower`)))[0].readings;
    assert.deepEqual(latest.map((r) => r.downstreamPower?.enabled ?? r.realPower.draw), [false, 0]);
  });
});

describe('sensor commands on a running clock', () => {
  test('a new command is pending', async () => {
    const sb = await start({ now: null });
    try {
      const mt40 = sb.world.devices.find((d) => d.model === 'MT40');
      const c = (await sb.post(`/devices/${mt40.serial}/sensor/commands`, { operation: 'cycleDownstreamPower' })).body;
      assert.equal(c.status, 'pending');
      assert.equal(c.completedAt, null);
    } finally {
      await sb.close();
    }
  });
});
