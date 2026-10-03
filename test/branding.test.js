import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('branding policies, early access and splash themes', () => {
  let sb;
  let org;
  let hq;
  let O;
  before(async () => (sb = await start()));
  afterEach(async () => {
    assert.equal((await sb.reset()).status, 204);
  });
  after(() => sb.close());
  const fresh = () => {
    org = sb.world.orgs.find((o) => o.name === 'Acme Corporation');
    hq = org.networks.find((n) => n.name === 'HQ - San Francisco');
    O = `/organizations/${org.id}`;
  };
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
  const PNG = 'iVBORw0KGgoAAAANSUhEUg==';

  test('branding policies keep their settings and drop gone networks and admins', async () => {
    fresh();
    const B = `${O}/brandingPolicies`;
    assert.deepEqual(await ok(sb.get(B)), []);
    const p = await ok(sb.post(B, { name: 'Partners', adminSettings: { appliesTo: 'All admins of networks...', values: [hq.id] }, helpSettings: { helpTab: 'show', supportContactInfo: '<h1>Call us</h1>' } }), 201);
    assert.match(p.brandingPolicyId, /^\d{6}$/);
    assert.equal(p.enabled, true);
    assert.deepEqual(p.adminSettings, { appliesTo: 'All admins of networks...', values: [hq.id] });
    assert.equal(p.helpSettings.helpTab, 'show');
    assert.equal(p.helpSettings.supportContactInfo, '<h1>Call us</h1>');
    assert.equal(p.helpSettings.casesSubtab, 'default or inherit');
    assert.deepEqual(p.customLogo, { enabled: false, image: null });
    assert.deepEqual(await ok(sb.get(`${B}/${p.brandingPolicyId}`)), p);

    const u = await ok(sb.put(`${B}/${p.brandingPolicyId}`, { name: 'Partners', enabled: false, customLogo: { enabled: true, image: { contents: PNG, format: 'png' } } }));
    assert.equal(u.enabled, false);
    assert.equal(u.helpSettings.helpTab, 'show');
    assert.equal(u.customLogo.enabled, true);
    assert.match(u.customLogo.image.preview.url, new RegExp(`/org-assets/${org.id}/[0-9a-f]{8}\\.png$`));
    assert.equal(u.customLogo.image.preview.expiresAt, '2026-09-29T19:30:00Z');

    // Changing who it applies to starts a new list.
    const admin = org.admins[0];
    const s = await ok(sb.put(`${B}/${p.brandingPolicyId}`, { name: 'Partners', adminSettings: { appliesTo: 'Specific admins...', values: [admin.id] } }));
    assert.deepEqual(s.adminSettings.values, [admin.id]);
    await ok(sb.del(`${O}/admins/${admin.id}`), 204);
    assert.deepEqual((await ok(sb.get(`${B}/${p.brandingPolicyId}`))).adminSettings.values, []);

    await ok(sb.del(`${B}/${p.brandingPolicyId}`), 204);
    await errorOf(sb.get(`${B}/${p.brandingPolicyId}`), 404);
  });

  test('branding policy bodies are checked before anything changes', async () => {
    fresh();
    const B = `${O}/brandingPolicies`;
    assert.match(await errorOf(sb.post(B, {})), /'name' is required/);
    assert.match(await errorOf(sb.post(B, { name: 'A', adminSettings: { appliesTo: 'All admins of networks tagged...' } })), /must list network tags/);
    assert.match(await errorOf(sb.post(B, { name: 'A', adminSettings: { appliesTo: 'All admins', values: ['x'] } })), /only applies when/);
    assert.match(await errorOf(sb.post(B, { name: 'A', adminSettings: { appliesTo: 'All admins of networks...', values: ['L_1'] } })), /not in this organization: L_1/);
    assert.match(await errorOf(sb.post(B, { name: 'A', adminSettings: { appliesTo: 'Specific admins...', values: ['1'] } })), /admin that is not/);
    assert.match(await errorOf(sb.post(B, { name: 'A', helpSettings: { helpTab: 'maybe' } })), /'helpSettings.helpTab' must be one of/);
    assert.match(await errorOf(sb.post(B, { name: 'A', helpSettings: { smForums: 'hide' } })), /Systems Manager/);
    assert.match(await errorOf(sb.post(B, { name: 'A', helpSettings: { supportContactInfo: ' ' } })), /custom HTML/);
    assert.match(await errorOf(sb.post(B, { name: 'A', customLogo: { enabled: true } })), /needs a logo/);
    assert.match(await errorOf(sb.post(B, { name: 'A', customLogo: { image: { contents: 'not base64', format: 'png' } } })), /base64/);
    assert.match(await errorOf(sb.post(B, { name: 'A', customLogo: { image: { contents: PNG } } })), /both 'contents' and 'format'/);
    const t = await ok(sb.post(B, { name: 'Tagged', adminSettings: { appliesTo: 'All admins of networks tagged...', values: ['west'] } }), 201);
    assert.match(await errorOf(sb.post(B, { name: 'Tagged' })), /already exists/);
    assert.deepEqual((await ok(sb.get(B))).map((x) => x.brandingPolicyId), [t.brandingPolicyId]);
  });

  test('priorities list every policy and reorder the list', async () => {
    fresh();
    const B = `${O}/brandingPolicies`;
    const ids = [];
    for (const name of ['One', 'Two', 'Three']) ids.push((await ok(sb.post(B, { name }), 201)).brandingPolicyId);
    assert.deepEqual(await ok(sb.get(`${B}/priorities`)), { brandingPolicyIds: ids });
    const order = [ids[2], ids[0], ids[1]];
    assert.deepEqual(await ok(sb.put(`${B}/priorities`, { brandingPolicyIds: order })), { brandingPolicyIds: order });
    assert.deepEqual((await ok(sb.get(B))).map((x) => x.name), ['Three', 'One', 'Two']);
    assert.match(await errorOf(sb.put(`${B}/priorities`, { brandingPolicyIds: [ids[0], ids[1]] })), /exactly once/);
    assert.match(await errorOf(sb.put(`${B}/priorities`, { brandingPolicyIds: [ids[0], ids[0], ids[1]] })), /exactly once/);
    assert.deepEqual(await ok(sb.put(`${B}/priorities`, {})), { brandingPolicyIds: order });
    await ok(sb.del(`${B}/${ids[0]}`), 204);
    assert.deepEqual((await ok(sb.get(`${B}/priorities`))).brandingPolicyIds, [ids[2], ids[1]]);
  });

  test('early access opt-ins name a feature and the networks they cover', async () => {
    fresh();
    const features = await ok(sb.get(`${O}/earlyAccess/features`));
    assert.ok(features.length >= 5);
    assert.ok(features.every((f) => f.shortName.startsWith('has_') && f.descriptions.short && typeof f.isOrgScopedOnly === 'boolean'));
    const scoped = features.find((f) => f.isOrgScopedOnly).shortName;
    const free = features.find((f) => !f.isOrgScopedOnly).shortName;
    const E = `${O}/earlyAccess/features/optIns`;
    const austin = org.networks.find((n) => n.name === 'Branch - Austin');
    const o = await ok(sb.post(E, { shortName: free, limitScopeToNetworks: [hq.id, austin.id] }));
    assert.deepEqual(o.limitScopeToNetworks, [{ id: hq.id, name: hq.name }, { id: austin.id, name: austin.name }]);
    assert.equal(o.createdAt, '2026-09-29T18:30:00Z');
    assert.equal(o.optOutEligibility.eligible, true);
    assert.deepEqual(await ok(sb.get(`${E}/${o.id}`)), o);
    assert.match(await errorOf(sb.post(E, { shortName: free })), /already opted in/);
    assert.match(await errorOf(sb.post(E, { shortName: 'has_nothing' })), /must name an early access feature/);
    assert.match(await errorOf(sb.post(E, { shortName: scoped, limitScopeToNetworks: [hq.id] })), /entire organization/);
    assert.match(await errorOf(sb.post(E, { shortName: scoped, limitScopeToNetworks: ['L_1'] })), /entire organization/);
    const whole = await ok(sb.post(E, { shortName: scoped }));
    assert.deepEqual(whole.limitScopeToNetworks, []);

    const u = await ok(sb.put(`${E}/${o.id}`, { limitScopeToNetworks: [austin.id] }));
    assert.deepEqual(u.limitScopeToNetworks.map((n) => n.id), [austin.id]);
    assert.equal(u.shortName, free);
    assert.match(await errorOf(sb.put(`${E}/${o.id}`, { limitScopeToNetworks: ['N_1'] })), /not in this organization/);
    assert.deepEqual((await ok(sb.get(E))).map((x) => x.id), [o.id, whole.id]);

    // A split points the opt-in at a part, and a deleted network drops out.
    const parts = (await ok(sb.post(`/networks/${austin.id}/split`))).resultingNetworks;
    const after = (await ok(sb.get(`${E}/${o.id}`))).limitScopeToNetworks.map((n) => n.id);
    assert.equal(after.length, 1);
    assert.ok(parts.some((p) => p.id === after[0]));
    await ok(sb.del(`/networks/${after[0]}`), 204);
    assert.deepEqual((await ok(sb.get(`${E}/${o.id}`))).limitScopeToNetworks, []);
    await ok(sb.del(`${E}/${o.id}`), 204);
    await errorOf(sb.get(`${E}/${o.id}`), 404);
  });

  test('splash themes copy a base theme and keep their assets', async () => {
    fresh();
    const T = `${O}/splash/themes`;
    const system = await ok(sb.get(T));
    assert.ok(system.length >= 3 && system.every((t) => t.isSystemTheme && /^[0-9a-f]{40}$/.test(t.id) && t.themeAssets.length));
    const base = system[0];
    const asset = await ok(sb.get(`${O}/splash/assets/${base.themeAssets[0].id}`));
    assert.equal(asset.name, base.themeAssets[0].name);
    assert.match(Buffer.from(asset.fileData, 'base64').toString(), /^<html>/);
    assert.ok(asset.fileData.endsWith('\n') && asset.fileData.split('\n').every((l) => l.length <= 60));

    const t = await ok(sb.post(T, { name: 'Lobby', baseTheme: base.id }), 201);
    assert.equal(t.isSystemTheme, false);
    assert.deepEqual(t.themeAssets.map((a) => a.name), base.themeAssets.map((a) => a.name));
    assert.ok(t.themeAssets.every((a) => !base.themeAssets.some((b) => b.id === a.id)));
    const empty = await ok(sb.post(T, { name: 'Blank' }), 201);
    assert.deepEqual(empty.themeAssets, []);
    assert.match(await errorOf(sb.post(T, { name: 'Lobby' })), /already exists/);
    assert.match(await errorOf(sb.post(T, { name: base.name })), /already exists/);
    assert.match(await errorOf(sb.post(T, { name: 'X', baseTheme: 'nope' })), /baseTheme/);
    assert.match(await errorOf(sb.post(T, {})), /'name' is required/);

    const A = `${T}/${t.id}/assets`;
    const logo = await ok(sb.post(A, { name: 'logo.png', content: PNG }), 201);
    assert.deepEqual(logo, { id: logo.id, name: 'logo.png', fileData: `${PNG}\n` });
    // The same name replaces the file and keeps its ID; the theme name works as well.
    const again = await ok(sb.post(`${T}/Lobby/assets`, { name: 'logo.png', content: 'AAAA' }), 201);
    assert.deepEqual(again, { id: logo.id, name: 'logo.png', fileData: 'AAAA\n' });
    assert.equal((await ok(sb.get(T))).find((x) => x.id === t.id).themeAssets.length, base.themeAssets.length + 1);
    assert.match(await errorOf(sb.post(A, { name: 'x.png', content: 'not base64' })), /base64/);
    assert.match(await errorOf(sb.post(A, { name: '../x', content: 'AAAA' })), /file name/);
    assert.match(await errorOf(sb.post(A, { content: 'AAAA' })), /'name' is required/);
    assert.match(await errorOf(sb.post(`${T}/${base.id}/assets`, { name: 'x', content: 'AAAA' })), /System splash themes/);
    await errorOf(sb.post(`${T}/nope/assets`, { name: 'x', content: 'AAAA' }), 404);

    await ok(sb.del(`${O}/splash/assets/${logo.id}`), 204);
    await errorOf(sb.get(`${O}/splash/assets/${logo.id}`), 404);
    assert.match(await errorOf(sb.del(`${O}/splash/assets/${base.themeAssets[0].id}`)), /system splash themes/);
    assert.match(await errorOf(sb.del(`${T}/${base.id}`)), /System splash themes cannot be deleted/);
    await ok(sb.del(`${T}/${empty.id}`), 204);
    await errorOf(sb.del(`${T}/${empty.id}`), 404);
  });

  test('SSID splash settings name a theme of the organization', async () => {
    fresh();
    const T = `${O}/splash/themes`;
    const t = await ok(sb.post(T, { name: 'Lobby' }), 201);
    const S = `/networks/${hq.id}/wireless/ssids/1/splash/settings`;
    assert.match(await errorOf(sb.put(S, { themeId: 'nope' })), /'themeId'/);
    assert.equal((await ok(sb.put(S, { themeId: t.id }))).themeId, t.id);
    assert.equal((await ok(sb.get(S))).themeId, t.id);
    assert.match(await errorOf(sb.del(`${T}/${t.id}`)), /used by the splash settings of 1 network/);

    // A network showing a custom theme can't move to another organization.
    const dest = await ok(sb.post('/organizations', { name: 'Acme West' }), 201);
    const move = await ok(sb.post(`${O}/networks/moves`, { network: { id: hq.id }, organizations: { target: { id: dest.id } } }), 201);
    assert.match(move.result.reason, /custom splash themes/);

    await ok(sb.put(S, { themeId: null }));
    await ok(sb.del(`${T}/${t.id}`), 204);
    const system = (await ok(sb.get(T)))[0];
    assert.equal((await ok(sb.put(S, { themeId: system.id }))).themeId, system.id);
  });
});
