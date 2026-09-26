# ENS-Identity VLAN & Group Access — Design

**Date:** 2026-09-26
**Status:** design for review

## Goal

Replace the captive portal's username/password tier login with an **ENS-name
identity** flow, where the entered ENS name maps (via SQLite) to a group, the
group determines bandwidth class + API resource access, and every ENS user is
network-isolated from every other. Contracts are NOT deployed — the ENS→group
mapping is a local SQLite rule, not an on-chain lookup.

## Context & Constraints (from live system inspection)

- Portal: Flask on `0.0.0.0:8080`, runs as **root**, owns all iptables/tc via
  `grant_access(ip,tier)` / `revoke_access(ip)`. In-memory dicts:
  `AUTHED_IPS{ip→tier}`, `SESSION_IDS{ip→sid}`, `ENS_NAMES{ip→name}` (added).
- Proxy: Flask on `127.0.0.1:8081`, gates API resource access by
  `group_resource_limits` row existence, injects `resources.api_key`.
- DB: `/var/lib/ensca/ensca.db` (sqlite). Tables: groups, users, resources,
  group_resource_limits, sessions, usage_events, daily_counters,
  daily_group_counters, quota_adjustments, admin_tokens, audit_log.
- **Bandwidth = fwmark → tc HTB class** on `enp10s0u1` egress (download path),
  built by `/etc/NetworkManager/dispatcher.d/99-ensca`:
  - mark 10 → class 1:10 → 5 Mbit (basic)
  - mark 20 → class 1:20 → 10 Mbit (staff)
  - mark 30 → class 1:30 → 1 Gbit (vip)
  - default 1:99 → 1 Mbit
- `network_tier` → group is **1:1** (`group-by-tier` is `LIMIT 1`). Each group
  needs a distinct `network_tier`.
- Firewall baseline (restored): `FORWARD` policy DROP, established ACCEPT,
  →portal ACCEPT, port-80 REDIRECT→8080. Per-IP ACCEPT added by `grant_access`.
- Cross-tier isolation: `_apply_cross_tier_rules` DROPs traffic between IPs on
  different tiers.
- VM `/opt/ensca` is NOT git; local repo `main` proxy (1358 lines) is a
  superset of VM's deployed proxy (1112 lines) — same lineage. Deploying main's
  proxy is in scope (closes drift).

## Resolved Model (user decisions)

| Dimension | Rule | Scope |
|-----------|------|-------|
| Identity | ENS name = one user; same name across devices = same identity | per ENS name |
| VLAN / L2 isolation | every ENS user isolated from every other (own island) | **per ENS user** |
| Bandwidth class | hacker→mark30 (1 Gbit), partner→mark10 (5 Mbit) | **per group** |
| API quota / rate limit | shared across a user's devices | **per ENS user** |
| API access | hacker→Alchemy, partner→no Alchemy | **per group** |
| Unknown ENS name | **rejected** at portal, no access | — |
| Disconnect | ARP poll 10s, revoke after ~20s absent | per device |

Groups & seeded users:
- **hacker** (network_tier `hacker`, mark 30, Alchemy access):
  bob.doco.eth, alice.eth (+ builders)
- **partner** (network_tier `partner`, mark 10, no Alchemy):
  world.eth, soy.eth, uniswap.eth (+ partners)

## Architecture

### 1. Data model (SQLite)

ENS identities reuse the existing `users` table — no new identity table:
`username` = ENS name (e.g. `bob.doco.eth`), `password_hash` = `''` (unused),
`default_group_id` = the mapped group's id.

```sql
-- ENS identity = a users row: username = ENS name, password_hash = '',
-- default_group_id = group id. Seeded once per known ENS name.
```

Two schema additions are needed (detailed in §6):
- new table `daily_ens_counters` (per-ENS-user daily quota bucket)
- new nullable column `group_resource_limits.per_ens_per_day`

Add distinct `network_tier` values `hacker` / `partner` to the two group rows.

`TIER_MARK` in portal extended: `{"hacker":"30", "partner":"10", basic/staff/vip kept}`.

### 2. Portal login flow (app.py)

- `/login` reads `ens_name`, normalizes (lowercase, strip).
- Look up ENS name in DB via a new proxy internal endpoint
  `GET /internal/ens-lookup/<name>` → `{group_id, network_tier}` or 404.
