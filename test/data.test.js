import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Rand, hashStr } from '../src/rng.js';
import { networkEventsOnDay } from '../src/sim/events.js';
import { statusChanges } from '../src/sim/outages.js';
import { clientUsage, eachSlot } from '../src/sim/usage.js';
import { DAY, HOUR, iso } from '../src/time.js';
import { buildWorld } from '../src/world.js';
import { NOW, collect, relLink, start } from './helpers.js';

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

  test('Acme Test Lab networks come after the base build and leave it alone', () => {
    const w = buildWorld({ seed: 1, bootTime: BOOT });
    const lab = w.orgs[1];
    const ottawa = lab.networks.find((n) => n.code === 'OTT');
    assert.deepEqual([ottawa.name, ottawa.productTypes, ottawa.mx.model, ottawa.devices.length, ottawa.clients.length, ottawa.vpn], ['Lab - Ottawa', ['appliance'], 'MX68W', 1, 0, null]);
    assert.deepEqual([ottawa.switches, ottawa.aps, ottawa.cameras], [[], [], []]);
    assert.equal(w.networkById.get(ottawa.id), ottawa);
    assert.equal(w.deviceBySerial.get(ottawa.mx.serial), ottawa.mx);
    assert.ok(lab.devices.includes(ottawa.mx) && !lab.baseNetworks.includes(ottawa));
    const license = lab.licenses.find((l) => l.deviceSerial === ottawa.mx.serial);
    assert.equal(license.networkId, ottawa.id);
    assert.ok(ottawa.mx.orderNumber && ottawa.mx.claimedAt < license.activationDate);
    const taken = [...w.orgs.flatMap((o) => o.spares), ...w.unclaimed.devices].map((s) => s.serial);
    assert.equal(new Set(w.devices.map((d) => d.serial)).size, w.devices.length);
    assert.ok(!taken.includes(ottawa.mx.serial));
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

describe('client usage', () => {
  const world = buildWorld({ seed: 1, bootTime: BOOT });
  const total = (u) => u.sent + u.recv;

  test('cached totals match a walk over every slot, in any order', () => {
    // One client of each kind, so every schedule and time zone is covered.
    const kinds = new Map();
    for (const c of world.clients) if (!kinds.has(c.kindName)) kinds.set(c.kindName, c);
    const r = new Rand(hashStr('usage windows'));
    const from = Date.parse('2026-02-15T00:00:00Z') / 1000;
    const to = Date.parse('2026-11-15T00:00:00Z') / 1000;
    for (let i = 0; i < 600; i++) {
      const c = r.pick([...kinds.values()]);
      // Short, multi-day and long windows that start and end at any second.
      const x = r.next();
      const span = Math.floor(r.next() * (x < 0.3 ? 2 * HOUR : x < 0.6 ? 3 * DAY : 40 * DAY)) + 1;
      const a = from + Math.floor(r.next() * (to - from));
      let sent = 0;
      let recv = 0;
      eachSlot(c, a, a + span, (slot, s, rv) => {
        sent += s;
        recv += rv;
      });
      const got = clientUsage(c, a, a + span);
      const msg = `${c.kindName} ${new Date(a * 1000).toISOString()} +${span}s`;
      assert.ok(Math.abs(got.sent - sent) <= 1e-9 * Math.max(1, sent), msg);
      assert.ok(Math.abs(got.recv - recv) <= 1e-9 * Math.max(1, recv), msg);
    }
  });

  test('backups follow local time through a DST change', () => {
    // The NAS backs up from 2:00 to 3:30 local time, every day.
    const nas = world.clients.find((c) => c.kindName === 'nas');
    const zone = nas.net.zone;
    for (const date of ['2026-03-08', '2026-11-01']) {
      const day = Date.parse(date) / 1000 / DAY;
      const hours = [];
      for (let t = zone.midnight(day); t < zone.midnight(day + 1); t += HOUR) hours.push({ local: Math.floor(zone.hourOf(t)), kb: total(clientUsage(nas, t, t + HOUR)) });
      const median = hours.map((h) => h.kb).sort((a, b) => a - b)[hours.length >> 1];
      const busy = hours.filter((h) => h.kb > 50 * median).map((h) => h.local);
      assert.ok(busy.length && busy.every((h) => h === 2 || h === 3), `${date}: busy at ${busy}`);
    }
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

  test('backward paging with rel=prev returns every event exactly once', async () => {
    const day = networkEventsOnDay(net, Math.floor(Date.parse(t0) / 86400000)).filter((e) => e.productType === 'switch');
    let url = `/networks/${net.id}/events?productType=switch&perPage=100&endingBefore=${t1}`;
    const got = [];
    for (let i = 0; i < 50; i++) {
      const r = await sb.get(url);
      const inDay = r.body.events.filter((e) => e.occurredAt >= t0);
      got.push(...inDay);
      if (inDay.length < r.body.events.length) break;
      url = relLink(r.link, 'prev');
    }
    assert.equal(got.length, day.length);
    assert.equal(new Set(got.map((e) => e.occurredAt)).size, got.length);
    assert.ok(got.every((e) => e.occurredAt < t1));
  });

  test('security events page through the window in either order', async () => {
    const path = `/networks/${net.id}/appliance/security/events?perPage=3&timespan=${7 * 86400}`;
    const up = (await collect(sb.get, path)).map((e) => e.ts);
    assert.ok(up.length > 3, 'more than one page');
    assert.deepEqual(up, [...up].sort());
    assert.equal(new Set(up).size, up.length);
    const down = (await collect(sb.get, `${path}&sortOrder=descending`)).map((e) => e.ts);
    assert.deepEqual(down, [...up].reverse());
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

describe('timestamps', () => {
  test('iso matches toISOString to the second', () => {
    const slow = (t) => new Date(Math.floor(t) * 1000).toISOString().slice(0, 19) + 'Z';
    const edges = [0, -0.5, 59.9, 3599, 86399.99, 86400, -86401, BOOT, BOOT + 0.7, -62167219200, -62167219201, 253402300799, 253402300800];
    const r = new Rand(hashStr('iso'));
    const random = Array.from({ length: 20000 }, () => (r.next() - 0.2) * 1e11);
    for (const t of [...edges, ...random]) assert.equal(iso(t), slow(t), String(t));
    assert.throws(() => iso(NaN), RangeError);
  });
});
