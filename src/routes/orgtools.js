// Organization tools: provisioning pipeline jobs (the emulator runs no
// pipelines, so both views are empty), cloning an organization, and the
// OpenAPI document of the operations the emulator serves.

import { configOf, rebase } from '../config.js';
import { orgJson } from '../format.js';
import { arrayParam, badRequest, paginateItems } from '../http.js';
import { API_PREFIX, ROUTES, VERSION } from '../server.js';
import { copyIot } from '../sim/zigbee.js';
import { schemaOf } from '../validate.js';
import { addNetwork, addOrganization, dropSwitchSerials } from '../world.js';
import { byId, orgOf } from './common.js';
import { MAX_ORGS } from './organizations.js';

const ORG = '/organizations/{organizationId}';
const PIPELINES = `${ORG}/api/rest/provisioning/pipelines/jobs`;
const JOB_STATUSES = ['complete', 'deferred', 'failed', 'new', 'ready', 'running', 'scheduled'];

// ── Provisioning pipelines ──

function pipelineJobs(ctx) {
  orgOf(ctx);
  arrayParam(ctx.query, 'pipelineIds');
  const status = ctx.query.get('status');
  if (status && !JOB_STATUSES.includes(status)) throw badRequest(`'status' must be one of: ${JOB_STATUSES.join(', ')}`);
  return paginateItems(ctx, [], (x) => x.jobId, { def: 10, max: 1000 });
}

// ── Clone ──

// Organization settings that network settings can name (policy objects,
// adaptive policy groups, splash themes) and plain sign-in settings.
const CLONED = ['policyObjects', 'policyObjectGroups', 'adaptivePolicyGroups', 'adaptivePolicyAcls', 'adaptivePolicies', 'adaptivePolicySettings', 'splashThemes', 'loginSecurity', 'snmp'];

// The new organization gets the source's settings and a copy of each network
// (name, product types, tags, time zone and settings) with no devices,
// clients or licenses. Bound networks keep their template's settings, unbound.
function cloneOrganization(ctx) {
  const src = orgOf(ctx);
  const name = ctx.body.name;
  if (name == null) throw badRequest("'name' is required");
  if (!String(name).trim()) throw badRequest("'name' must not be empty");
  if (ctx.world.orgs.length >= MAX_ORGS) throw badRequest(`The emulator is limited to ${MAX_ORGS} organizations`);
  const org = addOrganization(ctx.world, name);
  org.licensing = src.licensing;
  if (src.licensing === 'per-device') org.licenses = [];
  if (src.management) org.management = JSON.parse(JSON.stringify(src.management));
  const pairs = [...src.networks].sort(byId).map((n) => [n, addNetwork(ctx.world, org, { name: n.name, productTypes: [...n.productTypes], tags: [...n.tags], timeZone: n.timeZone, notes: n.notes ?? '' })]);
  const swap = (v) => {
    let s = JSON.stringify(v);
    for (const [n, net] of pairs) s = s.replaceAll(n.id, net.id);
    return JSON.parse(s);
  };
  for (const [n, net] of pairs) {
    net.config = dropSwitchSerials(swap(rebase(configOf(n), n.template?.id ?? n.id, net.id)));
    copyIot(n, net);
  }
  for (const k of CLONED) if (src[k] !== undefined) org[k] = swap(src[k]);
  return orgJson(org);
}

// ── OpenAPI document ──

function openapiSpec(ctx) {
  orgOf(ctx);
  const v = ctx.query.get('version') ?? '2';
  if (v !== '2' && v !== '3') throw badRequest("'version' must be 2 or 3");
  const v3 = v === '3';
  const paths = {};
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map(([, p]) => (v3 ? { name: p, in: 'path', required: true, schema: { type: 'string' } } : { name: p, in: 'path', required: true, type: 'string' }));
    const schema = schemaOf(r.op);
    const status = String(r.status ?? (r.method === 'POST' ? 201 : r.method === 'DELETE' ? 204 : 200));
    const op = { operationId: r.op, parameters: params, responses: { [status]: { description: 'Successful operation' } } };
    if (schema && v3) op.requestBody = { required: Boolean(schema.required?.length), content: { 'application/json': { schema } } };
    else if (schema) op.parameters.push({ name: r.op, in: 'body', required: Boolean(schema.required?.length), schema });
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  const info = { version: 'v1', title: 'Meraki Dashboard API', description: `The operations meraki-api-emulator ${VERSION} serves.` };
  const key = { type: 'apiKey', name: 'X-Cisco-Meraki-API-Key', in: 'header' };
  const security = [{ meraki_api_key: [] }];
  const host = new URL(ctx.origin);
  if (v3) return { openapi: '3.0.1', info, servers: [{ url: `${ctx.origin}${API_PREFIX}` }], paths, components: { securitySchemes: { meraki_api_key: key } }, security };
  return { swagger: '2.0', info, host: host.host, basePath: API_PREFIX, schemes: [host.protocol.slice(0, -1)], consumes: ['application/json'], produces: ['application/json'], securityDefinitions: { meraki_api_key: key }, security, paths };
}

export default [
  { op: 'getOrganizationApiRestProvisioningPipelinesJobs', path: PIPELINES, handler: pipelineJobs },
  {
    op: 'getOrganizationApiRestProvisioningPipelinesJobsOverviewsByPipeline',
    path: `${PIPELINES}/overviews/byPipeline`,
    handler: (ctx) => {
      orgOf(ctx);
      arrayParam(ctx.query, 'pipelineIds');
      return { items: [], meta: { counts: { items: { total: 0, remaining: 0 } } } };
    },
  },
  { op: 'cloneOrganization', method: 'POST', path: `${ORG}/clone`, handler: cloneOrganization },
  { op: 'getOrganizationOpenapiSpec', path: `${ORG}/openapiSpec`, sample: { query: 'version=3' }, handler: openapiSpec },
];
