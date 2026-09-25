# ENSCA — Demo Setup: MacBook M5 Air + Consumer Router

> Practical event-day guide for running ENSCA on a MacBook M5 Air with any consumer router. No enterprise hardware, no RADIUS, no 802.1X. All enforcement runs in software on the MacBook.

## What Works and What Doesn't on macOS 27

### What works

- **pf firewall** — fully functional on macOS 27 / Darwin 27. `pfctl`, dynamic tables, anchor files all work. No deprecation. Survives reboots via `/Library/LaunchDaemons`.
- **Internet Sharing** — still creates NAT on the shared ethernet interface via pf. Uses `bootpd` as DHCP server internally. Interface is typically `en5` or `en6` for USB-C ethernet adapters (check `ifconfig` after plugging in).
- **dnsmasq via Homebrew** — works on macOS ARM (M-series). `brew install dnsmasq`. You can run dnsmasq alongside Internet Sharing as long as you bind dnsmasq to the ethernet interface only and disable bootpd for that interface.
- **IP forwarding** — `sudo sysctl -w net.inet.ip.forwarding=1` works. Persist in `/etc/sysctl.conf`.
- **OpenSSH + AuthorizedKeysCommand** — macOS ships OpenSSH, `AuthorizedKeysCommand` works. Binary must be owned by root, not group/world writable.
- **Node.js, pm2** — run natively on Apple Silicon via Homebrew or nvm.

### What doesn't / is limited

- **dnctl / dummynet bandwidth shaping** — unreliable on Apple Silicon M-series. ALTQ queuing also has known issues. **Don't rely on bandwidth limiting for the demo** — focus on the identity and access control story instead. If you need it, run a Linux VM (UTM) and do shaping there.
- **L2 device isolation** — the biggest constraint. Traffic between two devices on the same router subnet never reaches the MacBook's pf — it stays within the router's switch fabric. pf can only see and block traffic that is routed through the MacBook (i.e. internet-bound traffic). True L2 isolation between attendees requires hardware VLANs. **Workaround: WireGuard per-identity tunnels** (see below).
- **MAC address visibility** — when devices are behind the consumer router's NAT, the MacBook's ARP table only sees the router's MAC, not individual device MACs. **Fix: disable router NAT/DHCP, run MacBook as DHCP server directly** — then devices get IPs in the MacBook's subnet and their real MACs are visible.

## Constraints & Tradeoffs vs Enterprise Setup

| Feature | Enterprise (MikroTik + RADIUS) | This Setup (MacBook + consumer router) |
|---|---|---|
| VLAN isolation | Hardware-enforced L2 | WireGuard per-identity tunnels |
| Bandwidth limiting | Router QoS via RADIUS attributes | Skip for demo (dnctl unreliable on M-series) |
| Auth flow | RADIUS CoA pushes policy to AP | MacBook pf rules updated post-auth |
| Captive portal redirect | Router redirects unauthenticated traffic | DNS hijack via dnsmasq on MacBook |
| RADIUS fallback | Built-in | Not applicable |
| Max concurrent devices | ~500 | ~50–80 comfortably |

Good enough for a hackathon demo. The identity layer (ENS + wallet sig) is identical — only the enforcement mechanism differs.

---

## Architecture

```
[Event WiFi]
     │  (MacBook connects as a normal WiFi client)
     │
[MacBook M5 Air]  ←── internet uplink via event WiFi (en0)
     │
     │  Ethernet (USB-C adapter → RJ45)
     ▼
[Consumer Router]  (TP-Link / ASUS / Netgear — any)
     │  Router WAN port gets IP from MacBook's Internet Sharing
     │  Router LAN: 192.168.2.0/24
     │
     ├── SSID: ensca-demo
     │    └── Attendee devices get IPs: 192.168.2.10 – 192.168.2.254
     │
     └── (Router is dumb — just a WiFi AP + DHCP relay)

MacBook services (all on 192.168.2.1 from router's perspective):
  ├── dnsmasq          :53    DNS + DHCP override + captive redirect
  ├── captive portal   :3001  Next.js wallet-connect page
  ├── ENSCA service    :3000  ENS resolver + policy API
  ├── API gateway      :4000  RPC/faucet/IPFS proxy
  ├── sshd             :22    SSH via ENS username
  └── pf               —     Per-identity firewall rules
```

