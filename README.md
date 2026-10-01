# Meraki API Emulator

A local stand-in for the Cisco Meraki Dashboard API v1. It serves two simulated organizations with networks, devices, clients and traffic that change through the day, so you can build, test and demo Meraki integrations without a real Meraki account.

It answers 225 operations (146 reads and 79 writes) with the same paths, operation IDs, paging and error formats as the real API. Writes change the emulator's configuration in memory, so provisioning tools and scripts can create, update and delete things and read them back. It also logs every call your client makes so you can check exactly what it sent.

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
docker build -t meraki-api-emulator .
docker run --rm -p 8765:8765 meraki-api-emulator
```

## Pointing a client at it

Use `http://localhost:8765/api/v1` wherever the client asks for the Meraki base URL, and any non-empty API key. The key goes in `X-Cisco-Meraki-API-Key` or `Authorization: Bearer`, the same as the real API. The official Python SDK needs a different setup, [described below](#the-official-python-sdk).

For the [Cisco Meraki data source for Grafana](https://github.com/dubsector/grafana-ciscomeraki-datasource), set **Base URL** in the data source settings. If Grafana runs in Docker and the emulator runs on the host, start the emulator with `--host 0.0.0.0` and use `http://host.docker.internal:8765/api/v1`.

### The official Python SDK

The [Meraki Python SDK](https://github.com/meraki/dashboard-api-python) only follows `Link` URLs on `meraki.com` hosts. With `base_url="http://localhost:8765/api/v1"` the first page works, then the SDK glues the next page's URL onto its base URL and gets a `404`. Give it a made-up `meraki.com` name instead and use the emulator as its proxy:

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

Every request goes to the emulator, and its `Link` headers keep the name you asked for, so paging, `429` and `5xx` retries and writes behave as they do against the real API. Keep the base URL on `http://`, since the emulator doesn't do TLS. `meraki.aio.AsyncDashboardAPI` takes the same two options.

Three things the SDK does that are easy to trip over:

- Walking the event log forward (`direction="next"`) stops once the next page starts within 5 minutes of your computer's clock. With `--now` in the past that never happens, so pass `event_log_end_time` or a number for `total_pages`.
- With `use_iterator_for_get_pages=True`, a forward event log walk loses its last page, because the SDK checks when to stop before handing over the page it just fetched. The default mode keeps it.
- Paging the assurance alert overviews by network or by type across more than one page raises `TypeError`. The SDK expects `meta.counts.items` to be an object with `remaining`, and the spec makes it a number. One page, the default `perPage` of 1000, works.

[scripts/sdk-check.py](scripts/sdk-check.py) runs the SDK against the emulator: paging, the event log, writes, rate limits, faults and the async client. CI runs it with the SDK version pinned in [scripts/sdk-requirements.txt](scripts/sdk-requirements.txt). To run it yourself:

```sh
python -m pip install --require-hashes -r scripts/sdk-requirements.txt
python scripts/sdk-check.py
```

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
- **Alerts** are raised from those outages too. A device gone for five minutes becomes an `unreachable` assurance alert that resolves when it comes back, the Austin switch has an open CRC errors alert, and WAN failures show up as `wan_status`. Dismissing an alert takes it out of the active views until it is restored.
- **Configuration** is built from the same topology. VLAN subnets hold every client address, the MX is `.1` on each one, firewall rules reference the real VLANs, and the VPN settings export the subnets the VPN status endpoint reports.
- **Administration**: each organization has admins with different access levels, a change log written by the admins allowed to make each change, and an inventory with a few unassigned spares. Acme Corporation uses co-term licensing and Acme Test Lab uses per-device licensing, with one license expiring soon and one unused.

The same seed and the same time always give the same answer. Freeze the clock with `--now` for repeatable tests.

## Testing your client

- Every authenticated call is logged in memory. `GET /organizations/{organizationId}/apiRequests` lists them newest first with the path, query string, user agent, status code and operation ID, and the `overview` endpoints count them by status code. Filter on `userAgent` to see only your client's calls.
- `--fault-rate 0.1` fails one call in ten with a 500, 502 or 503, to test retries.
- `--rate-limit` and `--burst` control when `429 Too Many Requests` starts, and the response carries `Retry-After`.
- `--latency 800` slows every response, to test timeouts and loading states.
- `--now 2026-01-15T09:00:00Z` freezes the clock, so the same request always returns the same body.
- `POST /_emulator/reset` (with your API key) throws away every write and puts the seeded world back, so each test can start clean. The request log is kept.

## Writes

`PUT`, `POST` and `DELETE` work on organizations, networks, devices, admins, VLANs, firewall and NAT rules, static routes, site-to-site VPN, threat protection, SSIDs and their firewall, splash, Bonjour, Hotspot 2.0, schedule, traffic shaping and VPN settings, identity PSKs, RF profiles, radio settings, switch ports, syslog, SNMP, alert settings, webhook servers, group policies, client policies and splash authorization, client provisioning, management interfaces, switch port cycling, and claiming, removing and swapping devices. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Bodies are checked against the request schemas in the official spec: types, enums, required fields and ranges. A bad value gets a `400` naming the field.
- `PUT` is a partial update. Fields you leave out keep their values, nested objects merge, and lists replace.
- Unknown and read-only fields are ignored, so you can `GET` an object, change it and `PUT` the whole thing back.
- `POST` answers `201` with the new object, and `DELETE` answers `204`. Actions use the spec's code instead: a claim or a port cycle answers `200`, a removal `204` and a bulk swap `207`.
- The checks that matter to real clients are there: VLAN subnets can't overlap and the appliance IP has to be inside the subnet, static routes need a next hop on a local subnet, names and admin emails have to be unique, a PSK SSID needs an 8 to 63 character key, identity PSKs need an SSID in `ipsk-without-radius` mode and a group policy that exists, a switch port only takes link speeds it lists, and the default firewall rule always stays last.
- An SSID only shows the fields for its current auth mode, IP assignment mode and splash page, the way the real API does. Switching from PSK to 802.1X drops `psk` and adds the RADIUS settings, and moving out of NAT mode drops `dnsRewrite`. RADIUS shared secrets are accepted but never sent back.
- Related data follows along. New VLANs join the site-to-site VPN list, the VPN status endpoint reports what you export, renaming a device renames it in the event log, renaming an SSID renames it for its clients, and deleting a network returns its devices to inventory.
- Devices can be claimed from the organization's inventory. A claimed device is online right away with no clients: a switch gets empty ports and an MX one DHCP uplink. Removing a device returns it to inventory, an AP's clients move to the network's other APs, a switch's wired clients leave with it, and a network that loses its MX drops out of AutoVPN. A swap puts the new device in the old one's place with its name, settings and clients. Network settings stay as they were through all of this.
- Every write shows up in `getOrganizationConfigurationChanges` the way the real change log records API calls: page `via API`, the method and path as the label, and the object before and after as JSON.

Apart from claiming, removing and swapping devices, writes change configuration, not the simulation. Clients keep their addresses and schedules, traffic stays the same, and a network you create is empty: no devices, clients or traffic. Changing a network's time zone changes what the API reports, not the site's schedule, an SSID outage schedule doesn't take the SSID off the air, and cycling a switch port doesn't drop its link. Start with `--read-only` to refuse every write with `405`.

## Behavior that matches the real API

- `Link` headers use unquoted `rel=next`, `rel=prev`, `rel=first` and `rel=last`, like Meraki sends them.
- The network event log always includes a `rel=next` link, even past the newest event, so clients have to decide when to stop. Pages are newest first.
- A missing or wrong key gets `401` with `{"errors":["No valid authentication method found"]}`.
- About 10 requests per second per key, with a burst of 20, then `429` with `Retry-After`.
- `t0`, `t1`, `timespan`, `resolution` and `perPage` are checked against each endpoint's limits from the OpenAPI spec (lookback, longest and shortest span, valid resolutions), and bad values get a `400` with an `errors` array.
- `uplinksLossAndLatency` data ends two minutes before the current time.
- `getNetworkEvents` needs `productType` on networks with more than one product type.
- Assurance alerts return only active alerts unless you pass `resolved=true` or `dismissed=true`, like the real defaults.
- `getOrganizationSwitchPortsStatusesBySwitch` wraps its results in `items` and `meta`, unlike most list endpoints.
- `getOrganizationLicenses` answers `400` for co-term organizations.

## Endpoints

All live under `/api/v1`. [ENDPOINTS.md](ENDPOINTS.md) lists each operation with its method and path. In short:

- **Organizations**: networks, devices, statuses and availability, power supplies, uplinks and uplink addresses, memory use over time, syslog servers and roles by network, VPN, clients, top-N summaries, admins, licenses, inventory with its end-of-life overview and device swaps, provisioning statuses, the change log and the API request log.
- **Networks**: devices and claiming or removing them, clients with their daily usage, application usage, policies and splash authorization, events and event types, traffic, settings, syslog, SNMP, alert settings, webhook servers, group policies, firmware and link layer topology.
- **Alerts**: assurance alerts across the organization with overviews by network, by type and over time, dismissing and restoring them, alert profiles and the alert taxonomy, plus per-network health alerts.
- **Security appliance (MX)**: LAN ports, VLANs, L3 and L7 firewall rules and the L7 application categories, port forwarding, 1:1 NAT, static routes, site-to-site VPN, content filtering and its categories, intrusion and malware settings, security events, DHCP subnets and uplink settings.
- **Switches (MS)**: port config and live status per switch and across the organization, packet counters, port cycling, LLDP and CDP neighbors.
- **Wireless (MR)**: SSIDs with their firewall, splash, Bonjour forwarding, device type policy, EAP timer, Hotspot 2.0, OpenRoaming, outage schedule, traffic shaping and VPN settings, identity PSKs, RF profiles, radio settings and status, client counts, usage, connection and latency stats, failed connections, channel utilization and signal quality.
- **Devices**: device details, clients, loss and latency history, MX performance and management interface.

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
| `--quiet` | `MERAKI_EMULATOR_QUIET` | off | Don't log requests |

There is no real authentication, so only use `--host 0.0.0.0` on a network you trust. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Differences from the real API

- Only the operations in [ENDPOINTS.md](ENDPOINTS.md) exist. Other paths return `404`, and other methods on a known path return `405`.
- Writes live in memory and are gone after a restart or a reset.
- Only serials in the organization's inventory can be claimed. The real API also claims devices straight from an order.
- Syslog roles other than `applianceEventLog`, `applianceUrlLog` and `wirelessEventLog`, and the vMX model names, follow Meraki's naming but haven't been checked against the real API. The same goes for the SSID EAP timer defaults, which come from Cisco's Nexus-as-Code data model.
- Device memory sizes, the order of the switch packet counters and what a power supply reports while its switch is down are educated guesses.
- Content filtering category IDs, and most layer 7 category and application IDs, are stand-ins. The names follow the Dashboard, and the firewall rules, traffic analysis and event log all use the same lists.
- The alert taxonomy only lists the alert types the emulator raises. Alert profiles accept every type in the spec but never send anything.
- No redirects to regional shard hosts.
- Error messages are close to Meraki's but not always word for word.
- Rate limits are per API key rather than per organization.
- Every API key acts as the same admin, `API Integration`, in both organizations.
- The API request log lives in memory, holds the last 10,000 calls and starts empty on each run.

## Development

```sh
npm test
```

After adding a route, give it the `op` name from the official spec and run `npm run docs` to update ENDPOINTS.md. A new `PUT` or `POST` route also needs its request schema: `npm run schemas` copies them from the spec into `src/schemas.json`. `npm run check-spec` downloads the [Meraki OpenAPI spec](https://github.com/meraki/openapi) and reports routes whose path or operation ID don't match it, plus response fields the spec's examples have that ours don't. Fields the real API only sends in situations the emulator doesn't have (cellular uplinks, templates, adaptive policy and so on) are listed in `CONDITIONAL` in the script and left out of the report; `-- --all` shows them too. Pass a path to use a local copy of `spec3.json` instead.

Endpoints that report traffic should total it with `clientUsage`, `clientsUsage` or `networkTotals` from `src/sim/usage.js`. They keep daily totals per client, plus hourly totals for days a window only partly covers (up to 40 days, enough for per-day histories split at local midnight). Walking `eachSlot` directly costs time in proportion to the window and the number of clients. `npm run bench` times every sample URL and the longest timespan each route accepts, so run it after adding an endpoint to catch a slow one.

## License

MIT
