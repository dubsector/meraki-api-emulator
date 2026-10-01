// Per-SSID settings beyond the SSID itself: Bonjour forwarding, device type
// policies, EAP timers, Hotspot 2.0, identity PSKs, OpenRoaming, outage
// schedules, traffic shaping and VPN. Each one is stored per network and SSID
// number, empty until written.

import { configOf, stored } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { isoMicro, parseTime } from '../time.js';
import { merge } from '../validate.js';
import { ssidOf, wirelessNet } from './wireless.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEK = 7 * 86400;
const MAX_SHAPING_RULES = 8;
const MAX_PSKS = 1000;

// The setting for one SSID, built from its default on first read.
function perSsid(net, key, number, build) {
  const all = stored(net, key, () => ({}));
  return (all[number] ??= build());
}

function setting(key, build) {
  return (ctx) => {
    const net = wirelessNet(ctx);
    return perSsid(net, key, ssidOf(net, ctx).number, build);
  };
}

function inRange(value, name, min, max) {
  if (value != null && !(value >= min && value <= max)) throw badRequest(`'${name}' must be between ${min} and ${max}`);
}

function requireGroupPolicy(net, id, at) {
  if (id == null || id === '') throw badRequest(`'${at}' is required when the policy is 'Group policy'`);
  if (!configOf(net).groupPolicies.some((g) => g.groupPolicyId === String(id))) throw badRequest(`Group policy '${id}' does not exist in this network`);
}

// ── Bonjour forwarding and device type policies ──

const bonjour = setting('ssidBonjour', () => ({ enabled: false, exception: { enabled: false }, rules: [] }));

function updateBonjour(ctx) {
  const set = bonjour(ctx);
  const { rules, ...patch } = ctx.body;
  if (rules) {
    set.rules = rules.map((r, i) => {
      if (!/^\d+$/.test(r.vlanId) || r.vlanId < 1 || r.vlanId > 4094) throw badRequest(`'rules[${i}].vlanId' must be a VLAN ID from 1 to 4094`);
      if (!r.services.length) throw badRequest(`'rules[${i}].services' needs at least one service`);
      return { description: r.description ?? '', vlanId: r.vlanId, services: r.services };
    });
  }
  return merge(set, patch);
}

const deviceTypePolicies = setting('ssidDeviceTypePolicies', () => ({ enabled: false, deviceTypePolicies: [] }));

// groupPolicyId is an integer here, unlike the rest of the API.
function updateDeviceTypePolicies(ctx) {
  const net = wirelessNet(ctx);
  const set = deviceTypePolicies(ctx);
  const { enabled, deviceTypePolicies: list } = ctx.body;
  if (list) {
    const seen = new Set();
    set.deviceTypePolicies = list.map((p, i) => {
      if (seen.has(p.deviceType)) throw badRequest(`'${p.deviceType}' has more than one policy`);
      seen.add(p.deviceType);
      if (p.devicePolicy !== 'Group policy') return { deviceType: p.deviceType, devicePolicy: p.devicePolicy };
      requireGroupPolicy(net, p.groupPolicyId, `deviceTypePolicies[${i}].groupPolicyId`);
      return { deviceType: p.deviceType, devicePolicy: p.devicePolicy, groupPolicyId: Number(p.groupPolicyId) };
    });
  }
  if (enabled != null) set.enabled = enabled;
  return set;
}

// ── EAP timers and Hotspot 2.0 ──

// Defaults and limits from Cisco's Nexus-as-Code data model.
const eapOverride = setting('ssidEapOverride', () => ({ timeout: 5, maxRetries: 5, identity: { retries: 5, timeout: 5 }, eapolKey: { retries: 4, timeoutInMs: 5000 } }));

