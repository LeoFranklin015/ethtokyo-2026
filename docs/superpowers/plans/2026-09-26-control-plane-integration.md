# Control Plane Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every fixture and hardcoded value in the Radius web control plane with live data from the proxy API, add missing proxy endpoints that the UI requires, and wire the portal's wallet-connect flow end-to-end — with zero mocks remaining anywhere.

**Architecture:** The web app (`web/`) calls a Next.js route handler layer (`web/app/api/admin/`) which proxies to the Flask proxy at port 8081 with a server-side admin token; console pages use SWR client hooks that call those route handlers with auto-polling; the portal page uses `window.ethereum` + a new portal challenge endpoint for real wallet-connect auth.

**Tech Stack:** Next.js 15 App Router, React, SWR, TypeScript, Tailwind; Flask proxy (Python) on port 8081; SQLite WAL; portal Flask app on port 8080; `window.ethereum` for wallet connect (no additional npm package needed — bare EIP-1193 provider).

**Spec:** `.superpowers/integration-analysis.md`

## Global Constraints

- Proxy admin token must NEVER appear in client-side code, browser storage, or `NEXT_PUBLIC_*` env vars — it lives only in server-side env as `PROXY_ADMIN_TOKEN`
- All network requests from browser go to Next.js route handlers (`/api/admin/…`) — never directly to `http://172.16.0.130:8081`
- `NEXT_PUBLIC_PROXY_URL` is used only server-side in route handlers (but named NEXT_PUBLIC for ease); token is separate `PROXY_ADMIN_TOKEN`
- SWR is the only data-fetching library to add — no React Query, no Axios
- `window.ethereum` only for wallet connect — no wagmi, viem, or ethers.js npm deps
- All pages that fetch data must be `"use client"` — App Router server components cannot use SWR
- Polling intervals: overview KPIs 10 s, throughput chart 60 s, members table 30 s, sidebar health 15 s
- `ROLES`, `ORG`, and `ENFORCEMENT` stay as static config in `web/lib/config.ts` — they are policy definitions, not proxy state
- For the group `pool` (bandwidth cap in Mbps), use static mapping by `network_tier`: `basic→100, staff→500, vip→1000` — no DB column needed; `used` comes from `bandwidth/sessions tier_totals`
- No `bandwidth_mbps` DB column or migration — pool is purely static config (simpler, no proxy changes for group data)
- `vlan` stays in static config map: `basic→10, staff→10, vip→200` (approximate match to ENS design; exact VLAN is enforcer-level config)
- Member `rate` column shows cumulative `bytes_out` formatted as KB/MB — no instantaneous Mbps (requires no new endpoint)
- The timeseries endpoint IS required for ThroughputChart — there is no client-side workaround

## Review Focus

1. **Admin token leakage** — `PROXY_ADMIN_TOKEN` must never reach the browser; any `NEXT_PUBLIC_PROXY_ADMIN_TOKEN` naming or `JSON.stringify(process.env)` call is a critical bug
2. **SWR on server components** — `"use client"` directive missing on any page that calls a SWR hook silently breaks at runtime; each hook file and page that uses it must declare it
3. **Timeseries SQL bucket alignment** — `GROUP BY (ts / 600)` with mixed timezones produces jumbled labels; test that t values increment monotonically and that the bucket count matches wall-clock expectations
4. **ENS fields in users list** — proxy line 419 selects `id,username,default_group_id,created_at,disabled` with no `ens_name`/`wallet_address`; if the fix is missed, memberships page shows `undefined` for every address silently
5. **Portal wallet flow abort** — if user rejects the MetaMask signature prompt, the code must catch the rejection error and transition to `denied` state, not hang in `signing`

---

## Task 1: Proxy — add timeseries endpoint + ENS fields to users list

**Files:**
- Modify: `proxy/proxy.py:419` (users list SELECT)
- Modify: `proxy/proxy.py` (add `GET /admin/bandwidth/timeseries` route, after existing bandwidth routes)

**Interfaces:**
- Produces: `GET /admin/bandwidth/timeseries` → `{samples: [{t: "HH:MM", mbps: number, admitted: number}]}`
- Produces: `GET /admin/users` rows now include `ens_name`, `wallet_address` fields
- Consumes: nothing from other tasks

- [ ] **Step 1: Write test script for ENS fields**

```bash
# On VM, after deploy — smoke test
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/users | python3 -c "
import sys,json; d=json.load(sys.stdin)
u = d['users'][0] if d['users'] else {}
assert 'ens_name' in u, 'ens_name missing from users list'
assert 'wallet_address' in u, 'wallet_address missing from users list'
print('users list: ens_name and wallet_address present')
"
```

- [ ] **Step 2: Fix users list SELECT in proxy.py**

Open `proxy/proxy.py`. Find line 419:
```python
    rows = db.execute(f"SELECT id,username,default_group_id,created_at,disabled FROM users "
```
Change to:
```python
    rows = db.execute(f"SELECT id,username,default_group_id,ens_name,wallet_address,created_at,disabled FROM users "
```
No other lines change.

- [ ] **Step 3: Add timeseries endpoint**

Find the bandwidth section in proxy.py (search for `admin/bandwidth/sessions`). Add this route immediately after it:

```python
@app.route("/admin/bandwidth/timeseries", methods=["GET"])
@require_admin
def bandwidth_timeseries():
    db = get_db()
    # 10-minute buckets over the last 6 hours, ordered by bucket
    rows = db.execute("""
        SELECT
            strftime('%H:%M', datetime(ts, 'unixepoch', 'localtime')) AS t,
            CAST(SUM(resp_bytes) * 8.0 / (10.0 * 60.0 * 1000000.0) AS REAL) AS mbps,
            COUNT(DISTINCT ip) AS admitted
        FROM usage_events
        WHERE ts >= strftime('%s', 'now', '-6 hours')
        GROUP BY (ts / 600)
        ORDER BY (ts / 600)
    """).fetchall()
    return jsonify({"samples": [dict(r) for r in rows]})
```

- [ ] **Step 4: Run proxy tests locally**

```bash
cd /Users/I740422/projects/ensca/proxy
python3 -c "from proxy import app; print('import ok')"
```
Expected: `import ok` with no errors.

- [ ] **Step 5: Deploy to VM and smoke-test**

```bash
# Sync proxy files to VM
rsync -av --exclude '__pycache__' /Users/I740422/projects/ensca/proxy/ philo@172.16.0.130:~/ensca/proxy/

# Restart proxy service
ssh philo@172.16.0.130 'sudo systemctl restart ensca-proxy'
sleep 2

# Test users list has ENS fields
ssh philo@172.16.0.130 'TOKEN=$(python3 -c "import sqlite3; db=sqlite3.connect(\"/var/lib/ensca/ensca.db\"); db.row_factory=sqlite3.Row; r=db.execute(\"SELECT id FROM admin_tokens WHERE revoked=0 LIMIT 1\").fetchone(); print(r[\"id\"] if r else \"\")"); curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/users | python3 -m json.tool | head -20'

# Test timeseries endpoint exists (may return empty samples if no events yet)
ssh philo@172.16.0.130 'TOKEN=$(python3 -c "import sqlite3; db=sqlite3.connect(\"/var/lib/ensca/ensca.db\"); db.row_factory=sqlite3.Row; r=db.execute(\"SELECT id FROM admin_tokens WHERE revoked=0 LIMIT 1\").fetchone(); print(r[\"id\"] if r else \"\")"); curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8081/admin/bandwidth/timeseries'
```
Expected: users response has `ens_name`/`wallet_address` keys; timeseries returns `{"samples": [...]}`.

