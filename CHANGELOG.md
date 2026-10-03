# Changelog

Versions follow [semantic versioning](https://semver.org/). While the version starts with `0.`, a new minor version can change responses, IDs or defaults, and a patch version only fixes bugs.

## 0.2.0

The emulator now answers 521 operations (295 reads and 226 writes), up from 317. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Organization views: summaries of top applications, clients, devices and networks, security events, alert history, firmware, and switch and appliance ports across the organization.
- Wireless: per-client stats, connectivity events and rate history, plus org-wide usage, packet loss, power and BSSID views.
- Inventory claims, co-term licenses and binding networks to config templates.
- Webhook payload templates, webhook tests, the webhook log and organization-wide alert configs.
- Device live tools, reboots and API callbacks.
- Action batches, the API identity and generating and revoking API keys.
- Cameras: settings, video links and MQTT brokers.
- MX traffic shaping, uplink selection, SD-WAN policies, firewall settings, cellular rules, NAT and warm spare.
- Hub BGP, third-party VPN peers and their IPsec SLA policies, and the organization's allowed intrusion rules.
- Switch layer 3 routing, OSPF and multicast, ACLs, access policies, QoS rules and DSCP mappings.
- Webhook tests and callbacks are only sent when the emulator starts with `--webhooks` (`MERAKI_EMULATOR_WEBHOOKS`). Without it they are logged as delivered and nothing leaves the emulator.

Changes to existing responses:

- A null list item, or a null where a required list or object belongs, now answers `400` naming the field instead of `500`. A null sent for a settings object no longer replaces it.
- Pages requested with `endingBefore` end at the cursor, so walking `rel=prev` links no longer repeats items. The first page can be short.
- VPN stats latency summaries and client bandwidth history are whole numbers, as the spec types them.
- The switch ports overview leaves out switches that were offline for the whole window, and the top devices summary honors `deviceTag`.
- A failed action batch is undone from a copy of the world taken before it ran, instead of replaying every write since startup. Memory no longer grows with each write.

## 0.1.1

- The Docker image no longer includes npm and npx. They carried the image's only known vulnerabilities, and the emulator doesn't use them.

## 0.1.0

First release. The emulator answers 317 operations of the Meraki Dashboard API v1 (176 reads and 141 writes), all listed in [ENDPOINTS.md](ENDPOINTS.md).

- Two simulated organizations, six networks and their MX, MS, MR and MV devices. Clients follow schedules in each site's local time, and traffic, events, outages and assurance alerts all come from the same sessions, so totals agree across endpoints.
- Every value comes from the seed and the clock, so the same seed and time always give the same answer. `--now` freezes the clock.
- Writes change configuration in memory: organizations, networks, devices, VLANs, firewall and NAT rules, VPN, SSIDs and their sub-settings, switch ports and stacks, firmware upgrades, floor plans, licenses, config templates, network groups, packet captures and more. Bodies are checked against the request schemas in the official spec, and every write shows up in the change log. `POST /_emulator/reset` brings back the seeded world.
- Devices can be claimed from inventory, removed and swapped, and networks can be moved to another organization or combined.
- Real API behavior that clients depend on: unquoted `Link` headers, an event log that always links to a next page, `401` and `429` bodies and `Retry-After`, and the spec's limits on `t0`, `t1`, `timespan`, `resolution` and `perPage`.
- Testing aids: an in-memory log of every call (`getOrganizationApiRequests`), `--fault-rate`, `--latency`, `--rate-limit`, `--burst`, `--read-only` and `--api-key`.
- Works with the official Python SDK (checked against meraki 4.5.0 in CI) through a `meraki.com` base URL and the emulator as its proxy, or a Docker network alias.
- Docker image on `ghcr.io/dubsector/meraki-api-emulator` for linux/amd64 and linux/arm64.

Values the spec doesn't settle are educated guesses, listed under "Differences from the real API" in the README and tracked in [#19](https://github.com/dubsector/meraki-api-emulator/issues/19).
