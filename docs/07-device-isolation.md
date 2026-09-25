# ENSCA — Device Isolation & Cross-Device Communication

## Overview

Every attendee's devices form a private network group. Devices authenticated under the same ENS name can reach each other freely. No other device on the network can see them. A local port exposed during hacking is visible only to your own machines.

This is implemented via per-identity VLAN assignment at the network layer. No software configuration required on the device side.

## How It Works

When a device authenticates via the captive portal, the server checks for existing sessions under the same ENS name:

```
philo's laptop authenticates:
  → signs challenge as philo.tokyo2026.ethglobal.eth
  → no existing session found for this ENS name
  → assigned identity VLAN 1042 (derived from namehash)
  → MikroTik puts laptop in VLAN 1042

philo's phone authenticates:
  → signs challenge as philo.tokyo2026.ethglobal.eth
  → existing session found: laptop is in VLAN 1042
  → phone assigned to VLAN 1042
  → laptop and phone can now reach each other
  → neither can reach any device in VLAN 1041 or 1043
```

## VLAN Assignment

Identity VLANs are derived deterministically from the ENS namehash:

```typescript
import { namehash } from 'viem'
import { normalize } from 'viem/ens'

function identityVlan(ensName: string): number {
  const node = namehash(normalize(ensName))
  // Use first 2 bytes of namehash as offset, within role's VLAN range
  const offset = parseInt(node.slice(2, 6), 16) % 900
  return 1000 + offset  // identity VLANs: 1000–1899
}

// Examples:
// philo.tokyo2026.ethglobal.eth  → VLAN 1042
// ann.tokyo2026.ethglobal.eth    → VLAN 1387
// marco.tokyo2026.ethglobal.eth  → VLAN 1156
```

Deterministic assignment means the VLAN for any given attendee is always the same, even across reconnects or multiple events — no state needed to look it up.

Collision probability with 500 attendees across 900 possible VLANs: ~24%. For a demo this is fine. Production would use the full 12-bit VLAN space (VLANs 1000–4094) and check for collisions at mint time.

## Multi-Device Session Management

```typescript
interface DeviceSession {
  mac: string
  ensName: string
  vlan: number
  connectedAt: number
  ipAddress: string
}

// In-memory session store (Redis in production)
const sessions = new Map<string, DeviceSession>()  // keyed by MAC

async function assignVlan(ensName: string, mac: string): Promise<number> {
  // Check if any device for this ENS name is already connected
  const existingSessions = [...sessions.values()]
    .filter(s => s.ensName === ensName)

  if (existingSessions.length > 0) {
    // Use same VLAN as existing devices
    return existingSessions[0].vlan
  }

  // New identity — derive VLAN from namehash
  return identityVlan(ensName)
}
```

## What Isolation Means in Practice

**Philo's laptop and phone can:**
- Ping each other by IP
- Access services running on each other (localhost:3000 on laptop is reachable from phone)
- Share files over LAN
- Test mobile ↔ desktop interactions for their dApp

**Philo's devices cannot:**
- Reach ann's laptop or phone
- See any broadcast traffic from other attendees
- Be scanned or probed by other devices on the network

**From the network layer:**
- Each identity VLAN is an isolated L2 broadcast domain
- Inter-VLAN routing is disabled by default
- Only outbound internet traffic is routed (through the MikroTik NAT)
- Intra-identity traffic stays within the VLAN, never touches the router

## RouterOS Configuration

MikroTik RouterOS configuration for VLAN isolation:

```
# Bridge for per-identity VLANs (vlan-filtering enabled)
/interface bridge
add name=bridge-ensca vlan-filtering=yes

# WiFi interface added to bridge
/interface bridge port
add bridge=bridge-ensca interface=wlan1

# Per-identity VLANs are created dynamically by FreeRADIUS CoA
# Static example for VLAN 1042:
/interface bridge vlan
add bridge=bridge-ensca tagged=bridge-ensca vlan-ids=1042

# No inter-VLAN routing — isolation enforced by absence of routes
# Each VLAN only has a default route to WAN
/ip route
add dst-address=0.0.0.0/0 gateway=<WAN_IP> routing-table=vlan-1042
```

FreeRADIUS sends a CoA (Change of Authorization) packet to MikroTik after each captive portal auth, dynamically assigning the VLAN. No manual router configuration per attendee.

## Organizer Override

Organizers can grant cross-identity visibility for specific use cases (e.g. a mentor needs to reach a hacker's dev server):

```
POST /admin/allow-cross-vlan
{
  "from": "marco.tokyo2026.ethglobal.eth",  // mentor
  "to": "philo.tokyo2026.ethglobal.eth",    // hacker
  "signature": "0x..."                       // organizer wallet sig
}
```

This creates a static route between the two VLANs on the MikroTik. Revoked when either party disconnects.
