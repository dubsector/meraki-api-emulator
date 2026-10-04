| Organization | Network | Products | Notes |
| --- | --- | --- | --- |
| Acme Corporation | HQ - San Francisco | MX, MS, MR, MV | VPN hub, dual WAN (fiber and cable), about 340 clients |
| | Branch - Austin | MX, MS, MR | One switch is in the alerting state |
| | Warehouse - Reno | MX, MS, MR, MV | Two shifts, one flaky AP, one dormant camera |
| | Retail - Denver | MX, MS, MR | Store hours, lots of guest Wi-Fi |
| | Remote - London | MX, MS, MR | Single WAN, Europe/London time zone |
| Acme Test Lab | Lab - Toronto | MR | Wireless only |
| | Lab - Ottawa | MX | One MX68W with Wi-Fi on a single cable uplink, no clients and no VPN |
| | Lab - Montreal | MR, MT | One CW9166I as the sensor gateway and Zigbee IoT controller (two door locks, ESL on) and nine sensors: two MT10, an MT11 freezer probe, MT12, MT14, MT15, MT20 door, MT30 button and MT40 power monitor |
| | Lab - Kingston | MG | Two cellular gateways: a 5G MG52 with a SIM and an eSIM, and a single-SIM LTE MG21, each SIM on its own Canadian carrier |
| | Lab - Systems Manager | SM | No Meraki hardware: 13 enrolled devices (iPhones, iPads, Macs, Windows laptops, Android phones and a Chromebook), their 7 owners and 6 profiles |
| | Lab - Calgary | MR, campus gateway | Three CW9166I APs whose two SSIDs tunnel through one cluster of two CW9800H1 campus gateways, about 15 clients, Mountain time |
| | Lab - Halifax | Wireless LAN controller | Two Catalyst 9800-40 controllers in an SSO pair with six Catalyst APs joined to it (records on the pair, not devices) and about 50 clients at peak, Atlantic time |
| | Lab - Winnipeg | MX | One Cisco Secure Router (C8455-G2-MX) on fiber and cable uplinks, with SFP+ optics in its first WAN port and one LAN port, no clients and no VPN, Central time |

Everything is generated from a seed and the clock:

- **Clients** follow schedules in each site's local time: office hours, warehouse shifts, retail hours, guests who drop in, and always-on devices like phones, printers and IoT sensors. Weekends are quiet.
- **Traffic** is built from those sessions on a 5-minute grid, so totals agree across endpoints and resolutions. HQ runs about 60 Mbps at midday, drops to almost nothing overnight, and has a nightly NAS backup.
- **Devices** have occasional outages. The Reno dock AP drops several times a day, and WAN links fail over now and then.
- **Events** come from the same sessions and outages: associations, 802.1X and splash auth, DHCP leases, port up and down, VPN peer changes, failovers, content filtering and IDS alerts.
- **Alerts** are raised from those outages too. A device gone for five minutes becomes an `unreachable` assurance alert that resolves when it comes back, the Austin switch has an open CRC errors alert, and WAN failures show up as `wan_status`. Dismissing an alert takes it out of the active views until it is restored.
- **Configuration** is built from the same topology. VLAN subnets hold every client address, the MX is `.1` on each one, firewall rules reference the real VLANs, and the VPN settings export the subnets the VPN status endpoint reports.
- **Sensors** report on their own schedule: temperature, humidity, air quality and power every 15 minutes, battery, water and the MT40's outlet every hour, and doors and buttons as they happen. Indoor readings follow office hours, the freezer stays near -18 °C, water stays dry, and batteries run down slowly. A sensor that is down reports nothing.
- **Systems Manager devices** check in through the day in Toronto time: laptops on most weekdays during office hours, phones and tablets from morning to late evening, and the front desk iPad through opening hours. Laptops send performance samples every hour and connection logs every four hours while online, and phones report daily cellular use.
- **Administration**: each organization has admins with different access levels, a change log written by the admins allowed to make each change, and an inventory with a few unassigned spares. Acme Corporation uses co-term licensing and Acme Test Lab uses per-device licensing, with one license per device, one of them expiring soon, and one unused.

The same seed and the same time always give the same answer. Freeze the clock with `--now` for repeatable tests.