- 404 → re-render login with "ENS name not recognized".
- Found → `grant_access(ip, network_tier)` with the group's tier.
- **Shared identity:** `ENS_NAMES[ip]=name`. Session reuse — if the same ENS
  name already has an active session (any IP), new devices join under the same
  ENS identity (same group_id, same session grouping for quota).

### 3. Per-user L2 isolation

`grant_access` currently isolates by *tier*. Change isolation to key on **ENS
user**: two IPs with the *same* ENS name may talk; IPs with *different* ENS
names get mutual DROP — regardless of group. Bandwidth mark still = group's mark.

### 4. Bandwidth (no tc script change)

hacker uses existing mark 30 (1 Gbit), partner uses mark 10 (5 Mbit). tc classes
already exist. Zero dispatcher edits.

### 5. API access control (proxy DB)

- Seed `alchemy` resource (slug, upstream_url `https://eth-mainnet.g.alchemy.com/v2`,
  key_placement url_path, api_key = real key).
- `group_resource_limits`: insert (hacker_group_id, alchemy_id, ...). NO row for
  partner → partner blocked from Alchemy by existing row-existence gate.

### 6. Rate limit keying — per-ENS-user bucket (shared identity)

Current rate_limit has TWO levels: `daily_counters` (per-ip device) +
`daily_group_counters` (per whole group). Neither is per-ENS-user. Decision:
**add a per-ENS-user daily counter** so bob.doco.eth's N devices share ONE
bucket, while alice (also hacker) has her own separate bucket.

New table:
```sql
CREATE TABLE IF NOT EXISTS daily_ens_counters (
    date        TEXT NOT NULL,
    ens_name    TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, ens_name, resource_id)
);
```

Thread `ens_name` end-to-end (single chosen path, no perimeters):
- Portal `_notify_session_created` payload gains `ens_name`.
- **Upsert a real users row per ENS name** (username=ens_name, password_hash='',
  default_group_id=mapped group) so `sessions.user_id` IS the ENS identity — no
  `portal-anon` sentinel, no new column on `sessions`. session-created writes
  `user_id = <ens users row id>`.
- Add nullable `per_ens_per_day` column to `group_resource_limits` so
  device / group / ENS are three independent quota knobs.
- `check_and_increment(ip, group_id, resource_id, ens_name)`: new signature.
  When `per_ens_per_day` is set, check + increment `daily_ens_counters` keyed on
  `ens_name` alongside the existing device + group checks. Proxy resolves
  `ens_name` from the active session's user row (`users.username`).

### 7. Disconnect reaper

New background thread in portal (or a small systemd timer script):
- Every 10s, read neighbor table (`ip neigh show dev enp10s0u1`).
- Track last-seen per authed IP. IP absent/FAILED for ~20s → call
  `revoke_access(ip)` (clears iptables + in-memory + notifies proxy
  session-ended). CPL auto-cleared → rapid re-test with no manual cache clear.

## Testing (self-test on VM before device handoff)

All simulated from the VM using network namespaces or crafted source IPs:
1. **ENS→group:** seed bob (hacker), world (partner). Login each, assert
   correct mark + group.
2. **Shared identity:** two IPs, same ENS name → same group, isolation allows
   them to talk, shared quota bucket.
3. **Per-user isolation:** bob-IP and alice-IP (both hacker) → mutual DROP.
4. **Bandwidth:** assert mark 30 on hacker IP (tc class 1:30), mark 10 on
   partner (1:10). Optional throughput probe.
5. **API access:** proxy request as hacker → Alchemy 200; as partner → 403.
6. **Rate limit:** exceed quota on one device → second device same ENS also
   throttled (shared bucket).
7. **Reaper:** drop an IP from neigh table → within ~20s auth cleared, re-login
   works fresh.
8. **Unknown name:** login `nobody.eth` → rejected, no access.

## Out of scope

- On-chain ENS resolution (contracts not deployed).
- 802.1Q VLAN tagging (isolation is L3 iptables DROP + fwmark tc, per existing design).
- Web console changes.

## Risks

- Prod firewall/tc/DB changes — mitigated by worktree, backups, VM-first self-test.
- Rate-limit re-keying touches proxy hot path — needs careful review.
- Shared-identity session model: proxy sessions key on IP; sharing a bucket
  across IPs needs a stable identity key (ENS name) threaded from portal→proxy.
