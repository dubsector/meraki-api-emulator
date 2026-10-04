// Air Marshal: scan results from the neighbor sim, containment rules and the
// default policy for rogue SSIDs.

import { configOf, stored } from '../config.js';
import { badRequest, paginateItems, timeWindow } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { lastSighting, neighborsOf } from '../sim/neighbors.js';
import { DAY } from '../time.js';
import { isMac } from '../validate.js';
import { byId, collection } from './common.js';
import { wirelessNet, wirelessNets } from './wireless.js';

const RULE_TYPES = ['alert', 'allow', 'block'];
const MATCH_TYPES = ['bssid', 'contains', 'exact', 'wildcard'];

function airMarshalOf(net) {
  return stored(net, 'wirelessAirMarshal', () => ({ defaultPolicy: 'block', rules: { created: 0, list: [] } }));
}

// '2023-05-23 12:02:46.298', the format these rules carry.
const stamp = (t) => new Date(Math.round(t * 1000)).toISOString().replace('T', ' ').slice(0, 23);

function ruleJson(rule, net) {
  return { network: { id: net.id, name: net.name }, ruleId: rule.ruleId, type: rule.type, updatedAt: stamp(rule.updatedAt), createdAt: stamp(rule.createdAt), match: { ...rule.match } };
}

function checkRule(ctx, net, b, self) {
  if (b.type != null && !RULE_TYPES.includes(b.type)) throw badRequest(`'type' must be one of: ${RULE_TYPES.join(', ')}`);
  if (b.match === null && !self) throw badRequest("'match' is required");
  const match = { ...self?.match, ...(b.match ?? {}) };
  if (!MATCH_TYPES.includes(match.type)) throw badRequest(`'match.type' must be one of: ${MATCH_TYPES.join(', ')}`);
  if (typeof match.string !== 'string' || !match.string.trim()) throw badRequest("'match.string' must not be empty");
  if (match.type === 'bssid' && !isMac(match.string)) throw badRequest("'match.string' must be a BSSID like 00:11:22:33:44:55 when 'match.type' is 'bssid'");
  if (match.type === 'bssid') match.string = match.string.toLowerCase();
  const rules = airMarshalOf(net).rules.list;
  if (rules.some((r) => r !== self && r.match.type === match.type && r.match.string === match.string)) throw badRequest('A rule with this match already exists in this network');
  return { type: match.type, string: match.string };
}

