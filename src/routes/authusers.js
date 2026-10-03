// Meraki authentication users: 802.1X and splash guest users on wireless
// networks and client VPN users on networks with an MX, plus splash login
// attempts worked out from client sessions. Passwords are kept but never
// returned, and nothing is emailed.

import { FIRST_NAMES, LAST_NAMES } from '../catalog.js';
import { configOf } from '../config.js';
import { badRequest, boolParam, intParam, notFound, timeWindow } from '../http.js';
import { Rand, hashStr, unit } from '../rng.js';
import { START, eachSession } from '../sim/presence.js';
import { DAY, isoMicro, parseTime } from '../time.js';
import { netOf } from './common.js';
import { wirelessNet } from './wireless.js';

const USERS = '/networks/{networkId}/merakiAuthUsers';
const USER = `${USERS}/{merakiAuthUserId}`;
const MAX_USERS = 1000;
const TYPES = ['802.1X', 'Guest', 'Client VPN'];
const MERAKI_SPLASH = 'Password-protected with Meraki RADIUS';
// Splash pages that ask the client to sign on.
const SIGN_ON = new Set([MERAKI_SPLASH, 'Password-protected with custom RADIUS', 'Password-protected with Active Directory', 'Password-protected with LDAP', 'SMS authentication', 'Billing', 'Facebook Wi-Fi', 'Google OAuth', 'Google Apps domain', 'Microsoft Entra ID', 'Sponsored guest']);

// 802.1X and guest users go with the APs, client VPN users with the MX.
const storeKey = (type) => (type === 'Client VPN' ? 'applianceMerakiAuthUsers' : 'wirelessMerakiAuthUsers');
const storeOf = (net, type) => (net[storeKey(type)] ??= { list: [] });
const byCreated = (a, b) => a.createdAt - b.createdAt || (a.email < b.email ? -1 : 1);
const usersOf = (net) => [...(net.wirelessMerakiAuthUsers?.list ?? []), ...(net.applianceMerakiAuthUsers?.list ?? [])].sort(byCreated);

// The ID is the email address in base64, as the real API's are.
const userId = (email) => Buffer.from(email).toString('base64');

function find(ctx) {
  const net = netOf(ctx);
  const user = usersOf(net).find((u) => u.id === ctx.params.merakiAuthUserId);
  if (!user) throw notFound('Meraki auth user');
  return { net, user };
}

function checkType(net, type) {
  if (!TYPES.includes(type)) throw badRequest(`'accountType' must be one of ${TYPES.join(', ')}`);
  if (type === 'Client VPN' && !net.productTypes.includes('appliance')) throw badRequest('Client VPN users need a network with an MX');
  if (type !== 'Client VPN' && !net.productTypes.includes('wireless')) throw badRequest(`${type} users need a wireless network`);
}

function expiry(v, at, now) {
  if (v == null || v === 'Never') return null;
  const t = typeof v === 'string' ? parseTime(v) : NaN;
  if (Number.isNaN(t)) throw badRequest(`'${at}' must be 'Never' or an ISO 8601 timestamp`);
  if (t <= now) throw badRequest(`'${at}' must be in the future`);
  return t;
}

// Wireless users name SSIDs set up for their account type; client VPN users take one authorization.
function checkAuthorizations(net, type, list, now, by) {
  if (!list?.length) throw badRequest("'authorizations' must list at least one authorization");
  if (type === 'Client VPN' && list.length > 1) throw badRequest('Client VPN users take one authorization');
  const ssids = configOf(net).ssids;
  const seen = new Set();
  return list.map((a, i) => {
    const at = `authorizations[${i}]`;
    const expiresAt = expiry(a.expiresAt, `${at}.expiresAt`, now);
    const auth = { expiresAt, authorizedAt: now, by };
    if (type === 'Client VPN') {
      if (a.ssidNumber != null) throw badRequest(`'${at}.ssidNumber' only applies to 802.1X and guest users`);
      return auth;
    }
    const n = a.ssidNumber;
    if (n == null) throw badRequest(`'${at}.ssidNumber' is required for wireless networks`);
    if (!Number.isInteger(n) || n < 0 || n > 14) throw badRequest(`'${at}.ssidNumber' must be an SSID number from 0 to 14`);
    if (seen.has(n)) throw badRequest(`SSID ${n} is listed more than once`);
    seen.add(n);
    if (type === '802.1X' && ssids[n].authMode !== '8021x-meraki') throw badRequest(`SSID ${n} must use 802.1X with Meraki authentication ('8021x-meraki') to authorize 802.1X users`);
    if (type === 'Guest' && ssids[n].splashPage !== MERAKI_SPLASH) throw badRequest(`SSID ${n} must use the '${MERAKI_SPLASH}' splash page to authorize guest users`);
    return { ssidNumber: n, ...auth };
  });
}

