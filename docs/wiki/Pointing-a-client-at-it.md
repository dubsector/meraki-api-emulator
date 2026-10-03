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

Every request goes to the emulator, and its `Link` headers keep the name you asked for, so paging, `429` and `5xx` retries and writes behave as they do against the real API. Keep the base URL on `http://`, since the emulator doesn't do TLS. `meraki.aio.AsyncDashboardAPI` takes the same two options. Under [Docker Compose](Docker#docker-compose) with the network alias, `base_url="http://emulator.meraki.com:8765/api/v1"` works on its own, with no proxy.

Three things the SDK does that are easy to trip over:

- Walking the event log forward (`direction="next"`) stops once the next page starts within 5 minutes of your computer's clock. With `--now` in the past that never happens, so pass `event_log_end_time` or a number for `total_pages`.
- With `use_iterator_for_get_pages=True`, a forward event log walk loses its last page, because the SDK checks when to stop before handing over the page it just fetched. The default mode keeps it.
- Paging the assurance alert overviews by network or by type across more than one page raises `TypeError`. The SDK expects `meta.counts.items` to be an object with `remaining`, and the spec makes it a number. One page, the default `perPage` of 1000, works.

[scripts/sdk-check.py](https://github.com/dubsector/meraki-api-emulator/blob/main/scripts/sdk-check.py) runs the SDK against the emulator: paging, the event log, writes, rate limits, faults and the async client. CI runs it with the SDK version pinned in [scripts/sdk-requirements.txt](https://github.com/dubsector/meraki-api-emulator/blob/main/scripts/sdk-requirements.txt). To run it yourself:

```sh
python -m pip install --require-hashes -r scripts/sdk-requirements.txt
python scripts/sdk-check.py
```
