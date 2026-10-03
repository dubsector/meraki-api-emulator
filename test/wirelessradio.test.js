import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('radio overrides, AutoRF and Air Marshal', () => {
  let sb;
  let corp;
  let hq;
  let reno;
  let ap;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    corp = sb.world.orgs[0];
    hq = corp.networks[0];
    reno = corp.networks.find((n) => n.name === 'Warehouse - Reno');
    ap = hq.aps[0];
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
  const O = () => `/devices/${ap.serial}/wireless/radio/overrides`;

  test('overrides start empty and list every radio the AP has', async () => {
    fresh();
    const o = await ok(sb.get(O()));
    assert.equal(o.serial, ap.serial);
    assert.deepEqual(o.network, { id: hq.id });
    assert.deepEqual(o.radios.map((r) => [r.index, r.band]), [['0', '2.4'], ['1', '5'], ['2', '6']]);
    assert.ok(o.radios.every((r) => r.enabled && r.channel === null && r.targetPower === null));
    const settings = await ok(sb.get(`/devices/${ap.serial}/wireless/radio/settings`));
    assert.equal(o.rfProfile.id, settings.rfProfileId);
    assert.equal((await ok(sb.get(`/devices/${reno.aps[0].serial}/wireless/radio/overrides`))).radios.length, 2);
  });

  test('overrides drive the radio settings and status views', async () => {
    fresh();
    const o = await ok(sb.put(O(), { radios: [{ index: '1', channel: 149, channelWidth: 80, targetPower: 17, band: '5' }, { index: '2', enabled: false }] }));
    assert.deepEqual(o.radios[1], { enabled: true, index: '1', band: '5', channel: 149, channelWidth: 80, targetPower: 17 });
    assert.deepEqual(o.radios[2], { enabled: false, index: '2', band: '6', channel: null, channelWidth: null, targetPower: -1 });
    const s = await ok(sb.get(`/devices/${ap.serial}/wireless/radio/settings`));
    assert.deepEqual(s.fiveGhzSettings, { channel: 149, channelWidth: 80, targetPower: 17 });
    const sets = (await ok(sb.get(`/devices/${ap.serial}/wireless/status`))).basicServiceSets;
    const five = sets.find((x) => x.band === '5 GHz');
    assert.equal(five.channelWidth, '80 MHz');
    assert.equal(five.power, '17 dBm');
    assert.ok(sets.filter((x) => x.band === '6 GHz').every((x) => !x.broadcasting && x.power === '-1 dBm'));
    // Radios left out stay as they were; null hands a value back to the profile.
    const again = await ok(sb.put(O(), { radios: [{ index: '1', channel: null }] }));
    assert.equal(again.radios[1].channel, null);
    assert.equal(again.radios[1].targetPower, 17);
    assert.equal(again.radios[2].enabled, false);
    const byDevice = await ok(sb.get(`/organizations/${corp.id}/wireless/radio/overrides/byDevice?serials[]=${ap.serial}`));
    assert.deepEqual(byDevice.items, [again]);
  });

  test('assigning an RF profile clears the overrides', async () => {
    fresh();
    const profile = await ok(sb.post(`/networks/${hq.id}/wireless/rfProfiles`, { name: 'High density', bandSelectionType: 'ap' }), 201);
    await ok(sb.put(O(), { radios: [{ index: '0', channel: 6, targetPower: 10 }, { index: '2', enabled: false }] }));
    const o = await ok(sb.put(O(), { rfProfile: { id: profile.id } }));
    assert.equal(o.rfProfile.id, profile.id);
    assert.equal(o.radios[0].channel, null);
    assert.equal(o.radios[0].targetPower, null);
    assert.equal(o.radios[2].enabled, false);
    const rows = (await ok(sb.get(`/organizations/${corp.id}/wireless/rfProfiles/assignments/byDevice?serials[]=${ap.serial}`)))[0].items;
    assert.deepEqual(rows[0].rfProfile, { id: profile.id, name: 'High density', isIndoorDefault: false, isOutdoorDefault: false });
    assert.match(await errorOf(sb.del(`/networks/${hq.id}/wireless/rfProfiles/${profile.id}`)), /assigned/);
    // A null ID goes back to the basic profile, outdoor for the MR78s.
    const basic = await ok(sb.put(O(), { rfProfile: { id: null } }));
    assert.notEqual(basic.rfProfile.id, profile.id);
    await ok(sb.del(`/networks/${hq.id}/wireless/rfProfiles/${profile.id}`), 204);
  });

  test('override writes check every radio before changing anything', async () => {
    fresh();
    assert.match(await errorOf(sb.put(O(), { radios: [{ index: '1', channel: 149 }, { index: '1', channel: 36 }] })), /more than once/);
    assert.match(await errorOf(sb.put(O(), { radios: [{ index: '1', channel: 149 }, { index: '0', channel: 36 }] })), /2.4 GHz channel/);
    assert.match(await errorOf(sb.put(O(), { radios: [{ index: '0', channelWidth: 40 }] })), /channelWidth/);
    assert.match(await errorOf(sb.put(O(), { radios: [{ index: '1', targetPower: 31 }] })), /targetPower/);
    assert.match(await errorOf(sb.put(`/devices/${reno.aps[0].serial}/wireless/radio/overrides`, { radios: [{ index: '2', channel: 37 }] })), /index/);
    assert.equal((await sb.put(O(), { rfProfile: { id: '1' } })).status, 404);
    assert.ok((await ok(sb.get(O()))).radios.every((r) => r.channel === null));
    assert.match(await errorOf(sb.put(`/devices/${hq.switches[0].serial}/wireless/radio/overrides`, {})), /wireless devices/);
  });

  test('org views page every AP', async () => {
    fresh();
    const aps = corp.devices.filter((d) => d.productType === 'wireless').map((d) => d.serial).sort();
    const rows = await collect(sb.get, `/organizations/${corp.id}/wireless/radio/overrides/byDevice?perPage=3`);
    assert.deepEqual(rows.map((r) => r.serial), aps);
    const first = await ok(sb.get(`/organizations/${corp.id}/wireless/rfProfiles/assignments/byDevice?perPage=3`));
    assert.equal(first.length, 1);
    assert.deepEqual(first[0].meta.counts.items, { total: aps.length, remaining: aps.length - 3 });
    const outdoor = (await ok(sb.get(`/organizations/${corp.id}/wireless/rfProfiles/assignments/byDevice?models[]=MR78`)))[0].items;
    assert.equal(outdoor.length, reno.aps.length);
    assert.ok(outdoor.every((r) => r.rfProfile.isOutdoorDefault));
    assert.deepEqual((await ok(sb.get(`/organizations/${corp.id}/wireless/rfProfiles/assignments/byDevice?productTypes[]=switch`)))[0].items, []);
    assert.equal((await sb.get(`/organizations/${corp.id}/wireless/radio/overrides/byDevice?perPage=101`)).status, 400);
  });

  test('AutoRF settings write per network and read by network', async () => {
    fresh();
    const R = `/networks/${hq.id}/wireless/radio/rrm`;
    const r = await ok(sb.put(R, { ai: { enabled: true }, fra: { enabled: true }, busyHour: { minimizeChanges: { enabled: true }, schedule: { mode: 'manual', manual: { start: '09:00', end: '12:00' } } } }));
    assert.equal(r.timeZone, 'America/Los_Angeles');
    assert.equal(r.ai.lastEnabledAt, '2026-09-29T18:30:00Z');
    assert.deepEqual(r.busyHour.schedule.manual, { start: '09:00', end: '12:00' });
    assert.match(await errorOf(sb.put(R, { ai: { enabled: false } })), /FRA/);
    assert.match(await errorOf(sb.put(R, { busyHour: { schedule: { manual: { start: '9am' } } } })), /whole hour/);
    assert.match(await errorOf(sb.put(R, { busyHour: { schedule: { manual: { start: '12:00' } } } })), /different hours/);
    const list = await ok(sb.get(`/organizations/${corp.id}/wireless/radio/rrm/byNetwork?networkIds[]=${hq.id}`));
    assert.deepEqual(list.items, [r]);
    const all = await ok(sb.get(`/organizations/${corp.id}/wireless/radio/rrm/byNetwork?sortOrder=descending`));
    const ids = all.items.map((x) => x.networkId);
    assert.deepEqual(ids, [...ids].sort().reverse());
    assert.equal(all.meta.counts.items.total, corp.networks.filter((n) => n.productTypes.includes('wireless')).length);
    assert.equal((await sb.get(`/organizations/${corp.id}/wireless/radio/rrm/byNetwork?sortOrder=up`)).status, 400);
  });

  test('channel recalculation checks its networks', async () => {
    fresh();
    const P = `/organizations/${corp.id}/wireless/radio/autoRf/channels/recalculate`;
    assert.deepEqual(await ok(sb.post(P, { networkIds: [hq.id, reno.id] })), { estimatedCompletedAt: '2026-09-29T18:35:00Z' });
    assert.match(await errorOf(sb.post(P, { networkIds: [] })), /at least one/);
    assert.match(await errorOf(sb.post(P, { networkIds: [sb.world.orgs[1].networks[0].id] })), /not in this organization/);
    assert.match(await errorOf(sb.post(P, { networkIds: Array(16).fill(hq.id) })), /15/);
  });

  test('scan results show neighbors, the rogue and the spoof', async () => {
    fresh();
    const A = `/networks/${reno.id}/wireless/airMarshal`;
    const week = await ok(sb.get(A));
    const rogue = week.find((x) => x.wiredMacs.length);
    assert.equal(rogue.ssid, 'NETGEAR-Dock4');
    assert.deepEqual(rogue.types, ['rogue']);
    assert.equal(rogue.bssids[0].detectedBy[0].device, reno.aps.find((a) => a.flaky).serial);
    assert.equal(rogue.wiredLastSeen, rogue.lastSeen);
    assert.deepEqual(week.find((x) => x.ssid === 'Acme-Guest').types, ['spoof']);
    const now = Date.parse('2026-09-29T18:30:00Z') / 1000;
    for (const x of week) {
      assert.ok(x.firstSeen <= x.lastSeen && x.lastSeen <= now && x.lastSeen > now - 7 * 86400, x.ssid);
      assert.ok(x.bssids.every((b) => b.detectedBy.every((d) => reno.aps.some((a) => a.serial === d.device))));
    }
    // Phones and printers drop out of short windows.
    const hour = await ok(sb.get(`${A}?timespan=3600`));
    assert.ok(hour.length <= week.length && hour.every((x) => x.lastSeen > now - 3600));
    assert.deepEqual(await ok(sb.get(A)), week);
    assert.equal((await sb.get(`${A}?timespan=2678401`)).status, 400);
    assert.equal((await sb.get(`/networks/${corp.networks.find((n) => n.name === 'Retail - Denver').id}/wireless/airMarshal`)).status, 200);
  });

  test('rules contain and allow-list what they match', async () => {
    fresh();
    const R = `/networks/${reno.id}/wireless/airMarshal/rules`;
    const rule = await ok(sb.post(R, { type: 'block', match: { type: 'wildcard', string: 'NETGEAR-D*' } }), 201);
    assert.match(rule.ruleId, /^\d+$/);
    assert.equal(rule.createdAt, '2026-09-29 18:30:00.000');
    assert.deepEqual(rule.network, { id: reno.id, name: reno.name });
    const scan = async () => (await ok(sb.get(`/networks/${reno.id}/wireless/airMarshal`))).find((x) => x.ssid === 'NETGEAR-Dock4');
    assert.ok((await scan()).bssids.every((b) => b.contained));
    const bssid = (await scan()).bssids[0].bssid;
    const allow = await ok(sb.post(R, { type: 'allow', match: { type: 'bssid', string: bssid } }), 201);
    const known = await scan();
    assert.deepEqual(known.types, []);
    assert.equal(known.bssids[0].contained, false);
    assert.equal((await ok(sb.put(`${R}/${allow.ruleId}`, { type: 'alert' }))).match.string, bssid.toLowerCase());
    assert.deepEqual((await scan()).types, ['rogue']);
    assert.match(await errorOf(sb.post(R, { type: 'block', match: { type: 'wildcard', string: 'NETGEAR-D*' } })), /already exists/);
    assert.match(await errorOf(sb.post(R, { type: 'block', match: { type: 'bssid', string: 'nope' } })), /BSSID/);
    assert.match(await errorOf(sb.post(R, { type: 'block', match: { type: 'exact' } })), /match.string/);
    assert.match(await errorOf(sb.post(R, { type: 'block' })), /'match' is required/);
    const org = await ok(sb.get(`/organizations/${corp.id}/wireless/airMarshal/rules`));
    assert.deepEqual(org.meta, { counts: { items: { total: 2, remaining: 0 } } });
    assert.deepEqual(org.items.map((x) => x.ruleId).sort(), [rule.ruleId, allow.ruleId].sort());
    await ok(sb.del(`${R}/${rule.ruleId}`), 204);
    assert.equal((await sb.del(`${R}/${rule.ruleId}`)).status, 404);
    assert.ok((await scan()).bssids.every((b) => !b.contained));
  });

  test('default policy writes and reads by network', async () => {
    fresh();
    const S = `/organizations/${corp.id}/wireless/airMarshal/settings/byNetwork`;
    assert.ok((await ok(sb.get(S))).items.every((x) => x.defaultPolicy === 'block'));
    assert.deepEqual(await ok(sb.put(`/networks/${reno.id}/wireless/airMarshal/settings`, { defaultPolicy: 'allow' })), { networkId: reno.id, defaultPolicy: 'allow' });
    assert.deepEqual((await ok(sb.get(`${S}?networkIds[]=${reno.id}`))).items, [{ networkId: reno.id, defaultPolicy: 'allow' }]);
    assert.equal((await sb.put(`/networks/${reno.id}/wireless/airMarshal/settings`, { defaultPolicy: 'maybe' })).status, 400);
  });

  test('settings follow the wireless part through split and combine', async () => {
    fresh();
    await ok(sb.put(`/networks/${hq.id}/wireless/radio/rrm`, { channel: { avoidance: { enabled: false } } }));
    const rule = await ok(sb.post(`/networks/${hq.id}/wireless/airMarshal/rules`, { type: 'allow', match: { type: 'exact', string: 'Lobby' } }), 201);
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    const rows = (await ok(sb.get(`/organizations/${corp.id}/wireless/airMarshal/rules`))).items;
    assert.deepEqual(rows.map((x) => [x.network.id, x.ruleId]), [[wl.id, rule.ruleId]]);
    assert.equal((await ok(sb.get(`/organizations/${corp.id}/wireless/radio/rrm/byNetwork?networkIds[]=${wl.id}`))).items[0].channel.avoidance.enabled, false);
  });

  test('template-bound networks refuse AutoRF and Air Marshal writes', async () => {
    fresh();
    const t = await ok(sb.post(`/organizations/${corp.id}/configTemplates`, { name: 'From HQ', copyFromNetworkId: hq.id }), 201);
    await ok(sb.post(`/networks/${hq.id}/bind`, { configTemplateId: t.id }));
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/wireless/radio/rrm`, { ai: { enabled: true } })), /bound to a config template/);
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/wireless/airMarshal/settings`, { defaultPolicy: 'allow' })), /bound to a config template/);
    await ok(sb.get(`/networks/${hq.id}/wireless/airMarshal`));
    await ok(sb.put(O(), { radios: [{ index: '1', channel: 36 }] }));
  });
});