function updateEapOverride(ctx) {
  const set = eapOverride(ctx);
  const next = merge(structuredClone(set), ctx.body);
  inRange(next.timeout, 'timeout', 1, 600);
  inRange(next.maxRetries, 'maxRetries', 1, 5);
  inRange(next.identity.retries, 'identity.retries', 1, 5);
  inRange(next.identity.timeout, 'identity.timeout', 1, 600);
  inRange(next.eapolKey.retries, 'eapolKey.retries', 1, 5);
  inRange(next.eapolKey.timeoutInMs, 'eapolKey.timeoutInMs', 1, 5000);
  return Object.assign(set, next);
}

const hotspot20 = setting('ssidHotspot20', () => ({
  enabled: false,
  operator: { name: '' },
  venue: { name: '', type: 'Unspecified' },
  networkAccessType: 'Private network',
  domains: [],
  roamConsortOis: [],
  mccMncs: [],
  naiRealms: [],
}));

const AUTH_TYPES = ['nonEapInnerAuthentication', 'eapInnerAuthentication', 'credentials', 'tunneledEapMethodCredentials'];

// Realms are written as `realm` and read back as `name`. A realm sent back
// from a GET has no `realm`, so it keeps the name it had.
function updateHotspot20(ctx) {
  const set = hotspot20(ctx);
  const { naiRealms, mccMncs, ...patch } = ctx.body;
  if (mccMncs) {
    set.mccMncs = mccMncs.map((p, i) => {
      if (!/^\d{3}$/.test(p.mcc ?? '')) throw badRequest(`'mccMncs[${i}].mcc' must be 3 digits`);
      if (!/^\d{2,3}$/.test(p.mnc ?? '')) throw badRequest(`'mccMncs[${i}].mnc' must be 2 or 3 digits`);
      return { mcc: p.mcc, mnc: p.mnc };
    });
  }
  if (naiRealms) {
    set.naiRealms = naiRealms.map((r, i) => ({
      format: r.format ?? '1',
      name: r.realm ?? set.naiRealms[i]?.name ?? '',
      methods: (r.methods ?? []).map((m, j) => ({ id: m.id ?? String(j + 1), authenticationTypes: Object.fromEntries(AUTH_TYPES.map((k) => [k, m.authenticationTypes?.[k] ?? []])) })),
    }));
  }
  return merge(set, patch);
}

// ── Identity PSKs ──

// Only SSIDs whose keys live in Dashboard take identity PSKs; the RADIUS modes get them from the server.
function pskStore(ctx, write) {
  const net = wirelessNet(ctx);
  const { number, config } = ssidOf(net, ctx);
  if (write && config.authMode !== 'ipsk-without-radius') throw badRequest("Identity PSKs need the SSID's authMode to be 'ipsk-without-radius'");
  const store = stored(net, 'identityPsks', () => ({ created: 0, bySsid: {} }));
  return { net, store, list: (store.bySsid[number] ??= []) };
}

function pskOf(list, id) {
  const psk = list.find((p) => p.id === id);
  if (!psk) throw notFound('Identity PSK');
  return psk;
}

function expiry(v) {
  if (v == null || v === '') return null;
  const t = parseTime(v);
  if (!Number.isFinite(t)) throw badRequest("'expiresAt' must be an ISO 8601 timestamp");
  return isoMicro(t);
}

function checkPsk(net, list, psk) {
  if (list.some((p) => p !== psk.self && p.name === psk.name)) throw badRequest('Name has already been taken');
  if (psk.passphrase.length < 8 || psk.passphrase.length > 63) throw badRequest("'passphrase' must be 8 to 63 characters");
  if (list.some((p) => p !== psk.self && p.passphrase === psk.passphrase)) throw badRequest('Passphrase has already been taken');
  if (!configOf(net).groupPolicies.some((g) => g.groupPolicyId === psk.groupPolicyId)) throw badRequest(`Group policy '${psk.groupPolicyId}' does not exist in this network`);
}

