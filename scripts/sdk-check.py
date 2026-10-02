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
        got = d.organizations.getOrganizationSummaryTopNetworksByStatus(org, total_pages="all", perPage=3)
        want = emu.raw(f"/organizations/{org}/summary/top/networks/byStatus")
        check(f"getOrganizationSummaryTopNetworksByStatus perPage=3, all pages ({len(want)} rows)", got == want, len(got))
        got = d.switch.getOrganizationSummarySwitchPowerHistory(org, timespan=86400)
        check(f"getOrganizationSummarySwitchPowerHistory ({len(got)} intervals)", len(got) == 72 and got == emu.raw(f"/organizations/{org}/summary/switch/power/history?{day}"), len(got))
        got = d.organizations.getOrganizationClientsBandwidthUsageHistory(org, timespan=86400)
        check(f"getOrganizationClientsBandwidthUsageHistory ({len(got)} rows)", len(got) == 288 and got == emu.raw(f"/organizations/{org}/clients/bandwidthUsageHistory?{day}"), len(got))
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


SCENARIOS = [paging, events, writes, ratelimit, faults, aio, summaries, wirelessstats, orgwireless, switchports]

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
