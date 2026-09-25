# ENS Design — Registries, Roles, and the Onboarding Flow

How the domain model in [`00-domain-model.md`](./00-domain-model.md) is expressed in ENS.

Target: **ENSv2 + Enhanced Access Control (EAC)**. All authority lives on-chain, in role bitmaps, and
is reversible. The console does not maintain a permission table — it reads `hasRoles`.

> Status: ENSv2 is deployed on **Sepolia only**. ENS Labs states the contracts "are not yet final and
> may change prior to mainnet deployment," and write-path authorization "may still change." Role
> constants must be read from the deployed contracts, not hardcoded from documentation — the docs
> disagree with themselves on at least `ROLE_RENEW`.

---

## 1. Registry Topology

ENSv2 gives every name the option of its own registry. We use that to make the domain model
structural rather than conventional.

```
                    ┌─────────────────────────┐
   Organization ──▶ │  acme.eth  ORG REGISTRY │
                    └───────────┬─────────────┘
                                │ names in this registry
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
        leo.acme.eth      tokyo.acme.eth     osaka.acme.eth
          (Member)          (Branch)           (Branch)
                                │  has its own subregistry
                    ┌───────────┴─────────────┐
                    │ tokyo.acme.eth          │
                    │      BRANCH REGISTRY    │
                    └───────────┬─────────────┘
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
     leo.tokyo.acme.eth  ann.tokyo.acme.eth  nova.tokyo.acme.eth
        (Membership)        (Membership)       (Membership)
          hacker              organizer           partner
```

| Domain term | ENSv2 construct | Created by |
|---|---|---|
| Organization | a registry, anchored at the org's `.eth` name | once, at org setup |
| Branch | a name in the org registry, **with its own subregistry** | `branch:create` |
| Member | a name in the org registry, no subregistry | first Onboarding anywhere |
| Membership | a name in the Branch registry | Onboarding at that Branch |

**Why Branch-as-subregistry is the keystone:** `ROOT_RESOURCE` (`0x0`) in a registry is a master key —
`hasRoles()` checks the named resource *and* root. A role granted at the Branch registry's root
therefore applies to every Membership in that Branch and to nothing outside it. Branch-scoped
authority is free; no per-person grants, and no pressure on the 15-holders-per-role-per-resource cap.

**Branch expiry is the Branch window.** `register()` takes an absolute Unix expiry timestamp. A
three-day hackathon registers its Memberships with expiry = event end, and they lapse on their own.
A permanent office registers far-future expiries and renews.

**Label collision.** Members and Branches are siblings in the org registry, so `leo.acme.eth` and
`tokyo.acme.eth` share a namespace. The registrar reserves all Branch labels and refuses them as
Member labels.

---

## 2. The Three EAC Surfaces

Authority is not one list. It lives in three contracts, and keeping them distinct is what makes the
model legible.

| Surface | Contract | Governs | Our term |
|---|---|---|---|
| **Registry** | ENSv2 stock registry | the *name*: resolver, subregistry, transfer, renewal | structural control |
| **Resolver** | Permissioned Resolver | the *records*: which keys an account may write | Entitlement authorship |
| **Registrar** | `BranchRegistrar` (ours) | the *business logic*: who may onboard, promote, revoke | Permissions |

A common mistake would be trying to express "volunteers may onboard hackers" in registry roles. It
does not fit — see §4.

### 2.1 Registry roles (stock)

```
ROLE_REGISTRAR            authorizes register()
ROLE_RENEW                authorizes renew()
ROLE_SET_RESOLVER         change the name's resolver
ROLE_SET_SUBREGISTRY      give the name its own child registry
ROLE_CAN_TRANSFER_ADMIN   withhold ⇒ the name is SOULBOUND
```

Bitmap layout: 32 regular roles in bits 0–127 at **one nybble (4 bits) each**, and each role's paired
admin role at `role << 128`. An admin-role holder may grant the regular role, grant the admin role,
and revoke either — without holding the regular role itself.

### 2.2 Registrar roles (ours)

