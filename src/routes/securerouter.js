// Organization views of Cisco Secure Routers (sim/router.js): DOM readings of
// the seated optics and packet counters per interface.

import { arrayParam, badRequest, paginateItems, timeWindow } from '../http.js';
import { DOM_SLOT, PACKET_TYPES, domSample, isSecureRouter, opticPorts, packetCounts, physicalPorts, portInterface } from '../sim/router.js';
import { buckets } from '../sim/usage.js';
import { DAY, isoMicro } from '../time.js';
import { orgOf, round } from './common.js';

const LAB = { org: 1 };
const INTERVALS = [300, 1200, 14400, 86400];
const UNITS = {
  power: { name: 'decibel milliwatts', symbol: 'dBm' },
  supplyVoltage: { name: 'volts', symbol: 'V' },
  laserBiasCurrent: { name: 'milliamps', symbol: 'mA' },
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Secure Routers in the organization, by serial, narrowed by networkIds and serials.
function routers(ctx) {
  const nets = arrayParam(ctx.query, 'networkIds');
  const serials = arrayParam(ctx.query, 'serials');
  return orgOf(ctx)
    .devices.filter((d) => isSecureRouter(d) && d.net && (!nets.length || nets.includes(d.net.id)) && (!serials.length || serials.includes(d.serial)))
    .sort((a, b) => cmp(a.serial, b.serial));
}

function stats(values, digits) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { minimum: round(v[0], digits), maximum: round(v.at(-1), digits), median: round(median, digits) };
}

// One reading per interval, newest first, from the samples in (start, end].
// An interval the router was down for has no samples and no reading.
function readings(mx, n, t0, t1, interval) {
  const out = [];
  for (const [s, e] of buckets(t0, t1, interval).reverse()) {
    const [a, b] = [Math.max(s, t0), Math.min(e, t1)];
    if (b <= a) continue;
    const samples = [];
    for (let t = (Math.floor(a / DOM_SLOT) + 1) * DOM_SLOT; t <= b; t += DOM_SLOT) {
      const x = domSample(mx, n, t);
      if (x) samples.push(x);
    }
    if (!samples.length) continue;
    const pick = (k) => samples.map((x) => x[k]);
    const celsius = stats(pick('celsius'), 1);
    out.push({
      startTs: isoMicro(a),
      endTs: isoMicro(b),
      sfpProductId: mx.info.optics[n],
      byMetric: {
        power: { transmit: stats(pick('transmit'), 2), receive: stats(pick('receive'), 2) },
        temperature: {
          fahrenheit: stats(pick('celsius').map((c) => (c * 9) / 5 + 32), 1),
          celsius,
        },
        supplyVoltage: { level: stats(pick('voltage'), 3) },
        laserBiasCurrent: { draw: stats(pick('bias'), 2) },
      },
    });
  }
  return out;
}

function transceiverReadings(ctx) {
  const q = ctx.query;
  const { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 30 * DAY, lookback: 30 * DAY });
  let interval = q.get('interval');
  if (interval == null || interval === '') {
    interval = t1 - t0 <= 4 * DAY ? 1200 : 14400;
  } else {
    interval = Number(interval);
    if (!INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of ${INTERVALS.join(', ')}`);
  }
  const portIds = arrayParam(q, 'portIds');
  const out = paginateItems(ctx, routers(ctx), (d) => d.serial, { def: 5, max: 10 }, (mx) => ({
    serial: mx.serial,
    ports: opticPorts(mx)
      .filter((n) => !portIds.length || portIds.includes(String(n)))
      .map((n) => {
        const { name, slot, subslot, number } = portInterface(mx, n);
        return { portId: String(n), interfaceName: name, indices: { slot, subslot, port: number }, readings: readings(mx, n, t0, t1, interval) };
      }),
    network: { id: mx.net.id, name: mx.net.name },
  }));
  out.meta.units = structuredClone(UNITS);
  return out;
}

function packetOverviews(ctx) {
  const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, lookback: 14 * DAY });
  const span = t1 - t0;
  return paginateItems(ctx, routers(ctx), (d) => d.serial, { def: 10, max: 50 }, (mx) => ({
    network: { id: mx.net.id },
    serial: mx.serial,
    interfaces: physicalPorts(mx).map((n) => {
      const counts = packetCounts(mx, n, t0, t1);
      return {
        ...portInterface(mx, n),
        byType: PACKET_TYPES.map((type) => {
          const { sent, recv } = counts[type];
          return { type, total: sent + recv, sent, recv, rates: { average: { total: round((sent + recv) / span, 2), sent: round(sent / span, 2), recv: round(recv / span, 2) } } };
        }),
      };
    }),
  }));
}

export default [
  {
    op: 'getOrganizationApplianceDevicesPortsTransceiversReadingsHistoryByDevice',
    path: '/organizations/{organizationId}/appliance/devices/ports/transceivers/readings/history/byDevice',
    sample: LAB,
    handler: transceiverReadings,
  },
  {
    op: 'getOrganizationApplianceInterfacesPacketsOverviewsByDevice',
    path: '/organizations/{organizationId}/appliance/interfaces/packets/overviews/byDevice',
    sample: LAB,
    handler: packetOverviews,
  },
];