function userJson(net, u) {
  const ssids = configOf(net).ssids;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: isoMicro(u.createdAt),
    accountType: u.accountType,
    isAdmin: u.isAdmin,
    authorizations: u.authorizations.map((a) => ({
      ...(a.ssidNumber != null ? { ssidNumber: a.ssidNumber } : {}),
      authorizedZone: a.ssidNumber != null ? ssids[a.ssidNumber].name : 'Client VPN',
      expiresAt: a.expiresAt == null ? 'Never' : isoMicro(a.expiresAt),
      authorizedByName: a.by.name,
      authorizedByEmail: a.by.email,
    })),
  };
}

const caller = (ctx) => ({ name: ctx.world.apiAdmin.name, email: ctx.world.apiAdmin.email });
const text = (v) => typeof v === 'string' && v.trim() !== '';
// One @, no spaces, and a dot inside the domain. No regex, so long input stays linear.
function isEmail(v) {
  const [local, domain, ...rest] = v.split('@');
  return !rest.length && !!local && domain?.length > 2 && !/\s/.test(v) && domain.indexOf('.') > 0 && !domain.endsWith('.');
}

function listUsers(ctx) {
  const net = netOf(ctx);
  return usersOf(net).map((u) => userJson(net, u));
}

function getUser(ctx) {
  const { net, user } = find(ctx);
  return userJson(net, user);
}

function createUser(ctx) {
  const net = netOf(ctx);
  const b = ctx.body;
  const type = b.accountType ?? '802.1X';
  checkType(net, type);
  if (!text(b.email) || !isEmail(b.email)) throw badRequest("'email' must be an email address");
  const all = usersOf(net);
  if (all.some((u) => u.email.toLowerCase() === b.email.toLowerCase())) throw badRequest(`A Meraki auth user with email '${b.email}' already exists in this network`);
  if (all.length >= MAX_USERS) throw badRequest(`Networks are limited to ${MAX_USERS} Meraki auth users in the emulator`);
  let name = b.name;
  if (b.isAdmin) {
    // A Dashboard administrator signs on with their own account.
    const admin = net.org.admins.find((a) => a.email.toLowerCase() === b.email.toLowerCase());
    if (!admin) throw badRequest(`'${b.email}' is not a Dashboard administrator of this organization`);
    name = admin.name;
  } else {
    if (!text(b.name)) throw badRequest("'name' is required for users who aren't Dashboard administrators");
    if (!text(b.password)) throw badRequest("'password' is required for users who aren't Dashboard administrators");
  }
  const authorizations = checkAuthorizations(net, type, b.authorizations, ctx.now, caller(ctx));
  const u = { id: userId(b.email), email: b.email, name, password: b.isAdmin ? null : b.password, accountType: type, isAdmin: !!b.isAdmin, emailPasswordToUser: !!b.emailPasswordToUser, createdAt: ctx.now, authorizations };
  storeOf(net, type).list.push(u);
  return userJson(net, u);
}