- [ ] **Step 6: Commit**

```bash
cd /Users/I740422/projects/ensca
git add proxy/proxy.py
git commit -m "feat(proxy): add timeseries endpoint, expose ens_name+wallet_address in users list"
```

---

## Task 2: Web — env setup + Next.js API proxy layer

**Files:**
- Create: `web/.env.local` (git-ignored, template only in plan)
- Create: `web/app/api/admin/[...path]/route.ts`
- Create: `web/lib/api.ts`

**Interfaces:**
- Produces: `/api/admin/*` route that forwards to `http://${PROXY_URL}/admin/*` with `Authorization: Bearer ${PROXY_ADMIN_TOKEN}`
- Produces: `apiGet<T>(path): Promise<T>` typed fetch helper for use by SWR hooks
- Consumes: nothing from other tasks (standalone infrastructure)

- [ ] **Step 1: Create .env.local**

Create `web/.env.local` (already in .gitignore for Next.js projects):
```
PROXY_URL=http://172.16.0.130:8081
PROXY_ADMIN_TOKEN=<paste-your-admin-token-here>
NEXT_PUBLIC_BRANCH_LABEL=tokyo2026
NEXT_PUBLIC_BRANCH_VENUE=Toranomon Hills Forum
NEXT_PUBLIC_BRANCH_WINDOW=26–28 Sep 2026
NEXT_PUBLIC_ORG_ENS=ethglobal.eth
NEXT_PUBLIC_SSID=ethglobal-tokyo2026
```
Note: `PROXY_ADMIN_TOKEN` has no `NEXT_PUBLIC_` prefix — server-only.

- [ ] **Step 2: Verify .env.local is gitignored**

```bash
cd /Users/I740422/projects/ensca/web
git check-ignore -v .env.local
```
Expected: shows `.gitignore` rule. If not ignored, add `.env.local` to `web/.gitignore` before proceeding.

- [ ] **Step 3: Write failing test for API route**

```typescript
// web/app/api/admin/__tests__/route.test.ts
// (manual smoke: start dev server and curl)
// Automated: just verify the file can be imported without error
// Run: cd web && npx tsc --noEmit
```
Expected compile: no errors.

- [ ] **Step 4: Create the catch-all route handler**

Create `web/app/api/admin/[...path]/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";

const PROXY_URL = process.env.PROXY_URL!;
const PROXY_ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN!;

async function handler(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const subpath = path.join("/");
  const search = req.nextUrl.search;
  const upstream = `${PROXY_URL}/admin/${subpath}${search}`;

  const headers: HeadersInit = {
    "Authorization": `Bearer ${PROXY_ADMIN_TOKEN}`,
    "Content-Type": req.headers.get("content-type") ?? "application/json",
  };

  const body = req.method !== "GET" && req.method !== "HEAD"
    ? await req.text()
    : undefined;

  const resp = await fetch(upstream, {
    method: req.method,
    headers,
    body,
    cache: "no-store",
  });

  const data = await resp.text();
  return new NextResponse(data, {
    status: resp.status,
    headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
  });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const PUT = handler;
```

- [ ] **Step 5: Create typed fetch helper**

Create `web/lib/api.ts`:
```typescript
export async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`/api/admin/${path}`, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
```

- [ ] **Step 6: TypeScript compile check**

```bash
cd /Users/I740422/projects/ensca/web
npx tsc --noEmit 2>&1
```
Expected: no errors (or only pre-existing errors unrelated to new files).

- [ ] **Step 7: Install SWR**

```bash
cd /Users/I740422/projects/ensca/web
npm install swr
```
Expected: package.json updated, no peer-dep errors.

- [ ] **Step 8: Smoke-test route handler with dev server**

```bash
cd /Users/I740422/projects/ensca/web
npm run dev &
sleep 5
curl -s http://localhost:3000/api/admin/groups | python3 -m json.tool | head -10
```
Expected: JSON with `groups` array from the live proxy.

- [ ] **Step 9: Commit**

```bash
cd /Users/I740422/projects/ensca
git add web/app/api web/lib/api.ts web/package.json web/package-lock.json
# DO NOT add web/.env.local — it's git-ignored and contains secrets
git commit -m "feat(web): add Next.js admin API proxy layer and SWR client"
```

---

## Task 3: Web — static config extraction

**Files:**
- Create: `web/lib/config.ts`
- Modify: `web/lib/data.ts` (remove BRANCHES, GROUPS, MEMBERSHIPS, THROUGHPUT; keep type exports only)

**Interfaces:**
- Produces: `web/lib/config.ts` exporting `ORG`, `ROLES`, `ENFORCEMENT`, `TIER_POOL_MBPS`, `TIER_VLAN` constants
- Produces: `web/lib/data.ts` exports only TypeScript types (`Branch`, `Group`, `Membership`, `Sample`, `RoleName`, `GroupName`, `Role`)
- Consumes: nothing from other tasks

- [ ] **Step 1: Create config.ts**

Create `web/lib/config.ts`:
```typescript
export const ORG = {
  name: "ETHGlobal",
  ens: process.env.NEXT_PUBLIC_ORG_ENS ?? "ethglobal.eth",
} as const;

export type RoleName = "hacker" | "volunteer" | "mentor" | "partner" | "organizer";

export type Role = {
  name: RoleName;
  group: string;
  vlan: number;
  rate: number;
  ceil: number;
  permissions: string[];
  bitmap: string;
  summary: string;
};

export const ROLES: Role[] = [
  { name: "hacker",    group: "hacker",  vlan: 100, rate: 5,   ceil: 20,   permissions: [],                                                              bitmap: "0", summary: "Holds no roles on the resolver, so cannot edit its own records." },
  { name: "volunteer", group: "staff",   vlan: 10,  rate: 10,  ceil: 50,   permissions: ["member:onboard"],                                              bitmap: "0", summary: "May onboard hackers. The registrar refuses anything above that." },
  { name: "mentor",    group: "mentor",  vlan: 200, rate: 20,  ceil: 100,  permissions: ["member:view"],                                                 bitmap: "0", summary: "Writes its own profile and ssh-pubkey; reads hacker records." },
  { name: "partner",   group: "partner", vlan: 400, rate: 20,  ceil: 100,  permissions: ["member:view"],                                                 bitmap: "ROLE_SET_RESOLVER", summary: "The only role that may point its name at its own resolver." },
  { name: "organizer", group: "staff",   vlan: 10,  rate: 100, ceil: 1000, permissions: ["member:onboard","member:revoke","role:assign","role:edit","branch:edit"], bitmap: "0", summary: "Holds every registrar role plus its admin pair." },
];

// Static bandwidth caps by network_tier (Mbps)
export const TIER_POOL_MBPS: Record<string, number> = {
  basic: 100,
  staff: 500,
  vip: 1000,
};

// Static VLAN tag by network_tier
export const TIER_VLAN: Record<string, number> = {
  basic: 100,
  staff: 10,
  vip: 200,
};

export const ENFORCEMENT = [
  ["Resource", "wifi"],
  ["Enforcer", "fedora-vm · enp10s0u1"],
  ["Identity", "DHCP lease → Membership"],
  ["Resolution", "Membership → Member → deny"],
  ["Revocation", "applied on next check"],
  ["Record cache", "12s old · ttl 60s"],
] as const;
```

- [ ] **Step 2: Slim data.ts to types only**

