// Device live tools: jobs a device runs and reports back on, plus reboot.
// Each device keeps its own jobs. A job is new for a second, runs for the
// tool's time, then answers from the sim at that moment. With a frozen
// clock a job never gets older, so it finishes in the POST.

import { isIP } from 'node:net';
import { configOf } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { Rand, gauss, hashStr, unit } from '../rng.js';
import { linkSample, pathLatency, vpnReachable } from '../sim/links.js';
import { activeUplink, isDown } from '../sim/outages.js';
import { isOnline } from '../sim/presence.js';
import { isoMicro } from '../time.js';
import { newCallback, sendCallback } from '../webhooks.js';
import { devOf, round } from './common.js';
import { checkCyclePorts, peerConnected, portConfig, portLoad, portSpeed, portStatus, speedMbps } from './switch.js';

const QUEUED = 1;
const MAX_JOBS = 100;
const UNREACHABLE = 'The device is unreachable.';
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const FQDN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd]|fe80)/i;
// Watts a switch draws before PoE, and its PoE budget. Both are educated guesses.
const POWER = { 'MS390-48UX': [140, 1100], 'MS250-48FP': [80, 740], 'MS130-48P': [50, 740], 'MS130-24P': [35, 370], 'MS120-8LP': [15, 67] };
// Downstream Mbps a throughput test reaches on each kind of uplink.
const ISP_MBPS = { fiber: 940, cable: 480, dsl: 85 };
const IFACE = { '1 Gbps': 'GigabitEthernet', '10 Gbps': 'TenGigabitEthernet' };

const jobsOf = (dev) => (dev.liveTools ??= new Map());

function newJobId(world, dev) {
  dev.liveToolIds = (dev.liveToolIds ?? 0) + 1;
  return new Rand(hashStr(`meraki-api-emulator:${world.seed}:liveTool:${dev.serial}:${dev.liveToolIds}`)).digits(13);
}

function statusOf(job, now) {
  if (now < job.start) return 'new';
  if (now < job.end) return 'running';
  return job.failed ? 'failed' : 'complete';
}

function requireKind(dev, kinds) {
  if (!kinds.includes(dev.productType)) throw badRequest(`This live tool is not supported on ${dev.model} devices`);
}

function countParam(b) {
  const count = b.count ?? 5;
  if (count < 1 || count > 5) throw badRequest("'count' must be between 1 and 5");
  return count;
}

// ── Ping ──

// Where an address lives: this network's LAN, another network over the VPN, or the internet.
function lanHost(net, ip) {
  if (net.devices.some((d) => d.lanIp === ip)) return { up: () => true };
  const c = net.clients.find((x) => x.ip === ip);
  if (c) return { up: (t) => isOnline(c, t) };
  const gateway = /^10\.\d+\.(\d+)\.1$/.exec(ip);
  if (net.mx && gateway && ip === `${net.subnet(Number(gateway[1]))}.1`) return { up: (t) => !isDown(net.mx, t) };
  return null;
}

// Round trips in ms for `count` pings sent a second apart from t, null for a lost one.
function pingTimes(dev, target, t, count) {
  const net = dev.net;
  const hop = dev.productType === 'appliance' ? 0 : 0.4;
  const key = hashStr(`${dev.serial}:${target}`);
  const times = [];
  const local = lanHost(net, target);
  const other = local ? null : net.org.networks.find((n) => n !== net && lanHost(n, target));
  for (let i = 0; i < count; i++) {
    const at = t + i;
    let ms = null;
    if (local) {
      if (local.up(at)) ms = 0.5 + hop + Math.abs(gauss(key, at)) * 0.6;
    } else if (other) {
      if (net.vpn && other.vpn && net.mx && other.mx && vpnReachable(net, other, at) && lanHost(other, target).up(at)) ms = pathLatency(net, other) + hop + Math.abs(gauss(key, at));
    } else if (!PRIVATE.test(target)) {
      ms = internet(dev, target, at, key, hop);
    }
    times.push(ms == null ? null : round(ms, 1));
  }
  return times;
}

