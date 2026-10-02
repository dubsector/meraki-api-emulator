import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('MX traffic shaping and SD-WAN', () => {
  let sb;
  let org;
  let hq;
  let london;
  let N;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    london = org.networks.find((n) => n.name === 'Remote - London');
    N = `/networks/${hq.id}/appliance/trafficShaping`;
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
  const newClass = (body = {}) => ok(sb.post(`${N}/customPerformanceClasses`, { name: 'Video', ...body }), 201);
  const rule = (filters, more = {}) => ({ trafficFilters: filters, preferredUplink: 'wan2', ...more });
  const custom = (value) => ({ type: 'custom', value });

  test('global bandwidth limits start unlimited and PUT changes what it names', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(N)), { globalBandwidthLimits: { limitUp: 0, limitDown: 0 } });
    assert.deepEqual(await ok(sb.put(N, { globalBandwidthLimits: { limitDown: 5120 } })), { globalBandwidthLimits: { limitUp: 0, limitDown: 5120 } });
    assert.equal((await ok(sb.get(N))).globalBandwidthLimits.limitDown, 5120);
    assert.match(await errorOf(sb.put(N, { globalBandwidthLimits: { limitUp: -1 } })), /limitUp' must be at least 0/);
    assert.match(await errorOf(sb.put(N, {})), /globalBandwidthLimits' is required/);
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
    assert.match(await errorOf(sb.get(`/networks/${lab.id}/appliance/trafficShaping`)), /product type 'appliance'/);
  });

  test('shaping rules take definitions of every type and count the default rules', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(`${N}/rules`)), { defaultRulesEnabled: true, rules: [] });
    const body = {
      rules: [
        {
          definitions: [
            { type: 'host', value: 'video.example.com' },
            { type: 'port', value: '8080' },
            { type: 'ipRange', value: '10.1.0.0/16:80' },
            { type: 'localNet', value: '192.168.10.0/24' },
            { type: 'application', value: { id: 'meraki:layer7/application/44' } },
            { type: 'applicationCategory', value: { id: 'meraki:layer7/category/13' } },
          ],
          perClientBandwidthLimits: { settings: 'custom', bandwidthLimits: { limitUp: 1000, limitDown: 5000 } },
          dscpTagValue: 34,
          priority: 'high',
        },
        { definitions: [{ type: 'host', value: 'backup.example.com' }] },
      ],
    };
    const r = await ok(sb.put(`${N}/rules`, body));
    assert.deepEqual(r.rules[0].definitions.slice(4), [
      { type: 'application', value: { id: 'meraki:layer7/application/44', name: 'YouTube' } },
      { type: 'applicationCategory', value: { id: 'meraki:layer7/category/13', name: 'Video & music' } },
    ]);
    assert.deepEqual(r.rules[1], { definitions: [{ type: 'host', value: 'backup.example.com' }], perClientBandwidthLimits: { settings: 'network default' }, dscpTagValue: null, priority: 'normal' });
    assert.deepEqual(await ok(sb.get(`${N}/rules`)), r);

    const five = Array.from({ length: 5 }, () => ({ definitions: [{ type: 'port', value: '443' }] }));
    assert.match(await errorOf(sb.put(`${N}/rules`, { rules: five })), /at most 8 traffic shaping rules/);
    assert.equal((await ok(sb.put(`${N}/rules`, { rules: five, defaultRulesEnabled: false }))).rules.length, 5);
    const bad = async (d) => errorOf(sb.put(`${N}/rules`, { rules: [{ definitions: [d] }] }));
    assert.match(await bad({ type: 'port', value: '70000' }), /port from 1 to 65535/);
    assert.match(await bad({ type: 'host', value: 'not a host' }), /hostname/);
    assert.match(await bad({ type: 'ipRange', value: '10.1.0.0/40' }), /IP address or CIDR/);
    assert.match(await bad({ type: 'application', value: { id: 'meraki:layer7/application/9999' } }), /ID of an application/);
    assert.match(await bad({ type: 'application', value: 'YouTube' }), /must be an object/);
    assert.match(await bad({ type: 'host', value: { id: 'x' } }), /must be a string/);
    assert.match(await errorOf(sb.put(`${N}/rules`, { rules: [{ definitions: [{ type: 'port', value: '1' }], dscpTagValue: 7 }] })), /dscpTaggingOptions/);
    assert.match(await errorOf(sb.put(`${N}/rules`, { rules: [{ definitions: [{ type: 'port', value: '1' }], priority: 'urgent' }] })), /priority/);
    assert.equal((await ok(sb.get(`${N}/rules`))).rules.length, 5, 'refused writes change nothing');
    assert.deepEqual((await ok(sb.put(`${N}/rules`, { rules: null }))).rules, []);
  });

  test('SSID shaping takes application definitions too', async () => {
    fresh();
    const r = await ok(sb.put(`/networks/${hq.id}/wireless/ssids/1/trafficShaping/rules`, { rules: [{ definitions: [{ type: 'applicationCategory', value: { id: 'meraki:layer7/category/8' } }] }] }));
    assert.deepEqual(r.rules[0].definitions, [{ type: 'applicationCategory', value: { id: 'meraki:layer7/category/8', name: 'Peer-to-peer (P2P)' } }]);
  });

  test('uplink bandwidth defaults follow each WAN link and PUT sets or clears limits', async () => {
    fresh();
    const hqBw = await ok(sb.get(`${N}/uplinkBandwidth`));
    assert.deepEqual(hqBw, { bandwidthLimits: { wan1: { limitUp: 1000000, limitDown: 1000000 }, wan2: { limitUp: 50000, limitDown: 500000 }, cellular: { limitUp: 51200, limitDown: 51200 } } });
    const ldn = await ok(sb.get(`/networks/${london.id}/appliance/trafficShaping/uplinkBandwidth`));
    assert.deepEqual(ldn.bandwidthLimits.wan2, { limitUp: null, limitDown: null });
    const r = await ok(sb.put(`${N}/uplinkBandwidth`, { bandwidthLimits: { wan1: { limitUp: 200000 }, wan2: { limitUp: null, limitDown: null } } }));
    assert.deepEqual(r.bandwidthLimits.wan1, { limitUp: 200000, limitDown: 1000000 });
    assert.deepEqual(r.bandwidthLimits.wan2, { limitUp: null, limitDown: null });
    assert.deepEqual(await ok(sb.get(`${N}/uplinkBandwidth`)), r);
    assert.match(await errorOf(sb.put(`${N}/uplinkBandwidth`, { bandwidthLimits: { cellular: { limitDown: 0 } } })), /cellular.limitDown' must be at least 1/);
  });

  test('uplink selection starts on wan1 and checks every rule before saving', async () => {
    fresh();
    const S = `${N}/uplinkSelection`;
    assert.deepEqual(await ok(sb.get(S)), {
      activeActiveAutoVpnEnabled: false,
      defaultUplink: 'wan1',
      loadBalancingEnabled: false,
      failoverAndFailback: { immediate: { enabled: false } },
      wanTrafficUplinkPreferences: [],
      vpnTrafficUplinkPreferences: [],
    });
    const cls = await newClass();
    const wan = rule([custom({ protocol: 'tcp', source: { port: 'any', cidr: '192.168.10.0/24' }, destination: { port: '443', cidr: 'any' } })]);
    const vpn = [
      rule([{ type: 'applicationCategory', value: { id: 'meraki:layer7/category/16' } }], { preferredUplink: 'bestForVoIP', performanceClass: { type: 'builtin', builtinPerformanceClassName: 'VoIP' } }),
      rule([custom({ protocol: 'udp', source: {}, destination: { port: '5000-5100', fqdn: 'media.example.com' } })], { failOverCriterion: 'poorPerformance', performanceClass: { type: 'custom', customPerformanceClassId: cls.customPerformanceClassId } }),
    ];
    const r = await ok(sb.put(S, { loadBalancingEnabled: true, failoverAndFailback: { immediate: { enabled: true } }, wanTrafficUplinkPreferences: [wan], vpnTrafficUplinkPreferences: vpn }));
    assert.equal(r.loadBalancingEnabled, true);
    assert.equal(r.failoverAndFailback.immediate.enabled, true);
    assert.deepEqual(r.wanTrafficUplinkPreferences, [wan]);
    assert.deepEqual(r.vpnTrafficUplinkPreferences[0].trafficFilters, [{ type: 'applicationCategory', value: { id: 'meraki:layer7/category/16' } }]);
    assert.deepEqual(r.vpnTrafficUplinkPreferences[1].trafficFilters[0].value, { protocol: 'udp', source: { port: 'any', cidr: 'any' }, destination: { port: '5000-5100', fqdn: 'media.example.com' } });
    assert.deepEqual(await ok(sb.get(S)), r);

    const before = r;
    assert.match(await errorOf(sb.put(S, { defaultUplink: 'wan3' })), /defaultUplink' must be one of: wan1, wan2/);
    assert.match(await errorOf(sb.put(S, { wanTrafficUplinkPreferences: [rule([custom({ source: {}, destination: {} })], { preferredUplink: 'cellular' })] })), /preferredUplink' must be one of: wan1, wan2/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([custom({ protocol: 'icmp', source: { port: '80' }, destination: {} })])] })), /needs protocol tcp or udp/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([custom({ source: { vlan: 10, host: 2 }, destination: {} })])] })), /only available under a config template/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([{ type: 'application', value: { id: 'meraki:layer7/application/9999' } }])] })), /application ID/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([custom({ destination: {} })], { performanceClass: { type: 'custom', customPerformanceClassId: '1' } })] })), /custom performance class in this network/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([custom({ destination: {} })], { vrf: { id: '12' } })] })), /VRFs are not enabled/);
    assert.match(await errorOf(sb.put(S, { vpnTrafficUplinkPreferences: [rule([])] })), /at least one filter/);
    assert.match(await errorOf(sb.put(S, { loadBalancingEnabled: false, vpnTrafficUplinkPreferences: [rule([custom({ destination: { cidr: '10.0.0.0/33' } })])] })), /cidr/);
    assert.deepEqual(await ok(sb.get(S)), before, 'refused writes change nothing');
  });

  test('custom performance classes: create, list, get, update and delete', async () => {
    fresh();
    const C = `${N}/customPerformanceClasses`;
    assert.deepEqual(await ok(sb.get(C)), []);
    const a = await newClass({ maxLatency: 150 });
    assert.deepEqual(Object.keys(a), ['name', 'customPerformanceClassId', 'maxLatency', 'maxJitter', 'maxLossPercentage']);
    assert.deepEqual({ ...a, customPerformanceClassId: 'x' }, { name: 'Video', customPerformanceClassId: 'x', maxLatency: 150, maxJitter: 100, maxLossPercentage: 5 });
    assert.match(a.customPerformanceClassId, /^\d{18}$/);
    const b = await newClass({ name: 'Voice', maxLossPercentage: 1 });
    assert.deepEqual(await ok(sb.get(C)), [a, b]);
    assert.deepEqual(await ok(sb.get(`${C}/${a.customPerformanceClassId}`)), a);
    const upd = await ok(sb.put(`${C}/${a.customPerformanceClassId}`, { maxJitter: 30 }));
    assert.equal(upd.maxJitter, 30);
    assert.match(await errorOf(sb.put(`${C}/${a.customPerformanceClassId}`, { name: 'Voice' })), /already exists/);
    assert.match(await errorOf(sb.post(C, { name: 'Bulk', maxLossPercentage: 101 })), /between 0 and 100/);
    assert.match(await errorOf(sb.post(C, {})), /'name' is required/);
    assert.equal((await sb.get(`${C}/1`)).status, 404);

    // A class in use can't be deleted until the rule using it goes.
    const vpn = [rule([custom({ destination: {} })], { performanceClass: { type: 'custom', customPerformanceClassId: b.customPerformanceClassId } })];
    await ok(sb.put(`${N}/uplinkSelection`, { vpnTrafficUplinkPreferences: vpn }));
    assert.match(await errorOf(sb.del(`${C}/${b.customPerformanceClassId}`)), /used by an uplink preference rule/);
    await ok(sb.put(`${N}/uplinkSelection`, { vpnTrafficUplinkPreferences: [] }));
    assert.equal((await sb.del(`${C}/${b.customPerformanceClassId}`)).status, 204);
    assert.deepEqual(await ok(sb.get(C)), [upd]);
    // IDs aren't reused after a delete.
    const c = await newClass({ name: 'Voice' });
    assert.notEqual(c.customPerformanceClassId, b.customPerformanceClassId);
  });

  test('SD-WAN internet policies write the WAN uplink preferences', async () => {
    fresh();
    const cls = await newClass();
    const policy = rule(
      [
        { type: 'majorApplication', value: { source: {}, destination: { applications: [{ id: 'meraki:layer7/application/3', name: 'DNS', type: 'major' }] } } },
        custom({ protocol: 'tcp', source: { cidr: '192.168.1.0/24' }, destination: { port: '443' } }),
      ],
      { preferredUplink: 'bestForVoIP', failOverCriterion: 'uplinkDown', performanceClass: { type: 'custom', customPerformanceClassId: cls.customPerformanceClassId } },
    );
    const r = await ok(sb.put(`/networks/${hq.id}/appliance/sdwan/internetPolicies`, { wanTrafficUplinkPreferences: [policy] }));
    const [p] = r.wanTrafficUplinkPreferences;
    assert.equal(p.failOverCriterion, 'uplinkDown');
    assert.deepEqual(p.trafficFilters[0].value.destination, { port: 'any', cidr: 'any', applications: [{ id: 'meraki:layer7/application/3', name: 'DNS', type: 'major' }] });
    const sel = await ok(sb.get(`${N}/uplinkSelection`));
    assert.deepEqual(sel.wanTrafficUplinkPreferences, [{ trafficFilters: p.trafficFilters, preferredUplink: 'bestForVoIP' }]);
    assert.match(await errorOf(sb.del(`${N}/customPerformanceClasses/${cls.customPerformanceClassId}`)), /in use|used by/);
    const bad = rule([{ type: 'majorApplication', value: { source: {}, destination: {} } }]);
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/appliance/sdwan/internetPolicies`, { wanTrafficUplinkPreferences: [bad] })), /destination.applications/);
    assert.match(await errorOf(sb.put(`/networks/${hq.id}/appliance/sdwan/internetPolicies`, { wanTrafficUplinkPreferences: [rule([custom({ source: {}, destination: {} })], { performanceClass: {} })] })), /performanceClass.type' is required/);
  });

  test('VPN exclusions per network and across the organization', async () => {
    fresh();
    const V = `${N}/vpnExclusions`;
    const r = await ok(
      sb.put(V, {
        custom: [{ protocol: 'tcp', destination: '192.168.3.0/24', port: '8000' }, { protocol: 'dns', destination: 'updates.example.com' }, { protocol: 'icmp' }],
        majorApplications: [{ id: 'meraki:vpnExclusion/application/2' }],
      }),
    );
    assert.deepEqual(r, {
      networkId: hq.id,
      networkName: hq.name,
      custom: [
        { protocol: 'tcp', destination: '192.168.3.0/24', port: '8000' },
        { protocol: 'dns', destination: 'updates.example.com', port: 'any' },
        { protocol: 'icmp', destination: 'any', port: 'any' },
      ],
      majorApplications: [{ id: 'meraki:vpnExclusion/application/2', name: 'Office 365 Sharepoint' }],
    });
    assert.match(await errorOf(sb.put(V, { custom: [{ protocol: 'dns', destination: '10.0.0.1' }] })), /hostname for protocol dns/);
    assert.match(await errorOf(sb.put(V, { custom: [{ protocol: 'udp', destination: 'example.com' }] })), /IPv4 address or CIDR/);
    assert.match(await errorOf(sb.put(V, { majorApplications: [{ id: 'meraki:vpnExclusion/application/99' }] })), /must be one of/);
    assert.match(await errorOf(sb.put(V, { majorApplications: [{ id: 'meraki:vpnExclusion/application/2', name: 'Zoom' }] })), /is 'Office 365 Sharepoint'/);

    const O = `/organizations/${org.id}/appliance/trafficShaping/vpnExclusions/byNetwork`;
    const all = await ok(sb.get(O));
    assert.deepEqual(Object.keys(all), ['items']);
    assert.equal(all.items.length, 5);
    assert.deepEqual(all.items.find((i) => i.networkId === hq.id), r);
    assert.deepEqual(all.items.find((i) => i.networkId === london.id), { networkId: london.id, networkName: london.name, custom: [], majorApplications: [] });
    const one = await ok(sb.get(`${O}?networkIds[]=${london.id}`));
    assert.deepEqual(one.items.map((i) => i.networkId), [london.id]);
    const page = await sb.get(`${O}?perPage=3`);
    assert.equal(page.body.items.length, 3);
    assert.match(page.link, /rel=next/);
  });

  test('application categories need an MX and DSCP options are a fixed list', async () => {
    fresh();
    const cats = await ok(sb.get(`/networks/${hq.id}/trafficShaping/applicationCategories`));
    assert.deepEqual(cats, await ok(sb.get(`/networks/${hq.id}/appliance/firewall/l7FirewallRules/applicationCategories`)));
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
    assert.match(await errorOf(sb.get(`/networks/${lab.id}/trafficShaping/applicationCategories`)), /appliance/);
    const dscp = await ok(sb.get(`/networks/${lab.id}/trafficShaping/dscpTaggingOptions`));
    assert.deepEqual(dscp.find((o) => o.dscpTagValue === 10), { dscpTagValue: 10, description: 'AF11 - High Throughput, Latency Insensitive, Low Drop' });
    assert.equal(dscp[0].dscpTagValue, 0);
  });

  test('a failed action batch rolls back new classes and shaping changes', async () => {
    fresh();
    const res = (p) => `/networks/${hq.id}/appliance/trafficShaping${p}`;
    const r = await ok(
      sb.post(`/organizations/${org.id}/actionBatches`, {
        confirmed: true,
        synchronous: true,
        actions: [
          { resource: res('/customPerformanceClasses'), operation: 'create', body: { name: 'Batch' } },
          { resource: res(''), operation: 'update', body: { globalBandwidthLimits: { limitUp: 99 } } },
          { resource: res('/customPerformanceClasses/1'), operation: 'destroy' },
        ],
      }),
      201,
    );
    assert.equal(r.status.failed, true);
    assert.deepEqual(await ok(sb.get(res('/customPerformanceClasses'))), []);
    assert.equal((await ok(sb.get(res('')))).globalBandwidthLimits.limitUp, 0);
  });
});
