// Action batches: writes sent as one list. Each action runs through the
// emulator's own routes, so every write route works in a batch, and a batch
// applies all of its actions or none. An unconfirmed batch waits for a PUT.
// Synchronous batches, and every batch under a frozen clock, run in the
// request that confirms them; the rest run a moment later.

import { configOf } from '../config.js';
import { badRequest, notFound } from '../http.js';
import { Rand, hashStr } from '../rng.js';
import { callbacksOf, newCallback, sendCallback } from '../webhooks.js';
import { orgOf } from './common.js';

const MAX_ACTIONS = 100;
const MAX_SYNC = 20;
const MAX_RUNNING = 5;
const MAX_BATCHES = 1000;
// Seconds an asynchronous batch takes: a start plus a little per action.
const RUN_SECONDS = 2;
const PER_ACTION = 0.1;
const STATUSES = ['pending', 'completed', 'failed'];

export const storeOf = (org) => (org.actionBatches ??= { ids: 0, list: new Map() });
const isRunning = (b) => b.confirmed && !b.done;
const statusOf = (b) => (b.status.failed ? 'failed' : b.status.completed ? 'completed' : 'pending');

function newBatchId(world, org) {
  const store = storeOf(org);
  store.ids += 1;
  return new Rand(hashStr(`meraki-api-emulator:${world.seed}:actionBatch:${org.id}:${store.ids}`)).digits(18);
}

function batchOf(ctx) {
  const org = orgOf(ctx);
  const batch = storeOf(org).list.get(ctx.params.actionBatchId);
  if (!batch) throw notFound('Action batch');
  return { org, batch };
}

function batchJson(org, b, { list = false } = {}) {
  const out = { id: b.id, organizationId: org.id, confirmed: b.confirmed, synchronous: b.synchronous, status: structuredClone(b.status), actions: structuredClone(b.actions) };
  if (b.callback && !list) {
    const cb = callbacksOf(org).get(b.callback.cb.callbackId) ?? b.callback.cb;
    out.callback = { id: cb.callbackId, url: cb.webhook.url, status: cb.status };
  }
  return out;
}

// The ID a create action's answer carries: `id`, or its one own `...Id` field.
function createdId(body, params) {
  if (body == null || typeof body !== 'object') return null;
  if (body.id != null) return String(body.id);
  // Switch access policies are numbered rather than given an ID.
  if (body.accessPolicyNumber != null) return String(body.accessPolicyNumber);
  const key = Object.keys(body).find((k) => /Id$/.test(k) && !(k in params) && k !== 'organizationId' && k !== 'networkId' && typeof body[k] !== 'object');
  return key ? String(body[key]) : null;
}

function run(ctx, org, batch) {
  const { results, error } = ctx.actions.run(ctx, org, batch.actions);
  batch.done = true;
  if (error) {
    Object.assign(batch.status, { completed: false, failed: true, errors: [error] });
    return;
  }
  const created = [];
  batch.actions.forEach((a, i) => {
    const id = a.operation === 'create' ? createdId(results[i].body, results[i].params) : null;
    if (id != null) created.push({ id, uri: `${a.resource.replace(/^\/api\/v1(?=\/)/, '').replace(/\/+$/, '')}/${id}` });
  });
  Object.assign(batch.status, { completed: true, failed: false, errors: [], createdResources: created });
}

// Runs every confirmed asynchronous batch whose time has come, oldest first.
// Called before each request, so reads always see finished batches.
export function settleBatches(ctx) {
  for (;;) {
    let due = null;
    for (const org of ctx.world.orgs) {
      if (!org.actionBatches) continue;
      for (const b of org.actionBatches.list.values()) if (isRunning(b) && b.end <= ctx.now && (!due || b.end < due.b.end)) due = { org, b };
    }
    if (!due) return;
    const rctx = { ...ctx, now: due.b.end, origin: due.b.origin };
    run(rctx, due.org, due.b);
    ctx.world = rctx.world;
  }
}

function checkRunning(ctx, org, synchronous) {
  if (synchronous || ctx.frozen) return;
  const running = [...storeOf(org).list.values()].filter(isRunning).length;
  if (running >= MAX_RUNNING) throw badRequest(`An organization can have at most ${MAX_RUNNING} running action batches`);
}

