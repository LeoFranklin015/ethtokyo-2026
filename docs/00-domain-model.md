# Domain Model

The system is **identity-gated access to physical infrastructure**. Events are one instance of that shape; a company with offices, a co-working space, a university campus are others.

This document fixes vocabulary. All docs, schema, routes, and labels use these terms.

---

## Entities

### Organization

Root entity. Operates one or more physical locations. Owns an ENS name (future); currently represented by the control plane admin.

### Perimeter

A physical location. May be permanent (an office) or time-bounded (a hackathon). Where infrastructure lives and where people show up. Currently: the ETHTokyo 2026 demo venue (Fedora VM + AX80).

### Group

A named access tier within a Perimeter. Today: `basic`, `staff`, `vip`. Groups define:
- Network tier (fwmark, tc HTB class, bandwidth cap)
- Which resources members can access (rows in `group_resource_limits`)
- Per-device and per-group daily usage limits per resource

Groups are the central policy unit. Adding a row to `group_resource_limits` grants access; removing it revokes it.

### User

A person known to the system. Bound to a username/password today; wallet + ENS subname in the future. Belongs to exactly one Group at a time. The `portal-anon` sentinel user represents devices authenticated via the captive portal without explicit user provisioning.

### Session

An authenticated binding of a device IP to a Group, with start and end timestamps. Sessions are created by the captive portal on login and ended on logout or admin revocation. The proxy reads active sessions to authorize proxy requests.

### Resource

An upstream API or service whose access is gated by Group membership. Each resource has:
- `slug` — URL identifier used in proxy routes (`/proxy/<slug>/...`)
- `upstream_url` — base URL to forward to
- `api_key` — injected by the proxy at forward time
- `key_placement` — `url_path` (key in URL) or `header` (injected as request header)
- Per-device and per-group daily request limits

Current resources: Alchemy Sepolia RPC, Alchemy Mainnet RPC.

### Device

A physical client identified by its IP address (assigned by AX80 DHCP). The VM sees AX80's NAT, so device identity is per-IP, not per-MAC. IPs are sticky (12h DHCP leases).

---

## Access Model

Access is **deny by default**. A device gets proxy access only if:

1. An active session exists for its IP (portal granted access)
2. The session's group has a row in `group_resource_limits` for the requested resource
3. Neither per-device nor per-group daily limits are exceeded

NULL limits = unlimited. Limits can be adjusted mid-day via quota adjustments without touching the base configuration.

---

## Actions

| Term | Meaning |
|---|---|
| **Login** | Captive portal verifies credentials, grants iptables ACCEPT + fwmark, creates session in proxy DB |
| **Logout** | Portal removes iptables rules, marks session ended in proxy DB |
| **Revoke** | Admin force-ends a session; portal flushes iptables rules for the IP |
| **Proxy** | Device sends request to `/proxy/<slug>/...`; proxy authenticates by session IP, checks access, rate limits, forwards |
| **Adjust quota** | Admin adds one-day top-up without changing base limits |
| **Rotate key** | Stage new API key (pending), then commit atomically — zero downtime key rotation |

---

## Future: ENS Identity

In the ENS-native version, Groups map to Roles on ENS subnames. Users become ENS subnames under the event domain. Sessions are initiated by wallet signature instead of username/password. The domain model above does not change — only the auth mechanism.

See `13-ens-design.md` for the on-chain design.