function updateUser(ctx) {
  const { net, user: u } = find(ctx);
  const b = ctx.body;
  if (u.isAdmin && (b.name != null || b.password != null)) throw badRequest("A Dashboard administrator's name and password can't be changed here");
  if (b.name != null && !text(b.name)) throw badRequest("'name' must not be empty");
  if (b.password != null && !text(b.password)) throw badRequest("'password' must not be empty");
  const authorizations = b.authorizations != null ? checkAuthorizations(net, u.accountType, b.authorizations, ctx.now, caller(ctx)) : null;
  if (b.name != null) u.name = b.name;
  if (b.password != null) u.password = b.password;
  if (b.emailPasswordToUser != null) u.emailPasswordToUser = b.emailPasswordToUser;
  if (authorizations) u.authorizations = authorizations;
  return userJson(net, u);
}

// Users are kept per network, so deauthorizing a guest or client VPN user
// removes them from this network whatever `delete` says.
function deleteUser(ctx) {
  const { net, user: u } = find(ctx);
  boolParam(ctx.query, 'delete');
  const list = storeOf(net, u.accountType).list;
  list.splice(list.indexOf(u), 1);
}

// ── Splash login attempts ──

// Who signs on from a client: a guest user authorized on the SSID when it uses
// Meraki RADIUS, else a person made up from the client's ID.
function signOn(ctx, net, c, splashPage, n) {
  if (splashPage === MERAKI_SPLASH) {
    const guests = (net.wirelessMerakiAuthUsers?.list ?? []).filter((u) => u.accountType === 'Guest' && u.authorizations.some((a) => a.ssidNumber === n)).sort(byCreated);
    if (guests.length) {
      const u = guests[c.key % guests.length];
      return { name: u.name, login: u.email };
    }
  }
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:splashLogin:${c.id}`));
  const first = r.pick(FIRST_NAMES);
  const last = r.pick(LAST_NAMES);
  const login = splashPage === 'SMS authentication' ? `+1555${r.digits(7)}` : `${first}.${last}@example.com`.toLowerCase();
  return { name: `${first} ${last}`, login };
}

// One attempt per connect on an enabled SSID whose splash page asks for a
// sign-on, at the instant the event log puts splash authentication. The seed
// has none, so the list starts empty.
function loginAttempts(ctx) {
  const net = wirelessNet(ctx);
  const q = ctx.query;
  const only = intParam(q, 'ssidNumber', null, { min: 0, max: 14 });
  const who = q.get('loginIdentifier')?.toLowerCase();
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 90 * DAY, defaultSpan: DAY, allowT1: false });
  const ssids = configOf(net).ssids;
  const rows = [];
  for (const c of net.clients) {
    if (c.wired || !c.ssid || (only != null && c.ssid.number !== only)) continue;
    const s = ssids[c.ssid.number];
    if (!s.enabled || !SIGN_ON.has(s.splashPage)) continue;
    const person = signOn(ctx, net, c, s.splashPage, c.ssid.number);
    if (who && person.login.toLowerCase() !== who) continue;
    eachSession(c, t0, t1, (start, end, flags) => {
      if (!(flags & START)) return;
      const at = start + 0.6 + unit(c.key, Math.floor(start) + 4);
      if (at < t0 || at > t1) return;
      const ok = unit(c.key, Math.floor(start) + 11) >= 0.06;
      rows.push({ at, row: { ...person, ssid: s.name, loginAt: isoMicro(at), gatewayDeviceMac: c.ap.mac, clientMac: c.mac, clientId: c.id, authorization: ok ? 'success' : 'failure' } });
    });
  }
  return rows.sort((a, b) => b.at - a.at).map((x) => x.row);
}

export default [
  { op: 'getNetworkMerakiAuthUsers', path: USERS, handler: listUsers },
  { op: 'createNetworkMerakiAuthUser', method: 'POST', path: USERS, handler: createUser },
  { op: 'getNetworkMerakiAuthUser', path: USER, handler: getUser, sample: { merakiAuthUserId: 'bm9ib2R5QGV4YW1wbGUuY29t', status: 404 } },
  { op: 'updateNetworkMerakiAuthUser', method: 'PUT', path: USER, handler: updateUser },
  { op: 'deleteNetworkMerakiAuthUser', method: 'DELETE', path: USER, handler: deleteUser },
  { op: 'getNetworkSplashLoginAttempts', path: '/networks/{networkId}/splashLoginAttempts', handler: loginAttempts },
];
