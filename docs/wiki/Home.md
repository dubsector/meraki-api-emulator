A local stand-in for the Cisco Meraki Dashboard API v1, with two simulated organizations whose networks, devices, clients and traffic change through the day. The [README](https://github.com/dubsector/meraki-api-emulator#readme) has the quick start and the command line options. These pages cover the rest.

## Using it

- [Docker](Docker): running the image, its tags and Docker Compose with a `meraki.com` alias.
- [Pointing a client at it](Pointing-a-client-at-it): base URL and key, Grafana, and the official Python SDK with the quirks to watch for.
- [Testing your client](Testing-your-client): the request log, faults, rate limits, latency, a frozen clock and resets.

## What it does

- [The simulated world](The-simulated-world): the organizations and networks, and how clients, traffic, outages, events and alerts are generated.
- [Endpoints](Endpoints): what the operations cover, by product.
- [Writes](Writes): what can be changed, how bodies are checked and what follows along.
- [Behavior that matches the real API](Behavior-that-matches-the-real-API): paging links, errors, rate limits and parameter checks.
- [Differences from the real API](Differences-from-the-real-API): what works differently, and the values that are educated guesses.

## Working on it

- [Development](Development): tests, adding routes, the spec check, benchmarks, fuzzing and editing this wiki.