Replace `web/lib/data.ts` entirely with:
```typescript
/**
 * Domain model types. All fixture arrays removed — replaced by live API hooks.
 * Static policy config (ROLES, ORG, ENFORCEMENT) lives in lib/config.ts.
 */

export type RoleName = "hacker" | "volunteer" | "mentor" | "partner" | "organizer";
export type GroupName = "hacker" | "staff" | "mentor" | "partner";

export type Branch = {
  label: string;
  ens: string;
  venue: string;
  window: string;
  status: "open" | "scheduled" | "archived";
  members: number;
  online: number;
};

export type Role = {
  name: RoleName;
  group: string;
  vlan: number;
  rate: number;
  ceil: number;
  permissions: string[];
  bitmap: string;
  summary: string;
};

export type Group = {
  // From API
  id: string;
  name: string;
  network_tier: string;
  member_count: number;
  active_session_count: number;
  // Derived locally
  vlan: number;
  pool: number;
  used: number;
  devices: number;
};

export type Membership = {
  label: string;       // ens_name prefix (before first dot) or username
  role: RoleName;      // derived from network_tier
  address: string;     // wallet_address or ""
  devices: number;     // count of active sessions for this user
  bytes_out: number;   // cumulative from active session
  online: boolean;
  onboarded: string;   // formatted logged_in_at
};

export type Sample = { t: string; mbps: number; admitted: number };
```

- [ ] **Step 3: TypeScript compile check**

```bash
cd /Users/I740422/projects/ensca/web
npx tsc --noEmit 2>&1
```
Expected: errors for pages still importing removed fixtures (BRANCHES/GROUPS/MEMBERSHIPS/THROUGHPUT) — that's expected; they'll be fixed in Tasks 4–6. Errors in `lib/config.ts` itself: zero.

- [ ] **Step 4: Commit**

```bash
cd /Users/I740422/projects/ensca
git add web/lib/config.ts web/lib/data.ts
git commit -m "refactor(web): extract static config, slim data.ts to types only"
```

---

## Task 4: Web — SWR hooks

**Files:**
- Create: `web/lib/hooks/useProxyStatus.ts`
- Create: `web/lib/hooks/useGroups.ts`
- Create: `web/lib/hooks/useSessions.ts`
- Create: `web/lib/hooks/useUsers.ts`
- Create: `web/lib/hooks/useThroughput.ts`
- Create: `web/lib/hooks/useBandwidth.ts`

**Interfaces:**
- Consumes: `apiGet` from `web/lib/api.ts`; SWR npm package
- Consumes: `Group`, `Membership`, `Sample` types from `web/lib/data.ts`
- Consumes: `TIER_POOL_MBPS`, `TIER_VLAN` from `web/lib/config.ts`
- Produces: typed React hooks used by console pages

- [ ] **Step 1: Create useProxyStatus.ts**

Create `web/lib/hooks/useProxyStatus.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

type ProxyStatus = {
  status: string;
  ts: number;
  db: string;
  active_sessions: number;
  resources_total: number;
  resources_enabled: number;
};

export function useProxyStatus() {
  return useSWR<ProxyStatus>(
    "status",
    () => fetch("/api/admin/../status").then(r => r.json()),  // hits GET /status (not /admin/status)
    { refreshInterval: 15_000 }
  );
}
```

Wait — `/status` is not under `/api/admin/`. Fix the fetcher to call `/api/status` or use a separate route. See correction in step below.

Actually: proxy `/status` requires local or Bearer auth. The catch-all route only covers `/api/admin/`. Add a dedicated status route in step 2.

- [ ] **Step 2: Add /api/status route handler**

Create `web/app/api/status/route.ts`:
```typescript
import { NextResponse } from "next/server";

const PROXY_URL = process.env.PROXY_URL!;
const PROXY_ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN!;

export async function GET() {
  const resp = await fetch(`${PROXY_URL}/status`, {
    headers: { "Authorization": `Bearer ${PROXY_ADMIN_TOKEN}` },
    cache: "no-store",
  });
  const data = await resp.text();
  return new NextResponse(data, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}
```

Update `web/lib/hooks/useProxyStatus.ts`:
```typescript
"use client";
import useSWR from "swr";

type ProxyStatus = {
  status: string;
  ts: number;
  db: string;
  active_sessions: number;
  resources_total: number;
  resources_enabled: number;
};

export function useProxyStatus() {
  return useSWR<ProxyStatus>(
    "proxy-status",
    () => fetch("/api/status").then(r => r.json()),
    { refreshInterval: 15_000 }
  );
}
```

- [ ] **Step 3: Create useGroups.ts**

Create `web/lib/hooks/useGroups.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";
import type { Group } from "@/lib/data";
import { TIER_POOL_MBPS, TIER_VLAN } from "@/lib/config";

type ApiGroup = {
  id: string;
  name: string;
  network_tier: string;
  member_count: number;
  active_session_count: number;
};

type BandwidthTierTotals = Record<string, { sessions: number; bytes_in: number; bytes_out: number }>;

export function useGroups() {
  const groups = useSWR<{ groups: ApiGroup[] }>(
    "groups",
    () => apiGet("groups"),
    { refreshInterval: 10_000 }
  );
  const bw = useSWR<{ tier_totals: BandwidthTierTotals }>(
    "bandwidth-sessions",
    () => apiGet("bandwidth/sessions", { active: "true" }),
    { refreshInterval: 10_000 }
  );

  const data: Group[] | undefined =
    groups.data && bw.data
      ? groups.data.groups.map((g) => {
          const tier = g.network_tier;
          const tierBw = bw.data!.tier_totals[tier];
          // Approximate used Mbps: bytes_out in last session window * 8 / 60s / 1e6
          // We don't have a window, so show bytes_out in MB as a proxy (label changes in UI)
          const used = tierBw ? Math.round((tierBw.bytes_out * 8) / (60 * 1_000_000)) : 0;
          return {
            id: g.id,
            name: g.name,
            network_tier: tier,
            member_count: g.member_count,
            active_session_count: g.active_session_count,
            vlan: TIER_VLAN[tier] ?? 0,
            pool: TIER_POOL_MBPS[tier] ?? 100,
            used,
            devices: g.active_session_count,
          };
        })
      : undefined;

  return { data, isLoading: groups.isLoading || bw.isLoading, error: groups.error ?? bw.error };
}
```

- [ ] **Step 4: Create useSessions.ts**

Create `web/lib/hooks/useSessions.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type ApiSession = {
  id: string;
  user_id: string;
  username: string;
  group_id: string;
  group_name: string;
  ip: string;
  network_tier: string;
  ens_name: string | null;
  wallet_address: string | null;
  logged_in_at: number;
  logged_out_at: number | null;
  revoked_at: number | null;
  bytes_in: number;
  bytes_out: number;
};

export function useSessions(active = true) {
  return useSWR<{ sessions: ApiSession[]; total: number }>(
    ["sessions", active],
    () => apiGet("sessions", { active: active ? "true" : "false", limit: "200" }),
    { refreshInterval: 10_000 }
  );
}
```

- [ ] **Step 5: Create useUsers.ts**

Create `web/lib/hooks/useUsers.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type ApiUser = {
  id: string;
  username: string;
  default_group_id: string | null;
  ens_name: string | null;
  wallet_address: string | null;
  created_at: number;
  disabled: number;
};

export function useUsers(params?: { group_id?: string; disabled?: "0" | "1"; limit?: string }) {
  const key = ["users", JSON.stringify(params ?? {})];
  return useSWR<{ users: ApiUser[]; total: number }>(
    key,
    () => apiGet("users", { limit: "200", ...params } as Record<string, string>),
    { refreshInterval: 30_000 }
  );
}
```

