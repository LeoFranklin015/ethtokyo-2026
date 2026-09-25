# ENSCA — The Plan

## Phases

### Phase 1 — Core Identity + WiFi (Demo-ready)

Get a single attendee on the network using their ENS subname. Prove the full loop works.

**Deliverables:**
- Subname minting flow (check-in UI + relayer)
- ENS text record schema defined and deployed
- Captive portal (wallet connect → sign → verified)
- FreeRADIUS module calling ENS resolver
- MikroTik AP configured with VLAN per role
- One hacker, one organizer — different VLANs, different bandwidth

**Hardware needed:**
- MikroTik hAP ax lite (~$45)
- Server or laptop running FreeRADIUS + resolver service

**Success criteria:** `philo.tokyo2026.ethglobal.eth` connects to WiFi, lands on hacker VLAN with 50 Mbps limit. `ann.tokyo2026.ethglobal.eth` (organizer) lands on staff VLAN with no limit.

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
Week 1: ENS schema + relayer + captive portal (Phase 1 core)
Week 2: RADIUS module + AP config + VLAN assignment (Phase 1 complete)
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
| Network hardware | MikroTik hAP ax lite |
| RADIUS server | FreeRADIUS 3.x |
| Captive portal | Next.js + viem + wagmi |
| ENS resolver service | Node.js + viem |
| SSH auth | AuthorizedKeysCommand + Node.js binary |
| PAM authorization | pam_exec + shell/Node.js script |
| API gateway | Node.js + per-identity rate limiting |
| Monitoring | FreeRADIUS accounting + custom dashboard |
| Relayer | Node.js + viem + funded EOA |
| Chains | Ethereum mainnet (ENS) + Sepolia (dev/test) |
