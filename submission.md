# Radius — ENS-native Infrastructure Access for Crypto Events

## Description

Most networks — corporate offices, university campuses, co-working spaces, event venues — still run on shared passwords, manual key distribution, and flat access for everyone. There's no per-person policy, no isolation between roles, no audit trail, no revocation without a full credential reset. Identity is an afterthought bolted on after the fact, if at all.

**Radius** is an identity-gated network and API access control system. Any organization with an ENS name can use it — a company, a university, an event venue. Your ENS subname becomes the sole credential for everything: WiFi admission, bandwidth tier, sponsor or internal API access, SSH. The subname carries your role, your access policy, and your device group in ENS text records. The infrastructure reads ENS instead of a password database. No VPN client, no RADIUS server, no manual provisioning — mint a subname, walk in, connect.

The system enforces access in three layers: a captive portal gates WiFi entry and assigns per-role bandwidth tiers at the kernel level, a resource proxy intercepts every API call and injects keys server-side so credentials are never exposed to end users, and an operator console lets administrators define groups, set per-identity and per-group daily quotas, rotate keys atomically, and revoke sessions in real time. Every admission, every proxied request, every quota check is logged against a session identity — not a bare IP — giving operators the first real audit trail without a dedicated security appliance.

Critically, Radius gives everyone on the network a usable, role-appropriate slice of real bandwidth — so nobody has to fall back to their mobile hotspot. Role-based VLANs mean a staff member or VIP gets a dedicated high-bandwidth lane, isolated from general attendee traffic, while basic users get a fair share without being able to saturate or snoop on each other. One shared network, properly segmented — the way it should have always worked. The demo targets a crypto hackathon, but the enforcement model is identical for a corporate office, a university lab, or any physical location where identity-based access control matters.

---

## The Problem It Solves

Crypto events are full of technically sophisticated people — yet they run on **hotel-grade shared WiFi, Discord-pasted API keys, and manual SSH key distribution**. There's no per-person policy, no isolation, no audit trail, no revocation.

The identity layer already exists. Every attendee has an ENS name and a wallet. **It just isn't wired to the infrastructure.**

---

## How It Works

**1. Mint at check-in.**
Every attendee gets a subname under the event domain — `philo.tokyo2026.ethglobal.eth`. The organizer writes their role, bandwidth policy, SSH public key, and device group directly into ENS text records. No database entry. No password issued. The subname *is* the credential.

**2. Captive portal reads ENS, not a password DB.**
When a device connects to the event WiFi, it hits the captive portal. The attendee signs an EIP-191 challenge with their wallet. The portal resolves the signing address to an ENS subname, reads the `wifi-tier` and `wifi-bandwidth` records, and maps them to an access group. That's the only auth check.

**3. Network enforcement runs at the kernel level.**
Login triggers two things instantly: an `iptables` rule marks the device's traffic with an fwmark tied to its tier, and a `tc HTB` class enforces bandwidth — 5 Mbit for basic attendees, 10 Mbit for staff, 1 Gbit for VIP. Cross-tier `FORWARD DROP` rules prevent devices on different tiers from reaching each other at all. Device isolation is structural, not policy — there's nothing to misconfigure.

**4. A resource proxy injects API keys server-side.**
All sponsor API access goes through a proxy layer. Attendees never see the keys. The proxy reads the active session, checks group membership and daily usage counters, then forwards the request with the key injected — into the URL path, query param, or header depending on the upstream. Limits are per-device and per-group, adjustable mid-day without a restart. Key rotation is atomic: stage a new key, commit it — zero downtime, old key invalidated in one swap.

**5. The full audit trail is automatic.**
Every proxied request is logged against a session UUID (never a bare IP). Organizers see per-person API usage, bandwidth consumed, login/logout times — in real time, via the operator console. Nothing requires manual instrumentation.

---

## How It's Made

The stack is deliberately split into four independent layers, each doing one job.

**Network enforcement — Linux kernel, not a daemon.**
The access control is pure kernel — `iptables` fwmark rules tag traffic by tier at the moment of login, and `tc HTB` (Hierarchical Token Bucket) shaping classes cap bandwidth per tier on the `enp10s0u1` egress interface. No userspace daemon sits in the packet path. When an attendee's tier changes mid-event, a single `tc class change` command updates the rate live without touching any other device. Cross-tier isolation is a `FORWARD DROP` iptables rule — no routing policy, no VLAN, structurally impossible to misconfigure.

The hardware is deliberately minimal: a Fedora VM running in VMware Fusion, USB-to-ethernet adapter, TP-Link AX80 in router mode. Double NAT (AX80 behind the VM) is a constraint we worked around — since the VM sits at L3, individual device MACs are hidden behind the AX80's NAT, so identity tracks by sticky DHCP IP (12h leases) rather than MAC.

**Captive portal — Flask, systemd, running as root.**
The portal is a Python Flask app that must run as root to issue `iptables` and `tc` commands. On login it fires three things atomically: adds an iptables `ACCEPT` rule for the device IP in `FORWARD`, sets the fwmark, and calls the proxy's internal API to create a session row. The `tc class change` for bandwidth happens in the same grant path. On logout the reverse: rules are removed, session is closed. A `NetworkManager` dispatcher script (`/etc/NetworkManager/dispatcher.d/99-ensca`) re-installs the base `tc` queuing and iptables skeleton on every boot from a lock file, so restarts are clean.

