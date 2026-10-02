// The page served at `/`: what the emulator contains and a small request explorer.

import { sampleUrl } from './samples.js';
import { schemaOf } from './validate.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ORDER = ['GET', 'POST', 'PUT', 'DELETE'];
const BLANK = { string: '', integer: 0, number: 0, boolean: false, array: [], object: {} };

// A starting body for the explorer: the operation's required fields, empty.
function bodyTemplate(op) {
  const schema = schemaOf(op);
  if (!schema) return '';
  const body = Object.fromEntries((schema.required || []).map((k) => [k, BLANK[schema.properties?.[k]?.type] ?? '']));
  return JSON.stringify(body, null, 2);
}

export function landingPage(world, routes, { apiKey, readOnly, now, version }) {
  const groups = { Organizations: [], Networks: [], Devices: [] };
  // Writes borrow the example IDs of the GET on the same path.
  const gets = new Map(routes.filter((r) => r.method === 'GET').map((r) => [r.path, r]));
  const example = (r) => {
    if (r.method === 'GET') return sampleUrl(r, world, now);
    const { query, status, ...ids } = r.sample ?? gets.get(r.path)?.sample ?? {};
    return sampleUrl({ ...r, sample: ids }, world, now);
  };
  const listed = readOnly ? routes.filter((r) => r.method === 'GET') : routes;
  for (const r of [...listed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : ORDER.indexOf(a.method) - ORDER.indexOf(b.method)))) {
    const g = r.path.startsWith('/organizations') ? 'Organizations' : r.path.startsWith('/networks') ? 'Networks' : 'Devices';
    groups[g].push(r);
  }
  const orgRows = world.orgs
    .map(
      (o) => `
      <section class="org">
        <h3>${esc(o.name)} <code>${esc(o.id)}</code></h3>
        <table>
          <thead><tr><th>Network</th><th>ID</th><th>Products</th><th class="n">Devices</th><th class="n">Clients</th></tr></thead>
          <tbody>${o.networks
            .map((n) => `<tr><td>${esc(n.name)}</td><td><code>${esc(n.id)}</code></td><td>${esc(n.productTypes.join(', '))}</td><td class="n">${n.devices.length}</td><td class="n">${n.clients.length}</td></tr>`)
            .join('')}</tbody>
        </table>
      </section>`,
    )
    .join('');
  const endpointLists = Object.entries(groups)
    .map(
      ([name, list]) => `
      <h3>${name} <span class="count">${list.length}</span></h3>
      <ul class="endpoints">${list
        .map(
          (r) =>
            `<li data-search="${esc(`${r.method} ${r.path} ${r.op}`.toLowerCase())}"><button type="button" data-method="${r.method}" data-path="${esc(example(r))}" data-body="${esc(bodyTemplate(r.op))}"><span class="verb ${r.method.toLowerCase()}">${r.method}</span> ${esc(r.path)}<span class="op">${esc(r.op)}</span></button></li>`,
        )
        .join('')}</ul>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meraki API Emulator</title>
<style>
:root {
  --bg: #f7f8fa; --panel: #ffffff; --text: #1d2330; --muted: #5d6677; --border: #dde1e8;
  --accent: #0b7a53; --accent-soft: #e3f3ec; --code: #eef1f5; --bad: #b42318; --post: #1d4ed8; --put: #a15c07;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #11151c; --panel: #181e27; --text: #e4e8ef; --muted: #98a2b3; --border: #2a3240;
    --accent: #3ccf95; --accent-soft: #173327; --code: #202835; --bad: #f97066; --post: #7aa7ff; --put: #f2b766;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 64px; }
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
.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 20px; align-items: start; }
.endpoints { list-style: none; padding: 0; margin: 0; }
.endpoints button { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: 100%; padding: 3px 6px; border-radius: 5px; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.endpoints button:hover, .endpoints button:focus-visible { background: var(--accent-soft); }
.verb { display: inline-block; min-width: 52px; color: var(--accent); font-weight: 700; }
.verb.post { color: var(--post); }
.verb.put { color: var(--put); }
.verb.delete { color: var(--bad); }
.op { display: block; color: var(--muted); font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding-left: 52px; }
.count { color: var(--muted); font-weight: 400; }
.endpoints li[hidden] { display: none; }
#filter { margin-bottom: 4px; }
.endpoint-list { max-height: 75vh; overflow-x: hidden; overflow-y: auto; }
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
.note { font-size: 13px; color: var(--muted); }
@media (max-width: 820px) { .grid { grid-template-columns: minmax(0, 1fr); } .explorer { position: static; } }
</style>
</head>
<body>
<main>
  <h1>Meraki API Emulator <span class="version">v${esc(version)}</span></h1>
  <p class="lede">A local stand-in for the Cisco Meraki Dashboard API v1, serving simulated organizations, networks, devices and client traffic. Not affiliated with or endorsed by Cisco.</p>

  <div class="panel">
    <p>Base URL <code id="base">/api/v1</code>. Send a key in <code>X-Cisco-Meraki-API-Key</code> or <code>Authorization: Bearer</code>. ${apiKey ? 'This server only accepts the key it was started with.' : 'Any non-empty key is accepted.'}</p>
    <pre id="curl"></pre>
    <p class="note">Data is generated from the seed and the clock, so the same seed and time always give the same answer. Link headers use unquoted <code>rel=next</code>, the same as the real API. Every call you make is logged, so <code>/organizations/{organizationId}/apiRequests</code> shows what your client actually sent.</p>
    <p class="note">${readOnly ? 'This server is read-only, so PUT, POST and DELETE answer 405.' : 'Writes change the emulator\'s configuration in memory and show up in the change log. <code>POST /_emulator/reset</code> puts everything back.'}</p>
  </div>

  <h2>Organizations and networks</h2>
  <div class="panel">${orgRows}</div>

  <h2>Endpoints</h2>
  <div class="grid">
    <div class="panel">
      <label for="filter">Filter by path or operation ID</label>
      <input id="filter" type="search" spellcheck="false" placeholder="e.g. vlans or getOrganizationDevices">
      <div class="endpoint-list">${endpointLists}</div>
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
      <div id="status">Pick an endpoint or edit the path, then send.</div>
      <div id="link"></div>
      <pre id="body"></pre>
    </div>
  </div>
</main>
<script>
const base = location.origin + '/api/v1';
document.getElementById('base').textContent = base;
document.getElementById('curl').textContent = "curl -H 'X-Cisco-Meraki-API-Key: ${apiKey ? '<your key>' : 'demo-key'}' " + base + '/organizations';
const form = document.getElementById('try');
const pathEl = document.getElementById('path');
const statusEl = document.getElementById('status');
const bodyEl = document.getElementById('body');
const linkEl = document.getElementById('link');
const methodEl = document.getElementById('method');
const requestEl = document.getElementById('request');
const payloadEl = document.getElementById('payload');
const showPayload = () => { payloadEl.hidden = methodEl.value !== 'PUT' && methodEl.value !== 'POST'; };
methodEl.addEventListener('change', showPayload);

async function send() {
  const path = pathEl.value.trim();
  const url = /^https?:/.test(path) ? path : base + (path.startsWith('/') ? path : '/' + path);
  const method = methodEl.value;
  const init = { method, headers: { 'X-Cisco-Meraki-API-Key': document.getElementById('key').value } };
  if (method === 'PUT' || method === 'POST') {
    init.headers['Content-Type'] = 'application/json';
    init.body = requestEl.value || '{}';
  }
  statusEl.className = '';
  statusEl.textContent = 'Loading...';
  linkEl.textContent = '';
  const t = performance.now();
  try {
    const res = await fetch(url, init);
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
      const m = /^<([^>]+)>; rel=(\\w+)$/.exec(l);
      return m ? '<a href="#" data-url="' + m[1].replace(/"/g, '&quot;') + '">' + m[2] + '</a>' : '';
    }).join(' ');
    bodyEl.textContent = pretty;
  } catch (e) {
    statusEl.className = 'bad';
    statusEl.textContent = String(e);
  }
}

form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
// Reads run straight away; writes wait for Send, since they change the emulator.
document.querySelectorAll('.endpoints button').forEach((b) => b.addEventListener('click', () => {
  pathEl.value = b.dataset.path;
  methodEl.value = b.dataset.method;
  requestEl.value = b.dataset.body;
  showPayload();
  if (b.dataset.method === 'GET') send();
  else {
    statusEl.className = '';
    statusEl.textContent = 'Fill in the path and body, then press Send.';
    bodyEl.textContent = '';
    linkEl.textContent = '';
  }
}));
document.getElementById('filter').addEventListener('input', (e) => {
  const words = e.target.value.toLowerCase().split(/\\s+/).filter(Boolean);
  document.querySelectorAll('.endpoints li').forEach((li) => { li.hidden = !words.every((w) => li.dataset.search.includes(w)); });
  document.querySelectorAll('.endpoints').forEach((ul) => {
    const shown = ul.querySelectorAll('li:not([hidden])').length;
    ul.previousElementSibling.hidden = !shown;
    ul.previousElementSibling.querySelector('.count').textContent = shown;
  });
});
linkEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  pathEl.value = a.dataset.url.replace(base, '');
  methodEl.value = 'GET';
  showPayload();
  send();
});
</script>
</body>
</html>`;
}
