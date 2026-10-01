#!/usr/bin/env node
// Writes src/schemas.json: the request body schema of every write route, taken
// from the official OpenAPI spec and trimmed to what validation needs, plus the
// assurance alert types that alert profiles accept.
//
// node scripts/schemas.js [path/to/spec3.json]   (downloads the spec if no path)

import { readFileSync, writeFileSync } from 'node:fs';
import { ROUTES } from '../src/server.js';

const SPEC_URL = 'https://raw.githubusercontent.com/meraki/openapi/master/openapi/spec3.json';
const KEEP = ['type', 'enum', 'properties', 'items', 'required', 'minimum', 'maximum', 'additionalProperties'];

function trim(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const k of KEEP) {
    if (!(k in schema)) continue;
    if (k === 'properties') out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, s]) => [name, trim(s)]));
    else if (k === 'items' || (k === 'additionalProperties' && typeof schema[k] === 'object')) out[k] = trim(schema[k]);
    else out[k] = schema[k];
  }
  return out;
}

const spec = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : await (await fetch(SPEC_URL)).json();
const schemas = {};
for (const r of ROUTES) {
  if (!r.method || r.method === 'GET') continue;
  const op = spec.paths[r.path]?.[r.method.toLowerCase()];
  if (!op) throw new Error(`${r.method} ${r.path} is not in spec ${spec.info.version}`);
  if (op.operationId !== r.op) throw new Error(`${r.method} ${r.path} is ${op.operationId} in the spec, not ${r.op}`);
  const schema = op.requestBody?.content?.['application/json']?.schema;
  if (schema) schemas[r.op] = trim(schema);
}
// The profile body takes any string, so use the list the alert filters enumerate.
const typesParam = spec.paths['/organizations/{organizationId}/assurance/alerts']?.get.parameters.find((p) => p.name === 'types');
const alertTypes = typesParam?.schema.items.enum;
if (!alertTypes?.length) throw new Error(`No assurance alert types in spec ${spec.info.version}`);
writeFileSync(new URL('../src/schemas.json', import.meta.url), JSON.stringify({ version: spec.info.version, schemas, alertTypes }) + '\n');
console.log(`${Object.keys(schemas).length} request schemas and ${alertTypes.length} alert types from spec ${spec.info.version}`);
