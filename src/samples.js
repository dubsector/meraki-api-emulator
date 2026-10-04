// A working example URL for each route, using HQ's IDs. Routes can pick the
// organization or device kind (or a function giving the serial), fill other
// path params (a value or a function of the world and clock) or add a query
// through `sample`.

export function sampleUrl(route, world, now) {
  const { serial: kind, query, org: orgIndex = 0, status, ...ids } = route.sample || {};
  const org = world.orgs[orgIndex];
  const net = org.networks[0];
  const p = route.path;
  const guess = p.includes('/switch/') ? 'switch' : p.includes('/appliance/') || p.includes('lossAndLatency') ? 'appliance' : p.includes('/camera/') ? 'camera' : 'wireless';
  const device = { appliance: net.mx, switch: net.switches[0], wireless: net.aps[0], camera: net.cameras[0], sensor: net.devices.find((d) => d.productType === 'sensor'), cellularGateway: org.devices.find((d) => d.productType === 'cellularGateway'), campusGateway: org.devices.find((d) => d.productType === 'campusGateway'), wirelessController: org.devices.find((d) => d.productType === 'wirelessController') }[kind || guess];
  const serial = typeof kind === 'function' ? kind(world, now) : device?.serial;
  const values = { organizationId: org.id, networkId: net.id, clientId: net.clients[0].id, serial };
  for (const [k, v] of Object.entries(ids)) values[k] = typeof v === 'function' ? v(world, now) : v;
  const url = p.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(values[n] ?? `{${n}}`));
  const q = typeof query === 'function' ? query(world, now) : query;
  return q ? `${url}?${q}` : url;
}
