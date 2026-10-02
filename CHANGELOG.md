# Changelog

Versions follow [semantic versioning](https://semver.org/). While the version starts with `0.`, a new minor version can change responses, IDs or defaults, and a patch version only fixes bugs.

## Unreleased

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