function confirm(ctx, org, batch) {
  batch.confirmed = true;
  const now = ctx.now;
  if (batch.synchronous || ctx.frozen) {
    batch.end = now;
    run(ctx, org, batch);
  } else {
    batch.end = now + RUN_SECONDS + PER_ACTION * batch.actions.length;
  }
  if (batch.callback) {
    const alertData = () => {
      // Timers can fire a millisecond early, so settle up to the batch's end at least.
      ctx.settle(batch.end);
      return batchJson(org, batch);
    };
    sendCallback(ctx, batch.callback.net, null, batch.callback, alertData, batch.end - now, org);
  }
}

// A callback's HTTP server can belong to any network in the organization.
function newBatchCallback(ctx, org, given) {
  if (given == null) return null;
  const id = given.httpServer?.id;
  const net = id != null ? org.networks.find((n) => configOf(n).httpServers.some((s) => s.id === id)) : null;
  if (id != null && !net) throw badRequest(`HTTP server ${id} does not exist in this organization`);
  return { ...newCallback(ctx, net, given, org), net };
}

function createBatch(ctx) {
  const org = orgOf(ctx);
  const b = ctx.body;
  const actions = b.actions.map((a) => ({ resource: a.resource, operation: a.operation, body: a.body ?? {} }));
  const synchronous = b.synchronous === true;
  if (!actions.length) throw badRequest("'actions' must have at least one action");
  if (actions.length > MAX_ACTIONS) throw badRequest(`An action batch can have at most ${MAX_ACTIONS} actions`);
  if (synchronous && actions.length > MAX_SYNC) throw badRequest(`A synchronous action batch can have at most ${MAX_SYNC} actions`);
  ctx.actions.check(org, actions);
  if (b.confirmed) checkRunning(ctx, org, synchronous);
  const callback = newBatchCallback(ctx, org, b.callback);
  const batch = { id: newBatchId(ctx.world, org), confirmed: false, synchronous, actions, status: { completed: false, failed: false, errors: [], createdResources: [] }, done: false, end: null, origin: ctx.origin, callback };
  const { list } = storeOf(org);
  if (list.size >= MAX_BATCHES) list.delete([...list.values()].find((x) => !isRunning(x)).id);
  // Stored before it runs, so a rebuilt world carries it over.
  list.set(batch.id, batch);
  if (b.confirmed) confirm(ctx, org, batch);
  const out = batchJson(org, batch);
  if (out.callback) out.callback.status = 'new';
  return out;
}

function updateBatch(ctx) {
  const { org, batch } = batchOf(ctx);
  const b = ctx.body;
  if (b.confirmed === false && batch.confirmed) throw badRequest("'confirmed' cannot be unset once it is true");
  const synchronous = b.synchronous ?? batch.synchronous;
  if (synchronous !== batch.synchronous) {
    if (batch.confirmed) throw badRequest("'synchronous' cannot change once the batch is confirmed");
    if (synchronous && batch.actions.length > MAX_SYNC) throw badRequest(`A synchronous action batch can have at most ${MAX_SYNC} actions`);
  }
  const confirming = b.confirmed === true && !batch.confirmed;
  if (confirming) checkRunning(ctx, org, synchronous);
  batch.synchronous = synchronous;
  if (confirming) confirm(ctx, org, batch);
  return batchJson(org, batch);
}

function deleteBatch(ctx) {
  const { org, batch } = batchOf(ctx);
  if (isRunning(batch)) throw badRequest('A running action batch cannot be deleted');
  storeOf(org).list.delete(batch.id);
}

function listBatches(ctx) {
  const org = orgOf(ctx);
  const status = ctx.query.get('status');
  if (status != null && !STATUSES.includes(status)) throw badRequest(`'status' must be one of: ${STATUSES.join(', ')}`);
  return [...storeOf(org).list.values()].filter((b) => status == null || statusOf(b) === status).map((b) => batchJson(org, b, { list: true }));
}

const PATH = '/organizations/{organizationId}/actionBatches';

// Batch routes stay out of the journal: a rebuilt world carries batches over.
export default [
  { op: 'getOrganizationActionBatches', path: PATH, handler: listBatches },
  { op: 'createOrganizationActionBatch', method: 'POST', path: PATH, journal: false, handler: createBatch },
  {
    op: 'getOrganizationActionBatch',
    path: `${PATH}/{actionBatchId}`,
    sample: { actionBatchId: '1234', status: 404 },
    handler: (ctx) => {
      const { org, batch } = batchOf(ctx);
      return batchJson(org, batch);
    },
  },
  { op: 'updateOrganizationActionBatch', method: 'PUT', path: `${PATH}/{actionBatchId}`, journal: false, handler: updateBatch },
  { op: 'deleteOrganizationActionBatch', method: 'DELETE', path: `${PATH}/{actionBatchId}`, journal: false, handler: deleteBatch },
];
