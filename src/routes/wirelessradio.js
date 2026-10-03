// AP radio overrides, RF profile assignments and AutoRF (RRM) settings.

import { stored } from '../config.js';
import { badRequest, paginateItems } from '../http.js';
import { RADIO, SETTINGS } from '../sim/rf.js';
import { iso, MIN } from '../time.js';
import { byId, bySerial, devOf, filterDevices, orgOf, requireModel } from './common.js';
import { FIVE_GHZ, SIX_GHZ, apProfile, orgAps, profileOf, wirelessNet, wirelessNets } from './wireless.js';
import { wirelessNetIn } from './wirelesslocation.js';

const BAND_OF = Object.fromEntries(Object.entries(RADIO).map(([band, index]) => [index, band]));
const CHANNELS = { 2.4: Array.from({ length: 14 }, (_, i) => i + 1), 5: FIVE_GHZ, 6: SIX_GHZ };
const WIDTHS = { 2.4: [20], 5: [20, 40, 80, 160], 6: [20, 40, 80, 160] };
const OVERRIDES = ['channel', 'channelWidth', 'targetPower'];

// Only values set by hand show; null means the RF profile picks.
function overridesJson(ap) {
  return {
    serial: ap.serial,
    network: { id: ap.net.id },
    rfProfile: { id: apProfile(ap).id },
    radios: ap.info.bands.map((band) => {
      const s = ap.radio?.[SETTINGS[band]] ?? {};
      const enabled = s.enabled !== false;
      return { enabled, index: RADIO[band], band, channel: s.channel ?? null, channelWidth: s.channelWidth ?? null, targetPower: enabled ? (s.targetPower ?? null) : -1 };
    }),
  };
}

function checkRadio(ap, r) {
  const band = BAND_OF[r.index];
  if (!band || !ap.info.bands.includes(band)) throw badRequest(`'radios.index' must be one of: ${ap.info.bands.map((b) => RADIO[b]).join(', ')}`);
  if (r.channel != null && !CHANNELS[band].includes(r.channel)) throw badRequest(`'radios.channel' must be a ${band} GHz channel: ${CHANNELS[band].join(', ')}`);
  if (r.channelWidth != null && !WIDTHS[band].includes(r.channelWidth)) throw badRequest(`'radios.channelWidth' must be one of ${WIDTHS[band].join(', ')} on ${band} GHz`);
  if (r.targetPower != null && !(Number.isInteger(r.targetPower) && r.targetPower >= 2 && r.targetPower <= 30)) throw badRequest("'radios.targetPower' must be an integer from 2 to 30 dBm");
  return band;
}

// Assigning a profile (null picks the basic one) clears every override first;
// listed radios are then updated and the rest kept.
function updateOverrides(ctx) {
  const ap = devOf(ctx);
  requireModel(ap, 'wireless');
  const b = ctx.body;
  const assign = b.rfProfile != null && 'id' in b.rfProfile;
  if (assign && b.rfProfile.id != null) profileOf(ap.net, b.rfProfile.id);
  const radios = (b.radios ?? []).map((r) => [checkRadio(ap, r), r]);
  if (new Set(radios.map(([band]) => band)).size < radios.length) throw badRequest("'radios' lists a radio more than once");
  ap.radio ??= {};
  if (assign) {
    if (b.rfProfile.id == null) delete ap.radio.rfProfileId;
    else ap.radio.rfProfileId = b.rfProfile.id;
    for (const key of Object.values(SETTINGS)) for (const k of OVERRIDES) if (ap.radio[key]) delete ap.radio[key][k];
  }
  for (const [band, r] of radios) {
    const s = (ap.radio[SETTINGS[band]] ??= {});
    for (const k of ['enabled', ...OVERRIDES]) if (k in r) s[k] = r[k];
  }
  return overridesJson(ap);
}

function profileJson(p) {
  return { id: p.id, name: p.name, isIndoorDefault: p.isIndoorDefault, isOutdoorDefault: p.isOutdoorDefault };
}

// ── AutoRF ──

function rrmOf(net) {
  return stored(net, 'wirelessRrm', () => ({
    busyHour: { schedule: { mode: 'manual', automatic: { start: '08:00', end: '17:00' }, manual: { start: '10:00', end: '15:00' } }, minimizeChanges: { enabled: false } },
    channel: { avoidance: { enabled: true } },
    fra: { enabled: false },
    ai: { enabled: false, lastEnabledAt: null },
  }));
}

function rrmJson(net) {
  return { networkId: net.id, name: net.name, timeZone: net.timeZone, ...structuredClone(rrmOf(net)) };
}

const HOUR_RE = /^([01]\d|2[0-3]):00$/;

