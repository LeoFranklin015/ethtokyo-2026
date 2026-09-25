# ENSCA — The Plan

## Phases

### Phase 1 — Core Identity + WiFi (Demo-ready)

Get a single attendee on the network using their ENS subname. Prove the full loop works.

**Deliverables:**
- Subname minting flow (check-in UI + relayer)
- ENS text record schema defined and deployed
- Captive portal (username/password → tier assignment)
- Software VLAN enforcement via iptables + tc HTB on Linux router
- Three tiers — basic (5 Mbps), staff (10 Mbps), vip (unlimited)
- Cross-tier isolation: iptables FORWARD DROP between devices on different tiers

**Current hardware (ETHTokyo 2026 demo):**
- Fedora Linux VM (VMware Fusion on MacBook M5 Air)
- USB-ethernet adapter (enp10s0u1, 192.168.0.1/24) — VM's LAN interface
- TP-Link Archer AX80 in router mode (AX80 → VM over ethernet)
- Attendee devices on AX80 WiFi (192.168.0.x)

**How VLANs work on this hardware:**

The AX80 does not pass 802.1Q VLAN tags — hardware VLANs are not possible. Software tiers implement equivalent isolation:

```
iptables mangle MARK
  basic login  → fwmark 10  → tc class 1:10 (5 Mbps ceil)
  staff login  → fwmark 20  → tc class 1:20 (10 Mbps ceil)
  vip login    → fwmark 30  → tc class 1:30 (1000 Mbps ceil)

tc HTB on enp10s0u1 egress (download path toward devices):
  1:10  basic  — 5 Mbps
  1:20  staff  — 10 Mbps
  1:30  vip    — 1000 Mbps (unlimited)
  1:99  default (unauthed) — 1 Mbps

Cross-tier isolation:
  iptables FORWARD DROP between IPs on different tiers
  Same-tier devices can reach each other freely
```

Credentials: `basic/basic2026`, `staff/staff2026`, `vip/vip2026`

**Success criteria:** device connects to AX80 WiFi → captive portal appears → login with tier credentials → correct bandwidth tier applied → cross-tier traffic blocked.

---

### Phase 1 Target — ENS-native auth

Replace username/password with ENS subname + wallet signature. The captive portal resolves the signer's ENS name, reads the `wifi-vlan` and `wifi-bandwidth` text records, and assigns the tier from on-chain policy.

**Hardware target:**
- MikroTik hAP ax lite (~$45)
- FreeRADIUS + ENSCA resolver on Linux server
- 802.1X / RADIUS CoA for hardware VLAN assignment

---

### Phase 2 — SSH + Dev Tools

Add SSH access to shared machines and developer tool provisioning.

**Deliverables:**
- `ensca-keys` binary (AuthorizedKeysCommand handler)
- SSH public key stored in ENS text record at mint time
- `ensca-authz` PAM script (reads ssh-policy, applies restrictions)
- API gateway with per-identity quota enforcement (RPC, faucet, IPFS)
- Tool endpoints provisioned automatically at subname mint

**Success criteria:** `ssh philo.tokyo2026.ethglobal.eth@devbox.ensca.eth` works with hardware wallet. RPC endpoint rate-limits by ENS name, not IP.

---

### Phase 3 — Device Isolation + Cross-Device

Multiple devices under the same identity share a private VLAN.

**Deliverables:**
- Per-identity VLAN assignment (derived from namehash)
- Second device auth under same ENS name → same VLAN
- Isolation verified: philo's laptop cannot see ann's devices
- Local port exposure visible only within identity's VLAN

**Success criteria:** Two devices signed with `philo.tokyo2026.ethglobal.eth` can ping each other. Neither can reach any device in another identity's VLAN.

---

### Phase 4 — Monitoring + Perimeter

Real-time visibility and presence detection.

**Deliverables:**
- Per-identity bandwidth usage from FreeRADIUS accounting
- Per-identity API/tool usage from gateway logs
- Organizer dashboard (active identities, bandwidth, tool usage)
- Presence detection (device on network = attendee at venue)
- Usage anomaly alerts

**Success criteria:** Organizer dashboard shows live per-subname stats. Perimeter detection updates within 60 seconds of a device connecting or disconnecting.

---

### Phase 5 — Post-Event Attestations

Subname becomes a permanent record of what happened at the event.

**Deliverables:**
- Attestation writer (updates ENS text records post-event)
- Records: prizes won, sponsors whose APIs were used, hours on network, projects built
- Cross-event persistence (`philo.ethglobal.eth` parent carries history)

---

## Prior Art

| Project | What they built | Gap |
|---|---|---|
| Nifi (ETHGlobal Singapore 2024) | Token/NFT captive portal on Raspberry Pi | Binary in/out, no ENS, no roles, no VLAN, no SSH |
| Tokenproof | NFT door check via staff app | Physical only, no network layer |
| pam-signandverify | PAM module for wallet signatures | Polkadot only, archived |

ENSCA builds on Nifi's proof that commodity hardware works and extends it with identity depth, role policy, device isolation, and the SSH layer.

---

## Build Order

```
ETHTokyo 2026 demo (done):
  ✓ Fedora VM captive portal — Flask, iptables, tc HTB
  ✓ Software VLAN tiers (basic/staff/vip) — fwmark + tc HTB
  ✓ Cross-tier isolation — iptables FORWARD DROP
  ✓ iOS/Android CNA — captive sheet opens and dismisses correctly

Next:
  Week 1: ENS schema + relayer + wallet-sig captive portal (Phase 1 ENS-native)
  Week 2: RADIUS module + MikroTik VLAN assignment (Phase 1 complete)
  Week 3: ensca-keys + ensca-authz + SSH flow (Phase 2)
  Week 4: API gateway + tool provisioning (Phase 2 complete)
  Week 5: Per-identity VLAN isolation (Phase 3)
  Week 6: Dashboard + perimeter detection (Phase 4)
  Post-event: Attestation writer (Phase 5)
```

## Tech Stack

| Layer | Technology |
|---|---|
| Identity | ENS (ENSIP-10, ENSIP-15, EIP-3668) |
| Auth signature | ECDSA / EIP-191 personal_sign |
| Demo hardware | Fedora VM + USB ethernet + TP-Link AX80 |
| Target hardware | MikroTik hAP ax lite |
| Software VLAN | iptables fwmark + tc HTB (current) |
| Hardware VLAN | FreeRADIUS 3.x + 802.1X (target) |
| Captive portal | Flask (current) → Next.js + viem + wagmi (target) |
| ENS resolver service | Node.js + viem |
| SSH auth | AuthorizedKeysCommand + Node.js binary |
| PAM authorization | pam_exec + shell/Node.js script |
| API gateway | Node.js + per-identity rate limiting |
| Monitoring | FreeRADIUS accounting + custom dashboard |
| Relayer | Node.js + viem + funded EOA |
| Chains | Ethereum mainnet (ENS) + Sepolia (dev/test) |