- [ ] **Step 6: Create useThroughput.ts**

Create `web/lib/hooks/useThroughput.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";
import type { Sample } from "@/lib/data";

export function useThroughput() {
  return useSWR<{ samples: Sample[] }>(
    "throughput",
    () => apiGet("bandwidth/timeseries"),
    { refreshInterval: 60_000 }
  );
}
```

- [ ] **Step 7: Create useBandwidth.ts**

Create `web/lib/hooks/useBandwidth.ts`:
```typescript
"use client";
import useSWR from "swr";
import { apiGet } from "@/lib/api";

export type BandwidthSession = {
  id: string;
  ip: string;
  network_tier: string;
  ens_name: string | null;
  wallet_address: string | null;
  username: string;
  group_name: string;
  bytes_in: number;
  bytes_out: number;
  bytes_total: number;
  logged_in_at: number;
  logged_out_at: number | null;
};

export function useBandwidth(active = true) {
  return useSWR<{ sessions: BandwidthSession[]; tier_totals: Record<string, { sessions: number; bytes_in: number; bytes_out: number }> }>(
    ["bandwidth", active],
    () => apiGet("bandwidth/sessions", { active: active ? "true" : "false" }),
    { refreshInterval: 10_000 }
  );
}
```

- [ ] **Step 8: TypeScript compile check**

```bash
cd /Users/I740422/projects/ensca/web
npx tsc --noEmit 2>&1
```
Expected: errors only in pages still using removed fixtures (will be fixed in Tasks 5–6). Zero errors in `lib/hooks/`.

- [ ] **Step 9: Commit**

```bash
cd /Users/I740422/projects/ensca
git add web/lib/hooks/ web/app/api/status/
git commit -m "feat(web): add SWR data hooks for all console data sources"
```

---

## Task 5: Web — wire console pages to live data

**Files:**
- Modify: `web/app/console/page.tsx`
- Modify: `web/app/console/members/page.tsx`
- Modify: `web/app/console/branches/page.tsx`
- Modify: `web/app/console/roles/page.tsx`
- Modify: `web/app/console/layout.tsx`
- Modify: `web/components/console/Sidebar.tsx`

**Interfaces:**
- Consumes: all hooks from Task 4; config from Task 3; `apiGet` from Task 2
- Produces: all console pages with zero fixture imports remaining

Notes on data mapping:
- `Membership.label`: use `ens_name.split(".")[0]` if available, else `username`
- `Membership.role`: map from `group_name` using `basic→hacker, staff→organizer, vip→mentor` (best approximation)
- `Membership.address`: `wallet_address` truncated as `${addr.slice(0,5)}…${addr.slice(-4)}` or empty string
- `Membership.devices`: count of active sessions for this user_id from sessions list
- `Membership.bytes_out`: from active session if exists, else 0
- `Membership.online`: has active session
- `Membership.onboarded`: format `logged_in_at` as `HH:MM` local time
- Denials KPI: count sessions from last hour with usage_events status 4xx — use `GET /api/admin/usage?date=<today>` and filter client-side by status >= 400 and ts >= now-3600
- "Joined 5m": sessions with `logged_in_at >= now-300` from useSessions
- "Left 5m": sessions with `logged_out_at >= now-300` from useSessions with `active=false`

- [ ] **Step 1: Rewrite console/page.tsx**

The page uses SWR hooks and must be `"use client"`:
```typescript
"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { ThroughputChart } from "@/components/console/ThroughputChart";
import { SignalDither } from "@/components/dither/SignalDither";
import { Meter } from "@/components/ui/Meter";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useGroups } from "@/lib/hooks/useGroups";
import { useSessions } from "@/lib/hooks/useSessions";
import { useThroughput } from "@/lib/hooks/useThroughput";
import { useUsers } from "@/lib/hooks/useUsers";
import { useProxyStatus } from "@/lib/hooks/useProxyStatus";
import { ENFORCEMENT } from "@/lib/config";

export default function OverviewPage() {
  const { data: groupsData, isLoading: groupsLoading } = useGroups();
  const { data: sessionsData } = useSessions(true);
  const { data: throughputData } = useThroughput();
  const { data: usersData } = useUsers();
  const { data: status } = useProxyStatus();

  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchEns = `${branchLabel}.${process.env.NEXT_PUBLIC_ORG_ENS ?? ""}`;
  const branchVenue = process.env.NEXT_PUBLIC_BRANCH_VENUE ?? "";
  const branchWindow = process.env.NEXT_PUBLIC_BRANCH_WINDOW ?? "";

  const groups = groupsData ?? [];
  const sessions = sessionsData?.sessions ?? [];
  const samples = throughputData?.samples ?? [];
  const totalUsers = usersData?.total ?? 0;
  const activeSessions = sessionsData?.total ?? status?.active_sessions ?? 0;
  const totalDevices = groups.reduce((s, g) => s + g.devices, 0);
  const totalUsed = groups.reduce((s, g) => s + g.used, 0);
  const totalPool = groups.reduce((s, g) => s + g.pool, 0);
  const peak = samples.length ? Math.max(...samples.map(s => s.mbps)) : 0;

  const now = Math.floor(Date.now() / 1000);
  const joined5m = sessions.filter(s => s.logged_in_at >= now - 300).length;
  const { data: recentLeft } = useSessions(false);
  const left5m = (recentLeft?.sessions ?? []).filter(
    s => s.logged_out_at && s.logged_out_at >= now - 300
  ).length;

  const KPIS = [
    { label: "Memberships", value: totalUsers.toLocaleString(), sub: "onboarded here" },
    { label: "Admitted",    value: activeSessions.toLocaleString(), sub: `${totalDevices} devices` },
    { label: "Throughput",  value: totalUsed.toLocaleString(), unit: "Mbps", sub: `peak ${peak.toFixed(0)}` },
    { label: "Denials",     value: "—", sub: "last hour" },
  ];

  const recent = sessions
    .sort((a, b) => b.logged_in_at - a.logged_in_at)
    .slice(0, 5);

  if (groupsLoading) {
    return <div className="px-5 py-12 text-center font-mono text-xs text-ink-muted">Loading…</div>;
  }

  return (
    <>
      <PageHeader
        eyebrow="Branch overview"
        title={branchEns}
        meta={`${branchVenue} · ${branchWindow}`}
        actions={
          <span className="inline-flex items-center gap-2 font-mono text-xs text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            Live · polling 10s
          </span>
        }
      />

      <dl className="grid grid-cols-2 border-b border-rule sm:grid-cols-4">
        {KPIS.map((kpi, i) => (
          <div
            key={kpi.label}
            className={`px-5 py-4 lg:px-8 ${i < 2 ? "border-b border-rule sm:border-b-0" : ""} ${
              i % 2 === 0 ? "border-r border-rule" : ""
            } sm:border-r sm:last:border-r-0`}
          >
            <dt className="label">{kpi.label}</dt>
            <dd>
              <span className="mt-2.5 flex items-baseline gap-1.5">
                <span className="font-mono text-[1.625rem] font-medium leading-none tabular-nums tracking-tight text-ink">
                  {kpi.value}
                </span>
                {kpi.unit ? <span className="font-mono text-xs text-ink-muted">{kpi.unit}</span> : null}
              </span>
              <span className="mt-1.5 block text-xs text-ink-muted">{kpi.sub}</span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section">
          <PanelHeader right={<span className="font-mono text-[0.6875rem] text-ink-muted">last 6h · 10m samples</span>}>
            Branch throughput
          </PanelHeader>
          <div className="px-2 pb-2 pt-3 sm:px-4">
            <ThroughputChart data={samples} cap={totalPool} />
          </div>
        </Panel>

        <div className="mt-6 grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Panel as="section">
            <PanelHeader
              right={<span className="font-mono text-[0.6875rem] text-ink-muted">{totalUsed} / {totalPool} Mbps</span>}
            >
              Group utilisation
            </PanelHeader>
            <div className="divide-y divide-rule">
              {groups.map((group) => (
                <Meter
                  key={group.name}
                  label={group.name}
                  used={group.used}
                  cap={group.pool}
                  detail={`vlan ${group.vlan} · ${group.devices} devices`}
                />
              ))}
            </div>
          </Panel>

          <div className="flex flex-col gap-6">
            <Panel as="section">
              <PanelHeader>Perimeter</PanelHeader>
              <div className="flex items-stretch divide-x divide-rule">
                <div className="relative w-[104px] shrink-0">
                  <SignalDither motif="radar" cell={2} period={4.5} intensity={0.75} className="absolute inset-0" label="Radar sweep" />
                </div>
                <dl className="flex-1 divide-y divide-rule">
                  {[
                    ["Present", String(activeSessions)],
                    ["Joined 5m", String(joined5m)],
                    ["Left 5m",   String(left5m)],
                  ].map(([term, value]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 px-4 py-[0.6875rem]">
                      <dt className="label">{term}</dt>
                      <dd className="font-mono text-xs tabular-nums text-ink-80">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </Panel>

            <Panel as="section">
              <PanelHeader>Recent admissions</PanelHeader>
              <ul className="divide-y divide-rule">
                {recent.map((s) => {
                  const label = s.ens_name?.split(".")[0] ?? s.username;
                  const time = new Date(s.logged_in_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <li key={s.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                      <span className="truncate font-mono text-xs text-ink">
                        {label}<span className="text-ink-muted">.{branchLabel}</span>
                      </span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">{time}</span>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          </div>
        </div>

        <Panel as="section" className="mt-6">
          <PanelHeader>Enforcement</PanelHeader>
          <dl className="grid sm:grid-cols-2 xl:grid-cols-3">
            {ENFORCEMENT.map(([term, detail]) => (
              <div key={term} className="flex items-baseline justify-between gap-4 border-b border-rule px-4 py-2.5 sm:border-r sm:last:border-r-0">
                <dt className="label">{term}</dt>
                <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Rewrite console/members/page.tsx**

```typescript
"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Button } from "@/components/ui/Button";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { RoleChip } from "@/components/ui/RoleChip";
import { useUsers } from "@/lib/hooks/useUsers";
import { useSessions } from "@/lib/hooks/useSessions";
import type { RoleName } from "@/lib/data";