// Short numeric IDs like the dashboard's, unique across the organization.
function nextRuleId(ctx, store, net) {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:airMarshalRule:${net.id}:${store.created}`));
  const taken = new Set(net.org.networks.filter((n) => n.productTypes.includes('wireless')).flatMap((n) => airMarshalOf(n).rules.list.map((x) => x.ruleId)));
  let id;
  do id = String(r.int(1000, 99999));
  while (taken.has(id));
  return id;
}

const rules = collection({
  ops: { create: 'createNetworkWirelessAirMarshalRule', update: 'updateNetworkWirelessAirMarshalRule', delete: 'deleteNetworkWirelessAirMarshalRule' },
  path: '/networks/{networkId}/wireless/airMarshal/rules',
  param: 'ruleId',
  key: 'ruleId',
  parent: wirelessNet,
  store: (net) => airMarshalOf(net).rules,
  what: 'Air Marshal rule',
  nextId: nextRuleId,
  max: 256,
  required: ['type', 'match'],
  unique: false,
  check: checkRule,
  blank: (ctx) => ({ createdAt: ctx.now }),
  apply: (rule, b, net, ctx, match) => {
    if (b.type != null) rule.type = b.type;
    rule.match = match;
    rule.updatedAt = ctx.now;
  },
  json: ruleJson,
});

// '*' matches any run of characters. Greedy with backtracking to the last
// star, so it stays linear without building a regex from user input.
function glob(pattern, s) {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === s[i]) {
      p++;
      i++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function matches(rule, ssid, bssid) {
  const { type, string } = rule.match;
  if (type === 'bssid') return bssid === string;
  if (type === 'exact') return ssid === string;
  if (type === 'contains') return ssid.includes(string);
  return glob(string, ssid);
}

// Allow rules mark an SSID as known: it isn't rogue and isn't contained. A
// block rule contains the BSSIDs it matches.
function scanResults(ctx) {
  const net = wirelessNet(ctx);
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 7 * DAY, lookback: 31 * DAY, allowT1: false });
  const list = airMarshalOf(net).rules.list;
  const enabled = new Set(configOf(net).ssids.filter((s) => s.enabled).map((s) => s.name));
  const rows = [];
  for (const n of neighborsOf(net)) {
    const last = lastSighting(n, t1);
    if (last == null || last < t0) continue;
    const allowed = (b) => list.some((r) => r.type === 'allow' && matches(r, n.ssid, b));
    const blocked = (b) => list.some((r) => r.type === 'block' && matches(r, n.ssid, b));
    const types = [];
    if (n.wired && !n.bssids.some((b) => allowed(b.bssid))) types.push('rogue');
    if (enabled.has(n.ssid)) types.push('spoof');
    rows.push({
      ssid: n.ssid,
      bssids: n.bssids.map((b) => ({
        bssid: b.bssid.toUpperCase(),
        contained: blocked(b.bssid) && !allowed(b.bssid),
        detectedBy: [...new Map(b.heard.map((h) => [net.aps[h.ap % net.aps.length].serial, h.rssi])).entries()].map(([device, rssi]) => ({ device, rssi })),
      })),
      channels: [...new Set(n.bssids.map((b) => b.channel))].sort((a, b) => a - b),
      firstSeen: n.firstSeen,
      lastSeen: last,
      wiredMacs: n.wired ? n.wired.macs.map((m) => m.toUpperCase()) : [],
      wiredVlans: n.wired ? n.wired.vlans : [],
      wiredLastSeen: n.wired ? last : null,
      manufacturers: [n.manufacturer],
      encryption: n.encryption,
      types,
    });
  }
  return rows.sort((a, b) => (a.ssid < b.ssid ? -1 : a.ssid > b.ssid ? 1 : 0));
}

const orgWirelessNets = (ctx) => wirelessNets(ctx).sort(byId);

export default [
  { op: 'getNetworkWirelessAirMarshal', path: '/networks/{networkId}/wireless/airMarshal', handler: scanResults },
  ...rules.routes,
  {
    op: 'updateNetworkWirelessAirMarshalSettings',
    method: 'PUT',
    path: '/networks/{networkId}/wireless/airMarshal/settings',
    handler: (ctx) => {
      const net = wirelessNet(ctx);
      const p = ctx.body.defaultPolicy;
      if (p !== 'allow' && p !== 'block') throw badRequest("'defaultPolicy' must be 'allow' or 'block'");
      airMarshalOf(net).defaultPolicy = p;
      return { networkId: net.id, defaultPolicy: p };
    },
  },
  {
    op: 'getOrganizationWirelessAirMarshalRules',
    path: '/organizations/{organizationId}/wireless/airMarshal/rules',
    handler: (ctx) => {
      const rows = orgWirelessNets(ctx).flatMap((net) => airMarshalOf(net).rules.list.map((rule) => ({ net, rule })));
      // The spec counts only the total, but the SDK reads `remaining` while paging.
      return paginateItems(ctx, rows, (x) => `${x.net.id}-${x.rule.ruleId}`, { def: 1000, max: 1000 }, (x) => ruleJson(x.rule, x.net));
    },
  },
  {
    op: 'getOrganizationWirelessAirMarshalSettingsByNetwork',
    path: '/organizations/{organizationId}/wireless/airMarshal/settings/byNetwork',
    handler: (ctx) => paginateItems(ctx, orgWirelessNets(ctx), (n) => n.id, { def: 1000, max: 1000 }, (net) => ({ networkId: net.id, defaultPolicy: airMarshalOf(net).defaultPolicy })),
  },
];
