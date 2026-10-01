// Request helpers that mirror Dashboard API conventions: {"errors": [...]}
// bodies, t0/t1/timespan windows, and Link header pagination.

import { DAY, parseTime } from './time.js';

export class ApiError extends Error {
  constructor(status, errors, headers = {}) {
    super(errors[0]);
    this.status = status;
    this.errors = errors;
    this.headers = headers;
  }
}

export const badRequest = (msg) => new ApiError(400, [msg]);
export const notFound = (what = 'Resource') => new ApiError(404, [`${what} not found`]);

// Accepts both `networkIds[]=a&networkIds[]=b` and `networkIds=a,b`.
export function arrayParam(q, name) {
  return [...q.getAll(`${name}[]`), ...q.getAll(name)]
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function intParam(q, name, def, { min = -Infinity, max = Infinity } = {}) {
  const v = q.get(name);
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`'${name}' must be an integer`);
  if (n < min || n > max) throw badRequest(`'${name}' must be between ${min} and ${max}`);
  return n;
}

export function boolParam(q, name, def = false) {
  const v = q.get(name);
  if (v == null) return def;
  return v.toLowerCase() === 'true' || v === '1';
}

function time(q, name) {
  const t = parseTime(q.get(name));
  if (Number.isNaN(t)) throw badRequest(`'${name}' must be an ISO 8601 timestamp or epoch seconds`);
  return t;
}

// Resolves t0/t1/timespan into [t0, t1], clamped to now. Spans and lookback in seconds;
// minSpan only applies to timespan, as in the spec.
export function timeWindow(q, now, { maxSpan, minSpan = 0, defaultSpan = DAY, lookback, allowT1 = true }) {
  const hasSpan = q.has('timespan');
  const hasT0 = q.has('t0');
  const hasT1 = allowT1 && q.has('t1');
  let t0;
  let t1;
  if (hasSpan) {
    if (hasT0 || hasT1) throw badRequest("'timespan' cannot be combined with 't0' or 't1'");
    const span = Number(q.get('timespan'));
    if (!(span > 0)) throw badRequest("'timespan' must be a positive number of seconds");
    if (span < minSpan) throw badRequest(`'timespan' must be greater than or equal to ${minSpan} seconds`);
    if (span > maxSpan) throw badRequest(`'timespan' must be less than or equal to ${maxSpan} seconds`);
    t1 = now;
    t0 = now - span;
  } else if (hasT0) {
    t0 = time(q, 't0');
    if (t0 >= now) throw badRequest("'t0' must be in the past");
    t1 = hasT1 ? time(q, 't1') : Math.min(now, t0 + maxSpan);
    if (t1 <= t0) throw badRequest("'t1' must be after 't0'");
    if (t1 - t0 > maxSpan) throw badRequest(`'t1' can be a maximum of ${maxSpan} seconds after 't0'`);
  } else if (hasT1) {
    t1 = Math.min(time(q, 't1'), now);
    t0 = t1 - defaultSpan;
  } else {
    t1 = now;
    t0 = now - defaultSpan;
  }
  if (lookback && t0 < now - lookback - 3600) {
    throw badRequest(`'t0' must be within the last ${Math.round(lookback / DAY)} days`);
  }
  return { t0, t1: Math.min(t1, now) };
}

export function resolutionParam(q, valid, def, span) {
  if (q.get('autoResolution') === 'true') {
    return valid.find((r) => span / r <= 300) ?? valid[valid.length - 1];
  }
  const v = q.get('resolution');
  if (v == null) return def;
  const r = Number(v);
  if (!valid.includes(r)) throw badRequest(`'resolution' must be one of ${valid.join(', ')}`);
  return r;
}

const FIRST = '0000000000';
const LAST = 'zzzzzzzzzz';

function pageUrl(ctx, perPage, set) {
  const u = new URL(ctx.url.pathname + ctx.url.search, ctx.origin);
  u.searchParams.delete('startingAfter');
  u.searchParams.delete('endingBefore');
  u.searchParams.set('perPage', String(perPage));
  for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
  return u.toString();
}

// Unquoted rel values, matching what the real API sends.
export function linkHeader(ctx, perPage, links) {
  return links.map(([rel, set]) => `<${pageUrl(ctx, perPage, set)}>; rel=${rel}`).join(', ');
}

export function perPageParam(q, { def, max, min = 3 }) {
  const v = q.get('perPage');
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`'perPage' must be an integer between ${min} and ${max}`);
  return n;
}

// Pages an ordered list with opaque cursors. keyOf gives each item's cursor.
export function paginate(ctx, items, keyOf, opts) {
  const q = ctx.query;
  const perPage = perPageParam(q, opts);
  const after = q.get('startingAfter');
  const before = q.get('endingBefore');
  const find = (token) => items.findIndex((x) => keyOf(x) === token);
  let start;
  if (after != null && after !== FIRST && after !== '0') {
    const i = find(after);
    // Unknown cursor: fall back to ordering, which holds for ID-sorted lists.
    const j = i >= 0 ? i + 1 : items.findIndex((x) => keyOf(x) > after);
    start = j >= 0 ? j : items.length;
  } else if (before != null) {
    const i = before === LAST || before === '0' ? items.length : find(before);
    const end = i >= 0 ? i : items.length;
    start = Math.max(0, end - perPage);
  } else {
    start = 0;
  }
  const page = items.slice(start, start + perPage);
  const links = [['first', { startingAfter: FIRST }]];
  if (start > 0 && page.length) links.push(['prev', { endingBefore: keyOf(page[0]) }]);
  if (start + perPage < items.length && page.length) links.push(['next', { startingAfter: keyOf(page[page.length - 1]) }]);
  links.push(['last', { endingBefore: LAST }]);
  ctx.headers.Link = linkHeader(ctx, perPage, links);
  return page;
}

// The same paging in the {items, meta} envelope some newer endpoints use.
// Only the page's items go through map.
export function paginateItems(ctx, items, keyOf, opts, map = (x) => x) {
  const page = paginate(ctx, items, keyOf, opts);
  const end = page.length ? items.indexOf(page[page.length - 1]) + 1 : items.length;
  return { items: page.map(map), meta: { counts: { items: { total: items.length, remaining: items.length - end } } } };
}

export function hasTags(itemTags, wanted, mode) {
  if (!wanted.length) return true;
  return mode === 'withAllTags' ? wanted.every((t) => itemTags.includes(t)) : wanted.some((t) => itemTags.includes(t));
}
