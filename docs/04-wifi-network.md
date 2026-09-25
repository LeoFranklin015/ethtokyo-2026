# ENSCA — WiFi & Network Layer

## Current Implementation (ETHTokyo 2026 Demo)

Running on Fedora VM + USB ethernet + TP-Link AX80. Hardware VLANs are not possible (AX80 does not pass 802.1Q tags). Equivalent isolation implemented in software.

### Topology

```
[Internet]
    │
[Mac Wi-Fi — en0]
    │  VMware host-only (bridge101, 172.16.0.1/24)
    │
[Fedora VM]
  enp2s0 — 172.16.0.129  (internet uplink via VMware)
  enp10s0u1 — 192.168.0.1/24  (USB ethernet → AX80 WAN)
    │
[TP-Link AX80 — router mode]
  WAN: 192.168.0.x (DHCP from Fedora dnsmasq)
  LAN: 192.168.0.0/24 (AX80's own NAT for WiFi devices)
    │
[Attendee devices — 192.168.0.x]
```

### Software VLAN Architecture

Three tiers implemented as iptables fwmarks + tc HTB classes on enp10s0u1 egress:

```
Login tier   fwmark   tc class   download cap
─────────────────────────────────────────────
basic        10       1:10       5 Mbps
staff        20       1:20       10 Mbps
vip          30       1:30       1000 Mbps (unlimited)
(unauthed)   —        1:99       1 Mbps (default class)
```

**Download shaping** — `tc HTB` on `enp10s0u1` egress (packets flowing toward devices). `iptables mangle MARK` on `dst-IP` classifies inbound packets per tier.

**Upload shaping** — `iptables mangle MARK` on `src-IP` marks upload traffic; same tc class applies on egress out enp2s0 if an upload shaper is added.

**Cross-tier isolation** — `iptables FORWARD DROP` between IPs on different tiers. Added at login, removed at logout.

### Config Files

**`/etc/NetworkManager/dispatcher.d/99-ensca`** — sets up iptables and tc HTB at boot:
```bash
# tc HTB on enp10s0u1
tc qdisc add dev enp10s0u1 root handle 1: htb default 99
tc class add dev enp10s0u1 parent 1: classid 1:99 htb rate 1mbit ceil 1mbit
tc class add dev enp10s0u1 parent 1: classid 1:10 htb rate 5mbit ceil 5mbit burst 15k
tc class add dev enp10s0u1 parent 1: classid 1:20 htb rate 10mbit ceil 10mbit burst 30k
tc class add dev enp10s0u1 parent 1: classid 1:30 htb rate 1000mbit ceil 1000mbit
tc filter add dev enp10s0u1 parent 1: protocol ip handle 10 fw classid 1:10
tc filter add dev enp10s0u1 parent 1: protocol ip handle 20 fw classid 1:20
tc filter add dev enp10s0u1 parent 1: protocol ip handle 30 fw classid 1:30
```

**`/opt/ensca/portal/app.py`** — Flask captive portal. On login:
```python
# Grant access for an IP at a given tier
def grant_access(ip, tier):
    mark = TIER_MARK[tier]  # "10", "20", or "30"
    iptables("-I FORWARD 1 -s {ip} -j ACCEPT")
    iptables("-t mangle -I FORWARD 1 -s {ip} -j MARK --set-mark {mark}")  # upload
    iptables("-t mangle -I FORWARD 1 -d {ip} -j MARK --set-mark {mark}")  # download
    iptables("-t nat -I PREROUTING 1 -s {ip} -p udp --dport 53 -j DNAT --to 8.8.8.8:53")
    _apply_cross_tier_rules(ip, tier, action="I")
```

### Captive Portal Flow

```
1. Device connects to AX80 WiFi → DHCP from AX80 → IP 192.168.0.x
2. HTTP request → iptables REDIRECT port 80 → Flask port 8080
3. DNS query → iptables REDIRECT udp/53 → dnsmasq → address=/#/192.168.0.1
4. Browser opens captive portal (iOS/Android CNA popup)
5. User submits credentials → tier assigned → iptables ACCEPT + fwmark added
6. Post-login 302 → /connected → OS re-probes → 204 → CNA sheet dismisses
7. DNS DNAT to 8.8.8.8 bypasses hijack for authed IPs → real internet works
```

