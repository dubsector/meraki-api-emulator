// The page served at `/`: what the emulator contains, how it is doing, and a small request explorer.

import { sampleUrl } from './samples.js';
import { schemaOf } from './validate.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ORDER = ['GET', 'POST', 'PUT', 'DELETE'];
const BLANK = { string: '', integer: 0, number: 0, boolean: false, array: [], object: {} };
const PRODUCTS = {
  appliance: 'Appliance',
  camera: 'Camera',
  campusGateway: 'Campus gateway',
  cellularGateway: 'Cellular gateway',
  insight: 'Insight',
  sensor: 'Sensor',
  sm: 'Systems manager',
  switch: 'Switch',
  wireless: 'Wireless',
  wirelessController: 'Wireless controller',
};
const GROUPS = ['Organizations', 'Networks', 'Devices', ...Object.values(PRODUCTS), 'Administered'];

// A starting body for the explorer: the operation's required fields, empty.
function bodyTemplate(op) {
  const schema = schemaOf(op);
  if (!schema) return '';
  const body = Object.fromEntries((schema.required || []).map((k) => [k, BLANK[schema.properties?.[k]?.type] ?? '']));
  return JSON.stringify(body, null, 2);
}

// Product paths group by product, the rest by what they hang off.
function groupOf(path) {
  const [, top, , section] = path.split('/');
  if (top === 'administered') return 'Administered';
  return PRODUCTS[section] ?? { organizations: 'Organizations', networks: 'Networks' }[top] ?? 'Devices';
}

// JSON that is safe inside a <script> element.
const embed = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

