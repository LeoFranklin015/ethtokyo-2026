# ENSCA — Device Isolation & Cross-Device Communication

## Current Implementation (ETHTokyo 2026 Demo)

Software-tier isolation via iptables. Hardware VLANs not available on AX80.

### How It Works

At login, `app.py` assigns the device IP to a tier (basic/staff/vip). Cross-tier DROP rules are inserted immediately:

```python
def _apply_cross_tier_rules(ip, tier, action):
    for other_ip, other_tier in AUTHED_IPS.items():
        if other_tier == tier or other_ip == ip:
            continue
        # Block traffic in both directions between different tiers
        iptables(f"-{action} FORWARD -s {ip} -d {other_ip} -j DROP")
        iptables(f"-{action} FORWARD -s {other_ip} -d {ip} -j DROP")
```

**Same-tier devices** can reach each other freely — their traffic passes the ACCEPT rule before hitting the DROP.

**Different-tier devices** — traffic between them hits an explicit DROP. A basic-tier device cannot reach a staff-tier device and vice versa.

### Tier Definitions

| Tier | Credentials | Download cap | Isolation |
|---|---|---|---|
| basic | basic / basic2026 | 5 Mbps | blocked from staff + vip |
| staff | staff / staff2026 | 10 Mbps | blocked from basic + vip |
| vip | vip / vip2026 | unlimited | blocked from basic + staff |

### Limitations vs Hardware VLANs

- Isolation is L3 (iptables FORWARD). Direct L2 frames within AX80's subnet bypass the VM entirely and are not blocked. True L2 isolation requires hardware VLANs.
- For the demo context (ETHTokyo 2026), L3 isolation is sufficient — it blocks all routed traffic between tiers.
- Per-device identity within a tier is by IP, not MAC (AX80 NAT hides individual MACs from the VM).

---

## Target Implementation (MikroTik + FreeRADIUS)

Full L2 isolation with per-identity VLANs.

### How It Works

When a device authenticates via the captive portal, the server checks for existing sessions under the same ENS name:

```
philo's laptop authenticates:
  → signs challenge as philo.tokyo2026.ethglobal.eth
  → no existing session → assigned identity VLAN 1042
  → MikroTik puts laptop in VLAN 1042

philo's phone authenticates:
  → signs as philo.tokyo2026.ethglobal.eth
  → existing session found: laptop in VLAN 1042
  → phone assigned to VLAN 1042
  → laptop and phone can reach each other
  → neither can reach any device in VLAN 1041 or 1043
```

### VLAN Assignment

Identity VLANs are derived deterministically from the ENS namehash:

```typescript
import { namehash } from 'viem'
import { normalize } from 'viem/ens'

function identityVlan(ensName: string): number {
  const node = namehash(normalize(ensName))
  const offset = parseInt(node.slice(2, 6), 16) % 900
  return 1000 + offset  // identity VLANs: 1000–1899
}

// philo.tokyo2026.ethglobal.eth  → VLAN 1042
// ann.tokyo2026.ethglobal.eth    → VLAN 1387
```

Deterministic — same VLAN across reconnects, no state needed.

Collision probability with 500 attendees across 900 VLANs: ~24%. Fine for demo. Production uses the full 12-bit VLAN space (1000–4094) with collision check at mint time.

### Multi-Device Session Management

```typescript
async function assignVlan(ensName: string, mac: string): Promise<number> {
  const existing = [...sessions.values()].filter(s => s.ensName === ensName)
  if (existing.length > 0) return existing[0].vlan
  return identityVlan(ensName)
}
```

### What Isolation Means in Practice

**Same-identity devices can:**
- Ping each other by IP
- Access services on each other (localhost:3000 on laptop reachable from phone)
- Share files over LAN, test mobile ↔ desktop dApp interactions

**Different-identity devices cannot:**
- Reach each other at all (L2 VLAN boundary)
- See broadcast traffic from other identities
- Be scanned or probed across the boundary

### RouterOS Configuration

```
/interface bridge
add name=bridge-ensca vlan-filtering=yes

/interface bridge port
add bridge=bridge-ensca interface=wlan1

# Per-identity VLANs created dynamically by FreeRADIUS CoA
/interface bridge vlan
add bridge=bridge-ensca tagged=bridge-ensca vlan-ids=1042

# No inter-VLAN routing — isolation by absence of routes
/ip route
add dst-address=0.0.0.0/0 gateway=<WAN_IP> routing-table=vlan-1042
```

### Organizer Override (target)

```
POST /admin/allow-cross-vlan
{
  "from": "marco.tokyo2026.ethglobal.eth",
  "to":   "philo.tokyo2026.ethglobal.eth",
  "signature": "0x..."
}
```

Creates a static route between the two VLANs. Revoked when either party disconnects.

---

## Comparison

| Feature | Current (software tiers) | Target (hardware VLANs) |
|---|---|---|
| Isolation layer | L3 iptables FORWARD DROP | L2 802.1Q VLAN |
| Per-identity VLANs | No (per-tier only) | Yes (namehash-derived) |
| Same-identity multi-device | Not tracked | Full L2 same-VLAN |
| Direct L2 frames blocked | No | Yes |
| Scales to | ~50 devices | ~500+ devices |
