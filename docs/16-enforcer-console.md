# 16 — Resources, access and user management in the console

The enforcer has a complete admin API and the console reads five endpoints of it. Everything that
*changes* anything is unreachable from the UI: `web/lib/api.ts` exports `apiGet` and nothing else,
so the console is a read-only window onto a system that expects to be operated.

This plans the rest of it.

---

## 1. The model the UI has to convey

The single most important thing, and the one most likely to be got wrong:

> **Access is granted to a group, never to a user.**

```
  User ──default_group_id──▶ Group ──group_resource_limits──▶ Resource
                                    (the row IS the grant)
```

`proxy.py` denies any request whose group has **no row** in `group_resource_limits` for that
resource. There is no per-user grant, no allow list, no override. So "give Alice the RPC" is
always two questions: *which group is Alice in*, and *does that group have the RPC*.

A UI with a per-user resource toggle would be lying about the system. The screens below are built
around the group as the unit of policy, with the user pages showing what a person gets **because
of** their group.

### The three limits on a grant

One row carries three independent caps, each `null` for unlimited:

| Column | Counted against | Notes |
|---|---|---|
| `per_device_per_day` | one IP | `daily_counters` |
| `group_per_day` | the whole group | `daily_group_counters` |
| `per_ens_per_day` | one ENS name, **across all their devices** | `daily_ens_counters` |

`per_ens_per_day` is the one that makes ENS identity worth anything at the quota layer: a person
who logs in from a laptop and a phone shares one bucket. It also **fails closed** — if it is set
and the session has no `ens_name`, the request is denied with `ens_identity_required`.

---

## 2. Traps in the API that the UI must handle

These are verified against `proxy/proxy.py`, not taken from the doc — several of them contradict
`docs/09-api-reference.md`.

| # | Trap | What the UI must do |
|---|---|---|
| T1 | **`PUT /limits` is a full replace.** Omitting `per_ens_per_day` sets it to `NULL` = unlimited. | Always send all three fields, every time. Never PATCH-by-omission. |
| T2 | **`GET /admin/groups/:id` does not return `per_ens_per_day`**, though `PUT` accepts it. The value is invisible through the API. | Show it as "not readable back" rather than blank, which would imply unlimited. Do not round-trip it. |
| T3 | **Creates are not idempotent.** 409 `name_taken` / `username_taken` / `slug_taken`. | Treat 409 as a named, recoverable outcome with a useful message — not a generic failure. |
| T4 | **`GET /admin/resources` returns no key field at all**, though the doc says masked. `GET /admin/resources/:id` does include `api_key_masked`. | Only show key state on the detail view. |
| T5 | **Delete guards.** Group with members → 409; group with active sessions → 409; resource with any limit row → 409. | Say which thing is blocking and link to it, rather than reporting "delete failed". |
| T6 | **`network_tier` is a closed enum** — `basic`, `staff`, `vip` — enforced on create and patch. | A select, not a text field. Note that `seed_ens.py` writes other values directly to SQL, so the list may contain tiers the API would reject. |
| T7 | **Users require a password** even though ENS members authenticate by signature. | Generate one; never ask an operator to invent a secret that is never checked. |
| T8 | **No lookup-by-slug for resources.** | List and match client-side; there is no other option. |
| T9 | **`PATCH /admin/groups/:id` renaming to an existing name returns HTML 500**, not 409 — an unhandled `sqlite3.IntegrityError`. | Check the name against the list before sending. |
| T10 | **`auth.py` matches at most 20 tokens, unordered.** Past 20 live tokens some silently 401. | The token screen should say so and encourage revoking. |
| T11 | Quota `scope` defaults to **group** for any value that is not exactly `device`. | Always send an explicit scope. |
| T12 | **There is no `ens` quota scope** and no reset for `daily_ens_counters`, though `per_ens_per_day` is enforced. | Do not offer a per-ENS top-up; it cannot be honoured. |

---

## 3. Screens

### 3.1 Resources — `/console/resources`

What an upstream is and how the proxy authenticates to it.

**List**: slug, display name, upstream host, placement, enabled, and how many groups have access.
**Detail / edit**: everything patchable (`display_name`, `upstream_url`, `key_placement`,
`key_header_name`, `query_param_name`, `notes`, `enabled`, `strip_path_prefix`), plus the
`group_access` list with a link to each group.

**Key placement** drives which extra field is required, and the form must follow it:

| Placement | Extra field |
|---|---|
| `url_path` | — |
| `header` | `key_header_name` |
| `bearer_token` | — |
| `basic_auth` | `api_key_b64_user` |
| `query_param` | `query_param_name` |
| `no_auth` | none; `api_key` may be omitted |

**Key rotation is three steps and the UI must show which one you are in**: stage
(`rotate-key`) → the resource now reads `has_pending_key: true` → commit (`commit-key`) or
discard (`pending-key` DELETE). Staging does not activate. A resource sitting with a pending key
is a state worth surfacing loudly, because it looks like nothing happened.

**`strip_path_prefix` is inert** — stored, returned, and never read by `upstream._build_url`.
Either implement it or do not offer it. This plan does not offer it.