function updateRrm(ctx) {
  const net = wirelessNet(ctx);
  const rrm = rrmOf(net);
  const b = ctx.body;
  const schedule = b.busyHour?.schedule;
  const manual = { ...rrm.busyHour.schedule.manual };
  for (const k of ['start', 'end']) {
    const v = schedule?.manual?.[k];
    if (v == null) continue;
    if (typeof v !== 'string' || !HOUR_RE.test(v)) throw badRequest(`'busyHour.schedule.manual.${k}' must be a whole hour like '10:00'`);
    manual[k] = v;
  }
  if (manual.start === manual.end) throw badRequest('Manual Busy Hour must start and end at different hours');
  const ai = b.ai?.enabled ?? rrm.ai.enabled;
  if (b.fra?.enabled && !ai) throw badRequest('FRA can only be enabled when AI-RRM is enabled');
  // Turning AI-RRM off turns FRA off with it.
  const fra = ai && (b.fra?.enabled ?? rrm.fra.enabled);
  if (schedule?.mode != null) rrm.busyHour.schedule.mode = schedule.mode;
  rrm.busyHour.schedule.manual = manual;
  if (b.busyHour?.minimizeChanges?.enabled != null) rrm.busyHour.minimizeChanges.enabled = b.busyHour.minimizeChanges.enabled;
  if (b.channel?.avoidance?.enabled != null) rrm.channel.avoidance.enabled = b.channel.avoidance.enabled;
  if (ai && !rrm.ai.enabled) rrm.ai.lastEnabledAt = iso(ctx.now);
  rrm.ai.enabled = ai;
  rrm.fra.enabled = fra;
  return rrmJson(net);
}

function recalculate(ctx) {
  const org = orgOf(ctx);
  const ids = ctx.body.networkIds;
  if (!Array.isArray(ids) || !ids.length) throw badRequest("'networkIds' must list at least one network");
  if (ids.length > 15) throw badRequest("'networkIds' is limited to 15 networks");
  for (const id of ids) wirelessNetIn(org, id);
  // Channels come from the radio sim, so nothing moves; the job just reports when it would end.
  return { estimatedCompletedAt: iso(ctx.now + 5 * MIN) };
}

export default [
  {
    op: 'getDeviceWirelessRadioOverrides',
    path: '/devices/{serial}/wireless/radio/overrides',
    handler: (ctx) => {
      const ap = devOf(ctx);
      requireModel(ap, 'wireless');
      return overridesJson(ap);
    },
  },
  { op: 'updateDeviceWirelessRadioOverrides', method: 'PUT', path: '/devices/{serial}/wireless/radio/overrides', handler: updateOverrides },
  {
    op: 'getOrganizationWirelessRadioOverridesByDevice',
    path: '/organizations/{organizationId}/wireless/radio/overrides/byDevice',
    handler: (ctx) => paginateItems(ctx, orgAps(ctx), (ap) => ap.serial, { def: 100, max: 100 }, overridesJson),
  },
  {
    op: 'getOrganizationWirelessRfProfilesAssignmentsByDevice',
    path: '/organizations/{organizationId}/wireless/rfProfiles/assignments/byDevice',
    handler: (ctx) => {
      const aps = filterDevices(ctx.query, orgOf(ctx).devices.filter((d) => d.productType === 'wireless')).sort(bySerial);
      const page = paginateItems(ctx, aps, (ap) => ap.serial, { def: 1000, max: 1000 }, (ap) => ({ network: { id: ap.net.id }, name: ap.name, serial: ap.serial, model: ap.model, rfProfile: profileJson(apProfile(ap)) }));
      // The spec wraps the page in a one-item array.
      return [page];
    },
  },
  { op: 'updateNetworkWirelessRadioRrm', method: 'PUT', path: '/networks/{networkId}/wireless/radio/rrm', handler: updateRrm },
  {
    op: 'getOrganizationWirelessRadioRrmByNetwork',
    path: '/organizations/{organizationId}/wireless/radio/rrm/byNetwork',
    handler: (ctx) => {
      const order = ctx.query.get('sortOrder') || 'ascending';
      if (order !== 'ascending' && order !== 'descending') throw badRequest("'sortOrder' must be 'ascending' or 'descending'");
      const nets = wirelessNets(ctx).sort(byId);
      if (order === 'descending') nets.reverse();
      return paginateItems(ctx, nets, (n) => n.id, { def: 1000, max: 1000 }, rrmJson);
    },
  },
  { op: 'recalculateOrganizationWirelessRadioAutoRfChannels', method: 'POST', path: '/organizations/{organizationId}/wireless/radio/autoRf/channels/recalculate', status: 200, handler: recalculate },
];
