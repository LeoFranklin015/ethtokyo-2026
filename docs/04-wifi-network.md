# ENSCA — WiFi & Network Layer

## Current Implementation (ETHTokyo 2026 Demo)

Running on Fedora VM + USB ethernet + TP-Link AX80. Hardware VLANs are not possible — the AX80 does not pass 802.1Q tags. Equivalent isolation implemented in software.

### Physical Topology

```
[Internet]
    │
[Mac Wi-Fi — en0]
    │  VMware host-only (bridge101, 172.16.0.1/24)
    │
[Fedora VM]
  enp2s0      — 172.16.0.130/24   (management + internet uplink)
  enp10s0u1   — 192.168.0.1/24    (USB ethernet → AX80 WAN)
    │
[TP-Link AX80 — router mode]
  WAN: 192.168.0.2 (DHCP from Fedora dnsmasq)
  LAN: 192.168.0.0/24 (AX80's own DHCP for WiFi devices)
    │
[Attendee devices — 192.168.0.x via AX80 WiFi]
```

Double NAT: AX80 NATs 192.168.0.x → 192.168.0.2, Fedora MASQUERADE → enp2s0.

VM management access: `ssh philo@172.16.0.130` (password: asdfghjkl).

### Software VLAN Architecture

Three tiers implemented as iptables fwmarks + tc HTB classes on enp10s0u1 egress:

| Tier | fwmark (hex) | tc class | Download cap |
|---|---|---|---|
| basic | 10 (0xa) | 1:10 | 5 Mbps |
| staff | 20 (0x14) | 1:20 | 10 Mbps |
| vip | 30 (0x1e) | 1:30 | 1000 Mbps (unlimited) |
| (unauthed) | — | 1:99 | 1 Mbps (default) |

**Download shaping** — `tc HTB` on `enp10s0u1` egress (toward devices). `iptables mangle MARK` on `dst=<ip>` classifies inbound packets.

**Upload shaping** — `iptables mangle MARK` on `src=<ip>` marks upload traffic; same tc class applies on enp2s0 egress.

**Cross-tier isolation** — `iptables FORWARD DROP` between IPs on different tiers. Inserted at login, removed at logout.

### tc HTB Setup (run once at boot via NM dispatcher)

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

### iptables: NAT, Redirect, Marking, Isolation (set up at boot)

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

### Per-Login iptables (managed by portal/app.py)

```bash
# On login (INSERT = highest priority):
iptables -I FORWARD 1 -s <ip> -j ACCEPT
iptables -t mangle -I FORWARD 1 -s <ip> -j MARK --set-mark <mark>   # upload
iptables -t mangle -I FORWARD 1 -d <ip> -j MARK --set-mark <mark>   # download
iptables -t nat -I PREROUTING 1 -s <ip> -p udp --dport 53 -j DNAT --to 8.8.8.8:53
# + FORWARD DROP between this IP and all IPs on other tiers

# On logout (DELETE exact matches):
iptables -D FORWARD -s <ip> -j ACCEPT
iptables -t mangle -D FORWARD -s <ip> -j MARK --set-mark <mark>
iptables -t mangle -D FORWARD -d <ip> -j MARK --set-mark <mark>
iptables -t nat -D PREROUTING -s <ip> -p udp --dport 53 -j DNAT --to 8.8.8.8:53
# + remove DROP rules for this IP
```

### Captive Portal Flow

```
1. Device connects to AX80 WiFi → DHCP from AX80 → IP 192.168.0.x
2. HTTP request → iptables REDIRECT port 80 → Flask port 8080
3. DNS query → iptables REDIRECT udp/53 → dnsmasq → address=/#/192.168.0.1
4. Browser opens captive portal (iOS/Android CNA popup)
5. User submits credentials → tier assigned → iptables ACCEPT + fwmark added
6. Post-login 302 → /connected → OS re-probes → 204 → CNA sheet dismisses
7. DNS DNAT for authed IPs bypasses dnsmasq → real internet DNS works
8. Portal notifies proxy: POST /internal/session-created with session UUID, group_id, IP
```

### iOS/Android CNA Probe Paths

Probe paths return `302 → portal` (unauthed) or `204 No Content` (authed):

```
/hotspot-detect.html    iOS/macOS
/generate_204           Android
/connecttest.txt        Windows
/check_network_status.txt  Linux NM
/canonical.html         Firefox
/ncsi.txt               Windows fallback
```

### dnsmasq Config

```ini
interface=enp10s0u1
dhcp-range=192.168.0.2,192.168.0.50,12h
dhcp-option=option:router,192.168.0.1
dhcp-option=option:dns-server,192.168.0.1
address=/#/192.168.0.1
```

All DNS returns 192.168.0.1 for unauthenticated devices. Authenticated devices get DNAT to 8.8.8.8 (inserted at PREROUTING position 1, takes priority over the dnsmasq REDIRECT).

### Persistence

NM dispatcher (`/etc/NetworkManager/dispatcher.d/99-ensca`) runs on every `up` event but uses `/run/ensca-iptables-init.lock` to initialize only once per boot. `/run` is cleared on reboot, so re-runs correctly after restart.

---

## Current vs Target Comparison

| Layer | Current (Fedora VM + AX80) | Target (MikroTik + RADIUS) |
|---|---|---|
| VLAN isolation | iptables fwmark + tc HTB | Hardware 802.1Q VLAN |
| Cross-tier isolation | iptables FORWARD DROP (L3) | L2 VLAN separation |
| Auth | username/password | ENS subname + wallet signature |
| Bandwidth shaping | tc HTB on enp10s0u1 | RouterOS QoS via RADIUS |
| Device identity | per-IP (AX80 NAT hides MACs) | per-MAC + per-ENS-name |
| Per-identity VLAN | No (per-tier only) | Yes (namehash-derived) |
| Max devices | ~50 | ~500 |
