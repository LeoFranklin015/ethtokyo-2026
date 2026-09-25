# Current Infrastructure: Mac + Fedora VM + AX80

## Overview

Working demo setup. Internet flows Mac Wi-Fi → Fedora VM (VMware Fusion) → USB-ethernet → TP-Link AX80. All enforcement runs in the VM.

---

## Physical Topology

```
[Internet]
    │
[Mac Wi-Fi — en0 — 10.229.65.238]
    │
    │  VMware host-only (bridge101 — 172.16.0.1/24)
    │
[Fedora VM]
  enp2s0      — 172.16.0.130/24   (management + internet uplink)
  enp10s0u1   — 192.168.0.1/24    (USB ethernet → AX80 WAN)
    │
[TP-Link Archer AX80 — router mode]
  WAN: 192.168.0.2 (DHCP from Fedora dnsmasq)
  LAN: 192.168.0.0/24 (AX80's own DHCP for WiFi devices)
    │
[Attendee devices — 192.168.0.x via AX80 WiFi]
```

Double NAT: AX80 NATs 192.168.0.x → 192.168.0.2, Fedora MASQUERADE → enp2s0.

---

## VM SSH Access

```bash
ssh philo@172.16.0.130   # password: asdfghjkl
```

Note: 192.168.0.1 is the WiFi-facing interface — not reachable from Mac. Use 172.16.0.130.

---

## Services Running on VM

| Service | Port | User | Systemd unit | Path |
|---|---|---|---|---|
| Captive portal | 8080 | root | `ensca-portal.service` | `/opt/ensca/portal/app.py` |
| Resource proxy | 8081 | philo | `ensca-proxy.service` | `~/ensca_proxy/proxy.py` |

DB: `~/ensca_data/ensca.db` (SQLite WAL, shared between both processes).

Both services use `Restart=on-failure` / `Restart=always`.

---

## Software VLANs

The AX80 does not support 802.1Q VLAN tagging. VLAN-equivalent isolation is implemented in software.

| Tier | Credentials | fwmark | tc class | Download cap |
|---|---|---|---|---|
| basic | basic / basic2026 | 10 | 1:10 | 5 Mbps |
| staff | staff / staff2026 | 20 | 1:20 | 10 Mbps |
| vip | vip / vip2026 | 30 | 1:30 | 1000 Mbps |
| (unauthed) | — | — | 1:99 | 1 Mbps |

See `04-wifi-network.md` for full tc HTB and iptables configuration.

---

## NM Dispatcher Script

`/etc/NetworkManager/dispatcher.d/99-ensca` sets up tc HTB and base iptables rules on boot. Uses `/run/ensca-iptables-init.lock` to run only once per boot.

---

## Portal↔Proxy Integration

Portal calls proxy internal API (localhost only) on login/logout:

```
POST /internal/session-created   — on login
POST /internal/session-ended     — on logout
GET  /internal/group-by-tier/<tier>  — cached at startup, maps tier→group_id
```

Proxy calls portal internal API on admin session revocation:

```
POST /internal/revoke-ip   — flushes iptables rules for the device IP
```

---

## Device Identity Constraint

The VM sits at L3. The AX80 runs its own NAT — individual device MACs are hidden. Fedora sees only AX80's MAC in ARP on enp10s0u1.

Device identity is tracked by **IP** (assigned by AX80's DHCP, sticky 12h leases). Per-IP iptables rules handle auth, marking, and isolation.

For true per-MAC identity: switch AX80 to AP/bridge mode, or replace with MikroTik.

---

## Python Version

Python 3.14.3 on VM. Local dev runs 3.9.6 — avoid `X | Y` union type hint syntax in source files.

---

## Bootstrap (first run)

```bash
# On VM as philo:
mkdir -p ~/ensca_proxy ~/ensca_data
# Copy proxy files to ~/ensca_proxy/
# Set env: ENSCA_DB=~/ensca_data/ensca.db
python3 ~/ensca_proxy/proxy.py   # starts on port 8081

# Create first admin token (no auth needed from localhost):
curl -s -X POST http://127.0.0.1:8081/admin/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"bootstrap"}'
# Save the returned token — shown only once
```
