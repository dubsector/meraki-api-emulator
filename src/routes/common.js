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

// A { created, list } store of named items with the usual routes: list, create,
// get, update and delete. Every check runs before anything changes, so a refused
// write leaves the store as it was. Options:
//   ops       { list, create, get, update, delete }: the op IDs; leave one out to
//             write that route by hand
//   path      the collection's path; `param` names the item's path parameter
//   parent    (ctx) => the network or organization, after its own checks
//   store     (parent) => its { created, list } store
//   what      the item in messages ('MQTT broker'); `plural` if not what + 's'
//   kind      the newId kind; `key` the items' ID field (default 'id')
//   nextId    (ctx, store, parent) => a new item's ID, in place of newId
//   max       the most items a parent can hold
//   required  body fields a create must have (null counts as missing)
//   unique    false when names may repeat; `scope` is 'network' or 'organization'
//   check     (ctx, parent, body, self) => other body checks; self is null on create
//   blank     (ctx, parent) => a new item's fields before the body is applied
//   apply     (item, body, parent, ctx) => copies the body onto an item, which
//             already has its ID
//   json      (item, parent) => the item as the API returns it
//   inUse     (item, parent) => why it can't be deleted, or nothing
//   missing   the get route's sample (an unknown ID and status 404)
export function collection(c) {
  const { what, key = 'id', scope = 'network' } = c;
  const plural = c.plural ?? `${what}s`;
  const item = `${c.path}/{${c.param}}`;
  const parents = scope === 'network' ? 'Networks' : 'Organizations';
  const storeOf = (ctx) => {
    const parent = c.parent(ctx);
    return { parent, store: c.store(parent) };
  };
  const find = (ctx) => {
    const { parent, store } = storeOf(ctx);
    const found = store.list.find((x) => x[key] === ctx.params[c.param]);
    if (!found) throw notFound(what[0].toUpperCase() + what.slice(1));
    return { parent, store, item: found };
  };
  const checkBody = (ctx, parent, store, b, self) => {
    if (c.unique !== false && b.name != null) {
      if (!b.name.trim()) throw badRequest("'name' must not be empty");
      if (store.list.some((x) => x !== self && x.name === b.name)) throw badRequest(`${/^[aeiou]/i.test(what) ? 'An' : 'A'} ${what} named '${b.name}' already exists in this ${scope}`);
    }
    c.check?.(ctx, parent, b, self);
  };
  const handlers = {
    list: (ctx) => {
      const { parent, store } = storeOf(ctx);
      return store.list.map((x) => c.json(x, parent));
    },
    create: (ctx) => {
      const { parent, store } = storeOf(ctx);
      const b = ctx.body;
      if (store.list.length >= c.max) throw badRequest(`${parents} are limited to ${c.max} ${plural} in the emulator`);
      for (const k of c.required ?? []) if (b[k] == null) throw badRequest(`'${k}' is required`);
      checkBody(ctx, parent, store, b, null);
      const x = { [key]: c.nextId ? c.nextId(ctx, store, parent) : newId(ctx, store, c.kind, parent.id, key), ...c.blank(ctx, parent) };
      c.apply(x, b, parent, ctx);
      store.list.push(x);
      return c.json(x, parent);
    },
    get: (ctx) => {
      const { parent, item: x } = find(ctx);
      return c.json(x, parent);
    },
    update: (ctx) => {
      const { parent, store, item: x } = find(ctx);
      checkBody(ctx, parent, store, ctx.body, x);
      c.apply(x, ctx.body, parent, ctx);
      return c.json(x, parent);
    },
    delete: (ctx) => {
      const { parent, store, item: x } = find(ctx);
      const reason = c.inUse?.(x, parent);
      if (reason) throw badRequest(reason);
      store.list.splice(store.list.indexOf(x), 1);
    },
  };
  const shape = { list: ['GET', c.path], create: ['POST', c.path], get: ['GET', item], update: ['PUT', item], delete: ['DELETE', item] };
  const routes = Object.entries(c.ops).map(([name, op]) => {
    const [method, path] = shape[name];
    return { op, method, path, handler: handlers[name], ...(name === 'get' && c.missing ? { sample: c.missing } : {}) };
  });
  return { routes, find, storeOf };
}
