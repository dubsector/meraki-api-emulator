import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

// True when a dotted IPv4 address falls inside a CIDR block.
function inCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const n = (a) => a.split('.').reduce((v, o) => v * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(bits));
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}

describe('appliance config', () => {
  let sb;
  before(async () => (sb = await start()));
  after(() => sb.close());

  test('every client address sits in its VLAN, and the MX is .1', async () => {
    for (const net of sb.world.orgs[0].networks) {
      const vlans = (await sb.get(`/networks/${net.id}/appliance/vlans`)).body;
      for (const c of net.clients) {
        const v = vlans.find((x) => x.id === String(c.vlan));
        assert.ok(v && inCidr(c.ip, v.subnet), `${net.code} ${c.ip} in VLAN ${c.vlan}`);
      }
      for (const v of vlans) assert.ok(v.applianceIp.endsWith('.1') && inCidr(v.applianceIp, v.subnet));
      assert.deepEqual((await sb.get(`/networks/${net.id}/appliance/vlans/${vlans[0].id}`)).body, vlans[0]);
    }
    const hq = sb.world.orgs[0].networks[0];
    assert.equal((await sb.get(`/networks/${hq.id}/appliance/vlans/999`)).status, 404);
  });

  test('VPN status exports what the site-to-site settings share', async () => {
    const org = sb.world.orgs[0];
    const statuses = (await sb.get(`/organizations/${org.id}/appliance/vpn/statuses`)).body;
    for (const s of statuses) {
      const vpn = (await sb.get(`/networks/${s.networkId}/appliance/vpn/siteToSiteVpn`)).body;
      assert.equal(vpn.mode, s.vpnMode);
      assert.deepEqual(s.exportedSubnets.map((x) => x.subnet), vpn.subnets.filter((x) => x.useVpn).map((x) => x.localSubnet));
      if (vpn.mode === 'spoke') assert.deepEqual(vpn.hubs.map((h) => h.hubId), [org.hub.id]);
      // Spokes rank their hubs; the hub's own peer list has no priority.
      for (const p of s.merakiVpnPeers) assert.equal(p.priority, vpn.mode === 'spoke' ? 1 : undefined);
    }
  });

  test('VPN stats give latency in whole milliseconds', async () => {
    const org = sb.world.orgs[0];
    const stats = (await sb.get(`/organizations/${org.id}/appliance/vpn/stats`)).body;
    const lat = stats.flatMap((s) => s.merakiVpnPeers.flatMap((p) => p.latencySummaries));
    assert.ok(lat.length > 0);
    for (const l of lat) for (const k of ['avgLatencyMs', 'minLatencyMs', 'maxLatencyMs']) assert.ok(Number.isInteger(l[k]), `${k} ${l[k]}`);
  });

  test('firewall rules end with the default rule', async () => {
    for (const net of sb.world.orgs[0].networks) {
      const rules = (await sb.get(`/networks/${net.id}/appliance/firewall/l3FirewallRules`)).body.rules;
      assert.equal(rules.at(-1).comment, 'Default rule');
    }
  });

  test('DHCP subnets match the VLANs and never overflow', async () => {
    const net = sb.world.orgs[0].networks[0];
    const vlans = (await sb.get(`/networks/${net.id}/appliance/vlans`)).body;
    const subnets = (await sb.get(`/devices/${net.mx.serial}/appliance/dhcp/subnets`)).body;
    assert.deepEqual(subnets.map((s) => s.subnet), vlans.map((v) => v.subnet));
    for (const s of subnets) assert.ok(s.usedCount >= 0 && s.freeCount >= 0);
    assert.ok(subnets.find((s) => s.vlanId === 10).usedCount > 50);
  });

  test('networks without an MX reject appliance config', async () => {
    const lab = sb.world.orgs[1].networks[0];
    for (const p of ['appliance/vlans', 'appliance/firewall/l3FirewallRules', 'appliance/vpn/siteToSiteVpn']) {
      assert.equal((await sb.get(`/networks/${lab.id}/${p}`)).status, 400, p);
    }
  });
});

