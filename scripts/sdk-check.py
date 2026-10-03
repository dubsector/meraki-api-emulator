"""Runs the official Meraki Python SDK against the emulator.

    python -m pip install --require-hashes -r scripts/sdk-requirements.txt
    python scripts/sdk-check.py [paging events writes ratelimit faults aio summaries wirelessstats]

Each scenario starts its own emulator from this checkout (needs node on PATH)
with the flags it tests. The SDK only follows Link URLs on meraki.com hosts, so
it uses a made-up meraki.com base URL with the emulator as its HTTP proxy, the
setup the README describes. Exits 1 if any check fails.
"""

import asyncio
import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import meraki
import meraki.aio
import meraki.session.sync

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


# HQ's wireless events follow office hours, so a walk over the last day on the
# real clock comes up short at night and at weekends. The events scenario pins
# the emulator to a weekday afternoon, and the SDK too, since the SDK ends a
# forward walk 5 minutes short of its own clock.
EVENTS_NOW = datetime(2026, 9, 30, 21, 0, tzinfo=timezone.utc)


@contextlib.contextmanager
def sdk_clock(now):
    real = meraki.session.sync.datetime

    class Pinned(real):
        @classmethod
        def now(cls, tz=None):
            return now.astimezone(tz) if tz else now.replace(tzinfo=None)

    meraki.session.sync.datetime = Pinned
    try:
        yield
    finally:
        meraki.session.sync.datetime = real


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
    # Pinned too: today's rows in a client's traffic history grow as the
    # clock runs, so a page read later than the reference copy can differ.
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
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
            # These wrap each page in {items, meta}. Legacy mode merges the pages' items, iterator mode yields them.
            serials = sorted(ids(emu.raw(f"/organizations/{org}/devices?perPage=1000"), "serial"))
            networks = [x["network"]["id"] for x in emu.raw(f"/organizations/{org}/devices/syslog/servers/byNetwork?perPage=1000")["items"]]
            for op, want in [
                ("getOrganizationDevicesSystemMemoryUsageHistoryByInterval", serials),
                ("getOrganizationDevicesSyslogServersByNetwork", networks),
                ("getOrganizationDevicesSyslogServersRolesByNetwork", networks),
            ]:
                key = lambda x: x.get("serial") or x["network"]["id"]
                got = getattr(d.organizations, op)(org, total_pages="all", perPage=3)
                got = [key(x) for x in (got["items"] if isinstance(got, dict) else got)]
                check(f"{mode} {op} perPage=3, all pages ({len(want)} items)", got == want, f"got {len(got)}: {got[:6]}")

        # The SDK sends list kwargs as key[]=a&key[]=b.
        d = dashboard(emu, smart_flow_enabled=False)
        nets = emu.raw(f"/organizations/{org}/networks")
        pair = [nets[0]["id"], nets[1]["id"]]
        got = d.organizations.getOrganizationDevices(org, total_pages="all", perPage=3, networkIds=pair, productTypes=["wireless", "switch"])
        want = [x for x in emu.raw(f"/organizations/{org}/devices?perPage=1000") if x["networkId"] in pair and x["productType"] in ("wireless", "switch")]
        check(f"networkIds[] and productTypes[] filters ({len(want)} rows)", want and ids(got, "serial") == ids(want, "serial"), (len(got), len(want)))
        got = d.organizations.getOrganizationDevicesStatuses(org, total_pages="all", statuses=["offline", "dormant"])
        check(f"statuses[] filter ({len(got)} rows)", all(x["status"] in ("offline", "dormant") for x in got))
        # direction="prev" walks back from the last page to a short first one.
        want = ids(emu.raw(f"/organizations/{org}/devices?perPage=1000"), "serial")
        got = ids(d.organizations.getOrganizationDevices(org, total_pages="all", perPage=7, direction="prev", endingBefore="zzzzzzzzzz"), "serial")
        check(f"getOrganizationDevices direction=prev, all pages ({len(want)} rows)", len(got) == len(want) and sorted(got) == sorted(want), f"got {len(got)}")
        hq = next(n["id"] for n in nets if n["name"] == "HQ - San Francisco")
        r = d.networks.getNetworkEvents(hq, productType="wireless", perPage=20, includedEventTypes=["association"])
        check("events includedEventTypes[] filter", r["events"] and all(e["type"] == "association" for e in r["events"]), {e["type"] for e in r["events"]})
        client = emu.raw(f"/networks/{hq}/clients?perPage=3")[0]["id"]
        want = emu.raw(f"/networks/{hq}/clients/{client}/trafficHistory")
        got = d.networks.getNetworkClientTrafficHistory(hq, client, total_pages="all", perPage=7)
        check(f"getNetworkClientTrafficHistory perPage=7, all pages ({len(want)} rows)", got == want, len(got))
        got = d.networks.getNetworkClientsUsageHistories(hq, client, timespan=7 * 86400)
        check("getNetworkClientsUsageHistories", len(got) == 1 and got[0]["clientId"] == client and got[0]["usageHistory"], got)

        # Smart flow resolves the org of a network or device, then loads the
        # org's networks and inventory.
        d = dashboard(emu)
        serial = emu.raw(f"/organizations/{org}/devices")[0]["serial"]
        check("smart flow getNetwork", d.networks.getNetwork(nets[0]["id"])["id"] == nets[0]["id"])
        check("smart flow getDevice", d.devices.getDevice(serial)["serial"] == serial)


@scenario
def events():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
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
            start = (EVENTS_NOW - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
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
            end = (EVENTS_NOW - timedelta(hours=12)).strftime("%Y-%m-%dT%H:%M:%SZ")
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

        d.wireless.updateNetworkWirelessSsid(site, 5, name="SDK iPSK", enabled=True, authMode="ipsk-without-radius")
        psk = d.wireless.createNetworkWirelessSsidIdentityPsk(site, 5, "SDK kiosk", "101", passphrase="sdk-kiosk-pass")
        check("createNetworkWirelessSsidIdentityPsk", psk.get("passphrase") == "sdk-kiosk-pass" and d.wireless.getNetworkWirelessSsidIdentityPsks(site, 5) == [psk], psk)
        check("deleteNetworkWirelessSsidIdentityPsk returns nothing", d.wireless.deleteNetworkWirelessSsidIdentityPsk(site, 5, psk["id"]) is None)
        sched = d.wireless.updateNetworkWirelessSsidSchedules(site, 1, enabled=True, ranges=[{"startDay": "Mon", "startTime": "22:00", "endDay": "Tue", "endTime": "06:00"}])
        check("updateNetworkWirelessSsidSchedules fills rangesInSeconds", sched.get("rangesInSeconds") == [{"start": 86400 + 79200, "end": 2 * 86400 + 21600}], sched)
        shaping = d.wireless.updateNetworkWirelessSsidTrafficShapingRules(site, 1, trafficShapingEnabled=True, rules=[{"definitions": [{"type": "host", "value": "video.example.com"}], "perClientBandwidthLimits": {"settings": "custom", "bandwidthLimits": {"limitUp": 1024, "limitDown": 4096}}}])
        check("updateNetworkWirelessSsidTrafficShapingRules", d.wireless.getNetworkWirelessSsidTrafficShapingRules(site, 1) == shaping and shaping["rules"][0]["dscpTagValue"] is None, shaping)
        fw = d.appliance.getNetworkApplianceFirewallL3FirewallRules(site)
        rules = [r for r in fw["rules"] if r.get("comment") != "Default rule"]
        rules.append({"comment": "sdk", "policy": "deny", "protocol": "tcp", "srcCidr": "Any", "srcPort": "Any", "destCidr": "192.0.2.10/32", "destPort": "22"})
        fw = d.appliance.updateNetworkApplianceFirewallL3FirewallRules(site, rules=rules)
        check("PUT L3 firewall rules, default rule stays last", fw["rules"][-2]["comment"] == "sdk" and fw["rules"][-1]["comment"] == "Default rule", fw["rules"][-2:])

        p = d.networks.provisionNetworkClients(site, [{"mac": "02:00:5e:00:53:01", "name": "SDK kiosk"}], "Blocked")
        key = p["clients"][0]["clientId"]
        check("provisionNetworkClients", p["devicePolicy"] == "Blocked" and p["clients"][0]["name"] == "SDK kiosk", p)
        pol = d.networks.updateNetworkClientPolicy(site, key, "Group policy", groupPolicyId="101")
        check("updateNetworkClientPolicy on a provisioned client", pol.get("groupPolicyId") == "101" and d.networks.getNetworkClientPolicy(site, key) == pol, pol)

        # Claim, remove and swap answer 200, 204 and 207.
        spare = d.organizations.getOrganizationInventoryDevices(org, usedState="unused", productTypes=["wireless"])[0]["serial"]
        c = d.networks.claimNetworkDevices(site, [spare])
        check("claimNetworkDevices", c.get("serials") == [spare] and not c.get("errors") and d.devices.getDevice(spare)["networkId"] == site, c)
        c = d.networks.claimNetworkDevices(site, [spare, "Q2XX-NOPE-NOPE"], addAtomically=False)
        check("claimNetworkDevices addAtomically=False lists errors per device", c.get("serials") == [] and len(c.get("errors", [])) == 2, c)
        check("removeNetworkDevices returns nothing", d.networks.removeNetworkDevices(site, spare) is None)
        check("a removed device is back in inventory", spare in ids(d.organizations.getOrganizationInventoryDevices(org, usedState="unused"), "serial"))
        vmx = d.networks.vmxNetworkDevicesClaim(nid, "small")
        check("vmxNetworkDevicesClaim", vmx.get("model") == "VMX-S" and vmx.get("networkId") == nid, vmx)
        old = next(x for x in d.networks.getNetworkDevices(site) if x["productType"] == "wireless")
        swap = d.organizations.createOrganizationInventoryDevicesSwapsBulk(org, [{"devices": {"old": old["serial"], "new": spare}, "afterAction": "remove from network"}])
        check("createOrganizationInventoryDevicesSwapsBulk", swap.get("jobId") and swap["swaps"][0]["status"] == "pending", swap)
        job = d.organizations.getOrganizationInventoryDevicesSwapsBulk(org, swap["jobId"])
        check("getOrganizationInventoryDevicesSwapsBulk", job["swaps"][0]["status"] == "complete" and d.devices.getDevice(spare)["name"] == old["name"], job)
        statuses = d.organizations.getOrganizationDevicesProvisioningStatuses(org, total_pages="all", perPage=5)
        unprovisioned = {s["serial"] for s in statuses if s["status"] == "unprovisioned"}
        check(f"getOrganizationDevicesProvisioningStatuses perPage=5, all pages ({len(statuses)} rows)", len(statuses) == len(d.organizations.getOrganizationInventoryDevices(org)) and old["serial"] in unprovisioned, len(statuses))
        sw = next(x for x in d.networks.getNetworkDevices(site) if x["productType"] == "switch")
        ip = sw["lanIp"].rsplit(".", 1)[0] + ".250"
        m = d.devices.updateDeviceManagementInterface(sw["serial"], wan1={"usingStaticIp": True, "staticIp": ip, "staticSubnetMask": "255.255.255.0", "staticGatewayIp": sw["lanIp"].rsplit(".", 1)[0] + ".1", "vlan": 1})
        check("updateDeviceManagementInterface", m["wan1"].get("staticIp") == ip and d.devices.getDevice(sw["serial"])["lanIp"] == ip, m)
        s = d.networks.updateNetworkDevicesSyslogServers(site, [{"host": "192.0.2.50", "port": 514, "roles": ["wirelessEventLog", "applianceUrlLog"]}])
        check("updateNetworkDevicesSyslogServers", s["servers"][0]["roles"] == ["wirelessEventLog", "applianceUrlLog"] and d.networks.getNetworkSyslogServers(site)["servers"][0]["roles"] == ["Wireless event log", "URLs"], s)
        s = d.organizations.bulkUpdateOrganizationDevicesDetails(org, [sw["serial"]], [{"name": "username", "value": "admin"}])
        check("bulkUpdateOrganizationDevicesDetails", s == {"serials": [sw["serial"]]}, s)
        rows = d.organizations.getOrganizationDevicesSyslogServersByNetwork(org, networkIds=[site])["items"]
        check("getOrganizationDevicesSyslogServersByNetwork shows the update", rows[0]["servers"][0]["roles"] == ["wirelessEventLog", "applianceUrlLog"], rows)
        addr = d.organizations.getOrganizationDevicesUplinksAddressesByDevice(org, total_pages="all", perPage=3, serials=[sw["serial"]])
        check("getOrganizationDevicesUplinksAddressesByDevice follows the management interface", addr[0]["uplinks"][0]["addresses"][0]["address"] == ip and addr[0]["uplinks"][0]["addresses"][0]["assignmentMode"] == "static", addr)
        s = d.switch.cycleDeviceSwitchPorts(sw["serial"], ["1", "2-3"])
        check("cycleDeviceSwitchPorts", s == {"ports": ["1", "2-3"]}, s)
        packets = d.switch.getDeviceSwitchPortsStatusesPackets(sw["serial"], timespan=3600)
        check("getDeviceSwitchPortsStatusesPackets", len(packets) == len(d.switch.getDeviceSwitchPorts(sw["serial"])) and packets[0]["packets"][0]["desc"] == "Total", packets[:1])
        psus = d.organizations.getOrganizationDevicesPowerModulesStatusesByDevice(org, total_pages="all", perPage=3)
        check("getOrganizationDevicesPowerModulesStatusesByDevice", len(psus) == 1 and len(psus[0]["slots"]) == 2, psus)
        eox = d.organizations.getOrganizationInventoryDevicesEoxOverview(org)
        check("getOrganizationInventoryDevicesEoxOverview", set(eox["counts"]["byStatus"]) == {"endOfSale", "endOfSupport", "nearEndOfSupport"}, eox)

        # Assurance alerts: dismiss and restore answer 204, profiles are kept per organization.
        active = d.organizations.getOrganizationAssuranceAlerts(org, total_pages="all")
        first = active[0]["id"]
        check("dismissOrganizationAssuranceAlerts returns nothing", d.organizations.dismissOrganizationAssuranceAlerts(org, [first]) is None)
        gone = d.organizations.getOrganizationAssuranceAlerts(org, total_pages="all", active=False, dismissed=True)
        check("a dismissed alert lists with dismissed=True", ids(gone) == [first] and gone[0]["dismissedAt"], gone)
        check("restoreOrganizationAssuranceAlerts", d.organizations.restoreOrganizationAssuranceAlerts(org, [first]) is None and d.organizations.getOrganizationAssuranceAlert(org, first)["dismissedAt"] is None)
        by_net = d.organizations.getOrganizationAssuranceAlertsOverviewByNetwork(org)
        by_type = d.organizations.getOrganizationAssuranceAlertsOverviewByType(org, includeNetworks=True)
        check("alert overviews by network and by type add up", sum(n["alertCount"] for n in by_net["items"]) == sum(t["count"] for t in by_type["items"]) == len(active), (by_net, by_type))
        t0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=3)
        fmt = "%Y-%m-%dT%H:%M:%SZ"
        hist = d.organizations.getOrganizationAssuranceAlertsOverviewHistorical(org, 86400, t0.strftime(fmt), tsEnd=(t0 + timedelta(days=3)).strftime(fmt))
        check("getOrganizationAssuranceAlertsOverviewHistorical", hist["meta"]["counts"]["items"] == 3 and all("totals" in x for x in hist["items"]), hist)
        hook = d.networks.createNetworkWebhooksHttpServer(site, "SDK hook", "https://hooks.example.com/sdk")
        dest = {"email": {"enabled": True, "recipients": ["noc@example.com"]}, "webhook": {"enabled": True, "recipients": [hook["id"]]}}
        prof = d.organizations.createOrganizationAssuranceAlertsProfile(org, "SDK profile", [site], ["unreachable", "vlan_mismatch"], {"alertDestinations": dest})
        check("createOrganizationAssuranceAlertsProfile", prof["configuration"]["alertDestinations"]["webhook"]["recipients"][0]["url"] == "https://hooks.example.com/sdk", prof)
        prof = d.organizations.updateOrganizationAssuranceAlertsProfile(org, prof["profileId"], "SDK profile 2", [site], ["unreachable"], {"enabled": False})
        check("updateOrganizationAssuranceAlertsProfile", d.organizations.getOrganizationAssuranceAlertsProfiles(org)["items"] == [prof], prof)
        check("deleteOrganizationAssuranceAlertsProfile", d.organizations.deleteOrganizationAssuranceAlertsProfile(org, prof["profileId"]) is None and d.organizations.getOrganizationAssuranceAlertsProfiles(org)["items"] == [])

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


