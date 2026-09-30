import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { networkEventsOnDay } from '../src/sim/events.js';
import { statusChanges } from '../src/sim/outages.js';
import { DAY } from '../src/time.js';
import { buildWorld } from '../src/world.js';
import { NOW, relLink, start } from './helpers.js';

const BOOT = Date.parse(NOW) / 1000;

function dormantCamera(world) {
  const cam = world.devices.find((d) => d.dormant);
  const onPort = (e) => e.deviceSerial === cam.switchPort.switch.serial && e.eventData.port === cam.switchPort.portId;
  return { cam, portEvents: (day) => networkEventsOnDay(cam.net, day).filter(onPort) };
}

describe('world', () => {
  test('the same seed builds the same world', () => {
    const a = buildWorld({ seed: 7, bootTime: 1.79e9 });
    const b = buildWorld({ seed: 7, bootTime: 1.79e9 });
    assert.deepEqual(a.devices.map((d) => d.serial), b.devices.map((d) => d.serial));
    assert.deepEqual(a.clients.map((c) => c.mac), b.clients.map((c) => c.mac));
  });

  test('a different seed changes IDs but not topology', () => {
    const a = buildWorld({ seed: 1, bootTime: 1.79e9 });
    const b = buildWorld({ seed: 2, bootTime: 1.79e9 });
    assert.notDeepEqual(a.devices.map((d) => d.serial), b.devices.map((d) => d.serial));
    assert.deepEqual(a.devices.map((d) => d.name), b.devices.map((d) => d.name));
  });

  test('every wired client has a switch port', () => {
    const w = buildWorld({ seed: 1, bootTime: 1.79e9 });
    for (const c of w.clients) if (c.wired) assert.ok(c.switchPort, c.description);
  });
});

describe('dormant device', () => {
  // Two months past boot, so random outages would have landed after it went dark.
  const later = BOOT + 60 * DAY;

  test('never comes back online after it goes dark', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { cam } = dormantCamera(buildWorld({ seed, bootTime: BOOT }));
      const changes = statusChanges(cam, cam.dormantSince, later, later);
      assert.deepEqual(changes.map((c) => `${c.from}->${c.to}`), ['online->offline', 'offline->dormant'], `seed ${seed}`);
    }
  });

  test('its switch port goes down once and stays down', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { cam, portEvents } = dormantCamera(buildWorld({ seed, bootTime: BOOT }));
      const events = [];
      for (let d = cam.dormantSince / DAY; d * DAY < later; d++) events.push(...portEvents(d));
      assert.deepEqual(events.map((e) => e.eventData.new), ['down'], `seed ${seed}`);
    }
  });

  test('worlds booted at different times keep separate event caches', () => {
    // Same seed, so same network IDs. A shared cache would hand b the events a computed.
    const a = dormantCamera(buildWorld({ seed: 1, bootTime: BOOT }));
    const b = dormantCamera(buildWorld({ seed: 1, bootTime: BOOT + 30 * DAY }));
    const day = b.cam.dormantSince / DAY;
    assert.equal(a.portEvents(day).length, 0);
    assert.equal(b.portEvents(day).length, 1);
  });
});