---

## Step 1 — macOS Internet Sharing

Connect MacBook to event WiFi (en0). Connect consumer router WAN port to MacBook via USB-C ethernet adapter.

Enable Internet Sharing:
```
System Settings → General → Sharing → Internet Sharing
  Share your connection from: Wi-Fi (en0)
  To computers using: USB Ethernet (en5 or similar)
```

This creates a NAT on the MacBook. The router's WAN gets an IP like `192.168.2.1` from macOS. The router then creates its own subnet (`192.168.3.0/24` typically) for attendee devices.

**Better: disable router's DHCP, let MacBook run dnsmasq as DHCP server.**

On the consumer router:
- Set to AP mode (or disable DHCP server)
- Set WAN IP statically: `192.168.2.2`, gateway `192.168.2.1` (MacBook)
- Attendee devices get IPs directly from MacBook's dnsmasq

This gives the MacBook full visibility of every device IP → MAC mapping, which is needed for pf rules.

---

## Step 2 — Install Tools

```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Core tools
brew install dnsmasq node git

# Optional: for bandwidth limiting
brew install lsof

# Node.js project deps (from /Users/I740422/projects/ensca)
cd ~/projects/ensca
npm install
```

---

## Step 3 — dnsmasq: DHCP + Captive Portal DNS

dnsmasq runs on the MacBook, serves DHCP to all attendee devices, and hijacks DNS for unauthenticated devices.

```
# /opt/homebrew/etc/dnsmasq.conf

interface=en5                        # ethernet interface toward router
bind-interfaces
dhcp-range=192.168.2.10,192.168.2.200,12h
dhcp-option=3,192.168.2.1            # gateway = MacBook
dhcp-option=6,192.168.2.1            # DNS = MacBook

# Default: redirect all DNS to captive portal IP
address=/#/192.168.2.1               # all domains → MacBook

# Per-MAC DNS override — set after wallet auth
# dhcp-host=aa:bb:cc:dd:ee:ff,192.168.2.50,philo-device
# address=/philo-allowed/8.8.8.8     # not how it works — see below
```

**How captive portal DNS works:**

- Before auth: `address=/#/192.168.2.1` sends ALL DNS queries to MacBook's IP
- Browser tries to load any page → DNS returns MacBook IP → HTTP 302 to captive portal
- After auth: per-device pf rule allows real DNS (8.8.8.8) to pass through, MacBook's DNS no longer intercepts that device

Dynamic DNS unblock after auth (called from captive portal backend):

```typescript
// After successful wallet auth for MAC aa:bb:cc:dd:ee:ff
async function grantAccess(mac: string, ensName: string) {
  const ip = await getMacIp(mac)          // from dnsmasq leases file
  const policy = await getPolicy(ensName)

  // 1. Write pf anchor rule allowing this IP real internet + real DNS
  await writePfRule(ip, policy)

  // 2. pf still intercepts DNS for unauthenticated IPs
  //    authenticated IP bypasses the redirect anchor
  await reloadPf()

  // 3. Store session
  sessions.set(mac, { ensName, ip, vlan: identityVlan(ensName), policy })
}
```

---

## Step 3b — Captive Portal OS Detection

Every OS probes specific URLs on connection to detect captive portals and show the "Sign in to network" popup. The MacBook must intercept these and return a redirect.

