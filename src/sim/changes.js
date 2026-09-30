// The organization change log: a few Dashboard edits on most weekdays, by the
// admins allowed to make them. Each edit ends at the value the config
// endpoints show today.

import { configOf } from '../config.js';
import { derive, hashStr, unit } from '../rng.js';
import { DAY, weekday } from '../time.js';
import { perDay } from './cache.js';

function templates(net) {
  const out = [];
  const corp = net.ssids.find((s) => s.key === 'corp');
  if (corp) {
    const ssid = { ssidNumber: corp.number, ssidName: corp.name };
    out.push({ page: 'Wireless > Access control', label: 'Band selection', oldValue: 'Dual band operation', newValue: 'Dual band operation with Band Steering', ...ssid });
    out.push({ page: 'Wireless > Access control', label: 'Minimum bitrate', oldValue: '11', newValue: '12', ...ssid });
  }
  for (const sw of net.switches) {
    const port = sw.ports.find((p) => p.clients.length);
    if (port) out.push({ page: 'Switch > Switch ports', label: `${sw.name} / Port ${port.portId} > Enabled`, oldValue: 'false', newValue: 'true' });
  }
  if (net.mx) {
    const c = configOf(net);
    out.push({ page: 'Security & SD-WAN > Firewall', label: 'Layer 7 firewall rules', oldValue: JSON.stringify(c.l7Rules.slice(0, -1)), newValue: JSON.stringify(c.l7Rules) });
    out.push({ page: 'Security & SD-WAN > Content filtering', label: 'Blocked URL patterns', oldValue: '[]', newValue: JSON.stringify(c.contentFiltering.blockedUrlPatterns) });
    out.push({ page: 'Security & SD-WAN > Addressing & VLANs', label: 'VLAN 10 (Corporate) DHCP lease time', oldValue: '4 hours', newValue: '1 day' });
  }
  out.push({ page: 'Network-wide > Alerts', label: 'Default recipients', oldValue: '[]', newValue: '["netops@example.com"]' });
  out.push({ page: 'Network-wide > General', label: 'Local status page authentication', oldValue: 'false', newValue: 'true' });
  return out;
}

// Admins who can edit a network: full org access, or full access to that network.
function editors(org, net) {
  return org.admins.filter((a) => !a.api && a.accountStatus === 'ok' && (a.orgAccess === 'full' || a.networks.some((n) => n.id === net.id && n.access === 'full')));
}

export function changesOnDay(org, day) {
  return perDay(org, 'changeCache', day, () => {
    const k = derive(hashStr(org.id), day);
    const dow = weekday(day);
    const busy = org.index === 0 ? 4 : 1.3;
    const n = dow === 0 || dow === 6 ? (unit(k, 0) < 0.1 ? 1 : 0) : Math.floor(unit(k, 0) * busy);
    const out = [];
    for (let i = 0; i < n; i++) {
      const u = (j) => unit(k, 10 + i * 8 + j);
      const net = org.networks[Math.floor(u(0) * org.networks.length)];
      const who = editors(org, net);
      if (!who.length) continue;
      const pool = templates(net);
      // Pacific business hours, 08:00 to 16:00.
      out.push({ t: day * DAY + (15 + u(1) * 8) * 3600, net, admin: who[Math.floor(u(2) * who.length)], ...pool[Math.floor(u(3) * pool.length)] });
    }
    return out.sort((a, b) => a.t - b.t);
  });
}
