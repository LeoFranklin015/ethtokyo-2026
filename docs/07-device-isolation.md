# Device Isolation

## Current Implementation (Software Tiers)

Isolation via iptables FORWARD DROP. Hardware VLANs not available on AX80.

### How It Works

At login, `portal/app.py` assigns the device IP to a tier. Cross-tier DROP rules are inserted immediately:

```python
def _apply_cross_tier_rules(ip, tier, action):
    for other_ip, other_tier in AUTHED_IPS.items():
        if other_tier == tier or other_ip == ip:
            continue
        _run_ok(["iptables", f"-{action}", "FORWARD", "-s", ip, "-d", other_ip, "-j", "DROP"])
        _run_ok(["iptables", f"-{action}", "FORWARD", "-s", other_ip, "-d", ip, "-j", "DROP"])
```

`action="I"` on login, `action="D"` on logout/revoke. Called after AUTHED_IPS is updated.

**Same-tier devices** — traffic passes the ACCEPT rule before hitting any DROP. Can reach each other freely.

**Different-tier devices** — explicit DROP in both directions.

### Tier Isolation Matrix

| From \ To | basic | staff | vip |
|---|---|---|---|
| basic | ACCEPT | DROP | DROP |
| staff | DROP | ACCEPT | DROP |
| vip | DROP | DROP | ACCEPT |

### Limitations vs Hardware VLANs

- Isolation is L3 (iptables FORWARD). Direct L2 frames within AX80's subnet bypass the VM entirely and are not blocked. True L2 isolation requires hardware VLANs.
- For the demo (ETHTokyo 2026), L3 isolation is sufficient — it blocks all routed traffic between tiers.
- Per-device identity within a tier is by IP, not MAC (AX80 NAT hides individual MACs from the VM).

### Rule Cleanup on Logout

`revoke_access(ip)` removes all rules for the IP:
- ACCEPT in FORWARD
- mangle MARK for upload (src=ip)
- mangle MARK for download (dst=ip)
- nat PREROUTING DNS DNAT
- All pairwise DROP rules between this IP and IPs on other tiers

The proxy is notified via `POST /internal/session-ended` to mark the session closed.

---

## Target Implementation (MikroTik + Hardware VLANs)

Full L2 isolation with per-identity VLANs. Requires hardware 802.1Q support.

### Per-Identity VLAN Assignment

Identity VLANs derived deterministically from ENS namehash:

```typescript
function identityVlan(ensName: string): number {
  const node = namehash(normalize(ensName))
  const offset = parseInt(node.slice(2, 6), 16) % 900
  return 1000 + offset  // identity VLANs: 1000–1899
}
```

Deterministic — same VLAN across reconnects, no state needed.

### Multi-Device Session Management

Second device authenticating as the same ENS name joins the same VLAN:

```typescript
async function assignVlan(ensName: string): Promise<number> {
  const existing = sessions.filter(s => s.ensName === ensName)
  return existing.length > 0 ? existing[0].vlan : identityVlan(ensName)
}
```

### Comparison

| Feature | Current (software tiers) | Target (hardware VLANs) |
|---|---|---|
| Isolation layer | L3 iptables FORWARD DROP | L2 802.1Q VLAN |
| Per-identity VLANs | No (per-tier only) | Yes (namehash-derived) |
| Same-identity multi-device | Not tracked | Full L2 same-VLAN |
| Direct L2 frames blocked | No | Yes |
| Scales to | ~50 devices | ~500+ devices |
