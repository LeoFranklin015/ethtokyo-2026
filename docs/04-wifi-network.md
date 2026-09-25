# ENSCA — WiFi & Network Layer

## Overview

The network layer enforces role-based access and per-identity isolation using commodity hardware (MikroTik hAP ax lite) and FreeRADIUS. The ENS resolver is the only new component — everything else is standard enterprise WiFi infrastructure.

## Hardware

**MikroTik hAP ax lite (~$45)**
- WiFi 6 (802.11ax), dual-band
- Built-in switch (5 ports), router, and AP in one device
- RouterOS — supports 802.1X, RADIUS, dynamic VLAN, QoS natively
- No separate controller needed
- PoE on port 1 (if needed), standard power adapter included

**Server (existing)**
- Runs FreeRADIUS + ENSCA resolver service + captive portal
- Connected to MikroTik via ethernet

## Network Topology

```
Internet
    │
    ▼
MikroTik hAP ax lite
    ├── Port 1: WAN (internet uplink)
    ├── Port 2: Server (FreeRADIUS + ENSCA services)
    └── WiFi: broadcasts SSIDs, handles RADIUS auth
         │
         ├── SSID: ethglobal-hacker   → VLAN 100
         ├── SSID: ethglobal-mentor   → VLAN 200
         ├── SSID: ethglobal-volunteer→ VLAN 300
         ├── SSID: ethglobal-pragma   → VLAN 400
         └── SSID: ethglobal-staff    → VLAN 10

Each VLAN is isolated at L2. Devices in VLAN 100 cannot reach VLAN 200.
Per-identity sub-VLANs (for device isolation) sit inside the role VLAN.
```

## Authentication Flow

```
1. Attendee connects to SSID (e.g. ethglobal-hacker)
2. MikroTik serves DHCP → attendee gets IP
3. All traffic redirected to captive portal (DNS hijack + HTTP redirect)
4. Captive portal loads in browser:
     - "Connect your wallet to get on the network"
     - WalletConnect QR or browser wallet prompt
5. Portal generates challenge: sha256(nonce + timestamp + mac_address)
6. Attendee signs with wallet (hardware or mobile)
7. Portal backend:
     a. Recovers signer address from signature
     b. Resolves reverse ENS: address → ENS name
     c. Checks name is under *.tokyo2026.ethglobal.eth
     d. Reads wifi-vlan, wifi-bandwidth text records
     e. Calls FreeRADIUS CoA (Change of Authorization) with:
          - VLAN assignment
          - Bandwidth policy
          - Session timeout
8. FreeRADIUS sends CoA to MikroTik
9. MikroTik moves device to correct VLAN, applies QoS
10. Browser redirected: "You're on the network as philo.tokyo2026.ethglobal.eth"
```

## FreeRADIUS Configuration

```
# /etc/freeradius/3.0/mods-enabled/exec
exec ensca {
    wait = yes
    program = "/usr/local/bin/ensca-radius-check %{User-Name}"
    input_pairs = request
    output_pairs = reply
    shell_escape = yes
}
```

```python
# /usr/local/bin/ensca-radius-check
# Called by FreeRADIUS with the ENS name as User-Name
# Returns RADIUS attributes for VLAN + QoS

import sys
import requests

ens_name = sys.argv[1]  # e.g. "philo.tokyo2026.ethglobal.eth"

# Call ENSCA resolver service
resp = requests.get(f"http://localhost:3000/policy/{ens_name}")
policy = resp.json()

if not policy or not policy.get('active'):
    print("Auth-Type := Reject")
    sys.exit(1)

# Return RADIUS attributes
print(f"Tunnel-Type = VLAN")
print(f"Tunnel-Medium-Type = IEEE-802")
print(f"Tunnel-Private-Group-Id = {policy['vlan']}")
print(f"Session-Timeout = {policy['session_timeout']}")
print(f"WISPr-Bandwidth-Max-Down = {policy['bandwidth_down']}")
print(f"WISPr-Bandwidth-Max-Up = {policy['bandwidth_up']}")
sys.exit(0)
```