export function landingPage(world, routes, { apiKey, readOnly, now, version, seed }) {
  // Writes borrow the example IDs of the GET on the same path.
  const gets = new Map(routes.filter((r) => r.method === 'GET').map((r) => [r.path, r]));
  const example = (r) => {
    if (r.method === 'GET') return sampleUrl(r, world, now);
    const { query, status, ...ids } = r.sample ?? gets.get(r.path)?.sample ?? {};
    return sampleUrl({ ...r, sample: ids }, world, now);
  };
  const listed = (readOnly ? routes.filter((r) => r.method === 'GET') : routes)
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : ORDER.indexOf(a.method) - ORDER.indexOf(b.method)));
  const endpoints = listed.map((r) => [r.method, r.path, example(r), r.op, GROUPS.indexOf(groupOf(r.path)), r.method === 'GET' ? '' : bodyTemplate(r.op)]);
  const org0 = world.orgs[0];
  const orgRows = world.orgs
    .map(
      (o) => `
      <section class="org">
        <h3>${esc(o.name)} <button type="button" class="id" data-go="/organizations/${esc(o.id)}">${esc(o.id)}</button></h3>
        <table>
          <thead><tr><th>Network</th><th>ID</th><th>Products</th><th class="n">Devices</th><th class="n">Clients</th></tr></thead>
          <tbody>${o.networks
            .map(
              (n) =>
                `<tr><td>${esc(n.name)}</td><td><button type="button" class="id" data-go="/networks/${esc(n.id)}">${esc(n.id)}</button></td><td>${esc(n.productTypes.join(', '))}</td><td class="n"><button type="button" class="id" data-go="/networks/${esc(n.id)}/devices">${n.devices.length}</button></td><td class="n"><button type="button" class="id" data-go="/networks/${esc(n.id)}/clients">${n.clients.length}</button></td></tr>`,
            )
            .join('')}</tbody>
        </table>
      </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meraki API Emulator</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #f7f8fa; --panel: #ffffff; --text: #1d2330; --muted: #5d6677; --border: #dde1e8;
  --accent: #0b7a53; --accent-soft: #e3f3ec; --code: #eef1f5; --bad: #b42318; --warn: #a15c07; --post: #1d4ed8; --put: #a15c07;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #11151c; --panel: #181e27; --text: #e4e8ef; --muted: #98a2b3; --border: #2a3240;
    --accent: #3ccf95; --accent-soft: #173327; --code: #202835; --bad: #f97066; --warn: #f2b766; --post: #7aa7ff; --put: #f2b766;
  }
}
:root[data-theme="dark"] {
  --bg: #11151c; --panel: #181e27; --text: #e4e8ef; --muted: #98a2b3; --border: #2a3240;
  --accent: #3ccf95; --accent-soft: #173327; --code: #202835; --bad: #f97066; --warn: #f2b766; --post: #7aa7ff; --put: #f2b766;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 64px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 28px; margin: 0 0 4px; }
.version { color: var(--muted); font-size: 15px; font-weight: 400; }
h2 { font-size: 19px; margin: 36px 0 12px; }
h3 { font-size: 15px; margin: 20px 0 8px; }
p { margin: 6px 0; }
a { color: var(--accent); }
.lede { color: var(--muted); margin-bottom: 20px; }
code, pre, input { font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--code); padding: 12px 14px; border-radius: 8px; overflow: auto; margin: 8px 0; }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
td.n, th.n { text-align: right; }
.org { overflow-x: auto; }
button.id { all: unset; cursor: pointer; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
button.id:hover, button.id:focus-visible { background: var(--accent-soft); color: var(--accent); }
.ghost { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; }
.ghost:hover, .ghost:focus-visible { border-color: var(--accent); color: var(--accent); }
.ghost.danger:hover, .ghost.danger:focus-visible { border-color: var(--bad); color: var(--bad); }
.tools { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; }
.tile { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.tile .k { font-size: 12px; color: var(--muted); }
.tile .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tile .v.bad { color: var(--bad); }
.tile .v.warn { color: var(--warn); }
.health-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 20px; margin-top: 14px; }
#spark { width: 100%; height: 64px; display: block; }
#spark .line { fill: none; stroke: var(--accent); stroke-width: 1.5; }
#spark .area { fill: var(--accent-soft); }
#spark .base { stroke: var(--border); }
.slow { font-size: 13px; }
.slow td { padding: 4px 6px; }
.slow button { all: unset; cursor: pointer; color: var(--accent); }
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 20px; align-items: start; }
details.group { border-bottom: 1px solid var(--border); }
details.group > summary { cursor: pointer; padding: 6px 2px; font-weight: 600; font-size: 14px; }
details.group[hidden] { display: none; }
.endpoints { list-style: none; padding: 0 0 8px; margin: 0; }
.endpoints button { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: 100%; padding: 3px 6px; border-radius: 5px; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.endpoints button:hover, .endpoints button:focus-visible { background: var(--accent-soft); }
.endpoints button.active { background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
.verb { display: inline-block; min-width: 52px; color: var(--accent); font-weight: 700; }
.verb.post { color: var(--post); }
.verb.put { color: var(--put); }
.verb.delete { color: var(--bad); }
.op { display: block; color: var(--muted); font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding-left: 52px; }
.count { color: var(--muted); font-weight: 400; }
.endpoints li[hidden] { display: none; }
#filter { margin-bottom: 4px; }
.endpoint-list { max-height: 75vh; overflow-x: hidden; overflow-y: auto; margin-top: 8px; }
.explorer { position: sticky; top: 16px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
input, select, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
select { width: auto; }
textarea { min-height: 110px; resize: vertical; }
.row { display: flex; gap: 8px; }
.row input { flex: 1; }
button.send { padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--panel); font-weight: 600; cursor: pointer; }
#status { margin-top: 12px; font-size: 13px; color: var(--muted); }
#status.bad { color: var(--bad); }
#body { max-height: 60vh; min-height: 120px; }
#link { word-break: break-all; font-size: 12px; }
#reqcurl { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
details.headers summary { cursor: pointer; font-size: 13px; color: var(--muted); margin-top: 8px; }
.note { font-size: 13px; color: var(--muted); }
@media (max-width: 820px) { .grid, .health-grid { grid-template-columns: minmax(0, 1fr); } .explorer { position: static; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Meraki API Emulator <span class="version">v${esc(version)}</span></h1>
    <button type="button" class="ghost" id="theme" aria-label="Color theme">Theme: auto</button>
  </header>
  <p class="lede">A local stand-in for the Cisco Meraki Dashboard API v1, serving simulated organizations, networks, devices and client traffic. Not affiliated with or endorsed by Cisco.</p>

  <div class="panel">
    <p>Base URL <code id="base">/api/v1</code>. Send a key in <code>X-Cisco-Meraki-API-Key</code> or <code>Authorization: Bearer</code>. ${apiKey ? 'This server only accepts the key it was started with.' : 'Any non-empty key is accepted.'}</p>
    <pre id="curl"></pre>
    <p class="note">Data is generated from the seed (<code>${esc(seed ?? '')}</code>) and the clock, so the same seed and time always give the same answer. Link headers use unquoted <code>rel=next</code>, the same as the real API. Every call you make is logged, so <code>/organizations/{organizationId}/apiRequests</code> shows what your client actually sent.</p>
    <p class="note">${readOnly ? 'This server is read-only, so PUT, POST and DELETE answer 405.' : 'Writes change the emulator\'s configuration in memory and show up in the change log. <code>POST /_emulator/reset</code> puts everything back.'}</p>
    <div class="tools">
      <button type="button" class="ghost" data-go="/organizations/${esc(org0.id)}/apiRequests">Request log</button>
      <button type="button" class="ghost" data-go="/organizations/${esc(org0.id)}/configurationChanges">Change log</button>
      <button type="button" class="ghost danger" id="reset">Reset emulator</button>
    </div>
  </div>

  <h2>API health</h2>
  <div class="panel" id="health">
    <div class="tiles">
      <div class="tile"><div class="k">Uptime</div><div class="v" id="h-uptime">-</div></div>
      <div class="tile"><div class="k">Requests per minute</div><div class="v" id="h-rate">-</div></div>
      <div class="tile"><div class="k">p50 response</div><div class="v" id="h-p50">-</div></div>
      <div class="tile"><div class="k">p95 response</div><div class="v" id="h-p95">-</div></div>
      <div class="tile"><div class="k">Slowest response</div><div class="v" id="h-max">-</div></div>
      <div class="tile"><div class="k">Errors (4xx / 5xx)</div><div class="v" id="h-errors">-</div></div>
      <div class="tile"><div class="k">Rate limited</div><div class="v" id="h-limited">-</div></div>
    </div>
    <div class="health-grid">
      <div>
        <label>p95 response time, last 5 minutes</label>
        <svg id="spark" viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label="p95 response time over the last 5 minutes"></svg>
        <p class="note" id="h-note">Counts API calls to <code>/api/v1</code> from any client. <a href="/healthz">/healthz</a> has the same numbers as JSON.</p>
      </div>
      <div>
        <label>Most called operations</label>
        <table class="slow"><tbody id="h-slow"><tr><td class="note">No API calls in the last 5 minutes.</td></tr></tbody></table>
      </div>
    </div>
  </div>

  <h2>Organizations and networks</h2>
  <div class="panel">${orgRows}</div>

  <h2>Endpoints</h2>
  <div class="grid">
    <div class="panel">
      <label for="filter">Filter by path, operation ID or product</label>
      <input id="filter" type="search" spellcheck="false" placeholder="e.g. vlans or getOrganizationDevices">
      <div class="endpoint-list" id="endpoints"></div>
    </div>
    <div class="panel explorer">
      <form id="try">
        <label for="key">API key</label>
        <input id="key" autocomplete="off" spellcheck="false" value="${apiKey ? '' : 'demo-key'}" placeholder="API key">
        <label for="path">Request</label>
        <div class="row">
          <select id="method" aria-label="Method">${(readOnly ? ['GET'] : ORDER).map((m) => `<option>${m}</option>`).join('')}</select>
          <input id="path" spellcheck="false" value="/organizations" aria-label="Path">
          <button class="send" type="submit">Send</button>
        </div>
        <div id="payload" hidden>
          <label for="request">JSON body</label>
          <textarea id="request" spellcheck="false"></textarea>
        </div>
      </form>
      <div class="tools">
        <button type="button" class="ghost" id="copy-curl">Copy as curl</button>
        <button type="button" class="ghost" id="copy-link">Copy link</button>
      </div>
      <pre id="reqcurl"></pre>
      <div id="status">Pick an endpoint or edit the path, then send.</div>
      <div id="link"></div>
      <details class="headers" id="headers-box" hidden><summary>Response headers</summary><pre id="headers"></pre></details>
      <pre id="body"></pre>
    </div>
  </div>
</main>
<script type="application/json" id="data">${embed({ endpoints, groups: GROUPS, demoKey: apiKey ? '' : 'demo-key' })}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

// The page's script. Kept as a raw string so it reads like plain JavaScript.
const SCRIPT = String.raw`
const data = JSON.parse(document.getElementById('data').textContent);
const base = location.origin + '/api/v1';
const $ = (id) => document.getElementById(id);
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Storage can be missing or blocked, so every access is guarded.
const store = {
  get: (k) => { try { return localStorage.getItem('emu.' + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem('emu.' + k, v); } catch {} },
};
$('base').textContent = base;
$('curl').textContent = "curl -H 'X-Cisco-Meraki-API-Key: " + (data.demoKey || '<your key>') + "' " + base + '/organizations';

// Theme: auto follows the system, light and dark override it.
const themes = ['auto', 'light', 'dark'];
const applyTheme = (t) => {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $('theme').textContent = 'Theme: ' + t;
};
let theme = themes.includes(store.get('theme')) ? store.get('theme') : 'auto';
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  store.set('theme', theme);
  applyTheme(theme);
});

