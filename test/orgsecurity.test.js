import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { start } from './helpers.js';

describe('login security, SAML and organization SNMP', () => {
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
  const FP = '00:11:22:33:44:55:66:77:88:99:00:11:22:33:44:55:66:77:88:99';

  test('login security starts with nothing enforced and keeps what is written', async () => {
    fresh();
    const L = `${O}/loginSecurity`;
    const s = await ok(sb.get(L));
    assert.equal(s.enforceStrongPasswords, true);
    assert.deepEqual([s.enforceTwoFactorAuth, s.enforceLoginIpRanges, s.loginIpRanges, s.apiAuthentication], [false, false, [], { ipRestrictionsForKeys: { enabled: false, ranges: [] } }]);
    const u = await ok(sb.put(L, { enforceIdleTimeout: true, idleTimeoutMinutes: 15, enforceStrongPasswords: false, enforceLoginIpRanges: true, loginIpRanges: ['10.0.0.0/8', '192.168.1.1-192.168.1.9', '8.8.8.8'], apiAuthentication: { ipRestrictionsForKeys: { enabled: true, ranges: ['1.2.3.0/24'] } } }));
    assert.deepEqual([u.enforceIdleTimeout, u.idleTimeoutMinutes, u.enforceStrongPasswords, u.loginIpRanges.length, u.apiAuthentication.ipRestrictionsForKeys], [true, 15, true, 3, { enabled: true, ranges: ['1.2.3.0/24'] }]);
    assert.deepEqual(await ok(sb.get(L)), u);
    // Restricting API keys is stored only: the emulator keeps answering.
    assert.equal((await sb.get(`${O}/networks`)).status, 200);
    assert.match(await errorOf(sb.put(L, { loginIpRanges: ['10.0.0.0/33'] })), /CIDR subnet/);
    assert.match(await errorOf(sb.put(L, { loginIpRanges: ['10.0.0.9-10.0.0.1'] })), /IP address range/);
    assert.match(await errorOf(sb.put(L, { loginIpRanges: [] })), /at least one range/);
    assert.match(await errorOf(sb.put(L, { apiAuthentication: { ipRestrictionsForKeys: { ranges: [] } } })), /at least one range/);
    assert.match(await errorOf(sb.put(L, { idleTimeoutMinutes: 0 })), /between 1 and/);
    assert.equal((await sb.put(L, { minimumPasswordLength: 20 })).status, 400);
    assert.deepEqual(await ok(sb.get(L)), u);
  });

  test('SAML IdPs are created, read, updated and deleted', async () => {
    fresh();
    const I = `${O}/saml/idps`;
    assert.deepEqual(await ok(sb.get(`${O}/saml`)), { enabled: false, spInitiated: { subdomain: null, idpId: null } });
    const idp = await ok(sb.post(I, { x509certSha1Fingerprint: FP, ssoLoginUrl: 'https://idp.example.com/sso' }), 201);
    assert.match(idp.idpId, /^\d{13}$/);
    assert.equal(idp.consumerUrl, `https://dashboard.meraki.com/saml/login/${org.slug}/${idp.idpId}`);
    assert.equal(idp.visionConsumerUrl, `${idp.consumerUrl}?appTarget=MerakiVision`);
    assert.equal(idp.sloLogoutUrl, '');
    const u = await ok(sb.put(`${I}/${idp.idpId}`, { sloLogoutUrl: 'https://idp.example.com/slo' }));
    assert.deepEqual([u.ssoLoginUrl, u.sloLogoutUrl], ['https://idp.example.com/sso', 'https://idp.example.com/slo']);
    assert.deepEqual(await ok(sb.get(I)), [u]);
    assert.deepEqual(await ok(sb.get(`${I}/${idp.idpId}`)), u);
    assert.match(await errorOf(sb.post(I, { x509certSha1Fingerprint: 'abc' })), /SHA1 fingerprint/);
    assert.match(await errorOf(sb.post(I, { x509certSha1Fingerprint: FP, ssoLoginUrl: 'ftp://x' })), /http or https/);
    assert.match(await errorOf(sb.post(I, {})), /'x509certSha1Fingerprint' is required/);

    // SP-initiated SSO names an IdP, which then can't be deleted.
    const s = await ok(sb.put(`${O}/saml`, { enabled: true, spInitiated: { subdomain: 'acme_sso', idpId: idp.idpId } }));
    assert.deepEqual(s, { enabled: true, spInitiated: { subdomain: 'acme_sso', idpId: idp.idpId } });
    assert.match(await errorOf(sb.del(`${I}/${idp.idpId}`)), /SP-initiated/);
    assert.match(await errorOf(sb.put(`${O}/saml`, { spInitiated: { idpId: '1' } })), /must name a SAML IdP/);
    assert.match(await errorOf(sb.put(`${O}/saml`, { spInitiated: { subdomain: 'bad sub' } })), /letters, digits/);
    const lab = sb.world.orgs.find((o) => o.name === 'Acme Test Lab');
    assert.match(await errorOf(sb.put(`/organizations/${lab.id}/saml`, { spInitiated: { subdomain: 'ACME_SSO' } })), /already in use/);

    const other = await ok(sb.post(I, { x509certSha1Fingerprint: FP.replaceAll(':', '') }), 201);
    await ok(sb.put(`${O}/saml`, { spInitiated: { idpId: other.idpId } }));
    assert.equal((await sb.del(`${I}/${idp.idpId}`)).status, 204);
    assert.equal((await sb.get(`${I}/${idp.idpId}`)).status, 404);
  });

  test('SAML roles take admin privileges and follow split networks', async () => {
    fresh();
    const R = `${O}/samlRoles`;
    const role = await ok(sb.post(R, { role: 'west', orgAccess: 'none', networks: [{ id: hq.id, access: 'ssid-admin' }], tags: [{ tag: 'west', access: 'read-only' }] }), 201);
    assert.match(role.id, /^\d{13}$/);
    assert.deepEqual(role, { id: role.id, role: 'west', orgAccess: 'none', networks: [{ id: hq.id, access: 'ssid-admin' }], tags: [{ tag: 'west', access: 'read-only' }], camera: [] });
    assert.deepEqual(await ok(sb.get(R)), [role]);
    assert.deepEqual(await ok(sb.get(`${R}/${role.id}`)), role);
    await ok(sb.post(R, { role: 'ops', orgAccess: 'custom-role:12:Ops', tags: [{ tag: 'a', access: 'custom-role:3' }] }), 201);
    assert.match(await errorOf(sb.post(R, { role: 'west', orgAccess: 'full' })), /already exists/);
    assert.match(await errorOf(sb.post(R, { role: 'x', orgAccess: 'boss' })), /'orgAccess' must be one of/);
    assert.match(await errorOf(sb.post(R, { role: 'x', orgAccess: 'none', tags: [{ tag: 'a', access: 'ssid-admin' }] })), /'tags\[0\]\.access'/);
    assert.match(await errorOf(sb.post(R, { role: 'x', orgAccess: 'none', networks: [{ id: 'N_1', access: 'full' }] })), /not in this organization/);
    assert.match(await errorOf(sb.post(R, { orgAccess: 'none' })), /'role' is required/);

    // A split sends the role's network to the appliance part.
    const parts = (await ok(sb.post(`/networks/${hq.id}/split`))).resultingNetworks;
    const main = parts.find((n) => n.productTypes.includes('appliance'));
    assert.deepEqual((await sb.get(`${R}/${role.id}`)).body.networks, [{ id: main.id, access: 'ssid-admin' }]);
    assert.equal((await sb.del(`/networks/${main.id}`)).status, 204);
    assert.deepEqual((await sb.get(`${R}/${role.id}`)).body.networks, []);

    const u = await ok(sb.put(`${R}/${role.id}`, { orgAccess: 'read-only', tags: [] }));
    assert.deepEqual([u.role, u.orgAccess, u.tags], ['west', 'read-only', []]);
    assert.equal((await sb.del(`${R}/${role.id}`)).status, 204);
    assert.equal((await sb.get(`${R}/${role.id}`)).status, 404);
  });

  test('organization SNMP keeps passphrases but never returns them', async () => {
    fresh();
    const S = `${O}/snmp`;
    assert.deepEqual(await ok(sb.get(S)), { v2cEnabled: false, v3Enabled: false, peerIps: [], hostname: 'snmp.meraki.com', port: 16100 });
    const v2 = await ok(sb.put(S, { v2cEnabled: true, peerIps: ['123.123.123.1'] }));
    assert.match(v2.v2CommunityString, /^o\/[A-Za-z0-9]{8}$/);
    assert.match(await errorOf(sb.put(S, { v3Enabled: true })), /'v3AuthPass' is required/);
    assert.match(await errorOf(sb.put(S, { v3Enabled: true, v3AuthPass: 'short', v3PrivPass: 'password2' })), /at least 8/);
    assert.match(await errorOf(sb.put(S, { peerIps: ['10.0.0.0/24'] })), /IPv4 address/);
    const v3 = await ok(sb.put(S, { v3Enabled: true, v3AuthMode: 'MD5', v3AuthPass: 'password1', v3PrivPass: 'password2' }));
    assert.deepEqual([v3.v3User, v3.v3AuthMode, v3.v3PrivMode, v3.v2CommunityString], [v2.v2CommunityString, 'MD5', 'AES128', v2.v2CommunityString]);
    assert.ok(!JSON.stringify(v3).includes('password'));
    // Passphrases stay, so v3 can be turned off and on again without them.
    await ok(sb.put(S, { v3Enabled: false, v2cEnabled: false }));
    const back = await ok(sb.put(S, { v3Enabled: true }));
    assert.deepEqual([back.v3Enabled, 'v2CommunityString' in back], [true, false]);
  });
});
