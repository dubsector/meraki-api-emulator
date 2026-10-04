// MG eSIMs: the inventory, service provider accounts and their plans, and
// profile swaps. Each eSIM's state lives on its device, so moves keep it and
// a hardware swap starts over; the accounts are an organization store.

import { deviceUrl } from '../format.js';
import { arrayParam, badRequest, notFound } from '../http.js';
import { ESIM_PROVIDERS, communicationPlans, eidOf, esimOf, esimProfile, esimProfileNow, isGateway, primarySlot, providerOf, ratePlans } from '../sim/cellular.js';
import { deviceStatus } from '../sim/outages.js';
import { iso } from '../time.js';
import { orgOf } from './common.js';

const BASE = '/organizations/{organizationId}/cellularGateway/esims';
const STATUSES = ['activated', 'deactivated'];
// How long a profile swap takes on a running clock.
const SWAP_SECONDS = 90;
const MAX_ACCOUNTS = 100;

const everything = (items) => ({ items, meta: { counts: { items: { total: items.length, remaining: 0 } } } });
const slugOf = (p) => p.provider.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const logoOf = (p) => ({ url: `https://n1.meraki.com/images/esim/providers/${slugOf(p)}.png` });

// Devices with an eSIM in the organization's networks.
const esimDevices = (org) => org.devices.filter((d) => isGateway(d) && d.info.esim && d.net);

function esimById(ctx) {
  const dev = esimDevices(orgOf(ctx)).find((d) => eidOf(d) === ctx.params.id);
  if (!dev) throw notFound('eSIM');
  return dev;
}

// Stores the eSIM as it reads now, so a finished swap stays applied.
function settle(dev, now) {
  dev.esim = structuredClone(esimOf(dev, now));
  return dev.esim;
}

function esimJson(dev, now) {
  const e = esimOf(dev, now);
  return {
    device: { name: dev.name, model: dev.model.toLowerCase(), serial: dev.serial, url: deviceUrl(dev), status: deviceStatus(dev, now) },
    active: e.status === 'activated' && primarySlot(dev) === dev.info.esim,
    eid: eidOf(dev),
    lastUpdatedAt: iso(e.updatedAt),
    network: { id: dev.net.id },
    profiles: e.profiles.map((p) => ({
      customApns: [...p.apns],
      iccid: p.iccid,
      status: p.iccid !== e.current ? 'disabled' : e.status,
      serviceProvider: { name: p.carrier.provider, plans: p.plans.map((x) => ({ ...x })) },
    })),
  };
}

function updateEsim(ctx) {
  const dev = esimById(ctx);
  const status = ctx.body.status;
  if (!STATUSES.includes(status)) throw badRequest(`'status' must be one of: ${STATUSES.join(', ')}`);
  if (status === 'deactivated' && primarySlot(dev) === dev.info.esim) throw badRequest(`The eSIM in ${dev.info.esim} is ${dev.name ?? dev.serial}'s primary SIM; make another SIM primary first`);
  const e = settle(dev, ctx.now);
  if (e.status !== status) Object.assign(e, { status, updatedAt: ctx.now });
  return esimJson(dev, ctx.now);
}

// ── Service provider accounts ──

const accountsOf = (org) => org.esimAccounts?.list ?? [];

function accountJson(a) {
  const p = providerOf(a.provider);
  return { accountId: a.accountId, lastUpdatedAt: iso(a.updatedAt), serviceProvider: { name: p.provider, logo: logoOf(p) }, title: a.title, username: a.username };
}

function accountOf(ctx) {
  const a = accountsOf(orgOf(ctx)).find((x) => x.accountId === ctx.params.accountId);
  if (!a) throw notFound('Service provider account');
  return a;
}

const text = (v, at) => {
  if (typeof v !== 'string' || !v.trim()) throw badRequest(`'${at}' must not be empty`);
  return v;
};