**Resource proxy — Flask, SQLite WAL, rate limiting in Python.**
The proxy runs as an unprivileged user, which means it cannot touch iptables — by design. Every attendee API request goes to `/proxy/<slug>/…`. The proxy checks the active session by device IP, checks group membership against `group_resource_limits`, increments daily counters (`per_device_per_day` and `per_group_per_day`), then forwards the request with the API key injected — into the URL path, query param, or request header depending on the resource. The key never leaves the VM. Key rotation is a two-step stage/commit atomic swap: new key goes to a `pending_api_key` column, a `POST /admin/resources/<id>/rotate/commit` does a single SQL `UPDATE` to make it live. Zero downtime, old key gone in one write.

The SQLite database is shared between portal and proxy, in WAL mode so both processes can read/write without blocking. Eleven tables: sessions, users, groups, resources, limits, usage events, daily counters, quota adjustments, audit log, admin tokens, API key rotations.

**Console — Next.js 15, wagmi/viem, ENS on Sepolia.**
The operator console is a Next.js app with wallet-connect via wagmi. Group and member provisioning writes directly to ENS on Sepolia via viem, then mirrors the result into the enforcer's SQLite via the proxy admin API. ENS text records carry the ground truth — `wifi.rate`, `wifi.ceil`, `wifi.group` — and the proxy reads them at admission time via a CCIP-Read resolver. The ENS → proxy path is the bridge that makes bandwidth limits dynamic: change a record on-chain, it takes effect at the attendee's next admission without a proxy restart.

**The notably hacky part.**
The portal runs as root and uses `subprocess` to issue raw `iptables` and `tc` commands. There's no abstraction layer — the commands are built as argument lists and fired via `_run()`. This is intentional: `iptables` and `tc` have no Python-native equivalents that are production-ready, and the wrapper is thin enough to read in one glance. The real guard is that the proxy runs as a separate unprivileged user and can only talk to the portal via a localhost internal API — no command injection surface, because the proxy never touches a shell command.

---

The full enforcement stack is **running live** on a Fedora VM + TP-Link AX80:

- **Captive portal** (Flask, systemd) — tier login, iptables grant/revoke, session sync
- **Resource proxy** (Flask, SQLite) — session auth, access control, rate limiting, audit log, key rotation
- **Console** (Next.js) — operator dashboard for groups, perimeters, resources, access control
- **ENS integration** — `wifi.rate` / `wifi.ceil` entitlements flow from ENS → proxy → live `tc class change`
- **Admin operations live**: quota top-ups mid-day, key rotation, session revocation

---

## What Makes It Different

| Before Radius | After Radius |
|---|---|
| Shared WiFi password | ENS subname + wallet signature |
| Same network for everyone | Role-based VLAN per identity |
| API keys on Discord | Per-identity, injected server-side |
| Manual SSH key distribution | `ssh-pubkey` ENS text record |
| No usage visibility | Per-session audit log + analytics |

---

## Tech Stack

- **Network enforcement**: Linux iptables fwmark + tc HTB (software VLAN now → FreeRADIUS 802.1X in Phase 3)
- **Control plane**: Python Flask, SQLite WAL, systemd
- **Console**: Next.js 15, wagmi/viem, Tailwind CSS
- **Identity**: ENS + CCIP-Read offchain resolver (Phase 2)
- **Chains**: Ethereum mainnet (ENS), Sepolia (dev/test)

---

## Roadmap

- **Phase 2** *(next)*: Replace username/password with wallet signature + EIP-191 challenge — ENS subname as the sole auth token
- **Phase 3**: Per-identity hardware VLAN via MikroTik + FreeRADIUS 802.1X
- **Phase 4**: `ssh-pubkey` ENS record → AuthorizedKeysCommand SSH auth
- **Phase 5**: Post-event on-chain attestations (hours on network, APIs used, sponsors accessed)

---

## ENS Prize — $10,000

**How we use ENS:**
ENS is not a feature in Radius — it is the entire identity and access control plane. Every person on the network is an ENS subname (`philo.tokyo2026.ethglobal.eth`). Their role, bandwidth tier, and device group are stored as ENS text records — `wifi.group`, `wifi.rate`, `wifi.ceil` — not in a password database. On WiFi admission, the enforcement proxy resolves the ENS name, reads those entitlements, and maps them directly to live kernel-level network policy: iptables fwmark, tc HTB bandwidth classes, and API quota assignments. Org and perimeter discovery is also ENS-native — each branch publishes its registrar address as an `ensca.registrar` text record, making the entire org tree discoverable from ENS with no hardcoded config.

**Why we're applicable:**
ENS is the entire identity and access control plane. The physical network state — who is admitted, at what bandwidth, with what API quotas — is a direct materialization of ENS records. There is no concept of a user in this system that isn't an ENS name.

**Code reference:** `proxy/proxy.py` line 1484 — `internal_ens_lookup` — the function that resolves an ENS name to entitlements and maps `wifi.group`, `wifi.rate`, `wifi.ceil` to live network enforcement.

**Ease of use: 6 / 10**

**Feedback for ENS:**
- The ENS indexer (`staging-graphql.ens.dev`) is a single point of failure on the hot admission path. There's no documented SLA, no pagination on `domains(where:)` queries, and truncation is indistinguishable from "name not found." A production admission path needs either a stable indexer endpoint or a documented fallback to direct RPC without scanning unbounded log ranges.
- `resolveIdentity` reading entitlements from `ENS.resolver` rather than the name's own resolver is a silent footgun — any member pointing their name at a custom resolver resolves to empty entitlements with HTTP 200 and no error, silently falling to the default policy. The docs don't surface this.
- ENSv2's `entitlementsOf(roleId)` is the right primitive for structured access policy, but the key schema for application-specific records (like `wifi.group`) is completely undocumented. We had to invent a convention with no guidance on namespacing, collision avoidance, or canonical key formats.