`BranchRegistrar` extends `EnhancedAccessControl` and defines its own roles at the same nybble
spacing. These are Permissions from the domain model, on-chain.

```solidity
uint256 constant ROLE_ONBOARD   = 1 << 0;   // create Memberships
uint256 constant ROLE_PROMOTE   = 1 << 4;   // change a Membership's Role
uint256 constant ROLE_REVOKE    = 1 << 8;   // end a Membership
uint256 constant ROLE_ROLE_EDIT = 1 << 12;  // define/edit the Role catalogue

uint256 constant ROLE_ONBOARD_ADMIN   = ROLE_ONBOARD   << 128;
uint256 constant ROLE_PROMOTE_ADMIN   = ROLE_PROMOTE   << 128;
uint256 constant ROLE_REVOKE_ADMIN    = ROLE_REVOKE    << 128;
uint256 constant ROLE_ROLE_EDIT_ADMIN = ROLE_ROLE_EDIT << 128;
```

Granted at the registrar's `ROOT_RESOURCE` for branch-wide authority.

---

## 3. The Role Catalogue

Five Roles ship by default. A Role is a name for one row of this table; an Organization may define
more, but every Role is expressible as (registrar roles, registry bitmap, resolver grants).

| Role | Registrar roles | Registry bitmap on own name | Resolver: may write on own name | Transferable |
|---|---|---|---|---|
| **hacker** | — | `0` | — | no (soulbound) |
| **volunteer** | `ROLE_ONBOARD` | `0` | `avatar`, `url` | no |
| **mentor** | — | `0` | `avatar`, `url`, `bio`, `ssh.pubkey` | no |
| **partner** | — | `ROLE_SET_RESOLVER \| ROLE_SET_RESOLVER_ADMIN` | `api.*` | no |
| **organizer** | all four + all four admin | `0` | branch-wide, all keys | no |

Notes on specific cells:

- **hacker gets a bitmap of `0` and that is the feature.** Per the ENS app-developer guide: *"A subname
  owner typically uses the parent's resolver and holds no roles on it, so a `setText` from their
  wallet reverts with `EACUnauthorizedAccountRoles`."* The hacker owns their name, can prove it by
  signature, and cannot edit their own Entitlements. "A hacker cannot modify their own records" is the
  default behaviour, not something we build.
- **Soulbound everywhere.** `ROLE_CAN_TRANSFER_ADMIN` is withheld on every Membership. Without it a
  volunteer could sell their badge, and a Membership is a statement about a person.
- **partner is the one Role that gets `ROLE_SET_RESOLVER`**, so a partner may point their name at their
  own resolver and serve their own `api.*` records. Their Entitlements are therefore self-asserted by
  design; the Enforcer treats partner-served records as claims, not as org policy.
- **organizer holds admin roles**, so organizers promote volunteers without any privileged deploy step.

Org-level Roles (granted at the **org** registry root, apply at every Branch) use the same catalogue.
An org-scoped `mentor` is a mentor at every location; a Branch Membership overrides it locally.

### 3.1 Entitlements: group isolation, per-user allocation

Isolation is **per group**, allocation is **per user within the group**. The group is derived from the
Role, not from the individual — every hacker shares one isolation group, every staff member another.
Resources are then budgeted to the group, and each Membership draws its own allocation from that pool.

Entitlement keys written to the resolver:

| Key | Scope | Example | Meaning |
|---|---|---|---|
| `wifi.group` | Role | `hacker` | isolation group; determines VLAN |
| `wifi.rate` | Membership | `5mbps` | this user's guaranteed rate |
| `wifi.ceil` | Membership | `20mbps` | this user's ceiling, borrowed from group headroom |
| `wifi.hours` | Role | `24/7` | access window |

Group budgets are Branch configuration, not per-Membership records — a Role's group carries a total
rate and ceiling that its members share.

```
Role      group    VLAN    group pool      per-user rate / ceil
────────────────────────────────────────────────────────────────
organizer staff     10     unlimited       unlimited
mentor    mentor   200     200 Mbps        20 / 100 Mbps
partner   partner  400     200 Mbps        20 / 100 Mbps
volunteer staff     10     100 Mbps        10 /  50 Mbps
hacker    hacker   100     500 Mbps         5 /  20 Mbps
(unauthed) —        —        1 Mbps          —
```