### iOS/Android CNA Handling

Probe paths return `302 → portal` (unauthed) or `204 No Content` (authed):
```
/hotspot-detect.html    iOS/macOS
/generate_204           Android
/connecttest.txt        Windows
/check_network_status.txt  Linux NM
/canonical.html         Firefox
/ncsi.txt               Windows fallback
```

---

## Target Implementation (MikroTik + FreeRADIUS)

Full hardware VLAN isolation, 802.1X auth, ENS-native identity.

### Hardware

**MikroTik hAP ax lite (~$45)**
- WiFi 6 (802.11ax), dual-band
- RouterOS — supports 802.1X, RADIUS, dynamic VLAN, QoS natively

### Network Topology

```
Internet
    │
MikroTik hAP ax lite
    ├── Port 1: WAN
    ├── Port 2: Server (FreeRADIUS + ENSCA services)
    └── WiFi SSIDs → RADIUS auth → hardware VLAN assignment
         │
         ├── SSID: ethglobal-hacker   → VLAN 100 (50 Mbps)
         ├── SSID: ethglobal-mentor   → VLAN 200 (100 Mbps)
         ├── SSID: ethglobal-volunteer→ VLAN 300 (20 Mbps)
         ├── SSID: ethglobal-pragma   → VLAN 400 (100 Mbps)
         └── SSID: ethglobal-staff    → VLAN 10  (unlimited)
```

### Authentication Flow (ENS-native)

```
1. Attendee connects to SSID
2. Captive portal: wallet connect → sign EIP-191 challenge
3. Portal recovers address → reverse ENS → check *.tokyo2026.ethglobal.eth
4. Reads wifi-vlan, wifi-bandwidth text records
5. Calls FreeRADIUS CoA with VLAN + bandwidth policy
6. MikroTik moves device to correct VLAN, applies QoS
```

### FreeRADIUS Configuration

```python
# /usr/local/bin/ensca-radius-check
ens_name = sys.argv[1]
resp = requests.get(f"http://localhost:3000/policy/{ens_name}")
policy = resp.json()
print(f"Tunnel-Type = VLAN")
print(f"Tunnel-Medium-Type = IEEE-802")
print(f"Tunnel-Private-Group-Id = {policy['vlan']}")
print(f"WISPr-Bandwidth-Max-Down = {policy['bandwidth_down']}")
```

### Per-Identity Device Isolation (target)

Each attendee's devices share a private VLAN derived from their ENS namehash:

```typescript
function identityVlan(ensName: string, roleBaseVlan: number): number {
  const node = namehash(normalize(ensName))
  const offset = parseInt(node.slice(2, 6), 16) % 200
  return roleBaseVlan * 10 + offset
}
// philo on hacker VLAN 100 → identity VLAN 1042
// ann  on hacker VLAN 100 → identity VLAN 1087
```

MikroTik RouterOS supports 4094 VLANs — more than enough for an event.

---

## Current vs Target Comparison

| Layer | Current (Fedora VM + AX80) | Target (MikroTik + RADIUS) |
|---|---|---|
| VLAN isolation | iptables fwmark + tc HTB (software) | Hardware 802.1Q VLAN |
| Cross-tier isolation | iptables FORWARD DROP | L2 VLAN separation |
| Auth | username/password → tier | ENS subname + wallet signature |
| Bandwidth shaping | tc HTB on enp10s0u1 | RouterOS QoS via RADIUS |
| DNS hijack | dnsmasq address=/#/ + iptables REDIRECT | Same pattern |
| Device identity | per-IP (from AX80 NAT) | per-MAC + per-ENS-name |
| Captive portal | Flask (Python) | Next.js + viem + wagmi |
| Max devices | ~50 | ~500 |
