# ENSCA Demo — Option B: Phone USB Tethering + MacBook as AP

## The Setup

Phone connects to event WiFi → USB tethers to MacBook → MacBook broadcasts its own SSID via built-in WiFi → all attendee traffic flows through MacBook → pf sees and controls everything including device-to-device traffic.

```
[Event WiFi]
     │
     ▼
[Phone] (iOS or Android)
  USB-C cable
     │
     ▼
[MacBook M5 Air]
  ├── en0 (built-in WiFi) → broadcasts "ensca-demo" SSID
  ├── iPhone USB interface (appears as en6 or similar)
  │     ↑ internet uplink via phone tethering
  │
  ├── dnsmasq       :53    DHCP + DNS hijack
  ├── captive portal :3001  wallet-connect page
  ├── ENSCA service  :3000  ENS resolver + policy
  ├── API gateway    :4000  RPC/faucet proxy
  ├── sshd           :22    SSH via ENS username
  └── pf             —     per-client firewall + isolation

Attendees connect to "ensca-demo" WiFi hosted by MacBook.
MacBook sees ALL traffic — internet-bound AND device-to-device.
pf can enforce full per-identity isolation.
```

## Why This Works Better Than a Router

When MacBook is the AP, attendee devices talk directly to the MacBook's WiFi interface. There is no intermediate router. The MacBook's pf sees:
- Every packet from every device
- Device-to-device traffic (it routes between them)
- DNS queries (for captive portal)

This means real per-identity isolation is possible with pf rules — no WireGuard, no hardware VLANs.

## Step 1 — Phone USB Tethering

**iPhone:**
```
Settings → Personal Hotspot → OFF (hotspot must be OFF)
Connect iPhone to MacBook via USB-C
Settings → Personal Hotspot → Allow Others to Join → ON
macOS will see a new network interface (RNDIS/CDC-ECM)
```

**Android:**
```
Settings → Connections → Mobile Hotspot and Tethering → USB Tethering → ON
```

Verify the interface appeared on MacBook:
```bash
ifconfig | grep -E "^en[0-9]"
# New interface appears, e.g. en6 or en7
# It will have an IP in the phone's tethering subnet (172.20.10.x for iPhone)
```

Confirm internet works through tether:
```bash
curl -I https://google.com
# Should return HTTP 200
```

## Step 2 — MacBook WiFi Hotspot

Since internet comes via USB (not WiFi), the built-in WiFi chip is free to broadcast.

```
System Settings → General → Sharing → Internet Sharing
  Share your connection from: iPhone USB  (or the tether interface name)
  To computers using: Wi-Fi
  
Wi-Fi Options:
  Network Name: ensca-demo
  Security: WPA2
  Password: (set something, or leave open for demo ease)
```

macOS Internet Sharing will:
- Create a NAT on the WiFi interface
- Start `bootpd` serving DHCP on 192.168.3.1/24
- Broadcast the SSID

Verify:
```bash
# MacBook WiFi interface (en0) should now have 192.168.3.1
ifconfig en0 | grep inet
# → inet 192.168.3.1

# bootpd should be running
ps aux | grep bootpd
```

## Step 3 — Replace bootpd with dnsmasq

Kill bootpd and run dnsmasq instead so we control DHCP and DNS:

```bash
# Stop bootpd
sudo launchctl unload /System/Library/LaunchDaemons/bootps.plist 2>/dev/null || true
sudo killall bootpd 2>/dev/null || true
```

```bash
# /opt/homebrew/etc/dnsmasq.conf
cat > /opt/homebrew/etc/dnsmasq.conf << 'EOF'
interface=en0
bind-interfaces

# DHCP range — attendees get IPs in 192.168.3.x
dhcp-range=192.168.3.10,192.168.3.200,12h
dhcp-option=3,192.168.3.1        # gateway = MacBook
dhcp-option=6,192.168.3.1        # DNS = MacBook

# Unauthenticated: all DNS → captive portal
address=/#/192.168.3.1

# Log DHCP leases (used to map MAC → IP)
dhcp-leasefile=/tmp/ensca-leases
log-dhcp
EOF

sudo brew services start dnsmasq
```

## Step 4 — pf Rules

With MacBook as the AP, pf on en0 sees all traffic. Full enforcement possible.

