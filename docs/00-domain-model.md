# Domain Model

The system is not event software. It is **identity-gated access to physical infrastructure**, for any
organization that operates physical locations. Events are one instance of that shape; a company with
offices, a gym chain, a co-working operator, a university with campuses are others.

This document fixes the vocabulary. Every other doc, schema, API route, and UI label uses these terms.

---

## Entities

### Organization

The root entity. A real-world org that operates one or more physical locations. Owns an ENS name; that
name is the trust root for everything beneath it.

```
acme.eth            ← Organization
ethglobal.eth       ← Organization
```

An Organization defines its Roles, registers its Branches, and is the only entity that can delegate
administrative authority.

### Branch

A physical location operated by an Organization. May be permanent (an office) or time-bounded (a
three-day hackathon). A Branch is where infrastructure physically lives and where people physically
show up.

```
shibuya.acme.eth        ← permanent branch, no end date
tokyo2026.ethglobal.eth ← time-bounded branch, opens/closes with the event
```

A Branch carries: display name, address/venue, timezone, optional `opens`/`closes` window, and the set
of Resources available there.

> A time-bounded Branch is the generalization of "event". We do not model "event" separately — an
> event is a Branch whose window is short.

### Member

A person known to the Organization, independent of any single Branch. Bound to a wallet address.
Persists across Branches and across time — this is what makes identity *global* rather than per-venue.

```
leo.acme.eth        ← Member of acme
```

The Member name is minted **once**, at the person's first Onboarding anywhere in the Organization, and
is never minted again. Every subsequent Branch adds a Membership beneath it. This is a deliberate
cost: one extra mint on a first visit buys an on-chain identity that genuinely follows the person
across locations, rather than a cross-branch view assembled in the console.

A Member's history spans every Branch they have ever been admitted to.

### Membership

A Member's standing at one specific Branch, carrying exactly one Role. This is the unit that
infrastructure actually reads.

```
leo.tokyo2026.ethglobal.eth   ← Membership: leo, at tokyo2026, role=volunteer
leo.singapore2026.ethglobal.eth ← same Member, different Branch, possibly different Role
```

One Member may hold many Memberships. A Membership is created by Onboarding and ended by Revocation.

### Role

A named bundle defined at the **Organization** level and granted per **Membership**. A Role carries two
orthogonal payloads that must never be conflated:

| Axis | Term | Governs | Read by |
|---|---|---|---|
| Administrative | **Permissions** | what you may *do in the console* | the console |
| Infrastructural | **Entitlements** | what you *get from the infrastructure* | Enforcers |

A volunteer may onboard attendees (Permission) while receiving only 5 Mbps (Entitlement). An
organizer may receive unlimited bandwidth and also edit Roles. The two axes move independently, and
the UI must present them as separate editors.

#### Role scope

A Role is granted at one of two scopes:

| Scope | Granted on | Applies |
|---|---|---|
| **Organization-scoped** | the Member (`leo.acme.eth`) | at every Branch |
| **Branch-scoped** | the Membership (`leo.osaka.acme.eth`) | at that Branch only, **overriding** the org-scoped Role |

Enforcers and the console resolve in that order:

```
1. Membership at this Branch?   → use its Role
2. else org-scoped Role?        → use it
3. else                         → deny
```

This is what lets one model serve both shapes. A hackathon issues only Memberships — you must check in
to get anything. A gym chain issues only org-scoped Roles — your membership works at every location. A
company issues an org-scoped Role plus Branch overrides at the offices you are badged into.

### Permission

A single administrative capability. Namespaced `subject:verb`.

```
branch:create   branch:edit    branch:archive
member:onboard  member:revoke  member:view
role:assign     role:edit
resource:manage
session:view
```

A Role grants a set of Permissions. Permissions are always scoped to the Branch the Membership belongs
to — except Organization-level Roles, which are scoped org-wide.

### Entitlement

A policy value consumed by a Resource's Enforcer. Namespaced by Resource.

