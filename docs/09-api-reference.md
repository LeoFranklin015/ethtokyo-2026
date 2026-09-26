# Proxy API Reference

Base URL: `http://172.16.0.130:8081` (from Mac) or `http://127.0.0.1:8081` (on VM)

All admin endpoints require: `Authorization: Bearer <admin_token>`

---

## Authentication

Admin tokens are bcrypt-hashed UUIDs. Create the first token from localhost without auth (bootstrap):

```bash
curl -s -X POST http://127.0.0.1:8081/admin/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"bootstrap"}'
```

Token is shown once in the response. Subsequent token creation requires an existing token.

---

## Health

### GET /health

No auth. Always returns 200.

```json
{"status": "ok", "ts": 1727000000}
```

### GET /status

No auth from localhost. Admin token required from other IPs.

```json
{
  "db": "ok",
  "active_sessions": 3,
  "resources_total": 2,
  "resources_enabled": 2
}
```

---

## Admin Tokens

### POST /admin/tokens

Create token. Localhost: no auth. Remote: admin token required.

Request:
```json
{"name": "my-token", "expires_at": null}
```

Response 201:
```json
{"id": "<uuid>", "name": "my-token", "token": "<raw-token>", "expires_at": null}
```

Token shown once. Store it — not retrievable later.

### GET /admin/tokens

List all tokens.

```json
{
  "tokens": [
    {"id": "<uuid>", "name": "my-token", "created_at": 1727000000,
     "expires_at": null, "last_used_at": 1727000100, "revoked": false}
  ]
}
```

### DELETE /admin/tokens/:id

Revoke token. Returns `{"revoked": true}`.

---

## Groups

Groups are the central policy unit. A `group_resource_limits` row grants access; removing it revokes it.

### POST /admin/groups

```json
{"name": "hackers", "network_tier": "basic", "notes": "optional"}
```

`network_tier` must be one of: `basic`, `staff`, `vip`.

Response 201: group object.

### GET /admin/groups

```json
{
  "groups": [
    {"id": "<uuid>", "name": "hackers", "network_tier": "basic",
     "member_count": 42, "active_session_count": 15, ...}
  ]
}
```

### GET /admin/groups/:id

Returns group with members, resource limits, and today's usage.

```json
{
  "id": "<uuid>", "name": "hackers", "network_tier": "basic",
  "members": [{"id": "<uid>", "username": "alice", "disabled": 0}],
  "limits": {
    "alchemy-sepolia": {"per_device_per_day": 50, "group_per_day": 500}
  },
  "usage_today": {
    "alchemy-sepolia": {"used": 120, "limit": 500}
  }
}
```

### PATCH /admin/groups/:id

Update `name`, `network_tier`, and/or `notes`. Returns updated group.

### DELETE /admin/groups/:id

Fails with 409 if group has members.

### POST /admin/groups/:id/members

Add user to group (sets `default_group_id`).

```json
{"user_id": "<uid>"}
```

### DELETE /admin/groups/:id/members/:uid

Remove user from group. Returns note to reassign via `PATCH /admin/users/:id`.

### PUT /admin/groups/:id/limits/:resource_id

Grant (or update) resource access for the group.

```json
{"per_device_per_day": 50, "group_per_day": 500}
```

`null` = unlimited. This is both an access grant and a limit setter — no row = no access.

### DELETE /admin/groups/:id/limits/:resource_id

Revoke group access to resource. Removes the row.

---

## Users

### POST /admin/users

```json
{
  "username": "alice", "password": "secure123", "group_id": "<gid>",
  "ens_name": "alice.acme.eth", "wallet_address": "0x...", "notes": "optional"
}
```

`ens_name` and `wallet_address` optional. Used for future ENS identity linking.

Response 201: `{"id": "<uid>", "username": "alice", "group_id": "<gid>", "ens_name": "alice.acme.eth", ...}`

### GET /admin/users

Query params: `group_id`, `disabled` (0/1), `limit` (default 50), `offset` (default 0).

```json
{"users": [...], "total": 100}
```

### GET /admin/users/:id

Returns user with group info, ENS identity, active session (if any), and today's usage.

```json
{
  "id": "<uid>", "username": "alice",
  "ens_name": "alice.acme.eth", "wallet_address": "0x...",
  "group": {"id": "<gid>", "name": "hackers", "network_tier": "basic"},
  "disabled": false, "created_at": 1727000000,
  "active_session": {...}, "usage_today": {...}
}
```

