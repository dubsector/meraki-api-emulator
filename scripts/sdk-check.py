"""Runs the official Meraki Python SDK against the emulator.

    python -m pip install --require-hashes -r scripts/sdk-requirements.txt
    python scripts/sdk-check.py [paging events writes ratelimit faults aio]

Each scenario starts its own emulator from this checkout (needs node on PATH)
with the flags it tests. The SDK only follows Link URLs on meraki.com hosts, so
it uses a made-up meraki.com base URL with the emulator as its HTTP proxy, the
setup the README describes. Exits 1 if any check fails.
"""

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import meraki
import meraki.aio

REPO = Path(__file__).resolve().parent.parent
KEY = "sdk-check-key-0000"
# Smart flow (on by default) caches org lookups; keep that out of ~/.meraki.
CACHE = os.path.join(tempfile.gettempdir(), "meraki-sdk-check-cache.json")
QUIET = not os.environ.get("SDK_LOG")
failures = []


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Emulator:
    def __init__(self, *args):
        self.args = list(args)
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}/api/v1"
        self.sdk = {"base_url": "http://emulator.meraki.com/api/v1", "requests_proxy": f"http://127.0.0.1:{self.port}"}

    def __enter__(self):
        cmd = ["node", str(REPO / "bin" / "meraki-api-emulator.js"), "--port", str(self.port), "--quiet", *self.args]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/healthz", timeout=1).read()
                return self
            except OSError:
                time.sleep(0.1)
        self.proc.kill()
        raise RuntimeError(f"emulator did not start: {self.proc.stdout.read()}")

    def __exit__(self, *exc):
        self.proc.terminate()
        out, _ = self.proc.communicate(timeout=5)
        if "error" in out.lower():
            print("  emulator output:\n" + out)

    # Plain HTTP for reference answers, waiting out any 429.
    def raw(self, path):
        req = urllib.request.Request(self.base + path, headers={"X-Cisco-Meraki-API-Key": KEY})
        for _ in range(30):
            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(int(e.headers.get("Retry-After", "1")))
        raise RuntimeError("still rate limited")


def dashboard(emu, **kw):
    opts = dict(api_key=KEY, **emu.sdk, suppress_logging=QUIET, output_log=False, smart_flow_cache_path=CACHE, single_request_timeout=15)
    opts.update(kw)
    return meraki.DashboardAPI(**opts)


def check(name, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"  ({detail})" if detail != "" and not cond else ""))
    if not cond:
        failures.append(name)


def scenario(fn):
    def run():
        print(f"\n== {fn.__name__}")
        try:
            fn()
        except Exception as e:
            failures.append(f"{fn.__name__}: {type(e).__name__}: {e}")
            print(f"  FAIL {type(e).__name__}: {e}")
            traceback.print_exc()

    run.__name__ = fn.__name__
    return run


def acme(orgs):
    return next(o["id"] for o in orgs if o["name"] == "Acme Corporation")


def ids(rows, key="id"):
    return [r[key] for r in rows]


@scenario
def paging():
    with Emulator("--rate-limit", "0") as emu:
        orgs = emu.raw("/organizations")
        org = acme(orgs)
        for iterator in (False, True):
            mode = "iterator" if iterator else "legacy"
            d = dashboard(emu, use_iterator_for_get_pages=iterator, smart_flow_enabled=False)
            got = d.organizations.getOrganizations(total_pages="all", perPage=3)
            check(f"{mode} getOrganizations all pages", ids(got) == ids(orgs), ids(got))
            for op, path, key in [
                ("getOrganizationNetworks", "/networks", "id"),
                ("getOrganizationDevices", "/devices", "serial"),
                ("getOrganizationDevicesStatuses", "/devices/statuses", "serial"),
                ("getOrganizationInventoryDevices", "/inventory/devices", "serial"),
            ]:
                want = ids(emu.raw(f"/organizations/{org}{path}?perPage=1000"), key)
                got = ids(getattr(d.organizations, op)(org, total_pages="all", perPage=3), key)
                check(f"{mode} {op} perPage=3, all pages ({len(want)} rows)", got == want, f"got {len(got)}: {got[:6]}")
                two = ids(getattr(d.organizations, op)(org, total_pages=2, perPage=3), key)
                check(f"{mode} {op} total_pages=2", two == want[:6], two)

        # The SDK sends list kwargs as key[]=a&key[]=b.
        d = dashboard(emu, smart_flow_enabled=False)
        nets = emu.raw(f"/organizations/{org}/networks")
        pair = [nets[0]["id"], nets[1]["id"]]
        got = d.organizations.getOrganizationDevices(org, total_pages="all", perPage=3, networkIds=pair, productTypes=["wireless", "switch"])
        want = [x for x in emu.raw(f"/organizations/{org}/devices?perPage=1000") if x["networkId"] in pair and x["productType"] in ("wireless", "switch")]
        check(f"networkIds[] and productTypes[] filters ({len(want)} rows)", want and ids(got, "serial") == ids(want, "serial"), (len(got), len(want)))
        got = d.organizations.getOrganizationDevicesStatuses(org, total_pages="all", statuses=["offline", "dormant"])
        check(f"statuses[] filter ({len(got)} rows)", all(x["status"] in ("offline", "dormant") for x in got))
        hq = next(n["id"] for n in nets if n["name"] == "HQ - San Francisco")
        r = d.networks.getNetworkEvents(hq, productType="wireless", perPage=20, includedEventTypes=["association"])
        check("events includedEventTypes[] filter", r["events"] and all(e["type"] == "association" for e in r["events"]), {e["type"] for e in r["events"]})

        # Smart flow resolves the org of a network or device, then loads the
        # org's networks and inventory.
        d = dashboard(emu)
        serial = emu.raw(f"/organizations/{org}/devices")[0]["serial"]
        check("smart flow getNetwork", d.networks.getNetwork(nets[0]["id"])["id"] == nets[0]["id"])
        check("smart flow getDevice", d.devices.getDevice(serial)["serial"] == serial)


