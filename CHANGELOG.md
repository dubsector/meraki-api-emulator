# Changelog

Versions follow [semantic versioning](https://semver.org/). While the version starts with `0.`, a new minor version can change responses, IDs or defaults, and a patch version only fixes bugs.

## 0.5.0

The emulator now answers 991 operations (530 reads and 461 writes), up from 888. That is every operation in version 1.74.0 of the Meraki OpenAPI spec except the 7 it marks deprecated. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Acme Test Lab gets five more networks: Lab - Systems Manager with 13 enrolled devices, their owners and profiles, Lab - Calgary with two CW9800H1 campus gateways in one cluster, Lab - Halifax with a pair of C9800-40 wireless LAN controllers and six Catalyst APs, and Lab - Winnipeg with a C8455-G2-MX Secure Router. Acme Corporation's answers don't change.
- Systems Manager: devices with their certificates, connectivity, logs, profiles, restrictions, software and histories, owners, profiles, device actions (check in, lock, reboot, shutdown, wipe, tags, move, app installs and unenrolling), activation lock bypass attempts and target groups.
- Systems Manager organization settings: limited access roles, the APNS certificate, VPP accounts, Sentry policies, trusted access configs and user access devices, plus PII lookups and requests.
- Campus gateways: clusters, provisioning with failover targets, SSID tunneling and mDNS, tunnel encryption, connections and client usage.
- Wireless LAN controllers: overviews, AP connections, availability changes, clients, layer 2 and layer 3 interfaces with their usage and packet counters, redundancy and failover history, and CPU utilization.
- Secure Routers: routing table lookups and summaries, transceiver readings and interface packet counters.
- Subscription licensing: entitlements, subscriptions, claims, claim key validation, binding networks and compliance, plus order previews and order claims.
- Long history reads and request routing are faster. The 31 day network health channel utilization read went from 441 to 348 ms, and a GET of a network SSID takes about a quarter of the time it did.

Changes to existing responses:

- Acme Test Lab's organization views list the new networks, devices and licenses: networks, devices, statuses, availabilities, inventory, licenses, firmware upgrades, summaries and the appliance and wireless views. The licenses overview counts the enrolled SM devices, and Insight thresholds and Secure Access eligible networks include Lab - Winnipeg.
- The wireless SSID usage views, organization wireless usage reads and the wireless device overview name the campus gateway clusters an SSID tunnels through.
- An SSID in `Campus Gateway` mode needs a cluster of the organization, and every SSID of a network tunnels through clusters of one network.
- Network copies and organization clones take an SM network's profiles, target groups and trusted access configs, and campus gateway clusters without their gateways, with the copy's SSIDs pointing at the copied clusters.
- Moving a network to another organization takes its PII requests along, and is refused while it is named by a Sentry policy or linked to another network's campus gateway cluster.
- Ping and ping device run on campus gateways. Wireless LAN controllers refuse them.

## 0.4.0

The emulator now answers 888 operations (463 reads and 425 writes), up from 800. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Acme Test Lab gets three networks for newer hardware: Lab - Ottawa with an MX68W, Lab - Montreal with a CW9166I, nine MT sensors and two Zigbee door locks, and Lab - Kingston with an MG52 and an MG21. Acme Corporation's answers don't change.
- MT sensors: readings history and latest readings, gateway connections, alert profiles and their overviews, commands, livestream relationships and the sensor MQTT brokers.
- Zigbee door locks with enrollments and disenrollments, and electronic shelf label settings, on CW916x APs.
- MG cellular gateways: SIMs and APNs, band masks, geolocation, LAN and port forwarding, uplink bandwidth limits and the organization uplink statuses.
- MG network settings: DHCP, connectivity monitoring destinations and the subnet pool, plus eSIMs with their inventory, service provider accounts, plans and profile swaps.
- Secure Access: the integration, eligible networks, regions, connectors, sites and site connectivity now and over time.
- Umbrella on MX networks (account, policies, domain exclusions and protection), XDR per network, the Cisco Spaces link, and the deployable and deployed integration lists.

Changes to existing responses:

- Acme Test Lab's organization views list the new networks and their devices: networks, devices, statuses, availabilities, inventory, licenses, provisioning statuses, firmware upgrades, summaries, and the appliance, wireless and cellular views. The organization cellular views list the two MGs where they answered empty lists.
- The MX Wi-Fi routes answer `200` on Lab - Ottawa's MX68W. An MX SSID update on a network without VLANs takes `defaultVlanId: 1`, the value the read shows for the single LAN.
- Network copies, templates made from a network and organization clones drop the source's switches from STP bridge priorities and MTU and multicast overrides.
- Cellular data usage history defaults to 1 day, as the spec says. It was 31 days.
- A network can't move to another organization while it's attached to Secure Access or its MGs have a cellular data profile.

## 0.3.1

Bug fixes. The emulator still answers 800 operations.

- A null `tags` on a network or device, or a null `tags` or network privileges on an admin, clears the list. It was stored as is, so the reads that filter on it answered `500`, and a live tool or action batch callback built from that device or network stopped the server. A callback whose payload can't be built is now marked `failed` instead. A null network `name` or `timeZone` is ignored.
- Deleting a network removes it from its spokes' hubs, admin and SAML role privileges, network groups and other organization settings. A spoke left with no hub reads mode `none`.
- A `PUT` replaces a VLAN's or static route's `fixedIpAssignments` whole, so reservations can be removed.
- MX and SSID L7 rules take `value` as an object or bare ID for applications and categories, and as a list of country codes for the country types, so the seeded rules can be sent back.
- Each part of a split keeps only its own product's syslog roles. A server left with no roles is dropped.
- A null `payloadTemplate` on a new webhook HTTP server gets Meraki (included) instead of a `500`.
- Body checks drop inherited names like `toString` and `valueOf` with the other unknown fields.
- `npm run fuzz` and a new CI job send broken bodies and query values to every route and fail on any `5xx`.

## 0.3.0

The emulator now answers 800 operations (418 reads and 382 writes), up from 521. [ENDPOINTS.md](ENDPOINTS.md) lists them all.

- Policy objects and policy object groups, which firewall rules can name as `OBJ(id)` and `GRP(id)`.
- Switches: STP, MTU, storm control, the alternate management interface, link aggregations, warm spare, port schedules, the DHCP server policy with ARP inspection trusted servers and warnings, and cloning one switch's settings onto others.
- Wireless: radio overrides, RF profile assignments, AutoRF, Air Marshal scan results, rules and default policy, Bluetooth settings and clients, billing plans, location scanning and its receivers, MQTT settings, the alternate management interface, SSID profiles, the L2 isolation allowlist, OpenRoaming, AP port profiles, zero touch deployments and RadSec certificate authorities.
- Cameras: wireless profiles, permission scopes and roles, area and crossing line boundaries with detections, custom analytics and onboarding statuses.
- Login security, SAML SSO with its IdPs and roles, and organization SNMP.
- Adaptive policy groups, ACLs, policies and settings, organization-wide firewall rulesets, group policies and their assignments, and client policy views.
- MX: local and split DNS profiles and records, L3 interfaces, delegated IPv6 prefixes, the VRF setting, Wi-Fi on MX models with a radio, warm spare redundancy views and vMX tokens.
- Meraki authentication users, NetFlow, traffic analysis, VLAN profiles, branding policies, early access opt-ins, splash themes, Insight, organization cloning and AP auto locate.

Changes to existing responses:

- Wireless networks can have MQTT brokers, so `GET /networks/{networkId}/mqttBrokers` on a wireless network without cameras answers `200` instead of `400`.
- An SSID splash `themeId` has to be a splash theme of the organization. Any string was stored before.
- Combining networks is refused while a wireless user and a client VPN user share an email.
- An MX port update refuses an unknown adaptive policy group `sgt.id`.
- A network bound to a config template reads multicast settings from the template and refuses writes to them, like STP and MTU. `switchProfiles` entries are refused everywhere.
- MX L3, inbound, cellular and VPN firewall rules accept policy object references, and a network whose rules name them can't move to another organization.
- A swapped switch keeps its place in STP priorities and MTU and multicast overrides.

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
