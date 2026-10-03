- Every authenticated call is logged in memory. `GET /organizations/{organizationId}/apiRequests` lists them newest first with the path, query string, user agent, status code and operation ID, and the `overview` endpoints count them by status code. Filter on `userAgent` to see only your client's calls.
- `--fault-rate 0.1` fails one call in ten with a 500, 502 or 503, to test retries.
- `--rate-limit` and `--burst` control when `429 Too Many Requests` starts, and the response carries `Retry-After`.
- `--latency 800` slows every response, to test timeouts and loading states.
- `--now 2026-01-15T09:00:00Z` freezes the clock, so the same request always returns the same body.
- `POST /_emulator/reset` (with your API key) throws away every write and puts the seeded world back, so each test can start clean. The request log is kept.

Each flag also has an environment variable. The [Options](https://github.com/dubsector/meraki-api-emulator#options) table in the README lists them with their defaults.
