# ENSCA — Current Infrastructure: Mac + Fedora VM + AX80

## Overview

This documents the actual working setup as of 2026-09-25. Internet flows from Mac Wi-Fi through a Fedora Linux VM (VMware Fusion) over a USB-ethernet adapter to a TP-Link Archer AX80 consumer router. All ENSCA enforcement runs inside the VM.

---

## Physical Topology

```
[Internet]
    │
[Mac Wi-Fi — en0 — 10.229.65.238]
    │
    │  VMware Fusion virtual network
    │  bridge101 — 172.16.0.1/24
    │
[Fedora VM — enp2s0 — 172.16.0.129/24]
    │
    │  USB-ethernet adapter (physically attached to Mac,
    │  passed through to VM via VMware USB passthrough)
    │  USB 10/100/1000 LAN — MAC: 6c:6e:07:43:ac:81
    │  Fedora sees it as: enp10s0u1
    │  Static IP on VM: 192.168.100.1/24
    │
[Ethernet cable — RJ45]
    │
[TP-Link Archer AX80 — Router mode]
    │  WAN port gets 192.168.100.x from Fedora dnsmasq
    │  WAN gateway: 192.168.100.1 (Fedora)
    │  LAN: 192.168.0.0/24 (router's own NAT)
    │
[Attendee devices via AX80 WiFi]
    │  IPs: 192.168.0.x (from AX80 DHCP)
```

---

## Mac-Side State

Internet Sharing is **enabled** on the Mac but en5 (USB adapter) is **not** in bridge100 — it was claimed by VMware before Internet Sharing could use it. The relevant bridges:

| Bridge | IP | Members | Purpose |
|---|---|---|---|
| bridge100 | 192.168.47.1/24 | vmenet0 | VMware NAT (default) |
| bridge101 | 172.16.0.1/24 | vmenet1, vmenet2, vmenet3 | VMware host-only — Fedora's internet uplink |
| bridge102 | 192.168.2.1/24 | en5 | macOS Internet Sharing anchor — en5 is here but VM has exclusive USB passthrough |

VMware USB passthrough removes en5 from macOS networking and hands raw USB to the VM. The Mac's Internet Sharing on bridge102 is effectively bypassed — the VM owns the adapter directly.

---

## Fedora VM — Network Interfaces

| Interface | IP | Role |
|---|---|---|
| enp2s0 | 172.16.0.129/24 | Internet uplink via VMware host-only (bridge101) |
| enp10s0u1 | 192.168.100.1/24 | USB ethernet adapter → router WAN |
| lo | 127.0.0.1 | Loopback |