| OS | Probe URL | Expected response | What triggers popup |
|---|---|---|---|
| iOS / macOS | `http://captive.apple.com/hotspot-detect.html` | HTML with "Success" | 302 redirect |
| Android | `http://connectivitycheck.gstatic.com/generate_204` | HTTP 204 empty | 302 redirect |
| Android (fallback) | `http://clients3.google.com/generate_204` | HTTP 204 empty | 302 redirect |
| Windows | `http://www.msftconnecttest.com/connecttest.txt` | "Microsoft Connect Test" | 302 redirect |
| Linux (NetworkManager) | `http://nmcheck.gnome.org/check_network_status.txt` | "NetworkManager is online" | 302 redirect |
| Firefox | `http://detectportal.firefox.com/canonical.html` | HTML meta refresh | 302 redirect |

The captive portal Next.js app must handle all these URLs and return a 302 to the portal page for unauthenticated devices, and the expected response for authenticated devices.

```typescript
// Captive portal detection handler
app.get([
  '/hotspot-detect.html',
  '/generate_204',
  '/connecttest.txt',
  '/check_network_status.txt',
  '/canonical.html',
], (req, res) => {
  const ip = req.ip
  if (sessions.isAuthed(ip)) {
    // Return expected response so OS knows internet is open
    if (req.path.includes('generate_204')) return res.status(204).send()
    if (req.path.includes('connecttest')) return res.send('Microsoft Connect Test')
    return res.send('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>')
  }
  // Redirect to portal
  res.redirect(302, `http://192.168.2.1:3001/`)
})
```

---

## Step 4 — pf Firewall Rules

macOS pf handles internet gating (block unauthenticated, allow authenticated). **Note: pf cannot isolate devices from each other when they're on the same router subnet — use WireGuard for isolation (Step 4b).**

```
# /etc/pf.anchors/ensca

# Table of authenticated IPs
table <ensca_authed> persist

# Table of IPs per identity group (for isolation)
# Each group is a set of IPs belonging to same ENS name
# Groups written dynamically by ensca service

# Default: block all traffic from unauthenticated IPs except DNS+portal
block in quick on en5 from !<ensca_authed> to any port {80 443} \
  rdr-to 192.168.2.1 port 3001

# Allow unauthenticated DNS (so captive portal can load)
pass in quick on en5 proto udp from any to 192.168.2.1 port 53

# Allow authenticated IPs full internet
pass in quick on en5 from <ensca_authed> to any

# Isolation: block traffic between different identity groups
# Written per-identity by ensca service:
# block in quick on en5 from <group_philo> to <group_alice>
# block in quick on en5 from <group_alice> to <group_philo>
# pass  in quick on en5 from <group_philo> to <group_philo>
```

Load anchor from main pf.conf:
```
# /etc/pf.conf (append)
anchor "ensca"
load anchor "ensca" from "/etc/pf.anchors/ensca"
```

Enable pf:
```bash
sudo pfctl -e
sudo pfctl -f /etc/pf.conf
```

Dynamically add authenticated IP:
```bash
# Called from captive portal backend after successful auth
sudo pfctl -t ensca_authed -T add 192.168.2.50
```

Dynamically add isolation rule:
```bash
# Create per-identity group tables
sudo pfctl -t group_philo -T add 192.168.2.50   # philo's laptop
sudo pfctl -t group_philo -T add 192.168.2.51   # philo's phone (same ENS)

# Block cross-group traffic (written to anchor file, reloaded)
echo "block in quick on en5 from <group_alice> to <group_philo>" \
  >> /etc/pf.anchors/ensca
sudo pfctl -f /etc/pf.conf
```

**Limitation:** pf only sees traffic routed through the MacBook (internet-bound). Device-to-device traffic within the router's subnet never reaches the MacBook's pf. Use WireGuard (Step 4b) for real per-identity isolation.

---

## Step 4b — WireGuard Per-Identity Isolation (replaces VLAN)

Since pf can't isolate devices at L2, WireGuard is the clean solution. Each authenticated identity gets a WireGuard peer config. All traffic flows through WireGuard tunnels — the MacBook sees and controls everything.

```
brew install wireguard-tools
```

MacBook WireGuard server config:
```ini
# /opt/homebrew/etc/wireguard/ensca.conf
[Interface]
PrivateKey = <server_private_key>
Address = 10.0.0.1/8
ListenPort = 51820

