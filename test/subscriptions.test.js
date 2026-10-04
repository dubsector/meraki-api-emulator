import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { NOW, collect, start } from './helpers.js';

const now = Date.parse(NOW) / 1000;
const A = '/administered/licensing/subscription';

describe('subscription licensing and order claims', () => {
  let sb;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const ok = async (res) => {
    const r = await res;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const errorOf = async (res, status = 400) => {
    const r = await res;
    assert.equal(r.status, status, JSON.stringify(r.body));
    return r.body.errors[0];
  };
  const pool = () => sb.world.unclaimed;
  const keyed = () => pool().subscriptions.find((s) => s.name === 'Lab networking');
  const newOrg = async (name = 'Subscriptions') => (await sb.post('/organizations', { name })).body;
  const claim = (org, extra = {}) => ok(sb.post(`${A}/subscriptions/claim`, { claimKey: keyed().claimKey, organizationId: org.id, ...extra }));

  test('entitlements are a fixed list, filtered by SKU and subscription type', async () => {
    const all = await ok(sb.get(`${A}/entitlements`));
    assert.ok(all.length > 10);
    assert.deepEqual(all.find((e) => e.sku === 'LIC-MR-A'), { sku: 'LIC-MR-A', name: 'MR', productType: 'wireless', productClass: 'MR', featureTier: 'advantage', isAddOn: false, isFree: false });
    assert.deepEqual((await ok(sb.get(`${A}/entitlements?skus[]=LIC-MT-E&skus[]=LIC-MX-ADD-SDW`))).map((e) => [e.sku, e.isFree, e.isAddOn, e.featureTier]), [
      ['LIC-MT-E', true, false, 'essentials'],
      ['LIC-MX-ADD-SDW', false, true, null],
    ]);
    const unified = await ok(sb.get(`${A}/entitlements?subscriptionType=unified`));
    assert.ok(unified.length < all.length && unified.every((e) => !e.isAddOn));
    assert.match(await errorOf(sb.get(`${A}/entitlements?subscriptionType=other`)), /subscriptionType/);
  });

  test('no organization starts with subscriptions, and the lists need organizationIds', async () => {
    const [corp, lab] = sb.world.orgs;
    assert.deepEqual(await ok(sb.get(`${A}/subscriptions?organizationIds[]=${corp.id}&organizationIds[]=${lab.id}`)), []);
    assert.deepEqual(await ok(sb.get(`${A}/subscriptions/compliance/statuses?organizationIds[]=${lab.id}`)), []);
    assert.match(await errorOf(sb.get(`${A}/subscriptions`)), /organizationIds/);
    assert.match(await errorOf(sb.get(`${A}/subscriptions/compliance/statuses`)), /organizationIds/);
    assert.match(await errorOf(sb.get(`${A}/subscriptions?organizationIds[]=1`)), /Organization 1 not found/);
  });

  test('a claim key validates, then claims into a new empty organization only', async () => {
    const key = keyed().claimKey;
    const found = await ok(sb.post(`${A}/subscriptions/claimKey/validate`, { claimKey: key.toLowerCase() }));
    assert.equal(found.name, 'Lab networking');
    assert.equal(found.status, 'active');
    assert.deepEqual(found.counts, { seats: { assigned: 0, available: 26, limit: 26 }, networks: 0, organizations: 0 });
    assert.deepEqual(found.productTypes, ['wireless', 'switch', 'appliance', 'sensor']);
    const [corp, lab] = sb.world.orgs;
    for (const o of [corp, lab]) assert.match(await errorOf(sb.post(`${A}/subscriptions/claim`, { claimKey: key, organizationId: o.id })), /does not use subscription licensing/);
    const org = await newOrg();
    // validate only checks.
    const preview = await ok(sb.post(`${A}/subscriptions/claim?validate=true`, { claimKey: key, organizationId: org.id, name: 'Mine' }));
    assert.equal(preview.name, 'Mine');
    assert.equal((await ok(sb.get(`/organizations/${org.id}`))).licensing.model, 'co-term');
    assert.ok(keyed());
    const sub = await claim(org, { name: 'Mine', description: 'Ours' });
    assert.deepEqual([sub.name, sub.description, sub.lastUpdatedAt, sub.counts.organizations], ['Mine', 'Ours', NOW, 1]);
    assert.equal((await ok(sb.get(`/organizations/${org.id}`))).licensing.model, 'subscription');
    assert.deepEqual(await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`)), [sub]);
    assert.match(await errorOf(sb.post(`${A}/subscriptions/claimKey/validate`, { claimKey: key })), /already been claimed/);
    assert.match(await errorOf(sb.post(`${A}/subscriptions/claim`, { claimKey: key, organizationId: org.id })), /already been claimed/);
    assert.match(await errorOf(sb.post(`${A}/subscriptions/claimKey/validate`, { claimKey: 'S2XX-XXXX-XXXX' })), /not found/);
    // A subscription organization has no co-term or per-device overview, and takes no per-device licenses.
    assert.match(await errorOf(sb.get(`/organizations/${org.id}/licenses/overview`)), /subscription licensing/);
    assert.match(await errorOf(sb.post(`/organizations/${lab.id}/licenses/move`, { destOrganizationId: org.id, licenseIds: [lab.licenses[0].id] })), /does not support per-device/);
  });

  test('a future subscription is inactive, and the list filters', async () => {
    const org = await newOrg();
    await claim(org);
    const later = pool().subscriptions.find((s) => s.name === 'Lab cameras');
    const cams = await ok(sb.post(`${A}/subscriptions/claim`, { claimKey: later.claimKey, organizationId: org.id }));
    assert.equal(cams.status, 'inactive');
    const q = (s) => sb.get(`${A}/subscriptions?organizationIds[]=${org.id}&${s}`);
    const names = async (s) => (await ok(q(s))).map((x) => x.name);
    assert.deepEqual(await names('statuses[]=inactive'), ['Lab cameras']);
    assert.deepEqual(await names('productTypes[]=camera'), ['Lab cameras']);
    assert.deepEqual(await names('skus[]=LIC-MR-A'), ['Lab networking']);
    assert.deepEqual(await names('name=CAMERA'), ['Lab cameras']);
    assert.deepEqual(await names(`startDate[gt]=${NOW}`), ['Lab cameras']);
    assert.deepEqual(await names(`startDate[lte]=${NOW}`), ['Lab networking']);
    assert.deepEqual(await names(`endDate=${cams.endDate}`), ['Lab cameras']);
    assert.deepEqual(await names(`subscriptionIds[]=${cams.subscriptionId}`), ['Lab cameras']);
    assert.match(await errorOf(q('startDate[lt]=soon')), /startDate\[lt\]/);
    assert.equal((await collect(sb.get, `${A}/subscriptions?organizationIds[]=${org.id}&perPage=3`)).length, 2);
  });

  test('binding networks assigns seats from their devices and reports what is missing', async () => {
    const org = await newOrg();
    const sub = await claim(org);
    const net = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Site', productTypes: ['wireless', 'switch'] })).body;
    // The order's two APs, claimed into the network.
    const order = pool().orders[0];
    await ok(sb.post(`/organizations/${org.id}/inventory/orders/claim`, { claimId: order.claimId }));
    await ok(sb.post(`/networks/${net.id}/devices/claim`, { serials: order.serials }));
    const B = `${A}/subscriptions/${sub.subscriptionId}/bind`;
    const checked = await ok(sb.post(`${B}?validate=true`, { networkIds: [net.id] }));
    assert.deepEqual(checked, { subscriptionId: sub.subscriptionId, networks: [{ id: net.id, name: 'Site' }], errors: [], insufficientEntitlements: [] });
    assert.equal((await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`)))[0].counts.networks, 0);
    await ok(sb.post(B, { networkIds: [net.id] }));
    const [after] = await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`));
    assert.deepEqual(after.entitlements[0], { sku: 'LIC-MR-A', seats: { assigned: 2, available: 8, limit: 10 } });
    assert.deepEqual([after.counts.networks, after.counts.seats.assigned, after.status], [1, 2, 'active']);
    // A network is bound to one subscription at a time, so binding moves it.
    const cams = await ok(sb.post(`${A}/subscriptions/claim`, { claimKey: pool().subscriptions.find((x) => x.name === 'Lab cameras').claimKey, organizationId: org.id }));
    const empty = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Empty', productTypes: ['camera'] })).body;
    await ok(sb.post(B, { networkIds: [empty.id] }));
    await ok(sb.post(`${A}/subscriptions/${cams.subscriptionId}/bind`, { networkIds: [empty.id] }));
    const counts = (await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`))).map((x) => [x.name, x.counts.networks]).sort();
    assert.deepEqual(counts, [
      ['Lab cameras', 1],
      ['Lab networking', 1],
    ]);
    // A camera claimed into the bound network needs a seat the subscription lacks.
    const corp = sb.world.orgs[0];
    const spare = corp.spares.find((x) => x.productType === 'camera');
    corp.spares.splice(corp.spares.indexOf(spare), 1);
    sb.world.orgById.get(org.id).spares.push(spare);
    await ok(sb.post(`/networks/${net.id}/devices/claim`, { serials: [spare.serial] }));
    const [status] = await ok(sb.get(`${A}/subscriptions/compliance/statuses?organizationIds[]=${org.id}`));
    assert.deepEqual(status, {
      subscription: { id: sub.subscriptionId, name: 'Lab networking', status: 'out_of_compliance' },
      violations: { byProductClass: [{ productClass: 'MV', gracePeriodEndsAt: new Date((now + 30 * 86400) * 1000).toISOString().replace('.000Z', 'Z'), missing: { entitlements: [{ sku: 'LIC-MV-E', quantity: 1 }] } }] },
    });
    // Binding it again adds nothing, so the shortfall already there doesn't block it.
    assert.deepEqual((await ok(sb.post(`${B}?validate=true`, { networkIds: [net.id] }))).insufficientEntitlements, []);
    // A network bringing another camera is refused for that one.
    const camNet = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Cameras', productTypes: ['camera'] })).body;
    const cam = sb.world.devices.find((d) => d.productType === 'camera' && d.net.org === corp);
    assert.equal((await sb.post(`/networks/${cam.net.id}/devices/remove`, { serial: cam.serial })).status, 204);
    const back = corp.spares.find((x) => x.serial === cam.serial);
    corp.spares.splice(corp.spares.indexOf(back), 1);
    sb.world.orgById.get(org.id).spares.push(back);
    await ok(sb.post(`/networks/${camNet.id}/devices/claim`, { serials: [cam.serial] }));
    const short = await ok(sb.post(`${B}?validate=true`, { networkIds: [camNet.id] }));
    assert.deepEqual([short.errors, short.insufficientEntitlements], [['Insufficient licenses'], [{ sku: 'LIC-MV-E', quantity: 1 }]]);
    assert.match(await errorOf(sb.post(B, { networkIds: [camNet.id] })), /1 x LIC-MV-E/);
    assert.match(await errorOf(sb.post(B, { networkIds: [sb.world.orgs[0].networks[0].id] })), /not in the subscription's organization/);
    assert.match(await errorOf(sb.post(B, { networkIds: [] })), /must not be empty/);
    assert.match(await errorOf(sb.post(`${A}/subscriptions/1/bind`, { networkIds: [net.id] }), 404), /Subscription not found/);
  });

  test('an order previews, then claims its devices and chosen subscriptions', async () => {
    const order = pool().orders[0];
    const lab = sb.world.orgs[1];
    const P = (org) => `/organizations/${org.id}/inventory/orders`;
    const preview = await ok(sb.post(`${P(lab)}/preview`, { claimId: order.claimId.toLowerCase() }));
    assert.equal(preview.resolution.claimableShippedDeviceCount, 2);
    assert.deepEqual(preview.shipping.shipments[0].devices, [{ quantity: 2, sku: 'CW9166I-HW', description: 'Meraki CW9166I Cloud Managed AP' }]);
    assert.deepEqual(preview.shipping.pending.devices, [{ quantity: 1, sku: 'C8455-G2-MX-HW', description: 'Cisco C8455-G2-MX Secure Router' }]);
    const [os] = preview.subscriptions;
    assert.deepEqual([os.isClaimed, os.counts.seats.limit], [false, 3]);
    // A per-device organization takes the devices, but not the subscription.
    assert.match(await errorOf(sb.post(`${P(lab)}/claim`, { claimId: order.claimId, subscriptions: [{ subscriptionId: os.subscriptionId }] })), /does not use subscription licensing/);
    assert.match(await errorOf(sb.post(`${P(lab)}/claim`, { claimId: order.claimId, subscriptions: [{ subscriptionId: '1' }] })), /not part of this order/);
    assert.match(await errorOf(sb.post(`${P(lab)}/claim`, { claimId: 'NOPE' })), /not found/);
    const spares = lab.spares.length;
    const got = await ok(sb.post(`${P(lab)}/claim`, { claimId: order.claimId }));
    assert.deepEqual(got, { claimId: order.claimId, number: order.number, serials: order.serials, subscriptions: [] });
    assert.equal(lab.spares.length, spares + 2);
    assert.equal((await ok(sb.get(`/organizations/${lab.id}/inventory/devices/${order.serials[0]}`))).orderNumber, order.number);
    assert.equal((await ok(sb.post(`${P(lab)}/preview`, { claimId: order.claimId }))).resolution.claimableShippedDeviceCount, 0);
    assert.match(await errorOf(sb.post(`${P(lab)}/claim`, { claimId: order.claimId })), /already been claimed/);
    // The subscription still waits for a subscription organization.
    const org = await newOrg();
    const left = await ok(sb.post(`${P(org)}/claim`, { claimId: order.claimId, subscriptions: [{ subscriptionId: os.subscriptionId, name: 'Order' }] }));
    assert.deepEqual(left.serials, []);
    assert.deepEqual(left.subscriptions.map((s) => [s.name, s.isClaimed, s.startDate]), [['Order', true, os.startDate]]);
    assert.deepEqual((await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`))).map((s) => s.name), ['Order']);
    assert.equal((await ok(sb.post(`${P(org)}/preview`, { claimId: order.claimId }))).subscriptions[0].isClaimed, true);
  });

  test('a removed network drops out of its subscription, a split keeps every part bound and a combine one subscription', async () => {
    const org = await newOrg();
    const sub = await claim(org);
    const net = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Gone', productTypes: ['wireless'] })).body;
    await ok(sb.post(`${A}/subscriptions/${sub.subscriptionId}/bind`, { networkIds: [net.id] }));
    assert.equal((await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`)))[0].counts.networks, 1);
    assert.equal((await sb.del(`/networks/${net.id}`)).status, 204);
    assert.equal((await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`)))[0].counts.networks, 0);
    const both = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Both', productTypes: ['wireless', 'switch'] })).body;
    await ok(sb.post(`${A}/subscriptions/${sub.subscriptionId}/bind`, { networkIds: [both.id] }));
    // The order's APs in the wireless part still take seats after the split.
    const order = pool().orders[0];
    await ok(sb.post(`/organizations/${org.id}/inventory/orders/claim`, { claimId: order.claimId }));
    await ok(sb.post(`/networks/${both.id}/devices/claim`, { serials: order.serials }));
    const seats = async () => (await ok(sb.get(`${A}/subscriptions?organizationIds[]=${org.id}`))).map((x) => [x.name, x.counts.networks, x.counts.seats.assigned]);
    assert.deepEqual(await seats(), [['Lab networking', 1, 2]]);
    const parts = (await ok(sb.post(`/networks/${both.id}/split`, {}))).resultingNetworks;
    assert.deepEqual(await seats(), [['Lab networking', 2, 2]]);
    // Combining parts bound to two subscriptions keeps the first one's binding.
    const cams = await ok(sb.post(`${A}/subscriptions/claim`, { claimKey: pool().subscriptions.find((x) => x.name === 'Lab cameras').claimKey, organizationId: org.id }));
    const cam = (await sb.post(`/organizations/${org.id}/networks`, { name: 'Cam', productTypes: ['camera'] })).body;
    await ok(sb.post(`${A}/subscriptions/${cams.subscriptionId}/bind`, { networkIds: [cam.id] }));
    const wl = parts.find((n) => n.productTypes[0] === 'wireless');
    const combined = (await ok(sb.post(`/organizations/${org.id}/networks/combine`, { name: 'Again', networkIds: [wl.id, cam.id] }))).resultingNetwork;
    const owners = sb.world.orgById.get(org.id).subscriptions.filter((x) => x.networkIds.includes(combined.id)).map((x) => x.name);
    assert.deepEqual(owners, ['Lab networking']);
    assert.deepEqual((await seats()).sort(), [['Lab cameras', 0, 0], ['Lab networking', 2, 2]]);
  });
});
