#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { API_PREFIX, VERSION, createEmulator } from '../src/server.js';

const HELP = `Usage: meraki-api-emulator [options]

Serves a simulated Meraki Dashboard API v1 on ${API_PREFIX}.

Options:
  -p, --port <n>          Port to listen on (default 8765, env PORT)
      --host <addr>       Address to bind (default 127.0.0.1, env HOST)
      --seed <s>          World seed; changes IDs, names and noise (default 1)
      --api-key <key>     Only accept this key (default: any non-empty key)
      --latency <ms>      Add about this much delay to each API response
      --fault-rate <p>    Answer this share of API calls with a 5xx (0 to 1)
      --rate-limit <n>    Requests per second per key before 429 (default 10, 0 = off)
      --burst <n>         Requests allowed at once before throttling (default 20)
      --now <time>        Freeze the clock (ISO 8601 or epoch seconds)
      --read-only         Refuse PUT, POST and DELETE with 405
      --no-webhooks       Record webhook tests and callbacks as delivered without sending them
  -q, --quiet             Don't log requests
  -h, --help              Show this help
  -v, --version           Show the version

Each option can also be set with MERAKI_EMULATOR_<NAME>, for example
MERAKI_EMULATOR_API_KEY or MERAKI_EMULATOR_FAULT_RATE.`;

const env = (name) => process.env[`MERAKI_EMULATOR_${name}`];

let values;
try {
  ({ values } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      seed: { type: 'string' },
      'api-key': { type: 'string' },
      latency: { type: 'string' },
      'fault-rate': { type: 'string' },
      'rate-limit': { type: 'string' },
      burst: { type: 'string' },
      now: { type: 'string' },
      'read-only': { type: 'boolean' },
      'no-webhooks': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }));
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

const quiet = values.quiet || env('QUIET') === '1' || env('QUIET') === 'true';
const port = Number(values.port ?? process.env.PORT ?? env('PORT') ?? 8765);
const host = values.host ?? process.env.HOST ?? env('HOST') ?? '127.0.0.1';

let emulator;
try {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  emulator = createEmulator({
    seed: values.seed ?? env('SEED'),
    apiKey: values['api-key'] ?? env('API_KEY'),
    latency: values.latency ?? env('LATENCY'),
    faultRate: values['fault-rate'] ?? env('FAULT_RATE'),
    rateLimit: values['rate-limit'] ?? env('RATE_LIMIT'),
    burst: values.burst ?? env('BURST'),
    now: values.now ?? env('NOW'),
    readOnly: values['read-only'] || env('READ_ONLY'),
    noWebhooks: values['no-webhooks'] || env('NO_WEBHOOKS'),
    log: quiet ? null : (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
} catch (e) {
  console.error(`meraki-api-emulator: ${e.message}`);
  process.exit(2);
}

const { server, world, options } = emulator;
server.on('error', (e) => {
  console.error(`meraki-api-emulator: ${e.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  const addr = server.address();
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shown}:${addr.port}`;
  const lines = [
    `Meraki API Emulator ${VERSION} on ${url}`,
    `  API base   ${url}${API_PREFIX}`,
    `  Auth       ${options.apiKey ? 'X-Cisco-Meraki-API-Key must match --api-key' : 'any non-empty X-Cisco-Meraki-API-Key'}`,
    `  Writes     ${options.readOnly ? 'off (--read-only)' : 'on, kept in memory until restart or POST /_emulator/reset'}`,
    `  Seed       ${options.seed}${options.now != null ? `, clock frozen at ${new Date(options.now * 1000).toISOString()}` : ''}`,
  ];
  if (options.latency || options.faultRate) lines.push(`  Faults     ${options.latency}ms latency, ${Math.round(options.faultRate * 1e4) / 100}% 5xx`);
  for (const org of world.orgs) lines.push(`  Org        ${org.id}  ${org.name} (${org.networks.length} networks)`);
  console.log(lines.join('\n'));
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