Default gateway on Fedora: `172.16.0.1` (Mac's bridge101) → Mac NATs to en0 → internet.

---

## IP Forwarding & NAT (Fedora)

```bash
# IP forwarding
sysctl net.ipv4.ip_forward = 1

# NAT: masquerade enp10s0u1 traffic out via enp2s0
iptables -t nat -A POSTROUTING -o enp2s0 -j MASQUERADE
iptables -A FORWARD -i enp10s0u1 -o enp2s0 -j ACCEPT
iptables -A FORWARD -i enp2s0 -o enp10s0u1 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

Traffic path for a device on AX80 WiFi reaching google.com:

```
Device (192.168.0.x)
  → AX80 NAT (192.168.0.1 → 192.168.100.x)
  → Fedora iptables MASQUERADE (192.168.100.x → 172.16.0.129)
  → VMware bridge101 → Mac bridge101 (172.16.0.1)
  → Mac NAT → en0 (10.229.65.238)
  → Internet
```

Double NAT: AX80 NATs once, Fedora NATs again.

---

## DHCP (Fedora dnsmasq)

```ini
# /etc/dnsmasq.conf
port=0                                          # DNS disabled (systemd-resolved conflict)
interface=enp10s0u1
dhcp-range=192.168.100.2,192.168.100.50,12h
dhcp-option=option:router,192.168.100.1
dhcp-option=option:dns-server,8.8.8.8
```

dnsmasq serves DHCP only to the AX80 WAN port. The AX80 gets `192.168.100.x` and uses `192.168.100.1` (Fedora) as its default gateway and DNS forwarder.

AX80 then runs its own DHCP server for devices on its LAN (`192.168.0.0/24`). Fedora never sees individual device IPs or MACs directly.

Firewall fix required — port 67 (DHCP) was blocked by firewalld:
```bash
sudo firewall-cmd --add-service=dhcp --permanent
sudo firewall-cmd --reload
```

NetworkManager was re-assigning enp10s0u1 to DHCP automatically. Disabled:
```bash
sudo nmcli device set enp10s0u1 managed no
```

---

## Device Identification — The Core Problem

### Why This Setup Loses Device Identity

The VM sits at **Layer 3**, not Layer 2. The USB adapter (enp10s0u1) connects to the AX80 WAN port. The AX80 runs its own NAT and DHCP for its LAN devices. This means:

- Fedora sees **only the AX80's WAN MAC** (`10:5a:95:d8:d4:2c`) in its ARP table
- Individual device MACs (phones, laptops) never reach Fedora's network stack
- Individual device IPs (`192.168.0.x`) are hidden behind AX80's NAT
- Fedora only sees source IP `192.168.100.2` (AX80 WAN) for all traffic

Fedora's ARP table on enp10s0u1:
```
192.168.100.2  →  10:5a:95:d8:d4:2c  (AX80 WAN — only entry)
```

### What Fedora CAN See

Because all traffic is NATted by AX80 before reaching Fedora, the VM sees:

- Source IP: always `192.168.100.2` (AX80 WAN address)
- Source MAC: always `10:5a:95:d8:d4:2c` (AX80 WAN MAC)
- TCP/UDP connections: source port varies per device (port-based NAT)
- HTTP headers: User-Agent, X-Forwarded-For if set
- Layer 7 content: anything in the payload if not encrypted

Fedora **cannot** see:
- Individual device MAC addresses
- Individual device IPs (192.168.0.x)
- Which physical device initiated a connection

### Identification Strategies at Layer 3/7

Since MAC-based identification is impossible, device identity must happen at the application layer.

**Option 1: Captive portal session cookie (recommended)**

Every unauthenticated device hits the captive portal before getting internet. The portal sets a session cookie tied to the wallet auth result. Subsequent requests carry the cookie — Fedora's proxy identifies the device by cookie, not MAC.

Limitation: cookie is per-browser, not per-device. A device with two browsers = two sessions.

**Option 2: WireGuard per-identity tunnel**

After wallet auth, device receives a WireGuard config (QR code on portal). All traffic flows through a WireGuard tunnel. Fedora's `wg0` interface sees each peer's WireGuard public key as the identity — not IP, not MAC.

Device identity = WireGuard public key = ENS name (stored in mapping at auth time).

This is the cleanest solution. Identity is cryptographic, not network-layer-dependent. Matches the ENS/wallet-sig model of the rest of ENSCA.

**Option 3: Source port tracking (fragile)**

AX80's NAT preserves source ports. A connection from device 192.168.0.10:54321 → AX80 NAT → Fedora sees source port 54321. A parallel tracker on the AX80 (or access to AX80 NAT table) could correlate port → device IP → device MAC.

Requires: SSH access to AX80 and periodic polling of its connection table. Fragile, AX80-model-specific, breaks with UDP. Not recommended.

**Option 4: Disable AX80 NAT (AP mode)**

Switch AX80 to AP mode (not router mode). Devices get IPs directly from Fedora's dnsmasq. Fedora sees real device MACs and IPs. Full Layer 2 visibility.

This was the original plan. Blocked because AX80's AP mode DHCP cannot be disabled — it insists on running its own DHCP (`192.168.0.x`) even in AP mode, conflicting with Fedora's dnsmasq.

Workaround: set Fedora dnsmasq range to `192.168.0.x` and accept that AX80 may also try to serve DHCP. Race condition — whichever responds first wins. Unreliable.

Better workaround: replace AX80 with a router that has a proper "dumb AP / bridge" mode (MikroTik, OpenWrt-flashed device). This gives full Layer 2 pass-through — exactly what the production ENSCA plan uses.

**Option 5: DHCP fingerprinting via dnsmasq logs**

Even if Fedora can't see device MACs directly, dnsmasq on Fedora serves DHCP to the AX80. The AX80 DHCP requests from its WAN port carry no per-device info. Not viable.

If AX80 were in true AP/bridge mode (or replaced with a transparent switch), dnsmasq would see individual device DHCP requests including MAC addresses — then `dhcp-script` hook could register each device at lease time.

---

## Recommended Path for ENSCA on This Setup

Given current hardware constraints (AX80 in router mode, double NAT), use WireGuard for device identity:

```
Device connects to AX80 WiFi
  → browser opens → DNS returns Fedora captive portal IP (via dnsmasq DNS hijack)
  → captive portal loads
  → user connects wallet, signs EIP-191 challenge
  → Fedora verifies sig, resolves ENS name, reads text records
  → portal returns WireGuard config (peer keys + assigned IP) as QR code
  → user imports WireGuard config
  → all traffic now flows through WireGuard tunnel
  → Fedora identifies device by WireGuard peer public key
  → iptables rules enforce access policy per peer key / tunnel IP
```

For the DNS hijack (captive portal redirect), Fedora needs to intercept DNS before it reaches AX80:

```bash
# iptables: redirect DNS from enp10s0u1 to Fedora's dnsmasq
sudo iptables -t nat -A PREROUTING -i enp10s0u1 -p udp --dport 53 -j REDIRECT --to-port 53
sudo iptables -t nat -A PREROUTING -i enp10s0u1 -p tcp --dport 80  -j REDIRECT --to-port 8080
```

Enable DNS on dnsmasq (remove `port=0`, resolve systemd-resolved conflict first):
```bash
sudo systemctl disable --now systemd-resolved
sudo sed -i '/^port=0/d' /etc/dnsmasq.conf
echo "address=/#/192.168.100.1" >> /etc/dnsmasq.conf   # all DNS → captive portal
sudo systemctl restart dnsmasq
```

---

## Layer Comparison: Current vs Target

| Layer | Current (VM setup) | Target (MikroTik) |
|---|---|---|
| Internet uplink | Mac Wi-Fi → VMware NAT → Fedora | Direct ethernet or event WiFi |
| Device visibility | L3 only (AX80 hides devices) | L2 full MAC visibility |
| Device identity | WireGuard peer key (app layer) | MAC + RADIUS CoA |
| VLAN isolation | iptables per-tunnel-IP | Hardware VLAN per identity |
| Captive portal | iptables redirect + dnsmasq | DNS hijack + RADIUS |
| NAT layers | Double (AX80 + Fedora) | Single (MikroTik) |
| DHCP authority | AX80 (for LAN), Fedora (for AX80 WAN) | Fedora/Linux direct |

---

## Persistence Notes

These settings do **not survive reboot** on Fedora:

- `ip addr add` on enp10s0u1 — cleared by NetworkManager
- `iptables` rules — cleared unless saved with `iptables-save`
- `sysctl net.ipv4.ip_forward` — reverts unless in `/etc/sysctl.d/`
- `nmcli device set managed no` — survives until NetworkManager restart

To make persistent:

```bash
# IP forward
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-ensca.conf

# iptables
sudo dnf install -y iptables-services
sudo iptables-save | sudo tee /etc/sysconfig/iptables
sudo systemctl enable iptables

# enp10s0u1 static IP via NetworkManager profile
sudo nmcli connection add type ethernet ifname enp10s0u1 \
  con-name ensca-uplink ip4 192.168.100.1/24 gw4 "" ipv4.method manual
sudo nmcli connection up ensca-uplink
```
