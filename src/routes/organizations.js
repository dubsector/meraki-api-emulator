import { configOf, exportedSubnets } from '../config.js';
import { deviceJson, networkJson, networkRef, orgJson } from '../format.js';
import { arrayParam, badRequest, hasTags, notFound, paginate, paginateItems, timeWindow } from '../http.js';
import { linkAverage, linkSample, pathLatency, vpnReachable } from '../sim/links.js';
import { memorySamples, ramKb } from '../sim/memory.js';
import { deviceStatus, lastReportedAt, statusChanges, uplinkStatus } from '../sim/outages.js';
import { presenceIn } from '../sim/presence.js';
import { uplinkBytes } from '../sim/traffic.js';
import { WAN_RECV, WAN_SENT, WD_RECV, WD_SENT, WL_RECV, WL_SENT, networkTotals } from '../sim/usage.js';
import { DAY, HOUR, MIN, iso, isoMicro } from '../time.js';
import { validTimeZone } from '../validate.js';
import { addNetwork, addOrganization, dropSwitchSerials, removeOrganization } from '../world.js';
import { byId, bySerial, filterDevices, orgOf, round } from './common.js';
import { managementInterface } from './networkwide.js';

export const MAX_ORGS = 100;
const MAX_NETWORKS = 500;

function createNetwork(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  if (!b.productTypes.length) throw badRequest("'productTypes' must not be empty");
  if (org.networks.some((n) => n.name === b.name)) throw badRequest('Name has already been taken');
  if (b.timeZone != null && !validTimeZone(b.timeZone)) throw badRequest("'timeZone' must be a valid IANA time zone");
  if (org.networks.length >= MAX_NETWORKS) throw badRequest(`Organizations are limited to ${MAX_NETWORKS} networks in the emulator`);
  const source = b.copyFromNetworkId ? org.networks.find((n) => n.id === b.copyFromNetworkId) : null;
  if (b.copyFromNetworkId && !source) throw notFound('Network to copy from');
  const net = addNetwork(ctx.world, org, { name: b.name, productTypes: [...new Set(b.productTypes)], tags: b.tags, timeZone: b.timeZone, notes: b.notes });
  // Copying takes the source's settings, with its network ID swapped for the new one.
  if (source) net.config = dropSwitchSerials(JSON.parse(JSON.stringify(configOf(source)).replaceAll(source.id, net.id)));
  return networkJson(net);
}

// The address the cloud sees a device on: its MX's WAN 1, or a stand-in without an MX.
function publicIpOf(d) {
  const mx = d.net.mx;
  return mx ? mx.uplinks[0].publicIp : `192.0.2.${40 + d.net.siteIndex}`;
}

// A device that is down last reported its supplies without input power.
function powerSupplies(d, status) {
  const up = status !== 'offline' && status !== 'dormant';
  return Array.from({ length: d.info.psus ?? 0 }, (_, i) => ({ slot: i + 1, serial: `${d.serial.slice(0, 4)}-PSU${i + 1}`, model: 'PWR-C6-600WAC', up }));
}

// An MX lists each WAN with the address its management interface gives it.
// Other devices list their management address, behind the MX's NAT, on the
// management VLAN.
function uplinkAddresses(d) {
  const mgmt = managementInterface(d);
  const ipv4 = (w, dhcp) => ({
    protocol: 'ipv4',
    ...(w.usingStaticIp ? { assignmentMode: 'static', address: w.staticIp, gateway: w.staticGatewayIp, nameservers: { addresses: w.staticDns ?? [] } } : { assignmentMode: 'dynamic', ...dhcp }),
  });
  if (d.productType === 'appliance') {
    return d.uplinks.map((u) => {
      const w = mgmt[u.interface] ?? { usingStaticIp: false };
      const a = ipv4(w, { address: u.publicIp, gateway: u.gateway, nameservers: { addresses: ['8.8.8.8', '1.1.1.1'] } });
      return { interface: u.interface, addresses: [{ ...a, public: { address: a.address }, ...(w.vlan != null && { vlan: { id: String(w.vlan) } }) }] };
    });
  }
  const w = mgmt.wan1;
  const lan = `${d.net.subnet(1)}.1`;
  const vlan = w.vlan ?? (d.productType === 'switch' ? configOf(d.net).switchSettings.vlan : 1);
  return [{ interface: 'man1', addresses: [{ ...ipv4(w, { address: d.lanIp, gateway: lan, nameservers: { addresses: [lan, '8.8.4.4'] } }), public: { address: publicIpOf(d) }, vlan: { id: String(vlan) } }] }];
}

