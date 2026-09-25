# Monitoring & Usage Analytics

## Current Implementation

All monitoring goes through the proxy control plane API. No separate dashboard service yet — queries hit the proxy REST API directly.

### What Gets Tracked

| Signal | Source | Granularity |
|---|---|---|
| Session start/end | Portal → proxy internal API | Per session, per IP |
| Proxy requests | Proxy `usage_events` table | Per request: method, path, status, bytes, duration |
| Daily device counters | `daily_counters` table | Per device per resource per day |
| Daily group counters | `daily_group_counters` table | Per group per resource per day |
| Admin control plane writes | `audit_log` table | Every write with token identity |

### Proxy API Endpoints for Analytics

All require `Authorization: Bearer <admin_token>`.

**Raw event log:**
```
GET /admin/usage?date=2026-09-26&resource_id=<rid>&group_id=<gid>&ip=<ip>
```

**Daily summary (aggregated by group+resource):**
```
GET /admin/usage/summary?from=2026-09-01&to=2026-09-26
```

**Top consumers:**
```
GET /admin/usage/top-consumers?scope=device&metric=count&date=2026-09-26&limit=10
GET /admin/usage/top-consumers?scope=group&metric=resp_bytes
```

**CSV export:**
```
GET /admin/usage/export?from=2026-09-01&to=2026-09-26
```
Returns streaming CSV: `id,ts,ip,username,group,resource,method,path,status,req_bytes,resp_bytes,duration_ms,upstream_error`

**Device's own usage (no admin token — authenticated by active session IP):**
```
GET /usage/me
```

### Live Session Monitoring

```
GET /admin/sessions?active=true
```

Returns all active sessions with: session ID, user, group, IP, network tier, login timestamp.

```
GET /status
```

Returns: DB status, active session count, total/enabled resource count.

### Quota Monitoring

```
GET /admin/quota?scope=device&ip=<ip>&resource_id=<rid>&date=2026-09-26
GET /admin/quota?scope=group&group_id=<gid>&resource_id=<rid>&date=2026-09-26
```

Returns: base limit, total adjustments, effective limit, used, remaining.

---

## Future: Organizer Dashboard

A Next.js dashboard polling the proxy API every 10s, showing:
- Live session count by group
- Bandwidth in/out (from FreeRADIUS accounting, Phase 3)
- Top consumers by request count and bytes
- RPC quota warnings (>80% used)
- Anomaly alerts (excessive bandwidth, auth failure floods)

---

## Audit Log

Every admin control plane write is recorded:

```
GET /admin/audit?method=POST&path_prefix=/admin/resources&from=1700000000&to=1800000000
GET /admin/audit/<id>
```

Each entry: timestamp, admin token identity, HTTP method, path, request body (sensitive fields redacted), response status, source IP.