function internet(dev, target, at, key, hop) {
  const mx = dev.net.mx;
  if (!mx) return 12 + (hashStr(target) % 5) + hop + Math.abs(gauss(key, at)) * 1.5;
  const uplink = isDown(mx, at) ? null : activeUplink(mx, at);
  if (!uplink) return null;
  const s = linkSample(mx, uplink, at, target);
  if (s.latencyMs == null || unit(key, at) * 100 < s.lossPercent) return null;
  return s.latencyMs + hop + gauss(key, at + 0.5) * s.jitter * 0.5;
}

function pingResults(times) {
  const replies = [];
  times.forEach((ms, i) => ms != null && replies.push({ sequenceId: i + 1, size: 84, latency: Math.max(0.1, ms) }));
  const lat = replies.map((r) => r.latency);
  const avg = lat.length ? round(lat.reduce((a, b) => a + b, 0) / lat.length, 1) : null;
  return {
    sent: times.length,
    received: replies.length,
    loss: { percentage: round(((times.length - replies.length) / times.length) * 100, 1) },
    latencies: { minimum: lat.length ? Math.min(...lat) : null, average: avg, maximum: lat.length ? Math.max(...lat) : null },
    replies,
  };
}

// The cloud pinging the device, through its network's MX when it has one.
function pingDeviceTimes(dev, t, count) {
  const key = hashStr(`${dev.serial}:cloud`);
  const hop = dev.productType === 'appliance' ? 0 : 0.4;
  return Array.from({ length: count }, (_, i) => {
    const at = t + i;
    if (isDown(dev, at)) return null;
    const ms = internet(dev, 'dashboard.meraki.com', at, key, hop);
    return ms == null ? null : round(ms, 1);
  });
}

// ── Tables ──

// VLANs a switch carries: its ports' VLANs, the listed trunk VLANs and the management VLAN.
function switchVlans(sw) {
  const out = new Set([Number(configOf(sw.net).switchSettings.vlan ?? 1)]);
  for (const p of sw.ports) {
    const c = portConfig(sw.net, sw, p);
    for (const v of [c.vlan, c.voiceVlan]) if (v != null) out.add(Number(v));
    if (c.type === 'trunk' && c.allowedVlans && c.allowedVlans !== 'all') {
      for (const part of String(c.allowedVlans).split(',')) {
        const [a, b = a] = part.split('-').map(Number);
        for (let v = a; v <= b && v - a < 4094; v++) out.add(v);
      }
    }
  }
  return out;
}

function applianceVlans(mx) {
  const c = configOf(mx.net);
  return new Set(c.vlansEnabled ? c.vlans.map((v) => Number(v.id)) : [1]);
}

function arpEntries(dev, t) {
  const net = dev.net;
  const seen = (c) => isoMicro(t - (hashStr(c.mac) % 240) - unit(c.key, Math.floor(t)));
  if (dev.productType === 'wireless') {
    const rows = net.clients.filter((c) => !c.wired && c.ap === dev && isOnline(c, t)).map((c) => ({ ip: c.ip, mac: c.mac, vlanId: null, interface: null, lastUpdatedAt: null }));
    if (net.mx && !isDown(net.mx, t)) rows.unshift({ ip: `${net.subnet(1)}.1`, mac: net.mx.mac, vlanId: null, interface: null, lastUpdatedAt: null });
    return rows;
  }
  const vlans = switchVlans(dev);
  const rows = [];
  if (net.mx && !isDown(net.mx, t)) for (const v of [...vlans].sort((a, b) => a - b)) rows.push({ ip: `${net.subnet(v)}.1`, mac: net.mx.mac, vlanId: v, interface: null, lastUpdatedAt: seen(net.mx) });
  for (const d of net.devices) if (d !== dev && d.lanIp && !isDown(d, t)) rows.push({ ip: d.lanIp, mac: d.mac, vlanId: 1, interface: null, lastUpdatedAt: seen(d) });
  for (const c of net.clients) if (vlans.has(c.vlan) && isOnline(c, t)) rows.push({ ip: c.ip, mac: c.mac, vlanId: c.vlan, interface: null, lastUpdatedAt: seen(c) });
  return rows;
}