function createAccount(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const accountId = text(b.accountId, 'accountId');
  const fields = { apiKey: text(b.apiKey, 'apiKey'), title: text(b.title, 'title'), username: text(b.username, 'username') };
  const p = providerOf(b.serviceProvider?.name);
  if (!p || p.bootstrap) throw badRequest(`'serviceProvider.name' must be one of: ${ESIM_PROVIDERS.filter((x) => !x.bootstrap).map((x) => x.provider).join(', ')}`);
  const store = (org.esimAccounts ??= { list: [] });
  if (store.list.some((a) => a.accountId === accountId)) throw badRequest(`Service provider account ${accountId} has already been added`);
  if (store.list.length >= MAX_ACCOUNTS) throw badRequest(`An organization can have at most ${MAX_ACCOUNTS} service provider accounts`);
  const a = { accountId, provider: p.provider, ...fields, updatedAt: ctx.now };
  store.list.push(a);
  return accountJson(a);
}

function updateAccount(ctx) {
  const a = accountOf(ctx);
  const b = ctx.body;
  const next = {};
  if (b.title != null) next.title = text(b.title, 'title');
  if (b.apiKey != null) next.apiKey = text(b.apiKey, 'apiKey');
  Object.assign(a, next, { updatedAt: ctx.now });
  return accountJson(a);
}

function deleteAccount(ctx) {
  const a = accountOf(ctx);
  const store = orgOf(ctx).esimAccounts;
  store.list = store.list.filter((x) => x !== a);
}

// Plans for each account asked for, in the order given.
function plans(ctx, build) {
  const ids = arrayParam(ctx.query, 'accountIds');
  if (!ids.length) throw badRequest("'accountIds' is required");
  const accounts = accountsOf(orgOf(ctx));
  const rows = [...new Set(ids)].flatMap((id) => {
    const a = accounts.find((x) => x.accountId === id);
    if (!a) throw badRequest(`No service provider account with ID ${id} in this organization`);
    return build(providerOf(a.provider)).map((p) => ({ accountId: a.accountId, ...p }));
  });
  return everything(rows);
}

// ── Profile swaps ──

// Checks every swap before starting any. A target account the eSIM already
// uses keeps its profile and only changes the plans.
function createSwap(ctx) {
  const org = orgOf(ctx);
  const devices = esimDevices(org);
  const seen = new Set();
  const jobs = ctx.body.swaps.map((s, i) => {
    const at = `swaps[${i}]`;
    const dev = devices.find((d) => eidOf(d) === s.eid);
    if (!dev) throw badRequest(`'${at}.eid' ${s.eid} is not an eSIM in this organization`);
    if (seen.has(s.eid)) throw badRequest(`eSIM ${s.eid} is listed twice`);
    seen.add(s.eid);
    const e = esimOf(dev, ctx.now);
    if (e.swap && !e.swap.applied) throw badRequest(`eSIM ${s.eid} already has a profile swap in progress`);
    const t = s.target;
    if (t == null) throw badRequest(`'${at}.target' is required`);
    const a = accountsOf(org).find((x) => x.accountId === t.accountId);
    if (!a) throw badRequest(`'${at}.target.accountId' ${t.accountId} is not a service provider account in this organization`);
    const p = providerOf(a.provider);
    const comm = communicationPlans(p).find((x) => x.name === t.communicationPlan);
    if (!comm) throw badRequest(`'${at}.target.communicationPlan' must be one of ${a.provider}'s plans: ${communicationPlans(p).map((x) => x.name).join(', ')}`);
    const rate = ratePlans(p).find((x) => x.name === t.ratePlan);
    if (!rate) throw badRequest(`'${at}.target.ratePlan' must be one of ${a.provider}'s plans: ${ratePlans(p).map((x) => x.name).join(', ')}`);
    return { dev, a, p, comm, rate };
  });
  const out = jobs.map(({ dev, a, p, comm, rate }) => {
    const e = settle(dev, ctx.now);
    const held = e.profiles.find((x) => x.accountId === a.accountId);
    let profile;
    if (held) profile = { ...held, plans: [{ name: comm.name, type: 'communication' }, { name: rate.name, type: 'rate' }], apns: comm.apns.map((x) => x.name) };
    else profile = esimProfile(dev, (e.ids += 1), p, comm, rate, a.accountId);
    e.swap = { profile, start: ctx.now, end: ctx.frozen ? ctx.now : ctx.now + SWAP_SECONDS, applied: false };
    if (ctx.frozen) settle(dev, ctx.now);
    return swapJson(dev, ctx.now);
  });
  return out[0];
}

function swapJson(dev, now) {
  const s = esimOf(dev, now).swap;
  return { eid: eidOf(dev), iccid: s.profile.iccid, status: now < s.end ? 'In progress' : 'Completed' };
}

