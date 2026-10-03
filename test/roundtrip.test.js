import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ROUTES } from '../src/server.js';
import { NOW, start } from './helpers.js';

// PUTs that can't take back what their GET answers, and why.
const REFUSED = {
  updateNetworkFirmwareUpgradesStagedEvents: 'no network starts with a staged upgrade event to change',
  updateNetworkWebhooksPayloadTemplate: 'the included payload templates can only be read',
  updateOrganizationWirelessMqttSettings: 'the GET lists every network and a PUT names one',
  updateNetworkApplianceContentFiltering: 'a PUT takes category IDs and the GET names each category',
};

let sb;
before(async () => (sb = await start()));
after(() => sb.close());

// Every path with a GET and a PUT, for every organization, network and device
// it can name. Other path parameters come from the route's sample.
test('an object read with GET can be sent back with PUT on every path', async () => {
  const now = Date.parse(NOW) / 1000;
  const byPath = new Map();
  for (const r of ROUTES) byPath.set(r.path, { ...byPath.get(r.path), [r.method]: r });
  const w = sb.world;
  const refused = [];
  let sent = 0;
  for (const { GET: get, PUT: put } of byPath.values()) {
    if (!get || !put) continue;
    const { serial: _serial, query: _query, org: _org, status: _status, ...ids } = get.sample ?? {};
    const scopes = get.path.includes('{serial}')
      ? w.networks.flatMap((net) => net.devices.map((d) => ({ net, serial: d.serial })))
      : get.path.includes('{networkId}')
        ? w.networks.map((net) => ({ net }))
        : w.orgs.map((org) => ({ org, net: org.networks[0] }));
    for (const { net, org = net.org, serial } of scopes) {
      const values = { organizationId: org.id, networkId: net?.id, serial, clientId: net?.clients[0]?.id };
      for (const [k, v] of Object.entries(ids)) values[k] = typeof v === 'function' ? v(w, now) : v;
      const path = get.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(values[k]));
      const read = await sb.get(path);
      if (read.status !== 200 || typeof read.body !== 'object' || Array.isArray(read.body)) continue;
      const r = await sb.put(path, read.body);
      sent++;
      if (r.status !== 200 && !REFUSED[put.op]) refused.push(`${put.op} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  assert.ok(sent > 500, `only ${sent} round trips`);
  assert.deepEqual(refused, []);
});