describe('data', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('responses are stable for a frozen clock', async () => {
    const other = await start();
    try {
      const net = sb.world.orgs[0].networks[0];
      const path = `/networks/${net.id}/clients/bandwidthUsageHistory?timespan=86400`;
      assert.deepEqual((await sb.get(path)).body, (await other.get(path)).body);
    } finally {
      await other.close();
    }
  });

  test('status overview matches the per-device statuses', async () => {
    const org = sb.world.orgs[0];
    const overview = (await sb.get(`/organizations/${org.id}/devices/statuses/overview`)).body.counts.byStatus;
    const statuses = (await sb.get(`/organizations/${org.id}/devices/statuses`)).body;
    const counted = { online: 0, alerting: 0, offline: 0, dormant: 0 };
    for (const d of statuses) counted[d.status]++;
    assert.deepEqual(overview, counted);
    assert.ok(counted.alerting >= 1, 'the Austin switch is alerting');
    assert.ok(counted.dormant >= 1, 'the Reno yard camera is dormant');
  });

  test('HQ traffic peaks during the working day', async () => {
    const net = sb.world.orgs[0].networks[0];
    const rows = (await sb.get(`/networks/${net.id}/clients/bandwidthUsageHistory?timespan=86400`)).body;
    const at = (hhmm) => rows.find((r) => r.ts.slice(11, 16) === hhmm).downstream;
    // 20:00 UTC is 13:00 in San Francisco, 11:00 UTC is 04:00.
    assert.ok(at('20:00') > 10 * at('11:00'), `${at('20:00')} vs ${at('11:00')}`);
  });

  test('client counts over time never exceed the wireless client total', async () => {
    const net = sb.world.orgs[0].networks[0];
    const wireless = net.clients.filter((c) => !c.wired).length;
    const rows = (await sb.get(`/networks/${net.id}/wireless/clientCountHistory?timespan=86400&resolution=3600`)).body;
    assert.equal(rows.length, 25);
    for (const r of rows) assert.ok(r.clientCount >= 0 && r.clientCount <= wireless);
  });
});

describe('events', () => {
  let sb;
  let net;
  before(async () => {
    sb = await start();
    net = sb.world.orgs[0].networks[0];
  });
  after(() => sb.close());

  const t0 = '2026-09-28T00:00:00Z';
  const t1 = '2026-09-29T00:00:00Z';

  test('a page is newest first with matching pageStartAt and pageEndAt', async () => {
    const r = await sb.get(`/networks/${net.id}/events?productType=wireless&perPage=20`);
    const times = r.body.events.map((e) => e.occurredAt);
    assert.equal(times.length, 20);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.equal(r.body.pageStartAt, times[times.length - 1]);
    assert.equal(r.body.pageEndAt, times[0]);
    assert.ok(r.body.pageEndAt < NOW);
  });

  test('forward paging returns every event exactly once, then empty pages', async () => {
    const day = networkEventsOnDay(net, Math.floor(Date.parse(t0) / 86400000)).filter((e) => e.productType === 'switch');
    let url = `/networks/${net.id}/events?productType=switch&perPage=100&startingAfter=${t0}&endingBefore=${t1}`;
    const got = [];
    let empty = 0;
    for (let i = 0; i < 50 && empty < 2; i++) {
      const r = await sb.get(url);
      if (!r.body.events.length) empty++;
      got.push(...r.body.events.reverse());
      url = relLink(r.link, 'next');
      assert.ok(url, 'the event log always has a next link');
    }
    assert.equal(empty, 2);
    assert.equal(got.length, day.length);
    assert.equal(new Set(got.map((e) => e.occurredAt)).size, got.length);
    assert.ok(got.every((e) => e.occurredAt >= t0 && e.occurredAt < t1));
  });

  test('event filters narrow the results', async () => {
    const ap = net.aps[0];
    const r = await sb.get(`/networks/${net.id}/events?productType=wireless&perPage=50&deviceSerial=${ap.serial}&includedEventTypes[]=association`);
    assert.ok(r.body.events.length > 0);
    for (const e of r.body.events) {
      assert.equal(e.deviceSerial, ap.serial);
      assert.equal(e.type, 'association');
    }
  });

  test('event objects carry every documented key', async () => {
    const r = await sb.get(`/networks/${net.id}/events?productType=appliance&perPage=5`);
    const keys = ['occurredAt', 'networkId', 'type', 'description', 'category', 'clientId', 'clientDescription', 'clientMac', 'deviceSerial', 'deviceName', 'ssidNumber', 'eventData'];
    for (const e of r.body.events) assert.deepEqual(Object.keys(e), keys);
  });
});