## Per-Identity Device Isolation

Each attendee's devices share a private VLAN derived from their namehash. This sits inside the role VLAN as a micro-segment.

```
VLAN 100 (hacker role)
├── Sub-VLAN 1001 (philo's devices — namehash derived)
│    ├── philo's laptop (MAC: aa:bb:cc:...)
│    └── philo's phone (MAC: dd:ee:ff:...)
├── Sub-VLAN 1002 (alice's devices)
└── Sub-VLAN 1003 (bob's devices)
```

VLAN ID assignment:
```typescript
// Deterministic VLAN from ENS namehash — no collision for up to ~200 attendees
function identityVlan(ensName: string, roleBaseVlan: number): number {
  const node = namehash(normalize(ensName))
  const offset = parseInt(node.slice(2, 6), 16) % 200
  return roleBaseVlan * 10 + offset
}
```

MikroTik RouterOS supports 4094 VLANs — more than enough for an event.

When a second device authenticates with the same ENS name, the captive portal detects the existing session and assigns the same sub-VLAN:

```
POST /auth
{ signature: "0x...", mac: "dd:ee:ff:..." }

→ recover address
→ resolve ENS name: philo.tokyo2026.ethglobal.eth
→ check existing sessions for this ENS name
→ found: session for aa:bb:cc (philo's laptop), vlan 1001
→ assign dd:ee:ff to vlan 1001 as well
→ both devices can now reach each other on vlan 1001
→ neither can reach vlan 1002 or 1003
```

## Access Hours Enforcement

FreeRADIUS `Session-Timeout` attribute handles session expiry. For roles with restricted hours (volunteers: 08:00–23:00):

```python
import datetime

now = datetime.datetime.now()
if policy['hours'] != '24/7':
    open_hour, close_hour = parse_hours(policy['hours'])
    if now.hour >= close_hour or now.hour < open_hour:
        print("Auth-Type := Reject")
        sys.exit(1)
    # Session expires at close_hour
    seconds_until_close = (close_hour - now.hour) * 3600
    print(f"Session-Timeout = {seconds_until_close}")
```

## Bandwidth Enforcement

MikroTik RouterOS QoS via RADIUS-returned attributes:

```
WISPr-Bandwidth-Max-Down = 52428800   # 50 Mbps in bps
WISPr-Bandwidth-Max-Up   = 10485760   # 10 Mbps up
```

Per-identity sub-queue in RouterOS Simple Queue, created dynamically when device joins.

## Captive Portal Stack

```
Next.js app (port 3001)
├── GET  /                → wallet connect page
├── POST /auth            → verify signature, call RADIUS CoA
├── GET  /status/:mac     → check if MAC is authorized
└── GET  /me              → show identity + role for connected device

Node.js ENSCA service (port 3000)
├── GET  /policy/:ensName → return wifi/ssh/tool policy for name
├── POST /revoke/:ensName → revoke access (organizer only)
└── GET  /sessions        → active sessions (organizer only)
```

## Signature Verification

```typescript
import { recoverMessageAddress, hashMessage } from 'viem'

async function verifyAuth(signature: `0x${string}`, mac: string, nonce: string) {
  const message = `ENSCA auth\nnonce: ${nonce}\ndevice: ${mac}\ntime: ${Math.floor(Date.now() / 1000)}`
  const address = await recoverMessageAddress({ message, signature })

  // Reverse resolve to ENS name
  const ensName = await client.getEnsName({ address })
  if (!ensName) throw new Error('No ENS name for address')

  // Check it's under the event domain
  if (!ensName.endsWith('.tokyo2026.ethglobal.eth')) {
    throw new Error('Not an event subname')
  }

  return { address, ensName }
}
```

Nonce is a server-generated UUID, single-use, 5-minute TTL. Prevents replay attacks.