const MEMORY_INTERVALS = [300, 1200, 3600, 14400];

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// Whole intervals inside the window, newest first. One the device was down
// for all of is left out.
function memoryItem(d, t0, t1, interval) {
  const total = ramKb(d);
  const first = Math.ceil(t0 / interval) * interval;
  const last = Math.floor(t1 / interval) * interval;
  const samples = last > first ? memorySamples(d, first, last) : [];
  const byEnd = new Map();
  for (const s of samples) {
    const end = Math.ceil(s.t / interval) * interval;
    if (!byEnd.has(end)) byEnd.set(end, []);
    byEnd.get(end).push(s.used);
  }
  const intervals = [];
  for (let end = last; end > first; end -= interval) {
    const used = byEnd.get(end);
    if (!used) continue;
    const lo = Math.min(...used);
    const hi = Math.max(...used);
    const mid = median(used);
    intervals.push({
      startTs: iso(end - interval),
      endTs: iso(end),
      memory: {
        used: { minimum: lo, maximum: hi, median: Math.ceil(mid), percentages: { maximum: Math.round((hi / total) * 100) } },
        free: { minimum: total - hi, maximum: total - lo, median: Math.ceil(total - mid) },
      },
    });
  }
  const mid = samples.length ? median(samples.map((s) => s.used)) : null;
  return {
    serial: d.serial,
    model: d.model,
    name: d.name,
    mac: d.mac,
    tags: d.tags,
    provisioned: total,
    used: { median: mid == null ? null : Math.ceil(mid) },
    free: { median: mid == null ? null : Math.ceil(total - mid) },
    network: { id: d.net.id, name: d.net.name, tags: d.net.tags },
    intervals,
  };
}

// The last 24 whole intervals, five minutes each unless an interval is given.
// With a time range, the interval is the shortest that keeps each device to
// 300 intervals, or the one asked for if that is longer.
function memoryHistory(ctx) {
  const q = ctx.query;
  let interval = 300;
  if (q.has('interval')) {
    interval = Number(q.get('interval'));
    if (!MEMORY_INTERVALS.includes(interval)) throw badRequest(`'interval' must be one of: ${MEMORY_INTERVALS.join(', ')}`);
  }
  const timed = ['t0', 't1', 'timespan'].some((k) => q.has(k));
  let { t0, t1 } = timeWindow(q, ctx.now, { maxSpan: 31 * DAY, defaultSpan: 2 * HOUR, lookback: 31 * DAY });
  if (timed) {
    interval = Math.max(interval, MEMORY_INTERVALS.find((i) => (t1 - t0) / i <= 300) ?? MEMORY_INTERVALS.at(-1));
  } else {
    t1 = Math.floor(ctx.now / interval) * interval;
    t0 = t1 - 24 * interval;
  }
  const devices = filterDevices(q, orgOf(ctx).devices).sort(bySerial);
  return paginateItems(ctx, devices, (d) => d.serial, { def: 10, max: 20 }, (d) => memoryItem(d, t0, t1, interval));
}

function uplinkJson(mx, u, now) {
  return {
    interface: u.interface,
    status: uplinkStatus(mx, u, now),
    ip: u.publicIp,
    gateway: u.gateway,
    publicIp: u.publicIp,
    primaryDns: '8.8.8.8',
    secondaryDns: '1.1.1.1',
    ipAssignedBy: u.isp === 'fiber' ? 'static' : 'dhcp',
  };
}