```
wifi.group       = hacker            ← isolation group, derived from Role
wifi.rate        = 5mbps             ← this Membership's guaranteed share
wifi.ceil        = 20mbps            ← its ceiling, borrowed from group headroom
wifi.hours       = 24/7
ssh.pubkey       = ssh-ed25519 AAAA...
ssh.sudo         = false
api.rpc.limit    = 10000/day
door.zones       = lobby,hall-a
```

Isolation is per **group** (a Role maps to a group; groups do not see each other), while allocation is
per **Membership** within that group's budget. See `13-ens-design.md` §3.1.

Entitlements are what get written to ENS text records and what the Fedora VM reads today.

### Resource

Anything at a Branch whose access is gated by Membership. The generalization of "the WiFi".

| Resource | Enforcer | Entitlements it consumes |
|---|---|---|
| `wifi` | captive portal + iptables/tc on the branch gateway | bandwidth, group, hours |
| `ssh` | `AuthorizedKeysCommand` on shared hosts | pubkey, sudo, allowed commands |
| `api` | API gateway | per-identity quotas |
| `door` | badge reader | zones |

Resources are registered per Branch. A Branch may offer only `wifi`.

### Enforcer

Software deployed at a Branch that gates one Resource by reading Membership records and applying
Entitlements. Enforcers hold no user database — they read identity and policy at auth time.

The Fedora VM (`portal/app.py` + `iptables` + `tc`) is the `wifi` Enforcer.

### Device

A physical client bound to a Membership at authentication time. Today identified by DHCP-leased IP;
MAC binding is available since the branch gateway is the DHCP authority.

Multiple Devices may share one Membership — that is what makes same-identity device grouping possible.

### Session

An authenticated binding of a Device to a Resource, with a start and an end. Sessions are the source
of presence detection, usage analytics, and live occupancy.

---

## Actions

| Term | Meaning |
|---|---|
| **Onboard** | Create a Membership at a Branch. Mints the Member name if this is a first visit, mints the Membership subname, writes Entitlements. |
| **Admit** | Grant a Device a Session on a Resource, after verifying its Membership. |
| **Promote** | Change a Membership's Role. Rewrites Entitlements. |
| **Revoke** | End a Membership. All Enforcers deny on next check. |
| **Archive** | Close a Branch. Memberships become historical, not active. |

### Onboarding modes

| Mode | Who drives | Shape |
|---|---|---|
| **Assisted** | a Member with `member:onboard` | check-in desk: staff picks label + Role |
| **Self-serve** | the arriving person | QR or claim link scoped to a Branch + default Role |

Both produce the same artifact: a Membership.

---

## Name Hierarchy

```
acme.eth                          Organization
├── leo.acme.eth                  Member        (org-level, persistent)
├── shibuya.acme.eth              Branch
│   ├── leo.shibuya.acme.eth      Membership    (role: staff)
│   └── ann.shibuya.acme.eth      Membership    (role: manager)
└── osaka.acme.eth                Branch
    └── leo.osaka.acme.eth        Membership    (role: visitor)
```

Label rules: `[a-z0-9-]`, max 32 chars, ENSIP-15 normalized before namehashing.

---

## Terms We Do Not Use

| Avoid | Use instead | Why |
|---|---|---|
| Event | Branch | an event is a time-bounded Branch, not a separate concept |
| Venue / Location / Site | Branch | one word, consistently |
| Attendee / User | Member, or Membership | the distinction between the two is load-bearing |
| Tier | Role | "tier" is an artifact of the password demo |
| VLAN | isolation group | VLAN is one implementation of grouping, not the concept |
| Access level | Role | Roles are bundles, not a linear scale |

---

## Status

These terms are expressed in ENS as described in [`13-ens-design.md`](./13-ens-design.md):
Organization and Branch are registries, Membership is a name carrying a per-name EAC role bitmap,
Permissions are roles on the `BranchRegistrar`, and Entitlements are records on the Permissioned
Resolver.

The vocabulary above is **settled**. Screens, routes, database columns, ENS record keys, and all other
docs use these terms verbatim. Changing one is a rename across the whole system, not a local edit.