describe('switching and topology', () => {
  let sb;
  let hq;
  before(async () => {
    sb = await start();
    hq = sb.world.orgs[0].networks[0];
  });
  after(() => sb.close());

  test('a single port matches the port list', async () => {
    const sw = hq.switches[0];
    const ports = (await sb.get(`/devices/${sw.serial}/switch/ports`)).body;
    assert.deepEqual((await sb.get(`/devices/${sw.serial}/switch/ports/5`)).body, ports[4]);
    assert.equal((await sb.get(`/devices/${sw.serial}/switch/ports/999`)).status, 404);
  });

  test('org-wide port statuses page through every switch', async () => {
    const org = sb.world.orgs[0];
    const switches = org.devices.filter((d) => d.productType === 'switch');
    const first = (await sb.get(`/organizations/${org.id}/switch/ports/statuses/bySwitch?perPage=3`)).body;
    assert.equal(first.items.length, 3);
    assert.deepEqual(first.meta.counts.items, { total: switches.length, remaining: switches.length - 3 });
    const configs = await collect(sb.get, `/organizations/${org.id}/switch/ports/bySwitch?perPage=3`);
    assert.equal(configs.length, switches.length);
  });

  test('ports list their link speeds, and the org-wide view keeps fewer fields', async () => {
    const core = hq.switches[0];
    const ports = (await sb.get(`/devices/${core.serial}/switch/ports`)).body;
    for (const p of ports) {
      assert.deepEqual([p.perpetualPoe, p.fastPoe, p.stpPortFastTrunk], [{ enabled: false }, { enabled: false }, false]);
      assert.ok(p.linkNegotiationCapabilities.includes(p.linkNegotiation));
    }
    assert.ok(ports[0].linkNegotiationCapabilities.includes('5 Gigabit full duplex (auto)'), 'MS390-48UX access ports are multigigabit');
    const byOrg = (await sb.get(`/organizations/${hq.org.id}/switch/ports/bySwitch?serials[]=${core.serial}`)).body[0].ports;
    assert.equal(byOrg.length, ports.length);
    assert.equal(byOrg[0].udld, undefined);
    assert.deepEqual(byOrg[0].perpetualPoe, { enabled: false });
  });

  test('an AP and its switch port see each other over LLDP', async () => {
    const ap = hq.aps[0];
    const sw = ap.switchPort.switch;
    const mine = (await sb.get(`/devices/${ap.serial}/lldpCdp`)).body;
    assert.equal(mine.ports.wired0.lldp.chassisId, sw.mac);
    assert.equal(mine.ports.wired0.lldp.managementVlan, 1);
    assert.match(mine.ports.wired0.device.url, /\/manage\/nodes\/new_list\/\d+$/);
    const theirs = (await sb.get(`/devices/${sw.serial}/lldpCdp`)).body;
    assert.equal(theirs.ports[ap.switchPort.portId].lldp.chassisId, ap.mac);
    assert.equal(theirs.ports[ap.switchPort.portId].deviceMac, ap.mac);
  });

  test('desk phones answer over CDP, with a model only in the lldpCdp view', async () => {
    const sw = hq.switches.find((s) => s.ports.some((p) => p.clients[0]?.kindName === 'deskPhone'));
    const neighbors = Object.values((await sb.get(`/devices/${sw.serial}/lldpCdp`)).body.ports).filter((p) => p.cdp);
    assert.ok(neighbors.length);
    assert.equal(neighbors[0].cdp.model, 'CP-8845');
    assert.equal(neighbors[0].cdp.systemName, undefined);
    const statuses = (await sb.get(`/devices/${sw.serial}/switch/ports/statuses`)).body.filter((p) => p.cdp);
    assert.equal(statuses.length, neighbors.length);
    assert.equal(statuses[0].cdp.model, undefined);
    assert.equal(statuses[0].lldp.managementAddress, statuses[0].cdp.address);
  });

  test('topology links only join known nodes and the MX is the root', async () => {
    const t = (await sb.get(`/networks/${hq.id}/topology/linkLayer`)).body;
    const ids = new Set(t.nodes.map((n) => n.derivedId));
    for (const l of t.links) for (const e of l.ends) assert.ok(ids.has(e.node.derivedId));
    assert.deepEqual(t.nodes.filter((n) => n.root).map((n) => n.device.serial), [hq.mx.serial]);
    const cores = t.links.filter((l) => l.ends.some((e) => e.device?.serial === hq.mx.serial));
    assert.equal(cores.length, 1);
  });
});