@scenario
def summaries():
    # Pinned like the events scenario, so time windows don't follow the real clock.
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())
        nets = d.organizations.getOrganizationNetworks(org)
        hq = next(n["id"] for n in nets if n["name"] == "HQ - San Francisco")
        day = "timespan=86400"
        for op, path, kw in [
            ("getOrganizationSummaryTopAppliancesByUtilization", "appliances/byUtilization", {}),
            ("getOrganizationSummaryTopApplicationsCategoriesByUsage", "applications/categories/byUsage", {}),
            ("getOrganizationSummaryTopClientsManufacturersByUsage", "clients/manufacturers/byUsage", {}),
            ("getOrganizationSummaryTopDevicesModelsByUsage", "devices/models/byUsage", {}),
            ("getOrganizationSummaryTopSwitchesByEnergyUsage", "switches/byEnergyUsage", {}),
        ]:
            got = getattr(d.organizations, op)(org, timespan=86400, quantity=5)
            want = emu.raw(f"/organizations/{org}/summary/top/{path}?{day}&quantity=5")
            check(f"{op} ({len(got)} rows)", got and got == want, got[:1])
        got = d.organizations.getOrganizationSummaryTopDevicesModelsByUsage(org, deviceTag="lobby")
        check("getOrganizationSummaryTopDevicesModelsByUsage deviceTag", [(m["model"], m["count"]) for m in got] == [("CW9166I", 1)], got)
        got = d.organizations.getOrganizationSummaryTopNetworksByStatus(org, total_pages="all", perPage=3)
        want = emu.raw(f"/organizations/{org}/summary/top/networks/byStatus")
        check(f"getOrganizationSummaryTopNetworksByStatus perPage=3, all pages ({len(want)} rows)", got == want, len(got))
        got = d.switch.getOrganizationSummarySwitchPowerHistory(org, timespan=86400)
        check(f"getOrganizationSummarySwitchPowerHistory ({len(got)} intervals)", len(got) == 72 and got == emu.raw(f"/organizations/{org}/summary/switch/power/history?{day}"), len(got))
        got = d.organizations.getOrganizationClientsBandwidthUsageHistory(org, timespan=86400)
        check(f"getOrganizationClientsBandwidthUsageHistory ({len(got)} rows)", len(got) == 288 and got == emu.raw(f"/organizations/{org}/clients/bandwidthUsageHistory?{day}"), len(got))
        check("bandwidth history is whole Mbps", all(isinstance(r[k], int) for r in got for k in ("total", "upstream", "downstream")), got[:1])
        got = d.appliance.getOrganizationApplianceUplinksStatusesOverview(org)
        uplinks = sum(len(x["uplinks"]) for x in emu.raw(f"/organizations/{org}/appliance/uplink/statuses"))
        check("getOrganizationApplianceUplinksStatusesOverview", sum(got["counts"]["byStatus"].values()) == uplinks, got)

        week = 7 * 86400
        got = d.appliance.getOrganizationApplianceSecurityEvents(org, total_pages="all", perPage=50, timespan=week)
        want = emu.raw(f"/organizations/{org}/appliance/security/events?timespan={week}&perPage=1000")
        check(f"getOrganizationApplianceSecurityEvents perPage=50, all pages ({len(want)} events)", want and got == want, len(got))
        mac = want[0]["clientMac"]
        client = d.organizations.getOrganizationClientsSearch(org, mac)
        check("getOrganizationClientsSearch", client["mac"] == mac and len(client["records"]) == 1, client)
        net = client["records"][0]["network"]["id"]
        got = d.appliance.getNetworkApplianceClientSecurityEvents(net, client["clientId"], total_pages="all", perPage=3, timespan=week)
        check(f"getNetworkApplianceClientSecurityEvents perPage=3, all pages ({len(got)} events)", got and got == [e for e in want if e["clientMac"] == mac], len(got))
        try:
            d.organizations.getOrganizationClientsSearch(org, "02:00:00:00:00:01")
            check("an unknown MAC raises", False)
        except meraki.APIError as e:
            check("an unknown MAC raises 404", e.status == 404, e.status)

        got = d.networks.getNetworkAlertsHistory(hq, total_pages="all", perPage=25)
        want = emu.raw(f"/networks/{hq}/alerts/history?perPage=1000")
        check(f"getNetworkAlertsHistory perPage=25, all pages ({len(want)} alerts)", want and got == want, len(got))

        upgrades = d.organizations.getOrganizationFirmwareUpgrades(org, total_pages="all", perPage=3)
        check(f"getOrganizationFirmwareUpgrades perPage=3, all pages ({len(upgrades)} upgrades)", upgrades and upgrades == emu.raw(f"/organizations/{org}/firmware/upgrades"), len(upgrades))
        fw = d.networks.getNetworkFirmwareUpgrades(hq)
        beta = fw["products"]["wireless"]["availableVersions"][0]["id"]
        d.networks.updateNetworkFirmwareUpgrades(hq, products={"wireless": {"nextUpgrade": {"time": "2026-10-05T10:00:00Z", "toVersion": {"id": beta}}}})
        sched = d.organizations.getOrganizationFirmwareUpgrades(org, status=["Scheduled"])
        check("a scheduled upgrade lists as Scheduled", len(sched) == 1 and sched[0]["toVersion"]["id"] == beta and sched[0]["completedAt"] is None, sched)
        rows = d.organizations.getOrganizationFirmwareUpgradesByDevice(org, total_pages="all", perPage=5, networkIds=[hq], upgradeStatuses=["scheduled"])
        aps = [x for x in d.networks.getNetworkDevices(hq) if x["productType"] == "wireless"]
        check(f"getOrganizationFirmwareUpgradesByDevice perPage=5, all pages ({len(rows)} rows)", len(rows) == len(aps) and all(r["upgrade"]["id"] == sched[0]["upgradeId"] for r in rows), len(rows))


@scenario
def wirelessstats():
    # Pinned like the events scenario, so each window holds the same sessions.
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())
        nets = d.organizations.getOrganizationNetworks(org)
        hq = next(n["id"] for n in nets if n["name"] == "HQ - San Francisco")
        week = 7 * 86400
        got = d.networks.getNetworkNetworkHealthChannelUtilization(hq, total_pages="all", perPage=3, timespan=3600)
        want = emu.raw(f"/networks/{hq}/networkHealth/channelUtilization?timespan=3600&perPage=100")
        check(f"getNetworkNetworkHealthChannelUtilization perPage=3, all pages ({len(want)} APs)", len(want) == 10 and got == want, len(got))

        rows = d.wireless.getNetworkWirelessClientsConnectionStats(hq, timespan=week)
        net = d.wireless.getNetworkWirelessConnectionStats(hq, timespan=week)
        check(f"getNetworkWirelessClientsConnectionStats adds up to the network ({len(rows)} clients)", rows and all(sum(r["connectionStats"][k] for r in rows) == v for k, v in net.items()), net)
        got = d.wireless.getNetworkWirelessClientsLatencyStats(hq, timespan=week, fields="avg")
        check(f"getNetworkWirelessClientsLatencyStats ({len(got)} clients)", got and got == emu.raw(f"/networks/{hq}/wireless/clients/latencyStats?timespan={week}&fields=avg"), got[:1])
        row = max(rows, key=lambda r: r["connectionStats"]["success"])
        mac = row["mac"]
        one = d.wireless.getNetworkWirelessClientConnectionStats(hq, mac, timespan=week)
        check("getNetworkWirelessClientConnectionStats", one["mac"] == mac and one["connectionStats"]["success"] == row["connectionStats"]["success"], one)
        got = d.wireless.getNetworkWirelessClientLatencyStats(hq, mac, timespan=week)
        check("getNetworkWirelessClientLatencyStats", got == next(r for r in emu.raw(f"/networks/{hq}/wireless/clients/latencyStats?timespan={week}") if r["mac"] == mac), got)
        events = d.wireless.getNetworkWirelessClientConnectivityEvents(hq, mac, total_pages="all", perPage=3, timespan=week)
        want = emu.raw(f"/networks/{hq}/wireless/clients/{mac}/connectivityEvents?timespan={week}")
        assoc = sum(1 for e in events if e["type"] == "assoc" and e["severity"] == "good")
        check(f"getNetworkWirelessClientConnectivityEvents perPage=3, all pages ({len(want)} events)", want and events == want and assoc == one["connectionStats"]["success"], len(events))
        got = d.wireless.getNetworkWirelessClientLatencyHistory(hq, mac, timespan=week)
        check(f"getNetworkWirelessClientLatencyHistory ({len(got)} days)", len(got) == 8 and got == emu.raw(f"/networks/{hq}/wireless/clients/{mac}/latencyHistory?timespan={week}"), len(got))

        got = d.wireless.getNetworkWirelessDataRateHistory(hq, timespan=86400, resolution=3600)
        check(f"getNetworkWirelessDataRateHistory ({len(got)} hours)", len(got) == 24 and got == emu.raw(f"/networks/{hq}/wireless/dataRateHistory?timespan=86400&resolution=3600"), len(got))
        got = d.wireless.getNetworkWirelessLatencyHistory(hq, timespan=86400, resolution=3600, accessCategory="voiceTraffic")
        check(f"getNetworkWirelessLatencyHistory ({len(got)} hours)", len(got) == 24 and got == emu.raw(f"/networks/{hq}/wireless/latencyHistory?timespan=86400&resolution=3600&accessCategory=voiceTraffic"), len(got))
        got = d.wireless.getNetworkWirelessMeshStatuses(hq, total_pages="all")
        check("getNetworkWirelessMeshStatuses is empty", got == [], got)

        got = d.wireless.getOrganizationWirelessClientsConnectionsImpactedByNetworkBySsid(org, total_pages="all", perPage=3, timespan=week)
        got = got["items"] if isinstance(got, dict) else got
        want = emu.raw(f"/organizations/{org}/wireless/clients/connections/impacted/byNetwork/bySsid?timespan={week}&perPage=1000")["items"]
        check(f"getOrganizationWirelessClientsConnectionsImpactedByNetworkBySsid perPage=3, all pages ({len(want)} SSIDs)", len(want) > 3 and got == want, len(got))
        got = d.wireless.getOrganizationWirelessClientsOverviewByDevice(org, total_pages="all", perPage=3)
        got = got["items"] if isinstance(got, dict) else got
        want = emu.raw(f"/organizations/{org}/wireless/clients/overview/byDevice")["items"]
        check(f"getOrganizationWirelessClientsOverviewByDevice perPage=3, all pages ({len(want)} APs)", len(want) == 25 and got == want, len(got))


