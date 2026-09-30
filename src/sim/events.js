// Network event log and MX security events, derived from client sessions,
// device outages and uplink failures so they agree with the other endpoints.

import { CF_BLOCKS, IDS_SIGNATURES, MALWARE } from '../catalog.js';
import { derive, unit } from '../rng.js';
import { DAY } from '../time.js';
import { perDay } from './cache.js';
import { eachOutage, eachUplinkFailure } from './outages.js';
import { END, START, sessions } from './presence.js';

const RADIO = { 2.4: '0', 5: '1', 6: '2' };
const CHANNELS = { 2.4: [1, 6, 11], 5: [36, 44, 52, 100, 149, 157], 6: [37, 69, 101] };

// Per-session connection failure, shared with the wireless connectionStats endpoint.
export function connectFailure(c, start) {
  const rate = c.ap.flaky ? 0.14 : 0.018;
  const k = derive(c.key, Math.floor(start));
  if (unit(k, 0) >= rate) return null;
  const r = unit(k, 1);
  return r < 0.5 ? 'auth' : r < 0.7 ? 'assoc' : r < 0.9 ? 'dhcp' : 'dns';
}

function radioInfo(c) {
  const chans = CHANNELS[c.band];
  const channel = chans[c.ap.key % chans.length];
  return { radio: RADIO[c.band], vap: String(c.ssid.number), channel: String(channel) };
}

// All events whose time falls in UTC day `day`, oldest first.
export function networkEventsOnDay(net, day) {
  return perDay(net, 'eventCache', day, () => buildEvents(net, day), 120);
}

function buildEvents(net, day) {
  const list = [];
  const a = day * DAY;
  const b = a + DAY;
  const inDay = (t) => t >= a && t < b;
  const push = (t, e) => {
    if (inDay(t)) list.push({ t, networkId: net.id, ...e });
  };

  for (const c of net.clients) {
    const zone = net.zone;
    for (let d = zone.day(a) - 1; d <= zone.day(b); d++) {
      for (const [s, e, flags] of sessions(c, d)) {
        if (e < a - 5 || s >= b + 60) continue;
        clientEvents(net, c, s, e, flags, push);
      }
    }
  }

  // A device going down shows up as its switch port dropping.
  for (const dev of net.devices) {
    if (!dev.switchPort) continue;
    eachOutage(dev, a - 3600, b, (s, e) => {
      push(s + 0.3, portEvent(dev.switchPort, '1Gfdx', 'down'));
      push(e + 0.8, portEvent(dev.switchPort, 'down', '1Gfdx'));
    });
    if (dev.dormant) push(dev.dormantSince + 0.3, portEvent(dev.switchPort, '1Gfdx', 'down'));
  }
  // This network's MX logs AutoVPN peers going away and coming back.
  if (net.mx && net.org.hub) {
    const peers = net.vpn === 'hub' ? net.org.networks.filter((n) => n.vpn === 'spoke') : [net.org.hub];
    for (const p of peers) {
      const ev = { productType: 'appliance', ...device(net.mx), type: 'vpn_connectivity_change', category: 'vpn', description: 'VPN connectivity change' };
      const data = { vpn_type: 'site-to-site', peer_contact: `${p.mx.uplinks[0].publicIp}:51820`, peer_ident: p.mx.serial };
      eachOutage(p.mx, a - 3600, b, (s, e) => {
        push(s + 25, { ...ev, eventData: { ...data, connectivity: 'false' } });
        push(e + 12, { ...ev, eventData: { ...data, connectivity: 'true' } });
      });
    }
  }
  if (net.mx) {
    for (const up of net.mx.uplinks) {
      if (up.interface !== 'wan1' || net.mx.uplinks.length < 2) continue;
      eachUplinkFailure(up, a, b, (s, e) => {
        const base = { type: 'failover_event', category: 'failover', description: 'Failover event', productType: 'appliance', ...device(net.mx) };
        push(s + 0.12, { ...base, eventData: { uplink: '1', reason: 'wan1 unreachable' } });
        push(e + 0.4, { ...base, eventData: { uplink: '0', reason: 'wan1 restored' } });
      });
    }
  }

  list.sort((x, y) => x.t - y.t);
  // Whole, strictly increasing microseconds so page cursors are exact.
  let prev = -Infinity;
  for (const e of list) prev = e.us = Math.max(Math.floor(e.t * 1e6), prev + 1);
  return list;
}

function device(dev) {
  return { deviceSerial: dev.serial, deviceName: dev.name };
}

function client(c) {
  return { clientId: c.id, clientDescription: c.description, clientMac: c.mac };
}

function portEvent(port, from, to) {
  return { productType: 'switch', ...device(port.switch), type: 'port_status', category: 'port', description: 'Port status change', eventData: { port: port.portId, old: from, new: to } };
}

