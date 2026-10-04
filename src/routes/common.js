import { L7_CATEGORIES } from '../catalog.js';
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

// The network in the path, refusing one without the product.
export function productNet(ctx, productType) {
  const net = netOf(ctx);
  requireProduct(net, productType);
  return net;
}

export const mxNet = (ctx) => productNet(ctx, 'appliance');
export const switchNet = (ctx) => productNet(ctx, 'switch');

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

// An ID counting up from a seeded start `digits` long, so creation order is ID
// order, for stores whose IDs are short numbers.
export function countingId(ctx, store, kind, parentId, digits) {
  const low = 10 ** (digits - 1);
  const start = new Rand(hashStr(`meraki-api-emulator:${ctx.world.seed}:${kind}:${parentId}`)).int(low, 9 * low - 1);
  return String(start + ++store.created);
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

// L7 firewall rules from a body, for MX and SSID rules alike. The spec types
// `value` as a string, but it's an object for applications and categories and
// a list of country codes for the country types. A bare ID is taken for an
// application too, and names come from the category list.
const L7_NAMES = new Map(L7_CATEGORIES.flatMap((c) => [[c.id, c.name], ...c.applications.map((a) => [a.id, a.name])]));
const COUNTRY_TYPES = ['allowedCountries', 'blockedCountries', 'whitelistedCountries', 'blacklistedCountries'];

export function l7Rules(rules) {
  return rules.map((r, i) => {
    const at = `rules[${i}]`;
    if (r.type == null) throw badRequest(`'${at}.type' is required`);
    let value = r.value;
    if (r.type === 'application' || r.type === 'applicationCategory') {
      const kind = r.type === 'application' ? 'application' : 'category';
      const id = typeof value === 'string' ? value : value?.id;
      if (typeof id !== 'string' || !new RegExp(`^meraki:layer7/${kind}/\\d+$`).test(id)) throw badRequest(`'${at}.value' must be an object with the ID of an ${r.type === 'application' ? 'application' : 'application category'}, like meraki:layer7/${kind}/1`);
      value = { id, name: L7_NAMES.get(id) ?? (typeof value?.name === 'string' ? value.name : null) };
    } else if (COUNTRY_TYPES.includes(r.type)) {
      if (!Array.isArray(value) || !value.length || !value.every((c) => /^[A-Za-z]{2}$/.test(c))) throw badRequest(`'${at}.value' must be a list of two-letter country codes`);
      value = value.map((c) => c.toUpperCase());
    } else {
      if (typeof value === 'number') value = String(value);
      if (typeof value !== 'string') throw badRequest(`'${at}.value' must be a string`);
    }
    return { policy: r.policy ?? 'deny', type: r.type, value };
  });
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
//   check     (ctx, parent, body, self) => other body checks; self is null on
//             create. What it returns goes to apply as `checked`
//   blank     (ctx, parent) => a new item's fields before the body is applied
//   apply     (item, body, parent, ctx, checked) => copies the body onto an
//             item, which already has its ID
//   json      (item, parent, ctx) => the item as the API returns it
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
    return c.check?.(ctx, parent, b, self);
  };
  const handlers = {
    list: (ctx) => {
      const { parent, store } = storeOf(ctx);
      return store.list.map((x) => c.json(x, parent, ctx));
    },
    create: (ctx) => {
      const { parent, store } = storeOf(ctx);
      const b = ctx.body;
      if (store.list.length >= c.max) throw badRequest(`${parents} are limited to ${c.max} ${plural} in the emulator`);
      for (const k of c.required ?? []) if (b[k] == null) throw badRequest(`'${k}' is required`);
      const checked = checkBody(ctx, parent, store, b, null);
      const x = { [key]: c.nextId ? c.nextId(ctx, store, parent) : newId(ctx, store, c.kind, parent.id, key), ...c.blank(ctx, parent) };
      c.apply(x, b, parent, ctx, checked);
      store.list.push(x);
      return c.json(x, parent, ctx);
    },
    get: (ctx) => {
      const { parent, item: x } = find(ctx);
      return c.json(x, parent, ctx);
    },
    update: (ctx) => {
      const { parent, store, item: x } = find(ctx);
      const checked = checkBody(ctx, parent, store, ctx.body, x);
      c.apply(x, ctx.body, parent, ctx, checked);
      return c.json(x, parent, ctx);
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