This is a two-level hierarchy, which is what HTB is actually designed for. The Enforcer builds a
parent class per group and a child class per Membership:

```
1:              root
├── 1:10        group staff    rate 100mbit ceil 100mbit
│   ├── 1:1001  ann            rate  10mbit ceil  50mbit
│   └── 1:1002  leo            rate  10mbit ceil  50mbit
└── 1:100       group hacker   rate 500mbit ceil 500mbit
    ├── 1:1003  nova           rate   5mbit ceil  20mbit
    └── …
```

A user idle inside their group lends capacity to their peers up to their own ceiling, but a group can
never exceed its pool — so hackers cannot starve staff, and one hacker cannot starve the others.

Isolation follows the same split:

- **Between groups** — blocked. Different VLANs; no route between them.
- **Within a group** — permitted. Same VLAN, peers reachable.
- **Within one Membership** — a person's own devices always reach each other, regardless of group.

The current Enforcer approximates this with `iptables` fwmark plus flat `tc` classes and pairwise
`FORWARD DROP` rules; the group VLAN replaces the DROP mesh, and the child classes replace the flat
tiers. Nothing above depends on hardware VLAN support — a software group per Role is the same model.


---

## 4. Why the Registrar Exists

EAC cannot express *"a volunteer may onboard, but only with the hacker Role."* `ROLE_REGISTRAR` is
binary: hold it and you may register any name with any bitmap, including one that makes the holder an
organizer.

ENSv2 anticipates this — registries store names, **registrars hold business logic**. So:

- `BranchRegistrar` holds `ROLE_REGISTRAR` and `ROLE_RENEW` on the Branch registry's `ROOT_RESOURCE`.
- No human ever holds `ROLE_REGISTRAR`.
- Humans hold `ROLE_ONBOARD` on the registrar, and the registrar decides what they may mint.

```solidity
function onboard(string calldata label, address owner, Role role) external {
    require(hasRoles(ROOT_RESOURCE, ROLE_ONBOARD, msg.sender), "not an onboarder");

    // A plain onboarder may only create hackers. Anything above that needs ROLE_PROMOTE.
    if (role != Role.Hacker) {
        require(hasRoles(ROOT_RESOURCE, ROLE_PROMOTE, msg.sender), "cannot grant that role");
    }

    require(!reservedLabel(label), "reserved");
    require(membershipOf[owner] == 0, "already onboarded at this branch");

    uint256 tokenId = registry.register(
        label,
        owner,
        address(0),              // Memberships have no subregistry
        branchResolver,
        registryBitmapFor(role), // per-Role, per-name — differs between siblings
        branchExpiry
    );
    _grantResolverPermissions(tokenId, owner, role);
    emit Onboarded(canonical(tokenId), owner, role);
}
```

The registrar is also where label rules (`[a-z0-9-]`, ≤32, ENSIP-15 normalized), one-Membership-per-
wallet, and Branch-window checks belong.

---

## 5. Flows

### 5.1 Organization setup — once

1. Org acquires `acme.eth` and deploys its org registry.
2. Deploys the Permissioned Resolver; sets it as the org's default resolver.
3. Grants the deployer address `ROLE_ROLE_EDIT` + admin at org root.
4. Publishes the Role catalogue.

### 5.2 Branch creation — `branch:create`

1. Caller must hold `ROLE_BRANCH_CREATE` at org root.
2. `orgRegistry.register("tokyo", orgAdmin, newBranchRegistry, resolver, bitmap, closesAt)` — the
   `subregistry` argument is what makes this a Branch rather than a Member.
3. Deploy `BranchRegistrar` for the new registry; grant it `ROLE_REGISTRAR | ROLE_RENEW` at the Branch
   registry's `ROOT_RESOURCE`.