describe('wireless', () => {
  let sb;
  let hq;
  before(async () => {
    sb = await start();
    hq = sb.world.orgs[0].networks[0];
  });
  after(() => sb.close());

  test('radio channels match the channels in association events', async () => {
    const events = (await sb.get(`/networks/${hq.id}/events?productType=wireless&perPage=200&includedEventTypes[]=association`)).body.events;
    assert.ok(events.length);
    for (const e of events.slice(0, 20)) {
      const radio = (await sb.get(`/devices/${e.deviceSerial}/wireless/radio/settings`)).body;
      const band = { 0: 'twoFourGhzSettings', 1: 'fiveGhzSettings' }[e.eventData.radio];
      if (band) assert.equal(String(radio[band].channel), e.eventData.channel);
    }
  });

  test('channel utilization splits into Wi-Fi and non-Wi-Fi', async () => {
    const rows = (await sb.get(`/networks/${hq.id}/wireless/channelUtilizationHistory?timespan=86400&resolution=3600&band=2.4`)).body;
    assert.equal(rows.length, 25);
    for (const r of rows) {
      assert.ok(r.utilizationTotal > 0 && r.utilizationTotal <= 100);
      assert.ok(Math.abs(r.utilization80211 + r.utilizationNon80211 - r.utilizationTotal) < 0.05);
    }
    const byDevice = (await sb.get(`/organizations/${hq.org.id}/wireless/devices/channelUtilization/byDevice?timespan=86400`)).body;
    assert.equal(byDevice.length, hq.org.devices.filter((d) => d.productType === 'wireless').length);
  });

  test('signal quality needs a client or an AP', async () => {
    assert.equal((await sb.get(`/networks/${hq.id}/wireless/signalQualityHistory`)).status, 400);
    const rows = (await sb.get(`/networks/${hq.id}/wireless/signalQualityHistory?deviceSerial=${hq.aps[0].serial}&timespan=86400&resolution=3600`)).body;
    const seen = rows.filter((r) => r.rssi != null);
    assert.ok(seen.length > 5);
    for (const r of seen) assert.ok(r.rssi < -30 && r.rssi > -90 && r.snr > 0);
  });

  test('failed connections point at real clients and APs', async () => {
    const rows = (await sb.get(`/networks/${hq.id}/wireless/failedConnections?timespan=604800`)).body;
    assert.ok(rows.length > 0);
    const macs = new Set(hq.clients.map((c) => c.mac));
    const aps = new Set(hq.aps.map((a) => a.serial));
    for (const r of rows) {
      assert.ok(macs.has(r.clientMac) && aps.has(r.serial));
      assert.ok(['assoc', 'auth', 'dhcp', 'dns'].includes(r.failureStep));
    }
  });

  test('the guest SSID blocks the LAN and shows a splash page', async () => {
    const guest = hq.ssids.find((s) => s.key === 'guest').number;
    const fw = (await sb.get(`/networks/${hq.id}/wireless/ssids/${guest}/firewall/l3FirewallRules`)).body;
    assert.equal(fw.allowLanAccess, false);
    assert.equal((await sb.get(`/networks/${hq.id}/wireless/ssids/${guest}/splash/settings`)).body.splashPage, 'Click-through splash page');
  });

  test('each SSID carries the fields for its auth mode, IP assignment and splash page', async () => {
    const ssids = (await sb.get(`/networks/${hq.id}/wireless/ssids`)).body;
    const byKey = (key) => ssids[hq.ssids.find((s) => s.key === key).number];
    const corp = byKey('corp');
    assert.equal(corp.radiusEnabled, true);
    assert.equal(corp.radiusServers[0].radsecEnabled, false);
    assert.deepEqual(corp.dot11r, { enabled: false, adaptive: false });
    assert.equal(corp.lanIsolationEnabled, false);
    assert.equal(corp.dnsRewrite, undefined);
    const iot = byKey('iot');
    assert.ok(iot.psk.length >= 8);
    assert.equal(iot.radiusEnabled, undefined);
    const guest = byKey('guest');
    assert.equal(guest.dot11w, undefined);
    assert.deepEqual(guest.dnsRewrite, { enabled: false, dnsCustomNameservers: [] });
    assert.equal(guest.adminSplashUrl, '');
    assert.equal(guest.useVlanTagging, undefined);
    assert.ok(ssids.every((s) => !('localAuth' in s)), 'localAuth is only for 8021x-nac');
  });
});

describe('alerts', () => {
  let sb;
  let org;
  before(async () => {
    sb = await start();
    org = sb.world.orgs[0];
  });
  after(() => sb.close());

  test('active alerts include the CRC errors and the dormant camera', async () => {
    const alerts = (await sb.get(`/organizations/${org.id}/assurance/alerts?perPage=300`)).body;
    assert.ok(alerts.every((a) => a.resolvedAt === null));
    const sw = org.devices.find((d) => d.alerting);
    const cam = org.devices.find((d) => d.dormant);
    assert.ok(alerts.some((a) => a.type === 'crc_errors' && a.scope.devices[0].serial === sw.serial));
    assert.ok(alerts.some((a) => a.type === 'unreachable' && a.scope.devices[0].serial === cam.serial));
    const overview = (await sb.get(`/organizations/${org.id}/assurance/alerts/overview`)).body;
    assert.equal(overview.counts.total, alerts.length);
    assert.deepEqual((await sb.get(`/organizations/${org.id}/assurance/alerts/${alerts[0].id}`)).body, alerts[0]);
  });

  test('resolved alerts line up with device outages', async () => {
    const resolved = (await sb.get(`/organizations/${org.id}/assurance/alerts?active=false&resolved=true&perPage=300&types[]=unreachable`)).body;
    assert.ok(resolved.length > 0);
    for (const a of resolved) assert.ok(a.resolvedAt > a.startedAt);
    const desc = (await sb.get(`/organizations/${org.id}/assurance/alerts?active=false&resolved=true&perPage=300&types[]=unreachable&sortOrder=descending`)).body;
    assert.deepEqual(desc.map((a) => a.id), resolved.map((a) => a.id).reverse());
  });

  test('network health alerts show what is wrong now', async () => {
    const austin = org.networks.find((n) => n.code === 'AUS');
    const alerts = (await sb.get(`/networks/${austin.id}/health/alerts`)).body;
    assert.ok(alerts.some((a) => a.type === 'CRC errors detected' && a.scope.devices[0].lldp.portId));
  });
});
