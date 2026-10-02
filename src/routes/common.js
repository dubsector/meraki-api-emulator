import { ApiError, arrayParam, badRequest, hasTags, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';

export function orgOf(ctx) {
  const org = ctx.world.orgById.get(ctx.params.organizationId);
  if (!org) throw notFound('Organization');
  return org;
}

export function netOf(ctx) {
  const net = ctx.world.networkById.get(ctx.params.networkId);
  if (!net) throw notFound('Network');
  return net;
}

export function devOf(ctx) {
  const dev = ctx.world.deviceBySerial.get(ctx.params.serial);
  if (!dev) throw notFound('Device');
  return dev;
}

// A client by its ID, MAC or IP.
export function findClient(net, id) {
  const lower = id.toLowerCase();
  return net.clients.find((c) => c.id === id || c.mac === lower || c.ip === id);
}

export function requireProduct(net, productType) {
  if (!net.productTypes.includes(productType)) throw badRequest(`This endpoint requires a network with product type '${productType}'`);
}

export function mxNet(ctx) {
  const net = netOf(ctx);
  requireProduct(net, 'appliance');
  return net;
}

// The organization's networks with an MX, by ID, for the org byNetwork reads.
export const mxNets = (org, ids) => org.networks.filter((n) => n.productTypes.includes('appliance') && (!ids.length || ids.includes(n.id))).sort(byId);

export function limit(list, max, what) {
  if (list.length > max) throw badRequest(`${what} are limited to ${max} in the emulator`);
  return list;
}

// An 18 digit ID for a new item in a { created, list } store. The counter never
// goes down, so a deleted item's ID isn't handed out again. `key` names the
// items' ID field.
export function newId(ctx, store, kind, parentId, key = 'id') {
  store.created++;
  const r = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${parentId}:${store.created}`));
  let id;
  do id = r.digits(18);
  while (store.list.some((x) => x[key] === id));
  return id;
}

export function requireModel(dev, productType) {
  if (dev.productType !== productType) throw new ApiError(400, [`This endpoint is only supported for ${productType} devices`]);
}

// Shared device filters used across the organization endpoints.
export function filterDevices(q, devices) {
  const networkIds = arrayParam(q, 'networkIds');
  const productTypes = arrayParam(q, 'productTypes');
  const serials = arrayParam(q, 'serials');
  const models = arrayParam(q, 'models');
  const macs = arrayParam(q, 'macs').map((m) => m.toLowerCase());
  const tags = arrayParam(q, 'tags');
  const mode = q.get('tagsFilterType') || 'withAnyTags';
  const name = q.get('name');
  const mac = q.get('mac')?.toLowerCase();
  const serial = q.get('serial')?.toUpperCase();
  const model = q.get('model');
  return devices.filter(
    (d) =>
      (!networkIds.length || networkIds.includes(d.net.id)) &&
      (!productTypes.length || productTypes.includes(d.productType)) &&
      (!serials.length || serials.includes(d.serial)) &&
      (!models.length || models.includes(d.model)) &&
      (!macs.length || macs.includes(d.mac)) &&
      hasTags(d.tags, tags, mode) &&
      (!name || (d.name ?? '').includes(name)) &&
      (!mac || d.mac.includes(mac)) &&
      (!serial || d.serial.includes(serial)) &&
      (!model || d.model.includes(model)),
  );
}

export const bySerial = (a, b) => (a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0);
export const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
