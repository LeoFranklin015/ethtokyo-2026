# ENSCA — Build Plan

## Phase 1 — Core Identity + WiFi (Demo-ready) ✓

Software VLAN enforcement on Fedora VM. Full control plane. Username/password auth.

**Completed:**
- Captive portal (`portal/app.py`) — Flask on port 8080, runs as root via systemd
- iptables ACCEPT + fwmark per tier on login; teardown on logout
- tc HTB on enp10s0u1 egress — 3 tier classes + default unauthed class
- Cross-tier FORWARD DROP rules between devices on different tiers
- Resource proxy (`proxy/proxy.py`) — Flask on port 8081, runs as philo via systemd
- 11-table SQLite DB (`proxy/db.py`) — sessions, users, groups, resources, limits, usage, audit
- Admin token auth (bcrypt), full CRUD for groups/users/resources
- Rate limiting: per-device and per-group daily counters
- Quota adjustments: mid-day top-ups without touching base limits
- API key rotation: stage + commit, atomic swap
- Portal↔proxy integration: login/logout notifies proxy via localhost HTTP
- Session UUID identity — never bare IP in the proxy DB

---

## Phase 2 — ENS-native Auth

Replace username/password with ENS subname + wallet signature.

**Deliverables:**
- Captive portal: wallet connect UI (viem/wagmi)
- EIP-191 challenge-response — portal recovers signer address
- Reverse ENS lookup: address → subname under event domain
- Read wifi-vlan + wifi-bandwidth text records via CCIP-Read resolver
- Map ENS role to existing group IDs in proxy DB

**Blocked on:** CCIP-Read resolver deployment or offchain gateway for event domain

---

## Phase 3 — Per-Identity VLAN

Multiple devices under the same ENS name share a private VLAN.

**Deliverables:**
- Per-identity VLAN derived from ENS namehash
- Second device auth under same ENS name → same VLAN
- Isolation: different-identity devices cannot reach each other
- Hardware target: MikroTik hAP ax lite + FreeRADIUS 802.1X

**Hardware requirement:** AX80 does not pass 802.1Q tags. Requires MikroTik or equivalent.

---

## Phase 4 — SSH + Dev Tools

SSH access to shared machines; per-identity API tool provisioning.

**Deliverables:**
- `ensca-keys` binary (AuthorizedKeysCommand handler — reads `ssh-pubkey` ENS record)
- `ensca-authz` PAM script (session policy from ENS records)
- Proxy resources: sponsor API endpoints provisioned at subname mint

---

## Phase 5 — Post-Event Attestations

Subname becomes permanent record of participation.

**Deliverables:**
- Attestation writer (post-event ENS text record writes)
- Records: API requests, hours on network, sponsors used

---

## Current Build Order

```
Done:
  ✓ Fedora VM captive portal — Flask, iptables, tc HTB
  ✓ Software VLAN tiers (basic/staff/vip) — fwmark + tc HTB
  ✓ Cross-tier isolation — iptables FORWARD DROP
  ✓ Resource proxy + control plane — sessions, groups, rate limiting, key rotation
  ✓ Portal↔proxy session sync via localhost internal API

Next:
  Week 1: ENS schema + offchain resolver + wallet-sig captive portal (Phase 2)
  Week 2: MikroTik + FreeRADIUS hardware VLAN assignment (Phase 3)
  Week 3: ensca-keys + ensca-authz + SSH flow (Phase 4)
  Week 4: Per-identity VLAN isolation (Phase 3 complete)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Demo hardware | Fedora VM + USB ethernet + TP-Link AX80 |
| Target hardware | MikroTik hAP ax lite |
| Software VLAN | iptables fwmark + tc HTB (current) |
| Hardware VLAN | FreeRADIUS 3.x + 802.1X (Phase 3) |
| Captive portal | Flask Python (current) → Next.js + viem + wagmi (Phase 2) |
| Proxy + control plane | Flask Python (current) |
| DB | SQLite WAL, shared between portal and proxy processes |
| ENS resolver | CCIP-Read gateway (Phase 2) |
| SSH auth | AuthorizedKeysCommand (Phase 4) |
| Chains | Ethereum mainnet (ENS) + Sepolia (dev/test) |