# Philo's laptop (auto-added at auth time)
[Peer]
PublicKey = <philo_laptop_pubkey>
AllowedIPs = 10.1.42.1/32   # derived from identityVlan

# Philo's phone (same identity — same /24 subnet)
[Peer]
PublicKey = <philo_phone_pubkey>
AllowedIPs = 10.1.42.2/32
```

Identity subnet assignment:
```typescript
// Each ENS identity gets a /24 within 10.x.x.0/8
// Devices within same identity share the /24 — can reach each other
// Devices in different identities are in different /24s — blocked by default
function identitySubnet(ensName: string): string {
  const node = namehash(normalize(ensName))
  const a = parseInt(node.slice(2, 4), 16)   // 0-255
  const b = parseInt(node.slice(4, 6), 16)   // 0-255
  return `10.${a}.${b}.0/24`
  // philo → 10.42.17.0/24
  // alice → 10.87.203.0/24  (different subnet, no cross-talk)
}
```

pf rule to block cross-identity WireGuard traffic:
```
# All WireGuard traffic goes through utun interface
# Block routing between different 10.x.x.0/24 subnets
block in quick on utun0 from 10.42.0.0/16 to 10.87.0.0/16
block in quick on utun0 from 10.87.0.0/16 to 10.42.0.0/16
# Allow within same /24 (same identity)
pass  in quick on utun0 from 10.42.17.0/24 to 10.42.17.0/24
```

**Tradeoff:** WireGuard requires the attendee to install a WireGuard client and import a config. Add this to the captive portal flow — after wallet auth, portal shows a QR code for the WireGuard config. Every major OS has a WireGuard client app.

---

## Router Recommendations

Any consumer router works. Best options at ~$30–60 globally available:

| Model | Price | WiFi | AP mode | Notes |
|---|---|---|---|---|
| TP-Link Archer AX23 | ~$50 | WiFi 6 | Yes, reliable | Best overall pick |
| TP-Link Archer AX20 | ~$40 | WiFi 6 | Yes | Slightly less range |
| TP-Link TL-WR840N | ~$20 | WiFi 5 | Yes | Budget pick, fine for <30 devices |
| ASUS RT-AX53U | ~$60 | WiFi 6 | Yes | Best range option |
| TP-Link Archer C6 | ~$35 | WiFi 5 | Yes | Widely available in Asia |

**TP-Link Archer AX23 is the recommendation** — widely available in Japan/Asia, reliable AP mode, WiFi 6 handles 50+ devices cleanly.

AP mode setup on any TP-Link (universal):
```
1. Connect laptop to router via ethernet
2. Open 192.168.0.1 in browser
3. Quick Setup → Operation Mode → Access Point
4. Set SSID: ensca-demo, password: optional
5. Disable DHCP (router hands DHCP to MacBook)
6. Save — router reboots in AP mode
```

**Critical: disable "client isolation" in router settings** if present. Client isolation blocks devices from seeing each other even within the same SSID — you want the MacBook's WireGuard to handle isolation, not the router.

---

## Step 5 — Bandwidth Limiting

macOS ALTQ (pf's bandwidth shaper) has limited support on Apple Silicon. Use `dnctl` + `pfctl` pipe-based shaping instead:

```bash
# Create a pipe for philo's IP with 50 Mbps limit
sudo dnctl pipe 100 config bw 50Mbit/s
sudo pfctl -t ensca_pipes -T add 192.168.2.50

# pf rule to send philo's traffic through pipe 100
echo "dummynet in quick on en5 from 192.168.2.50 pipe 100" \
  >> /etc/pf.anchors/ensca