function createPsk(ctx) {
  const { net, store, list } = pskStore(ctx, true);
  const b = ctx.body;
  if (list.length >= MAX_PSKS) throw badRequest(`SSIDs are limited to ${MAX_PSKS} identity PSKs in the emulator`);
  // Seeded from a count that never goes down, so the same calls give the same IDs.
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:identityPsk:${net.id}:${store.created}`));
  let id;
  do id = r.digits(13);
  while (Object.values(store.bySsid).some((l) => l.some((p) => p.id === id)));
  const psk = {
    name: b.name,
    id,
    groupPolicyId: String(b.groupPolicyId),
    passphrase: b.passphrase || r.chars(12, 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'),
    wifiPersonalNetworkId: null,
    email: null,
    expiresAt: expiry(b.expiresAt),
  };
  checkPsk(net, list, psk);
  list.push(psk);
  return psk;
}

function updatePsk(ctx) {
  const { net, list } = pskStore(ctx, true);
  const psk = pskOf(list, ctx.params.identityPskId);
  const { name, passphrase, groupPolicyId, expiresAt } = ctx.body;
  const next = { ...psk, name: name ?? psk.name, passphrase: passphrase ?? psk.passphrase, groupPolicyId: groupPolicyId == null ? psk.groupPolicyId : String(groupPolicyId) };
  if (expiresAt !== undefined) next.expiresAt = expiry(expiresAt);
  checkPsk(net, list, { ...next, self: psk });
  return Object.assign(psk, next);
}

// ── OpenRoaming and outage schedules ──

function updateOpenRoaming(ctx) {
  const net = wirelessNet(ctx);
  const set = perSsid(net, 'ssidOpenRoaming', ssidOf(net, ctx).number, () => ({ enabled: false, tenantId: null }));
  const next = { ...set, ...ctx.body };
  if (next.enabled && !next.tenantId) throw badRequest("'tenantId' is required to turn on OpenRoaming");
  return Object.assign(set, next);
}

const schedules = setting('ssidSchedules', () => ({ enabled: false, ranges: [], rangesInSeconds: [] }));

function dayOf(name, at) {
  const lower = String(name).toLowerCase();
  const i = DAYS.findIndex((d) => d.toLowerCase() === lower || d.slice(0, 3).toLowerCase() === lower);
  if (i < 0) throw badRequest(`'${at}' must be a day of the week`);
  return i;
}

function minuteOf(time, at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  const h = Number(m?.[1]);
  if (!m || h > 24 || Number(m[2]) > 59 || (h === 24 && m[2] !== '00')) throw badRequest(`'${at}' must be a 24 hour time like 13:30`);
  return h * 60 + Number(m[2]);
}

// Seconds since Sunday midnight to a day and time. An end on midnight is 24:00 of the day before.
function dayTime(s, end) {
  const back = end && s > 0 && s % 86400 === 0;
  const t = s % WEEK;
  const day = back ? (s / 86400 - 1) % 7 : Math.floor(t / 86400);
  const minutes = back ? 1440 : Math.floor((t % 86400) / 60);
  return [DAYS[day], `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`];
}

// Either list can be sent; ranges win when both are, and the other list follows.
function updateSchedules(ctx) {
  const set = schedules(ctx);
  const { enabled, ranges, rangesInSeconds } = ctx.body;
  let seconds;
  if (ranges) {
    seconds = ranges.map((r, i) => ({
      start: dayOf(r.startDay, `ranges[${i}].startDay`) * 86400 + minuteOf(r.startTime, `ranges[${i}].startTime`) * 60,
      end: dayOf(r.endDay, `ranges[${i}].endDay`) * 86400 + minuteOf(r.endTime, `ranges[${i}].endTime`) * 60,
    }));
  } else if (rangesInSeconds) {
    seconds = rangesInSeconds.map((r, i) => {
      inRange(r.start, `rangesInSeconds[${i}].start`, 0, WEEK);
      inRange(r.end, `rangesInSeconds[${i}].end`, 0, WEEK);
      return { start: r.start, end: r.end };
    });
  }
  if (seconds) {
    set.rangesInSeconds = seconds;
    set.ranges = seconds.map(({ start, end }) => {
      const [startDay, startTime] = dayTime(start, false);
      const [endDay, endTime] = dayTime(end, true);
      return { startDay, startTime, endDay, endTime };
    });
  }
  if (enabled != null) set.enabled = enabled;
  return set;
}

// ── Traffic shaping and VPN ──

const shaping = setting('ssidTrafficShaping', () => ({ trafficShapingEnabled: false, defaultRulesEnabled: true, rules: [] }));

function shapingRule(r, i) {
  if (!r.definitions.length) throw badRequest(`'rules[${i}].definitions' needs at least one definition`);
  r.definitions.forEach((d, j) => {
    if (d.type === 'port' && !(/^\d+$/.test(d.value) && d.value >= 1 && d.value <= 65535)) throw badRequest(`'rules[${i}].definitions[${j}].value' must be a port from 1 to 65535`);
  });
  const limits = r.perClientBandwidthLimits ?? {};
  const settings = limits.settings ?? 'network default';
  if (!['network default', 'ignore', 'custom'].includes(settings)) throw badRequest(`'rules[${i}].perClientBandwidthLimits.settings' must be one of: network default, ignore, custom`);
  inRange(r.dscpTagValue, `rules[${i}].dscpTagValue`, 0, 63);
  inRange(r.pcpTagValue, `rules[${i}].pcpTagValue`, 0, 7);
  return {
    definitions: r.definitions.map((d) => ({ type: d.type, value: d.value })),
    perClientBandwidthLimits: settings === 'custom' ? { settings, bandwidthLimits: { limitUp: limits.bandwidthLimits?.limitUp ?? null, limitDown: limits.bandwidthLimits?.limitDown ?? null } } : { settings },
    dscpTagValue: r.dscpTagValue ?? null,
    pcpTagValue: r.pcpTagValue ?? null,
  };
}

// The four default rules count against the limit of eight.
function updateShaping(ctx) {
  const set = shaping(ctx);
  const { rules, ...patch } = ctx.body;
  const next = { ...set, ...patch, rules: rules ? rules.map(shapingRule) : set.rules };
  if (next.rules.length + (next.defaultRulesEnabled ? 4 : 0) > MAX_SHAPING_RULES) throw badRequest(`An SSID can have at most ${MAX_SHAPING_RULES} traffic shaping rules, and the default rules count as 4`);
  return Object.assign(set, next);
}

function vpnStore(net, number) {
  return perSsid(net, 'ssidVpn', number, () => ({
    concentrator: { networkId: null, vlanId: null },
    failover: { requestIp: null, heartbeatInterval: 10, idleTimeout: 30 },
    splitTunnel: { enabled: false, rules: [] },
  }));
}

// The concentrator's name comes from its network, so a rename shows here too.
function vpnJson(world, set) {
  const { networkId, vlanId } = set.concentrator;
  return { concentrator: { networkId, vlanId, name: world.networkById.get(networkId)?.name ?? null }, failover: { ...set.failover }, splitTunnel: structuredClone(set.splitTunnel) };
}

function updateVpn(ctx) {
  const net = wirelessNet(ctx);
  const set = vpnStore(net, ssidOf(net, ctx).number);
  const { concentrator, failover, splitTunnel } = ctx.body;
  const next = structuredClone(set);
  if (concentrator) {
    merge(next.concentrator, concentrator);
    const target = ctx.world.networkById.get(next.concentrator.networkId);
    if (next.concentrator.networkId != null && (target?.org !== net.org || !target.productTypes.includes('appliance'))) throw badRequest("'concentrator.networkId' must be a network in this organization with a security appliance");
    inRange(next.concentrator.vlanId, 'concentrator.vlanId', 1, 4094);
  }
  if (failover) {
    merge(next.failover, failover);
    inRange(next.failover.heartbeatInterval, 'failover.heartbeatInterval', 1, 3600);
    inRange(next.failover.idleTimeout, 'failover.idleTimeout', 1, 3600);
  }
  if (splitTunnel) {
    if (splitTunnel.enabled != null) next.splitTunnel.enabled = splitTunnel.enabled;
    if (splitTunnel.rules) {
      next.splitTunnel.rules = splitTunnel.rules.map((r, i) => {
        const policy = String(r.policy).toLowerCase();
        if (policy !== 'allow' && policy !== 'deny') throw badRequest(`'splitTunnel.rules[${i}].policy' must be allow or deny`);
        return { protocol: r.protocol ?? 'Any', destCidr: r.destCidr, destPort: r.destPort ?? 'any', policy, comment: r.comment ?? '' };
      });
    }
  }
  Object.assign(set, next);
  return vpnJson(ctx.world, set);
}

const path = (rest) => `/networks/{networkId}/wireless/ssids/{number}/${rest}`;

export default [
  { op: 'getNetworkWirelessSsidBonjourForwarding', path: path('bonjourForwarding'), sample: { number: '0' }, handler: bonjour },
  { op: 'updateNetworkWirelessSsidBonjourForwarding', method: 'PUT', path: path('bonjourForwarding'), handler: updateBonjour },
  { op: 'getNetworkWirelessSsidDeviceTypeGroupPolicies', path: path('deviceTypeGroupPolicies'), sample: { number: '0' }, handler: deviceTypePolicies },
  { op: 'updateNetworkWirelessSsidDeviceTypeGroupPolicies', method: 'PUT', path: path('deviceTypeGroupPolicies'), handler: updateDeviceTypePolicies },
  { op: 'getNetworkWirelessSsidEapOverride', path: path('eapOverride'), sample: { number: '0' }, handler: eapOverride },
  { op: 'updateNetworkWirelessSsidEapOverride', method: 'PUT', path: path('eapOverride'), handler: updateEapOverride },
  { op: 'getNetworkWirelessSsidHotspot20', path: path('hotspot20'), sample: { number: '0' }, handler: hotspot20 },
  { op: 'updateNetworkWirelessSsidHotspot20', method: 'PUT', path: path('hotspot20'), handler: updateHotspot20 },
  { op: 'getNetworkWirelessSsidIdentityPsks', path: path('identityPsks'), sample: { number: '2' }, handler: (ctx) => pskStore(ctx, false).list },
  { op: 'createNetworkWirelessSsidIdentityPsk', method: 'POST', path: path('identityPsks'), handler: createPsk },
  {
    op: 'getNetworkWirelessSsidIdentityPsk',
    path: path('identityPsks/{identityPskId}'),
    sample: { number: '2', identityPskId: '1284392014819', status: 404 },
    handler: (ctx) => pskOf(pskStore(ctx, false).list, ctx.params.identityPskId),
  },
  { op: 'updateNetworkWirelessSsidIdentityPsk', method: 'PUT', path: path('identityPsks/{identityPskId}'), handler: updatePsk },
  {
    op: 'deleteNetworkWirelessSsidIdentityPsk',
    method: 'DELETE',
    path: path('identityPsks/{identityPskId}'),
    handler: (ctx) => {
      const { list } = pskStore(ctx, false);
      list.splice(list.indexOf(pskOf(list, ctx.params.identityPskId)), 1);
    },
  },
  { op: 'updateNetworkWirelessSsidOpenRoaming', method: 'PUT', path: path('openRoaming'), handler: updateOpenRoaming },
  { op: 'getNetworkWirelessSsidSchedules', path: path('schedules'), sample: { number: '0' }, handler: schedules },
  { op: 'updateNetworkWirelessSsidSchedules', method: 'PUT', path: path('schedules'), handler: updateSchedules },
  { op: 'getNetworkWirelessSsidTrafficShapingRules', path: path('trafficShaping/rules'), sample: { number: '1' }, handler: shaping },
  { op: 'updateNetworkWirelessSsidTrafficShapingRules', method: 'PUT', path: path('trafficShaping/rules'), handler: updateShaping },
  {
    op: 'getNetworkWirelessSsidVpn',
    path: path('vpn'),
    sample: { number: '0' },
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      return vpnJson(ctx.world, vpnStore(net, ssidOf(net, ctx).number));
    },
  },
  { op: 'updateNetworkWirelessSsidVpn', method: 'PUT', path: path('vpn'), handler: updateVpn },
];