@scenario
def events():
    with Emulator("--rate-limit", "0") as emu:
        org = acme(emu.raw("/organizations"))
        nets = emu.raw(f"/organizations/{org}/networks")
        net = next(n for n in nets if n["name"] == "HQ - San Francisco")["id"]
        for iterator in (False, True):
            mode = "iterator" if iterator else "legacy"
            d = dashboard(emu, use_iterator_for_get_pages=iterator, smart_flow_enabled=False)

            # The default direction is prev: newest first, walking back.
            r = d.networks.getNetworkEvents(net, productType="wireless", perPage=10, total_pages=3)
            evs = list(r) if iterator else r["events"]
            times = [e["occurredAt"] for e in evs]
            check(f"{mode} events prev, 3 pages of 10", len(evs) == 30, len(evs))
            check(f"{mode} events prev newest first, no repeats", times == sorted(times, reverse=True) and len(set(map(json.dumps, evs))) == len(evs), times[:12])
            if not iterator:
                check("legacy pageStartAt and pageEndAt span the events", r["pageStartAt"] <= min(times) and r["pageEndAt"] >= max(times), (r["pageStartAt"], r["pageEndAt"]))

            # Forward from a day ago until the SDK stops itself 5 minutes short of now.
            start = (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
            r = d.networks.getNetworkEvents(net, productType="wireless", perPage=50, total_pages="all", direction="next", startingAfter=start)
            evs = list(r) if iterator else r["events"]
            times = [e["occurredAt"] for e in evs]
            want = emu.raw(f"/networks/{net}/events?productType=wireless&perPage=1000&startingAfter={start}")["events"]
            check(f"{mode} events next from 24h ago, oldest first", times and times == sorted(times) and times[0] > start, times[:4])
            if iterator and len(evs) < len(want):
                # SDK bug: _get_pages_iterator checks the stop condition before
                # yielding the page it just fetched, so the last page is lost.
                lost = len(want) % 50 or 50
                print(f"  note iterator mode dropped the final page ({len(evs)} of {len(want)} events), a known SDK issue")
                check(f"{mode} events next covers all but the final page", len(evs) == len(want) - lost and len(set(times)) == len(times), f"{len(evs)} vs {len(want)}")
            else:
                check(f"{mode} events next covers the window ({len(evs)} events)", len(evs) >= len(want) and len(set(times)) == len(times), f"{len(evs)} vs {len(want)}")

            # event_log_end_time ends the walk once a page starts past it.
            end = (datetime.now(timezone.utc) - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")
            r = d.networks.getNetworkEvents(net, productType="wireless", perPage=20, total_pages="all", direction="next", startingAfter=start, event_log_end_time=end)
            evs = list(r) if iterator else r["events"]
            past = sum(1 for e in evs if e["occurredAt"] > end)
            check(f"{mode} events next stops within a page of event_log_end_time", evs and past <= 20, past)

        d = dashboard(emu, smart_flow_enabled=False)
        multi = next(n for n in nets if len(n["productTypes"]) > 1)["id"]
        try:
            d.networks.getNetworkEvents(multi)
            check("events without productType on a multi-product network raise", False)
        except meraki.APIError as e:
            check("events without productType on a multi-product network raise 400", e.status == 400, e.status)


@scenario
def writes():
    with Emulator("--rate-limit", "0") as emu:
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())

        net = d.organizations.createOrganizationNetwork(org, "SDK Check", ["appliance", "switch", "wireless"], timeZone="America/Chicago", tags=["sdk"], notes="made by sdk-check")
        nid = net["id"]
        check("createOrganizationNetwork", net["name"] == "SDK Check" and sorted(net["productTypes"]) == ["appliance", "switch", "wireless"], net)
        check("getNetwork reads it back", d.networks.getNetwork(nid)["notes"] == "made by sdk-check")
        check("the new network shows up in paged org networks", nid in ids(d.organizations.getOrganizationNetworks(org, total_pages="all", perPage=3)))

        s = d.appliance.updateNetworkApplianceVlansSettings(nid, vlansEnabled=True)
        check("updateNetworkApplianceVlansSettings", s.get("vlansEnabled") is True, s)
        v = d.appliance.createNetworkApplianceVlan(nid, "42", "Lab", subnet="192.168.42.0/24", applianceIp="192.168.42.1")
        check("createNetworkApplianceVlan", str(v.get("id")) == "42" and v.get("subnet") == "192.168.42.0/24", v)
        v = d.appliance.updateNetworkApplianceVlan(nid, "42", name="Lab 2", dhcpHandling="Do not respond to DHCP requests")
        check("updateNetworkApplianceVlan", v.get("name") == "Lab 2", v)
        vlans = d.appliance.getNetworkApplianceVlans(nid)
        check("getNetworkApplianceVlans lists it", any(str(x["id"]) == "42" and x["name"] == "Lab 2" for x in vlans), vlans)
        check("getNetworkApplianceVlan", d.appliance.getNetworkApplianceVlan(nid, "42")["applianceIp"] == "192.168.42.1")

        ssid = d.wireless.updateNetworkWirelessSsid(nid, "0", name="SDK SSID", enabled=True, authMode="psk", psk="correct-horse-1", encryptionMode="wpa", wpaEncryptionMode="WPA2 only")
        check("updateNetworkWirelessSsid", ssid.get("name") == "SDK SSID" and ssid.get("enabled") is True, ssid)
        back = d.wireless.getNetworkWirelessSsid(nid, "0")
        check("getNetworkWirelessSsid reads it back", back["name"] == "SDK SSID" and back["authMode"] == "psk" and back.get("psk") == "correct-horse-1", back)
        ssids = d.wireless.getNetworkWirelessSsids(nid)
        check("getNetworkWirelessSsids lists 15, ours first", len(ssids) == 15 and ssids[0]["name"] == "SDK SSID", len(ssids))

        # A seeded network too.
        site = next(n for n in d.organizations.getOrganizationNetworks(org) if {"wireless", "appliance"} <= set(n["productTypes"]))["id"]
        before = d.wireless.getNetworkWirelessSsid(site, 1)
        after = d.wireless.updateNetworkWirelessSsid(site, 1, name=before["name"] + " (edited)", visible=False)
        check("PUT an SSID on a seeded network", after["name"].endswith("(edited)") and after.get("visible") is False, after)
        restored = d.wireless.updateNetworkWirelessSsid(site, 1, **{k: v for k, v in before.items() if k != "number"})
        check("PUT the whole GET body back", restored["name"] == before["name"])
        fw = d.appliance.getNetworkApplianceFirewallL3FirewallRules(site)
        rules = [r for r in fw["rules"] if r.get("comment") != "Default rule"]
        rules.append({"comment": "sdk", "policy": "deny", "protocol": "tcp", "srcCidr": "Any", "srcPort": "Any", "destCidr": "192.0.2.10/32", "destPort": "22"})
        fw = d.appliance.updateNetworkApplianceFirewallL3FirewallRules(site, rules=rules)
        check("PUT L3 firewall rules, default rule stays last", fw["rules"][-2]["comment"] == "sdk" and fw["rules"][-1]["comment"] == "Default rule", fw["rules"][-2:])

        changes = d.organizations.getOrganizationConfigurationChanges(org, total_pages="all", perPage=10, timespan=3600)
        check("writes show up in configurationChanges", sum(1 for c in changes if c.get("page") == "via API") >= 6, len(changes))

        d.appliance.deleteNetworkApplianceVlan(nid, "42")
        check("deleteNetworkApplianceVlan", all(str(x["id"]) != "42" for x in d.appliance.getNetworkApplianceVlans(nid)))
        d.networks.deleteNetwork(nid)
        try:
            d.networks.getNetwork(nid)
            check("a deleted network is a 404", False)
        except meraki.APIError as e:
            check("a deleted network is a 404", e.status == 404, e.status)

        try:
            d.appliance.createNetworkApplianceVlan(site, "5000", "Bad", subnet="nope", applianceIp="x")
            check("a bad VLAN raises", False)
        except meraki.APIError as e:
            check("a bad VLAN raises 400 with errors", e.status == 400 and isinstance(e.message, dict) and e.message.get("errors"), (e.status, e.message))


@scenario
def ratelimit():
    with Emulator("--rate-limit", "2", "--burst", "3") as emu:
        d = dashboard(emu, smart_flow_enabled=False, maximum_retries=10)
        org = acme(d.organizations.getOrganizations())
        t = time.monotonic()
        devs = d.organizations.getOrganizationDevices(org, total_pages="all", perPage=3)
        took = time.monotonic() - t
        log = emu.raw(f"/organizations/{org}/apiRequests?perPage=1000&timespan=600")
        n429 = sum(1 for r in log if r["responseCode"] == 429 and r["userAgent"].startswith("python-meraki/"))
        want = ids(emu.raw(f"/organizations/{org}/devices?perPage=1000"), "serial")
        check(f"paging through 429s ({len(devs)} devices, {n429} retried 429s, {took:.1f}s)", ids(devs, "serial") == want and n429 > 0, (len(devs), n429))

        strict = dashboard(emu, smart_flow_enabled=False, wait_on_rate_limit=False)
        try:
            for _ in range(10):
                strict.organizations.getOrganizations()
            check("wait_on_rate_limit=False raises on 429", False)
        except meraki.APIError as e:
            check("wait_on_rate_limit=False raises APIError 429", e.status == 429, e.status)


@scenario
def faults():
    with Emulator("--rate-limit", "0", "--fault-rate", "0.3") as emu:
        d = dashboard(emu, smart_flow_enabled=False, maximum_retries=12)
        org = acme(d.organizations.getOrganizations())
        want = None
        for _ in range(20):  # the reference fetch can hit a fault too
            try:
                want = ids(emu.raw(f"/organizations/{org}/devices?perPage=1000"), "serial")
                break
            except urllib.error.HTTPError:
                pass
        got = ids(d.organizations.getOrganizationDevices(org, total_pages="all", perPage=3), "serial")
        check(f"paging through 5xx ({len(got)} devices)", got == want, (len(got), want and len(want)))
        net = d.organizations.createOrganizationNetwork(org, "Faulty", ["switch"])
        check("POST through 5xx creates one network", sum(1 for n in d.organizations.getOrganizationNetworks(org, total_pages="all") if n["name"] == "Faulty") == 1)
        d.networks.updateNetwork(net["id"], name="Faulty 2")
        check("PUT through 5xx", d.networks.getNetwork(net["id"])["name"] == "Faulty 2")
        r = d.networks.getNetworkEvents(net["id"], perPage=5, total_pages=2)
        check("events on an empty network", r["events"] == [], r)
    with Emulator("--rate-limit", "0", "--fault-rate", "1") as emu:
        d = dashboard(emu, smart_flow_enabled=False, maximum_retries=2)
        try:
            d.organizations.getOrganizations()
            check("fault-rate 1 raises after retries", False)
        except meraki.APIError as e:
            check("fault-rate 1 raises APIError 5xx after retries", e.status in (500, 502, 503), e.status)


@scenario
def aio():
    async def go(emu):
        org = acme(emu.raw("/organizations"))
        nets = emu.raw(f"/organizations/{org}/networks?perPage=1000")
        async with meraki.aio.AsyncDashboardAPI(api_key=KEY, **emu.sdk, suppress_logging=QUIET, output_log=False, smart_flow_cache_path=CACHE) as d:
            got = ids(await d.organizations.getOrganizationNetworks(org, total_pages="all", perPage=3))
            check(f"aio getOrganizationNetworks all pages ({len(nets)})", got == ids(nets), got)
            hq = next(n["id"] for n in nets if n["name"] == "HQ - San Francisco")
            r = await d.networks.getNetworkEvents(hq, productType="wireless", perPage=10, total_pages=2)
            check("aio events prev, 2 pages of 10", len(r["events"]) == 20, len(r["events"]))
            res = await asyncio.gather(*[d.organizations.getOrganizationDevices(org, total_pages="all", perPage=5) for _ in range(4)])
            check("aio 4 concurrent paged device lists agree", res[0] and all(ids(x, "serial") == ids(res[0], "serial") for x in res))

    with Emulator() as emu:
        asyncio.run(go(emu))


SCENARIOS = [paging, events, writes, ratelimit, faults, aio]

if __name__ == "__main__":
    names = {s.__name__ for s in SCENARIOS}
    wanted = sys.argv[1:]
    if not set(wanted) <= names:
        sys.exit(f"unknown scenario: {', '.join(sorted(set(wanted) - names))} (choose from {', '.join(s.__name__ for s in SCENARIOS)})")
    print(f"meraki SDK {meraki.__version__}")
    for s in SCENARIOS:
        if not wanted or s.__name__ in wanted:
            s()
    print(f"\n{len(failures)} failure(s)" + "".join(f"\n  - {f}" for f in failures))
    sys.exit(1 if failures else 0)
