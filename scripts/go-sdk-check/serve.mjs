// Starts an emulator for main.go and prints its base URL and a sample URL for
// every GET route as one JSON line. Stops when stdin closes.
import { createEmulator, ROUTES } from '../../src/server.js';
import { sampleUrl } from '../../src/samples.js';

const emu = createEmulator({ rateLimit: 0 });
await new Promise((r) => emu.server.listen(0, '127.0.0.1', r));
const now = Date.now() / 1000;
const samples = {};
for (const route of ROUTES.filter((r) => r.method === 'GET')) {
  try {
    samples[route.path] = sampleUrl(route, emu.world, now);
  } catch {
    // Routes whose sample needs state the world doesn't have yet.
  }
}
console.log(JSON.stringify({ base: `http://127.0.0.1:${emu.server.address().port}`, samples }));
process.stdin.on('end', () => process.exit(0)).resume();
