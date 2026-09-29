# Meraki API Sandbox

A local stand-in for the Cisco Meraki Dashboard API v1. It serves two simulated organizations with networks, devices, clients and traffic that change through the day, so you can build and demo Meraki tooling without a real Meraki account.

Not affiliated with or endorsed by Cisco or Meraki. All names, addresses and IPs are made up (IPs come from the RFC 5737 documentation ranges).

## Quick start

Needs Node.js 22 or newer. There are no dependencies to install.

```sh
git clone https://github.com/dubsector/meraki-api-sandbox.git
cd meraki-api-sandbox
node bin/meraki-api-sandbox.js
```

Then open <http://localhost:8765> for an overview and a request explorer, or call the API directly:

```sh
curl -H 'X-Cisco-Meraki-API-Key: anything' http://localhost:8765/api/v1/organizations
```

With Docker:

```sh
docker build -t meraki-api-sandbox .
docker run --rm -p 8765:8765 meraki-api-sandbox
```

## Pointing a client at it

Use `http://localhost:8765/api/v1` wherever the client asks for the Meraki base URL, and any non-empty API key. The key goes in `X-Cisco-Meraki-API-Key` or `Authorization: Bearer`, the same as the real API.

For the [Cisco Meraki data source for Grafana](https://github.com/dubsector/grafana-ciscomeraki-datasource), set **Base URL** in the data source settings. If Grafana runs in Docker and the sandbox runs on the host, start the sandbox with `--host 0.0.0.0` and use `http://host.docker.internal:8765/api/v1`.

## What's in it

| Organization | Network | Products | Notes |
| --- | --- | --- | --- |
| Acme Corporation | HQ - San Francisco | MX, MS, MR, MV | VPN hub, dual WAN (fiber and cable), about 340 clients |
| | Branch - Austin | MX, MS, MR | One switch is in the alerting state |
| | Warehouse - Reno | MX, MS, MR, MV | Two shifts, one flaky AP, one dormant camera |
| | Retail - Denver | MX, MS, MR | Store hours, lots of guest Wi-Fi |
| | Remote - London | MX, MS, MR | Single WAN, Europe/London time zone |
| Acme Test Lab | Lab - Toronto | MR | Wireless only |

Everything is generated from a seed and the clock:

- **Clients** follow schedules in each site's local time: office hours, warehouse shifts, retail hours, guests who drop in, and always-on devices like phones, printers and IoT sensors. Weekends are quiet.
- **Traffic** is built from those sessions on a 5-minute grid, so totals agree across endpoints and resolutions. HQ runs about 60 Mbps at midday, drops to almost nothing overnight, and has a nightly NAS backup.
- **Devices** have occasional outages. The Reno dock AP drops several times a day, and WAN links fail over now and then.
- **Events** come from the same sessions and outages: associations, 802.1X and splash auth, DHCP leases, port up and down, VPN peer changes, failovers, content filtering and IDS alerts.

The same seed and the same time always give the same answer. Freeze the clock with `--now` for repeatable tests.

## Behavior that matches the real API

- `Link` headers use unquoted `rel=next`, `rel=prev`, `rel=first` and `rel=last`, like Meraki sends them.
- The network event log always includes a `rel=next` link, even past the newest event, so clients have to decide when to stop. Pages are newest first.
- A missing or wrong key gets `401` with `{"errors":["No valid authentication method found"]}`.
- About 10 requests per second per key, with a burst of 20, then `429` with `Retry-After`.
- `t0`, `t1`, `timespan`, `resolution` and `perPage` are checked against each endpoint's limits from the OpenAPI spec, and bad values get a `400` with an `errors` array.
- `getNetworkEvents` needs `productType` on networks with more than one product type.

## Endpoints

All are `GET` under `/api/v1`.

**Organizations**: `/organizations`, `/organizations/{organizationId}`, and under it `networks`, `devices`, `devices/statuses`, `devices/statuses/overview`, `devices/availabilities`, `devices/availabilities/changeHistory`, `devices/uplinksLossAndLatency`, `appliance/uplink/statuses`, `uplinks/statuses`, `appliance/vpn/statuses`, `appliance/vpn/stats`, `appliance/uplinks/usage/byNetwork`, `clients/overview`, `summary/top/applications/byUsage`, `summary/top/clients/byUsage`, `summary/top/devices/byUsage`.

**Networks**: `/networks/{networkId}`, and under it `devices`, `clients`, `clients/{clientId}` (ID, MAC or IP), `clients/overview`, `clients/bandwidthUsageHistory`, `events`, `traffic`, `appliance/uplinks/usageHistory`, `appliance/security/events`, `wireless/clientCountHistory`, `wireless/usageHistory`, `wireless/connectionStats`, `wireless/latencyStats`, `wireless/devices/connectionStats`, `wireless/devices/latencyStats`, `wireless/ssids`, `wireless/ssids/{number}`.

**Devices**: `/devices/{serial}`, and under it `clients`, `lossAndLatencyHistory`, `appliance/performance`, `switch/ports`, `switch/ports/statuses`, `wireless/connectionStats`, `wireless/latencyStats`.

## Options

| Flag | Environment | Default | |
| --- | --- | --- | --- |
| `--port` | `PORT` | `8765` | Port to listen on |
| `--host` | `HOST` | `127.0.0.1` | Address to bind. Use `0.0.0.0` to accept outside connections |
| `--seed` | `MERAKI_SANDBOX_SEED` | `1` | Changes IDs, serials, names and noise. The topology stays the same |
| `--api-key` | `MERAKI_SANDBOX_API_KEY` | any key | Only accept this key |
| `--latency` | `MERAKI_SANDBOX_LATENCY` | `0` | Add roughly this many milliseconds to each API response |
| `--fault-rate` | `MERAKI_SANDBOX_FAULT_RATE` | `0` | Share of API calls (0 to 1) that fail with 500, 502 or 503 |
| `--rate-limit` | `MERAKI_SANDBOX_RATE_LIMIT` | `10` | Requests per second per key. `0` turns it off |
| `--burst` | `MERAKI_SANDBOX_BURST` | `20` | Requests allowed at once before throttling starts |
| `--now` | `MERAKI_SANDBOX_NOW` | real time | Freeze the clock (ISO 8601 or epoch seconds) |
| `--quiet` | `MERAKI_SANDBOX_QUIET` | off | Don't log requests |

## Differences from the real API

- Read only. Anything other than `GET` returns `405`.
- Only the endpoints above exist. Others return `404`.
- No redirects to regional shard hosts.
- Error messages are close to Meraki's but not always word for word.
- Rate limits are per API key rather than per organization.

## Development

```sh
npm test
```

## License

MIT