// Endpoint list, built here to keep the page small. Paths may break after a slash.
const groups = data.groups.map((name) => ({ name, items: [] }));
data.endpoints.forEach(([method, path, example, op, g, body], i) => groups[g].items.push({ i, method, path, example, op, body, search: (method + ' ' + path + ' ' + op + ' ' + data.groups[g]).toLowerCase() }));
$('endpoints').innerHTML = groups.filter((g) => g.items.length).map((g) =>
  '<details class="group"><summary>' + escHtml(g.name) + ' <span class="count">' + g.items.length + '</span></summary><ul class="endpoints">' +
  g.items.map((r) => '<li data-search="' + escHtml(r.search) + '"><button type="button" data-i="' + r.i + '"><span class="verb ' + r.method.toLowerCase() + '">' + r.method + '</span> ' +
    escHtml(r.path).replace(/\//g, '/<wbr>') + '<span class="op">' + escHtml(r.op) + '</span></button></li>').join('') +
  '</ul></details>').join('');

const form = $('try');
const pathEl = $('path');
const statusEl = $('status');
const bodyEl = $('body');
const linkEl = $('link');
const methodEl = $('method');
const requestEl = $('request');
const payloadEl = $('payload');
const keyEl = $('key');
if (store.get('key')) keyEl.value = store.get('key');
keyEl.addEventListener('change', () => store.set('key', keyEl.value));
const hasBody = () => methodEl.value === 'PUT' || methodEl.value === 'POST';
const urlOf = () => {
  const path = pathEl.value.trim();
  return /^https?:/.test(path) ? path : base + (path.startsWith('/') ? path : '/' + path);
};
const quote = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const curlOf = () => {
  const parts = ['curl'];
  if (methodEl.value !== 'GET') parts.push('-X ' + methodEl.value);
  parts.push('-H ' + quote('X-Cisco-Meraki-API-Key: ' + keyEl.value));
  if (hasBody()) parts.push('-H ' + quote('Content-Type: application/json'), '--data ' + quote(requestEl.value || '{}'));
  parts.push(quote(urlOf()));
  return parts.join(' ');
};
const refresh = () => {
  payloadEl.hidden = !hasBody();
  $('reqcurl').textContent = curlOf();
};
[methodEl, pathEl, requestEl, keyEl].forEach((el) => el.addEventListener('input', refresh));
methodEl.addEventListener('change', refresh);

// The request in the address bar, so a link reopens it.
const remember = () => history.replaceState(null, '', '#' + encodeURIComponent(methodEl.value + ' ' + pathEl.value.trim()));

async function send() {
  const method = methodEl.value;
  const init = { method, headers: { 'X-Cisco-Meraki-API-Key': keyEl.value } };
  if (hasBody()) {
    init.headers['Content-Type'] = 'application/json';
    init.body = requestEl.value || '{}';
  }
  remember();
  statusEl.className = '';
  statusEl.textContent = 'Loading...';
  linkEl.textContent = '';
  $('headers-box').hidden = true;
  const t = performance.now();
  try {
    const res = await fetch(urlOf(), init);
    const text = await res.text();
    const ms = Math.round(performance.now() - t);
    let pretty = text;
    let count = '';
    try {
      const json = JSON.parse(text);
      pretty = JSON.stringify(json, null, 2);
      if (Array.isArray(json)) count = ', ' + json.length + ' items';
      else if (Array.isArray(json.events)) count = ', ' + json.events.length + ' events';
    } catch {}
    statusEl.className = res.ok ? '' : 'bad';
    statusEl.textContent = res.status + ' ' + res.statusText + ' in ' + ms + ' ms' + count;
    const link = res.headers.get('Link');
    if (link) linkEl.innerHTML = 'Link: ' + link.split(', ').map((l) => {
      const m = /^<([^>]+)>; rel=(\w+)$/.exec(l);
      return m ? '<a href="#" data-url="' + escHtml(m[1]) + '">' + m[2] + '</a>' : '';
    }).join(' ');
    $('headers').textContent = [...res.headers].map(([k, v]) => k + ': ' + v).join('\n');
    $('headers-box').hidden = false;
    bodyEl.textContent = pretty;
  } catch (e) {
    statusEl.className = 'bad';
    statusEl.textContent = String(e);
  }
  loadHealth();
}

// Reads run straight away; writes wait for Send, since they change the emulator.
function load(method, path, body) {
  methodEl.value = method;
  pathEl.value = path;
  requestEl.value = body || '';
  refresh();
  if (method === 'GET') return send();
  remember();
  statusEl.className = '';
  statusEl.textContent = 'Fill in the path and body, then press Send.';
  bodyEl.textContent = '';
  linkEl.textContent = '';
  $('headers-box').hidden = true;
}

form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('endpoints').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  document.querySelectorAll('.endpoints button.active').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  const [method, , example, , , body] = data.endpoints[b.dataset.i];
  load(method, example, body);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  load('GET', b.dataset.go);
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

const filterEl = $('filter');
function applyFilter() {
  const words = filterEl.value.toLowerCase().split(/\s+/).filter(Boolean);
  store.set('filter', filterEl.value);
  document.querySelectorAll('details.group').forEach((d) => {
    let shown = 0;
    d.querySelectorAll('li').forEach((li) => { li.hidden = !words.every((w) => li.dataset.search.includes(w)); if (!li.hidden) shown++; });
    d.querySelector('.count').textContent = shown;
    d.hidden = !shown;
    d.open = words.length > 0 && shown <= 60;
  });
}
filterEl.value = store.get('filter') || '';
filterEl.addEventListener('input', applyFilter);
if (filterEl.value) applyFilter();

linkEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  load('GET', a.dataset.url.replace(base, ''));
});

