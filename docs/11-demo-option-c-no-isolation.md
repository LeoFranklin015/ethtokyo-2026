# ENSCA Demo — Option C: Consumer Router, No Device Isolation

## The Setup

Simplest possible demo. MacBook connects to event WiFi, shares via ethernet to a consumer router, router handles WiFi for attendees. No WireGuard, no USB adapter, no isolation between devices.

```
[Event WiFi]
     │
     ▼
[MacBook M5 Air]  ← internet via event WiFi (en0)
  USB-C ethernet adapter
     │
     ▼
[Consumer Router]  (AP mode, DHCP off)
     │
     └── SSID: ensca-demo
          └── Attendee devices → 192.168.2.x

MacBook enforces:
  ✓ ENS-gated internet access (pf + captive portal)
  ✓ Role-based policy (text records)
  ✓ Dev tool quotas (API gateway)
  ✓ SSH via ENS name
  ✗ Device-to-device isolation (not possible without hardware VLANs)
```

## What You Demo

Focus the story on what works cleanly:

1. **Identity-gated access** — no subname, no internet. Show someone trying to connect without a wallet and getting blocked.
2. **Role policies** — connect as a hacker (50 Mbps, limited tools) vs organizer (unlimited). Show the difference.
3. **SSH via ENS** — `ssh philo.tokyo2026.ethglobal.eth@192.168.2.1` just works.
4. **Dev tools** — hit the RPC endpoint, hit the faucet, watch the quota counter.
5. **Live dashboard** — show organizer view with active identities, bandwidth, tool usage.
6. **Revocation** — burn a subname, watch that identity lose internet access within seconds.

For isolation: explain it verbally. "On enterprise hardware with RADIUS and VLANs, or with the phone-tether setup, each identity's devices are fully isolated at the network layer. The identity and policy layer is identical — we're just enforcing it in software here."

## Step 1 — macOS Internet Sharing

```
System Settings → General → Sharing → Internet Sharing
  Share your connection from: Wi-Fi (en0)
  To computers using: USB Ethernet (en5 or en6 — check ifconfig after plugging in)
```

Find your USB-C ethernet interface name:
```bash
ifconfig | grep -E "^en"
# en0: built-in WiFi
# en5: (or en6/en7) — USB-C ethernet adapter
```

Verify the router WAN got an IP from macOS:
```bash
# Should see 192.168.2.x assigned to ethernet interface
ifconfig en5 | grep inet
```

## Step 2 — Router in AP Mode

On the consumer router (TP-Link example):
```
1. Connect laptop to router LAN port via ethernet
2. Open 192.168.0.1 → Quick Setup → Access Point mode
3. SSID: ensca-demo
4. Disable DHCP server
5. Save and reboot
```

After reboot, plug router WAN port into MacBook's USB-C ethernet adapter.

## Step 3 — dnsmasq DHCP + DNS

```bash
brew install dnsmasq

cat > /opt/homebrew/etc/dnsmasq.conf << 'EOF'
interface=en5
bind-interfaces
dhcp-range=192.168.2.10,192.168.2.200,12h
dhcp-option=3,192.168.2.1
dhcp-option=6,192.168.2.1
address=/#/192.168.2.1
dhcp-leasefile=/tmp/ensca-leases
log-dhcp
EOF

sudo brew services start dnsmasq
```

## Step 4 — pf: Internet Gating Only

No isolation rules — just block unauthenticated devices from internet.

```bash
cat > /etc/pf.anchors/ensca << 'EOF'
table <ensca_authed> persist

# Redirect unauthenticated HTTP to captive portal
rdr pass on en5 proto tcp from !<ensca_authed> to any port 80 \
  -> 192.168.2.1 port 3001

# Block unauthenticated HTTPS
block drop on en5 from !<ensca_authed> to any port 443

# Allow unauthenticated DNS to MacBook only
pass on en5 proto udp from !<ensca_authed> to 192.168.2.1 port 53

# Authenticated — full internet
pass on en5 from <ensca_authed> to any
EOF

echo 'anchor "ensca"' | sudo tee -a /etc/pf.conf
echo 'load anchor "ensca" from "/etc/pf.anchors/ensca"' | sudo tee -a /etc/pf.conf
sudo pfctl -e
sudo pfctl -f /etc/pf.conf
```

## Step 5 — ENSCA Services

```bash
npm i -g pm2
cd ~/projects/ensca
pm2 start ecosystem.config.js
pm2 logs
```

Services:
- `ensca-service` on port 3000 — ENS resolver, policy API, session store
- `captive-portal` on port 3001 — wallet-connect, signature verify, pf grant
- `api-gateway` on port 4000 — RPC/faucet/IPFS with per-identity quotas

## Step 6 — SSH

```bash
sudo systemsetup -setremotelogin on
```

```
# /etc/ssh/sshd_config
AuthorizedKeysCommand /usr/local/bin/ensca-keys %u
AuthorizedKeysCommandUser nobody
PubkeyAuthentication yes
PasswordAuthentication no
```

```bash
sudo chown root:wheel /usr/local/bin/ensca-keys
sudo chmod 755 /usr/local/bin/ensca-keys
sudo launchctl stop com.openssh.sshd
sudo launchctl start com.openssh.sshd
```

## Captive Portal OS Detection

The captive portal must handle OS probe URLs so devices show the "Sign in" popup:

| OS | Probe URL |
|---|---|
| iOS / macOS | `http://captive.apple.com/hotspot-detect.html` |
| Android | `http://connectivitycheck.gstatic.com/generate_204` |
| Windows | `http://www.msftconnecttest.com/connecttest.txt` |
| Linux | `http://nmcheck.gnome.org/check_network_status.txt` |
| Firefox | `http://detectportal.firefox.com/canonical.html` |

Return 302 redirect to portal for unauthenticated IPs. Return expected response for authenticated IPs.

## Revocation Demo

The most dramatic part of the demo:

```typescript
// Organizer calls: POST /admin/revoke { ensName: "eve.tokyo2026.ethglobal.eth" }
async function revokeAccess(ensName: string) {
  const sessions = getSessionsByEns(ensName)

  for (const session of sessions) {
    // Remove from authenticated table
    execSync(`sudo pfctl -t ensca_authed -T delete ${session.ip}`)
  }

  // Mark subname as revoked in ENSCA DB
  await db.revokeIdentity(ensName)
}
```

From the moment `pfctl -T delete` runs, that device loses internet. DNS still resolves to captive portal. They reconnect and see "Access revoked."

## Hardware Needed

- USB-C to ethernet adapter (~$15–25)
- Any consumer router with AP mode (~$30–50)
- Short ethernet cable (~$5)

Total: ~$50–80

## Day-of Checklist

```
[ ] MacBook on event WiFi, internet works
[ ] USB-C ethernet adapter plugged in
[ ] Router WAN connected to adapter, set to AP mode
[ ] Router SSID "ensca-demo" visible on test device
[ ] dnsmasq running: sudo brew services start dnsmasq
[ ] Test device gets 192.168.2.x IP from dnsmasq
[ ] Browser opens → redirects to captive portal
[ ] pf loaded: sudo pfctl -e
[ ] ENSCA services running: pm2 status
[ ] SSH working: ssh test.tokyo2026.ethglobal.eth@192.168.2.1
[ ] Relayer wallet has ETH for subname minting
[ ] MacBook sleep disabled: sudo pmset -c sleep 0
[ ] MacBook on power, not battery
```
