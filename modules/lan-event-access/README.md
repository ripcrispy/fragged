# LAN Event Access

Door-desk network access for LAN parties. When an attendee plugs in, their PC gets a **staging** address from your
firewall's DHCP server and can't reach the LAN. At the front desk, staff confirm payment and click **Approve**. The
module then moves the device into the **approved** section of the firewall's DHCP configuration, and the PC joins the
LAN party network when it renews its lease (unplugging and replugging the cable does that straight away).

- **Door desk:** Admin › Event access (`/admin/m/lan-event-access/desk`)
- **Members:** `/m/lan-event-access` ("Network access" in the user menu) lists their approved devices and payment
- **Works with:** OPNsense (Kea DHCP, Dnsmasq or legacy ISC DHCP) and pfSense (with the REST API package), plus a
  **demo** mode that simulates a firewall so you can try the desk first

## Desk workflow

1. New devices appear under **Waiting at the door** with their name, MAC address and staging address. The page
   refreshes every 15 seconds while nobody is typing.
2. Click **Take payment & approve**. For a new attendee, enter their name, optionally their Fragged username (links
   the device to their account and notifies them), the amount (pre-filled with the entry fee) and how they paid:
   cash, card, paid in advance or free entry. Cash and card need the **Payment received** tick.
3. Someone who has already paid can add a second device (a laptop, a console) by choosing their name instead. They
   aren't charged again.
4. **Approved devices** shows each device's live status: *On the LAN*, *still on a staging address* (waiting for
   it to renew), *no lease right now*, or a warning when the firewall and Fragged disagree.
5. Organisers can **Revoke** a device. It drops back to the staging network when it next renews.
6. **Sync with firewall** puts back any approvals the firewall has lost (a reboot, a config restore, someone
   deleting entries by hand). With the OPNsense ISC alias it also follows devices whose lease address changed.

If the firewall refuses an approval, nothing is recorded: no device, no payment. The desk sees the firewall's reason
and can try again. Two desks can't approve the same device or hand out the same address at the same time.

## Permissions

| Permission | Default | Lets you |
| --- | --- | --- |
| `lan-event-access.view` | members | see your own approved devices and entry payment |
| `lan-event-access.desk` | administrators | work the door desk: take entry payments and approve devices (good for helpers) |
| `lan-event-access.manage` | administrators | revoke devices, sync with the firewall, test the connection |

## Settings and environment

Settings are in Admin › Modules › LAN Event Access › Settings.

| Setting | Notes |
| --- | --- |
| Firewall and DHCP server | `Demo`, `OPNsense: Kea DHCP`, `OPNsense: Dnsmasq`, `OPNsense: ISC DHCP (legacy)` or `pfSense: REST API package` |
| Firewall address | e.g. `https://192.168.1.1`. Only the Fragged server connects to it. |
| Check the firewall's TLS certificate | On by default. For a self-signed certificate, prefer `LAN_EVENT_ACCESS_CA_FILE`. |
| Staging address range | e.g. `10.10.1.10-10.10.1.250`. Devices with a lease here show up as waiting. |
| Approved address range | e.g. `10.10.0.10-10.10.0.250`. Approved devices get the first free address. Keep it **outside** every DHCP pool. Not used with OPNsense ISC. |
| pfSense: DHCP interface | Interface id of the LAN DHCP server, e.g. `lan` or `opt1` |
| OPNsense ISC: firewall alias | Name of an *External (advanced)* alias, default `LAN_APPROVED` |
| Entry fee, currency symbol | Pre-fill the amount on the approve form |
| Instructions shown to members | Shown on the member page |

Credentials are never stored in the database. Set them in the server environment:

```bash
LAN_EVENT_ACCESS_API_KEY=...       # OPNsense API key, or pfSense REST API key
LAN_EVENT_ACCESS_API_SECRET=...    # OPNsense API secret (leave unset for a pfSense API key)
LAN_EVENT_ACCESS_CA_FILE=/etc/fragged/firewall-ca.pem   # optional: trust the firewall's own CA
```

On pfSense, setting both variables sends them as a username and password (HTTP basic auth) instead of an API key.

After saving the settings, use **Test connection** on the desk page. It only reads from the firewall.

## Setting up the network

