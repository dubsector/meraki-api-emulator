// Traffic analysis rows and WAN uplink accounting.

import { APPS } from '../catalog.js';
import { derive, lognoise } from '../rng.js';
import { DAY } from '../time.js';
import { activeUplink, uplinkUp } from './outages.js';
import { presenceIn } from './presence.js';
import { SLOT, WAN_RECV, WAN_SENT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, clientsUsage, minuteShare, networkDay, networkTotals } from './usage.js';

// Relative upload weight per application; backups and calls push more upstream.
const UPLOAD = { Zoom: 3, Webex: 3, 'Amazon AWS': 8, Dropbox: 2, iCloud: 2, YouTube: 0.3, Netflix: 0.2, Spotify: 0.3 };

const SERIES = {
  combined: [WAN_SENT, WAN_RECV],
  appliance: [WAN_SENT, WAN_RECV],
  wireless: [WL_SENT, WL_RECV],
  switch: [WD_SENT, WD_RECV],
};

export function trafficRows(net, t0, t1, deviceType = 'combined') {
  const [sent, recv] = networkTotals(net, t0, t1, SERIES[deviceType] || SERIES.combined);
  const guests = net.clients.filter((c) => c.kindName === 'guest');
  const g = clientsUsage(guests, t0, t1);
  const guestShare = sent + recv > 0 ? Math.min(1, (g.sent + g.recv) / (sent + recv)) : 0;
  let present = 0;
  let clientSeconds = 0;
  for (const c of net.clients) {
    const p = presenceIn(c, t0, t1);
    if (p) {
      present++;
      clientSeconds += p.seconds;
    }
  }

  const day = Math.floor(t1 / DAY);
  const weights = APPS.map((a) => (a.weight * (1 - guestShare) + a.guest * guestShare) * lognoise(derive(net.key, a.application), day, 0.25));
  const upWeights = weights.map((w, i) => w * (UPLOAD[APPS[i].application] ?? 1));
  const wSum = weights.reduce((x, y) => x + y, 0);
  const upSum = upWeights.reduce((x, y) => x + y, 0);

  return APPS.map((a, i) => {
    const share = weights[i] / wSum;
    const s = (sent * upWeights[i]) / upSum;
    const r = recv * share;
    return {
      application: a.application,
      destination: a.destination,
      protocol: a.protocol,
      port: a.port,
      sent: Math.round(s),
      recv: Math.round(r),
      numClients: Math.max(1, Math.round(present * Math.min(1, share * 7))),
      activeTime: Math.round(clientSeconds * share),
      flows: Math.max(1, Math.round((s + r) / 90)),
    };
  })
    .filter((row) => row.sent + row.recv > 0)
    .sort((x, y) => y.sent + y.recv - (x.sent + x.recv));
}

// What single-purpose clients talk to. Laptops and phones follow the office
// mix, guests the guest mix, with the same daily noise as trafficRows.
const KIND_APPS = {
  nas: { 'Amazon AWS': 1 },
  deskPhone: { Webex: 1 },
  printer: { 'Non-web TCP': 3, DNS: 1 },
  confTv: { Zoom: 3, Webex: 1 },
  iot: { 'Miscellaneous secure web': 4, DNS: 1 },
  scanner: { 'Miscellaneous secure web': 3, 'Non-web TCP': 2, DNS: 0.5 },
  pos: { 'Miscellaneous secure web': 4, DNS: 0.5 },
};

// Splits a client's sent and received KB across applications, biggest first.
export function clientApps(c, sent, recv, day) {
  const fixed = KIND_APPS[c.kindName];
  const weights = APPS.map((a) => (fixed ? (fixed[a.application] ?? 0) : c.kindName === 'guest' ? a.guest : a.weight) * lognoise(derive(c.net.key, a.application), day, 0.25));
  const upWeights = weights.map((w, i) => w * (UPLOAD[APPS[i].application] ?? 1));
  const wSum = weights.reduce((x, y) => x + y, 0);
  const upSum = upWeights.reduce((x, y) => x + y, 0);
  return APPS.map((a, i) => ({ app: a, share: weights[i] / wSum, sent: (sent * upWeights[i]) / upSum, recv: (recv * weights[i]) / wSum }))
    .filter((r) => Math.round(r.sent) + Math.round(r.recv) > 0)
    .sort((x, y) => y.sent + y.recv - (x.sent + x.recv));
}

// WAN bytes per uplink over [a, b). Traffic rides whichever uplink is active.
export function uplinkBytes(net, a, b, res = SLOT) {
  const mx = net.mx;
  const out = Object.fromEntries(mx.uplinks.map((u) => [u.interface, { sent: 0, received: 0 }]));
  const step = res < SLOT ? 60 : SLOT;
  for (let t = Math.floor(a / step) * step; t < b; t += step) {
    const w = (Math.min(b, t + step) - Math.max(a, t)) / step;
    if (w <= 0) continue;
    const slot = Math.floor(t / SLOT);
    const day = Math.floor(slot / (DAY / SLOT));
    const arr = networkDay(net, day);
    const i = slot - day * (DAY / SLOT);
    const per = DAY / SLOT;
    const frac = step === 60 ? minuteShare(net.key, t / 60) : 1;
    const active = activeUplink(mx, t + step / 2);
    if (active) {
      out[active.interface].sent += arr[WAN_SENT * per + i] * 1000 * frac * w;
      out[active.interface].received += arr[WAN_RECV * per + i] * 1000 * frac * w;
    }
    // Standby uplinks still carry a little probe traffic.
    for (const u of mx.uplinks) {
      if (u !== active && uplinkUp(mx, u, t)) {
        out[u.interface].sent += 180 * (step / 60) * w;
        out[u.interface].received += 240 * (step / 60) * w;
      }
    }
  }
  for (const v of Object.values(out)) {
    v.sent = Math.round(v.sent);
    v.received = Math.round(v.received);
  }
  return out;
}
