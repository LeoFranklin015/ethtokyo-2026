# ENSCA — Current Infrastructure: Mac + Fedora VM + AX80

## Overview

Working setup as of ETHTokyo 2026. Internet flows Mac Wi-Fi → Fedora VM (VMware Fusion) → USB-ethernet adapter → TP-Link AX80. All ENSCA enforcement runs in the VM.

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
  enp2s0      — 172.16.0.129/24   (internet uplink)
  enp10s0u1   — 192.168.0.1/24    (USB ethernet → AX80 WAN)
    │
[TP-Link Archer AX80 — router mode]
  WAN: 192.168.0.2 (DHCP from Fedora dnsmasq)
  LAN: 192.168.0.0/24 (AX80's own DHCP for WiFi devices)
    │
[Attendee devices — 192.168.0.x via AX80 WiFi]
```

Double NAT: AX80 NATs 192.168.0.x → 192.168.0.2, Fedora MASQUERADE → enp2s0 → Mac → internet.

---

## Software VLAN Configuration

The AX80 does not support 802.1Q VLAN tagging. VLAN-equivalent isolation is implemented entirely in software on the Fedora VM.

### Tiers

| Tier | Password | fwmark | tc class | Download cap |
|---|---|---|---|---|
| basic | basic2026 | 10 | 1:10 | 5 Mbps |
| staff | staff2026 | 20 | 1:20 | 10 Mbps |
| vip | vip2026 | 30 | 1:30 | 1000 Mbps |
| (unauthed) | — | — | 1:99 | 1 Mbps |

### tc HTB on enp10s0u1

Rate limiting runs on enp10s0u1 **egress** (download path — packets flowing toward devices). Managed by `99-ensca` NM dispatcher script, set up once at boot:

```bash
tc qdisc add dev enp10s0u1 root handle 1: htb default 99
tc class add dev enp10s0u1 parent 1: classid 1:99 htb rate 1mbit ceil 1mbit
tc class add dev enp10s0u1 parent 1: classid 1:10 htb rate 5mbit ceil 5mbit burst 15k
tc class add dev enp10s0u1 parent 1: classid 1:20 htb rate 10mbit ceil 10mbit burst 30k
tc class add dev enp10s0u1 parent 1: classid 1:30 htb rate 1000mbit ceil 1000mbit
tc filter add dev enp10s0u1 parent 1: protocol ip handle 10 fw classid 1:10
tc filter add dev enp10s0u1 parent 1: protocol ip handle 20 fw classid 1:20
tc filter add dev enp10s0u1 parent 1: protocol ip handle 30 fw classid 1:30
```

### iptables: NAT, Redirect, Marking, Isolation

Set up by `99-ensca` at boot:
```bash
# Masquerade internet traffic out VM uplink
iptables -t nat -A POSTROUTING -o enp2s0 -j MASQUERADE

# Redirect HTTP → captive portal, DNS → dnsmasq
iptables -t nat -A PREROUTING -i enp10s0u1 -p tcp --dport 80 -j REDIRECT --to-port 8080
iptables -t nat -A PREROUTING -i enp10s0u1 -p udp --dport 53 -j REDIRECT --to-port 53

# Allow return traffic
iptables -A FORWARD -i enp2s0 -o enp10s0u1 -m state --state RELATED,ESTABLISHED -j ACCEPT

# Block all unauthenticated forward by default
iptables -A FORWARD -i enp10s0u1 -j DROP
```

Per-login additions (managed by `app.py`):
```bash
# ACCEPT + fwmark for upload + fwmark for download + DNS DNAT + cross-tier DROP
iptables -I FORWARD 1 -s <ip> -j ACCEPT
iptables -t mangle -I FORWARD 1 -s <ip> -j MARK --set-mark <mark>   # upload
iptables -t mangle -I FORWARD 1 -d <ip> -j MARK --set-mark <mark>   # download
iptables -t nat -I PREROUTING 1 -s <ip> -p udp --dport 53 -j DNAT --to 8.8.8.8:53
# + DROP rules between this IP and all IPs on other tiers
```

### NM Dispatcher Lock

`99-ensca` uses `/run/ensca-iptables-init.lock` to run only once per boot. `/run` is cleared on reboot — no stale lock after restart.

---

## Captive Portal

**Flask app** at `/opt/ensca/portal/app.py`, systemd service `ensca-portal`, runs as root.

**Login flow:**
1. Device connects → DHCP from AX80 → 192.168.0.x
2. HTTP → REDIRECT to port 8080 → captive portal
3. DNS → REDIRECT to dnsmasq → `address=/#/192.168.0.1` returns VM IP for all names
4. iOS/Android CNA probes (`/hotspot-detect.html`, `/generate_204`, etc.) → 302 to portal (unauthed)
5. User submits credentials → `grant_access(ip, tier)` called
6. Post-login `302 → /connected` → OS re-probes → 204 → captive sheet dismisses
7. DNS DNAT for authed IPs bypasses dnsmasq → real DNS resolution

---

## dnsmasq Config

```ini
interface=enp10s0u1
dhcp-range=192.168.0.2,192.168.0.50,12h
dhcp-option=option:router,192.168.0.1
dhcp-option=option:dns-server,192.168.0.1
address=/#/192.168.0.1
```

All DNS returns 192.168.0.1 for unauthenticated devices. Authenticated devices get DNAT to 8.8.8.8 which takes priority (PREROUTING INSERT 1) over the dnsmasq REDIRECT.

---

## Device Identity Constraint

The VM sits at L3. The AX80 runs its own NAT — individual device MACs (192.168.0.x) are hidden behind AX80's WAN MAC. Fedora sees only AX80's MAC in its ARP table on enp10s0u1.

Workaround: device identity is tracked by **IP** (assigned by AX80's DHCP). Per-IP iptables rules handle auth, marking, and isolation. This works because the AX80 DHCP leases are sticky (12h), so IPs don't change mid-session.

For true per-MAC identity: switch AX80 to AP/bridge mode so Fedora sees individual device MACs and IPs directly, or replace with MikroTik.

---

## Persistence

NM dispatcher script (`99-ensca`) runs on every `up` event but the lock file prevents re-init. Survives NetworkManager restarts within a boot. Does not survive reboot (lock in `/run`), but re-runs correctly on next boot.

Flask service managed by systemd (`ensca-portal.service`, `Restart=always`).

---

## VM SSH Access

```
ssh philo@172.16.0.130   (password: asdfghjkl)
```

From Mac terminal: `! ssh philo@172.16.0.130`

---

## Layer Comparison: Current vs Target

| Layer | Current (VM + AX80) | Target (MikroTik) |
|---|---|---|
| VLAN isolation | iptables fwmark + tc HTB | Hardware 802.1Q VLAN |
| Cross-tier isolation | iptables FORWARD DROP | L2 VLAN separation |
| Auth | username/password | ENS subname + wallet sig |
| Device identity | per-IP (AX80 NAT) | per-MAC + per-ENS-name |
| Bandwidth shaping | tc HTB on enp10s0u1 | RouterOS QoS via RADIUS |
| NAT layers | Double (AX80 + Fedora) | Single (MikroTik) |
| Max devices | ~50 | ~500 |