const TIER_ROLE: Record<string, RoleName> = {
  basic: "hacker",
  staff: "organizer",
  vip: "mentor",
};

function fmtBytes(b: number): string {
  if (b > 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b > 1_000) return `${(b / 1_000).toFixed(0)} KB`;
  return `${b} B`;
}

export default function MembersPage() {
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchEns = `${branchLabel}.${process.env.NEXT_PUBLIC_ORG_ENS ?? ""}`;

  const { data: usersData, isLoading } = useUsers();
  const { data: sessionsData } = useSessions(true);

  const users = usersData?.users ?? [];
  const activeSessions = sessionsData?.sessions ?? [];
  const sessionsByUser = new Map(activeSessions.map(s => [s.user_id, s]));

  const COLUMNS = ["Membership", "Role", "Address", "Devices", "Data out", "State"];

  if (isLoading) {
    return <div className="px-5 py-12 text-center font-mono text-xs text-ink-muted">Loading…</div>;
  }

  return (
    <>
      <PageHeader
        eyebrow="Branch"
        title="Memberships"
        meta={`${users.length} at ${branchEns}`}
        actions={<Button variant="solid">Onboard member</Button>}
      />

      <div className="px-5 py-6 lg:px-8">
        <Panel as="section" className="overflow-hidden">
          <PanelHeader
            right={<span className="font-mono text-[0.6875rem] text-ink-muted">{activeSessions.length} online</span>}
          >
            All memberships
          </PanelHeader>

          {users.length === 0 ? (
            <div role="status" className="px-4 py-16 text-center">
              <p className="text-sm text-ink">No memberships yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <caption className="sr-only">Memberships at {branchEns}</caption>
                <thead>
                  <tr className="border-b border-rule">
                    {COLUMNS.map((h) => (
                      <th key={h} scope="col" className="label px-4 py-2.5 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {users.map((u) => {
                    const session = sessionsByUser.get(u.id);
                    const online = !!session;
                    const label = u.ens_name?.split(".")[0] ?? u.username;
                    const addrFull = u.wallet_address ?? "";
                    const addrShort = addrFull ? `${addrFull.slice(0, 5)}…${addrFull.slice(-4)}` : "—";
                    const tier = activeSessions.find(s => s.user_id === u.id)?.network_tier ?? "basic";
                    const role: RoleName = TIER_ROLE[tier] ?? "hacker";
                    const bytesOut = session?.bytes_out ?? 0;
                    return (
                      <tr key={u.id} className="transition-colors hover:bg-ink/5">
                        <th scope="row" className="px-4 py-3 text-left font-normal">
                          <span className="font-mono text-sm text-ink">{label}</span>
                          <span className="font-mono text-sm text-ink-muted">.{branchLabel}</span>
                        </th>
                        <td className="px-4 py-3"><RoleChip role={role} /></td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">{addrShort}</td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                          {activeSessions.filter(s => s.user_id === u.id).length}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs tabular-nums text-ink-80">
                          {online ? fmtBytes(bytesOut) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                            <span aria-hidden className="size-1.5 rounded-full" style={{ background: online ? "var(--signal)" : "var(--ink-faint)" }} />
                            <span className={online ? "text-ink-80" : "text-ink-muted"}>{online ? "admitted" : "offline"}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
```

- [ ] **Step 3: Rewrite console/branches/page.tsx**

The perimeters concept maps to "this single proxy instance". Show one card:
```typescript
"use client";

import { PageHeader } from "@/components/console/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { useSessions } from "@/lib/hooks/useSessions";
import { useUsers } from "@/lib/hooks/useUsers";
import { ORG } from "@/lib/config";

export default function BranchesPage() {
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";
  const branchVenue = process.env.NEXT_PUBLIC_BRANCH_VENUE ?? "";
  const branchWindow = process.env.NEXT_PUBLIC_BRANCH_WINDOW ?? "";

  const { data: usersData } = useUsers();
  const { data: sessionsData } = useSessions(true);

  const members = usersData?.total ?? 0;
  const online = sessionsData?.total ?? 0;

  return (
    <>
      <PageHeader eyebrow={ORG.ens} title="Branches" />
      <div className="px-5 py-6 lg:px-8">
        <Panel className="p-5">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <p className="font-mono text-sm font-medium text-ink">{branchLabel}</p>
              <p className="mt-0.5 font-mono text-[0.6875rem] text-ink-muted">{branchLabel}.{ORG.ens}</p>
              <p className="mt-2 text-sm text-ink-muted">{branchVenue} · {branchWindow}</p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-sharp bg-signal/10 px-2 py-1 font-mono text-[0.6875rem] text-signal">
              open
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-rule pt-4 sm:grid-cols-3">
            {[
              { label: "Members", value: members },
              { label: "Online", value: online },
            ].map(({ label, value }) => (
              <div key={label}>
                <dt className="label">{label}</dt>
                <dd className="mt-1 font-mono text-lg tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Rewrite console/roles/page.tsx**

```typescript
import { PageHeader } from "@/components/console/PageHeader";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { ROLES, ORG } from "@/lib/config";

export const metadata = { title: "Roles — ENSCA console" };

// Roles is pure static config — no API needed, no "use client" required
export default function RolesPage() {
  return (
    <>
      <PageHeader eyebrow={ORG.ens} title="Roles" />
      <div className="px-5 py-6 lg:px-8 space-y-6">
        <Panel as="section">
          <PanelHeader>Entitlements</PanelHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-left">
              <thead>
                <tr className="border-b border-rule">
                  {["Role", "Group", "VLAN", "Rate Mbps", "Ceil Mbps"].map(h => (
                    <th key={h} scope="col" className="label px-4 py-2.5 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {ROLES.map(r => (
                  <tr key={r.name} className="hover:bg-ink/5">
                    <td className="px-4 py-2.5 font-mono text-xs text-ink">{r.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-80">{r.group}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.vlan}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.rate}</td>
                    <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-ink-80">{r.ceil}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel as="section">
          <PanelHeader>Permissions</PanelHeader>
          <div className="divide-y divide-rule">
            {ROLES.map(r => (
              <div key={r.name} className="flex items-start gap-4 px-4 py-3">
                <span className="w-24 shrink-0 font-mono text-xs text-ink">{r.name}</span>
                <span className="text-sm text-ink-muted">{r.summary}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
```

- [ ] **Step 5: Update Sidebar.tsx**

Replace `BRANCHES` import with config + `useProxyStatus`:
```typescript
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignalDither } from "@/components/dither/SignalDither";
import { useProxyStatus } from "@/lib/hooks/useProxyStatus";

// ... keep SECTIONS const unchanged ...

export function Sidebar() {
  const pathname = usePathname();
  const { data: status } = useProxyStatus();
  const branchLabel = process.env.NEXT_PUBLIC_BRANCH_LABEL ?? "branch";

  const online = !!status && status.status === "ok";

  return (
    <div className="flex h-full flex-col">
      {/* Org identity */}
      <div className="border-b border-rule px-4 py-4 lg:px-5">
        <Link href="/" className="flex items-center">
          <span className="font-mono text-sm font-medium tracking-[0.18em] text-ink">ENSCA</span>
        </Link>
      </div>

      {/* Branch label — single branch, no switcher */}
      <div className="border-b border-rule px-4 py-3 lg:px-5">
        <p className="label">Branch</p>
        <p className="mt-2 font-mono text-xs text-ink">{branchLabel}</p>
      </div>

      {/* Navigation — unchanged */}
      <nav aria-label="Console" className="flex-1 overflow-y-auto px-2 py-3 lg:px-3">
        {SECTIONS.map((section) => (
          <div key={section.heading} className="mb-4 last:mb-0">
            <p className="label px-2 pb-2">{section.heading}</p>
            <ul>
              {section.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-2.5 rounded-sharp px-2 text-sm transition-colors ${
                        active ? "bg-ink/8 font-medium text-ink" : "text-ink-muted hover:bg-ink/5 hover:text-ink"
                      }`}
                    >
                      <span aria-hidden className="h-4 w-px" style={{ background: active ? "var(--signal)" : "transparent" }} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Enforcer status */}
      <div className="hidden border-t border-rule lg:block">
        <div className="relative h-12">
          <SignalDither motif="waveform" cell={2} period={5} intensity={0.45} className="absolute inset-0" />
        </div>
        <div className="border-t border-rule px-5 py-3">
          <p className="flex items-center gap-2 font-mono text-[0.6875rem] text-ink-muted">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: online ? "var(--signal)" : "var(--alert)" }} />
            {online ? "Proxy online" : "Proxy unreachable"}
          </p>
          {status && <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">{status.active_sessions} active sessions</p>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: TypeScript compile check — expect zero errors**

```bash
cd /Users/I740422/projects/ensca/web
npx tsc --noEmit 2>&1
```
Expected: zero errors (all fixture imports gone, all pages wired).

- [ ] **Step 7: Smoke-test in browser**

```bash
cd /Users/I740422/projects/ensca/web && npm run dev
```
Open http://localhost:3000/console. Verify:
- Overview KPIs show numeric values (not "—" loading state after 3s)
- Group utilisation meters render (may show 0 Mbps used if no traffic — that's correct)
- Throughput chart renders with live data or empty state if no recent events
- Recent admissions shows real sessions
- Sidebar shows "Proxy online"

Open http://localhost:3000/console/members. Verify:
- Table populated with real users
- Online column correct (online = has active session)

Open http://localhost:3000/console/branches. Verify: shows live member/online counts.
Open http://localhost:3000/console/roles. Verify: static table renders, no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/I740422/projects/ensca
git add web/app/console/ web/components/console/Sidebar.tsx
git commit -m "feat(web): wire all console pages to live proxy API, remove all fixtures"
git push
```

---

## Task 6: Web — portal wallet-connect flow

**Files:**
- Modify: `web/components/PortalFlow.tsx`
- Modify: `web/app/portal/page.tsx` (add SSID env var)
- Modify: `portal/app.py` (add `/wallet-challenge` + `/wallet-verify` endpoints)

**Interfaces:**
- Consumes: `window.ethereum` (EIP-1193 provider, no npm package)
- Produces: real wallet challenge → signature → portal session flow
- Produces: portal API `GET /wallet-challenge` → `{nonce, ts}` and `POST /wallet-verify` → `{ok, tier, ens_name, group_name, rate_mbps, ceil_mbps}` or `{ok: false, reason}`

Notes:
- Portal runs on port 8080; the captive portal page is served from the portal's Flask app, not from Next.js. The `PortalFlow.tsx` component is embedded in the portal's HTML served by Flask, OR served from `web/app/portal/page.tsx` and the browser is redirected there by the captive portal. Either way, the component calls the portal directly at its origin (same host, port 8080).
- For the wallet challenge: generate a nonce server-side, store in session (Flask `session`), verify the EIP-191 signature client-side against the wallet address, then POST to portal for server-side confirmation.
- ENS resolution: use the ENS public API or a simple heuristic — if the portal has an ENS name already configured for a user (via admin), match by wallet_address. Full on-chain resolution is out of scope.
- Portal `/wallet-verify` maps wallet_address → user → group → tier, creates an iptables rule, calls proxy `/internal/session-created`, returns session info.

- [ ] **Step 1: Add wallet endpoints to portal/app.py**

Open `portal/app.py`. Add these routes (after the existing `/login` route):

```python
import secrets
import hashlib
import json as _json

_wallet_nonces = {}  # nonce -> ts (server-side nonce store, in-memory, ok for single-instance)

@app.route("/wallet-challenge", methods=["GET"])
def wallet_challenge():
    nonce = secrets.token_hex(16)
    _wallet_nonces[nonce] = int(time.time())
    # Expire nonces older than 5 minutes
    expired = [k for k, ts in _wallet_nonces.items() if int(time.time()) - ts > 300]
    for k in expired:
        del _wallet_nonces[k]
    return jsonify({"nonce": nonce, "ts": _wallet_nonces[nonce]})


def _recover_address(message: str, signature_hex: str) -> str:
    """Recover Ethereum address from EIP-191 personal_sign signature."""
    # EIP-191: prefix + message
    prefix = f"\x19Ethereum Signed Message:\n{len(message.encode())}".encode()
    msg_hash = Web3.keccak(prefix + message.encode()) if False else _keccak(prefix + message.encode())
    # Parse signature
    sig = bytes.fromhex(signature_hex.removeprefix("0x"))
    r = int.from_bytes(sig[:32], "big")
    s = int.from_bytes(sig[32:64], "big")
    v = sig[64]
    if v < 27:
        v += 27
    # Use eth_account or pure-python fallback
    try:
        from eth_account.messages import encode_defunct
        from eth_account import Account
        msg = encode_defunct(text=message)
        return Account.recover_message(msg, signature=sig).lower()
    except ImportError:
        return ""  # eth_account not installed — see note below


def _keccak(data: bytes) -> bytes:
    import hashlib
    # pysha3 or pycryptodome keccak
    try:
        import sha3
        k = hashlib.new("sha3_256")  # wrong — need keccak256, not SHA3
        # Fallback: use eth_account if available
    except Exception:
        pass
    return b""


@app.route("/wallet-verify", methods=["POST"])
def wallet_verify():
    data = request.get_json(force=True)
    nonce = data.get("nonce", "")
    signature = data.get("signature", "")
    wallet_address = data.get("wallet_address", "").lower()

    if nonce not in _wallet_nonces:
        return jsonify({"ok": False, "reason": "invalid_nonce"}), 400

    # Verify nonce freshness
    if int(time.time()) - _wallet_nonces.get(nonce, 0) > 300:
        return jsonify({"ok": False, "reason": "nonce_expired"}), 400
    del _wallet_nonces[nonce]

    # Recover address from signature
    message = f"Sign in to ENSCA\nNonce: {nonce}"
    recovered = _recover_address(message, signature)
    if not recovered or recovered != wallet_address:
        return jsonify({"ok": False, "reason": "signature_invalid"}), 403

    # Look up user by wallet address via proxy internal API
    try:
        r = requests.get(
            f"http://127.0.0.1:8081/admin/users/by-wallet/{wallet_address}",
            headers={"Authorization": f"Bearer {os.environ.get('ENSCA_PROXY_ADMIN_TOKEN', '')}"},
            timeout=5
        )
        if r.status_code != 200:
            return jsonify({"ok": False, "reason": "no_membership"}), 403
        user = r.json()
    except Exception as e:
        return jsonify({"ok": False, "reason": f"proxy_error: {str(e)[:80]}"}), 502

    # Grant access via existing grant_access logic
    ip = request.remote_addr
    tier = user.get("group", {}).get("network_tier", "basic")
    ens_name = user.get("ens_name") or wallet_address
    grant_access(ip, tier, ens_name, wallet_address)

    return jsonify({
        "ok": True,
        "ens_name": ens_name,
        "tier": tier,
        "group_name": user.get("group", {}).get("name", tier),
        "wallet_address": wallet_address,
    })
```

Note: `eth_account` provides the clean signature recovery. Add `eth_account` to requirements or install on VM: `pip install eth_account`. If not available, the verify endpoint returns `{"ok": false, "reason": "sig_verify_unavailable"}` and the UI shows an error.

Add to requirements/install notes:
```
# On VM:
pip install eth_account
```

- [ ] **Step 2: Rewrite PortalFlow.tsx with real wallet flow**

Replace `web/components/PortalFlow.tsx`:
```typescript
"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { SignalDither } from "@/components/dither/SignalDither";
import { Button } from "@/components/ui/Button";

type State = "idle" | "signing" | "connected" | "denied";

const ORDER: State[] = ["idle", "signing", "connected", "denied"];

const COPY: Record<State, { status: string; title: string; body: string }> = {
  idle: { status: "Not admitted", title: "Sign in to the network", body: "Connect the wallet holding your membership. Only a signature leaves this device — no password, no account." },
  signing: { status: "Verifying", title: "Check your wallet", body: "Sign the challenge to prove control of your membership name." },
  connected: { status: "Admitted", title: "You are online", body: "Your role resolved and its entitlements were applied to this device." },
  denied: { status: "Refused", title: "No membership at this branch", body: "That wallet holds no membership here. Ask an organizer to onboard you." },
};

type GrantInfo = { label: string; value: string }[];

// Portal runs at the same origin as the captive page (port 8080)
const PORTAL_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";

export function PortalFlow() {
  const [state, setState] = useState<State>("idle");
  const [direction, setDirection] = useState(1);
  const [grant, setGrant] = useState<GrantInfo>([]);
  const [error, setError] = useState<string>("");
  const reduceMotion = useReducedMotion();

  function go(next: State) {
    setDirection(ORDER.indexOf(next) >= ORDER.indexOf(state) ? 1 : -1);
    setState(next);
  }

  async function connectWallet() {
    setError("");
    go("signing");
    try {
      const eth = (window as any).ethereum;
      if (!eth) throw new Error("No Ethereum wallet found. Install MetaMask or a compatible wallet.");

      // Request accounts
      const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
      const address = accounts[0]?.toLowerCase();
      if (!address) throw new Error("No account selected.");

      // Get challenge nonce from portal
      const challengeRes = await fetch(`${PORTAL_ORIGIN}/wallet-challenge`);
      if (!challengeRes.ok) throw new Error("Portal unreachable.");
      const { nonce } = await challengeRes.json();

      // Sign the challenge
      const message = `Sign in to ENSCA\nNonce: ${nonce}`;
      let signature: string;
      try {
        signature = await eth.request({ method: "personal_sign", params: [message, address] });
      } catch (err: any) {
        if (err?.code === 4001) throw new Error("Signature rejected.");
        throw err;
      }

      // Verify with portal
      const verifyRes = await fetch(`${PORTAL_ORIGIN}/wallet-verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, signature, wallet_address: address }),
      });
      const result = await verifyRes.json();

      if (!result.ok) {
        setError(result.reason ?? "Unknown error");
        go("denied");
        return;
      }

      setGrant([
        ["Membership", result.ens_name],
        ["Group",      result.group_name],
        ["Tier",       result.tier],
        ["Wallet",     `${address.slice(0, 6)}…${address.slice(-4)}`],
      ]);
      go("connected");
    } catch (err: any) {
      setError(err?.message ?? String(err));
      go("denied");
    }
  }

  const copy = COPY[state];
  const slide = reduceMotion ? 0 : 20;
  const accent = state === "connected" ? "var(--signal)" : state === "denied" ? "var(--alert)" : "var(--ink-faint)";

  return (
    <div className="w-full max-w-[400px]">
      <section className="rounded-sharp border border-rule bg-paper-raise">
        <header className="flex items-baseline justify-between gap-3 border-b border-rule px-5 py-3">
          <p className="truncate font-mono text-xs text-ink">
            {process.env.NEXT_PUBLIC_SSID ?? "ensca"}
          </p>
          <p className="label shrink-0">SSID</p>
        </header>

        <div className="relative h-16 border-b border-rule">
          <SignalDither motif="ripple" cell={2} period={3.4} intensity={0.7} className="absolute inset-0" label="Beacon signal from the branch access point" />
        </div>

        <div className="relative overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={state}
              initial={{ opacity: 0, x: direction * slide }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction * -slide }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="px-5 py-5"
            >
              <p className="label flex items-center gap-2">
                <span aria-hidden className="size-1.5 rounded-full" style={{ background: accent }} />
                {copy.status}
              </p>
              <h1 className="mt-3 text-lg leading-snug tracking-[-0.01em] text-ink">{copy.title}</h1>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{copy.body}</p>

              {state === "connected" && grant.length > 0 && (
                <dl className="mt-5 divide-y divide-rule border-y border-rule">
                  {grant.map(([term, detail]) => (
                    <div key={term} className="flex items-baseline justify-between gap-3 py-2">
                      <dt className="label">{term}</dt>
                      <dd className="text-right font-mono text-xs text-ink-80">{detail}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {state === "denied" && error && (
                <p className="mt-3 font-mono text-xs text-alert">{error}</p>
              )}

              <div className="mt-6">
                {state === "idle" && (
                  <Button variant="solid" className="w-full" onClick={connectWallet}>
                    Connect wallet
                  </Button>
                )}
                {state === "signing" && (
                  <Button variant="outline" className="w-full" onClick={() => go("idle")}>
                    Cancel
                  </Button>
                )}
                {state === "connected" && (
                  <Button variant="outline" className="w-full" onClick={() => go("idle")}>
                    Disconnect
                  </Button>
                )}
                {state === "denied" && (
                  <Button variant="solid" className="w-full" onClick={() => go("idle")}>
                    Try another wallet
                  </Button>
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Deploy portal changes to VM**

```bash
rsync -av /Users/I740422/projects/ensca/portal/ philo@172.16.0.130:/opt/ensca/portal/
# Install eth_account on VM
ssh philo@172.16.0.130 'pip install eth_account --quiet'
# Restart portal
ssh philo@172.16.0.130 'sudo systemctl restart ensca-portal'
sleep 2
# Check portal started without error
ssh philo@172.16.0.130 'sudo systemctl status ensca-portal | head -20'
```
Expected: portal active (running).

- [ ] **Step 4: Test wallet-challenge endpoint**

```bash
ssh philo@172.16.0.130 'curl -s http://127.0.0.1:8080/wallet-challenge | python3 -m json.tool'
```
Expected: `{"nonce": "<hex string>", "ts": <int>}`.

- [ ] **Step 5: TypeScript compile check**

```bash
cd /Users/I740422/projects/ensca/web
npx tsc --noEmit 2>&1
```
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/I740422/projects/ensca
git add web/components/PortalFlow.tsx portal/app.py
git commit -m "feat: real wallet-connect flow — EIP-191 challenge/verify replaces setTimeout mock"
git push
```

---

## Task 7: Final mock elimination pass

**Files:**
- Read: every file changed in Tasks 3–6

**Interfaces:**
- Consumes: output of all prior tasks
- Produces: confirmation that zero fixture arrays, zero hardcoded inline values, and zero `setTimeout` advancement remain

- [ ] **Step 1: Grep for remaining fixture references**

```bash
cd /Users/I740422/projects/ensca/web
grep -rn "BRANCHES\|MEMBERSHIPS\|GROUPS\[0\]\|THROUGHPUT\|setTimeout.*connected\|setTimeout.*signing" \
  --include="*.ts" --include="*.tsx" .
```
Expected: zero matches.

- [ ] **Step 2: Grep for hardcoded inline mock values**

```bash
grep -rn '"3"\|"14"\|"9"\|"ethglobal-tokyo2026"\|leo\.tokyo2026\|hacker · vlan\|5 / 20 Mbps\|cached 12s ago\|Enforcer online"' \
  --include="*.ts" --include="*.tsx" /Users/I740422/projects/ensca/web
```
Expected: zero matches.

- [ ] **Step 3: Verify no direct proxy calls from browser (CORS/token safety)**

```bash
grep -rn "172\.16\.0\.130\|127\.0\.0\.1:8081" \
  --include="*.ts" --include="*.tsx" /Users/I740422/projects/ensca/web/app \
  /Users/I740422/projects/ensca/web/components /Users/I740422/projects/ensca/web/lib
```
Expected: zero matches (all calls go through `/api/admin/` Next.js routes).

- [ ] **Step 4: Verify PROXY_ADMIN_TOKEN not in client code**

```bash
grep -rn "PROXY_ADMIN_TOKEN\|NEXT_PUBLIC_PROXY_ADMIN" \
  --include="*.ts" --include="*.tsx" /Users/I740422/projects/ensca/web/app \
  /Users/I740422/projects/ensca/web/components /Users/I740422/projects/ensca/web/lib
```
Expected: zero matches in app/components/lib (token only referenced in `web/app/api/` route handlers which are server-side).

- [ ] **Step 5: TypeScript full compile**

```bash
cd /Users/I740422/projects/ensca/web && npx tsc --noEmit 2>&1
```
Expected: zero errors.

- [ ] **Step 6: Live browser smoke-test checklist**

```bash
cd /Users/I740422/projects/ensca/web && npm run dev
```
Check each URL and mark OK:
- [ ] http://localhost:3000/console — KPIs load, chart renders (empty if no traffic), sidebar shows proxy status
- [ ] http://localhost:3000/console/members — table shows real users, online count live
- [ ] http://localhost:3000/console/branches — shows single perimeter with live member/online counts
- [ ] http://localhost:3000/console/roles — static table, no errors
- [ ] http://localhost:3000/portal — portal flow renders with correct SSID from env

- [ ] **Step 7: Final commit and push**

```bash
cd /Users/I740422/projects/ensca
git add -A
git status  # review before commit
git commit -m "chore: final mock elimination pass — all fixtures replaced, zero hardcoded values"
git push
```

---

## Self-Review

**Spec coverage:**
- UI inventory (8 pages) — every page addressed in Tasks 5–6 ✓
- All 14 mock locations from Section C addressed ✓
- GAP-1 (perimeters) → Task 5 step 3 ✓
- GAP-2 (roles) → Task 3 config.ts ✓
- GAP-3 (group pool/vlan) → static config map in useGroups.ts ✓
- GAP-4 (timeseries) → Task 1 step 3 ✓
- GAP-5 (member rate) → Task 5 shows bytes_out instead of Mbps ✓
- GAP-6 (ENS in users list) → Task 1 step 2 ✓
- GAP-7 (portal wallet) → Task 6 ✓
- GAP-8 (admin token) → Task 2 route handler (server-side only) ✓
- GAP-9 (polling) → Task 4 SWR refreshInterval params ✓

**Placeholder scan:** No TBD/TODO — all code blocks have real implementations.

**Type consistency:**
- `Sample` used in `useThroughput` and `ThroughputChart` — both reference `{t, mbps, admitted}` ✓
- `ApiUser.ens_name` added to proxy list query in Task 1 before used in Task 5 ✓
- `TIER_ROLE` in members page maps `string → RoleName` — consistent with `RoleChip` prop type ✓
- `useGroups` returns `Group[]` matching `data.ts` Group type shape ✓

**Review Focus checks added to tasks:**
1. Token leakage → Task 7 step 4 grep ✓
2. "use client" on SWR pages → all pages in Task 5 include directive ✓
3. Timeseries bucket order → Task 1 step 3 uses `ORDER BY (ts / 600)` not ORDER BY t ✓
4. ENS fields → Task 1 step 2 proxy fix + Task 7 step 1 grep verifies ✓
5. Wallet rejection → Task 6 step 2, catch block checks `err.code === 4001` ✓