### GET /admin/users/by-ens/:ens_name

Look up a user by ENS name (e.g. `alice.acme.eth`). Returns 404 if not found.

### GET /admin/users/by-wallet/:wallet_address

Look up a user by wallet address. Returns 404 if not found.

### PATCH /admin/users/:id

Update `group_id`, `password`, `disabled` (bool), `notes`, `ens_name`, `wallet_address`.

### DELETE /admin/users/:id

Deletes user and their sessions. Usage events retain session reference as NULL.

### POST /admin/users/:id/revoke

Force-end the user's active session. Calls portal `/internal/revoke-ip` to flush iptables.

```json
{"session_id": "<sid>", "revoked": true, "ip": "192.168.0.10"}
```

---

## Resources

Resources are upstream services the proxy forwards to.

### POST /admin/resources

```json
{
  "slug": "alchemy-sepolia",
  "display_name": "Alchemy Sepolia RPC",
  "upstream_url": "https://eth-sepolia.g.alchemy.com/v2",
  "key_placement": "url_path",
  "api_key": "alch_xxxx",
  "key_header_name": null,
  "query_param_name": null,
  "api_key_b64_user": null,
  "strip_path_prefix": false,
  "enabled": true,
  "notes": "optional"
}
```

`key_placement` — all supported values:

| Value | Auth mechanism | Required extra fields |
|---|---|---|
| `url_path` | `{base}/{api_key}/{subpath}` | — |
| `header` | Custom header: `key_header_name: api_key` | `key_header_name` |
| `bearer_token` | `Authorization: Bearer {api_key}` | — |
| `basic_auth` | `Authorization: Basic base64({api_key_b64_user}:{api_key})` | `api_key_b64_user` (may be empty) |
| `query_param` | `?{query_param_name}={api_key}` | `query_param_name` |
| `no_auth` | No injection — open or client-provided auth | `api_key` may be omitted |

`strip_path_prefix` — if true, the resource slug is stripped from the forwarded path.

Response 201 includes `api_key_masked` (last 4 chars) and `api_key_b64_user`.

### GET /admin/resources

List all. Returns masked keys, no raw keys.

### GET /admin/resources/:id

Returns resource with `group_access` list showing all groups that have access.

### PATCH /admin/resources/:id

Update `display_name`, `upstream_url`, `key_placement`, `key_header_name`, `notes`, `enabled`.

### DELETE /admin/resources/:id

Fails with 409 if any `group_resource_limits` rows reference this resource. Remove group limits first.

### PATCH /admin/resources/:id/rotate-key

Stage a new key (does not activate):

```json
{"new_key": "alch_new_key_here"}
```

Response: `{"staged": true, "commit_url": "/admin/resources/<id>/commit-key"}`

### POST /admin/resources/:id/commit-key

Atomically swap `api_key = api_key_pending`, clear `api_key_pending`.

Response: `{"committed": true, "activated_at": 1727000000}`

### DELETE /admin/resources/:id/pending-key

Discard staged key without activating.

---

## Sessions

### GET /admin/sessions

Query params: `active` (true/false), `user_id`, `group_id`, `limit`, `offset`.

```json
{
  "sessions": [
    {
      "id": "<uuid>", "user_id": "<uid>", "username": "alice",
      "group_id": "<gid>", "group_name": "hackers",
      "ip": "192.168.0.10", "network_tier": "basic",
      "ens_name": "alice.acme.eth", "wallet_address": "0x...",
      "logged_in_at": 1727000000, "logged_out_at": null, "revoked_at": null,
      "bytes_in": 102400, "bytes_out": 2048000
    }
  ],
  "total": 5
}
```

### GET /admin/sessions/:id

Returns session with per-resource usage breakdown and bandwidth totals.

```json
{
  ...session fields...,
  "bytes_in": 102400, "bytes_out": 2048000,
  "usage": {
    "alchemy-sepolia": {"count": 42, "req_bytes": 8400, "resp_bytes": 120000}
  }
}
```

### DELETE /admin/sessions/:id

Revoke active session. Fails 409 if already ended.

---

## Proxy

### ANY /proxy/:slug

### ANY /proxy/:slug/*path

Proxy a request to the upstream resource identified by `slug`. Auth by active session for the requesting IP.

**Auth flow:**
1. Look up active session for `request.remote_addr`
2. Check `group_resource_limits` row exists for (group, resource) — deny 403 if not
3. Check daily counters — deny 429 if limit exceeded
4. Forward to upstream with injected API key
5. Return upstream response

