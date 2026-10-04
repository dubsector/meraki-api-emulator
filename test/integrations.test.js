import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { collect, start } from './helpers.js';

const KEYS = { api: { key: 'umbrella-key', secret: 'umbrella-secret' } };

describe('Umbrella, XDR, Spaces and integration lists', () => {
  let sb;
  let corp;
  let lab;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    corp = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
  };
  const net = (org, name) => org.networks.find((n) => n.name === name);
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
  const xdr = (verb, ...nets) => sb.post(`/organizations/${corp.id}/integrations/xdr/networks/${verb}`, { networks: nets.map((n) => ({ networkId: n.id, productTypes: ['appliance'] })) });

  test('Umbrella connects, applies policies idempotently and nulls IDs with protection off', async () => {
    fresh();
    const U = `/networks/${net(corp, 'HQ - San Francisco').id}/appliance/umbrella`;
    assert.match(await errorOf(sb.post(`${U}/policies/add`, { policy: { id: '13408726' } })), /No Umbrella account/);
    assert.match(await errorOf(sb.put(`${U}/protection`, { enabled: true })), /No Umbrella account/);
    assert.match(await errorOf(sb.post(`${U}/account/disconnect`)), /No Umbrella account/);
    assert.match(await errorOf(sb.post(`${U}/account/connect`, { api: { key: 'k' } })), /'api.secret' is required/);

    const made = await ok(sb.post(`${U}/account/connect`, KEYS));
    assert.match(made.umbrella.organization.id, /^\d{7}$/);
    assert.ok(!JSON.stringify(made).includes('umbrella-secret'));
    assert.deepEqual(await ok(sb.post(`${U}/account/connect`, KEYS)), made, 'the same key names the same Umbrella organization');

    const added = await ok(sb.post(`${U}/policies/add`, { policy: { id: '13408726' } }));
    assert.deepEqual(added, { network: { id: net(corp, 'HQ - San Francisco').id }, policies: [{ id: '13408726' }] });
    assert.deepEqual(await ok(sb.post(`${U}/policies/add`, { policy: { id: '13408726' } })), added);
    await ok(sb.post(`${U}/policies/add`, { policy: { id: '55' } }));
    assert.equal(await ok(sb.post(`${U}/policies/remove`, { policy: { id: '55' } }), 204), '');
    assert.match(await errorOf(sb.post(`${U}/policies/remove`, { policy: { id: '55' } })), /not applied/);
    assert.match(await errorOf(sb.post(`${U}/policies/add`, { policy: { id: 'abc' } })), /policy ID/);

    const on = await ok(sb.put(`${U}/protection`, { enabled: true }));
    assert.equal(on.enabled, true);
    assert.equal(on.umbrella.organization.id, made.umbrella.organization.id);
    assert.match(on.umbrella.origin.id, /^\d{9}$/);
    assert.deepEqual(await ok(sb.put(`${U}/protection`, { enabled: false })), { umbrella: { organization: { id: null }, origin: { id: null } }, enabled: false });

    // Connecting another account drops the old account's policies.
    await ok(sb.post(`${U}/account/connect`, { api: { key: 'other', secret: 's' } }));
    assert.deepEqual((await ok(sb.post(`${U}/policies/add`, { policy: { id: '7' } }))).policies, [{ id: '7' }]);

    assert.equal(await ok(sb.post(`${U}/account/disconnect`), 204), '');
    assert.match(await errorOf(sb.post(`${U}/policies/add`, { policy: { id: '7' } })), /No Umbrella account/);
    assert.match(await errorOf(sb.post(`/networks/${net(lab, 'Lab - Toronto').id}/appliance/umbrella/account/connect`, KEYS)), /product type 'appliance'/);
  });

  test('Umbrella exclusions replace the list, lowercased, with no wildcards', async () => {
    fresh();
    const U = `/networks/${net(corp, 'Branch - Austin').id}/appliance/umbrella/domains/exclusions`;
    assert.deepEqual(await ok(sb.put(U, { domains: ['Example.COM', 'corp.example.org', 'example.com'] })), { domains: ['example.com', 'corp.example.org'] });
    assert.deepEqual(await ok(sb.put(U, { domains: ['acme.test'] })), { domains: ['acme.test'] });
    assert.match(await errorOf(sb.put(U, { domains: ['*.example.com'] })), /no wildcards/);
    assert.deepEqual(await ok(sb.put(U, { domains: [] })), { domains: [] });
  });

  test('XDR lists every appliance network and enables or disables them', async () => {
    fresh();
    const X = `/organizations/${corp.id}/integrations/xdr/networks`;
    const rows = await collect(sb.get, `${X}?perPage=3`);
    assert.deepEqual(rows.map((r) => r.networkId), corp.networks.filter((n) => n.productTypes.includes('appliance')).map((n) => n.id).sort());
    assert.ok(rows.every((r) => !r.enabled && r.isEligible && r.productTypes.length === 0));

    const hq = net(corp, 'HQ - San Francisco');
    const austin = net(corp, 'Branch - Austin');
    const on = await ok(xdr('enable', hq, austin, hq));
    assert.deepEqual(on.networks.map((r) => [r.networkId, r.name, r.enabled, r.productTypes]), [[hq.id, hq.name, true, ['appliance']], [austin.id, austin.name, true, ['appliance']]]);
    const off = await ok(xdr('disable', austin));
    assert.deepEqual(off.networks, [{ networkId: austin.id, productTypes: ['appliance'], name: austin.name, enabled: false, isEligible: true }]);
    const [only] = (await ok(sb.get(`${X}?networkIds[]=${hq.id}`))).items;
    assert.deepEqual([only.enabled, only.productTypes], [true, ['appliance']]);

    // Every row is checked before anything changes.
    assert.match(await errorOf(xdr('enable', austin, net(lab, 'Lab - Toronto'))), /networks\[1\]\.networkId/);
    assert.equal((await ok(sb.get(`${X}?networkIds[]=${austin.id}`))).items[0].enabled, false);
    assert.match(await errorOf(sb.post(`${X}/enable`, { networks: [{ networkId: hq.id, productTypes: ['wireless'] }] })), /appliance/);
    assert.match(await errorOf(sb.post(`${X}/enable`, { networks: [] })), /at least one/);
  });

  test('XDR follows a split, drops a removed network and needs an MX', async () => {
    fresh();
    const X = `/organizations/${corp.id}/integrations/xdr/networks`;
    const hq = net(corp, 'HQ - San Francisco');
    const denver = net(corp, 'Retail - Denver');
    await ok(xdr('enable', hq, denver));
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const appliance = parts.find((p) => p.productTypes.includes('appliance'));
    await ok(sb.del(`/networks/${denver.id}`), 204);
    const enabled = (await collect(sb.get, X)).filter((r) => r.enabled).map((r) => r.networkId);
    assert.deepEqual(enabled, [appliance.id]);

    const london = net(corp, 'Remote - London');
    await ok(sb.post(`/networks/${london.id}/devices/remove`, { serial: london.mx.serial }), 204);
    const [row] = (await ok(sb.get(`${X}?networkIds[]=${london.id}`))).items;
    assert.equal(row.isEligible, false);
    assert.match(await errorOf(xdr('enable', london)), /not eligible/);
  });

  test('Spaces is linked in Acme Test Lab only, and remove answers its status', async () => {
    fresh();
    const S = (org) => `/organizations/${org.id}/spaces`;
    assert.deepEqual(await ok(sb.get(`${S(corp)}/integrate/status`)), { status: false, states: [] });
    const status = await ok(sb.get(`${S(lab)}/integrate/status`));
    const engineer = lab.admins[0];
    assert.deepEqual([status.status, status.email, status.accountName, status.accountType], [true, engineer.email, 'Acme Test Lab', 'Extend']);
    assert.equal(status.states.at(-1), `Invite email sent to ${engineer.email}`);
    assert.equal((await ok(sb.post(`${S(lab)}/integration/remove`))).status, true);
    assert.deepEqual(await ok(sb.get(`${S(lab)}/integrate/status`)), { status: false, states: [] });
    assert.deepEqual(await ok(sb.post(`${S(lab)}/integration/remove`)), { status: false, message: 'The organization has no Spaces integration' });
  });

  test('deployed integrations come from Secure Access, XDR and Spaces state', async () => {
    fresh();
    const D = (org, which) => `/organizations/${org.id}/integrations/${which}`;
    const types = async (org) => (await ok(sb.get(D(org, 'deployed')))).items.map((i) => i.type);
    const deployable = async (org) => Object.fromEntries((await ok(sb.get(D(org, 'deployable')))).items.map((i) => [i.type, i.isDeployable]));
    assert.deepEqual(await types(corp), []);
    assert.deepEqual(await types(lab), ['Cisco Spaces']);
    const all = (await ok(sb.get(D(corp, 'deployable')))).items;
    assert.equal(all.length, 10);
    assert.ok(all.every((i) => i.isDeployable));
    assert.equal((await deployable(lab))['Cisco Spaces'], false);

    const sase = await ok(sb.post(`/organizations/${corp.id}/sase/integrations`, { api: { key: 'k', secret: 's' } }), 201);
    await ok(xdr('enable', net(corp, 'Branch - Austin')));
    const items = (await ok(sb.get(D(corp, 'deployed')))).items;
    assert.deepEqual(items.map((i) => i.type), ['Secure Access', 'XDR']);
    assert.equal(items[0].id, sase.integrationId);
    assert.match(items[1].id, /^\d{5}$/);
    assert.equal((await deployable(corp))['Secure Access'], false);

    await ok(xdr('disable', net(corp, 'Branch - Austin')));
    await ok(sb.del(`/organizations/${corp.id}/sase/integrations/${sase.integrationId}`), 204);
    assert.deepEqual(await types(corp), []);
  });
});