@scenario
def orgwireless():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())
        o = f"/organizations/{org}"
        items = lambda got: got["items"] if isinstance(got, dict) else got
        day = 86400

        top = d.organizations.getOrganizationSummaryTopSsidsByUsage(org, timespan=day, quantity=50)
        got = items(d.wireless.getOrganizationWirelessClientsUsageBySsid(org, total_pages="all", perPage=3, timespan=day))
        rows = {r["ssid"]["name"]: r for r in got}
        check(f"getOrganizationWirelessClientsUsageBySsid perPage=3, all pages, matches the top SSIDs ({len(got)} SSIDs)", top and all(abs(rows[t["name"]]["usage"]["total"] - t["usage"]["total"]) <= 0.1 and rows[t["name"]]["clients"]["total"] == t["clients"]["counts"]["total"] for t in top), got[:1])
        nets = items(d.wireless.getOrganizationWirelessClientsUsageByNetwork(org, total_pages="all", perPage=3, timespan=day))
        check(f"getOrganizationWirelessClientsUsageByNetwork perPage=3, all pages ({len(nets)} networks)", len(nets) == 5 and nets == emu.raw(f"{o}/wireless/clients/usage/byNetwork?timespan={day}")["items"], len(nets))
        got = items(d.wireless.getOrganizationWirelessClientsUsageByNetworkBySsid(org, total_pages="all", perPage=3, timespan=day, usageUnits="KB"))
        sums = {n["network"]["id"]: sum(r["usage"]["total"] for r in got if r["network"]["id"] == n["network"]["id"]) for n in nets}
        check(f"getOrganizationWirelessClientsUsageByNetworkBySsid in KB adds up to each network ({len(got)} SSIDs)", all(abs(sums[n["network"]["id"]] / 1024 - n["usage"]["total"]) <= 0.05 for n in nets), sums)

        got = d.wireless.getOrganizationWirelessDevicesChannelUtilizationHistoryByDeviceByInterval(org, total_pages="all", perPage=3, timespan=7200, interval=3600)
        want = emu.raw(f"{o}/wireless/devices/channelUtilization/history/byDevice/byInterval?timespan=7200&interval=3600")
        check(f"getOrganizationWirelessDevicesChannelUtilizationHistoryByDeviceByInterval perPage=3, all pages ({len(want)} rows)", len(want) == 50 and got == want, len(got))
        got = d.wireless.getOrganizationWirelessDevicesChannelUtilizationHistoryByNetworkByInterval(org, total_pages="all", perPage=3, timespan=7200, interval=3600)
        check(f"getOrganizationWirelessDevicesChannelUtilizationHistoryByNetworkByInterval ({len(got)} rows)", len(got) == 10 and got == emu.raw(f"{o}/wireless/devices/channelUtilization/history/byNetwork/byInterval?timespan=7200&interval=3600"), len(got))

        got = d.wireless.getOrganizationWirelessDevicesEthernetStatuses(org, total_pages="all", perPage=3)
        low = sum(1 for r in got if r["power"]["mode"] == "low")
        check(f"getOrganizationWirelessDevicesEthernetStatuses perPage=3, all pages ({low} APs on low power)", len(got) == 25 and low == 6 and got == emu.raw(f"{o}/wireless/devices/ethernet/statuses"), len(got))

        clients = d.wireless.getOrganizationWirelessDevicesPacketLossByClient(org, total_pages="all", perPage=100, timespan=7 * day)
        devices = d.wireless.getOrganizationWirelessDevicesPacketLossByDevice(org, total_pages="all", perPage=3, timespan=7 * day)
        nets = d.wireless.getOrganizationWirelessDevicesPacketLossByNetwork(org, total_pages="all", perPage=3, timespan=7 * day)
        lost = lambda rows, net: sum(r["downstream"]["lost"] for r in rows if r["network"]["id"] == net)
        check(f"getOrganizationWirelessDevicesPacketLoss by client, device and network agree ({len(clients)} clients)", len(devices) == 25 and len(nets) == 5 and all(lost(clients, n["network"]["id"]) == lost(devices, n["network"]["id"]) == n["downstream"]["lost"] for n in nets), nets[:1])

        got = items(d.wireless.getOrganizationWirelessDevicesPowerModeHistory(org, total_pages="all", perPage=3))
        check(f"getOrganizationWirelessDevicesPowerModeHistory perPage=3, all pages ({len(got)} APs)", len(got) == 25 and got[:20] == emu.raw(f"{o}/wireless/devices/power/mode/history?perPage=20")["items"], len(got))
        got = items(d.wireless.getOrganizationWirelessDevicesSystemCpuLoadHistory(org, total_pages="all", perPage=3, timespan=3600))
        check(f"getOrganizationWirelessDevicesSystemCpuLoadHistory perPage=3, all pages ({len(got)} APs)", len(got) == 25 and all(len(r["series"]) == 12 for r in got), [len(r["series"]) for r in got])

        got = items(d.wireless.getOrganizationWirelessSsidsStatusesByDevice(org, total_pages="all", perPage=3))
        ap = got[0]
        status = d.wireless.getDeviceWirelessStatus(ap["serial"])["basicServiceSets"]
        check(f"getOrganizationWirelessSsidsStatusesByDevice perPage=3, all pages, matches the AP status ({len(got)} APs)", len(got) == 25 and [b["bssid"] for b in ap["basicServiceSets"]] == [b["bssid"] for b in status], len(got))
        got = d.wireless.getOrganizationAssuranceImpactedDeviceWirelessByNetwork(org, total_pages="all", perPage=3, timespan=14 * day)
        check(f"getOrganizationAssuranceImpactedDeviceWirelessByNetwork perPage=3, all pages ({sum(r['counts']['total'] for r in got)} APs impacted)", len(got) == 5 and got == emu.raw(f"{o}/assurance/impactedDevice/wireless/byNetwork?timespan={14 * day}"), got)


@scenario
def switchports():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())
        o = f"/organizations/{org}"
        items = lambda got: got["items"] if isinstance(got, dict) else got
        hq = next(n["id"] for n in d.organizations.getOrganizationNetworks(org) if n["name"] == "HQ - San Francisco")

        got = d.switch.getOrganizationSwitchPortsOverview(org, timespan=86400)["counts"]
        active = got["byStatus"]["active"]
        check(f"getOrganizationSwitchPortsOverview ({active['total']} of {got['total']} ports active)", got["total"] == 358 and active["total"] + got["byStatus"]["inactive"]["total"] == got["total"], got)
        got = items(d.switch.getOrganizationSwitchPortsClientsOverviewByDevice(org, total_pages="all", perPage=3))
        sw = got[0]
        statuses = d.switch.getDeviceSwitchPortsStatuses(sw["serial"])
        counts = {s["portId"]: s["clientCount"] for s in statuses if s["clientCount"]}
        check(f"getOrganizationSwitchPortsClientsOverviewByDevice perPage=3, all pages, matches the port statuses ({len(got)} switches)", len(got) == 9 and {p["portId"]: p["counts"]["byStatus"]["online"] for p in sw["ports"]} == counts, sw["ports"][:3])
        got = items(d.switch.getOrganizationSwitchPortsTopologyDiscoveryByDevice(org, total_pages="all", perPage=3))
        check(f"getOrganizationSwitchPortsTopologyDiscoveryByDevice perPage=3, all pages ({sum(len(r['ports']) for r in got)} ports)", len(got) == 9 and got == emu.raw(f"{o}/switch/ports/topology/discovery/byDevice?perPage=20")["items"], len(got))
        got = items(d.switch.getOrganizationSwitchPortsUsageHistoryByDeviceByInterval(org, total_pages="all", perPage=3, interval=14400, timespan=86400))
        port = got[0]["ports"][0]
        check(f"getOrganizationSwitchPortsUsageHistoryByDeviceByInterval perPage=3, all pages ({len(got)} switches)", len(got) == 9 and len(port["intervals"]) in (6, 7) and got == emu.raw(f"{o}/switch/ports/usage/history/byDevice/byInterval?perPage=50&interval=14400&timespan=86400")["items"], len(got))

        got = d.switch.getNetworkSwitchDhcpV4ServersSeen(hq, total_pages="all", perPage=3)
        check(f"getNetworkSwitchDhcpV4ServersSeen perPage=3, all pages ({len(got)} VLANs)", len(got) >= 4 and got == emu.raw(f"/networks/{hq}/switch/dhcp/v4/servers/seen") and all(s["type"] == "device" for s in got), [s["vlan"] for s in got])

        got = d.appliance.getOrganizationApplianceDevicesInterfacesPortsByDevice(org)["items"]
        one = d.appliance.getOrganizationApplianceDevicesInterfacesPortsByDevice(org, serials=[got[0]["serial"]], numbers=["1", "3"])["items"]
        check(f"getOrganizationApplianceDevicesInterfacesPortsByDevice, serials and numbers filters ({len(got)} appliances)", len(got) == 5 and [p["number"] for p in one[0]["ports"]] == ["1", "3"], one)


# The unclaimed order the default seed gives Acme Corporation: an MX250, an
# MS130-24P, two MR46s and a co-term license for them.
ACME_ORDER = "4C9557446"


@scenario
def inventory():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
        d = dashboard(emu)
        org = acme(d.organizations.getOrganizations())
        o = f"/organizations/{org}"
        counted = lambda: sum(d.organizations.getOrganizationLicensesOverview(org)["licensedDeviceCounts"].values())

        got = d.licensing.getOrganizationLicensingCotermLicenses(org, total_pages="all", perPage=3)
        check(f"getOrganizationLicensingCotermLicenses perPage=3, all pages ({len(got)} licenses)", len(got) == 6 and got == emu.raw(f"{o}/licensing/coterm/licenses") and sum(c["count"] for l in got for c in l["counts"]) == counted(), len(got))

        before = counted()
        got = d.organizations.claimIntoOrganizationInventory(org, orders=[ACME_ORDER])
        rows = d.organizations.getOrganizationInventoryDevices(org, orderNumbers=[ACME_ORDER])
        check(f"claimIntoOrganizationInventory by order ({len(rows)} devices)", got["orders"] == [ACME_ORDER] and sorted(r["model"] for r in rows) == ["MR46", "MR46", "MS130-24P", "MX250"] and counted() == before + 4, got)
        spare = next(r["serial"] for r in rows if r["model"] == "MR46")
        got = d.organizations.releaseFromOrganizationInventory(org, serials=[spare])
        gone = not d.organizations.getOrganizationInventoryDevices(org, serials=[spare])
        back = d.organizations.claimIntoOrganizationInventory(org, serials=[spare])
        check("releaseFromOrganizationInventory, then claimed back by serial", got["serials"] == [spare] and gone and back["serials"] == [spare], got)

        other = d.organizations.createOrganization("Acme Spinoff")["id"]
        lic = next(l for l in d.licensing.getOrganizationLicensingCotermLicenses(org) if any(c["model"] == "MR Enterprise" for c in l["counts"]))
        got = d.licensing.moveOrganizationLicensingCotermLicenses(org, {"organizationId": other, "mode": "addDevices"}, [{"key": lic["key"], "counts": [{"model": "MR Enterprise", "count": 1}]}])
        moved = d.licensing.getOrganizationLicensingCotermLicenses(other)
        check("moveOrganizationLicensingCotermLicenses leaves a remainder and invalidates the license", len(got["remainderLicenses"]) == 1 and [m["key"] for m in moved] == [got["movedLicenses"][0]["key"]] and d.licensing.getOrganizationLicensingCotermLicenses(org, invalidated=True)[0]["key"] == lic["key"], got)

        nets = {n["name"]: n["id"] for n in d.organizations.getOrganizationNetworks(org)}
        austin, london = nets["Branch - Austin"], nets["Remote - London"]
        template = d.organizations.createOrganizationConfigTemplate(org, "Branch", copyFromNetworkId=austin)["id"]
        got = d.networks.bindNetwork(london, template, autoBind=True)
        ssid = d.wireless.getNetworkWirelessSsid(austin, 1)["name"]
        bound = d.organizations.getOrganizationNetworks(org, configTemplateId=template)
        check("bindNetwork with autoBind, settings read through the template", got["isBoundToConfigTemplate"] and got["configTemplateId"] == template and [n["id"] for n in bound] == [london] and d.wireless.getNetworkWirelessSsid(london, 1)["name"] == ssid, got)
        try:
            d.wireless.updateNetworkWirelessSsid(london, 1, name="Local")
            check("a bound network refuses settings writes", False, "no error")
        except meraki.APIError as e:
            check("a bound network refuses settings writes with 400", e.status == 400, e.status)
        got = d.networks.unbindNetwork(london, retainConfigs=True)
        check("unbindNetwork with retainConfigs keeps the template's settings", not got["isBoundToConfigTemplate"] and d.wireless.getNetworkWirelessSsid(london, 1)["name"] == ssid, got)

        got = d.networks.splitNetwork(nets["HQ - San Francisco"])["resultingNetworks"]
        devices = sum(len(d.networks.getNetworkDevices(n["id"])) for n in got)
        check(f"splitNetwork into {len(got)} networks with all {devices} devices", [n["productTypes"] for n in got] == [["appliance"], ["switch"], ["wireless"], ["camera"]] and devices == 17, [n["name"] for n in got])


