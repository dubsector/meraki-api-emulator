import { sampleUrl } from '../src/samples.js';
import { ROUTES, createEmulator } from '../src/server.js';

export const NOW = '2026-09-29T18:30:00Z';

// Starts an emulator on a free port. Rate limiting is off unless a test asks for it.
export async function start(options = {}) {
  const sb = createEmulator({ now: NOW, rateLimit: 0, ...options });
  await new Promise((resolve) => sb.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${sb.server.address().port}/api/v1`;
  const get = async (path, { key = 'test-key', headers = {}, method = 'GET', body } = {}) => {
    const h = { ...headers };
    if (key != null) h['X-Cisco-Meraki-API-Key'] = key;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const res = await fetch(path.startsWith('http') ? path : base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, link: res.headers.get('link'), body: parsed };
  };
  const send = (method) => (path, body, opts = {}) => get(path, { ...opts, method, body });
  return {
    // A getter, so tests see the new world after a reset.
    get world() {
      return sb.world;
    },
    server: sb.server,
    apiLog: sb.apiLog,
    base,
    get,
    put: send('PUT'),
    post: send('POST'),
    del: (path, opts = {}) => get(path, { ...opts, method: 'DELETE' }),
    reset: () => fetch(base.replace('/api/v1', '/_emulator/reset'), { method: 'POST', headers: { 'X-Cisco-Meraki-API-Key': 'test-key' } }),
    close: () => new Promise((r) => sb.server.close(r)),
  };
}

export function relLink(link, rel) {
  const m = new RegExp(`<([^>]+)>; rel=${rel}(?:,|$)`).exec(link || '');
  return m ? m[1] : null;
}

// Follows rel=next like a Dashboard API client and returns every item.
export async function collect(get, path, maxPages = 200) {
  const items = [];
  let url = path;
  for (let i = 0; url && i < maxPages; i++) {
    const r = await get(url);
    if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
    items.push(...r.body);
    url = relLink(r.link, 'next');
  }
  return items;
}

// A concrete URL for each route, using IDs from HQ.
export function sampleUrls(world) {
  return ROUTES.filter((r) => r.method === 'GET').map((r) => ({ url: sampleUrl(r, world, Date.parse(NOW) / 1000), status: r.sample?.status ?? r.status ?? 200 }));
}