// Clients on the switch's ports, wireless ones behind its APs, and the devices it links to.
function macEntries(sw, t, mac) {
  const rows = [];
  for (const p of sw.ports) {
    const config = portConfig(sw.net, sw, p);
    if (config.enabled === false) continue;
    const peer = p.peer?.device;
    if (peer && !isDown(peer, t)) {
      rows.push({ mac: peer.mac, port: p.portId, vlanId: Number(config.vlan ?? 1) });
      if (peer.productType === 'wireless') for (const c of sw.net.clients) if (!c.wired && c.ap === peer && isOnline(c, t)) rows.push({ mac: c.mac, port: p.portId, vlanId: c.vlan });
    }
    for (const c of p.clients) if (isOnline(c, t)) rows.push({ mac: c.mac, port: p.portId, vlanId: c.vlan });
  }
  return mac ? rows.filter((r) => r.mac === mac.toLowerCase()) : rows;
}

// ── Switch ports ──

// Cabled ports report each pair's length, empty ones an open circuit, and SFP uplinks can't be tested.
function cableResults(sw, ports, t) {
  return ports.map((id) => {
    const port = sw.ports.find((p) => p.portId === id);
    const up = peerConnected(port, t);
    const cabled = port.peer || port.clients.length;
    const length = 2 + (hashStr(`${sw.serial}:${id}`) % 70);
    const pair = (index) => {
      if (port.uplinkPort) return { index, status: 'not-supported', lengthMeters: 0 };
      return cabled ? { index, status: 'ok', lengthMeters: length + (index % 2) } : { index, status: 'open', lengthMeters: 0 };
    };
    return { port: id, status: up ? 'up' : 'down', speedMbps: up ? speedMbps(portSpeed(sw, port)) : 0, pairs: [0, 1, 2, 3].map(pair) };
  });
}

function interfaceOf(sw, port) {
  const n = Number(port.portId);
  const module = port.uplinkPort;
  const number = module ? n - sw.info.ports : n;
  const speed = module ? sw.info.uplinkSpeed : sw.info.accessSpeed;
  return { name: `${IFACE[speed] ?? 'GigabitEthernet'}1/${module ? 1 : 0}/${number}`, slot: 1, subslot: module ? 1 : 0, number };
}

// A snapshot of the port statuses over the last five minutes.
function portResults(sw, t) {
  return sw.ports.map((port) => {
    const s = portStatus(sw, port, t - 300, t, t);
    return { portId: Number(port.portId), interface: interfaceOf(sw, port), speed: s.speed, status: s.status === 'Connected' ? 'connected' : 'disconnected', duplex: s.duplex === 'full', enabled: s.enabled, power: { isDrawing: s.poe.isAllocated } };
  });
}

function powerResults(sw, t) {
  const [base, poe] = POWER[sw.model] ?? [40, 370];
  let watts = base;
  for (const p of sw.ports) if (!p.uplinkPort && peerConnected(p, t)) watts += portLoad(p, t - 60, t).wh * 60;
  const instant = round(watts, 1);
  return { instant, peak: round(instant * (1.05 + 0.1 * unit(sw.key, Math.floor(t / 86400))), 1), budget: base + poe };
}

function throughput(mx, t) {
  const uplink = activeUplink(mx, t);
  if (!uplink) return null;
  const mbps = Math.min(ISP_MBPS[uplink.isp] ?? 300, mx.info.throughput) * (0.85 + 0.1 * unit(mx.key, Math.floor(t)));
  return { speeds: { downstream: round(mbps, 6) } };
}

function wakeOnLanVlans(dev) {
  return dev.productType === 'appliance' ? applianceVlans(dev) : switchVlans(dev);
}

// ── The tools ──