function clientEvents(net, c, s, e, flags, push) {
  const frac = (i) => unit(c.key, Math.floor(s) + i);
  if (!c.wired && c.ap) {
    const ri = radioInfo(c);
    const w = { productType: 'wireless', ...client(c), ...device(c.ap), ssidNumber: c.ssid.number };
    if (flags & START) {
      const fail = connectFailure(c, s);
      if (fail) {
        const failure = {
          auth: c.ssid.auth === '8021x'
            ? { type: '8021x_eap_failure', category: '8021x', description: '802.1X EAP failure', eventData: { ...ri, client_mac: c.mac, identity: c.user, reason: 'Invalid credentials' } }
            : { type: 'wpa_deauth', category: 'wpa', description: 'WPA deauthentication', eventData: { ...ri, client_mac: c.mac, reason: 'Pairwise key handshake timed out' } },
          assoc: { type: 'association_rejected', category: '80211', description: '802.11 association rejected', eventData: { ...ri, client_mac: c.mac, status: '17' } },
          dhcp: { type: 'dhcp_no_offer', category: 'dhcp', description: 'DHCP no offers', eventData: { ...ri, client_mac: c.mac } },
          dns: { type: 'dns_failure', category: 'dns', description: 'DNS failure', eventData: { ...ri, client_mac: c.mac, server: `10.${net.siteIndex}.1.1` } },
        }[fail];
        push(s - 25 - frac(0) * 20, { ...w, ...failure });
      }
      push(s + frac(1) * 0.5, { ...w, type: 'association', category: '80211', description: '802.11 association', eventData: { ...ri, client_mac: c.mac, client_ip: c.ip, rssi: String(20 + Math.floor(frac(2) * 30)), aid: String(Math.floor(frac(3) * 2e9)) } });
      const auth = {
        '8021x': { type: '8021x_auth', category: '8021x', description: '802.1X authentication', eventData: { ...ri, client_mac: c.mac, client_ip: c.ip, identity: c.user } },
        wpa: { type: 'wpa_auth', category: 'wpa', description: 'WPA authentication', eventData: { ...ri, client_mac: c.mac, aid: String(Math.floor(frac(3) * 2e9)) } },
        splash: { type: 'splash_auth', category: 'splash', description: 'Splash authentication', eventData: { ip: c.ip, duration: '3600' } },
      }[c.ssid.auth];
      push(s + 0.6 + frac(4), { ...w, ...auth });
    }
    if (flags & END) {
      push(e, { ...w, type: 'disassociation', category: '80211', description: '802.11 disassociation', eventData: { ...ri, client_mac: c.mac, client_ip: c.ip, reason: '8', duration: String(Math.round(e - s)) } });
    }
  }

  if (c.wired && c.switchPort && c.kindName !== 'nas') {
    if (flags & START) push(s - 2 - frac(5), portEvent(c.switchPort, 'down', '1Gfdx'));
    if (flags & END) push(e + frac(6), portEvent(c.switchPort, '1Gfdx', 'down'));
  }

  if (net.mx && flags & START && c.kindName !== 'nas' && c.kindName !== 'printer') {
    push(s + 2 + frac(7) * 2, {
      productType: 'appliance', ...client(c), ...device(net.mx),
      type: 'dhcp_lease', category: 'dhcp', description: 'DHCP lease',
      eventData: { client_ip: c.ip, client_mac: c.mac, router_ip: `10.${net.siteIndex}.${c.vlan}.1`, lease_time: '86400' },
    });
    if (unit(c.key, Math.floor(s) + 99) < (c.kindName === 'guest' ? 0.06 : 0.015)) {
      const block = CF_BLOCKS[Math.floor(frac(8) * CF_BLOCKS.length)];
      push(s + 300 + frac(9) * Math.max(0, e - s - 300), {
        productType: 'appliance', ...client(c), ...device(net.mx),
        type: 'cf_block', category: 'content_filtering', description: 'Content filtering blocked URL',
        eventData: { url: block.url, category0: block.category, server: '8.8.8.8' },
      });
    }
  }
}

export function securityEventsOnDay(net, day) {
  return perDay(net, 'securityCache', day, () => buildSecurityEvents(net, day), 400);
}

function buildSecurityEvents(net, day) {
  const list = [];
  if (net.mx) {
    const k = derive(net.key ^ 0x5ec, day);
    const rate = net.code === 'HQ' ? 9 : net.kind === 'retail' ? 5 : 3;
    const n = Math.floor(rate * (0.4 + unit(k, 0) * 1.2));
    const pool = net.clients.filter((c) => c.kindName !== 'printer' && c.kindName !== 'deskPhone');
    for (let i = 0; i < n; i++) {
      const u = (j) => unit(k, 10 + i * 16 + j);
      const t = day * DAY + u(0) * DAY;
      const c = pool[Math.floor(u(1) * pool.length)];
      const ext = `${u(2) < 0.5 ? '203.0.113' : '192.0.2'}.${1 + Math.floor(u(3) * 250)}`;
      if (u(4) < 0.75) {
        const sig = IDS_SIGNATURES[Math.floor(u(5) * IDS_SIGNATURES.length)];
        const sport = 1024 + Math.floor(u(6) * 60000);
        const [src, dst] = sig.outbound ? [`${c.ip}:${sport}`, `${ext}:${sig.port}`] : [`${ext}:${sport}`, `${c.ip}:${sig.port}`];
        list.push({
          t, ts: t, eventType: 'IDS Alert', deviceMac: net.mx.mac, clientMac: c.mac, srcIp: src, destIp: dst,
          protocol: sig.protocol, priority: sig.priority, classification: sig.classification, blocked: u(7) < 0.85,
          message: sig.message, signature: sig.signature, sigSource: '', ruleId: `meraki:intrusion/snort/GID/1/SID/${sig.signature.split(':')[1]}`,
        });
      } else {
        const m = MALWARE[Math.floor(u(5) * MALWARE.length)];
        let hash = '';
        for (let j = 0; j < 8; j++) hash += Math.floor(u(8 + j) * 4294967296).toString(16).padStart(8, '0');
        list.push({
          t, ts: t, eventType: 'File Scanned', clientName: c.description, clientMac: c.mac, clientIp: c.ip, srcIp: c.ip,
          destIp: ext, protocol: 'http', uri: m.uri, canonicalName: m.canonicalName, destinationPort: 80, fileHash: hash,
          fileType: m.fileType, fileSizeBytes: 40000 + Math.floor(u(6) * 900000), disposition: 'Malicious', action: 'Blocked',
        });
      }
    }
    list.sort((x, y) => x.t - y.t);
  }
  return list;
}
