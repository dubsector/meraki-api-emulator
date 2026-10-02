# Meraki API Emulator

[![CI](https://img.shields.io/github/actions/workflow/status/dubsector/meraki-api-emulator/ci.yml?branch=main&label=CI)](https://github.com/dubsector/meraki-api-emulator/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dubsector/meraki-api-emulator)](https://github.com/dubsector/meraki-api-emulator/releases/latest)
[![License](https://img.shields.io/github/license/dubsector/meraki-api-emulator)](LICENSE)

A local stand-in for the Cisco Meraki Dashboard API v1. It serves two simulated organizations with networks, devices, clients and traffic that change through the day, so you can build, test and demo Meraki integrations without a real Meraki account.

It answers 384 operations (230 reads and 154 writes) with the same paths, operation IDs, paging and error formats as the real API. Writes change the emulator's configuration in memory, so provisioning tools and scripts can create, update and delete things and read them back. It also logs every call your client makes so you can check exactly what it sent.

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
docker run --rm -p 8765:8765 ghcr.io/dubsector/meraki-api-emulator:0.1
```

The image listens on all interfaces inside the container, and `-p 8765:8765` publishes it on every interface of your machine too. Use `-p 127.0.0.1:8765:8765` to keep it local. Options go after the image name or in environment variables, the same as on the command line (see [Options](#options)):

```sh
docker run --rm -p 8765:8765 -e MERAKI_EMULATOR_NOW=2026-01-15T09:00:00Z \
  ghcr.io/dubsector/meraki-api-emulator:0.1 --fault-rate 0.05
```

For another port, change the host side: `-p 9000:8765`. If the port inside the container has to change too, set `PORT` rather than passing `--port`, since the image's health check reads the port from the environment.

Tags follow the release version: `0.1.0` for an exact release, `0.1` for the latest patch of it, and `latest`. While the version starts with `0.`, a new minor version can change responses, so pin `0.1` or an exact version in tests. To build the image yourself, run `docker build -t meraki-api-emulator .` in a clone.

The image leaves out npm and npx, which the emulator doesn't need. CI scans each build with [Trivy](https://trivy.dev) and fails on high or critical vulnerabilities that have a fix, and the published image is rescanned weekly, with findings under the repository's Security tab.

### Docker Compose

Next to an app under test, give the emulator a `meraki.com` name as a network alias. The app can then use it as its base URL, and that also works for the [official Python SDK](#the-official-python-sdk) without a proxy:

```yaml
services:
  meraki:
    image: ghcr.io/dubsector/meraki-api-emulator:0.1
    environment:
      MERAKI_EMULATOR_NOW: 2026-01-15T09:00:00Z
    networks:
      default:
        aliases: [emulator.meraki.com]
  app:
    build: .
    environment:
      MERAKI_BASE_URL: http://emulator.meraki.com:8765/api/v1
      MERAKI_DASHBOARD_API_KEY: any-key
    depends_on:
      meraki:
        condition: service_healthy
```

`MERAKI_BASE_URL` stands for whatever setting your app reads its base URL from. The emulator's `Link` headers keep the name and port the app called, so paging stays on the alias.

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

Every request goes to the emulator, and its `Link` headers keep the name you asked for, so paging, `429` and `5xx` retries and writes behave as they do against the real API. Keep the base URL on `http://`, since the emulator doesn't do TLS. `meraki.aio.AsyncDashboardAPI` takes the same two options. Under [Docker Compose](#docker-compose) with the network alias, `base_url="http://emulator.meraki.com:8765/api/v1"` works on its own, with no proxy.

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

`PUT`, `POST` and `DELETE` work on organizations, networks, devices, admins, VLANs, firewall and NAT rules, static routes, site-to-site VPN, threat protection, SSIDs and their firewall, splash, Bonjour, Hotspot 2.0, schedule, traffic shaping and VPN settings, identity PSKs, RF profiles, radio settings, switch ports, switch stacks and their layer 3 interfaces, DHCP and static routes, syslog, SNMP, alert settings, webhook servers and payload templates, webhook tests, organization-wide alert configs, group policies, client policies and splash authorization, client provisioning, firmware upgrade schedules and rollbacks, staged switch upgrades, floor plans and their device assignments, AP auto locate jobs, management interfaces, switch port cycling, license assignments and moves, co-term license moves, config templates and their switch profile ports, binding networks to templates, network groups, moving networks to another organization, combining and splitting networks, packet captures and their schedules, migrations to a wireless controller, cellular data profiles, claiming devices into and releasing them from inventory, and claiming, removing and swapping devices. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Bodies are checked against the request schemas in the official spec: types, enums, required fields and ranges. A bad value gets a `400` naming the field.
- `PUT` is a partial update. Fields you leave out keep their values, nested objects merge, and lists replace.
- Unknown and read-only fields are ignored, so you can `GET` an object, change it and `PUT` the whole thing back.
- `POST` answers `201` with the new object, and `DELETE` answers `204`. Actions use the spec's code instead: a claim or a port cycle answers `200`, a removal `204` and a bulk swap `207`.
- The checks that matter to real clients are there: VLAN subnets can't overlap and the appliance IP has to be inside the subnet, static routes need a next hop on a local subnet, names and admin emails have to be unique, a PSK SSID needs an 8 to 63 character key, a firmware upgrade has to move to a newer version (older ones go through a rollback), identity PSKs need an SSID in `ipsk-without-radius` mode and a group policy that exists, a switch port only takes link speeds it lists, a stack takes 2 to 8 switches of one stackable series (MS390 or MS250 here, not MS120 or MS130), and the default firewall rule always stays last.
- An SSID only shows the fields for its current auth mode, IP assignment mode and splash page, the way the real API does. Switching from PSK to 802.1X drops `psk` and adds the RADIUS settings, and moving out of NAT mode drops `dnsRewrite`. RADIUS shared secrets are accepted but never sent back.
- Related data follows along. New VLANs join the site-to-site VPN list, the VPN status endpoint reports what you export, renaming a device renames it in the event log, renaming an SSID renames it for its clients, and deleting a network returns its devices to inventory.
- Devices can be claimed from the organization's inventory. A claimed device is online right away with no clients: a switch gets empty ports and an MX one DHCP uplink. Removing a device returns it to inventory, an AP's clients move to the network's other APs, a switch's wired clients leave with it, and a network that loses its MX drops out of AutoVPN. A swap puts the new device in the old one's place with its name, settings and clients. Network settings stay as they were through all of this.
- A network moved to another organization takes its devices, clients and settings along and leaves AutoVPN. Networks with different product types can be combined into one, which takes each product's devices and settings from the network that had them, and its network-wide settings, time zone and address from the first one listed. Splitting a combined network gives one network per product type, each with that product's devices and a copy of the settings. Moving licenses to another organization moves the devices they're on to its inventory.
- A network bound to a config template reads its settings from the template, so every network bound to it shares them, and its settings writes answer `400`. With `autoBind`, its switches take their ports from the template's switch profile for their model, and a profile port change shows on every bound switch. Unbinding with `retainConfigs` keeps a copy; without it the network starts over from its defaults.
- Each organization has an unclaimed order to claim into inventory. With the default seed, Acme Corporation's is `4C9557446` (an MX250, an MS130-24P, two MR46s and a co-term license for them) and Acme Test Lab's is `4C9750629` (two MR36s). Claimed devices land in inventory, released ones go back to the unclaimed pool and can be claimed again by serial or order.
- A webhook test really sends its webhook: the alert type's example, with the network's names, rendered through the payload template and POSTed to the URL with the shared secret. Its status goes from `enqueued` to `processing`, then `delivered` on a `2xx`, or `retrying` and finally `abandoned` after three tries. Each try goes into the organization's webhook log. Start with `--no-webhooks` to send nothing and record every test as delivered.
- Every write shows up in `getOrganizationConfigurationChanges` the way the real change log records API calls: page `via API`, the method and path as the label, and the object before and after as JSON.

Apart from claiming, removing and swapping devices, and moving or combining networks, writes change configuration, not the simulation. Clients keep their addresses and schedules, traffic stays the same, and a network you create is empty: no devices, clients or traffic. Changing a network's time zone changes what the API reports, not the site's schedule, an SSID outage schedule doesn't take the SSID off the air, and cycling a switch port doesn't drop its link. Start with `--read-only` to refuse every write with `405`.

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
- The per-device license endpoints answer `400` for co-term organizations.

## Endpoints

All live under `/api/v1`. [ENDPOINTS.md](ENDPOINTS.md) lists each operation with its method and path. In short:

- **Organizations**: networks, devices, statuses and availability, power supplies, uplinks and uplink addresses, memory use over time, syslog servers and roles by network, VPN, clients and client search, client bandwidth over time, top-N summaries (applications and their categories, clients and manufacturers, devices and models, SSIDs, networks by status, appliances by utilization, switches by energy), switch PoE power over time, admins, licenses with their assignments and moves, co-term licenses and their moves, network groups and their overview, network moves and combining networks, config templates with their switch profiles and ports, packet captures and their schedules, controller migrations, cellular data profiles and the cellular device views, inventory with claiming and releasing, its end-of-life overview and device swaps, provisioning statuses, the change log and the API request log.
- **Networks**: binding to config templates, splitting combined networks, devices and claiming or removing them, clients with their daily usage, application usage, policies and splash authorization, events and event types, traffic, settings, syslog, SNMP, alert settings, webhook servers, payload templates and tests, group policies, alert history, firmware upgrades (also across the organization, per upgrade and per device), rollbacks and staged switch upgrades (groups, their order and events), floor plans with their devices and AP auto locate jobs, and link layer topology.
- **Alerts and webhooks**: assurance alerts across the organization with overviews by network, by type and over time, dismissing and restoring them, alert profiles and the alert taxonomy, organization-wide alert configs, webhook alert types, the webhook log and callback statuses, plus per-network health alerts.
- **Security appliance (MX)**: LAN ports, VLANs, L3 and L7 firewall rules and the L7 application categories, port forwarding, 1:1 NAT, static routes, site-to-site VPN, content filtering and its categories, intrusion and malware settings, security events per network, client and organization, an uplink status overview, DHCP subnets and uplink settings, plus every appliance's port configuration across the organization.
- **Switches (MS)**: port config and live status per switch and across the organization, organization-wide port counts by media and speed, clients per port, LLDP and CDP discovery and port usage history, the DHCP servers a network sees, packet counters, port cycling, LLDP and CDP neighbors, and stacks with their layer 3 interfaces, DHCP and static routes.
- **Wireless (MR)**: SSIDs with their firewall, splash, Bonjour forwarding, device type policy, EAP timer, Hotspot 2.0, OpenRoaming, outage schedule, traffic shaping and VPN settings, identity PSKs, RF profiles, radio settings and status, client counts, usage, connection and latency stats (also per client), client connectivity events and latency history, data rate and latency over time, failed connections, channel utilization (also per radio in network health), signal quality and mesh statuses, plus organization-wide client counts per AP, clients impacted by connection failures per SSID, client usage by network and SSID, packet loss by client, AP and network, channel utilization over time, Ethernet and PoE status, power mode and CPU load history, BSSID statuses and APs impacted by outages.
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
| `--no-webhooks` | `MERAKI_EMULATOR_NO_WEBHOOKS` | off | Record webhook tests as delivered without sending them |
| `--quiet` | `MERAKI_EMULATOR_QUIET` | off | Don't log requests |

There is no real authentication, so only use `--host 0.0.0.0` on a network you trust. Webhook tests POST to any URL a caller gives, including hosts on your network, so add `--no-webhooks` when others can reach the emulator. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Differences from the real API

- Only the operations in [ENDPOINTS.md](ENDPOINTS.md) exist. Other paths return `404`, and other methods on a known path return `405`.
- Writes live in memory and are gone after a restart or a reset.
- Only serials in the organization's inventory can be claimed into a network. The real API also claims devices straight from an order. Inventory claim only knows the seeded unclaimed orders and devices released from inventory.
- Acme Corporation's co-term licenses are one per order, with counts that match its devices, so the licenses overview counts what the licenses cover, and its status turns to `License Required` when an organization holds more devices than that. Claiming a license with `addDevices` adds its counts, and `renew` pushes the co-term date out by its term. Moving counts invalidates the license and makes a new one in each organization, a remainder only when counts are left. License terms, the edition names, the license model names (`MR Enterprise`, `MX250 Enterprise`, `MV`, the switch model), the key format, the `License Required` status and the renewal math are educated guesses.
- Syslog roles other than `applianceEventLog`, `applianceUrlLog` and `wirelessEventLog`, and the vMX model names, follow Meraki's naming but haven't been checked against the real API. The same goes for the SSID EAP timer defaults, which come from Cisco's Nexus-as-Code data model.
- Networks start with no switch stacks. Once a stack exists, the link layer topology shows its members as one stack node, with each link to a member pointing at that node. The spec lists no fields for a stack's members there, so each one carries the same fields as a device node. Stack member roles (first active, second standby), the ID formats, the stack node's `derivedId` and `mac`, and the defaults for interface OSPF and stack DHCP are educated guesses.
- Firmware is configuration only. A scheduled upgrade or rollback shows as done once its time passes, but device firmware strings never change. Each product has three releases (the previous one, the one networks run, and a beta). A staged upgrade stage takes an hour from its start time. Networks start with no staged upgrade groups or event. Stage status names, the time an upgrade gets when you leave it out (the next upgrade window), the ID formats and what the staged event endpoint answers before there is an event are educated guesses.
- Floor plans keep the image's MD5 and aspect ratio, not the image, so `imageUrl` points at `floorplans.example.com` and can't be downloaded. Networks start with no floor plans. A plan placed by its `center` is 100 m wide, and positions use a flat local grid, which is accurate at building scale.
- AP auto locate jobs run on the clock: 10 minutes with a GNSS and ranging refresh, 1 minute without. A plan with fewer than two APs ends in `error` with `no neighbors`. The real feature needs APs that support it; here every AP takes part. A job scheduled in the past keeps its time, so with a frozen `--now`, schedule one at least 10 minutes back to get a finished job you can publish. Publishing with no devices moves each AP to a calculated spot on its plan. The run times, the default width, the ID formats, the image URL's 30 minute expiry and leaving out `refresh` meaning no refresh are educated guesses.
- Per-device licenses assigned to a device that already has one are queued behind it and start when it runs out. A license taken off its device after it started keeps running as `unusedActive`. Neither organization has Systems Manager seats, so the seat endpoints always answer `400`. An organization created through the API with nothing in it takes on per-device licensing when licenses are moved into it. These rules are educated guesses, as are the queue's place in `permanentlyQueuedLicenses`.
- Network moves happen at once, so a move is `completed` or `failed` as soon as it's made, and a simulated move isn't kept. A move needs both organizations on the same licensing model and a free network name. A network belongs to one group at most, and a group's overall status is its worst device status. The failure reasons, the ID formats and these rules are educated guesses.
- Organizations start with no config templates. A template copied from a network gets a switch profile for each switch model in it, with that model's default port settings, and one copied from a template gets its profiles and port settings. A template made from scratch covers appliance, switch and wireless, and takes its settings from the first network bound to it. A template copied from a network keeps that network's settings as they were. Template IDs don't work as network IDs, so a template's settings can only change through its switch profile ports. A network can only bind to a template that covers all its product types, and a template with bound networks can't be deleted. The switch profiles made on copy, their names, the ID formats, which settings writes a bound network refuses, and the error wording are educated guesses.
- Packet captures run on the clock for their duration, or until stopped, and the organization keeps the newest 10. A capture takes one switch or security appliance, or several APs from one network. Packet counts and file sizes are made up, and the download link points at `pcap.example.com`. Schedules show their next run and conflicts but never take captures. Capture defaults (60 seconds, interface `wan1`, `wired` or `wireless`), the fields of each `devices` entry, the ID formats and the conflict warning's wording are educated guesses.
- Controller migrations are a record only: an AP starts its move 5 minutes after it's asked to and stays in its network. Only APs can move to a wireless controller.
- The emulator has no cellular gateways, so the cellular device, usage, geolocation, band and tower endpoints return empty lists, and profile assignments refuse every device. Data profiles are stored, with one or two rules on different SIM slots and priorities.
- Device memory sizes, the order of the switch packet counters and what a power supply reports while its switch is down are educated guesses.
- Content filtering category IDs, and most layer 7 category and application IDs, are stand-ins. The names follow the Dashboard, and the firewall rules, traffic analysis and event log all use the same lists.
- Network alert history lists what the alert settings would have sent for things the sim records: devices down past the alert's timeout, failovers, VPN peer changes, blocked malware and settings changes. Alerts go out when they happen (down alerts after the timeout), and only email, push (all admins), SMS and webhooks that are set up show as destinations. The alert type IDs other than `settings_changed` and `stopped_reporting`, the titles, `alertData` and the 31 day window are educated guesses.
- Organization firmware upgrades list each network's upgrade per product, including the one every network got about two weeks after its current release, plus scheduled and canceled ones. Outside a staged event an upgrade takes no time, so every phase of it shows the upgrade's time. Status names other than `Completed` and `Cancelled` (and the device statuses), `completedAt`'s format and the ID formats are educated guesses.
- Wireless client connectivity events follow the event log: a failed attempt when there is one, then association, authentication and DHCP, and a disassociation when the session ends. Clients don't roam, so there are no roam or sticky events, and no event triggers a packet capture. A client's latency is its AP's, and data rates follow the band, the client's signal and its spatial streams. No AP is a mesh repeater, so mesh statuses are always empty. The event subtypes and severities, the durations, the default page size of connectivity events, the SSID ID format, the order of the per-client lists (by MAC) and the empty values for intervals with no clients are educated guesses.
- Organization wireless views reuse the per-network numbers. Packet loss comes from each client's usage at a fixed packet size with a steady loss share per client, higher on 2.4 GHz and on the flaky AP. An AP gets the lower of the PoE standard its model needs and the one its switch gives (802.3bt on the MS390, 802.3at elsewhere) and runs at low power when that falls short, so the HQ CW9166Is on the MS250 run at low power. It reports its power mode each time it comes back after its own or its switch's outage. CPU load is the 5-minute load average times 1000. The impacted devices view returns one entry per wireless network, though the spec shows a single object, and counts an outage of 15 minutes or less as `AP reboot` and a longer one as `AP offline`. Usage defaults to megabytes, `tunneledTo` is `null` since there are no campus gateways, and Catalyst APs report `null` link speed, duplex and aggregation. These choices, the CPU core counts and the PoE needs per model are educated guesses.
- DHCP servers seen only lists the network's MX, on each VLAN where it handed out a lease in the window. There are no rogue servers and switch stacks don't serve DHCP there. The appliance port view names interfaces `GigabitEthernet0/0/N`, which is a guess.
- Switch port usage history picks its span and interval as the spec describes: an interval alone covers 72 intervals (a day at 1200 s), and with time parameters the interval grows until one port has at most 288.
- Webhook payload templates render Liquid output tags (`{{ name }}`, dotted paths and the `jsonify` filter) but leave `{% %}` tags as they are. Only the IDs of the included templates and the names of `wpt_00001` and `wpt_00005` come from the spec; the other names and every included body are educated guesses, as are refusing to change included templates or delete one an HTTP server uses. Webhook alert types cover the alert history's types plus `power_supply_down`. A test retries twice, half a second and then a second apart, waits 5 seconds for an answer, doesn't follow redirects, and logs a try that got no answer with `responseCode` `0`. These numbers, the test ID format and the `User-Agent` are educated guesses. Callback statuses exist for API calls that take a `callback`, and none do yet, so the lookup always answers `404`.
- Organization-wide alert configs are stored but never fire. A config needs the threshold for its type (`bit_rate_bps`, `latency_ms`, `loss_ratio`, `jitter_ms` or `mos`), keeps only that one, and its webhook recipients have to be HTTP servers in the organization. Those checks are educated guesses.
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