function swapStatus(ctx) {
  const dev = esimById(ctx);
  if (!esimOf(dev, ctx.now).swap) throw notFound('Profile swap');
  return swapJson(dev, ctx.now);
}

const LAB = 1;
const EID = (world) => eidOf(world.orgs[LAB].devices.find((d) => d.info?.esim));
const ACCOUNT = (world) => world.orgs[LAB].esimAccounts?.list[0]?.accountId ?? '0987654321';

export default [
  {
    op: 'getOrganizationCellularGatewayEsimsInventory',
    path: `${BASE}/inventory`,
    sample: { org: LAB },
    handler: (ctx) => {
      const eids = arrayParam(ctx.query, 'eids');
      const rows = esimDevices(orgOf(ctx))
        .map((d) => esimJson(d, ctx.now))
        .filter((r) => !eids.length || eids.includes(r.eid))
        .sort((x, y) => (x.eid < y.eid ? -1 : 1));
      return everything(rows);
    },
  },
  { op: 'updateOrganizationCellularGatewayEsimsInventory', method: 'PUT', path: `${BASE}/inventory/{id}`, sample: { org: LAB, id: EID }, handler: updateEsim },
  {
    op: 'getOrganizationCellularGatewayEsimsServiceProviders',
    path: `${BASE}/serviceProviders`,
    sample: { org: LAB },
    handler: (ctx) => {
      orgOf(ctx);
      return everything(ESIM_PROVIDERS.map((p) => ({ name: p.provider, logo: logoOf(p), isBootstrap: !!p.bootstrap, terms: { content: `https://n1.meraki.com/esim/terms/${slugOf(p)}`, name: `${p.provider} Terms and Conditions` } })));
    },
  },
  {
    op: 'getOrganizationCellularGatewayEsimsServiceProvidersAccounts',
    path: `${BASE}/serviceProviders/accounts`,
    sample: { org: LAB },
    handler: (ctx) => {
      // The filter is typed as integers, so 0123 and 123 name the same account.
      const ids = arrayParam(ctx.query, 'accountIds');
      const match = (id) => ids.some((x) => x === id || (/^\d+$/.test(x) && /^\d+$/.test(id) && BigInt(x) === BigInt(id)));
      return [everything(accountsOf(orgOf(ctx)).filter((a) => !ids.length || match(a.accountId)).map(accountJson))];
    },
  },
  { op: 'createOrganizationCellularGatewayEsimsServiceProvidersAccount', method: 'POST', path: `${BASE}/serviceProviders/accounts`, status: 200, sample: { org: LAB }, handler: createAccount },
  { op: 'getOrganizationCellularGatewayEsimsServiceProvidersAccountsCommunicationPlans', path: `${BASE}/serviceProviders/accounts/communicationPlans`, sample: { org: LAB, query: (world) => `accountIds[]=${ACCOUNT(world)}`, status: 400 }, handler: (ctx) => plans(ctx, communicationPlans) },
  { op: 'getOrganizationCellularGatewayEsimsServiceProvidersAccountsRatePlans', path: `${BASE}/serviceProviders/accounts/ratePlans`, sample: { org: LAB, query: (world) => `accountIds[]=${ACCOUNT(world)}`, status: 400 }, handler: (ctx) => plans(ctx, ratePlans) },
  { op: 'updateOrganizationCellularGatewayEsimsServiceProvidersAccount', method: 'PUT', path: `${BASE}/serviceProviders/accounts/{accountId}`, sample: { org: LAB, accountId: ACCOUNT }, handler: updateAccount },
  { op: 'deleteOrganizationCellularGatewayEsimsServiceProvidersAccount', method: 'DELETE', path: `${BASE}/serviceProviders/accounts/{accountId}`, sample: { org: LAB, accountId: ACCOUNT }, handler: deleteAccount },
  { op: 'createOrganizationCellularGatewayEsimsSwap', method: 'POST', path: `${BASE}/swap`, status: 200, sample: { org: LAB }, handler: createSwap },
  { op: 'updateOrganizationCellularGatewayEsimsSwap', method: 'PUT', path: `${BASE}/swap/{id}`, sample: { org: LAB, id: EID }, logged: false, handler: swapStatus },
];