All supported firewalls use the same layout: **one LAN subnet with two address ranges**.

```
LAN subnet       10.10.0.0/23
  approved       10.10.0.10 – 10.10.0.250   reservations made by this module (outside the DHCP pool)
  staging pool   10.10.1.10 – 10.10.1.250   what unknown devices get from DHCP
```

1. **DHCP pool = staging range.** Give the pool a **short lease time** (2–5 minutes) so approved devices pick up
   their new address quickly.
2. **Firewall rules on the LAN interface**, top to bottom (aliases for the two ranges keep this readable):
   - allow *staging* → the Fragged server (HTTP/HTTPS), and → the firewall for DNS and DHCP
   - block *staging* → anything else
   - allow *approved* → any (game servers, internet)
3. Put **game servers on their own subnet or VLAN** behind the firewall. Devices on the same subnet talk to each
   other directly through the switch without passing the firewall, so rules can only gate traffic that leaves the
   LAN subnet.
4. Create a **dedicated API user** on the firewall with only the privileges listed for your DHCP server below.

### OPNsense: Kea DHCP (recommended on OPNsense)

- Services › Kea DHCP › Kea DHCPv4: a subnet `10.10.0.0/23` on the LAN interface with the pool
  `10.10.1.10-10.10.1.250`.
- The module adds a **reservation** in that subnet for each approved device (MAC → approved address) and applies the
  configuration.
- API user privileges: the Kea DHCP settings and leases pages.

### OPNsense: Dnsmasq DNS & DHCP

- Services › Dnsmasq DNS & DHCP › DHCP ranges: the range `10.10.1.10` – `10.10.1.250` on LAN with subnet mask
  `255.255.254.0`, so the approved addresses are inside the same DHCP subnet.
- The module adds a **host entry** (MAC + approved address) for each approved device and applies the configuration.
- API user privileges: the Dnsmasq settings and leases pages.

### OPNsense: ISC DHCP (legacy)

OPNsense has no API for ISC static mappings, so this mode **doesn't move devices to a new address**. It adds each
approved device's current lease address to a firewall alias instead.

- Firewall › Aliases: create `LAN_APPROVED` of type **External (advanced)**.
- Use `LAN_APPROVED` in place of the *approved* range in the firewall rules above. The rest of the pool stays
  blocked.
- Access works immediately; nothing needs to reconnect.
- External aliases are emptied when the firewall reboots. Press **Sync with firewall** afterwards. Sync also follows a
  device whose lease address changed.
- API user privileges: the ISC DHCP leases page and firewall aliases.
- ISC DHCP is end-of-life on OPNsense. Kea or Dnsmasq give you real address separation.

### pfSense (ISC or Kea backend)

pfSense has no built-in API. Install the third-party, open-source
[pfSense REST API package](https://github.com/pfrest/pfSense-pkg-RESTAPI) (v2), then create an API key for a user
that may edit DHCP server settings and read DHCP leases.

- Services › DHCP Server › LAN: set the address pool to the staging range and a short default lease time.
- The module adds a **static mapping** (MAC → approved address) on the configured interface and applies the DHCP
  server configuration. pfSense requires static mappings to be outside the pool, which this layout already does.
- Works with both of pfSense's DHCP backends (ISC and Kea).

## Data and privacy

- **Tables:** `mod_lan_event_access_attendees` (name, optional member link, amount, payment method, who took it) and
  `mod_lan_event_access_devices` (MAC, name, address, status, who approved or revoked it and when).
- **Audit log:** `lan-event-access.payment`, `.approve`, `.revoke` and `.sync`.
- **Notifications:** `lan-event-access` tells a linked member when their device is approved. Members can turn it off.
- **Closing an account** keeps the payment as a cash record but removes the member link and the name.
- Only people with `lan-event-access.manage` can see the firewall settings, and only administrators can change them.
  Firewall requests time out after 8 seconds and replies are capped at 4 MB.

## Limits

- IPv4 only.
- Demo mode keeps its simulated firewall in memory: it resets when the server restarts, and every server instance has
  its own copy.
- The connectors are tested against simulated OPNsense and pfSense API responses. If your firewall answers
  differently, please open an issue with the API response (remove addresses and keys first).