### 3.2 Access — `/console/access`

The heart of it: a **groups × resources matrix**. Each cell is either a grant or nothing.

- Empty cell → "no access"; clicking opens the limit editor and a save creates the row.
- Filled cell → shows the three caps compactly (`50 / 500 / —`).
- Revoking removes the row, which is the only way to take access away.

This screen exists because the relationship is invisible otherwise: it lives in a join table with
no page of its own, and an operator otherwise has to open each group in turn to discover who can
reach what.

Per T1, saving always sends all three fields. Per T2, the per-ENS cap shows as "set, not
readable" once written.

### 3.3 Users — `/console/users`

**List**: username, ENS name, wallet, group, enabled, online. Filters for group and disabled,
with paging — `limit`/`offset` are real and `total` is returned, so the count is honest.

**Detail**: group (changeable), ENS name and wallet, notes, disable toggle, today's usage per
resource, active session, and the two destructive actions — **revoke session** (ends it and
flushes the iptables rule via the portal) and **delete**.

**What they can reach** is rendered from their group's grants, labelled as such, so nobody looks
for a per-user switch that does not exist.

**Create**: username, ENS name, wallet, group. The password is generated (T7) and never shown,
because nothing ever checks it.

### 3.4 Quota — inside a user or group

Not its own screen. A top-up is always about *this device* or *this group*, so it belongs where
you are already looking:

- from a user with an active session → adjust `scope=device` with their IP
- from a group → adjust `scope=group`

Show `base_limit`, `adjustments`, `effective_limit`, `used`, `remaining` from `GET /admin/quota`,
and offer reset. Per T12, no per-ENS option.

---

## 4. The write layer

`lib/api.ts` currently exports one function. It needs the rest, with one property that matters
more than the verbs:

**Errors must stay typed.** The proxy distinguishes 400 (bad input), 401 (console not signed in),
403, 404, 409 (the named conflicts above) and 502 (enforcer unreachable). Collapsing those into
`throw new Error(text)` is what made the console say "the enforcer did not answer" when the real
answer was "that name is taken". So: an `ApiError` carrying `status` and the parsed `error` code.

All of it goes through the existing `/api/admin/[...path]` proxy, which holds the enforcer token
server-side and gates itself on a proven-ownership session (see below).

### Who is allowed to write

There is no console token. Operating the enforcer requires a signature from the wallet that holds
the organization's `.eth` name, verified against the registry by `/api/console/session`, which
then issues an HMAC-signed httpOnly cookie. That is the same authority the contracts already
enforce for every on-chain write, so there is one answer to "who runs this organization" rather
than two — and nothing has to be provisioned out of band before somebody can run their own.

The session records which name was proved, but the enforcer has no organization column, so any
proven owner pointed at a deployment operates that one enforcer. The screens say so.

---

## 5. Checklist

**Write layer**
- [ ] `ApiError` with `status` and `code`; `apiGet/apiPost/apiPut/apiPatch/apiDelete`
- [ ] 401 surfaces as "sign in", never as an enforcer failure
- [ ] Every mutation revalidates the SWR keys it invalidates

**Resources**
- [ ] List with group-access count
- [ ] Create, with placement-driven conditional fields
- [ ] Edit; enable/disable
- [ ] Key rotation: stage → commit / discard, with the pending state visible
- [ ] Delete, naming the groups that block it (T5)

**Access**
- [ ] Groups × resources matrix
- [ ] Grant / edit limits, always sending all three (T1)
- [ ] Revoke
- [ ] Per-ENS cap shown as "set, not readable" (T2)

**Users**
- [ ] List with group/disabled filters and paging
- [ ] Create with generated password (T7)
- [ ] Detail: group change, disable, notes, usage today
- [ ] Revoke session; delete
- [ ] "What they can reach", derived from their group

**Groups**
- [ ] Create/edit with the tier enum (T6), rename checked against the list (T9)
- [ ] Members: add, remove
- [ ] Delete, naming what blocks it

**Quota**
- [ ] Read current state for a device or group
- [ ] Top-up with a reason; remove an adjustment; reset counters

**Who may operate it**
- [x] No console token anywhere. The only credential is the wallet that owns the organization's
      `.eth` name, proved once by signing a server-issued nonce and checked against the registry
- [x] `/api/admin/*` is the single gate; the middleware's second, different one is gone
- [x] A refused challenge is spent, so it cannot be retried
- [x] Reads that are public stay public — only writes and enforcer figures need the proof

**Honesty**
- [ ] No screen renders a failed read as empty data
- [ ] 409s say which name or which dependency
- [ ] Nothing offers `strip_path_prefix` or a per-ENS top-up while they do nothing

---

## 6. What this does not do

- **The enforcer is not multi-tenant.** Its groups, users and resources are global to one
  deployment — there is no organization column. The console is now organization-scoped for
  everything on chain, and these screens are *not*: they show one enforcer. That mismatch is
  real and should be stated on screen rather than papered over.
- **Resources stay local.** An upstream URL and an API key are not published to ENS and never
  should be. The chain says which group a person is in; the enforcer decides what that group can
  reach.