function uplinkStatuses(ctx) {
  const org = orgOf(ctx);
  const networkIds = arrayParam(ctx.query, 'networkIds');
  const serials = arrayParam(ctx.query, 'serials');
  const rows = org.networks
    .filter((n) => n.mx && (!networkIds.length || networkIds.includes(n.id)) && (!serials.length || serials.includes(n.mx.serial)))
    .map((n) => ({
      networkId: n.id,
      serial: n.mx.serial,
      model: n.mx.model,
      lastReportedAt: iso(lastReportedAt(n.mx, ctx.now)),
      highAvailability: { enabled: false, role: 'primary' },
      uplinks: n.mx.uplinks.map((u) => uplinkJson(n.mx, u, ctx.now)),
    }))
    .sort((a, b) => (a.serial < b.serial ? -1 : 1));
  return paginate(ctx, rows, (r) => r.serial, { def: 1000, max: 1000 });
}

function vpnPeers(net) {
  if (!net.mx || !net.org.hub) return [];
  return net.vpn === 'hub' ? net.org.networks.filter((n) => n.vpn === 'spoke') : [net.org.hub];
}

// A spoke ranks its hubs by their order in its site-to-site settings, 1 first.
function vpnPeerStatus(local, peer, now) {
  const out = { networkId: peer.id, networkName: peer.name, reachability: vpnReachable(local, peer, now) ? 'reachable' : 'unreachable' };
  const s2s = configOf(local).siteToSite;
  const rank = s2s.mode === 'spoke' ? s2s.hubs.findIndex((h) => h.hubId === peer.id) : -1;
  if (rank >= 0) out.priority = rank + 1;
  return out;
}

function vpnPeerStats(local, peer, t0, t1) {
  const spoke = local.vpn === 'spoke' ? local : peer;
  const [s, r] = networkTotals(spoke, t0, t1, [WAN_SENT, WAN_RECV]);
  const toHub = s * 0.08;
  const fromHub = r * 0.08;
  const a = linkAverage(local.mx, local.mx.uplinks[0], t0, t1) || { latencyMs: 0, lossPercent: 0, jitter: 0 };
  const b = linkAverage(peer.mx, peer.mx.uplinks[0], t0, t1) || { latencyMs: 0, lossPercent: 0, jitter: 0 };
  const base = pathLatency(local, peer);
  const lat = base + ((a.latencyMs ?? 0) + (b.latencyMs ?? 0)) / 2;
  const loss = Math.min(100, (a.lossPercent + b.lossPercent) / 2);
  const jitter = ((a.jitter ?? 0) + (b.jitter ?? 0)) / 2;
  const mos = Math.max(1, Math.min(4.4, 4.4 - lat / 250 - loss * 0.12));
  const pair = { senderUplink: 'wan1', receiverUplink: 'wan1' };
  return {
    networkId: peer.id,
    networkName: peer.name,
    usageSummary: {
      receivedInKilobytes: Math.round(local === spoke ? fromHub : toHub),
      sentInKilobytes: Math.round(local === spoke ? toHub : fromHub),
    },
    latencySummaries: [{ ...pair, avgLatencyMs: Math.round(lat), minLatencyMs: Math.round(base * 0.97), maxLatencyMs: Math.round(lat * 2.2 + 25) }],
    lossPercentageSummaries: [{ ...pair, avgLossPercentage: round(loss, 2), minLossPercentage: 0, maxLossPercentage: round(Math.max(0.5, loss * 6), 2) }],
    jitterSummaries: [{ ...pair, avgJitter: round(jitter, 2), minJitter: round(jitter * 0.2, 2), maxJitter: round(jitter * 4 + 2, 2) }],
    mosSummaries: [{ ...pair, avgMos: round(mos, 1), minMos: round(Math.max(1, mos - 0.6), 1), maxMos: round(Math.min(4.5, mos + 0.1), 1) }],
  };
}

