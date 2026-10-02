import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('MX VPN and intrusion settings', () => {
  let sb;
  let org;
  let hq;
  let austin;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    austin = org.networks.find((n) => n.name === 'Branch - Austin');
    O = `/organizations/${org.id}/appliance`;
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
  const neighbor = { ip: '10.10.10.22', remoteAsNumber: 64343, ebgpHoldTimer: 180, ebgpMultihop: 2 };
  const peer = { name: 'AWS', publicIp: '203.0.113.10', secret: 'secret', privateSubnets: ['172.31.0.0/16'] };

  test('BGP starts off with the default ASN and hold timer', async () => {
    fresh();
    assert.deepEqual(await ok(sb.get(`/networks/${hq.id}/appliance/vpn/bgp`)), { enabled: false, asNumber: 64512, ibgpHoldTimer: 240, neighbors: [] });
  });

  test('BGP on a hub takes neighbors and shares the ASN across hubs', async () => {
    fresh();
    const path = `/networks/${hq.id}/appliance/vpn/bgp`;
    const body = await ok(sb.put(path, { enabled: true, asNumber: 65001, ibgpHoldTimer: 120, routerId: '10.15.10.2', neighbors: [{ ...neighbor, sourceInterface: 'wan2', pathPrepend: [1, 2], communityOut: ['64515:100', 'NO_EXPORT'], filterIn: ['10.0.0.0/8'] }] }));
    assert.equal(body.enabled, true);
    assert.equal(body.asNumber, 65001);
    assert.equal(body.routerId, '10.15.10.2');
    assert.deepEqual(body.neighbors[0], {
      ip: '10.10.10.22',
      remoteAsNumber: 64343,
      receiveLimit: 0,
      allowTransit: false,
      ebgpHoldTimer: 180,
      ebgpMultihop: 2,
      sourceInterface: 'wan2',
      ttlSecurity: { enabled: false },
      pathPrepend: [1, 2],
      filterIn: ['10.0.0.0/8'],
      communityOut: ['64515:100', 'NO_EXPORT'],
    });
    assert.deepEqual(await ok(sb.get(path)), body);
    // The ASN covers the Auto VPN domain, so a spoke reads it too.
    assert.equal((await ok(sb.get(`/networks/${austin.id}/appliance/vpn/bgp`))).asNumber, 65001);
    // Leaving out neighbors keeps them.
    assert.equal((await ok(sb.put(path, { enabled: false }))).neighbors.length, 1);
  });

  test('BGP refuses spokes, bad ranges and unknown interfaces', async () => {
    fresh();
    const path = `/networks/${hq.id}/appliance/vpn/bgp`;
    assert.match(await errorOf(sb.put(`/networks/${austin.id}/appliance/vpn/bgp`, { enabled: true })), /hub mode/);
    assert.match(await errorOf(sb.put(path, { asNumber: 1 })), /'enabled' is required/);
    assert.match(await errorOf(sb.put(path, { enabled: true, asNumber: 0 })), /asNumber/);
    assert.match(await errorOf(sb.put(path, { enabled: true, ibgpHoldTimer: 300 })), /ibgpHoldTimer/);
    assert.match(await errorOf(sb.put(path, { enabled: true, routerId: 'router' })), /routerId/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, ip: undefined }] })), /'ip' or 'ipv6.address'/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, ebgpMultihop: 0 }] })), /ebgpMultihop/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, weight: 50 }] })), /weight/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, sourceInterface: 'wan3' }] })), /wan3 does not exist/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, sourceInterface: 'vlan999' }] })), /vlan999 does not exist/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, pathPrepend: Array(11).fill(1) }] })), /limited to 10/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, communityOut: ['nope'] }] })), /communityOut/);
    assert.match(await errorOf(sb.put(path, { enabled: true, neighbors: [neighbor, neighbor] })), /own address/);
    // A VLAN that exists and an IPv6 neighbor work.
    const v6 = await ok(sb.put(path, { enabled: true, neighbors: [{ ...neighbor, ip: undefined, ipv6: { address: '2002::1234:abcd:ffff:c0a8:101' }, sourceInterface: 'vlan10' }] }));
    assert.deepEqual(v6.neighbors[0].ipv6, { address: '2002::1234:abcd:ffff:c0a8:101' });
    assert.equal(v6.neighbors[0].ip, undefined);
  });

  test('BGP reads as off once the network is no longer a hub', async () => {
    fresh();
    await ok(sb.put(`/networks/${hq.id}/appliance/vpn/bgp`, { enabled: true }));
    await ok(sb.put(`/networks/${hq.id}/appliance/vpn/siteToSiteVpn`, { mode: 'none' }));
    assert.equal((await ok(sb.get(`/networks/${hq.id}/appliance/vpn/bgp`))).enabled, false);
  });

  test('third-party peers start empty and are replaced as a list', async () => {
    fresh();
    const path = `${O}/vpn/thirdPartyVPNPeers`;
    assert.deepEqual(await ok(sb.get(path)), { peers: [] });
    const { peers } = await ok(sb.put(path, { peers: [peer, { name: 'Azure', publicHostname: 'vpn.example.com', secret: 's2', privateSubnets: ['10.200.0.0/16'], ipsecPoliciesPreset: 'azure', ikeVersion: '2', network: { ids: [hq.id] } }] }));
    assert.equal(peers.length, 2);
    assert.match(peers[0].peerId, /^\d{18}$/);
    assert.deepEqual(peers[0], { peerId: peers[0].peerId, name: 'AWS', publicIp: '203.0.113.10', secret: 'secret', privateSubnets: ['172.31.0.0/16'], ipsecPoliciesPreset: 'default', ikeVersion: '1', networkTags: ['all'], isRouteBased: false });
    assert.equal(peers[1].ipsecPoliciesPreset, 'azure');
    assert.deepEqual(peers[1].network, { names: ['HQ - San Francisco'], ids: [hq.id] });
    assert.deepEqual(await ok(sb.get(path)), { peers });
    // A peer sent back with its ID keeps it; one left out is removed.
    const again = await ok(sb.put(path, { peers: [{ ...peers[1], name: 'Azure 2' }] }));
    assert.equal(again.peers.length, 1);
    assert.equal(again.peers[0].peerId, peers[1].peerId);
    assert.equal(again.peers[0].name, 'Azure 2');
  });

  test('third-party peers take custom IPsec policies, BGP and groups', async () => {
    fresh();
    const path = `${O}/vpn/thirdPartyVPNPeers`;
    const custom = { ...peer, ipsecPolicies: { ikeCipherAlgo: ['aes256'], ikeDiffieHellmanGroup: ['group14'], childCipherAlgo: ['aes256', 'aes128'], childPfsGroup: ['group14'] } };
    const routed = { ...peer, name: 'Routed', isRouteBased: true, ebgpNeighbor: { neighborIp: '169.254.0.2', remoteAsNumber: 64600, sourceIp: '169.254.0.1' }, ecmpUplinkConfigs: [{ wan: 'WAN 1', privateSubnets: ['169.254.10.0/30'], ebgpNeighbor: { neighborIp: '169.254.10.2' } }] };
    const { peers } = await ok(sb.put(path, { peers: [{ ...custom, group: { number: 9 }, priorityInGroup: 999 }, { ...routed, group: { number: 9 }, priorityInGroup: 5 }, { ...peer, name: 'Other', group: { number: 3, failover: { directToInternet: true } } }] }));
    assert.deepEqual(peers[0].ipsecPolicies, {
      ikeCipherAlgo: ['aes256'],
      ikeAuthAlgo: ['sha1'],
      ikePrfAlgo: ['default'],
      ikeDiffieHellmanGroup: ['group14'],
      ikeLifetime: 28800,
      childCipherAlgo: ['aes256', 'aes128'],
      childAuthAlgo: ['sha1'],
      childPfsGroup: ['group14'],
      childLifetime: 28800,
    });
    assert.equal(peers[0].ipsecPoliciesPreset, undefined);
    assert.deepEqual(peers[1].ebgpNeighbor, { neighborId: 1, neighborIp: '169.254.0.2', ipVersion: 4, remoteAsNumber: 64600, ebgpHoldTimer: 180, ebgpMultihop: 1, sourceIp: '169.254.0.1' });
    assert.match(peers[1].ecmpUplinkConfigs[0].id, /^\d{18}$/);
    // Group numbers and priorities become 1, 2, 3 in their order.
    assert.deepEqual(peers.map((p) => [p.group.number, p.priorityInGroup]), [[2, 2], [2, 1], [1, undefined]]);
    assert.deepEqual(peers[2].group.failover, { directToInternet: true });
    // Sent back, the neighbor and ECMP config keep their IDs.
    const again = await ok(sb.put(path, { peers }));
    assert.deepEqual(again.peers, peers);
  });

  test('third-party peers refuse bad fields without changing anything', async () => {
    fresh();
    const path = `${O}/vpn/thirdPartyVPNPeers`;
    await ok(sb.put(path, { peers: [peer] }));
    const bad = async (p, re) => assert.match(await errorOf(sb.put(path, { peers: [peer, p].map((x, i) => (i ? { ...peer, name: 'B', ...x } : x)) })), re);
    await bad({ name: '' }, /name' must not be empty/);
    await bad({ secret: '' }, /secret/);
    await bad({ publicIp: undefined }, /'publicIp' or 'publicHostname'/);
    await bad({ publicHostname: 'vpn.example.com' }, /not both/);
    await bad({ publicIp: '300.1.1.1' }, /publicIp/);
    await bad({ remoteId: 'not valid' }, /remoteId/);
    await bad({ privateSubnets: [] }, /privateSubnets/);
    await bad({ privateSubnets: ['10.0.0.1'] }, /privateSubnets/);
    await bad({ peerId: '1' }, /not a peer/);
    await bad({ slaPolicy: { id: '1' } }, /SLA policy/);
    await bad({ network: { ids: ['L_1'] } }, /appliance network/);
    await bad({ ipsecPolicies: { ikeDiffieHellmanGroup: ['group19'] } }, /ikeDiffieHellmanGroup/);
    await bad({ ipsecPolicies: { ikeCipherAlgo: ['aes256', 'aes128'] } }, /exactly one/);
    await bad({ ipsecPolicies: { childPfsGroup: [] } }, /at least one/);
    await bad({ ebgpNeighbor: { neighborIp: '10.0.0.1', remoteAsNumber: 1 } }, /isRouteBased/);
    await bad({ isRouteBased: true, ebgpNeighbor: { neighborIp: '10.0.0.1', remoteAsNumber: 1, ipVersion: 6 } }, /ipVersion/);
    await bad({ isRouteBased: true, ebgpNeighbor: { neighborIp: '10.0.0.1' } }, /remoteAsNumber/);
    await bad({ isRouteBased: true, ecmpUplinkConfigs: [{ wan: 'WAN 1', privateSubnets: ['169.254.10.0/30'] }, { wan: 'WAN 1', privateSubnets: ['169.254.10.4/30'] }] }, /each WAN once/);
    await bad({ name: 'AWS' }, /own name/);
    assert.equal((await ok(sb.get(path))).peers.length, 1);
  });

  test('IPsec SLA policies list the peers that use them', async () => {
    fresh();
    const path = `${O}/vpn/siteToSite/ipsec/peers/slas`;
    assert.deepEqual(await ok(sb.get(path)), { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    const { items } = await ok(sb.put(path, { items: [{ name: 'sla policy', uri: 'http://checkthisendpoint.com' }, { name: 'other', uri: 'https://example.com/health' }] }));
    assert.equal(items.length, 2);
    const { peers } = await ok(sb.put(`${O}/vpn/thirdPartyVPNPeers`, { peers: [{ ...peer, slaPolicy: { id: items[0].id } }] }));
    assert.deepEqual(peers[0].slaPolicy, { id: items[0].id });
    const read = await ok(sb.get(path));
    assert.deepEqual(read.items[0], { id: items[0].id, name: 'sla policy', uri: 'http://checkthisendpoint.com', ipsec: { peerIds: [peers[0].peerId] } });
    assert.deepEqual(read.items[1].ipsec.peerIds, []);
    // A policy kept by name keeps its ID; a removed one drops off the peer.
    const kept = await ok(sb.put(path, { items: [{ name: 'other', uri: 'https://example.com/other' }] }));
    assert.equal(kept.items[0].id, items[1].id);
    assert.equal((await ok(sb.get(`${O}/vpn/thirdPartyVPNPeers`))).peers[0].slaPolicy, undefined);
    assert.match(await errorOf(sb.put(path, { items: [{ name: 'x', uri: 'ftp://example.com' }] })), /http or https/);
    assert.match(await errorOf(sb.put(path, { items: [{ name: '', uri: 'http://example.com' }] })), /name/);
    assert.match(await errorOf(sb.put(path, { items: [{ name: 'x' }] })), /uri' is required/);
    assert.match(await errorOf(sb.put(path, { items: [{ name: 'x', uri: 'http://a.com' }, { name: 'x', uri: 'http://b.com' }] })), /own name/);
  });

  test('VPN firewall rules end with the default rule', async () => {
    fresh();
    const path = `${O}/vpn/vpnFirewallRules`;
    const def = { comment: 'Default rule', policy: 'allow', protocol: 'Any', srcPort: 'Any', srcCidr: 'Any', destPort: 'Any', destCidr: 'Any', syslogEnabled: false };
    assert.deepEqual(await ok(sb.get(path)), { rules: [def] });
    const rule = { comment: 'Web', policy: 'deny', protocol: 'tcp', srcCidr: '10.0.0.0/8', destCidr: '192.168.1.0/24,192.168.2.1', destPort: '443' };
    const body = await ok(sb.put(path, { rules: [rule, def], syslogDefaultRule: true }));
    assert.deepEqual(body, { rules: [{ ...rule, srcPort: 'Any', syslogEnabled: false }, { ...def, syslogEnabled: true }] });
    assert.deepEqual(await ok(sb.get(path)), body);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, destCidr: 'example.com' }] })), /destCidr/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, destPort: '70000' }] })), /destPort/);
    assert.match(await errorOf(sb.put(path, { rules: [{ ...rule, policy: 'drop' }] })), /policy/);
  });

  test('organization intrusion settings hold the allowed rules', async () => {
    fresh();
    const path = `${O}/security/intrusion`;
    assert.deepEqual(await ok(sb.get(path)), { allowedRules: [] });
    const body = await ok(sb.put(path, { allowedRules: [{ ruleId: 'meraki:intrusion/snort/GID/1/SID/19559', message: 'ignored' }, { ruleId: 'meraki:intrusion/snort/GID/01/SID/688' }] }));
    assert.deepEqual(body, { allowedRules: [{ ruleId: 'meraki:intrusion/snort/GID/1/SID/19559', message: 'INDICATOR-SCAN SSH brute force login attempt' }, { ruleId: 'meraki:intrusion/snort/GID/01/SID/688' }] });
    assert.deepEqual(await ok(sb.get(path)), body);
    assert.match(await errorOf(sb.put(path, { allowedRules: [{ ruleId: '1:688' }] })), /ruleId/);
    assert.match(await errorOf(sb.put(path, {})), /allowedRules' is required/);
  });

  test('a failed action batch rolls back VPN writes', async () => {
    fresh();
    const r = await ok(
      sb.post(`/organizations/${org.id}/actionBatches`, {
        confirmed: true,
        synchronous: true,
        actions: [
          { resource: `/organizations/${org.id}/appliance/vpn/thirdPartyVPNPeers`, operation: 'update', body: { peers: [peer] } },
          { resource: `/networks/${hq.id}/appliance/vpn/bgp`, operation: 'update', body: { enabled: true, asNumber: 65010 } },
          { resource: `/networks/${austin.id}/appliance/vpn/bgp`, operation: 'update', body: { enabled: true } },
        ],
      }),
      201,
    );
    assert.equal(r.status.failed, true);
    assert.deepEqual(await ok(sb.get(`${O}/vpn/thirdPartyVPNPeers`)), { peers: [] });
    assert.equal((await ok(sb.get(`/networks/${hq.id}/appliance/vpn/bgp`))).asNumber, 64512);
    // The same peers written again get the same ID as without the batch.
    const first = (await ok(sb.put(`${O}/vpn/thirdPartyVPNPeers`, { peers: [peer] }))).peers[0].peerId;
    await sb.reset();
    fresh();
    assert.equal((await ok(sb.put(`${O}/vpn/thirdPartyVPNPeers`, { peers: [peer] }))).peers[0].peerId, first);
  });
});
