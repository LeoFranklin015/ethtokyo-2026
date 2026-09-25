# Developer Tools Layer

## Current Implementation

The resource proxy (`proxy/proxy.py`) is the developer tools gateway. It proxies API requests to upstream services, enforces per-group access control and daily rate limits, and injects API keys server-side.

**Running resources on demo VM:**
- Alchemy Sepolia RPC: `GET/POST /proxy/alchemy-sepolia/<path:subpath>`
- Alchemy Mainnet RPC: `GET/POST /proxy/alchemy-mainnet/<path:subpath>`

More resources can be added via `POST /admin/resources`.

---

## How the Proxy Works

1. Request arrives at `/proxy/<slug>/...`
2. Proxy looks up active session for the requesting IP
3. Checks `group_resource_limits` — deny if no row exists for (group, resource)
4. Checks daily counters — deny 429 if per-device or per-group limit exceeded
5. Forwards to `upstream_url`, injecting `api_key` via `url_path` or `header` placement
6. Records usage event (method, path, status, bytes, duration)
7. Returns upstream response

API key is never exposed to the client — the proxy injects it server-side.

---

## Key Rotation

Zero-downtime rotation via stage + commit:

```bash
# Stage new key (does not activate yet):
PATCH /admin/resources/<rid>/rotate-key
{"new_key": "alch_new_key_here"}

# Commit (atomically swaps api_key = api_key_pending, clears pending):
POST /admin/resources/<rid>/commit-key

# Discard staged key if rotation cancelled:
DELETE /admin/resources/<rid>/pending-key
```

---

## Rate Limiting

Two-level check per request:
- **Per-device daily limit** (`per_device_per_day` in `group_resource_limits`)
- **Per-group daily limit** (`group_per_day`)

NULL = unlimited. Counters reset at UTC midnight.

Quota adjustments add top-ups for the current day without changing the base limit:

```bash
POST /admin/quota/adjust
{"scope": "device", "ip": "192.168.0.10", "resource_id": "<rid>", "amount": 100}
```

---

## Future: At-Mint Provisioning (Phase 4)

When ENS-native auth is live:
- Subname mint triggers provisioning of personal API keys per sponsor service
- Role determines quota tier (hacker: 10k/day, mentor: 50k/day, etc.)
- Keys served via proxy — real key never exposed to client
- Usage tracked per ENS subname, not per IP
