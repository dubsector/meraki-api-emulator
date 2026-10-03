// Assurance alerts, raised from the same outages, uplink failures and port
// errors the status endpoints report. A device has to be gone for five
// minutes before it counts as unreachable.

import { derive } from '../rng.js';
import { DAY } from '../time.js';
import { eachOutage, eachUplinkFailure, isDown } from './outages.js';

export const LOOKBACK = 31 * DAY;
const GRACE = 300;
export const DEVICE_TYPE = { appliance: 'MX', switch: 'MS', wireless: 'MR', camera: 'MV', sensor: 'MT' };

// The alert types the sim raises, as the taxonomy endpoint lists them.
// Unreachable's device types are the spec's example.
export const ALERT_TYPES = {
  unreachable: { title: 'Unreachable device', categoryType: 'connectivity', severities: ['critical'], deviceTypes: ['Campus Gateway', 'Catalyst AP', 'Catalyst Controller', 'Catalyst Switch', 'MG', 'MR', 'MS', 'MT', 'MV', 'MX', 'VMX', 'Z'] },
  crc_errors: { title: 'CRC errors detected', categoryType: 'connectivity', severities: ['warning'], deviceTypes: ['MS'] },
  wan_status: { title: 'WAN uplink down', categoryType: 'connectivity', severities: ['warning', 'critical'], deviceTypes: ['MX'] },
};

export const ALERT_CATEGORIES = [
  { type: 'configuration', title: 'Configuration' },
  { type: 'connectivity', title: 'Connectivity' },
  { type: 'device_health', title: 'Device health' },
  { type: 'experience_metrics', title: 'Experience metrics' },
  { type: 'insights', title: 'Insights' },
];

// The port that reports CRC errors on an alerting switch.
export function crcPort(sw) {
  return sw.ports.find((p) => p.clients.length && !p.uplinkPort);
}

function alert(dev, type, fields) {
  const { title, categoryType } = ALERT_TYPES[type];
  return { id: String(derive(dev.key, `${type}:${Math.floor(fields.startedAt)}`)), net: dev.net, dev, type, categoryType, title, ...fields };
}

// Alerts that started in the lookback window before now, oldest first.
export function orgAlerts(org, world, now) {
  const from = now - LOOKBACK;
  const out = [];
  for (const dev of org.devices) {
    eachOutage(dev, from, now, (s, e) => {
      if (Math.min(e, now) - s < GRACE || s + GRACE > now) return;
      out.push(alert(dev, 'unreachable', { severity: 'critical', description: `${dev.name} has not checked in with the Meraki cloud`, startedAt: s + GRACE, resolvedAt: e <= now ? e : null }));
    });
    if (dev.dormant && dev.dormantSince + GRACE <= now) {
      out.push(alert(dev, 'unreachable', { severity: 'critical', description: `${dev.name} has not checked in with the Meraki cloud`, startedAt: dev.dormantSince + GRACE, resolvedAt: null }));
    }
    if (dev.alerting) {
      const port = crcPort(dev);
      out.push(alert(dev, 'crc_errors', { severity: 'warning', description: `Very high proportion of CRC errors on port ${port.portId}`, port: port.portId, startedAt: world.dormantSince + 3 * DAY, resolvedAt: null }));
    }
    for (const u of dev.uplinks || []) {
      eachUplinkFailure(u, from, now, (s, e) => {
        if (Math.min(e, now) - s < GRACE || s + GRACE > now || isDown(dev, s)) return;
        const backup = dev.uplinks.length > 1;
        out.push(alert(dev, 'wan_status', { severity: backup ? 'warning' : 'critical', description: `${u.interface} on ${dev.name} lost connectivity${backup ? ' and traffic failed over' : ''}`, port: u.interface, startedAt: s + GRACE, resolvedAt: e <= now ? e : null }));
      });
    }
  }
  return out.filter((a) => a.startedAt >= from).sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));
}
