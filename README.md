# Meraki API Emulator

[![CI](https://img.shields.io/github/actions/workflow/status/dubsector/meraki-api-emulator/ci.yml?branch=main&label=CI)](https://github.com/dubsector/meraki-api-emulator/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dubsector/meraki-api-emulator)](https://github.com/dubsector/meraki-api-emulator/releases/latest)
[![License](https://img.shields.io/github/license/dubsector/meraki-api-emulator)](LICENSE)

A local stand-in for the Cisco Meraki Dashboard API v1. It serves two simulated organizations with networks, devices, clients and traffic that change through the day, so you can build, test and demo Meraki integrations without a real Meraki account.

It answers 845 operations (444 reads and 401 writes) with the same paths, operation IDs, paging and error formats as the real API. Writes change the emulator's configuration in memory, so provisioning tools and scripts can create, update and delete things and read them back. It also logs every call your client makes so you can check exactly what it sent.

Not affiliated with or endorsed by Cisco or Meraki. All names, addresses and IPs are made up (IPs come from the RFC 5737 documentation ranges).

## Quick start

Needs Node.js 22 or newer. There are no dependencies to install.

```sh
git clone https://github.com/dubsector/meraki-api-emulator.git
cd meraki-api-emulator
node bin/meraki-api-emulator.js
```

Then open <http://localhost:8765> for an overview and a request explorer, or call the API directly:

```sh
curl -H 'X-Cisco-Meraki-API-Key: anything' http://localhost:8765/api/v1/organizations
```

With Docker:

```sh
docker run --rm -p 8765:8765 ghcr.io/dubsector/meraki-api-emulator:0.3
```

`-p 8765:8765` publishes the port on every interface of your machine. Use `-p 127.0.0.1:8765:8765` to keep it local. Pin `0.3` or an exact version in tests, since a new minor version can change responses while the version starts with `0.`. [Docker](https://github.com/dubsector/meraki-api-emulator/wiki/Docker) on the wiki covers options, other ports, the tags and Docker Compose.

## Pointing a client at it

Use `http://localhost:8765/api/v1` wherever the client asks for the Meraki base URL, and any non-empty API key. The key goes in `X-Cisco-Meraki-API-Key` or `Authorization: Bearer`, the same as the real API.

The [Meraki Python SDK](https://github.com/meraki/dashboard-api-python) only follows `Link` URLs on `meraki.com` hosts, so paging from `localhost` fails after the first page. Give it a made-up `meraki.com` name instead and use the emulator as its proxy:

```python
import meraki

dashboard = meraki.DashboardAPI(
    "any-key",
    base_url="http://emulator.meraki.com/api/v1",
    requests_proxy="http://localhost:8765",
    suppress_logging=True,
)
devices = dashboard.organizations.getOrganizationDevices(org_id, total_pages="all")
```

[Pointing a client at it](https://github.com/dubsector/meraki-api-emulator/wiki/Pointing-a-client-at-it) on the wiki has the details, the Grafana data source setup and three SDK quirks that are easy to trip over.

## Options

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8765` | Port to listen on |
| `--host` | `HOST` | `127.0.0.1` | Address to bind. Use `0.0.0.0` to accept outside connections |
| `--seed` | `MERAKI_EMULATOR_SEED` | `1` | Changes IDs, serials, names and noise. The topology stays the same |
| `--api-key` | `MERAKI_EMULATOR_API_KEY` | any key | Only accept this key |
| `--latency` | `MERAKI_EMULATOR_LATENCY` | `0` | Add roughly this many milliseconds to each API response |
| `--fault-rate` | `MERAKI_EMULATOR_FAULT_RATE` | `0` | Share of API calls (0 to 1) that fail with 500, 502 or 503 |
| `--rate-limit` | `MERAKI_EMULATOR_RATE_LIMIT` | `10` | Requests per second per key. `0` turns it off |
| `--burst` | `MERAKI_EMULATOR_BURST` | `20` | Requests allowed at once before throttling starts |
| `--now` | `MERAKI_EMULATOR_NOW` | real time | Freeze the clock (ISO 8601 or epoch seconds) |
| `--read-only` | `MERAKI_EMULATOR_READ_ONLY` | off | Refuse `PUT`, `POST` and `DELETE` with `405` |
| `--webhooks` | `MERAKI_EMULATOR_WEBHOOKS` | off | Send webhook tests and callbacks. Off, they are recorded as delivered without being sent |
| `--quiet` | `MERAKI_EMULATOR_QUIET` | off | Don't log requests |

There is no real authentication, so only use `--host 0.0.0.0` on a network you trust. With `--webhooks`, webhook tests and callbacks POST to any URL a caller gives, including hosts on your network, so leave it off when others can reach the emulator. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Documentation

The [wiki](https://github.com/dubsector/meraki-api-emulator/wiki) has the rest:

- [Testing your client](https://github.com/dubsector/meraki-api-emulator/wiki/Testing-your-client): the request log, faults, rate limits, latency, a frozen clock and resets.
- [The simulated world](https://github.com/dubsector/meraki-api-emulator/wiki/The-simulated-world): the organizations and networks, and how clients, traffic, outages, events and alerts are generated.
- [Endpoints](https://github.com/dubsector/meraki-api-emulator/wiki/Endpoints): what the operations cover, by product. [ENDPOINTS.md](ENDPOINTS.md) lists every one with its method and path.
- [Writes](https://github.com/dubsector/meraki-api-emulator/wiki/Writes): what can be changed, how bodies are checked and what follows along.
- [Behavior that matches the real API](https://github.com/dubsector/meraki-api-emulator/wiki/Behavior-that-matches-the-real-API): paging links, errors, rate limits and parameter checks.
- [Differences from the real API](https://github.com/dubsector/meraki-api-emulator/wiki/Differences-from-the-real-API): what works differently, and the values that are educated guesses.
- [Development](https://github.com/dubsector/meraki-api-emulator/wiki/Development): adding routes, the spec check, benchmarks, fuzzing and editing the wiki.

## Development

```sh
npm test
```

The wiki's pages live in [docs/wiki](docs/wiki) and are published to the wiki when a change to them merges, so edit them there in a pull request.

## License

MIT