// Each tool: the ID field in its answers, the path param of its GET, the
// device kinds it runs on, how long it runs, its request fields and what
// a finished job adds. `post` lists those additions the POST answer shows too.
const TOOLS = {
  arpTable: {
    name: 'ArpTable',
    id: 'arpTableId',
    param: 'arpTableId',
    kinds: ['switch', 'wireless'],
    seconds: 3,
    result: (dev, job, t, ok) => (ok ? { entries: arpEntries(dev, t) } : { error: UNREACHABLE }),
  },
  cableTest: {
    name: 'CableTest',
    id: 'cableTestId',
    param: 'id',
    kinds: ['switch'],
    seconds: 5,
    request: (dev, b) => {
      if (!b.ports.length) throw badRequest("'ports' must not be empty");
      for (const p of b.ports) if (!dev.ports.some((x) => x.portId === String(p).trim())) throw badRequest(`'${p}' is not a port on this switch`);
      return { ports: b.ports.map((p) => String(p).trim()) };
    },
    result: (dev, job, t, ok) => (ok ? { results: cableResults(dev, job.request.ports, t) } : { error: UNREACHABLE }),
  },
  'leds/blink': {
    name: 'LedsBlink',
    id: 'ledsBlinkId',
    param: 'ledsBlinkId',
    seconds: 1,
    request: (dev, b) => {
      if (b.duration < 1 || b.duration > 3600) throw badRequest("'duration' must be between 1 and 3600 seconds");
      return { duration: b.duration };
    },
    result: (dev, job, t, ok) => (ok ? {} : { error: UNREACHABLE }),
    post: ['error'],
  },
  macTable: {
    name: 'MacTable',
    id: 'macTableId',
    param: 'macTableId',
    kinds: ['switch'],
    seconds: 3,
    request: (dev, b) => {
      if (b.mac == null) return {};
      if (!MAC.test(b.mac)) throw badRequest("'mac' must be a colon-delimited six-octet MAC address, like 00:11:22:a0:b1:c2");
      return { mac: b.mac };
    },
    result: (dev, job, t, ok) => (ok ? { entries: macEntries(dev, t, job.request.mac) } : { error: UNREACHABLE }),
  },
  ping: {
    name: 'Ping',
    id: 'pingId',
    param: 'id',
    seconds: 6,
    request: (dev, b) => {
      const target = String(b.target).trim();
      if (!isIP(target) && !FQDN.test(target)) throw badRequest("'target' must be an FQDN, IPv4 or IPv6 address");
      return { target, count: countParam(b) };
    },
    result: (dev, job, t, ok) => (ok ? { results: pingResults(pingTimes(dev, job.request.target, job.start, job.request.count)) } : {}),
  },
  pingDevice: {
    name: 'PingDevice',
    id: 'pingId',
    param: 'id',
    seconds: 6,
    reachable: true,
    request: (dev, b) => ({ count: countParam(b) }),
    result: (dev, job) => ({ results: pingResults(pingDeviceTimes(dev, job.start, job.request.count)) }),
  },
  'ports/cycle': {
    name: 'PortsCycle',
    id: 'cyclePortId',
    param: 'id',
    kinds: ['switch'],
    seconds: 5,
    request: (dev, b) => {
      checkCyclePorts(dev, b.ports);
      return { ports: b.ports };
    },
    result: (dev, job, t, ok) => (ok ? {} : { error: UNREACHABLE }),
  },
  'ports/status': {
    name: 'PortsStatus',
    id: 'jobId',
    param: 'jobId',
    kinds: ['switch'],
    seconds: 2,
    result: (dev, job, t, ok) => (ok ? { results: portResults(dev, t), errors: [] } : { errors: [UNREACHABLE] }),
  },
  'power/usage': {
    name: 'PowerUsage',
    id: 'jobId',
    param: 'jobId',
    kinds: ['switch'],
    seconds: 2,
    result: (dev, job, t, ok) => (ok ? { results: powerResults(dev, t), errors: [] } : { errors: [UNREACHABLE] }),
  },
  throughputTest: {
    name: 'ThroughputTest',
    id: 'throughputTestId',
    param: 'throughputTestId',
    kinds: ['appliance'],
    seconds: 10,
    result: (dev, job, t, ok) => {
      const result = ok ? throughput(dev, job.start) : null;
      return result ? { result } : { error: ok ? 'No uplink is active.' : UNREACHABLE, failed: true };
    },
    post: ['result', 'error'],
  },
  wakeOnLan: {
    name: 'WakeOnLan',
    id: 'wakeOnLanId',
    param: 'wakeOnLanId',
    kinds: ['appliance', 'switch'],
    seconds: 1,
    request: (dev, b) => {
      if (b.vlanId < 1 || b.vlanId > 4094) throw badRequest("'vlanId' must be between 1 and 4094");
      if (!MAC.test(b.mac)) throw badRequest("'mac' must be a colon-delimited six-octet MAC address");
      if (!wakeOnLanVlans(dev).has(b.vlanId)) throw badRequest(`VLAN ${b.vlanId} does not exist on this device`);
      return { vlanId: b.vlanId, mac: b.mac };
    },
    result: (dev, job, t, ok) => (ok ? {} : { error: UNREACHABLE }),
    post: ['error'],
  },
};

