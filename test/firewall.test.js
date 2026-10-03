import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

describe('MX firewall, NAT and warm spare', () => {
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
    N = `/networks/${hq.id}/appliance`;
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
  const lab = () => sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks[0];
  // Claims the seeded order's MX250 into HQ, next to its MX250.
  const claimSpare = async () => {
    const mx = sb.world.unclaimed.devices.find((d) => d.model === 'MX250');
    await ok(sb.post(`/organizations/${org.id}/inventory/claim`, { orders: [mx.orderNumber] }));
    await ok(sb.post(`/networks/${hq.id}/devices/claim`, { serials: [mx.serial] }));
    return mx.serial;
  };

  test('firewall settings default to blocking spoofed sources and PUT sets the mode', async () => {
    fresh();
    const path = `${N}/firewall/settings`;
    assert.deepEqual(await ok(sb.get(path)), { spoofingProtection: { ipSourceGuard: { mode: 'block' } } });
    assert.match(await errorOf(sb.put(path, { spoofingProtection: { ipSourceGuard: { mode: 'drop' } } })), /mode/);
    assert.equal((await ok(sb.put(path, { spoofingProtection: { ipSourceGuard: { mode: 'log' } } }))).spoofingProtection.ipSourceGuard.mode, 'log');
    assert.equal((await ok(sb.get(path))).spoofingProtection.ipSourceGuard.mode, 'log');
    assert.equal((await ok(sb.put(path, {}))).spoofingProtection.ipSourceGuard.mode, 'log');
    assert.match(await errorOf(sb.get(`/networks/${lab().id}/appliance/firewall/settings`)), /appliance/);
  });

  test('cellular rules end with the default rule, which is dropped when sent back', async () => {
    fresh();
    for (const path of [`${N}/firewall/cellularFirewallRules`, `${N}/firewall/inboundCellularFirewallRules`]) {
      const start = await ok(sb.get(path));
      assert.deepEqual(start.rules.map((r) => r.comment), ['Default rule']);
      const rule = { comment: 'Block telnet', policy: 'deny', protocol: 'tcp', srcCidr: '10.0.0.0/8,192.168.1.5', destCidr: 'example.com', destPort: '23' };
      const set = await ok(sb.put(path, { rules: [rule] }));
      assert.deepEqual(set.rules[0], { ...rule, srcPort: 'Any', syslogEnabled: false });
      assert.equal(set.rules.length, 2);
      assert.deepEqual(await ok(sb.put(path, set)), set);
      assert.deepEqual(await ok(sb.get(path)), set);
      assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, srcCidr: 'example.com' }] })), /srcCidr/);
      assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, destPort: '70000' }] })), /destPort/);
      assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, policy: 'drop' }] })), /policy/);
      assert.match(await errorOf(sb.put(path, { rules: [{ policy: 'deny', protocol: 'tcp', destCidr: 'Any' }] })), /srcCidr/);
    }
    // The two lists are separate.
    await ok(sb.put(`${N}/firewall/cellularFirewallRules`, { rules: [] }));
    assert.equal((await ok(sb.get(`${N}/firewall/inboundCellularFirewallRules`))).rules.length, 2);
  });

  test('1:many NAT rules start empty and are checked before they replace the list', async () => {
    fresh();
    const path = `${N}/firewall/oneToManyNatRules`;
    assert.deepEqual(await ok(sb.get(path)), { rules: [] });
    const rule = { publicIp: '198.51.100.40', uplink: 'internet1', portRules: [{ name: 'Web', protocol: 'tcp', publicPort: '9443', localIp: '10.0.5.20', localPort: '443' }] };
    const set = await ok(sb.put(path, { rules: [rule] }));
    assert.deepEqual(set.rules[0].portRules[0], { ...rule.portRules[0], allowedIps: ['any'] });
    assert.deepEqual(await ok(sb.get(path)), set);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, publicIp: 'x' }] })), /publicIp/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, uplink: 'wan1' }] })), /uplink/);
    assert.match(await errorOf(sb.put(path, { rules: [rule, rule] })), /more than one/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, portRules: [{ protocol: 'tcp', publicPort: '0' }] }] })), /publicPort/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, portRules: [{ localIp: '10.0.5' }] }] })), /localIp/);
    assert.match(await errorOf(sb.put(path, {})), /rules/);
    assert.deepEqual(await ok(sb.get(path)), set);
  });

  test('multicast forwarding takes rules on the network VLANs and the org lists every MX network', async () => {
    fresh();
    const path = `${N}/firewall/multicastForwarding`;
    const vlan = (await ok(sb.get(`${N}/vlans`)))[0].id;
    const rule = { description: 'Paging', address: '239.1.1.1', vlanIds: [vlan] };
    assert.deepEqual(await ok(sb.put(path, { rules: [rule] })), { network: { id: hq.id, name: hq.name }, rules: [rule] });
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, address: '10.1.1.1' }] })), /multicast/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, vlanIds: ['999'] }] })), /VLAN 999/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, vlanIds: [] }] })), /at least one/);
    assert.match(await errorOf(sb.put(path, {})), /rules/);
    const all = `/organizations/${org.id}/appliance/firewall/multicastForwarding/byNetwork`;
    const page = await ok(sb.get(all));
    assert.equal(page.items.length, org.networks.filter((n) => n.productTypes.includes('appliance')).length);
    assert.deepEqual(page.meta.counts.items, { total: page.items.length, remaining: 0 });
    assert.deepEqual(page.items.find((i) => i.network.id === hq.id).rules, [rule]);
    assert.deepEqual(page.items.find((i) => i.network.id === london.id).rules, []);
    const one = await ok(sb.get(`${all}?networkIds[]=${london.id}`));
    assert.deepEqual(one.items.map((i) => i.network.name), [london.name]);
    assert.equal((await collect(sb.get, `${all}?perPage=3`)).length, page.items.length);
    assert.match(await errorOf(sb.get(`${all}?perPage=2`)), /perPage/);
    await ok(sb.put(path, { rules: [] }));
    assert.deepEqual((await ok(sb.get(all))).items.find((i) => i.network.id === hq.id).rules, []);
  });

  test('uplink NAT is on for both WANs until PUT turns one off', async () => {
    fresh();
    const all = `/organizations/${org.id}/appliance/uplinks/nat/byNetwork`;
    const rows = await ok(sb.get(all));
    assert.ok(Array.isArray(rows));
    assert.deepEqual(rows.find((r) => r.networkId === hq.id).uplinks, [
      { interface: 'wan1', nat: { enabled: true } },
      { interface: 'wan2', nat: { enabled: true } },
    ]);
    const set = await ok(sb.put(`${N}/uplinks/nat`, { uplinks: [{ interface: 'wan2', nat: { enabled: false } }] }));
    assert.deepEqual(set.uplinks[1], { interface: 'wan2', nat: { enabled: false } });
    assert.match(await errorOf(sb.put(`${N}/uplinks/nat`, { uplinks: [{ interface: 'cellular', nat: { enabled: false } }] })), /interface/);
    assert.match(await errorOf(sb.put(`${N}/uplinks/nat`, { uplinks: [{ interface: 'wan1' }] })), /nat/);
    const filtered = await ok(sb.get(`${all}?networkIds[]=${hq.id}&interfaces[]=wan2`));
    assert.deepEqual(filtered, [{ networkId: hq.id, uplinks: [{ interface: 'wan2', nat: { enabled: false } }] }]);
    assert.equal((await collect(sb.get, `${all}?perPage=3`)).length, rows.length);
  });

  test('connectivity monitoring defaults to the address the uplink stats measure against', async () => {
    fresh();
    const path = `${N}/connectivityMonitoringDestinations`;
    assert.deepEqual(await ok(sb.get(path)), { destinations: [{ ip: '8.8.8.8', description: 'Google', default: true }] });
    const set = await ok(sb.put(path, { destinations: [{ ip: '1.1.1.1', default: true }, { ip: '9.9.9.9', description: 'Quad9' }] }));
    assert.deepEqual(set.destinations, [
      { ip: '1.1.1.1', description: '', default: true },
      { ip: '9.9.9.9', description: 'Quad9', default: false },
    ]);
    assert.deepEqual(await ok(sb.get(path)), set);
    assert.match(await errorOf(sb.put(path, { destinations: [{ ip: 'dns.google' }] })), /ip/);
    assert.match(await errorOf(sb.put(path, { destinations: [{ ip: '1.1.1.1', default: true }, { ip: '9.9.9.9', default: true }] })), /one destination/);
    assert.match(await errorOf(sb.put(path, { destinations: [{ ip: '1.1.1.1' }, { ip: '1.1.1.1' }] })), /more than once/);
    assert.match(await errorOf(sb.put(path, { destinations: [{ description: 'x' }] })), /ip/);
    assert.deepEqual(await ok(sb.get(path)), set);
  });

  test('warm spare takes a second MX of the same model and swap flips the roles', async () => {
    fresh();
    const path = `${N}/warmSpare`;
    const primary = hq.mx.serial;
    assert.deepEqual(await ok(sb.get(path)), { enabled: false, primarySerial: primary });
    assert.match(await errorOf(sb.post(`${path}/swap`)), /not enabled/);
    assert.match(await errorOf(sb.put(path, { enabled: true })), /spareSerial/);
    assert.match(await errorOf(sb.put(path, { enabled: true, spareSerial: primary })), /primary/);
    assert.match(await errorOf(sb.put(path, { enabled: true, spareSerial: london.mx.serial })), /not an MX in this network/);
    assert.match(await errorOf(sb.put(path, {})), /enabled/);
    const spare = await claimSpare();
    assert.equal(sb.world.networkById.get(hq.id).mx.serial, primary);

    const pub = await ok(sb.put(path, { enabled: true, spareSerial: spare }));
    assert.deepEqual(pub, { enabled: true, primarySerial: primary, spareSerial: spare, uplinkMode: 'public' });
    assert.match(await errorOf(sb.put(path, { enabled: true, uplinkMode: 'virtual', virtualIp1: '198.51.100.250' })), /virtualIp2/);
    assert.match(await errorOf(sb.put(path, { enabled: true, uplinkMode: 'virtual', virtualIp1: '10.0.0.1', virtualIp2: '203.0.113.250' })), /virtualIp1.*subnet/);
    assert.match(await errorOf(sb.put(path, { enabled: true, uplinkMode: 'virtual', virtualIp1: '198.51.100.1', virtualIp2: '203.0.113.250' })), /gateway/);
    assert.match(await errorOf(sb.put(path, { enabled: true, uplinkMode: 'bridge' })), /uplinkMode/);
    const virt = await ok(sb.put(path, { enabled: true, uplinkMode: 'virtual', virtualIp1: '198.51.100.250', virtualIp2: '203.0.113.250' }));
    assert.deepEqual(virt, {
      enabled: true,
      primarySerial: primary,
      spareSerial: spare,
      uplinkMode: 'virtual',
      wan1: { ip: '198.51.100.250', subnet: '198.51.100.0/24' },
      wan2: { ip: '203.0.113.250', subnet: '203.0.113.0/24' },
    });
    assert.deepEqual(await ok(sb.get(path)), virt);

    const swapped = await ok(sb.post(`${path}/swap`));
    assert.deepEqual([swapped.primarySerial, swapped.spareSerial], [spare, primary]);
    // The new primary has one WAN of its own, but the shared links stay the network's.
    assert.deepEqual([swapped.wan1, swapped.wan2], [virt.wan1, virt.wan2]);
    assert.deepEqual(await ok(sb.get(path)), swapped);
    // Roles only: the sim keeps reporting on the same MX.
    assert.equal(sb.world.networkById.get(hq.id).mx.serial, primary);
    const back = await ok(sb.post(`${path}/swap`));
    assert.deepEqual(back, virt);

    assert.deepEqual(await ok(sb.put(path, { enabled: false })), { enabled: false, primarySerial: primary });
    assert.match(await errorOf(sb.post(`${path}/swap`)), /not enabled/);
  });

  test('removing the primary leaves the spare as the network MX', async () => {
    fresh();
    const path = `${N}/warmSpare`;
    const primary = hq.mx.serial;
    const spare = await claimSpare();
    await ok(sb.put(path, { enabled: true, spareSerial: spare }));
    await ok(sb.post(`/networks/${hq.id}/devices/remove`, { serial: primary }), 204);
    assert.equal(sb.world.networkById.get(hq.id).mx.serial, spare);
    assert.deepEqual(await ok(sb.get(path)), { enabled: false, primarySerial: spare });
    assert.equal((await ok(sb.get(`/devices/${spare}/appliance/uplinks/settings`))).interfaces.wan1.enabled, true);
  });

  test('the spare must match the primary model', async () => {
    fresh();
    const mx = sb.world.unclaimed.devices.find((d) => d.model === 'MX250');
    await ok(sb.post(`/organizations/${org.id}/inventory/claim`, { orders: [mx.orderNumber] }));
    await ok(sb.post(`/networks/${london.id}/devices/claim`, { serials: [mx.serial] }));
    assert.match(await errorOf(sb.put(`/networks/${london.id}/appliance/warmSpare`, { enabled: true, spareSerial: mx.serial })), /same model/);
  });

  test('a network bound to a template keeps its own warm spare', async () => {
    fresh();
    const spare = await claimSpare();
    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'From HQ', copyFromNetworkId: hq.id }), 201);
    await ok(sb.post(`/networks/${hq.id}/bind`, { configTemplateId: t.id }));
    assert.match(await errorOf(sb.put(`${N}/firewall/settings`, { spoofingProtection: { ipSourceGuard: { mode: 'log' } } })), /bound to a config template/);
    assert.equal((await ok(sb.put(`${N}/warmSpare`, { enabled: true, spareSerial: spare }))).spareSerial, spare);
    assert.equal((await ok(sb.post(`${N}/warmSpare/swap`))).primarySerial, spare);
  });
  test('redundancy is the warm spare in another shape and both views agree', async () => {
    fresh();
    const R = `${N}/devices/redundancy`;
    const byNet = async () => (await collect(sb.get, `/organizations/${org.id}/appliance/devices/redundancy/byNetwork?perPage=5`)).find((x) => x.networkId === hq.id);
    const primary = hq.mx.serial;
    const off = { networkId: hq.id, name: hq.name, enabled: false, mode: 'disabled', designations: [{ serial: primary, priority: 1 }], uplink: { mode: 'public', interfaces: [], sharing: { enabled: false, vlanId: null, byInterface: [] } } };
    assert.deepEqual(await byNet(), off);
    assert.match(await errorOf(sb.post(`${R}/swap`)), /not enabled/);
    assert.match(await errorOf(sb.put(R, {})), /enabled/);
    assert.match(await errorOf(sb.put(R, { enabled: true })), /designations.*spare/);
    assert.match(await errorOf(sb.put(R, { enabled: true, mode: 'disabled' })), /mode/);
    assert.match(await errorOf(sb.put(R, { enabled: false, mode: 'active-passive' })), /mode/);
    const spare = await claimSpare();
    assert.match(await errorOf(sb.put(R, { enabled: true, designations: [{ serial: primary, priority: 1 }] })), /two appliances/);
    assert.match(await errorOf(sb.put(R, { enabled: true, designations: [{ serial: primary, priority: 1 }, { serial: primary, priority: 2 }] })), /different/);
    assert.match(await errorOf(sb.put(R, { enabled: true, designations: [{ serial: primary, priority: 1 }, { serial: spare, priority: 1 }] })), /priority 1/);
    assert.match(await errorOf(sb.put(R, { enabled: true, designations: [{ serial: primary, priority: 1 }, { serial: london.mx.serial, priority: 2 }] })), /not an MX/);
    assert.match(await errorOf(sb.put(R, { enabled: true, uplink: { mode: 'virtual', interfaces: [{ name: 'wan3', addresses: [{ address: '198.51.100.250' }] }] } })), /wan1, wan2/);
    assert.match(await errorOf(sb.put(R, { enabled: true, uplink: { sharing: { enabled: true } } })), /vlanId/);
    assert.match(await errorOf(sb.put(R, { enabled: true, uplink: { sharing: { vlanId: '5000' } } })), /4094/);
    assert.equal((await ok(sb.get(`${N}/warmSpare`))).enabled, false);

    // Designations can name the spare as primary, which is a swap.
    const set = await ok(
      sb.put(R, {
        enabled: true,
        mode: 'active-passive',
        designations: [{ serial: spare, priority: 1 }, { serial: primary, priority: 2 }],
        uplink: {
          mode: 'virtual',
          interfaces: [
            { name: 'wan1', addresses: [{ address: '198.51.100.250', subnet: '198.51.100.0/24' }] },
            { name: 'wan2', addresses: [{ address: '203.0.113.250' }] },
          ],
          sharing: { enabled: true, vlanId: '100', byInterface: [{ name: 'wan1', parent: 'primary' }] },
        },
      }),
    );
    assert.deepEqual(set.designations, [{ serial: spare, priority: 1 }, { serial: primary, priority: 2 }]);
    assert.deepEqual(set.uplink.interfaces, [
      { name: 'wan1', addresses: [{ address: '198.51.100.250', subnet: '198.51.100.0/24' }] },
      { name: 'wan2', addresses: [{ address: '203.0.113.250', subnet: '203.0.113.0/24' }] },
    ]);
    assert.deepEqual(set.uplink.sharing, { enabled: true, vlanId: '100', byInterface: [{ name: 'wan1', parent: 'primary' }] });
    assert.deepEqual(await byNet(), set);
    assert.deepEqual(await ok(sb.get(`${N}/warmSpare`)), {
      enabled: true,
      primarySerial: spare,
      spareSerial: primary,
      uplinkMode: 'virtual',
      wan1: { ip: '198.51.100.250', subnet: '198.51.100.0/24' },
      wan2: { ip: '203.0.113.250', subnet: '203.0.113.0/24' },
    });

    const swapped = await ok(sb.post(`${R}/swap`));
    assert.deepEqual(swapped.designations, [{ serial: primary, priority: 1 }, { serial: spare, priority: 2 }]);
    assert.equal((await ok(sb.get(`${N}/warmSpare`))).primarySerial, primary);
    await ok(sb.post(`${N}/warmSpare/swap`));
    assert.deepEqual((await byNet()).designations, set.designations);

    // The old endpoint turning it off shows in the new one, and back.
    await ok(sb.put(`${N}/warmSpare`, { enabled: false }));
    assert.deepEqual({ ...(await byNet()), designations: null }, { ...off, designations: null, uplink: { ...off.uplink, sharing: set.uplink.sharing } });
    const active = await ok(sb.put(R, { enabled: true, mode: 'active-active', designations: [{ serial: primary, priority: 1 }, { serial: spare, priority: 2 }] }));
    assert.deepEqual([active.mode, active.uplink.mode], ['active-active', 'public']);
    assert.equal((await ok(sb.get(`${N}/warmSpare`))).spareSerial, spare);
  });

  test('redundancy writes stay with a network bound to a template', async () => {
    fresh();
    const spare = await claimSpare();
    const t = await ok(sb.post(`/organizations/${org.id}/configTemplates`, { name: 'From HQ', copyFromNetworkId: hq.id }), 201);
    await ok(sb.post(`/networks/${hq.id}/bind`, { configTemplateId: t.id }));
    const set = await ok(sb.put(`${N}/devices/redundancy`, { enabled: true, designations: [{ serial: hq.mx.serial, priority: 1 }, { serial: spare, priority: 2 }] }));
    assert.equal(set.enabled, true);
    assert.equal((await ok(sb.post(`${N}/devices/redundancy/swap`))).designations[0].serial, spare);
  });
});