export default [
  {
    op: 'getOrganizations',
    path: '/organizations',
    handler: (ctx) => paginate(ctx, [...ctx.world.orgs].sort(byId).map(orgJson), (o) => o.id, { def: 9000, max: 9000 }),
  },
  {
    op: 'getOrganization',
    path: '/organizations/{organizationId}',
    handler: (ctx) => orgJson(orgOf(ctx)),
  },
  {
    op: 'createOrganization',
    method: 'POST',
    path: '/organizations',
    handler: (ctx) => {
      if (ctx.world.orgs.length >= MAX_ORGS) throw badRequest(`The emulator is limited to ${MAX_ORGS} organizations`);
      const org = addOrganization(ctx.world, ctx.body.name);
      if (ctx.body.management) org.management = ctx.body.management;
      return orgJson(org);
    },
  },
  {
    op: 'updateOrganization',
    method: 'PUT',
    path: '/organizations/{organizationId}',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const b = ctx.body;
      if (b.name != null) org.name = b.name;
      if (b.management) org.management = b.management;
      if (b.api?.enabled != null) org.apiEnabled = b.api.enabled;
      return orgJson(org);
    },
  },
  {
    op: 'deleteOrganization',
    method: 'DELETE',
    path: '/organizations/{organizationId}',
    handler: (ctx) => {
      const org = orgOf(ctx);
      if (org.networks.length) throw badRequest('Delete every network in the organization first');
      removeOrganization(ctx.world, org);
    },
  },
  {
    op: 'createOrganizationNetwork',
    method: 'POST',
    path: '/organizations/{organizationId}/networks',
    handler: createNetwork,
  },
  {
    op: 'getOrganizationNetworks',
    path: '/organizations/{organizationId}/networks',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const q = ctx.query;
      const tags = arrayParam(q, 'tags');
      const productTypes = arrayParam(q, 'productTypes');
      const mode = q.get('tagsFilterType') || 'withAnyTags';
      const bound = q.get('isBoundToConfigTemplate');
      const templateId = q.get('configTemplateId');
      if (templateId && bound === 'false') throw badRequest("'isBoundToConfigTemplate' cannot be false when 'configTemplateId' is set");
      const rows = org.networks
        .filter((n) => (bound == null || (bound === 'true') === !!n.template) && (!templateId || n.template?.id === templateId))
        .filter((n) => hasTags(n.tags, tags, mode) && (!productTypes.length || productTypes.some((p) => n.productTypes.includes(p))))
        .sort(byId)
        .map(networkJson);
      return paginate(ctx, rows, (n) => n.id, { def: 1000, max: 100000 });
    },
  },
  {
    op: 'getOrganizationDevices',
    path: '/organizations/{organizationId}/devices',
    handler: (ctx) => {
      const rows = filterDevices(ctx.query, orgOf(ctx).devices).sort(bySerial).map((d) => deviceJson(d));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 5000 });
    },
  },
  {
    op: 'getOrganizationDevicesStatuses',
    path: '/organizations/{organizationId}/devices/statuses',
    handler: (ctx) => {
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .sort(bySerial)
        .map((d) => {
          const status = deviceStatus(d, ctx.now);
          const out = {
            name: d.name,
            serial: d.serial,
            mac: d.mac,
            publicIp: publicIpOf(d),
            networkId: d.net.id,
            status,
            lastReportedAt: iso(lastReportedAt(d, ctx.now)),
            lanIp: d.lanIp ?? null,
            gateway: d.productType === 'appliance' ? d.uplinks[0].gateway : `${d.net.subnet(1)}.1`,
            ipType: d.productType === 'appliance' ? 'static' : 'dhcp',
            primaryDns: d.productType === 'appliance' ? '8.8.8.8' : `${d.net.subnet(1)}.1`,
            secondaryDns: '8.8.4.4',
            productType: d.productType,
            model: d.model,
            tags: d.tags,
          };
          if (d.info.psus) {
            out.components = { powerSupplies: powerSupplies(d, status).map(({ up, ...p }) => ({ ...p, status: up ? 'powering' : 'disconnected', poe: { unit: 'watts', maximum: 740 } })) };
          }
          return out;
        })
        .filter((d) => !statuses.length || statuses.includes(d.status));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesStatusesOverview',
    path: '/organizations/{organizationId}/devices/statuses/overview',
    handler: (ctx) => {
      const byStatus = { online: 0, alerting: 0, offline: 0, dormant: 0 };
      for (const d of filterDevices(ctx.query, orgOf(ctx).devices)) byStatus[deviceStatus(d, ctx.now)]++;
      return { counts: { byStatus } };
    },
  },
  {
    op: 'getOrganizationDevicesAvailabilities',
    path: '/organizations/{organizationId}/devices/availabilities',
    handler: (ctx) => {
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .sort(bySerial)
        .map((d) => ({ mac: d.mac, name: d.name, network: { id: d.net.id }, productType: d.productType, serial: d.serial, status: deviceStatus(d, ctx.now), tags: d.tags }))
        .filter((d) => !statuses.length || statuses.includes(d.status));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesPowerModulesStatusesByDevice',
    path: '/organizations/{organizationId}/devices/powerModules/statuses/byDevice',
    handler: (ctx) => {
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .filter((d) => d.info.psus)
        .sort(bySerial)
        .map((d) => {
          const slots = powerSupplies(d, deviceStatus(d, ctx.now)).map((p) => ({ number: p.slot, serial: p.serial, model: p.model, status: p.up ? 'powering' : 'not connected' }));
          return { mac: d.mac, name: d.name, network: { id: d.net.id }, productType: d.productType, serial: d.serial, tags: d.tags, slots };
        });
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesUplinksAddressesByDevice',
    path: '/organizations/{organizationId}/devices/uplinks/addresses/byDevice',
    handler: (ctx) => {
      const rows = filterDevices(ctx.query, orgOf(ctx).devices)
        .sort(bySerial)
        .map((d) => ({ mac: d.mac, name: d.name, network: { id: d.net.id }, productType: d.productType, serial: d.serial, tags: d.tags, uplinks: uplinkAddresses(d) }));
      return paginate(ctx, rows, (d) => d.serial, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationDevicesSystemMemoryUsageHistoryByInterval',
    path: '/organizations/{organizationId}/devices/system/memory/usage/history/byInterval',
    handler: memoryHistory,
  },
  {
    op: 'getOrganizationDevicesAvailabilitiesChangeHistory',
    path: '/organizations/{organizationId}/devices/availabilities/changeHistory',
    handler: (ctx) => {
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
      const statuses = arrayParam(ctx.query, 'statuses');
      const rows = [];
      for (const d of filterDevices(ctx.query, orgOf(ctx).devices)) {
        for (const ch of statusChanges(d, t0, t1, ctx.now)) {
          if (statuses.length && !statuses.includes(ch.to)) continue;
          rows.push({
            ts: isoMicro(ch.ts),
            device: { serial: d.serial, name: d.name, productType: d.productType, model: d.model },
            details: { old: [{ name: 'status', value: ch.from }], new: [{ name: 'status', value: ch.to }] },
            network: networkRef(d.net),
          });
        }
      }
      rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      return paginate(ctx, rows, (r) => `${r.ts}_${r.device.serial}`, { def: 1000, max: 1000 });
    },
  },
  {
    op: 'getOrganizationApplianceUplinkStatuses',
    path: '/organizations/{organizationId}/appliance/uplink/statuses',
    handler: uplinkStatuses,
  },
  {
    op: 'getOrganizationUplinksStatuses',
    path: '/organizations/{organizationId}/uplinks/statuses',
    handler: uplinkStatuses,
  },
  {
    op: 'getOrganizationApplianceVpnStatuses',
    path: '/organizations/{organizationId}/appliance/vpn/statuses',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const networkIds = arrayParam(ctx.query, 'networkIds');
      const rows = org.networks
        .filter((n) => n.mx && org.hub && (!networkIds.length || networkIds.includes(n.id)))
        .map((n) => ({
          networkId: n.id,
          networkName: n.name,
          deviceSerial: n.mx.serial,
          deviceStatus: deviceStatus(n.mx, ctx.now),
          uplinks: n.mx.uplinks.map((u) => ({ interface: u.interface, publicIp: u.publicIp })),
          vpnMode: configOf(n).siteToSite.mode,
          exportedSubnets: exportedSubnets(n),
          merakiVpnPeers: vpnPeers(n).map((p) => vpnPeerStatus(n, p, ctx.now)),
          thirdPartyVpnPeers: n.vpn === 'hub' ? [{ name: 'Cloud VPC', publicIp: '192.0.2.200', reachability: 'reachable' }] : [],
        }))
        .sort(byId);
      return paginate(ctx, rows, (r) => r.networkId, { def: 300, max: 300 });
    },
  },
  {
    op: 'getOrganizationApplianceVpnStats',
    path: '/organizations/{organizationId}/appliance/vpn/stats',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY, lookback: 31 * DAY });
      const networkIds = arrayParam(ctx.query, 'networkIds');
      const rows = org.networks
        .filter((n) => n.mx && org.hub && (!networkIds.length || networkIds.includes(n.id)))
        .sort(byId)
        .map((n) => ({ networkId: n.id, networkName: n.name, merakiVpnPeers: vpnPeers(n).map((p) => vpnPeerStats(n, p, t0, t1)) }));
      return paginate(ctx, rows, (r) => r.networkId, { def: 300, max: 300 });
    },
  },
  {
    op: 'getOrganizationDevicesUplinksLossAndLatency',
    path: '/organizations/{organizationId}/devices/uplinksLossAndLatency',
    handler: (ctx) => {
      const org = orgOf(ctx);
      // The newest sample Meraki serves is two minutes old.
      const latest = Math.floor((ctx.now - 2 * MIN) / MIN) * MIN;
      const { t0, t1 } = timeWindow(ctx.query, latest, { maxSpan: 300, defaultSpan: 300, lookback: 60 * DAY });
      const uplink = ctx.query.get('uplink');
      const ip = ctx.query.get('ip') || '8.8.8.8';
      const rows = [];
      for (const n of org.networks) {
        if (!n.mx) continue;
        for (const u of n.mx.uplinks) {
          if (uplink && u.interface !== uplink) continue;
          const timeSeries = [];
          for (let t = Math.ceil(t0 / MIN) * MIN; t < t1; t += MIN) {
            const s = linkSample(n.mx, u, t, ip);
            timeSeries.push({ ts: iso(t), lossPercent: s.lossPercent, latencyMs: s.latencyMs });
          }
          rows.push({ networkId: n.id, serial: n.mx.serial, uplink: u.interface, ip, timeSeries });
        }
      }
      return rows;
    },
  },
  {
    op: 'getOrganizationApplianceUplinksUsageByNetwork',
    path: '/organizations/{organizationId}/appliance/uplinks/usage/byNetwork',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 14 * DAY, lookback: 30 * DAY });
      return org.networks
        .filter((n) => n.mx)
        .map((n) => {
          const bytes = uplinkBytes(n, t0, t1);
          return { networkId: n.id, name: n.name, byUplink: n.mx.uplinks.map((u) => ({ serial: n.mx.serial, interface: u.interface, ...bytes[u.interface] })) };
        });
    },
  },
  {
    op: 'getOrganizationClientsOverview',
    path: '/organizations/{organizationId}/clients/overview',
    handler: (ctx) => {
      const org = orgOf(ctx);
      const { t0, t1 } = timeWindow(ctx.query, ctx.now, { maxSpan: 31 * DAY });
      let up = 0;
      let down = 0;
      let count = 0;
      for (const n of org.networks) {
        const [ws, wr, ds, dr] = networkTotals(n, t0, t1, [WL_SENT, WL_RECV, WD_SENT, WD_RECV]);
        up += ws + ds;
        down += wr + dr;
        for (const c of n.clients) if (presenceIn(c, t0, t1)) count++;
      }
      const total = Math.round(up + down);
      return { usage: { overall: { total, downstream: Math.round(down), upstream: Math.round(up) }, average: count ? round(total / count, 2) : 0 }, counts: { total: count } };
    },
  },
];