```bash
# /etc/pf.anchors/ensca
cat > /etc/pf.anchors/ensca << 'EOF'
# Authenticated IPs table
table <ensca_authed> persist

# Per-identity group tables (added dynamically)
# table <grp_philo> persist
# table <grp_alice> persist

# Redirect unauthenticated HTTP to captive portal
rdr pass on en0 proto tcp from !<ensca_authed> to any port 80 \
  -> 192.168.3.1 port 3001

# Block unauthenticated HTTPS (show error, not portal — acceptable for demo)
block drop on en0 from !<ensca_authed> to any port 443

# Allow unauthenticated DNS to reach MacBook only
pass on en0 proto udp from !<ensca_authed> to 192.168.3.1 port 53

# Allow authenticated IPs full internet
pass on en0 from <ensca_authed> to any

# Per-identity isolation (added dynamically after auth):
# block on en0 from <grp_alice> to <grp_philo>
# block on en0 from <grp_philo> to <grp_alice>
# pass  on en0 from <grp_philo> to <grp_philo>
EOF

# Load anchor
echo 'anchor "ensca"' | sudo tee -a /etc/pf.conf
echo 'load anchor "ensca" from "/etc/pf.anchors/ensca"' | sudo tee -a /etc/pf.conf

sudo pfctl -e
sudo pfctl -f /etc/pf.conf
```

After wallet auth, grant access:
```bash
sudo pfctl -t ensca_authed -T add 192.168.3.50
```

Per-identity isolation (philo's two devices can see each other, nobody else can):
```typescript
async function applyIsolation(ensName: string, newIp: string) {
  const groupTable = `grp_${ensName.split('.')[0]}`

  // Add IP to identity group table
  execSync(`sudo pfctl -t ${groupTable} -T add ${newIp}`)

  // Rebuild isolation rules in anchor
  const groups = await getAllGroups()
  const rules = []

  for (const [g1, ips1] of groups) {
    for (const [g2, ips2] of groups) {
      if (g1 !== g2) {
        rules.push(`block on en0 from <${g1}> to <${g2}>`)
      }
    }
    rules.push(`pass on en0 from <${g1}> to <${g1}>`)
  }

  writeFileSync('/etc/pf.anchors/ensca-isolation', rules.join('\n'))
  execSync('sudo pfctl -f /etc/pf.conf')
}
```

## Step 5 — SSH

No change from main setup. `AuthorizedKeysCommand` on macOS en0 interface works identically.

```
# /etc/ssh/sshd_config
AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
AuthorizedKeysCommandUser nobody
PubkeyAuthentication yes
PasswordAuthentication no
```

SSH address for attendees: `ssh name.tokyo2026.ethglobal.eth@192.168.3.1`

Or set a hostname: `ensca.local` via mDNS (macOS broadcasts this automatically).

## Limitations

- **Phone battery** — keep phone plugged into power. USB tethering drains battery fast.
- **Event WiFi blocks tethering** — some event networks detect and block USB tethering. Test before the event. If blocked, fall back to phone's cellular data (costs data but works).
- **MacBook WiFi range** — built-in WiFi is good but not AP-grade. Fine for a demo table with 5–15 devices nearby. Not for a 50-device room.
- **~30–40 device max** — MacBook's WiFi chip in hotspot mode handles this comfortably.
- **No consumer router needed** — saves ~$50 vs other options.

## Day-of Checklist

```
[ ] Phone connected to event WiFi, confirmed working
[ ] Phone USB-C to MacBook, tethering enabled
[ ] ifconfig shows tether interface with IP (172.20.10.x)
[ ] curl -I https://google.com works on MacBook
[ ] Internet Sharing: iPhone USB → Wi-Fi, SSID "ensca-demo"
[ ] bootpd killed, dnsmasq running
[ ] Test device connects to "ensca-demo" → gets 192.168.3.x IP
[ ] Browser opens → redirects to captive portal
[ ] pf loaded: sudo pfctl -e && sudo pfctl -f /etc/pf.conf
[ ] ENSCA services running: pm2 start
[ ] SSH enabled, AuthorizedKeysCommand configured
[ ] Phone on power bank or wall charger
[ ] MacBook sleep disabled: sudo pmset -c sleep 0
```