async function copy(text, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select and copy below';
  }
  setTimeout(() => { button.textContent = label; }, 1500);
}
$('copy-curl').addEventListener('click', (e) => copy(curlOf(), e.currentTarget));
$('copy-link').addEventListener('click', (e) => { remember(); copy(location.href, e.currentTarget); });

$('reset').addEventListener('click', async () => {
  if (!confirm('Reset the emulator? Every write is thrown away and the seed data comes back.')) return;
  const res = await fetch('/_emulator/reset', { method: 'POST', headers: { 'X-Cisco-Meraki-API-Key': keyEl.value } });
  statusEl.className = res.ok ? '' : 'bad';
  statusEl.textContent = res.ok ? 'The emulator was reset.' : 'Reset failed: ' + res.status + ' ' + res.statusText;
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// Health, refreshed every few seconds while the page is visible.
const fmtMs = (ms) => (ms == null ? '-' : ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms');
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm ' + (s % 60) + 's' : s + 's';
};
function spark(points) {
  const max = Math.max(1, ...points.map((p) => p.p95Ms || 0));
  const step = 300 / Math.max(1, points.length - 1);
  const xy = points.map((p, i) => (i * step).toFixed(1) + ',' + (62 - ((p.p95Ms || 0) / max) * 56).toFixed(1));
  $('spark').innerHTML = '<line class="base" x1="0" y1="62.5" x2="300" y2="62.5"/>' +
    '<polygon class="area" points="0,62 ' + xy.join(' ') + ' 300,62"/><polyline class="line" points="' + xy.join(' ') + '"/>';
  $('spark').setAttribute('aria-label', 'p95 response time over the last 5 minutes, peak ' + fmtMs(max));
}
async function loadHealth() {
  if (document.hidden) return;
  try {
    const h = await (await fetch('/healthz')).json();
    const w = h.window;
    $('h-uptime').textContent = fmtUptime(h.uptimeSeconds);
    $('h-rate').textContent = w.perMinute;
    $('h-p50').textContent = fmtMs(w.p50Ms);
    $('h-p95').textContent = fmtMs(w.p95Ms);
    $('h-max').textContent = fmtMs(w.maxMs);
    $('h-errors').textContent = w.clientErrors + ' / ' + w.serverErrors;
    $('h-errors').className = 'v' + (w.serverErrors ? ' bad' : w.clientErrors ? ' warn' : '');
    $('h-limited').textContent = w.rateLimited;
    $('h-limited').className = 'v' + (w.rateLimited ? ' warn' : '');
    spark(h.timeline);
    $('h-slow').innerHTML = h.mostCalled.length
      ? h.mostCalled.map((s) => '<tr><td><button type="button" data-op="' + escHtml(s.op) + '">' + escHtml(s.op) + '</button></td><td class="n">' + s.calls + (s.calls === 1 ? ' call' : ' calls') + '</td><td class="n">' + fmtMs(s.avgMs) + ' avg</td></tr>').join('')
      : '<tr><td class="note">No API calls in the last 5 minutes.</td></tr>';
  } catch {}
}
$('h-slow').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-op]');
  if (!b) return;
  filterEl.value = b.dataset.op;
  applyFilter();
  filterEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
loadHealth();
setInterval(loadHealth, 5000);
document.addEventListener('visibilitychange', loadHealth);

// Open the request named in the link, if any.
const fromHash = decodeURIComponent(location.hash.slice(1));
const m = /^(GET|POST|PUT|DELETE) (.+)$/.exec(fromHash);
if (m && [...methodEl.options].some((o) => o.value === m[1])) {
  const known = data.endpoints.find((r) => r[0] === m[1] && r[2] === m[2]);
  load(m[1], m[2], known ? known[5] : '');
} else refresh();
`;