4. Grant the creating organizer all four registrar roles plus their admin variants at registrar root.
5. Register the Branch's Resources (`wifi`, `ssh`, `api`) and their Enforcer endpoints.

### 5.3 Onboarding — assisted

```
staff opens check-in for tokyo
  → attendee connects wallet            → 0xLeo
  → registrar: is 0xLeo already a Member of acme?
       no  → orgRegistry.register("leo", 0xLeo, 0, resolver, 0, farFuture)   ← Member, once ever
  → staff picks label + Role            → ("leo", hacker)
  → BranchRegistrar.onboard("leo", 0xLeo, Hacker)
       ├─ registry.register(... registryBitmapFor(Hacker) ... closesAt)
       ├─ resolver: write Entitlements for Role hacker
       └─ emit Onboarded
  → leo.tokyo.acme.eth is live
```

Self-serve onboarding is the same call behind a Branch-scoped claim link; the link's issuer holds
`ROLE_ONBOARD` and the Role is fixed to the Branch's default.

### 5.4 Admit — getting on the WiFi

```
device joins WiFi → captive portal → connect wallet → sign challenge
  → recover 0xLeo
  → address → Membership   (indexer lookup; see §6)
  → read Role + Entitlements:
        1. leo.tokyo.acme.eth   Membership override?   use it
        2. leo.acme.eth         org-scoped Role?       use it
        3. neither                                     deny
  → wifi.group  → place the Device in that group's VLAN
  → wifi.rate/ceil → attach a child class under the group's HTB parent
  → admit
```

The Enforcer reads records through a normal ENS client. It holds no user table. A second Device under
the same Membership joins the same VLAN and the same child class — that is how one identity's devices
reach each other while remaining isolated from other groups.

### 5.5 Promote / Revoke

- **Promote** — `ROLE_PROMOTE` required. Rewrite the registry bitmap and resolver grants, rewrite
  Entitlement records. Reversible, unlike v1 fuses. Existing Sessions are re-evaluated on next auth.
- **Revoke** — `ROLE_REVOKE` required. Revoke all roles on the Membership resource and clear its
  records. Enforcers deny on next check. The Member name survives; only the Membership ends.

---

## 6. Implementation Notes

**Key everything on the canonical ID.** Token IDs are *mutable* — they change when roles are granted
or revoked. The stable identifier is:

```
canonicalId = tokenId ^ uint32(tokenId)
```

A promotion changes a Membership's token ID. Any database, index, or UI keyed on the raw token ID will
read a promotion as a new person. Key on `canonicalId`.

**Index both contracts.** Registrar and registry both emit events; the console's address → Membership
lookup is built from that index. There is no on-chain reverse lookup from an address to a Membership,
and reverse records do not scale to a check-in desk.

**Cache at the Enforcer.** The Branch gateway must serve WiFi when its upstream is flaky. Enforcers
cache resolved Entitlements per Membership and fail closed only on explicit revocation.

**Capacity.** 32 regular roles, 32 admin roles, and **15 holders per role per resource**. Grant
branch-wide roles at `ROOT_RESOURCE` so the 15-cap applies to staff counts, never to Member counts.

**Onboarding is a transaction.** Each `onboard()` confirms on-chain. At a check-in desk this needs a
queue and optimistic UI, and a retry path for a dropped tx in front of a waiting line.

---

## 7. Migration Position

The current WiFi Enforcer authenticates with shared passwords and three hardcoded tiers. The path:

| Step | Change | Blocked on |
|---|---|---|
| 1 | Portal: password form → wallet connect + EIP-191 challenge | — |
| 2 | Portal resolves Role via ENS, maps Entitlements → existing tc classes | Role catalogue deployed |
| 3 | Console: Organization, Branch, Role, Onboarding screens | §5 flows |
| 4 | `BranchRegistrar` on Sepolia; onboarding writes on-chain | ENSv2 Sepolia |
| 5 | Mainnet | ENSv2 mainnet release |

Steps 1–3 are independent of ENSv2 and can ship against a v1-style offchain resolver. The role model
above is the target shape either way, so nothing built for steps 1–3 is thrown away at step 4.
