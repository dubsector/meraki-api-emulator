// The page served at `/`: what the emulator contains and a small request explorer.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function samples(world) {
  const org = world.orgs[0];
  const net = org.networks[0];
  return {
    organizationId: org.id,
    networkId: net.id,
    clientId: net.clients[0].id,
    number: '0',
    appliance: net.mx.serial,
    switch: net.switches[0].serial,
    wireless: net.aps[0].serial,
  };
}

function exampleFor(path, s) {
  let serial = s.wireless;
  if (path.includes('/switch/')) serial = s.switch;
  else if (path.includes('/appliance/') || path.includes('lossAndLatency')) serial = s.appliance;
  let url = path.replace(/\{(\w+)\}/g, (_, n) => (n === 'serial' ? serial : s[n] ?? `{${n}}`));
  if (path.endsWith('/events')) url += '?productType=wireless&perPage=20';
  else if (path.endsWith('lossAndLatencyHistory')) url += '?ip=8.8.8.8&timespan=3600';
  else if (path.endsWith('clientCountHistory') || path.endsWith('wireless/usageHistory')) url += '?timespan=86400&resolution=3600';
  return url;
}

export function landingPage(world, routes, { apiKey }) {
  const s = samples(world);
  const groups = { Organizations: [], Networks: [], Devices: [] };
  for (const r of routes) {
    const g = r.path.startsWith('/organizations') ? 'Organizations' : r.path.startsWith('/networks') ? 'Networks' : 'Devices';
    groups[g].push(r.path);
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
      ([name, paths]) => `
      <h3>${name}</h3>
      <ul class="endpoints">${paths.map((p) => `<li><button type="button" data-path="${esc(exampleFor(p, s))}"><span class="verb">GET</span> ${esc(p)}</button></li>`).join('')}</ul>`,
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
  --accent: #0b7a53; --accent-soft: #e3f3ec; --code: #eef1f5; --bad: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #11151c; --panel: #181e27; --text: #e4e8ef; --muted: #98a2b3; --border: #2a3240;
    --accent: #3ccf95; --accent-soft: #173327; --code: #202835; --bad: #f97066;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 4px; }
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
.endpoints button { all: unset; cursor: pointer; display: block; width: 100%; padding: 3px 6px; border-radius: 5px; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; }
.endpoints button:hover, .endpoints button:focus-visible { background: var(--accent-soft); }
.verb { color: var(--accent); font-weight: 700; margin-right: 4px; }
.explorer { position: sticky; top: 16px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
input { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
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
  <h1>Meraki API Emulator</h1>
  <p class="lede">A local stand-in for the Cisco Meraki Dashboard API v1, serving simulated organizations, networks, devices and client traffic. Not affiliated with or endorsed by Cisco.</p>

  <div class="panel">
    <p>Base URL <code id="base">/api/v1</code>. Send a key in <code>X-Cisco-Meraki-API-Key</code> or <code>Authorization: Bearer</code>. ${apiKey ? 'This server only accepts the key it was started with.' : 'Any non-empty key is accepted.'}</p>
    <pre id="curl"></pre>
    <p class="note">Data is generated from the seed and the clock, so the same seed and time always give the same answer. Link headers use unquoted <code>rel=next</code>, the same as the real API.</p>
  </div>

  <h2>Organizations and networks</h2>
  <div class="panel">${orgRows}</div>

  <h2>Endpoints</h2>
  <div class="grid">
    <div class="panel">${endpointLists}</div>
    <div class="panel explorer">
      <form id="try">
        <label for="key">API key</label>
        <input id="key" autocomplete="off" spellcheck="false" value="${apiKey ? '' : 'demo-key'}" placeholder="API key">
        <label for="path">Path</label>
        <div class="row">
          <input id="path" spellcheck="false" value="/organizations">
          <button class="send" type="submit">Send</button>
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
document.getElementById('curl').textContent = "curl -H 'X-Cisco-Meraki-API-Key: demo-key' " + base + '/organizations';
const form = document.getElementById('try');
const pathEl = document.getElementById('path');
const statusEl = document.getElementById('status');
const bodyEl = document.getElementById('body');
const linkEl = document.getElementById('link');

async function send() {
  const path = pathEl.value.trim();
  const url = /^https?:/.test(path) ? path : base + (path.startsWith('/') ? path : '/' + path);
  statusEl.className = '';
  statusEl.textContent = 'Loading...';
  linkEl.textContent = '';
  const t = performance.now();
  try {
    const res = await fetch(url, { headers: { 'X-Cisco-Meraki-API-Key': document.getElementById('key').value } });
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
document.querySelectorAll('.endpoints button').forEach((b) => b.addEventListener('click', () => { pathEl.value = b.dataset.path; send(); }));
linkEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  pathEl.value = a.dataset.url.replace(base, '');
  send();
});
</script>
</body>
</html>`;
}