**Error responses:**

| Status | Body | Reason |
|---|---|---|
| 403 | `{"error": "not_authenticated"}` | No active session for this IP |
| 403 | `{"error": "access_denied", ...}` | Group has no access to this resource |
| 404 | `{"error": "resource_not_found"}` | Slug not found |
| 429 | `{"error": "rate_limit_exceeded", "scope": "device", "limit": 50, "used": 50, "resets_at": "..."}` | Limit hit |
| 502 | `{"error": "upstream_unreachable"}` | Upstream connection failed |
| 503 | `{"error": "resource_disabled"}` | Resource exists but is disabled |

---

## Bandwidth & Resource Allocation

### GET /admin/bandwidth/sessions

Per-session bandwidth totals. Query params: `active` (default `true`), `group_id`, `network_tier`.

```json
{
  "sessions": [
    {
      "id": "<uuid>", "ip": "192.168.0.10", "username": "alice",
      "group_name": "hackers", "tier": "basic",
      "ens_name": "alice.acme.eth", "wallet_address": "0x...",
      "bytes_in": 102400, "bytes_out": 2048000, "bytes_total": 2150400,
      "logged_in_at": 1727000000, "logged_out_at": null
    }
  ],
  "tier_totals": {
    "basic": {"sessions": 15, "bytes_in": 500000, "bytes_out": 12000000}
  },
  "total_sessions": 15
}
```

Sorted by `bytes_total` descending — biggest consumers first.

### POST /admin/bandwidth/test

Measure effective upstream throughput to a resource. Downloads a payload and returns timing.

Request:
```json
{"resource_id": "<rid>", "payload_bytes": 65536, "subpath": ""}
```

`payload_bytes` clamped to 1KB–10MB. `subpath` appended to upstream URL.

Response:
```json
{
  "resource_id": "<rid>",
  "resource_slug": "alchemy-sepolia",
  "upstream_url": "https://eth-sepolia.g.alchemy.com/v2/...",
  "http_status": 200,
  "resp_bytes": 65536,
  "elapsed_ms": 182,
  "first_byte_ms": 45,
  "throughput_bps": 360000,
  "throughput_mbps": 0.36
}
```

This measures the proxy→upstream leg, not client→proxy. Use it to verify resource connectivity and baseline latency.

---

## Usage & Analytics

### GET /usage/me

No admin token. Authenticated by active session IP.

```json
{
  "ip": "192.168.0.10", "group": "hackers", "date": "2026-09-26",
  "resources": {
    "alchemy-sepolia": {
      "used": 42, "device_limit": 50, "group_limit": 500,
      "group_used": 120, "resets_at": "2026-09-27T00:00:00+00:00"
    }
  }
}
```

### GET /admin/usage

Raw event log. Query params: `date` (default today), `resource_id`, `group_id`, `ip`, `limit`, `offset`.

### GET /admin/usage/summary

Aggregated by date+group+resource. Query params: `from`, `to` (YYYY-MM-DD), `group_id`, `resource_id`.

```json
{
  "rows": [
    {
      "date": "2026-09-26", "group_id": "<gid>", "group_name": "hackers",
      "resource_id": "<rid>", "resource_slug": "alchemy-sepolia",
      "request_count": 500, "total_req_bytes": 50000, "total_resp_bytes": 2000000
    }
  ]
}
```

### GET /admin/usage/top-consumers

Query params: `scope` (`device` or `group`), `metric` (`count`, `req_bytes`, `resp_bytes`), `date`, `limit`, `resource_id`.

### GET /admin/usage/export

Streams CSV. Query params: `from`, `to`, `resource_id`, `group_id`.

Header: `Content-Disposition: attachment; filename=usage-<from>-to-<to>.csv`

Columns: `id,ts,ip,username,group,resource,method,path,status,req_bytes,resp_bytes,duration_ms,upstream_error`

---

## Quota Management

### GET /admin/quota

Current quota state for a device or group.

Query params: `scope` (`device` or `group`), `resource_id`, `date` (default today).
- For `scope=device`: also `ip` required.
- For `scope=group`: also `group_id` required.

```json
{
  "scope": "device", "resource_id": "<rid>", "date": "2026-09-26",
  "base_limit": 50, "adjustments": 20, "effective_limit": 70,
  "used": 42, "remaining": 28
}
```

### POST /admin/quota/adjust