@scenario
def webhooks():
    import http.server
    import threading

    got = []

    class Hook(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            got.append((dict(self.headers), self.rfile.read(int(self.headers["Content-Length"])).decode()))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    rx = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=rx.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{rx.server_address[1]}/hook"
    try:
        with Emulator("--rate-limit", "0", "--webhooks", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
            d = dashboard(emu)
            org = acme(d.organizations.getOrganizations())
            net = next(n["id"] for n in d.organizations.getOrganizationNetworks(org) if n["name"] == "HQ - San Francisco")

            got_list = d.networks.getNetworkWebhooksPayloadTemplates(net)
            check(f"getNetworkWebhooksPayloadTemplates lists the included templates ({len(got_list)})", [t["payloadTemplateId"] for t in got_list][:1] == ["wpt_00001"] and all(t["type"] == "included" for t in got_list), got_list[:1])
            t = d.networks.createNetworkWebhooksPayloadTemplate(net, "Ops", body='{"type":"{{alertTypeId}}","secret":{{sharedSecret | jsonify}}}', headers=[{"name": "X-Token", "template": "{{sharedSecret}}"}])
            tid = t["payloadTemplateId"]
            up = d.networks.updateNetworkWebhooksPayloadTemplate(net, tid, name="Ops v2")
            check("createNetworkWebhooksPayloadTemplate, then get and update it", d.networks.getNetworkWebhooksPayloadTemplate(net, tid) == up and up["name"] == "Ops v2" and up["type"] == "custom", up)

            job = d.networks.createNetworkWebhooksWebhookTest(net, url, sharedSecret="s3cret", payloadTemplateId=tid, alertTypeId="settings_changed")
            for _ in range(100):
                status = d.networks.getNetworkWebhooksWebhookTest(net, job["id"])["status"]
                if status in ("delivered", "abandoned"):
                    break
                time.sleep(0.05)
            body = json.loads(got[0][1]) if got else None
            check("createNetworkWebhooksWebhookTest sends the rendered template", job["status"] == "enqueued" and status == "delivered" and body == {"type": "settings_changed", "secret": "s3cret"} and got[0][0].get("X-Token") == "s3cret", (status, got))
            logs = d.organizations.getOrganizationWebhooksLogs(org, url=url)
            check("getOrganizationWebhooksLogs has the delivery", [(l["responseCode"], l["url"], l["networkId"]) for l in logs] == [(200, url, net)] and logs == emu.raw(f"/organizations/{org}/webhooks/logs?url={urllib.parse.quote(url, safe='')}"), logs)
            d.networks.deleteNetworkWebhooksPayloadTemplate(net, tid)
            check("deleteNetworkWebhooksPayloadTemplate", all(x["payloadTemplateId"] != tid for x in d.networks.getNetworkWebhooksPayloadTemplates(net)))

            types = d.organizations.getOrganizationWebhooksAlertTypes(org, productType="switch")
            check(f"getOrganizationWebhooksAlertTypes productType=switch ({len(types)})", types and all(x["example"]["alertTypeId"] == x["alertTypeId"] for x in types) and "power_supply_down" in [x["alertTypeId"] for x in types], types[:1])
            try:
                d.organizations.getOrganizationWebhooksCallbacksStatus(org, "1284392014819")
                check("getOrganizationWebhooksCallbacksStatus unknown ID", False, "no error")
            except meraki.APIError as e:
                check("getOrganizationWebhooksCallbacksStatus unknown ID answers 404", e.status == 404, e.status)

            a = d.organizations.createOrganizationAlertsProfile(org, "wanLatency", {"duration": 60, "window": 600, "latency_ms": 100, "interface": "wan1"}, {"emails": ["noc@example.com"]}, ["branch"], description="WAN latency")
            up = d.organizations.updateOrganizationAlertsProfile(org, a["id"], enabled=False)
            check("createOrganizationAlertsProfile, then list and update it", d.organizations.getOrganizationAlertsProfiles(org) == [up] and not up["enabled"] and up["alertCondition"]["latency_ms"] == 100, up)
            d.organizations.deleteOrganizationAlertsProfile(org, a["id"])
            check("deleteOrganizationAlertsProfile", d.organizations.getOrganizationAlertsProfiles(org) == [])
    finally:
        rx.shutdown()


@scenario
def livetools():
    import http.server
    import threading

    got = []

    class Hook(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            got.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    rx = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=rx.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{rx.server_address[1]}/cb"
    try:
        with Emulator("--rate-limit", "0", "--webhooks", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
            d = dashboard(emu)
            org = acme(d.organizations.getOrganizations())
            net = next(n["id"] for n in d.organizations.getOrganizationNetworks(org) if n["name"] == "HQ - San Francisco")
            devs = d.networks.getNetworkDevices(net)
            sw, ap, mx = (next(x["serial"] for x in devs if x["model"].startswith(m)) for m in ("MS", "CW", "MX"))
            lt = d.devices

            def same(name, job, read, key):
                check(f"{name} creates a job the GET returns", job["status"] == "complete" and read[key] == job[key] and read == emu.raw(job["url"]), (job, read))
                return read

            job = lt.createDeviceLiveToolsPing(sw, "8.8.8.8", count=3, callback={"url": url, "sharedSecret": "s3cret"})
            read = same("createDeviceLiveToolsPing", job, lt.getDeviceLiveToolsPing(sw, job["pingId"]), "pingId")
            check("getDeviceLiveToolsPing has three pings", read["results"]["sent"] == 3 and read["request"]["target"] == "8.8.8.8", read)
            for _ in range(100):
                cb = d.organizations.getOrganizationWebhooksCallbacksStatus(org, job["callback"]["id"])
                if cb["status"] != "running":
                    break
                time.sleep(0.05)
            check("getOrganizationWebhooksCallbacksStatus after a live tool callback", cb["status"] == "completed" and got and got[0]["alertData"] == read and got[0]["sharedSecret"] == "s3cret", (cb, got[:1]))
            job = lt.createDeviceLiveToolsPingDevice(ap, count=2)
            read = same("createDeviceLiveToolsPingDevice", job, lt.getDeviceLiveToolsPingDevice(ap, job["pingId"]), "pingId")
            check("getDeviceLiveToolsPingDevice sends two", read["results"]["sent"] == 2, read)
            job = lt.createDeviceLiveToolsArpTable(sw)
            read = same("createDeviceLiveToolsArpTable", job, lt.getDeviceLiveToolsArpTable(sw, job["arpTableId"]), "arpTableId")
            check(f"getDeviceLiveToolsArpTable lists entries ({len(read['entries'])})", len(read["entries"]) > 10, read["entries"][:1])
            job = lt.createDeviceLiveToolsMacTable(sw)
            read = same("createDeviceLiveToolsMacTable", job, lt.getDeviceLiveToolsMacTable(sw, job["macTableId"]), "macTableId")
            mac = read["entries"][0]["mac"]
            job = lt.createDeviceLiveToolsMacTable(sw, mac=mac.upper())
            check("getDeviceLiveToolsMacTable filters by MAC", [e["mac"] for e in lt.getDeviceLiveToolsMacTable(sw, job["macTableId"])["entries"]] == [mac], job)
            job = lt.createDeviceLiveToolsCableTest(sw, ["1", "2"])
            read = same("createDeviceLiveToolsCableTest", job, lt.getDeviceLiveToolsCableTest(sw, job["cableTestId"]), "cableTestId")
            check("getDeviceLiveToolsCableTest has a result per port", [r["port"] for r in read["results"]] == ["1", "2"] and all(len(r["pairs"]) == 4 for r in read["results"]), read)
            job = lt.createDeviceLiveToolsLedsBlink(ap, 20)
            same("createDeviceLiveToolsLedsBlink", job, lt.getDeviceLiveToolsLedsBlink(ap, job["ledsBlinkId"]), "ledsBlinkId")
            job = lt.createDeviceLiveToolsWakeOnLan(mx, 10, "00:11:22:33:44:55")
            same("createDeviceLiveToolsWakeOnLan", job, lt.getDeviceLiveToolsWakeOnLan(mx, job["wakeOnLanId"]), "wakeOnLanId")
            job = lt.createDeviceLiveToolsPortsCycle(sw, ["3", "5-6"])
            same("createDeviceLiveToolsPortsCycle", job, lt.getDeviceLiveToolsPortsCycle(sw, job["cyclePortId"]), "cyclePortId")
            job = lt.createDeviceLiveToolsPortsStatus(sw)
            read = same("createDeviceLiveToolsPortsStatus", job, lt.getDeviceLiveToolsPortsStatus(sw, job["jobId"]), "jobId")
            statuses = d.switch.getDeviceSwitchPortsStatuses(sw, timespan=300)
            check("getDeviceLiveToolsPortsStatus matches getDeviceSwitchPortsStatuses", [(r["portId"], r["status"]) for r in read["results"]] == [(int(s["portId"]), s["status"].lower()) for s in statuses], read["results"][:1])
            job = lt.createDeviceLiveToolsPowerUsage(sw)
            read = same("createDeviceLiveToolsPowerUsage", job, lt.getDeviceLiveToolsPowerUsage(sw, job["jobId"]), "jobId")
            check("getDeviceLiveToolsPowerUsage reports watts", read["results"]["peak"] >= read["results"]["instant"] > 0, read)
            job = lt.createDeviceLiveToolsThroughputTest(mx)
            same("createDeviceLiveToolsThroughputTest", job, lt.getDeviceLiveToolsThroughputTest(mx, job["throughputTestId"]), "throughputTestId")
            check("createDeviceLiveToolsThroughputTest reports a speed", job["result"]["speeds"]["downstream"] > 0, job)
            check("rebootDevice", lt.rebootDevice(ap) == {"success": True})
            try:
                lt.createDeviceLiveToolsThroughputTest(ap)
                check("createDeviceLiveToolsThroughputTest on an AP", False, "no error")
            except meraki.APIError as e:
                check("createDeviceLiveToolsThroughputTest on an AP answers 400", e.status == 400, e.status)
    finally:
        rx.shutdown()


@scenario
def actionbatches():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu:
        d = dashboard(emu)
        me = d.administered.getAdministeredIdentitiesMe()
        check("getAdministeredIdentitiesMe", me["name"] == "API Integration" and me["authentication"]["api"]["key"]["created"] is True, me)
        key = d.administered.generateAdministeredIdentitiesMeApiKeys()["key"]
        check("generateAdministeredIdentitiesMeApiKeys", len(key) == 40, key)
        suffixes = [k["suffix"] for k in d.administered.getAdministeredIdentitiesMeApiKeys()]
        check("getAdministeredIdentitiesMeApiKeys lists the SDK's key and the new one", suffixes == [KEY[-4:], key[-4:]], suffixes)
        check("a generated key works", dashboard(emu, api_key=key).organizations.getOrganizations() != [])
        d.administered.revokeAdministeredIdentitiesMeApiKeys(key[-4:])
        try:
            dashboard(emu, api_key=key).organizations.getOrganizations()
            check("revokeAdministeredIdentitiesMeApiKeys", False, "the key still works")
        except meraki.APIError as e:
            check("revokeAdministeredIdentitiesMeApiKeys makes the key answer 401", e.status == 401, e.status)

        org = acme(d.organizations.getOrganizations())
        net = next(n["id"] for n in d.organizations.getOrganizationNetworks(org) if n["name"] == "HQ - San Francisco")
        o = d.organizations
        vlan = {"id": "300", "name": "Batch", "subnet": "10.250.0.0/24", "applianceIp": "10.250.0.1"}
        batch = o.createOrganizationActionBatch(org, [{"resource": f"/networks/{net}/appliance/vlans", "operation": "create", "body": vlan}], confirmed=True, synchronous=True)
        check("createOrganizationActionBatch creates the VLAN", batch["status"]["completed"] and batch["status"]["createdResources"] == [{"id": "300", "uri": f"/networks/{net}/appliance/vlans/300"}] and d.appliance.getNetworkApplianceVlan(net, "300")["name"] == "Batch", batch)
        check("getOrganizationActionBatch", o.getOrganizationActionBatch(org, batch["id"]) == batch)
        preview = o.createOrganizationActionBatch(org, [{"resource": f"/networks/{net}/appliance/vlans/300", "operation": "update", "body": {"name": "Renamed"}}])
        check("an unconfirmed batch changes nothing", not preview["confirmed"] and d.appliance.getNetworkApplianceVlan(net, "300")["name"] == "Batch", preview)
        check("getOrganizationActionBatches filters by status", ids(o.getOrganizationActionBatches(org, status="pending")) == [preview["id"]])
        done = o.updateOrganizationActionBatch(org, preview["id"], confirmed=True)
        check("updateOrganizationActionBatch confirms it", done["status"]["completed"] and d.appliance.getNetworkApplianceVlan(net, "300")["name"] == "Renamed", done)
        failed = o.createOrganizationActionBatch(org, [{"resource": f"/networks/{net}/appliance/vlans/300", "operation": "destroy"}, {"resource": f"/networks/{net}/appliance/vlans/999", "operation": "destroy"}], confirmed=True)
        check("a failed batch rolls back", failed["status"]["failed"] and d.appliance.getNetworkApplianceVlan(net, "300")["name"] == "Renamed", failed)
        o.deleteOrganizationActionBatch(org, failed["id"])
        check("deleteOrganizationActionBatch", ids(o.getOrganizationActionBatches(org)) == [batch["id"], preview["id"]])


@scenario
def camera():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        c, n = d.camera, d.networks
        org = acme(d.organizations.getOrganizations())
        net = next(x["id"] for x in d.organizations.getOrganizationNetworks(org) if x["name"] == "HQ - San Francisco")
        up = [x["serial"] for x in d.organizations.getOrganizationDevicesStatuses(org, productTypes=["camera"], total_pages=-1) if x["status"] == "online" and x["networkId"] == net]
        serial = up[0]
        at = lambda minutes: (EVENTS_NOW - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")

        broker = n.createNetworkMqttBroker(net, "Sense", "mqtt.example.com", 8883, security={"mode": "tls", "tls": {"caCertificate": "LS0tLS1CRUdJTg==", "verifyHostnames": True}}, authentication={"username": "cams", "password": "hunter2"})
        upd = n.updateNetworkMqttBroker(net, broker["id"], port=1883)
        check("createNetworkMqttBroker hides its secrets, then get and update it", n.getNetworkMqttBroker(net, broker["id"]) == upd and upd["port"] == 1883 and upd["security"]["tls"]["hasCaCertificate"] and "hunter2" not in json.dumps(n.getNetworkMqttBrokers(net)), upd)
        models = c.getDeviceCameraSenseObjectDetectionModels(serial)
        sense = c.updateDeviceCameraSense(serial, senseEnabled=True, mqttBrokerId=broker["id"], detectionModelId=models[-1]["id"], audioDetection={"enabled": False})
        check("updateDeviceCameraSense publishes to the broker", c.getDeviceCameraSense(serial) == sense and sense["mqttBrokerId"] == broker["id"] and f"/merakimv/{serial}/raw_detections" in sense["mqttTopics"], sense)

        schedules = c.getNetworkCameraSchedules(net)
        p = c.createNetworkCameraQualityRetentionProfile(net, "Lobby", maxRetentionDays=7, scheduleId=schedules[0]["id"], videoSettings={"MV12/MV22/MV72": {"quality": "Enhanced", "resolution": "1920x1080"}})
        p2 = c.updateNetworkCameraQualityRetentionProfile(net, p["id"], audioRecordingEnabled=True)
        check("createNetworkCameraQualityRetentionProfile, then list, get and update it", c.getNetworkCameraQualityRetentionProfiles(net) == [p2] and c.getNetworkCameraQualityRetentionProfile(net, p["id"]) == p2 and p2["audioRecordingEnabled"], p2)
        q = c.updateDeviceCameraQualityAndRetention(serial, profileId=p["id"])
        check("updateDeviceCameraQualityAndRetention takes the profile's settings", c.getDeviceCameraQualityAndRetention(serial) == q and (q["quality"], q["resolution"], q["audioRecordingEnabled"]) == ("Enhanced", "1920x1080", True), q)
        v = c.updateDeviceCameraVideoSettings(serial, externalRtspEnabled=True)
        check("updateDeviceCameraVideoSettings adds the RTSP URL", c.getDeviceCameraVideoSettings(serial) == v and v["rtspUrl"].startswith("rtsp://"), v)

        link = c.getDeviceCameraVideoLink(serial, timestamp=at(60))
        check("getDeviceCameraVideoLink", link["url"].endswith(f"?timestamp={int((EVENTS_NOW - timedelta(minutes=60)).timestamp() * 1000)}") and "visionUrl" in link, link)
        snap = c.generateDeviceCameraSnapshot(serial, timestamp=at(30))
        check("generateDeviceCameraSnapshot", snap["url"].startswith("https://camera.example.com/") and snap["expiry"].startswith("Access to the image will expire at"), snap)
        clip = c.clipDeviceCamera(serial, at(10), at(7))
        check("clipDeviceCamera", clip["url"].endswith(".mp4"), clip)
        try:
            c.generateDeviceCameraSnapshot(serial, timestamp=at(8 * 24 * 60))
            check("generateDeviceCameraSnapshot outside retention", False, "no error")
        except meraki.APIError as e:
            check("generateDeviceCameraSnapshot outside the profile's retention answers 400", e.status == 400, e.status)

        c.deleteNetworkCameraQualityRetentionProfile(net, p["id"])
        n.deleteNetworkMqttBroker(net, broker["id"])
        check("deleting the profile and broker takes them off the camera", c.getDeviceCameraQualityAndRetention(serial)["profileId"] is None and c.getDeviceCameraSense(serial)["mqttBrokerId"] is None and n.getNetworkMqttBrokers(net) == [])


@scenario
def shaping():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        a, n = d.appliance, d.networks
        org = acme(d.organizations.getOrganizations())
        net = next(x["id"] for x in d.organizations.getOrganizationNetworks(org) if x["name"] == "HQ - San Francisco")

        g = a.updateNetworkApplianceTrafficShaping(net, globalBandwidthLimits={"limitUp": 2048, "limitDown": 5120})
        check("updateNetworkApplianceTrafficShaping", a.getNetworkApplianceTrafficShaping(net) == g and g["globalBandwidthLimits"]["limitUp"] == 2048, g)
        cats = n.getNetworkTrafficShapingApplicationCategories(net)["applicationCategories"]
        dscp = n.getNetworkTrafficShapingDscpTaggingOptions(net)
        check("getNetworkTrafficShapingApplicationCategories and getNetworkTrafficShapingDscpTaggingOptions", len(cats) > 0 and any(o["dscpTagValue"] == 46 for o in dscp), dscp)
        rules = a.updateNetworkApplianceTrafficShapingRules(net, defaultRulesEnabled=True, rules=[{"definitions": [{"type": "applicationCategory", "value": {"id": cats[0]["id"]}}, {"type": "host", "value": "video.example.com"}], "perClientBandwidthLimits": {"settings": "custom", "bandwidthLimits": {"limitUp": 1000, "limitDown": 5000}}, "dscpTagValue": dscp[-1]["dscpTagValue"], "priority": "high"}])
        check("updateNetworkApplianceTrafficShapingRules names the category", a.getNetworkApplianceTrafficShapingRules(net) == rules and rules["rules"][0]["definitions"][0]["value"]["name"] == cats[0]["name"], rules)
        bw = a.updateNetworkApplianceTrafficShapingUplinkBandwidth(net, bandwidthLimits={"wan2": {"limitUp": 20000, "limitDown": None}})
        check("updateNetworkApplianceTrafficShapingUplinkBandwidth", a.getNetworkApplianceTrafficShapingUplinkBandwidth(net) == bw and bw["bandwidthLimits"]["wan2"] == {"limitUp": 20000, "limitDown": None}, bw)

        cls = a.createNetworkApplianceTrafficShapingCustomPerformanceClass(net, "Video", maxLatency=150, maxJitter=40, maxLossPercentage=2)
        cid = cls["customPerformanceClassId"]
        upd = a.updateNetworkApplianceTrafficShapingCustomPerformanceClass(net, cid, maxJitter=30)
        check("createNetworkApplianceTrafficShapingCustomPerformanceClass, then list, get and update it", a.getNetworkApplianceTrafficShapingCustomPerformanceClasses(net) == [upd] and a.getNetworkApplianceTrafficShapingCustomPerformanceClass(net, cid) == upd and upd["maxJitter"] == 30, upd)
        sel = a.updateNetworkApplianceTrafficShapingUplinkSelection(net, loadBalancingEnabled=True, wanTrafficUplinkPreferences=[{"trafficFilters": [{"type": "custom", "value": {"protocol": "tcp", "source": {"cidr": "192.168.10.0/24"}, "destination": {"port": "443"}}}], "preferredUplink": "wan2"}], vpnTrafficUplinkPreferences=[{"trafficFilters": [{"type": "application", "value": {"id": cats[0]["applications"][0]["id"]}}], "preferredUplink": "bestForVoIP", "failOverCriterion": "poorPerformance", "performanceClass": {"type": "custom", "customPerformanceClassId": cid}}])
        check("updateNetworkApplianceTrafficShapingUplinkSelection", a.getNetworkApplianceTrafficShapingUplinkSelection(net) == sel and sel["defaultUplink"] == "wan1" and sel["vpnTrafficUplinkPreferences"][0]["performanceClass"]["customPerformanceClassId"] == cid, sel)
        sdwan = a.updateNetworkApplianceSdwanInternetPolicies(net, wanTrafficUplinkPreferences=[{"trafficFilters": [{"type": "custom", "value": {"protocol": "udp", "source": {}, "destination": {"port": "5060"}}}], "preferredUplink": "bestForVoIP", "performanceClass": {"type": "builtin", "builtinPerformanceClassName": "VoIP"}}])
        check("updateNetworkApplianceSdwanInternetPolicies sets the WAN preference rules", a.getNetworkApplianceTrafficShapingUplinkSelection(net)["wanTrafficUplinkPreferences"][0]["preferredUplink"] == "bestForVoIP", sdwan)
        try:
            a.deleteNetworkApplianceTrafficShapingCustomPerformanceClass(net, cid)
            check("deleteNetworkApplianceTrafficShapingCustomPerformanceClass while in use", False, "no error")
        except meraki.APIError as e:
            check("deleteNetworkApplianceTrafficShapingCustomPerformanceClass while in use answers 400", e.status == 400, e.status)
        a.updateNetworkApplianceTrafficShapingUplinkSelection(net, vpnTrafficUplinkPreferences=[])
        a.deleteNetworkApplianceTrafficShapingCustomPerformanceClass(net, cid)
        check("deleteNetworkApplianceTrafficShapingCustomPerformanceClass", a.getNetworkApplianceTrafficShapingCustomPerformanceClasses(net) == [])

        ex = a.updateNetworkApplianceTrafficShapingVpnExclusions(net, custom=[{"protocol": "tcp", "destination": "192.168.3.0/24", "port": "8000"}], majorApplications=[{"id": "meraki:vpnExclusion/application/2"}])
        rows = a.getOrganizationApplianceTrafficShapingVpnExclusionsByNetwork(org, perPage=3, total_pages=-1)
        rows = rows["items"] if isinstance(rows, dict) else rows
        check("updateNetworkApplianceTrafficShapingVpnExclusions and getOrganizationApplianceTrafficShapingVpnExclusionsByNetwork", ex["majorApplications"][0]["name"] == "Office 365 Sharepoint" and len(rows) == 5 and next(r for r in rows if r["networkId"] == net) == ex, rows)


@scenario
def firewall():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        a = d.appliance
        org = acme(d.organizations.getOrganizations())
        net = next(x["id"] for x in d.organizations.getOrganizationNetworks(org) if x["name"] == "HQ - San Francisco")

        fs = a.updateNetworkApplianceFirewallSettings(net, spoofingProtection={"ipSourceGuard": {"mode": "log"}})
        check("updateNetworkApplianceFirewallSettings", a.getNetworkApplianceFirewallSettings(net) == fs and fs["spoofingProtection"]["ipSourceGuard"]["mode"] == "log", fs)
        rule = {"comment": "Block telnet", "policy": "deny", "protocol": "tcp", "srcCidr": "Any", "destCidr": "10.0.0.0/8", "destPort": "23"}
        cell = a.updateNetworkApplianceFirewallCellularFirewallRules(net, rules=[rule])
        check("updateNetworkApplianceFirewallCellularFirewallRules adds the default rule", a.getNetworkApplianceFirewallCellularFirewallRules(net) == cell and [r["comment"] for r in cell["rules"]] == ["Block telnet", "Default rule"], cell)
        inbound = a.updateNetworkApplianceFirewallInboundCellularFirewallRules(net, rules=cell["rules"])
        check("updateNetworkApplianceFirewallInboundCellularFirewallRules takes the default rule back", a.getNetworkApplianceFirewallInboundCellularFirewallRules(net) == inbound == cell, inbound)
        nat = a.updateNetworkApplianceFirewallOneToManyNatRules(net, rules=[{"publicIp": "198.51.100.40", "uplink": "internet1", "portRules": [{"name": "Web", "protocol": "tcp", "publicPort": "9443", "localIp": "10.0.5.20", "localPort": "443"}]}])
        check("updateNetworkApplianceFirewallOneToManyNatRules", a.getNetworkApplianceFirewallOneToManyNatRules(net) == nat and nat["rules"][0]["portRules"][0]["allowedIps"] == ["any"], nat)

        vlan = a.getNetworkApplianceVlans(net)[0]["id"]
        mc = a.updateNetworkApplianceFirewallMulticastForwarding(net, rules=[{"description": "Paging", "address": "239.1.1.1", "vlanIds": [vlan]}])
        rows = a.getOrganizationApplianceFirewallMulticastForwardingByNetwork(org, perPage=3, total_pages=-1)
        rows = rows["items"] if isinstance(rows, dict) else rows
        check(f"updateNetworkApplianceFirewallMulticastForwarding and getOrganizationApplianceFirewallMulticastForwardingByNetwork perPage=3 ({len(rows)} networks)", len(rows) == 5 and next(r for r in rows if r["network"]["id"] == net) == mc, rows)
        up = a.updateNetworkApplianceUplinksNat(net, uplinks=[{"interface": "wan2", "nat": {"enabled": False}}])
        rows = a.getOrganizationApplianceUplinksNatByNetwork(org, perPage=3, total_pages=-1)
        check(f"updateNetworkApplianceUplinksNat and getOrganizationApplianceUplinksNatByNetwork perPage=3 ({len(rows)} networks)", len(rows) == 5 and next(r for r in rows if r["networkId"] == net)["uplinks"] == up["uplinks"] and up["uplinks"][1]["nat"]["enabled"] is False, rows)
        dest = a.updateNetworkApplianceConnectivityMonitoringDestinations(net, destinations=[{"ip": "1.1.1.1", "description": "Cloudflare", "default": True}])
        check("updateNetworkApplianceConnectivityMonitoringDestinations", a.getNetworkApplianceConnectivityMonitoringDestinations(net) == dest and dest["destinations"][0]["ip"] == "1.1.1.1", dest)

        primary = a.getNetworkApplianceWarmSpare(net)["primarySerial"]
        d.organizations.claimIntoOrganizationInventory(org, orders=[ACME_ORDER])
        spare = next(x["serial"] for x in d.organizations.getOrganizationInventoryDevices(org, orderNumbers=[ACME_ORDER]) if x["model"] == "MX250")
        d.networks.claimNetworkDevices(net, serials=[spare])
        ws = a.updateNetworkApplianceWarmSpare(net, True, spareSerial=spare, uplinkMode="virtual", virtualIp1="198.51.100.250", virtualIp2="203.0.113.250")
        check("updateNetworkApplianceWarmSpare in virtual mode", a.getNetworkApplianceWarmSpare(net) == ws and ws["spareSerial"] == spare and ws["wan1"] == {"ip": "198.51.100.250", "subnet": "198.51.100.0/24"}, ws)
        sw = a.swapNetworkApplianceWarmSpare(net)
        check("swapNetworkApplianceWarmSpare flips the roles", a.getNetworkApplianceWarmSpare(net) == sw and (sw["primarySerial"], sw["spareSerial"]) == (spare, primary), sw)


@scenario
def vpn():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        a = d.appliance
        org = acme(d.organizations.getOrganizations())
        nets = {x["name"]: x["id"] for x in d.organizations.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]

        neighbor = {"ip": "10.10.10.22", "remoteAsNumber": 64343, "ebgpHoldTimer": 180, "ebgpMultihop": 2, "sourceInterface": "wan1"}
        bgp = a.updateNetworkApplianceVpnBgp(hq, True, asNumber=65001, ibgpHoldTimer=120, neighbors=[neighbor])
        check("updateNetworkApplianceVpnBgp on the hub", a.getNetworkApplianceVpnBgp(hq) == bgp and bgp["enabled"] and bgp["neighbors"][0]["remoteAsNumber"] == 64343, bgp)
        spoke = a.getNetworkApplianceVpnBgp(nets["Branch - Austin"])
        check("getNetworkApplianceVpnBgp on a spoke shares the ASN", spoke["asNumber"] == 65001 and spoke["enabled"] is False, spoke)
        try:
            a.updateNetworkApplianceVpnBgp(nets["Branch - Austin"], True)
            check("updateNetworkApplianceVpnBgp refuses a spoke", False, "no error")
        except meraki.APIError as e:
            check("updateNetworkApplianceVpnBgp refuses a spoke", e.status == 400, e.message)

        slas = a.updateOrganizationApplianceVpnSiteToSiteIpsecPeersSlas(org, items=[{"name": "sla policy", "uri": "http://checkthisendpoint.com"}])
        sla = slas["items"][0]["id"]
        peer = {"name": "AWS", "publicIp": "203.0.113.10", "secret": "secret", "privateSubnets": ["172.31.0.0/16"], "ipsecPoliciesPreset": "aws", "slaPolicy": {"id": sla}}
        peers = a.updateOrganizationApplianceVpnThirdPartyVPNPeers(org, [peer, {**peer, "name": "Routed", "isRouteBased": True, "ebgpNeighbor": {"neighborIp": "169.254.0.2", "remoteAsNumber": 64600}}])
        check("updateOrganizationApplianceVpnThirdPartyVPNPeers", a.getOrganizationApplianceVpnThirdPartyVPNPeers(org) == peers and len(peers["peers"]) == 2 and peers["peers"][1]["ebgpNeighbor"]["ipVersion"] == 4, peers)
        read = a.getOrganizationApplianceVpnSiteToSiteIpsecPeersSlas(org)
        check("getOrganizationApplianceVpnSiteToSiteIpsecPeersSlas lists the peers using each policy", read["items"][0]["ipsec"]["peerIds"] == [p["peerId"] for p in peers["peers"]] and read["meta"]["counts"]["items"]["total"] == 1, read)

        rule = {"comment": "Web", "policy": "deny", "protocol": "tcp", "srcCidr": "10.0.0.0/8", "destCidr": "192.168.1.0/24", "destPort": "443"}
        fw = a.updateOrganizationApplianceVpnVpnFirewallRules(org, rules=[rule], syslogDefaultRule=True)
        check("updateOrganizationApplianceVpnVpnFirewallRules adds the default rule", a.getOrganizationApplianceVpnVpnFirewallRules(org) == fw and [r["comment"] for r in fw["rules"]] == ["Web", "Default rule"] and fw["rules"][1]["syslogEnabled"], fw)
        ids = a.updateOrganizationApplianceSecurityIntrusion(org, [{"ruleId": "meraki:intrusion/snort/GID/1/SID/19559"}])
        check("updateOrganizationApplianceSecurityIntrusion", a.getOrganizationApplianceSecurityIntrusion(org) == ids and ids["allowedRules"][0]["message"].startswith("INDICATOR-SCAN"), ids)


@scenario
def routing():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        s = d.switch
        org = acme(d.organizations.getOrganizations())
        nets = {x["name"]: x["id"] for x in d.organizations.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]
        switches = sorted((x for x in d.networks.getNetworkDevices(hq) if x["model"].startswith("MS")), key=lambda x: x["model"], reverse=True)
        core, floor = switches[0]["serial"], switches[1]["serial"]

        check("getDeviceSwitchRoutingInterfaces starts empty", s.getDeviceSwitchRoutingInterfaces(core) == [])
        ospf = s.updateNetworkSwitchRoutingOspf(hq, enabled=True, areas=[{"areaId": "0", "areaName": "Backbone", "areaType": "normal"}, {"areaId": "10", "areaName": "Floors", "areaType": "stub"}])
        check("updateNetworkSwitchRoutingOspf", s.getNetworkSwitchRoutingOspf(hq) == ospf and ospf["enabled"] and len(ospf["areas"]) == 2, ospf)
        iface = s.createDeviceSwitchRoutingInterface(core, "Users", vlanId=10, subnet="192.0.2.0/25", interfaceIp="192.0.2.2", defaultGateway="192.0.2.1", multicastRouting="enabled", ospfSettings={"area": "10"})
        check("createDeviceSwitchRoutingInterface", iface["serial"] == core and iface["uplinkV4"] and iface["ospfSettings"]["area"] == "10", iface)
        iid = iface["interfaceId"]
        put = s.updateDeviceSwitchRoutingInterface(core, iid, name="Staff")
        check("updateDeviceSwitchRoutingInterface", s.getDeviceSwitchRoutingInterface(core, iid) == put and put["name"] == "Staff", put)
        dhcp = s.updateDeviceSwitchRoutingInterfaceDhcp(core, iid, dhcpMode="dhcpServer", dnsNameserversOption="openDns")
        check("updateDeviceSwitchRoutingInterfaceDhcp", s.getDeviceSwitchRoutingInterfaceDhcp(core, iid) == dhcp and dhcp["dnsNameserversOption"] == "openDns", dhcp)
        route = s.createDeviceSwitchRoutingStaticRoute(core, "198.51.100.0/24", "192.0.2.10", name="Lab")
        rid = route["staticRouteId"]
        moved = s.updateDeviceSwitchRoutingStaticRoute(core, rid, advertiseViaOspfEnabled=True)
        check("updateDeviceSwitchRoutingStaticRoute", s.getDeviceSwitchRoutingStaticRoute(core, rid) == moved and s.getDeviceSwitchRoutingStaticRoutes(core) == [moved] and moved["advertiseViaOspfEnabled"], moved)
        try:
            s.getDeviceSwitchRoutingInterfaces(next(x["serial"] for x in d.networks.getNetworkDevices(nets["Branch - Austin"]) if x["model"].startswith("MS130")))
            check("getDeviceSwitchRoutingInterfaces refuses a switch that can't route", False, "no error")
        except meraki.APIError as e:
            check("getDeviceSwitchRoutingInterfaces refuses a switch that can't route", e.status == 400, e.message)

        flags = {"igmpSnoopingEnabled": False, "floodUnknownMulticastTrafficEnabled": True}
        m = s.updateNetworkSwitchRoutingMulticast(hq, overrides=[{"switches": [core], **flags}])
        check("updateNetworkSwitchRoutingMulticast", s.getNetworkSwitchRoutingMulticast(hq) == m and m["overrides"][0]["switches"] == [core], m)
        s.createDeviceSwitchRoutingInterface(floor, "Peer", vlanId=10, subnet="192.0.2.0/25", interfaceIp="192.0.2.3", defaultGateway="192.0.2.1", multicastRouting="enabled")
        rp = s.createNetworkSwitchRoutingMulticastRendezvousPoint(hq, "192.0.2.3", "Any")
        rp = s.updateNetworkSwitchRoutingMulticastRendezvousPoint(hq, rp["rendezvousPointId"], "192.0.2.3", "239.1.1.1")
        check("updateNetworkSwitchRoutingMulticastRendezvousPoint", s.getNetworkSwitchRoutingMulticastRendezvousPoint(hq, rp["rendezvousPointId"]) == rp and s.getNetworkSwitchRoutingMulticastRendezvousPoints(hq) == [rp] and rp["serial"] == floor, rp)

        job = d.devices.createDeviceLiveToolsMulticastRouting(core)
        res = d.devices.getDeviceLiveToolsMulticastRouting(core, job["multicastRoutingId"])
        check("getDeviceLiveToolsMulticastRouting", res["status"] == "complete" and res["interfaces"][0]["neighbors"] == ["192.0.2.3"] and res["routes"][0]["group"] == "239.1.1.1", res)

        s.deleteNetworkSwitchRoutingMulticastRendezvousPoint(hq, rp["rendezvousPointId"])
        s.deleteDeviceSwitchRoutingStaticRoute(core, rid)
        s.deleteDeviceSwitchRoutingInterface(core, iid)
        check("deleteDeviceSwitchRoutingInterface", s.getDeviceSwitchRoutingInterfaces(core) == [] and s.getNetworkSwitchRoutingMulticastRendezvousPoints(hq) == [])


@scenario
def switchpolicies():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        s = d.switch
        org = acme(d.organizations.getOrganizations())
        nets = {x["name"]: x["id"] for x in d.organizations.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]
        core = next(x["serial"] for x in d.networks.getNetworkDevices(hq) if x["model"].startswith("MS390"))

        acl = s.updateNetworkSwitchAccessControlLists(hq, [{"comment": "Deny SSH", "policy": "deny", "protocol": "tcp", "srcCidr": "10.1.10.0/24", "dstCidr": "any", "dstPort": "22", "vlan": "10"}])
        check("updateNetworkSwitchAccessControlLists", s.getNetworkSwitchAccessControlLists(hq) == acl and [r["comment"] for r in acl["rules"]] == ["Deny SSH", "Default rule"], acl)

        p = s.createNetworkSwitchAccessPolicy(hq, "Staff 802.1X", [{"host": "192.0.2.10", "port": 1812, "secret": "shh"}], False, hostMode="Multi-Domain")
        num = p["accessPolicyNumber"]
        check("createNetworkSwitchAccessPolicy", p["accessPolicyType"] == "Hybrid authentication" and "secret" not in p["radiusServers"][0], p)
        p = s.updateNetworkSwitchAccessPolicy(hq, num, radiusServers=[{"serverId": p["radiusServers"][0]["serverId"], "port": 1645}], guestVlanId=30)
        check("updateNetworkSwitchAccessPolicy", s.getNetworkSwitchAccessPolicy(hq, num) == p and s.getNetworkSwitchAccessPolicies(hq) == [p] and p["radiusServers"][0]["port"] == 1645, p)
        port = s.updateDeviceSwitchPort(core, "10", accessPolicyType="Custom access policy", accessPolicyNumber=int(num))
        check("updateDeviceSwitchPort takes an access policy", port["accessPolicyNumber"] == int(num) and s.getNetworkSwitchAccessPolicy(hq, num)["counts"]["ports"]["withThisPolicy"] == 1, port)
        try:
            s.deleteNetworkSwitchAccessPolicy(hq, num)
            check("deleteNetworkSwitchAccessPolicy refuses a policy in use", False, "no error")
        except meraki.APIError as e:
            check("deleteNetworkSwitchAccessPolicy refuses a policy in use", e.status == 400, e.message)
        s.updateDeviceSwitchPort(core, "10", accessPolicyType="Open")
        s.deleteNetworkSwitchAccessPolicy(hq, num)
        check("deleteNetworkSwitchAccessPolicy", s.getNetworkSwitchAccessPolicies(hq) == [])

        a = s.createNetworkSwitchQosRule(hq, 100, protocol="TCP", srcPort=2000, dscp=46)
        b = s.createNetworkSwitchQosRule(hq, None)
        a = s.updateNetworkSwitchQosRule(hq, a["id"], dstPortRange="3000-3100")
        check("updateNetworkSwitchQosRule", s.getNetworkSwitchQosRule(hq, a["id"]) == a and a["dstPortRange"] == "3000-3100", a)
        order = s.updateNetworkSwitchQosRulesOrder(hq, [b["id"], a["id"]])
        check("updateNetworkSwitchQosRulesOrder", s.getNetworkSwitchQosRulesOrder(hq) == order and [r["id"] for r in s.getNetworkSwitchQosRules(hq)] == [b["id"], a["id"]], order)
        s.deleteNetworkSwitchQosRule(hq, b["id"])
        check("deleteNetworkSwitchQosRule", s.getNetworkSwitchQosRulesOrder(hq)["ruleIds"] == [a["id"]])

        m = s.updateNetworkSwitchDscpToCosMappings(hq, [{"dscp": 1, "cos": 1, "title": "Video"}])
        check("updateNetworkSwitchDscpToCosMappings", s.getNetworkSwitchDscpToCosMappings(hq) == m and m["mappings"][0]["title"] == "Video", m)
        reset = s.updateNetworkSwitchDscpToCosMappings(hq, [])
        check("updateNetworkSwitchDscpToCosMappings resets", len(reset["mappings"]) == 6, reset)


@scenario
def policyobjects():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]

        web = o.createOrganizationPolicyObject(org, "Web Servers", "network", "cidr", cidr="10.0.0.0/24")
        check("createOrganizationPolicyObject", o.getOrganizationPolicyObject(org, web["id"]) == web and web["cidr"] == "10.0.0.0/24", web)
        site = o.createOrganizationPolicyObject(org, "Example", "network", "fqdn", fqdn="example.com")
        for i in range(10):
            o.createOrganizationPolicyObject(org, f"Host {i}", "network", "cidr", cidr=f"10.1.0.{i}")
        everything = o.getOrganizationPolicyObjects(org, total_pages="all", perPage=10)
        check("getOrganizationPolicyObjects pages", len(everything) == 12 and everything == o.getOrganizationPolicyObjects(org), len(everything))

        g = o.createOrganizationPolicyObjectsGroup(org, "Servers", objectIds=[web["id"]])
        check("createOrganizationPolicyObjectsGroup", o.getOrganizationPolicyObjectsGroup(org, g["id"]) == g and g["objectIds"] == [int(web["id"])], g)
        web = o.updateOrganizationPolicyObject(org, web["id"], name="Web Tier", groupIds=[])
        check("updateOrganizationPolicyObject", web["name"] == "Web Tier" and o.getOrganizationPolicyObjectsGroup(org, g["id"])["objectIds"] == [], web)
        g = o.updateOrganizationPolicyObjectsGroup(org, g["id"], objectIds=[web["id"], site["id"]])
        check("updateOrganizationPolicyObjectsGroup", o.getOrganizationPolicyObject(org, site["id"])["groupIds"] == [g["id"]] and o.getOrganizationPolicyObjectsGroups(org, total_pages="all", perPage=10) == [g], g)

        d.appliance.updateNetworkApplianceFirewallL3FirewallRules(hq, rules=[{"comment": "Objects", "policy": "deny", "protocol": "any", "srcCidr": "Any", "destCidr": f"GRP({g['id']})"}])
        check("L3 rules name a group", o.getOrganizationPolicyObject(org, web["id"])["networkIds"] == [hq] and o.getOrganizationPolicyObjectsGroup(org, g["id"])["networkIds"] == [hq])
        try:
            o.deleteOrganizationPolicyObjectsGroup(org, g["id"])
            check("deleteOrganizationPolicyObjectsGroup refuses a group in use", False, "no error")
        except meraki.APIError as e:
            check("deleteOrganizationPolicyObjectsGroup refuses a group in use", e.status == 400, e.message)
        d.appliance.updateNetworkApplianceFirewallL3FirewallRules(hq, rules=[])
        o.deleteOrganizationPolicyObjectsGroup(org, g["id"])
        o.deleteOrganizationPolicyObject(org, web["id"])
        check("deleteOrganizationPolicyObject", len(o.getOrganizationPolicyObjects(org)) == 11 and o.getOrganizationPolicyObjectsGroups(org) == [])


@scenario
def switchsettings():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        s = d.switch
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]
        sw = o.getOrganizationDevices(org, networkIds=[hq], productTypes=["switch"])
        core = next(x["serial"] for x in sw if x["model"] == "MS390-48UX")
        f2, f3 = sorted(x["serial"] for x in sw if x["model"] == "MS250-48FP")

        stp = s.updateNetworkSwitchStp(hq, rstpEnabled=True, stpBridgePriority=[{"switches": [core], "stpPriority": 4096}])
        check("updateNetworkSwitchStp", s.getNetworkSwitchStp(hq) == stp and stp["stpBridgePriority"][0]["switches"] == [core], stp)
        mtu = s.updateNetworkSwitchMtu(hq, defaultMtuSize=9000, overrides=[{"switches": [f2, f3], "mtuSize": 1500}])
        check("updateNetworkSwitchMtu", s.getNetworkSwitchMtu(hq) == mtu and mtu["defaultMtuSize"] == 9000, mtu)
        storm = s.updateNetworkSwitchStormControl(hq, broadcastThreshold=30, multicastThreshold=30, treatTheseTrafficTypesAsOneThreshold=["broadcast", "multicast"])
        check("updateNetworkSwitchStormControl", s.getNetworkSwitchStormControl(hq) == storm and storm["unknownUnicastThreshold"] == 100, storm)
        ami = s.updateNetworkSwitchAlternateManagementInterface(hq, enabled=True, vlanId=10, protocols=["snmp", "syslog"], switches=[{"serial": f2, "alternateManagementIp": "10.1.10.20"}])
        check("updateNetworkSwitchAlternateManagementInterface", s.getNetworkSwitchAlternateManagementInterface(hq) == ami and ami["switches"][0]["serial"] == f2, ami)

        ports = [{"serial": core, "portId": p} for p in ("10", "11")]
        lag = s.createNetworkSwitchLinkAggregation(hq, switchPorts=ports)
        check("createNetworkSwitchLinkAggregation", s.getNetworkSwitchLinkAggregations(hq) == [lag] and lag["switchPorts"] == ports, lag)
        lag = s.updateNetworkSwitchLinkAggregation(hq, lag["id"], switchPorts=ports + [{"serial": core, "portId": "12"}])
        check("updateNetworkSwitchLinkAggregation", len(s.getNetworkSwitchLinkAggregations(hq)[0]["switchPorts"]) == 3, lag)
        try:
            s.createNetworkSwitchLinkAggregation(hq, switchPorts=ports)
            check("createNetworkSwitchLinkAggregation refuses taken ports", False, "no error")
        except meraki.APIError as e:
            check("createNetworkSwitchLinkAggregation refuses taken ports", e.status == 400, e.message)
        s.deleteNetworkSwitchLinkAggregation(hq, lag["id"])
        check("deleteNetworkSwitchLinkAggregation", s.getNetworkSwitchLinkAggregations(hq) == [])

        spare = s.updateDeviceSwitchWarmSpare(f2, True, spareSerial=f3)
        check("updateDeviceSwitchWarmSpare", spare == {"enabled": True, "primarySerial": f2, "spareSerial": f3} and s.getDeviceSwitchWarmSpare(f3) == spare, spare)
        off = s.updateDeviceSwitchWarmSpare(f2, False)
        check("getDeviceSwitchWarmSpare after disabling", off == s.getDeviceSwitchWarmSpare(f2) and not off["enabled"], off)


@scenario
def switchdhcp():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        s = d.switch
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]
        sw = o.getOrganizationDevices(org, networkIds=[hq], productTypes=["switch"])
        f2, f3 = sorted(x["serial"] for x in sw if x["model"] == "MS250-48FP")

        p = s.updateNetworkSwitchDhcpServerPolicy(hq, defaultPolicy="block", allowedServers=["00:50:56:00:00:01"], arpInspection={"enabled": True})
        check("updateNetworkSwitchDhcpServerPolicy", s.getNetworkSwitchDhcpServerPolicy(hq) == p and p["defaultPolicy"] == "block" and len(p["alwaysAllowedServers"]) == 4, p)
        made = [s.createNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer(hq, f"00:11:22:33:44:{n:02x}", 100, {"address": f"10.0.0.{n}"}) for n in range(1, 6)]
        listed = s.getNetworkSwitchDhcpServerPolicyArpInspectionTrustedServers(hq, total_pages=-1, perPage=3)
        check("createNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer", listed == made, listed)
        t = s.updateNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer(hq, made[0]["trustedServerId"], vlan=200)
        check("updateNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer", t["vlan"] == 200 and t["mac"] == made[0]["mac"], t)
        s.deleteNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer(hq, made[0]["trustedServerId"])
        check("deleteNetworkSwitchDhcpServerPolicyArpInspectionTrustedServer", len(s.getNetworkSwitchDhcpServerPolicyArpInspectionTrustedServers(hq, total_pages=-1)) == 4)
        warn = s.getNetworkSwitchDhcpServerPolicyArpInspectionWarningsByDevice(hq, total_pages=-1)
        check("getNetworkSwitchDhcpServerPolicyArpInspectionWarningsByDevice", [w["serial"] for w in warn] == [f2, f3] and not warn[0]["hasTrustedPort"], warn)

        sched = s.createNetworkSwitchPortSchedule(hq, "Weekdays", portSchedule={"saturday": {"active": False}, "monday": {"from": "9:00", "to": "17:00"}})
        check("createNetworkSwitchPortSchedule", s.getNetworkSwitchPortSchedules(hq) == [sched] and sched["portSchedule"]["sunday"]["active"], sched)
        sched = s.updateNetworkSwitchPortSchedule(hq, sched["id"], name="Office")
        check("updateNetworkSwitchPortSchedule", sched["name"] == "Office" and sched["portSchedule"]["monday"]["to"] == "17:00", sched)
        port = s.updateDeviceSwitchPort(f2, "10", portScheduleId=sched["id"], name="Desk")
        check("updateDeviceSwitchPort with a schedule", port["schedule"] == {"id": sched["id"], "name": "Office"}, port)
        c = s.cloneOrganizationSwitchDevices(org, f2, [f3])
        cloned = s.getDeviceSwitchPort(f3, "10")
        check("cloneOrganizationSwitchDevices", c == {"sourceSerial": f2, "targetSerials": [f3]} and cloned["name"] == "Desk" and cloned["portScheduleId"] == sched["id"], cloned)
        try:
            s.deleteNetworkSwitchPortSchedule(hq, sched["id"])
            check("deleteNetworkSwitchPortSchedule refuses a schedule in use", False, "no error")
        except meraki.APIError as e:
            check("deleteNetworkSwitchPortSchedule refuses a schedule in use", e.status == 400, e.message)
        for serial in (f2, f3):
            s.updateDeviceSwitchPort(serial, "10", portScheduleId=None)
        s.deleteNetworkSwitchPortSchedule(hq, sched["id"])
        check("deleteNetworkSwitchPortSchedule", s.getNetworkSwitchPortSchedules(hq) == [])


@scenario
def wirelessradio():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        w = d.wireless
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq, reno = nets["HQ - San Francisco"], nets["Warehouse - Reno"]
        aps = sorted(x["serial"] for x in o.getOrganizationDevices(org, total_pages=-1, productTypes=["wireless"]))
        ap = sorted(x["serial"] for x in o.getOrganizationDevices(org, networkIds=[hq], productTypes=["wireless"]))[0]

        before = w.getDeviceWirelessRadioOverrides(ap)
        check("getDeviceWirelessRadioOverrides", [r["band"] for r in before["radios"]] == ["2.4", "5", "6"] and before["radios"][1]["channel"] is None, before)
        o1 = w.updateDeviceWirelessRadioOverrides(ap, radios=[{"index": "1", "channel": 149, "channelWidth": 80, "targetPower": 17}, {"index": "2", "enabled": False}])
        settings = w.getDeviceWirelessRadioSettings(ap)
        check("updateDeviceWirelessRadioOverrides", o1["radios"][2]["targetPower"] == -1 and settings["fiveGhzSettings"] == {"channel": 149, "channelWidth": 80, "targetPower": 17}, o1)
        rows = w.getOrganizationWirelessRadioOverridesByDevice(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessRadioOverridesByDevice", [r["serial"] for r in rows] == aps and o1 in rows, len(rows))
        pages = w.getOrganizationWirelessRfProfilesAssignmentsByDevice(org, models=["MR78"])
        check("getOrganizationWirelessRfProfilesAssignmentsByDevice", len(pages) == 1 and pages[0]["items"] and all(r["rfProfile"]["isOutdoorDefault"] for r in pages[0]["items"]), pages)
        # Each page is a one-item array, so the SDK hands back one envelope per page.
        paged = w.getOrganizationWirelessRfProfilesAssignmentsByDevice(org, total_pages=-1, perPage=3)
        check("getOrganizationWirelessRfProfilesAssignmentsByDevice pages", [r["serial"] for p in paged for r in p["items"]] == aps, len(paged))

        rrm = w.updateNetworkWirelessRadioRrm(hq, ai={"enabled": True}, fra={"enabled": True}, busyHour={"schedule": {"mode": "manual", "manual": {"start": "09:00", "end": "12:00"}}})
        check("updateNetworkWirelessRadioRrm", rrm["ai"]["enabled"] and rrm["ai"]["lastEnabledAt"] and rrm["busyHour"]["schedule"]["manual"]["start"] == "09:00", rrm)
        listed = w.getOrganizationWirelessRadioRrmByNetwork(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessRadioRrmByNetwork", rrm in listed and len(listed) == 5, len(listed))
        r = w.recalculateOrganizationWirelessRadioAutoRfChannels(org, [hq, reno])
        check("recalculateOrganizationWirelessRadioAutoRfChannels", r["estimatedCompletedAt"] > EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ"), r)

        scan = w.getNetworkWirelessAirMarshal(reno, timespan=86400)
        rogue = [x for x in scan if "rogue" in x["types"]]
        check("getNetworkWirelessAirMarshal", len(rogue) == 1 and rogue[0]["wiredMacs"], scan)
        rule = w.createNetworkWirelessAirMarshalRule(reno, "block", {"type": "exact", "string": rogue[0]["ssid"]})
        contained = [x for x in w.getNetworkWirelessAirMarshal(reno, timespan=86400) if x["ssid"] == rogue[0]["ssid"]][0]
        check("createNetworkWirelessAirMarshalRule", rule["type"] == "block" and all(b["contained"] for b in contained["bssids"]), rule)
        rule = w.updateNetworkWirelessAirMarshalRule(reno, rule["ruleId"], type="alert")
        check("updateNetworkWirelessAirMarshalRule", rule["type"] == "alert" and rule["match"]["type"] == "exact", rule)
        made = [w.createNetworkWirelessAirMarshalRule(hq, "allow", {"type": "contains", "string": f"Neighbor{n}"}) for n in range(4)]
        all_rules = w.getOrganizationWirelessAirMarshalRules(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessAirMarshalRules", sorted(x["ruleId"] for x in all_rules) == sorted([rule["ruleId"]] + [m["ruleId"] for m in made]), all_rules)
        w.deleteNetworkWirelessAirMarshalRule(reno, rule["ruleId"])
        check("deleteNetworkWirelessAirMarshalRule", w.getOrganizationWirelessAirMarshalRules(org, networkIds=[reno])["items"] == [])
        s = w.updateNetworkWirelessAirMarshalSettings(reno, "allow")
        by = w.getOrganizationWirelessAirMarshalSettingsByNetwork(org, total_pages=-1, perPage=3)["items"]
        check("updateNetworkWirelessAirMarshalSettings", s == {"networkId": reno, "defaultPolicy": "allow"} and s in by, s)
        check("getOrganizationWirelessAirMarshalSettingsByNetwork", len(by) == 5, by)


@scenario
def wirelesslocation():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        w = d.wireless
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq, austin = nets["HQ - San Francisco"], nets["Branch - Austin"]
        ap = sorted(x["serial"] for x in o.getOrganizationDevices(org, networkIds=[hq], productTypes=["wireless"]))[0]

        bt = w.updateNetworkWirelessBluetoothSettings(hq, scanningEnabled=True, majorMinorAssignmentMode="Non-unique", major=7, minor=2)
        check("updateNetworkWirelessBluetoothSettings", bt["scanningEnabled"] and bt["major"] == 7, bt)
        check("getNetworkWirelessBluetoothSettings", w.getNetworkWirelessBluetoothSettings(hq) == bt, bt)
        dev = w.updateDeviceWirelessBluetoothSettings(ap, minor=40)
        check("updateDeviceWirelessBluetoothSettings", dev == {"uuid": bt["uuid"], "major": 7, "minor": 40}, dev)
        check("getDeviceWirelessBluetoothSettings", w.getDeviceWirelessBluetoothSettings(ap) == dev, dev)
        clients = d.networks.getNetworkBluetoothClients(hq, total_pages=-1, perPage=5)
        check("getNetworkBluetoothClients", clients == [], clients)
        try:
            d.networks.getNetworkBluetoothClient(hq, "1284392014819")
            check("getNetworkBluetoothClient", False, "no 404")
        except meraki.APIError as e:
            check("getNetworkBluetoothClient", e.status == 404, e.status)

        entry = {"serial": ap, "alternateManagementIp": "10.9.0.5", "subnetMask": "255.255.255.0", "gateway": "10.9.0.1", "dns1": "8.8.8.8", "dns2": "8.8.4.4"}
        ami = w.updateNetworkWirelessAlternateManagementInterface(hq, enabled=True, vlanId=100, protocols=["radius", "syslog"], accessPoints=[entry])
        check("updateNetworkWirelessAlternateManagementInterface", ami["accessPoints"] == [entry], ami)
        check("getNetworkWirelessAlternateManagementInterface", w.getNetworkWirelessAlternateManagementInterface(hq) == ami, ami)
        v6 = {"protocol": "ipv6", "assignmentMode": "static", "address": "2001:db8:3c4d:15::1", "gateway": "fe80::1", "prefix": "2001:db8:3c4d:15::/64", "nameservers": {"addresses": ["2001:4860:4860::8888"]}}
        r = w.updateDeviceWirelessAlternateManagementInterfaceIpv6(ap, addresses=[v6])
        check("updateDeviceWirelessAlternateManagementInterfaceIpv6", r == {"addresses": [v6]}, r)

        bill = w.updateNetworkWirelessBilling(hq, currency="EUR", plans=[{"price": 5, "bandwidthLimits": {"limitUp": 1000, "limitDown": 2000}, "timeLimit": "1 hour"}])
        check("updateNetworkWirelessBilling", bill["currency"] == "EUR" and bill["plans"][0]["id"] == "1", bill)
        check("getNetworkWirelessBilling", w.getNetworkWirelessBilling(hq) == bill, bill)

        scan = w.updateNetworkWirelessLocationScanning(hq, enabled=True, api={"enabled": True})
        check("updateNetworkWirelessLocationScanning", scan["api"]["enabled"] and len(scan["api"]["validator"]["string"]) == 40, scan)
        rows = w.getOrganizationWirelessLocationScanningByNetwork(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessLocationScanningByNetwork", len(rows) == 5 and {"networkId": hq, "name": "HQ - San Francisco", **scan} in rows, len(rows))
        rx = [w.createOrganizationWirelessLocationScanningReceiver(org, {"id": n}, f"https://rx{i}.example.com", "3", {"type": "Wi-Fi"}, "secret") for i, n in enumerate([hq, austin, hq, austin])]
        check("createOrganizationWirelessLocationScanningReceiver", rx[0]["network"]["id"] == hq and "sharedSecret" not in rx[0], rx[0])
        u = w.updateOrganizationWirelessLocationScanningReceiver(org, rx[0]["receiverId"], radio={"type": "Bluetooth"})
        check("updateOrganizationWirelessLocationScanningReceiver", u["radio"]["type"] == "Bluetooth" and u["url"] == rx[0]["url"], u)
        listed = w.getOrganizationWirelessLocationScanningReceivers(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessLocationScanningReceivers", [x["receiverId"] for x in listed] == [x["receiverId"] for x in rx], listed)
        w.deleteOrganizationWirelessLocationScanningReceiver(org, rx[0]["receiverId"])
        left = w.getOrganizationWirelessLocationScanningReceivers(org, networkIds=[hq])["items"]
        check("deleteOrganizationWirelessLocationScanningReceiver", [x["receiverId"] for x in left] == [rx[2]["receiverId"]], left)

        broker = d.networks.createNetworkMqttBroker(austin, "Hub", "mqtt.example.com", 1883)
        m = w.updateOrganizationWirelessMqttSettings(org, {"id": austin}, {"enabled": True, "topic": "meraki", "broker": {"name": "Hub"}}, ble={"enabled": True, "type": "ibeacon"})
        check("updateOrganizationWirelessMqttSettings", m["mqtt"]["broker"] == {"id": broker["id"], "name": "Hub"} and m["ble"]["type"] == "ibeacon", m)
        rows = w.getOrganizationWirelessMqttSettings(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessMqttSettings", len(rows) == 5 and m in rows, len(rows))


@scenario
def ssidprofiles():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        w = d.wireless
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq, austin = nets["HQ - San Francisco"], nets["Branch - Austin"]

        made = [w.createOrganizationWirelessSsidsProfile(org, name, {"security": {"mode": "psk", "encryption": {"passphrase": "correct horse"}}}) for name in ["Delta", "Alpha", "Charlie", "Bravo"]]
        check("createOrganizationWirelessSsidsProfile", made[0]["ssid"]["security"]["mode"] == "psk" and "passphrase" not in made[0]["ssid"]["security"]["encryption"], made[0])
        u = w.updateOrganizationWirelessSsidsProfile(org, made[0]["id"], ssid={"advertisement": {"enabled": False}})
        check("updateOrganizationWirelessSsidsProfile", u["ssid"]["advertisement"]["enabled"] is False and u["ssid"]["name"] == "Delta", u)
        listed = w.getOrganizationWirelessSsidsProfiles(org, total_pages=-1, perPage=3)
        check("getOrganizationWirelessSsidsProfiles", [x["name"] for x in listed] == ["Alpha", "Bravo", "Charlie", "Delta"] and u in listed, [x["name"] for x in listed])
        over = w.getOrganizationWirelessSsidsProfilesOverviews(org, total_pages=-1, perPage=3)
        check("getOrganizationWirelessSsidsProfilesOverviews", over == listed, len(over))

        a = w.createOrganizationWirelessSsidsProfilesAssignment(org, {"id": made[0]["id"]}, {"number": 1}, network={"id": hq})
        check("createOrganizationWirelessSsidsProfilesAssignment", a["network"]["id"] == hq and a["ssid"]["number"] == 1 and a["profile"]["name"] == "Delta", a)
        b = w.createOrganizationWirelessSsidsProfilesAssignment(org, {"id": made[1]["id"]}, {"number": 0}, network={"id": austin})
        rows = w.getOrganizationWirelessSsidsProfilesAssignments(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessSsidsProfilesAssignments", rows == [a, b], rows)
        by = w.getOrganizationWirelessSsidsProfilesAssignmentsByNetwork(org, total_pages=-1, perPage=3, includeAllNetworks=True)
        hq_row = next(x for x in by if x["id"] == hq)
        check("getOrganizationWirelessSsidsProfilesAssignmentsByNetwork", len(by) == 5 and hq_row["assignments"] == [{"profile": a["profile"], "ssid": a["ssid"]}], hq_row)
        # The SDK's delete sends no body, so the SSID it names never reaches the API.
        try:
            w.deleteOrganizationWirelessSsidsProfilesAssignments(org, {"id": b["ssid"]["id"]})
            check("deleteOrganizationWirelessSsidsProfilesAssignments", False, "no 400")
        except meraki.APIError as e:
            check("deleteOrganizationWirelessSsidsProfilesAssignments", e.status == 400, e.message)
        try:
            w.deleteOrganizationWirelessSsidsProfile(org, made[0]["id"])
            check("deleteOrganizationWirelessSsidsProfile in use", False, "no 400")
        except meraki.APIError as e:
            check("deleteOrganizationWirelessSsidsProfile in use", e.status == 400, e.message)
        w.deleteOrganizationWirelessSsidsProfile(org, made[2]["id"])
        check("deleteOrganizationWirelessSsidsProfile", len(w.getOrganizationWirelessSsidsProfiles(org)) == 3, "")

        entries = [w.createOrganizationWirelessSsidsFirewallIsolationAllowlistEntry(org, {"mac": f"00:11:22:33:44:5{i}"}, {"number": 2}, {"id": hq}, description=f"Printer {i}") for i in range(4)]
        check("createOrganizationWirelessSsidsFirewallIsolationAllowlistEntry", entries[0]["entryId"] == "1" and entries[0]["network"]["id"] == hq, entries[0])
        e = w.updateOrganizationWirelessSsidsFirewallIsolationAllowlistEntry(org, "1", description="Lab printer")
        check("updateOrganizationWirelessSsidsFirewallIsolationAllowlistEntry", e["description"] == "Lab printer" and e["client"] == entries[0]["client"], e)
        listed = w.getOrganizationWirelessSsidsFirewallIsolationAllowlistEntries(org, total_pages=-1, perPage=3)["items"]
        check("getOrganizationWirelessSsidsFirewallIsolationAllowlistEntries", [x["entryId"] for x in listed] == ["1", "2", "3", "4"] and listed[0] == e, len(listed))
        w.deleteOrganizationWirelessSsidsFirewallIsolationAllowlistEntry(org, "1")
        left = w.getOrganizationWirelessSsidsFirewallIsolationAllowlistEntries(org, ssids=[2])["items"]
        check("deleteOrganizationWirelessSsidsFirewallIsolationAllowlistEntry", [x["entryId"] for x in left] == ["2", "3", "4"], left)

        roam = w.updateNetworkWirelessSsidOpenRoaming(hq, 1, enabled=True, tenantId="42")
        rows = w.getOrganizationWirelessSsidsOpenRoamingByNetwork(org, total_pages=-1, perPage=3)["items"]
        hq_row = next(x for x in rows if x["networkId"] == hq)
        check("getOrganizationWirelessSsidsOpenRoamingByNetwork", len(rows) == 5 and hq_row["ssid"][1]["openRoaming"] == roam, hq_row["ssid"][1])


@scenario
def wirelessdevices():
    with Emulator("--rate-limit", "0", "--now", EVENTS_NOW.strftime("%Y-%m-%dT%H:%M:%SZ")) as emu, sdk_clock(EVENTS_NOW):
        d = dashboard(emu)
        o = d.organizations
        w = d.wireless
        org = acme(o.getOrganizations())
        nets = {x["name"]: x["id"] for x in o.getOrganizationNetworks(org)}
        hq = nets["HQ - San Francisco"]
        aps = sorted(x["serial"] for x in o.getOrganizationDevices(org, networkIds=[hq], productTypes=["wireless"]))

        listed = w.getNetworkWirelessEthernetPortsProfiles(hq)
        check("getNetworkWirelessEthernetPortsProfiles", [(x["profileId"], x["isDefault"]) for x in listed] == [("1001", True)] and listed[0]["ports"][0]["ssid"] == 1, listed)
        p = w.createNetworkWirelessEthernetPortsProfile(hq, "Lobby", [{"name": "Kiosk", "ssid": 2, "pskGroupId": "100"}], usbPorts=[{"name": "usb", "enabled": False}])
        check("createNetworkWirelessEthernetPortsProfile", p["profileId"] == "1002" and p["ports"] == [{"name": "Kiosk", "number": 1, "enabled": True, "ssid": 2, "pskGroupId": "100"}], p)
        u = w.updateNetworkWirelessEthernetPortsProfile(hq, p["profileId"], name="Lobby 2")
        check("updateNetworkWirelessEthernetPortsProfile", u["name"] == "Lobby 2" and u["ports"] == p["ports"], u)
        check("getNetworkWirelessEthernetPortsProfile", w.getNetworkWirelessEthernetPortsProfile(hq, p["profileId"]) == u, "")
        a = w.assignNetworkWirelessEthernetPortsProfiles(hq, aps[:2], p["profileId"])
        check("assignNetworkWirelessEthernetPortsProfiles", a == {"serials": aps[:2], "profileId": p["profileId"]}, a)
        s = w.setNetworkWirelessEthernetPortsProfilesDefault(hq, p["profileId"])
        check("setNetworkWirelessEthernetPortsProfilesDefault", s == {"profileId": p["profileId"]} and [x["isDefault"] for x in w.getNetworkWirelessEthernetPortsProfiles(hq)] == [False, True], s)
        w.deleteNetworkWirelessEthernetPortsProfile(hq, "1001")
        check("deleteNetworkWirelessEthernetPortsProfile", [x["profileId"] for x in w.getNetworkWirelessEthernetPortsProfiles(hq)] == ["1002"], "")

        spare = o.getOrganizationInventoryDevices(org, usedState="unused", productTypes=["wireless"])[0]["serial"]
        made = [w.createOrganizationWirelessDevicesProvisioningDeployment(org, [{"devices": {"new": {"serial": spare, "name": f"AP {i}"}}, "status": "ready", "type": "deploy", "network": {"id": hq}}])["items"][0] for i in range(4)]
        check("createOrganizationWirelessDevicesProvisioningDeployment", made[0]["status"] == "completed" and made[0]["network"]["id"] == hq and made[0]["devices"]["new"]["model"] == "MR46", made[0])
        r = w.createOrganizationWirelessDevicesProvisioningDeployment(org, [{"devices": {"new": {"serial": spare}, "old": {"serial": aps[0]}}, "status": "ready", "type": "replace"}])["items"][0]
        u = w.updateOrganizationWirelessDevicesProvisioningDeployments(org, [{"deploymentId": r["deploymentId"], "devices": {"new": {"serial": spare, "name": "Lobby AP"}, "old": {"serial": aps[1], "afterAction": "release"}}, "status": "ready", "type": "replace"}])["items"][0]
        check("updateOrganizationWirelessDevicesProvisioningDeployments", u["devices"]["new"]["name"] == "Lobby AP" and u["devices"]["old"]["serial"] == aps[1], u)
        # Each page is a one-item array, so the SDK hands back one envelope per page.
        pages = w.getOrganizationWirelessDevicesProvisioningDeployments(org, total_pages=-1, perPage=3, sortBy="name")
        names = [x["devices"]["new"]["name"] for p in pages for x in p["items"]]
        check("getOrganizationWirelessDevicesProvisioningDeployments", names == ["AP 0", "AP 1", "AP 2", "AP 3", "Lobby AP"] and len(pages) == 2, names)
        w.deleteOrganizationWirelessDevicesProvisioningDeployment(org, r["deploymentId"])
        left = w.getOrganizationWirelessDevicesProvisioningDeployments(org, deploymentType="replace")
        check("deleteOrganizationWirelessDevicesProvisioningDeployment", left[0]["items"] == [], left)

        ca = w.createOrganizationWirelessDevicesRadsecCertificatesAuthority(org)
        check("createOrganizationWirelessDevicesRadsecCertificatesAuthority", ca["status"] == "untrusted" and ca["contents"].startswith("-----BEGIN CERTIFICATE-----"), ca)
        t = w.updateOrganizationWirelessDevicesRadsecCertificatesAuthorities(org, status="trusted", certificateAuthorityId=ca["certificateAuthorityId"])
        check("updateOrganizationWirelessDevicesRadsecCertificatesAuthorities", t == {**ca, "status": "trusted"}, t)
        cas = w.getOrganizationWirelessDevicesRadsecCertificatesAuthorities(org, certificateAuthorityIds=[ca["certificateAuthorityId"]])
        check("getOrganizationWirelessDevicesRadsecCertificatesAuthorities", cas[0]["items"] == [t], cas)
        crls = w.getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrls(org)
        check("getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrls", [x["certificateAuthorityId"] for x in crls["items"]] == [ca["certificateAuthorityId"]], crls)
        deltas = w.getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrlsDeltas(org, certificateAuthorityIds=["1"])
        check("getOrganizationWirelessDevicesRadsecCertificatesAuthoritiesCrlsDeltas", deltas["items"] == [], deltas)


SCENARIOS = [paging, events, writes, ratelimit, faults, aio, summaries, wirelessstats, orgwireless, switchports, inventory, webhooks, livetools, actionbatches, camera, shaping, firewall, vpn, routing, switchpolicies, policyobjects, switchsettings, switchdhcp, wirelessradio, wirelesslocation, ssidprofiles, wirelessdevices]

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