sudo pfctl -f /etc/pf.conf
```

Pipe numbers are assigned per-identity at auth time. Clean up on disconnect.

**Alternative if dnctl is flaky on M5:** skip bandwidth limiting for the demo and focus on the identity + isolation story. Bandwidth limits are policy, not core to the ENS identity demo.

---

## Step 6 — SSH on macOS

macOS ships with OpenSSH. `AuthorizedKeysCommand` works on macOS with one gotcha: the command must be owned by root and not group/world writable.

```bash
# Enable SSH
sudo systemsetup -setremotelogin on

# Or: System Settings → General → Sharing → Remote Login → On
```

```
# /etc/ssh/sshd_config (add these lines)
AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
AuthorizedKeysCommandUser nobody
PubkeyAuthentication yes
PasswordAuthentication no
```

Fix permissions (required on macOS):
```bash
sudo chown root:wheel /usr/local/bin/ensca-keys
sudo chmod 755 /usr/local/bin/ensca-keys
```

Test:
```bash
ssh philo.tokyo2026.ethglobal.eth@localhost
# sshd calls ensca-keys "philo.tokyo2026.ethglobal.eth"
# ensca-keys resolves ENS → returns ssh-pubkey text record
# standard pubkey auth proceeds
```

---

## Step 7 — Running All Services

Use a `Procfile`-style launcher or just multiple terminal tabs for demo:

```bash
# Terminal 1: ENSCA core service
cd ~/projects/ensca && node services/ensca-service.js

# Terminal 2: Captive portal
cd ~/projects/ensca && node services/captive-portal.js

# Terminal 3: API gateway
cd ~/projects/ensca && node services/api-gateway.js

# Terminal 4: dnsmasq (foreground for visibility)
sudo dnsmasq --no-daemon --log-queries
```

Or use `pm2` for cleaner process management:
```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 logs
```

---

## Day-of-Event Checklist

```
[ ] MacBook connected to event WiFi — confirm internet works
[ ] USB-C ethernet adapter plugged in, router connected
[ ] Internet Sharing enabled (WiFi → USB Ethernet)
[ ] Router set to AP mode, DHCP disabled
[ ] dnsmasq running: sudo brew services start dnsmasq
[ ] pf enabled: sudo pfctl -e && sudo pfctl -f /etc/pf.conf
[ ] ENSCA services running: pm2 start
[ ] SSH enabled: System Settings → Sharing → Remote Login
[ ] Test: connect a device to router SSID
       → browser should redirect to captive portal
[ ] Test: authenticate with a test wallet
       → should get internet access
[ ] Test: ssh test.tokyo2026.ethglobal.eth@<macbook-ip>
       → should authenticate via ENS pubkey record
[ ] ENS relayer funded: check balance on relayer wallet
[ ] Confirm RPC endpoint responds: curl localhost:4000/rpc/eth_blockNumber
```

---

## Known Limitations vs Enterprise Setup

1. **L2 isolation not enforced** — devices on same subnet can ARP each other. pf blocks routed traffic but not direct L2 frames. Acceptable for demo, not production.

2. **pf reload latency** — rule changes take ~100ms to apply. Edge case: brief window between auth and rule load.

3. **MacBook as SPOF** — if MacBook sleeps or crashes, everyone loses internet. Disable sleep: `sudo pmset -b sleep 0 disksleep 0`.

4. **~50-80 device limit** — dnsmasq + pf handles this fine. Above ~100 concurrent devices, pf table operations get slow.

5. **No hardware QoS** — `dnctl` pipes work but are less precise than router QoS. Bursts can exceed limits briefly.

6. **macOS updates** — avoid running Software Update during the event. pf config survives reboots if loaded from `/etc/pf.conf`.

---

## Disable Sleep (Critical)

```bash
# Prevent MacBook from sleeping while on power
sudo pmset -c sleep 0
sudo pmset -c disksleep 0
sudo pmset -c displaysleep 10   # screen can sleep, system cannot

# Verify
pmset -g
```