Add a one-day top-up. Does not change base limits.

```json
{
  "scope": "device",
  "ip": "192.168.0.10",
  "resource_id": "<rid>",
  "amount": 50,
  "date": "2026-09-26",
  "reason": "hackathon finalist needs extra RPC"
}
```

For `scope=group`: use `group_id` instead of `ip`.

### DELETE /admin/quota/adjust/:id

Remove a quota adjustment.

### POST /admin/quota/reset

Reset daily counters (clears used counts, not limits or adjustments).

```json
{"scope": "device", "ip": "192.168.0.10", "date": "2026-09-26", "resource_id": "<rid>"}
```

For `scope=group`: use `group_id`. Omit `resource_id` to reset all resources.

Returns: `{"rows_cleared": 1}`

---

## Audit Log

### GET /admin/audit

Query params: `admin_token_id`, `method`, `path_prefix`, `from` (unix ts), `to`, `limit`, `offset`.

```json
{
  "entries": [
    {
      "id": 42, "ts": 1727000000, "admin_token_id": "<tid>",
      "admin_token_name": "bootstrap", "method": "POST",
      "path": "/admin/resources", "response_status": 201, "ip": "127.0.0.1"
    }
  ],
  "total": 100
}
```

### GET /admin/audit/:id

Full audit entry including `request_body` (sensitive fields redacted).

---

## Internal API (localhost only)

These endpoints are called by the captive portal and are restricted to `127.0.0.1`/`::1`.

### GET /internal/group-by-tier/:tier

Portal calls this at startup to resolve tier names to group UUIDs. Result is cached by the portal.

```json
{"group_id": "<uuid>"}
```

Returns 404 if no group with that `network_tier` exists.

### POST /internal/session-created

Portal calls on user login.

```json
{
  "session_id": "<uuid>",
  "user_id": "portal-user",
  "group_id": "<uuid>",
  "ip": "192.168.0.10",
  "network_tier": "basic",
  "logged_in_at": 1727000000
}
```

If `user_id` is not found in the users table, the `portal-anon` sentinel user is used automatically.

### POST /internal/session-ended

Portal calls on user logout.

```json
{"session_id": "<uuid>", "logged_out_at": 1727000100}
```

### GET /internal/session/:ip

Check whether an IP has an active session.

```json
{"active": true, "session_id": "<uuid>"}
```

---

## ENS resolution (console)

The enforcer resolves identity from ENS rather than from its own user table. `ENSCA_WEB_URL` points
the proxy at the console; leave it unset to keep using the local `users` table.

### GET /api/ens/resolve?name=`<ens name>`

Served by the console, not the proxy. Reads the **contracts directly** for this one name — never
the indexer, and never the whole membership list.

That is deliberate. Searching a list and coming up empty is indistinguishable from "no such
membership", so an indexer outage or a branch missing from a fallback would answer `404` and be
read as a deny — silently locking people off the network. Resolving one name against the chain has
no partial-answer state: it either finds a live membership or the chain says there is none, and a
failed read throws so the route answers `502` and the caller falls back.

The indexer is used for the console's list views, where a stale or incomplete answer is a cosmetic
problem rather than an access-control one.

```json
{
  "name": "marco.osaka.ethglobal2.eth",
  "owner": "0xd3b0...14d9",
  "branch": "osaka.ethglobal2.eth",
  "role": "mentor",
  "entitlements": { "wifi.group": "mentor", "wifi.rate": "20mbps", "wifi.ceil": "100mbps" },
  "source": "chain"
}
```

`404 no_membership` means the name holds no live membership — a definite deny. `502` means the
lookup could not be performed, which is **not** a deny: the caller should fall back.

### GET /internal/ens-lookup/`<name>` — behaviour change

Now asks the console first and maps the published `wifi.group` through the local `groups` table:

| Console says | Proxy returns |
|---|---|
| a group this enforcer runs | `200` with that group's id and tier, `source: "ens"` |
| a group it does not run | `404 unknown_group` — denying beats guessing |
| `404` (no membership) | `404`, `source: "ens"` |
| unreachable / `ENSCA_WEB_URL` unset | falls back to the local table, `source: "local"` |

The split is deliberate: **ENS is the authority on which group a person belongs to; the enforcer is
the authority on what that group means on its network** — tier, VLAN, quota. So an organization can
change someone's group on-chain without the enforcer being reconfigured, and an enforcer can change
what a group is worth locally without touching ENS.
