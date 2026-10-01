import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { APPS } from '../src/catalog.js';
import { networkEventsOnDay } from '../src/sim/events.js';
import { DAY } from '../src/time.js';
import { NOW, start } from './helpers.js';

const T1 = Date.parse(NOW) / 1000;
const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);

describe('client history', () => {
  let sb;
  let hq;
  before(async () => {
    sb = await start();
    hq = sb.world.orgs[0].networks[0];
  });
  after(() => sb.close());
  const kind = (k) => hq.clients.find((c) => c.kindName === k);

  test('daily usage adds up to the usage the clients list reports', async () => {
    const window = `t0=${T1 - 7 * DAY}&t1=${T1}`;
    const ids = ['laptop', 'phone', 'nas'].map((k) => kind(k).id);
    const listed = (await sb.get(`/networks/${hq.id}/clients?perPage=5000&t0=${T1 - 7 * DAY}`)).body;
    const histories = (await sb.get(`/networks/${hq.id}/clients/usageHistories?clients=${ids.join(',')}&${window}`)).body;
    assert.deepEqual(histories.map((h) => h.clientId), ids);
    for (const h of histories) {
      const row = listed.find((c) => c.id === h.clientId);
      assert.equal(h.clientMac, row.mac);
      assert.ok(Math.abs(sum(h.usageHistory, 'sent') - row.usage.sent) <= 8, h.clientId);
      assert.ok(Math.abs(sum(h.usageHistory, 'received') - row.usage.recv) <= 8, h.clientId);
    }
  });

  test('usage history covers the last 30 days and skips days without traffic', async () => {
    const rows = (await sb.get(`/networks/${hq.id}/clients/${kind('laptop').id}/usageHistory`)).body;
    assert.ok(rows.length > 10 && rows.length <= 30);
    for (const r of rows) assert.ok(r.sent + r.received > 0);
    assert.ok(rows.every((r, i) => i === 0 || r.ts > rows[i - 1].ts));
    assert.ok(Date.parse(rows[0].ts) / 1000 > T1 - 30 * DAY);
    assert.deepEqual((await sb.get(`/networks/${hq.id}/clients/${kind('laptop').mac}/usageHistory`)).body, rows);
  });

  test('traffic history splits each day across applications', async () => {
    const c = kind('laptop');
    const usage = (await sb.get(`/networks/${hq.id}/clients/${c.id}/usageHistory`)).body;
    const traffic = (await sb.get(`/networks/${hq.id}/clients/${c.id}/trafficHistory`)).body;
    const names = new Set(APPS.map((a) => a.application));
    for (const day of usage) {
      const rows = traffic.filter((r) => r.ts === day.ts);
      assert.ok(rows.length > 3, day.ts);
      assert.ok(Math.abs(sum(rows, 'recv') - day.received) <= rows.length, day.ts);
      for (const r of rows) assert.ok(names.has(r.application) && r.numFlows >= 1 && r.activeSeconds <= DAY);
    }
    const page = await sb.get(`/networks/${hq.id}/clients/${c.id}/trafficHistory?perPage=5`);
    assert.deepEqual(page.body, traffic.slice(0, 5));
    assert.match(page.link, /rel=next/);
  });

  test('application usage follows what each kind of client does', async () => {
    const phone = kind('deskPhone');
    const laptop = kind('laptop');
    const r = await sb.get(`/networks/${hq.id}/clients/applicationUsage?clients=${phone.mac},${laptop.ip}&timespan=${7 * DAY}`);
    assert.equal(r.status, 200);
    const [p, l] = r.body;
    assert.deepEqual(p.applicationUsage.map((a) => a.application), ['Webex']);
    assert.equal(l.clientId, laptop.id);
    assert.ok(l.applicationUsage.length > 5);
    const listed = (await sb.get(`/networks/${hq.id}/clients?perPage=5000&timespan=${7 * DAY}`)).body.find((c) => c.id === laptop.id);
    assert.ok(Math.abs(sum(l.applicationUsage, 'received') - listed.usage.recv) <= l.applicationUsage.length);
  });

  test('the clients parameter is required and must name known clients', async () => {
    const path = `/networks/${hq.id}/clients/usageHistories`;
    assert.equal((await sb.get(path)).status, 400);
    assert.equal((await sb.get(`${path}?clients=k000000`)).status, 404);
    const guest = kind('guest');
    const corp = kind('phone');
    const bySsid = (await sb.get(`${path}?clients=${guest.id},${corp.id}&ssidNumber=${guest.ssid.number}`)).body;
    assert.deepEqual(bySsid.map((h) => h.clientId), [guest.id]);
  });
});

describe('lookups', () => {
  let sb;
  let org;
  before(async () => {
    sb = await start();
    org = sb.world.orgs[0];
  });
  after(() => sb.close());

  test('event types cover every event in the log', async () => {
    for (const net of [...org.networks, sb.world.orgs[1].networks[0]]) {
      const types = (await sb.get(`/networks/${net.id}/events/eventTypes`)).body;
      const known = new Map(types.map((t) => [t.type, t.description]));
      assert.equal(known.size, types.length);
      const day = Math.floor(T1 / DAY);
      for (const e of [...networkEventsOnDay(net, day - 1), ...networkEventsOnDay(net, day - 2)]) assert.equal(known.get(e.type), e.description, `${net.code} ${e.type}`);
      if (!net.mx) assert.ok(types.every((t) => !['dhcp_lease', 'port_status'].includes(t.type)), net.code);
    }
  });

  test('layer 7 categories hold what firewall rules and traffic analysis use', async () => {
    const rno = org.networks.find((n) => n.code === 'RNO');
    const { applicationCategories } = (await sb.get(`/networks/${rno.id}/appliance/firewall/l7FirewallRules/applicationCategories`)).body;
    const byId = new Map(applicationCategories.map((c) => [c.id, c]));
    const rules = (await sb.get(`/networks/${rno.id}/appliance/firewall/l7FirewallRules`)).body.rules.filter((r) => r.type === 'applicationCategory');
    assert.ok(rules.length >= 2);
    for (const r of rules) assert.equal(byId.get(r.value.id)?.name, r.value.name);
    assert.equal(byId.get('meraki:layer7/category/8').name, 'Peer-to-peer (P2P)');
    const apps = new Set(applicationCategories.flatMap((c) => c.applications.map((a) => a.name)));
    for (const name of ['Microsoft 365', 'Zoom', 'YouTube', 'Dropbox', 'Windows Update', 'iCloud', 'Amazon AWS']) assert.ok(apps.has(name), name);
    const lab = sb.world.orgs[1].networks[0];
    assert.equal((await sb.get(`/networks/${lab.id}/appliance/firewall/l7FirewallRules/applicationCategories`)).status, 400);
  });

  test('content filtering categories include the blocked ones', async () => {
    const hq = org.networks[0];
    const { categories } = (await sb.get(`/networks/${hq.id}/appliance/contentFiltering/categories`)).body;
    const blocked = (await sb.get(`/networks/${hq.id}/appliance/contentFiltering`)).body.blockedUrlCategories;
    for (const b of blocked) assert.deepEqual(categories.find((c) => c.id === b.id), b);
    assert.equal(new Set(categories.map((c) => c.id)).size, categories.length);
    // A category set by ID comes back with its name.
    const put = await sb.put(`/networks/${hq.id}/appliance/contentFiltering`, { blockedUrlCategories: [categories[0].id] });
    assert.deepEqual(put.body.blockedUrlCategories, [categories[0]]);
    await sb.reset();
  });
});