// A finished job's answer is worked out once, at the moment it finished.
function outcome(dev, tool, job) {
  if (!job.outcome) {
    const ok = tool.reachable || !isDown(dev, job.start);
    const { failed, ...fields } = tool.result(dev, job, job.end, ok);
    job.outcome = { failed: !ok || !!failed, fields };
  }
  return job.outcome;
}

function jobJson(dev, tool, job, now, { post = false } = {}) {
  const out = { [tool.id]: job.id, url: `/devices/${dev.serial}/liveTools/${job.path}/${job.id}`, request: { serial: dev.serial, ...job.request } };
  let status = statusOf(job, now);
  if (status === 'complete') {
    const { failed, fields } = outcome(dev, tool, job);
    if (failed) status = 'failed';
    out.status = status;
    for (const [k, v] of Object.entries(fields)) if (!post || tool.post?.includes(k)) out[k] = structuredClone(v);
  } else {
    out.status = status;
  }
  return out;
}

function createJob(ctx, path, tool) {
  const dev = devOf(ctx);
  if (tool.kinds) requireKind(dev, tool.kinds);
  const b = ctx.body;
  const request = tool.request ? tool.request(dev, b) : {};
  const callback = newCallback(ctx, dev.net, b.callback);
  const now = ctx.now;
  const seconds = path === 'ping' || path === 'pingDevice' ? request.count + 1 : tool.seconds;
  const job = { id: newJobId(ctx.world, dev), path, request, start: ctx.frozen ? now : now + QUEUED, end: ctx.frozen ? now : now + QUEUED + seconds, callback: callback?.cb ?? null };
  const jobs = jobsOf(dev);
  if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value);
  jobs.set(job.id, job);
  const out = jobJson(dev, tool, job, now, { post: true });
  if (callback) {
    out.callback = { id: callback.cb.callbackId, url: callback.cb.webhook.url, status: 'new' };
    sendCallback(ctx, dev.net, dev, callback, () => jobJson(dev, tool, job, job.end), job.end - now);
  }
  return out;
}

function jobOf(ctx, path, tool) {
  const dev = devOf(ctx);
  const job = jobsOf(dev).get(ctx.params[tool.param]);
  if (!job || job.path !== path) throw notFound('Live tool job');
  const out = jobJson(dev, tool, job, ctx.now);
  if (path === 'pingDevice' && job.callback) out.callback = { id: job.callback.callbackId, url: job.callback.webhook.url, status: job.callback.status };
  return out;
}

// Spec rate limits per device: [seconds per request, burst].
const LIMITS = { 'leds/blink': [10, 1], throughputTest: [5, 1] };

export default [
  ...Object.entries(TOOLS).flatMap(([path, tool]) => [
    { op: `createDeviceLiveTools${tool.name}`, method: 'POST', path: `/devices/{serial}/liveTools/${path}`, perDevice: LIMITS[path] ?? [5, 5], handler: (ctx) => createJob(ctx, path, tool) },
    {
      op: `getDeviceLiveTools${tool.name}`,
      path: `/devices/{serial}/liveTools/${path}/{${tool.param}}`,
      sample: { [tool.param]: '1284392014819', status: 404, serial: tool.kinds?.[0] },
      handler: (ctx) => jobOf(ctx, path, tool),
    },
  ]),
  {
    op: 'rebootDevice',
    method: 'POST',
    status: 202,
    path: '/devices/{serial}/reboot',
    perDevice: [60, 1],
    handler: (ctx) => {
      devOf(ctx);
      return { success: true };
    },
  },
];
