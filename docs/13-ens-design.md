# ENS Design — Registries, Roles, and Onboarding

How the domain model maps to ENS. Target: **ENSv2 + Enhanced Access Control (EAC)**. This is Phase 3+ of the build plan — not implemented yet.

> Status: ENSv2 deployed on **Sepolia only**. Contracts "are not yet final." Role constants must be read from deployed contracts, not hardcoded from documentation.

---

## 1. Registry Topology

```
                    ┌─────────────────────────┐
   Organization ──▶ │  acme.eth  ORG REGISTRY │
                    └───────────┬─────────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
        leo.acme.eth      tokyo.acme.eth     osaka.acme.eth
          (Member)          (Branch)           (Branch)
                                │  has own subregistry
                    ┌───────────┴─────────────┐
                    │ tokyo.acme.eth          │
                    │      BRANCH REGISTRY    │
                    └───────────┬─────────────┘
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     leo.tokyo.acme.eth  ann.tokyo.acme.eth  nova.tokyo.acme.eth
        (Membership)        (Membership)       (Membership)
```

| Domain term | ENSv2 construct |
|---|---|
| Organization | registry anchored at `.eth` name |
| Branch | name in org registry with its own subregistry |
| Member | name in org registry, no subregistry |
| Membership | name in Branch registry |

**Branch expiry = Branch window.** A hackathon registers Memberships with expiry = event end; they lapse automatically.

---

## 2. Three EAC Surfaces

| Surface | Contract | Governs |
|---|---|---|
| **Registry** | ENSv2 stock registry | the name: resolver, subregistry, transfer, renewal |
| **Resolver** | Permissioned Resolver | the records: which keys an account may write |
| **Registrar** | `BranchRegistrar` (ours) | business logic: onboard, promote, revoke |

### Registry Roles (stock)

```
ROLE_REGISTRAR          — authorize register()
ROLE_RENEW              — authorize renew()
ROLE_SET_RESOLVER       — change resolver
ROLE_SET_SUBREGISTRY    — give name its own child registry
ROLE_CAN_TRANSFER_ADMIN — withheld = SOULBOUND
```

### Registrar Roles (ours)

```solidity
uint256 constant ROLE_ONBOARD   = 1 << 0;   // create Memberships
uint256 constant ROLE_PROMOTE   = 1 << 4;   // change a Membership's Role
uint256 constant ROLE_REVOKE    = 1 << 8;   // end a Membership
uint256 constant ROLE_ROLE_EDIT = 1 << 12;  // define/edit Role catalogue
```

---

## 3. Role Catalogue

| Role | Network group | Proxy resource access |
|---|---|---|
| **hacker** | hacker VLAN | RPC: 10k/day |
| **mentor** | mentor VLAN | RPC: 50k/day |
| **volunteer** | staff VLAN | RPC: 2k/day |
| **organizer** | staff VLAN | unlimited |
| **partner** | partner VLAN | custom |

### Group Isolation + Per-User Allocation

Isolation is **per group** (Role → group → VLAN). Allocation is **per user within the group**.

```
Role        group    VLAN    group pool      per-user rate/ceil
──────────────────────────────────────────────────────────────
organizer   staff     10    unlimited        unlimited
mentor      mentor   200    200 Mbps         20/100 Mbps
partner     partner  400    200 Mbps         20/100 Mbps
volunteer   staff     10    100 Mbps         10/50 Mbps
hacker      hacker   100    500 Mbps          5/20 Mbps
(unauthed)  —         —       1 Mbps          —
```

Two-level HTB: parent class per group, child class per Membership.

---

## 4. Why BranchRegistrar Exists

`ROLE_REGISTRAR` is binary — hold it and you can mint any name with any bitmap. ENSv2 intends registrars to hold the business logic:

- `BranchRegistrar` holds `ROLE_REGISTRAR` + `ROLE_RENEW` on the Branch registry root.
- Humans hold `ROLE_ONBOARD` on the registrar.
- Registrar enforces: a plain onboarder may only mint Hacker roles; `ROLE_PROMOTE` needed for anything higher.

---

## 5. Key Flows

### Onboarding

```
staff opens check-in
  → attendee connects wallet → 0xLeo
  → check: is 0xLeo already a Member of acme?
       no → orgRegistry.register("leo", 0xLeo, ...)   ← Member, once ever
  → staff picks label + Role ("leo", hacker)
  → BranchRegistrar.onboard("leo", 0xLeo, Hacker)
       ├─ registry.register(... closesAt)
       ├─ resolver: write Entitlements for hacker role
       └─ emit Onboarded
  → leo.tokyo.acme.eth is live
```

### Admit (WiFi)

```
device joins WiFi → captive portal → wallet connect → sign challenge
  → recover 0xLeo
  → address → Membership  (via event indexer)
  → read Role + Entitlements:
        1. leo.tokyo.acme.eth  Membership override?  use it
        2. leo.acme.eth        org-scoped Role?       use it
        3. neither                                    deny
  → wifi.group → place device in group's VLAN
  → wifi.rate/ceil → attach child HTB class under group parent
  → admit
```

### Revoke

`ROLE_REVOKE` required. Revoke all roles on Membership resource, clear records. Enforcers deny on next check. Member name survives; only Membership ends.

---

## 6. Migration Path from Current Demo

| Step | Change | Blocked on |
|---|---|---|
| 1 | Portal: password form → wallet connect + EIP-191 challenge | — |
| 2 | Portal resolves Role via ENS, maps Entitlements → existing tc classes | Role catalogue deployed |
| 3 | Console: Organization, Branch, Role, Onboarding screens | Step 2 done |
| 4 | `BranchRegistrar` on Sepolia; onboarding writes on-chain | ENSv2 Sepolia stable |
| 5 | Mainnet | ENSv2 mainnet release |

Steps 1–3 are independent of ENSv2. The proxy control plane requires no changes for any of these steps — only the portal's auth mechanism changes.

---

## 7. Implementation Notes

**Key everything on canonicalId.** Token IDs are mutable (change on role grant/revoke). Stable identifier:
```
canonicalId = tokenId ^ uint32(tokenId)
```

**Index both contracts.** Registrar + registry both emit events. Address → Membership lookup is built from that index.

**Cache at the Enforcer.** Branch gateway must serve WiFi when upstream is flaky. Cache Entitlements per Membership, fail closed only on explicit revocation.

**15-holder cap.** 15 holders per role per resource. Grant branch-wide roles at `ROOT_RESOURCE` so the cap applies to staff counts, not Member counts.
