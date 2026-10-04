import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { lastConnected } from '../src/sim/sm.js';
import { iso } from '../src/time.js';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;

describe('Systems Manager organization settings, trusted access and PII', () => {
  let sb;
  let lab;
  let net;
  let tor;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    net = lab.networks.find((n) => n.name === 'Lab - Systems Manager');
    tor = lab.networks.find((n) => n.name === 'Lab - Toronto');
  };
  const ok = async (r, status = 200) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };
  const errorOf = async (r, status = 400) => {
    const res = await r;
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body.errors[0];
  };
  const O = () => `/organizations/${lab.id}/sm`;
  const ASSIGN = () => `${O()}/sentry/policies/assignments`;
  const byNetwork = async (q = '') => (await ok(sb.get(`${ASSIGN()}/byNetwork${q}`)))[0];
  const policy = (extra = {}) => ({ smNetworkId: net.id, scope: 'withAny', tags: ['byod'], groupPolicyId: '101', ...extra });
  const guestPolicy = async (n = tor) => ok(sb.post(`/networks/${n.id}/groupPolicies`, { name: 'Restricted' }), 201);

  test('limited access roles are organization CRUD with a tag scope', async () => {
    fresh();
    const R = `${O()}/admins/roles`;
    const role = await ok(sb.post(R, { name: 'Help desk', scope: 'some', tags: ['byod', ' it ', 'it'] }), 201);
    assert.deepEqual(Object.keys(role), ['roleId', 'name', 'scope', 'tags']);
    assert.deepEqual([role.scope, role.tags], ['some', ['byod', 'it']]);
    const plain = await ok(sb.post(R, { name: 'Viewers' }), 201);
    assert.deepEqual([plain.scope, plain.tags], ['all_tags', []]);
    assert.match(await errorOf(sb.post(R, { name: 'Help desk' })), /already exists/);
    assert.match(await errorOf(sb.post(R, { name: 'X', tags: [''] })), /empty tags/);
    assert.match(await errorOf(sb.post(R, { name: 'X', scope: 'any' })), /'scope'/);
    assert.match(await errorOf(sb.post(R, {})), /'name' is required/);
    assert.deepEqual(await ok(sb.put(`${R}/${role.roleId}`, { scope: 'without_all_tags' })), { ...role, scope: 'without_all_tags' });

    const page = await ok(sb.get(`${R}?perPage=3`));
    assert.deepEqual(page.items.map((x) => x.roleId), [role.roleId, plain.roleId].sort());
    assert.deepEqual(page.meta.counts.items, { total: 2, remaining: 0 });
    assert.match(await errorOf(sb.get(`${R}?perPage=2`)), /perPage/);

    await ok(sb.del(`${R}/${role.roleId}`), 204);
    assert.match(await errorOf(sb.get(`${R}/${role.roleId}`), 404), /not found/);
    // Cloning the organization copies the roles.
    const clone = await ok(sb.post(`/organizations/${lab.id}/clone`, { name: 'Lab copy' }), 201);
    assert.deepEqual((await ok(sb.get(`/organizations/${clone.id}/sm/admins/roles`))).items, [plain]);
  });

  test('an organization with an SM network has an APNS certificate and a VPP account', async () => {
    fresh();
    const { certificate } = await ok(sb.get(`${O()}/apnsCert`));
    assert.match(certificate, /^-----BEGIN CERTIFICATE-----\nMIIF[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/);
    assert.equal((await ok(sb.get(`${O()}/apnsCert`))).certificate, certificate);
    const [account] = await ok(sb.get(`${O()}/vppAccounts`));
    assert.equal(account.vppAccountId, account.id);
    assert.deepEqual(account.assignableNetworkIds, [net.id]);
    assert.equal(account.networkIdAdmins, net.id);
    assert.equal(account.parsedToken.orgName, 'Acme Test Lab');
    assert.ok(!('vppServiceToken' in account) && !('contentToken' in account));
    assert.ok(account.lastSyncedAt <= NOW && account.lastSyncedAt > iso(now - 86400));
    const one = await ok(sb.get(`${O()}/vppAccounts/${account.id}`));
    assert.deepEqual({ ...one, contentToken: undefined, vppServiceToken: undefined }, { ...account, contentToken: undefined, vppServiceToken: undefined });
    assert.equal(one.contentToken, one.vppServiceToken);
    const token = JSON.parse(Buffer.from(one.contentToken, 'base64').toString());
    assert.deepEqual(Object.keys(token), ['expDate', 'token', 'orgName']);
    assert.match(await errorOf(sb.get(`${O()}/vppAccounts/123`), 404), /VPP account not found/);

    const hq = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    assert.match(await errorOf(sb.get(`/organizations/${hq.id}/sm/apnsCert`), 404), /APNS certificate not found/);
    assert.deepEqual(await ok(sb.get(`/organizations/${hq.id}/sm/vppAccounts`)), []);
  });

  test('Sentry policies are replaced per network in priority order', async () => {
    fresh();
    assert.deepEqual(await byNetwork(), { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } });
    const gp = await guestPolicy();
    const put = await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id, policies: [policy(), policy({ scope: 'all', tags: [], groupPolicyId: gp.groupPolicyId })] }] }));
    const [a, b] = put.items[0].policies;
    assert.deepEqual(put.items.map((x) => x.networkId), [tor.id]);
    assert.deepEqual([a.priority, b.priority, b.scope, b.groupNumber, b.groupPolicyId], ['1', '2', 'all', gp.groupPolicyId, gp.groupPolicyId]);
    assert.deepEqual([a.networkId, a.smNetworkId, a.createdAt, a.lastUpdatedAt], [tor.id, net.id, NOW, NOW]);
    assert.deepEqual((await byNetwork()).items, put.items);

    // Naming a policy keeps it; the order given is the new priority order.
    const again = await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id, policies: [policy({ policyId: b.policyId, scope: 'all', tags: [], groupPolicyId: gp.groupPolicyId }), policy({ tags: ['remote'] })] }] }));
    const [b2, c] = again.items[0].policies;
    assert.deepEqual({ ...b2, priority: '2' }, b);
    assert.notEqual(c.policyId, a.policyId);
    assert.deepEqual([c.priority, c.tags], ['2', ['remote']]);
    assert.equal((await byNetwork(`?networkIds[]=${net.id}`)).items.length, 0);

    for (const [body, re] of [
      [{}, /'items' is required/],
      [{ items: [{ networkId: 'N_1' }] }, /not a network in this organization/],
      [{ items: [{ networkId: net.id }] }, /wireless or an appliance/],
      [{ items: [{ networkId: tor.id }, { networkId: tor.id }] }, /more than once/],
      [{ items: [{ networkId: tor.id, policies: [policy({ smNetworkId: tor.id })] }] }, /not a Systems Manager network/],
      [{ items: [{ networkId: tor.id, policies: [policy({ groupPolicyId: '555' })] }] }, /not a group policy/],
      [{ items: [{ networkId: tor.id, policies: [policy({ policyId: '1' })] }] }, /not a Sentry policy/],
      [{ items: [{ networkId: tor.id, policies: [policy({ policyId: c.policyId }), policy({ policyId: c.policyId })] }] }, /more than once/],
      [{ items: [{ networkId: tor.id, policies: [policy({ tags: [' '] })] }] }, /empty tags/],
      [{ items: [{ networkId: tor.id, policies: [policy({ scope: 'some' })] }] }, /'items\[0\].policies\[0\].scope'/],
    ]) {
      assert.match(await errorOf(sb.put(ASSIGN(), body)), re);
    }
    assert.deepEqual((await byNetwork()).items, again.items);

    // Deleting the group policy takes its Sentry policies with it.
    await ok(sb.del(`/networks/${tor.id}/groupPolicies/${gp.groupPolicyId}`), 204);
    assert.deepEqual((await byNetwork()).items, []);
    assert.equal(lab.smSentryPolicies.list.length, 0);
    // An empty list clears a network.
    await guestPolicy();
    await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id, policies: [policy()] }] }));
    assert.deepEqual((await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id }] }))).items, [{ networkId: tor.id, policies: [] }]);
    assert.equal((await byNetwork()).items.length, 0);
  });

  test('Sentry policies follow combines and splits and stop a move', async () => {
    fresh();
    await guestPolicy();
    await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id, policies: [policy()] }] }));
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    Object.assign(sb.world.orgById.get(dest.id), { licensing: lab.licensing, licenses: [] });
    const move = await ok(sb.post(`/organizations/${lab.id}/networks/moves`, { network: { id: net.id }, organizations: { target: { id: dest.id } }, simulate: true }), 201);
    assert.match(move.result.reason, /Sentry policies/);

    const combined = await ok(sb.post(`/organizations/${lab.id}/networks/combine`, { name: 'Lab - Combined', networkIds: [tor.id, net.id] }));
    const id = combined.resultingNetwork.id;
    const [p] = (await byNetwork()).items[0].policies;
    assert.deepEqual([p.networkId, p.smNetworkId], [id, id]);
    const parts = (await ok(sb.post(`/networks/${id}/split`))).resultingNetworks;
    const part = (t) => parts.find((n) => n.productTypes.includes(t)).id;
    const [q] = (await byNetwork()).items[0].policies;
    assert.deepEqual([q.policyId, q.networkId, q.smNetworkId], [p.policyId, part('wireless'), part('systemsManager')]);
    // A deleted network takes its policies with it.
    await ok(sb.del(`/networks/${part('systemsManager')}`), 204);
    assert.deepEqual((await byNetwork()).items, []);
  });

  test('a Sentry policy hidden by a lost group policy neither stops a move nor comes back', async () => {
    fresh();
    await guestPolicy();
    await ok(sb.put(ASSIGN(), { items: [{ networkId: tor.id, policies: [policy()] }] }));
    // Binding to a template and unbinding again leaves Toronto with no group policies.
    const t = await ok(sb.post(`/organizations/${lab.id}/configTemplates`, { name: 'Lab template' }), 201);
    await ok(sb.post(`/networks/${tor.id}/bind`, { configTemplateId: t.id }));
    await ok(sb.post(`/networks/${tor.id}/unbind`, {}));
    assert.deepEqual((await byNetwork()).items, []);
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    Object.assign(sb.world.orgById.get(dest.id), { licensing: lab.licensing, licenses: [] });
    const move = await ok(sb.post(`/organizations/${lab.id}/networks/moves`, { network: { id: tor.id }, organizations: { target: { id: dest.id } }, simulate: true }), 201);
    assert.doesNotMatch(move.result.reason, /Sentry/);
    // A new group policy takes the lost one's ID without bringing the policy back.
    assert.equal((await guestPolicy()).groupPolicyId, '101');
    assert.deepEqual((await byNetwork()).items, []);
  });

  test('user access devices follow the enrolled device and keep what it had when it left', async () => {
    fresh();
    const R = `/networks/${net.id}/sm/userAccessDevices`;
    const row = net.sm.userAccessDevices[0];
    const dev = net.sm.devices.find((d) => d.id === row.deviceId);
    await ok(sb.post(`/networks/${net.id}/sm/devices/modifyTags`, { ids: [dev.id], updateAction: 'add', tags: ['travel'] }));
    await ok(sb.put(`/networks/${net.id}/sm/devices/fields`, { id: dev.id, deviceFields: { name: 'Loaner' } }));
    const [shown] = await ok(sb.get(`/networks/${net.id}/sm/devices?ids[]=${dev.id}`));
    const pick = (u) => [u.name, u.tags];
    assert.deepEqual(pick((await ok(sb.get(R))).find((u) => u.id === row.id)), [shown.name, shown.tags]);
    assert.ok(shown.tags.includes('travel'));
    await ok(sb.post(`/networks/${net.id}/sm/devices/${dev.id}/unenroll`, {}));
    assert.deepEqual(pick((await ok(sb.get(R))).find((u) => u.id === row.id)), [shown.name, shown.tags]);
  });

  test('PII requests go with their network to another organization', async () => {
    fresh();
    const R = `/networks/${net.id}/pii/requests`;
    const r = await ok(sb.post(R, { type: 'restrict processing', smDeviceId: net.sm.devices[0].id }), 201);
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    Object.assign(sb.world.orgById.get(dest.id), { licensing: lab.licensing, licenses: [] });
    const move = await ok(sb.post(`/organizations/${lab.id}/networks/moves`, { network: { id: net.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.equal(move.result.status, 'completed');
    assert.deepEqual(await ok(sb.get(R)), [r]);
    await ok(sb.del(`${R}/${r.id}`), 204);
    assert.deepEqual(await ok(sb.get(R)), []);
  });

  test('trusted access configs and user access devices', async () => {
    fresh();
    const configs = await ok(sb.get(`/networks/${net.id}/sm/trustedAccessConfigs`));
    assert.deepEqual(configs.map((c) => [c.name, c.ssidName, c.scope, c.tags]), [...net.sm.trustedAccess].map((c) => [c.name, 'Acme-Corp', 'withAny', c.tags]));
    assert.ok(configs.every((c) => c.accessStartAt < NOW && c.accessEndAt > NOW));
    const rows = await collect(sb.get, `/networks/${net.id}/sm/userAccessDevices?perPage=3`);
    assert.equal(rows.length, net.sm.userAccessDevices.length);
    assert.ok(rows.length >= 4);
    for (const u of rows) {
      const stored = net.sm.userAccessDevices.find((x) => x.id === u.id);
      const dev = net.sm.devices.find((d) => d.id === stored.deviceId);
      const owner = net.sm.users.find((x) => x.id === dev.ownerId);
      assert.deepEqual([u.name, u.mac, u.username, u.email], [dev.name, dev.wifiMac, owner.username, owner.email]);
      const wanted = configs.filter((c) => c.tags.some((t) => dev.tags.includes(t))).map((c) => c.id);
      assert.deepEqual(u.trustedAccessConnections.map((c) => c.trustedAccessConfigId), wanted);
      // The last connection agrees with the device's own check-ins.
      for (const c of u.trustedAccessConnections) assert.equal(c.lastConnectedAt, iso(lastConnected(dev, net, now)));
    }
    const [first] = rows;
    await ok(sb.del(`/networks/${net.id}/sm/userAccessDevices/${first.id}`), 204);
    assert.equal((await ok(sb.get(`/networks/${net.id}/sm/userAccessDevices`))).length, rows.length - 1);
    assert.match(await errorOf(sb.del(`/networks/${net.id}/sm/userAccessDevices/${first.id}`), 404), /not found/);
    assert.match(await errorOf(sb.get(`/networks/${tor.id}/sm/trustedAccessConfigs`)), /systemsManager/i);
  });

  test('PII lookups find SM devices, owners and clients', async () => {
    fresh();
    const P = (p, q) => `/networks/${net.id}/pii/${p}?${q}`;
    const dev = net.sm.devices.find((d) => d.imei && d.ownerId);
    const owner = net.sm.users.find((u) => u.id === dev.ownerId);
    const theirs = net.sm.devices.filter((d) => d.ownerId === owner.id);
    const keys = await ok(sb.get(P('piiKeys', `imei=${dev.imei}`)));
    assert.deepEqual(keys, { [net.id]: { macs: [dev.wifiMac], emails: [owner.email], usernames: [owner.username], serials: [dev.serialNumber], imeis: [dev.imei], bluetoothMacs: [] } });
    const byUser = await ok(sb.get(P('piiKeys', `username=${owner.username.toUpperCase()}`)));
    assert.deepEqual(byUser[net.id].serials, theirs.map((d) => d.serialNumber));
    assert.deepEqual(await ok(sb.get(P('smDevicesForKey', `email=${owner.email}`))), { [net.id]: theirs.map((d) => d.id).sort() });
    assert.deepEqual(await ok(sb.get(P('smOwnersForKey', `mac=${dev.wifiMac.toUpperCase()}`))), { [net.id]: [owner.id] });
    assert.deepEqual(await ok(sb.get(P('smOwnersForKey', `serial=${dev.serialNumber.toLowerCase()}`))), { [net.id]: [owner.id] });
    assert.deepEqual(await ok(sb.get(P('smDevicesForKey', 'serial=NOPE'))), {});
    assert.deepEqual(await ok(sb.get(P('piiKeys', 'bluetoothMac=00:11:22:33:44:55'))), {});
    assert.match(await errorOf(sb.get(P('piiKeys', `serial=${dev.serialNumber}&imei=${dev.imei}`))), /Exactly one/);
    assert.match(await errorOf(sb.get(P('piiKeys', ''))), /Exactly one/);
    const client = tor.clients[0];
    assert.deepEqual((await ok(sb.get(`/networks/${tor.id}/pii/piiKeys?mac=${client.mac}`)))[tor.id].macs, [client.mac]);
  });

  test('PII requests are jobs; deleting an SM device or owner removes it', async () => {
    fresh();
    const R = `/networks/${net.id}/pii/requests`;
    const dev = net.sm.devices.find((d) => d.ownerId);
    const restrict = await ok(sb.post(R, { type: 'restrict processing', smDeviceId: dev.id }), 201);
    assert.deepEqual(restrict, { id: restrict.id, organizationWide: false, networkId: net.id, type: 'restrict processing', status: 'Completed', createdAt: now, completedAt: now });
    const mac = await ok(sb.post(R, { type: 'delete', mac: 'AA:BB:CC:DD:EE:FF', datasets: ['all'] }), 201);
    assert.deepEqual([mac.mac, mac.datasets], ['aa:bb:cc:dd:ee:ff', "['usage', 'events', 'traffic']"]);
    const users = await ok(sb.post(R, { type: 'delete', username: 'someone', datasets: ['loginAttempts'] }), 201);
    assert.equal(users.datasets, "['loginAttempts']");
    for (const [body, re] of [
      [{ mac: 'aa:bb:cc:dd:ee:ff' }, /'type' is required/],
      [{ type: 'delete' }, /exactly one/],
      [{ type: 'delete', mac: 'aa:bb:cc:dd:ee:ff', email: 'a@b.c', datasets: ['all'] }, /exactly one/],
      [{ type: 'delete', mac: 'nope', datasets: ['all'] }, /MAC address/],
      [{ type: 'delete', email: 'nope', datasets: ['all'] }, /email address/],
      [{ type: 'delete', mac: 'aa:bb:cc:dd:ee:ff' }, /'datasets' is required/],
      [{ type: 'delete', mac: 'aa:bb:cc:dd:ee:ff', datasets: ['device'] }, /'datasets' for 'mac'/],
      [{ type: 'restrict processing', email: 'a@b.c' }, /only applies to delete/],
      [{ type: 'restrict processing', mac: 'aa:bb:cc:dd:ee:ff', datasets: ['usage'] }, /only applies to delete/],
      [{ type: 'delete', smDeviceId: '1', datasets: ['device'] }, /not a Systems Manager device/],
      [{ type: 'delete', smUserId: '1', datasets: ['user'] }, /not a Systems Manager owner/],
    ]) {
      assert.match(await errorOf(sb.post(R, body)), re);
    }
    assert.deepEqual(await ok(sb.get(R)), [restrict, mac, users]);
    assert.deepEqual(await ok(sb.get(`${R}/${mac.id}`)), mac);
    assert.match(await errorOf(sb.del(`${R}/${mac.id}`)), /Only restrict processing/);
    await ok(sb.del(`${R}/${restrict.id}`), 204);
    assert.match(await errorOf(sb.get(`${R}/${restrict.id}`), 404), /not found/);
    // Requests belong to their network.
    assert.match(await errorOf(sb.get(`/networks/${tor.id}/pii/requests/${mac.id}`), 404), /not found/);

    const owner = dev.ownerId;
    const access = net.sm.userAccessDevices.filter((u) => u.deviceId === dev.id).length;
    const before = net.sm.userAccessDevices.length;
    await ok(sb.post(R, { type: 'delete', smDeviceId: dev.id, datasets: ['all'] }), 201);
    assert.ok(!net.sm.devices.includes(dev));
    assert.equal(net.sm.userAccessDevices.length, before - access);
    await ok(sb.get(`/networks/${net.id}/sm/devices/${dev.id}/softwares`), 404);
    await ok(sb.post(R, { type: 'delete', smUserId: owner, datasets: ['user'] }), 201);
    assert.ok(!net.sm.users.some((u) => u.id === owner));
    assert.ok(net.sm.devices.every((d) => d.ownerId !== owner));
    const json = await ok(sb.get(`/networks/${net.id}/sm/devices?fields[]=ownerEmail`));
    assert.ok(json.every((d) => d.ownerEmail !== undefined));
  });
});

describe('PII requests on a running clock', () => {
  test('a request is in progress until it completes', async () => {
    const sb = await start({ now: null });
    try {
      const net = sb.world.orgs.find((o) => o.name === 'Acme Test Lab').networks.find((n) => n.sm);
      const r = (await sb.post(`/networks/${net.id}/pii/requests`, { type: 'restrict processing', mac: '00:11:22:33:44:55' })).body;
      assert.equal(r.status, 'In progress');
      assert.ok(!('completedAt' in r));
    } finally {
      sb.close();
    }
  });
});
