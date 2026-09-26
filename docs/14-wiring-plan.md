# 14 — Wiring plan: ENS ⇄ console ⇄ enforcer

One document, one checklist. Every box is a change with a file and a reason. Items marked
**[BLOCKER]** must land before a demo; **[SEC]** is a security fix; **[DEL]** is a deletion.

Written after a five-agent review of `proxy/`, `contracts/`, `portal/`, `config/` and every file
in `web/`. Claims below marked "verified" were re-checked directly, not taken from a report.

---

## 0. Decisions this plan assumes

| # | Decision | Consequence |
|---|---|---|
| D1 | **Write-through from Next.js.** The `/api/ens/*` route does the chain tx, waits for the receipt, then mirrors into the enforcer in the same request. | Every mirror call must be idempotent. A reconcile endpoint repairs drift instead of a log listener. |
| D2 | **One enforcer per perimeter.** Perimeter identity is config (`BRANCH_ENS`), not a table. | No `branches` table in SQLite. But group names must still be perimeter-qualified at the ENS boundary. |
| D3 | **Next.js portal is the face, Flask stays the enforcer.** | `PortalFlow.tsx` gets real endpoints; `portal/app.py` keeps iptables/tc and the session row, and gains `/internal/admit`. |

---

## 1. What is actually true today (verified)

The gap between what the app claims and what it does is the real subject of this plan.

### 1.1 Security — the console is world-writable

- **Verified:** `find web -name middleware.ts` → **0 results**. There is no auth anywhere in `web/`.
- **Verified:** `grep -rn "authoriz\|session\|cookie" web/app/api/ens/` → **no matches**. Every
  chain-writing route is open.
- `POST /api/ens/onboard` mints a membership in any group, signed by `ORG_PRIVATE_KEY`.
- `POST /api/ens/groups` and `/api/ens/onboard` take `registrar` from the request body and cast it
  `as Address` with no validation — so the caller also picks **which contract** the org key calls.
- **Verified:** `app/api/admin/[...path]/route.ts` attaches `Bearer ${PROXY_ADMIN_TOKEN}` to any
  caller's request and exports `GET POST PATCH DELETE PUT`. `POST /api/admin/tokens` mints admin
  tokens; `DELETE /api/admin/users/<id>` deletes users. Both reachable from any browser.
- Catch-all segments arrive percent-decoded, so `/api/admin/..%2f..%2fsecret` escapes `/admin/`.

### 1.2 Config — the proxy world is unconfigured, and the org has two names

- **Verified:** the only var in `web/.env.local` is `ORG_PRIVATE_KEY`.
- **Verified:** code reads `PROXY_URL` / `PROXY_ADMIN_TOKEN`; `.env.example` documents
  `ENFORCER_URL` / `ENFORCER_TOKEN`. **Nothing reads the documented names.** So `/api/status` fetches
  `undefined/health` and throws, and the whole proxy half of the console is dead in this checkout.
- **Verified:** `lib/config.ts:5` says the org is `ensca.eth`; `lib/ens/config.ts:15` says
  `ethglobal2.eth` with no env override. `contracts/deployments/sepolia.json` agrees with the second.
- `NEXT_PUBLIC_BRANCH_LABEL`, `_ORG_ENS`, `_BRANCH_VENUE`, `_BRANCH_WINDOW`, `_SSID` are read in five
  places and defined nowhere — the overview page's title renders the literal string `branch.`
- `resolveIdentity` (`lib/ens/read.ts:379`) rejects any name not ending in the hardcoded org suffix.
  **If the deployed org is ever the env-configured one, every admission 404s and the whole site is
  locked out.** A config fork becomes a site-wide deny.

### 1.3 Correctness — three confident wrong answers

- **Verified:** `read.ts:261` — `async function fromChain(): Promise<EnsMembership[]>` takes **no
  argument**, and `getMemberships(branchLabel)` calls it as `fromChain()`. So
  `GET /api/ens/memberships?branch=osaka` during an indexer outage returns **Tokyo's members with
  HTTP 200**, stamped `branchLabel: "tokyo"`. Silent cross-branch corruption.
- **Verified:** `ThroughputChart.tsx:76` dereferences `points[peakIndex].mbps` with no guard;
  `useThroughput` returns `{samples: []}` whenever the proxy is unreachable — which is always, today.
- **Verified:** `Wizard.tsx:314` — `onDone(body.label, null)`, and `createBranch` in `write.ts`
  returns only `{txHash, label}`. The `BranchCreated` event in the receipt carries `registry` and
  `registrar` and is **thrown away**, so step 3 of the wizard re-discovers the perimeter through an
  indexer that has not indexed the just-confirmed tx. The wizard's happy path does not work.
- `resolveIdentity` reads entitlements from `ENS.resolver` rather than the name's own resolver. A
  member who points their name at their own resolver resolves to `{}` → HTTP 200 with an empty
  policy → `proxy.py:1236` reads no `wifi.group` → silent default group.
- `roleNames()` does `eth_getLogs` from block `11782000` to `latest` on every cache miss, on the hot
  admission path, against a public RPC that caps log ranges. When it throws, `/api/ens/resolve` 502s
  and `proxy.py:1214` stops consulting ENS entirely and falls back to SQLite — the ENS integration
  silently stops being the authority with no signal in any UI.

### 1.4 Mock data still rendered as telemetry

The user has said repeatedly: no mock data. These are what is left.

| Where | What |
|---|---|
| `lib/config.ts:63-67` `TIER_POOL_MBPS` | Invented capacity. Every meter's denominator and the chart's "provisioned" ceiling. |
| `lib/config.ts:70-74` `TIER_VLAN` | Invented VLAN tags rendered as `vlan 100 · N devices`. **The deployment has no VLANs at all** — `config/99-ensca` uses fwmark + HTB. |
| `lib/config.ts:76-83` `ENFORCEMENT` | Six hardcoded strings in a telemetry panel, including `fedora-vm · enp10s0u1` and a **fabricated, never-changing `"12s old · ttl 60s"`**. |
| `lib/hooks/useGroups.ts:39` | `used = bytes_out * 8 / 60e6`. `bytes_out` is a **cumulative lifetime counter**; there is no 60-second window. The number grows forever. This feeds the `Throughput` KPI. |
| `app/console/members/page.tsx:13-17` `TIER_ROLE` | Invented `tier → role` map with `?? "hacker"`. Every role chip in that table is a guess — and the ENS table one panel above shows the real name. The same person can appear as two different roles on one screen. |
| `app/console/page.tsx:52` | A `Denials` KPI hardcoded to `—`. |
| `app/console/page.tsx:73` | `Live · polling 10s` — three of the four feeds poll at 30s/60s. |
| `Wizard.tsx:386-390` `PRESETS` | Invented bandwidth strings **written to the blockchain** as entitlements. |

### 1.5 The bridge exists and is unwired on both ends

`/api/ens/resolve` was built as the enforcer's admission lookup. **Nothing calls it.** Not the web
app, not `portal/app.py`, and not the proxy — because `ENSCA_WEB_URL` is set nowhere in the repo, so
`_resolve_via_ens` returns `None` on every request and every login resolves against local SQLite.

### 1.6 Two portals, neither wired

`portal/app.py` is live: a **bare ENS name typed into a text box**, no password, no signature. Typing
`alice.eth` admits you as Alice. `PortalFlow.tsx` implements the wallet-signature flow correctly but
calls `/wallet-challenge` and `/wallet-verify`, **which exist nowhere in the repo** — only in an
unimplemented plan doc. It is served by Next on :3000 while `PORTAL_ORIGIN` assumes Flask on :8080,
so it fails at the first fetch every time.

---

## 2. Target architecture

```
                    ENS (Sepolia) — authority on WHO and WHICH GROUP
                           │
        ┌──────────────────┼──────────────────┐
        │ BranchFactory    │ BranchRegistrarV2│ OrgRegistrar
        │ BranchCreated    │ RoleDefined      │ MemberEnrolled
        │                  │ Onboarded        │
        └──────────────────┼──────────────────┘
                           │  receipt decoded → real addresses
                           ▼
              Next.js route handler  (/api/ens/*)   ← the only writer
                           │
                 ┌─────────┴─────────┐
                 │ 1. chain tx       │
                 │ 2. await receipt  │
                 │ 3. mirror  ───────┼────────────▶ enforcer admin API (idempotent upsert)
                 └───────────────────┘                     │
                                                           ▼
                                        SQLite: groups / users / limits
                                                           │
   device ──▶ Next portal ──signature──▶ Flask /internal/admit ──▶ iptables + tc + session row
                                                  │
                                                  └─ resolves via /api/ens/resolve (404=deny, 502=fallback)
```

**The invariant, already correct in `proxy.py` and worth protecting:** ENS is the authority on which
group a person is in; the enforcer is the authority on what that group means locally (tier, rate,
quota). Never publish a bandwidth number on-chain and trust it.

### 2.1 Join keys — decide once, use everywhere

| Object | On-chain id | SQL key | Why |
|---|---|---|---|
| Person | wallet address (`Onboarded.owner`) | `users.wallet_address` | The only id that survives expiry, revocation and re-onboarding, and it is what a signature recovers to. |
| Membership | full ENS name `<label>.<branch>.<org>` | `users.username` **and** `users.ens_name`, identical, lowercased | `/internal/ens-lookup` joins on `username`; `by-ens` joins on `ens_name`. Today only `seed_ens.py` keeps them equal. Write both or the two paths disagree. |
| Group | `roleId = keccak256(name)` | `groups.name` = `<branch-label>:<role-name>` | `groups.name` is **globally UNIQUE** in SQLite, but two perimeters can each define `mentor`. Qualify the name. |
| Perimeter | `BranchCreated.node` / registry address | config only (D2) | One enforcer per perimeter. |

⚠️ **Do not** key on `tokenId` — it is regenerated on every role grant (`TokenRegenerated`). `resource`
changes after expiry. Both are current-value columns, never keys.

---

## 3. PHASE 0 — Stop the bleeding [BLOCKER]

Nothing else matters while the org key is world-spendable.

- [ ] **[SEC]** Create `web/middleware.ts`. Require an authenticated session for every
      `POST/PATCH/PUT/DELETE` under `/api/ens/*` and for **all** methods under `/api/admin/*`.
- [ ] **[SEC]** Pick the session mechanism and write it down: a signed httpOnly cookie issued after
      the operator proves control of the org wallet (SIWE), or — if that is too much for the demo —
      a single `CONSOLE_TOKEN` env var checked against an `x-console-token` header. Either is fine.
      **No auth at all is not.**
- [ ] **[SEC]** Reject path traversal in `app/api/admin/[...path]/route.ts`: refuse any segment
      containing `/`, `..`, or a leading `.` **before** building the upstream URL.
- [ ] **[SEC]** Allow-list `registrar`. Add `assertOurRegistrar(address)` in `lib/ens/` that checks
      the address against the perimeter registrars discovered from ENS (or the perimeter's own
      `ensca.registrar` text record) and throws otherwise. Call it in `/api/ens/groups` POST and
      `/api/ens/onboard` POST before any write.
- [ ] **[SEC]** Stop deriving the commit salt from the private key. `write.ts:146`
      `process.env.ORG_PRIVATE_KEY ?? "ensca"` — a public fallback salt voids commit/reveal
      front-running protection entirely. Use `crypto.randomBytes(32)` persisted per pending
      commitment (see §6.1, which needs that store anyway).
- [ ] **[SEC]** `GET /api/ens/org` returns the org signer address to anonymous callers. Move it
      behind the same gate.
- [ ] Add `try/catch` to `app/api/status/route.ts` and `app/api/admin/[...path]/route.ts`. An
      unreachable enforcer must be a **502 with a JSON body**, never an unhandled 500 HTML page.
- [ ] Rotate `ORG_PRIVATE_KEY` before any public demo. It is a demo key in a repo that has been
      shared. (Verified it was never committed — `git log -S` finds nothing — but rotate anyway.)

---

## 4. PHASE 1 — One source of truth for config [BLOCKER]

Every downstream bug in §1.2 comes from here.

- [ ] Create `web/lib/ens/addresses.ts`: public constants only (contract addresses, `explorer()`,
      `ENTITLEMENT_KEYS`). No env reads. Safe for client components.
- [ ] Keep `RPC_URL`, `INDEXER_URL` and anything secret in a module that starts with
      `import "server-only"`. Today `lib/ens/config.ts` reads `SEPOLIA_RPC_URL` **and** is imported
      by five client components — it works only because Next erases non-`NEXT_PUBLIC_` vars, and it
      is the one file where a future secret leaks without a build error.
- [ ] Make the organization name configurable: `ORG_ENS` (server) + `NEXT_PUBLIC_ORG_ENS` (display),
      both defaulting to the same value, derived from one constant. Delete the hardcoded
      `organization: "ethglobal2.eth"` as a *literal* and read it from env with that default.
- [ ] **[DEL]** Delete `ORG` (`lib/config.ts:3-7`) — zero importers, and its `ensca.eth` default is
      the wrong org.
- [ ] Rename `PROXY_URL` → `ENFORCER_URL` and `PROXY_ADMIN_TOKEN` → `ENFORCER_TOKEN` **in the code**,
      matching what `.env.example` already documents. Update
      `app/api/status/route.ts:3` and `app/api/admin/[...path]/route.ts:3-4`.
- [ ] Add every var actually read to `.env.example`, with a comment each:
      `ENFORCER_URL`, `ENFORCER_TOKEN`, `ORG_ENS`, `NEXT_PUBLIC_ORG_ENS`, `BRANCH_ENS`,
      `NEXT_PUBLIC_BRANCH_ENS`, `NEXT_PUBLIC_SSID`, `CONSOLE_TOKEN`, `SEPOLIA_RPC_URL`,
      `ENS_INDEXER_URL`, `ORG_PRIVATE_KEY`.
- [ ] Replace `NEXT_PUBLIC_BRANCH_LABEL` + `NEXT_PUBLIC_ORG_ENS` string-concatenation (four sites)
      with one `BRANCH_ENS` value. Delete `NEXT_PUBLIC_BRANCH_VENUE` and `_BRANCH_WINDOW` — they are
      fossils of the deleted `Branch` fixture type and render an empty ` · `.
- [ ] Make the `Radius` wordmark one exported constant. It is currently hardcoded in
      `SiteHeader.tsx:14`, `Sidebar.tsx:39`, `layout.tsx:17`, `app/page.tsx:21`, `PortalFlow.tsx:73`
      and `lib/config.ts:4` — six copies.
- [ ] One `NEXT_PUBLIC_SSID` default. `lib/config.ts` says `"ENSCA"`, `PortalFlow.tsx:138` says
      `"ensca"`, for the same variable.
- [ ] Set `ENSCA_WEB_URL` in `config/ensca-proxy.service`. **Until this is set the ENS integration
      does not run at all** — `_resolve_via_ens` returns `None` on every request and every login
      falls back to SQLite. This one line is the difference between the demo being ENS-backed and
      being a password database with ENS-shaped names.

---

## 5. PHASE 2 — Make the enforcer mirrorable

The backend has **no concept of a perimeter or an organization** — the word `branch` appears once, as a
pass-through field that is never stored. Under D2 we do not add those tables, but the group namespace
still has to stop colliding.

### 5.1 Schema

- [ ] `groups`: add `ens_role_id TEXT` (the `keccak256(name)` hex) and `branch_ens TEXT`.
      Index `(branch_ens, ens_role_id)`.
- [ ] `groups.name`: keep the global UNIQUE, and write perimeter-qualified names
      (`tokyo:mentor`). Cheaper than a SQLite table rebuild and achieves the same thing.
      Document the format in `db.py` next to the column.
- [ ] `users`: add `ens_owner TEXT` (the wallet that owns the name on-chain) distinct from the
      existing free-text `wallet_address`, plus `last_synced_at INTEGER`.
- [ ] Add UNIQUE indexes on `users.ens_name` and `users.wallet_address` (partial, `WHERE NOT NULL`).
      Today both are non-unique, so `by-ens` and `by-wallet` resolve duplicates **arbitrarily**.
- [ ] Normalise ENS names on write: lowercase, everywhere. `/internal/ens-lookup` lowercases;
      `by-ens` does not; nothing normalises on write. `Bob.eth` and `bob.eth` currently get separate
      `daily_ens_counters` buckets and therefore separate quotas.
- [ ] **Do not** run a `users` table rebuild casually. `db._migrate()` already does one with
      `PRAGMA foreign_keys=OFF` inside a bare `except sqlite3.OperationalError: pass` — a failed
      rebuild is **silent**. Add columns with `ALTER TABLE` only.
- [ ] Note in `db.py`: `init_db()` only runs under `python proxy.py`, not under gunicorn. If the
      service ever changes launcher, migrations stop running.

### 5.2 Endpoints the mirror needs

- [ ] `PUT /admin/groups/by-name/<name>` — idempotent upsert. Today `POST /admin/groups` returns
      `409 name_taken` on replay, and a retried mirror cannot tell "already done" from "failed".
- [ ] `PUT /admin/users/by-ens/<ens_name>` — idempotent upsert. Same reason: `POST /admin/users`
      409s, and it **requires a password**, which is meaningless for an ENS-authenticated member.
      The upsert must allow `password_hash = ''`.
- [ ] Relax the `network_tier` enum. `POST /admin/groups` hard-requires
      `basic|staff|vip` (`proxy.py:208`), but the ENS groups are `hacker`, `mentor`, `partner`,
      `volunteer` — which is exactly why `seed_ens.py` bypasses the API and writes SQL directly.
      Either widen the enum or decouple: the group's **name** carries chain identity, `network_tier`
      stays a local enforcement policy with a safe default the mirror never overwrites.
- [ ] `GET /admin/groups?name=` and `GET /admin/resources?slug=` — lookup by natural key. Today a
      mirror must list everything and scan client-side to recover a uuid.
- [ ] Fix `PATCH /admin/groups/<gid>` renaming to an existing name: it hits the UNIQUE constraint
      with no pre-check and returns **500 HTML**, not 409.
- [ ] Fix `/internal/session-created` and `/internal/session-ended`: they index the body with
      `data["..."]`, so any missing key is a `KeyError` → 500. Return 400.
- [ ] Add `GET /admin/sync/state` — what is currently mirrored, with `last_synced_at`. There is no
      way today to ask the question.
- [ ] `POST /admin/sync/reconcile` — accept the full desired state for this perimeter (groups + members)
      and converge. This is the listener's job done on demand, and it is how drift gets repaired
      after a half-failed write-through.
- [ ] **Raise the token cap.** `auth.py:22` selects `LIMIT 20` with **no ORDER BY**. Past 20 live
      tokens some authenticate and some silently 401, depending on SQLite row order. A console plus a
      mirror minting tokens will hit this. Also: every admin call bcrypt-compares against up to 20
      hashes — seconds of CPU per request. Switch to an HMAC lookup keyed by a token id prefix.
- [ ] Decide the mirror's auth path. `/internal/*` is `@require_local` with **no token bypass**, so
      if Next.js is not on the VM it cannot reach `ens-lookup` or `session-created` at all. Either
      co-locate, or add admin-authenticated equivalents.
- [ ] `_local_or_admin_ok` trusts `request.remote_addr` and grants **unauthenticated token minting
      from localhost**. Behind any reverse proxy without `ProxyFix`, every request looks local and
      `POST /admin/tokens` is world-open. Add `ProxyFix` or drop the localhost bypass.

### 5.3 Limits

- [ ] `PUT /admin/groups/<gid>/limits/<rid>` is a **full replace**: omitting `per_ens_per_day` sets it
      to NULL (= unlimited), silently dropping a configured cap. And `GET /admin/groups/<gid>` does
      not return `per_ens_per_day`, so the loss is invisible through the API. Always send all three
      keys from the mirror, and add the field to the GET response.

---

## 6. PHASE 3 — The write-through path

### 6.1 Make the ENS writes return real data and be replay-safe

- [ ] **[BLOCKER]** `createBranch` in `write.ts`: decode `BranchCreated` from the receipt and return
      `{txHash, label, node, registry, registrar, owner}`. The receipt already contains all of it and
      the function throws it away — this is the single fix that unbreaks the create wizard.
- [ ] `onboardMember`: decode `Onboarded` and return `{resource, label, owner, roleId}`.
- [ ] `defineGroup`: decode `RoleDefined` and return `{roleId, name}`.
- [ ] Make all three writes idempotent: read current state first and return `{alreadyDone: true}`
      rather than sending a tx that reverts. None of them does this today, so a retry after a
      timeout reverts with an opaque error and the UI has no way forward.
- [ ] **Fix the timeout inversion.** `send()` waits 120s for a receipt (`write.ts:70`) while the
      routes set `maxDuration = 120`. A slow-but-successful tx is killed by the platform **after it
      lands**, the UI shows an error, and the name has been bought. Set `maxDuration = 300` and the
      receipt timeout to 90s, or return the hash immediately and poll.
- [ ] Add a nonce manager. `wallet()` builds a fresh client per call with no nonce management; two
      concurrent POSTs resolve the same pending nonce, one replaces the other, and the replaced hash
      never confirms — the route then blocks the full timeout. Use viem's `nonceManager`, or
      serialise writes behind a mutex.
- [ ] Persist pending org commitments (label → secret, committed-at). Today the secret is re-derived
      from the private key and the wizard keeps the countdown in React state, so a refresh loses a
      paid-for commitment.

### 6.2 The mirror itself

- [ ] Create `web/lib/enforcer/client.ts`: a typed client over `ENFORCER_URL` with `ENFORCER_TOKEN`,
      exposing `upsertGroup`, `upsertMember`, `putLimit`, `reconcile`. Server-only.
- [ ] `POST /api/ens/groups` — after the receipt: `upsertGroup({name: "<perimeter>:<role>", ens_role_id,
      branch_ens, network_tier: <default>})`. Then `putLimit` for each resource the group may reach.
- [ ] `POST /api/ens/onboard` — after the receipt: `upsertMember({ens_name: "<label>.<perimeter>.<org>",
      username: same, wallet_address: owner, group: "<perimeter>:<role>"})`.
- [ ] `POST /api/ens/branch` — under D2 nothing to mirror, but **do** write the perimeter's
      `ensca.registrar` record if the perimeter was created by a script rather than the factory
      (`AddBranch.s.sol` never writes it, and without it the perimeter is undiscoverable).
- [ ] **Mirror failures must not fail the request.** The chain write already landed and is the
      authority. Return `200 {ok: true, mirrored: false, reason}` and let reconcile repair it.
      Surface `mirrored: false` in the UI as a visible warning, not a silent success.
- [ ] Log every mirror attempt with the tx hash, so drift is diagnosable.

### 6.3 Resources and limits

- [ ] Resources stay **local only** — an upstream URL plus a plaintext API key. Nothing about them
      goes on-chain, ever. The console declares *which* resources a group may reach; the enforcer
      owns the credentials.
- [ ] Add a console screen for resources (`/console/resources`) that reads and writes the enforcer
      directly. The proxy already has full CRUD; `lib/api.ts` exposes **only `apiGet`**, so the UI
      currently cannot write to the enforcer at all despite the catch-all forwarding all five verbs.
- [ ] Note in the UI that `strip_path_prefix` does nothing — it is stored, returned, and never read
      by `upstream._build_url`. Either implement it or remove it from the API.

---

## 7. PHASE 4 — The UI, file by file

### 7.1 Deletions first [DEL]

Each verified by repo-wide grep. ~350 lines, most of it fabricated policy.

- [ ] `components/ui/Stat.tsx` — zero imports. `console/page.tsx:78-96` reimplements it inline.
- [ ] `lib/hooks/useBandwidth.ts` — zero imports; duplicated live inside `useGroups.ts:26-30`.
- [ ] `lib/hooks/useEns.ts:37-44` `useEnsBranch` — zero imports **and broken**: fetches
      `/api/ens/branch` with no query string, which returns `{valid:false}`, typed as `EnsBranch`.
- [ ] `lib/ens/read.ts:145-167` `getBranch` and `read.ts:72-81` `EnsBranch` — dead with the above.
- [ ] `lib/config.ts:9-60` `ROLES` — 52 lines of fabricated roles with invented VLANs, rates and
      permission strings (`"role:assign"`, `"branch:edit"` appear nowhere else in the repo).
- [ ] `lib/data.ts` — `GroupName`, `Branch`, `Membership`, `Role`: four of seven exported types have
      zero importers. Fold the three live ones into their hooks; the file disappears.
- [ ] `lib/ens/config.ts` — `SEPOLIA_CHAIN_ID`, `universalResolver` (zero readers each).
- [ ] `lib/ens/write.ts:344` — `export { namehash, resolverAbi }`, zero importers.
- [ ] `components/dither/bayer.ts:28` `thresholdAt` — zero callers.
- [ ] `lib/ens/abis.ts` — ~15 unused fragments (`roleCount`, `hasRoles`, `membershipOf`,
      `effectiveRole`, `roleResource`, `balanceOf`, most of `orgRegistrarAbi`).
- [ ] `app/console/members/page.tsx:44` — "Onboard member" button with no `onClick`, sitting directly
      above the real form.
- [ ] **[BLOCKER]** `lib/ens/read.ts:261-351` `fromChain` + the `getMemberships` try/catch +
      `lib/ens/config.ts:30-33` (the Tokyo quartet). This is the largest single deletion and it fixes
      the wrong-perimeter bug. The fallback's stated purpose — "the indexer is a cache, never the
      authority" — is not what it does: it substitutes one hardcoded perimeter's data for whatever was
      asked, which is worse than the 502 the route would otherwise return. `EnsMemberships.tsx:53-61`
      already renders a correct failure state.
      *If* a chain fallback is wanted later, write one that takes `branchLabel` and derives the
      registrar from the perimeter's `ensca.registrar` record.

### 7.2 Remove the remaining mock data

- [ ] `lib/config.ts` `TIER_POOL_MBPS` → read the group's `wifi.ceil` entitlement from ENS, or drop
      the meter. Do not invent a denominator.
- [ ] `lib/config.ts` `TIER_VLAN` → **delete**. There are no VLANs in this deployment; enforcement is
      fwmark + HTB (`config/99-ensca`). Showing `vlan 100` is fiction.
- [ ] `lib/config.ts` `ENFORCEMENT` → replace the panel with real values from
      `GET /api/status` + `/admin/status`, or delete the panel. `"12s old · ttl 60s"` is a hardcoded
      string that never changes.
- [ ] `useGroups.ts:39` → either compute real Mbps from `/admin/bandwidth/timeseries` (which does
      bucket properly, verified in `proxy.py:1378-1394`) or show cumulative bytes and label it
      "total". Do not divide a lifetime counter by a made-up window.
- [ ] `members/page.tsx:13-17` `TIER_ROLE` → **delete**. Join the enforcer's users to the ENS
      memberships on `wallet_address ↔ owner` and show the real on-chain role, or show nothing.
- [ ] `console/page.tsx:52` `Denials` KPI → wire to a real denial count (add one to the enforcer) or
      remove the tile.
- [ ] `console/page.tsx:73` → derive the polling label from the actual `refreshInterval`.
- [ ] `Wizard.tsx:386-390` `PRESETS` → these are written on-chain. Either label them explicitly as
      editable suggestions with empty defaults, or seed them from a documented org policy file. Do
      not silently write invented numbers to the blockchain.
- [ ] `GroupForm.tsx:10-14` `STARTER_ENTITLEMENTS` → derive from `ENTITLEMENT_KEYS`, one source.

### 7.3 Fix the crash and the missing states

- [ ] **[BLOCKER]** `ThroughputChart.tsx` — guard every empty-data path: `points[peakIndex]` (line 76),
      `points[-1]` in the axis map (line 143), `x(i)` dividing by `data.length - 1` (zero or −1),
      `niceCeil(0)` → `10 ** -Infinity` → `NaN` coordinates, and `key={tick.value}` collisions when
      `max === 0`. Render an empty state below two samples.
- [ ] Every hook currently discards `error`. Add error states to: `console/page.tsx`,
      `members/page.tsx`, `groups/page.tsx`, `Sidebar.tsx`. **An outage must never render as "nobody
      is here" or "no groups yet".** `EnsBranches.tsx` already does this correctly — copy its shape.
- [ ] Add `res.ok` checks to every bare fetcher: `useProxyStatus.ts:12`, `OnboardForm.tsx:36`,
      `groups/page.tsx:26`. A 502 JSON body is currently cached as data, so `groups` becomes `[]` and
      the UI says "no groups defined yet".

### 7.4 Fix the flows

- [ ] **[BLOCKER]** `Wizard.tsx` `BranchStep` — pass the real registrar through from the receipt
      (§6.1) instead of `onDone(body.label, null)`, and have `GroupsStep` use it directly rather than
      re-querying an indexer that has not caught up.
- [ ] `Wizard.tsx` "I already have one" calls `onDone("")` — advances without establishing which org
      the user owns. Either accept an org name here or remove the option.
- [ ] Fix the debounced-availability race in `Wizard.tsx` (two places) and `OnboardForm.tsx:42`.
      `clearTimeout` cancels the *timer*, never the in-flight *request*: type `ac`, pause, type `me`,
      and A's stale "available" can land after B's and enable submit for a label never checked.
      Capture the value in the closure and discard mismatched responses, or use `AbortController`.
- [ ] `OnboardForm.tsx:58` — the effect's dep array contains `branch`, an object SWR rebuilds every
      60s, so the availability check re-fires on every revalidation of an untouched form.
- [ ] `members/page.tsx:49` — pass `onDone={mutate}` to `OnboardForm`. A successful onboard currently
      refreshes nothing for up to 30s and the operator re-submits.
- [ ] `GroupForm.tsx` — reset `rows`, `editableKeys` and the checkboxes on success. Today only `name`
      resets, so the second group silently inherits the first's entitlements.
- [ ] `GroupForm.tsx:135` — key entitlement rows by a stable id, not array index; adding a row
      remounts the inputs and loses focus.
- [ ] Surface `txHash` with an explorer link on every successful write. All four routes return it and
      every form discards it.
- [ ] Extract one `useSelectedBranch()` hook. "Filter perimeters with a registrar, default to the
      first" is written four times (`GroupForm.tsx:26,37`, `OnboardForm.tsx:31`, `groups/page.tsx:22`,
      `Wizard.tsx:399`), and all four share the same stale-`target` bug: the `<select>` shows
      perimeter[0] while state is `""`, so a reorder on revalidation changes the selection silently.
- [ ] Replace `Wizard.tsx:405-416`'s hand-rolled perimeters effect with `useEnsBranches()`.
- [ ] One `RoleChip`. `RoleChip.tsx` is typed to the closed `RoleName` union (which is why the fake
      `TIER_ROLE` map exists to satisfy it) while `EnsMemberships.tsx:110-120` hand-rolls a second
      one for arbitrary on-chain names. Keep the second, delete the type constraint.
- [ ] One `short(address)` helper. Three copies with three different slice lengths.
- [ ] One `get(prefix, path, params)`. `lib/api.ts:apiGet` and `useEns.ts:ensGet` are the same
      function twice, and `ensGet` drops the response body from the error so the UI can only ever say
      "failed", never why.

### 7.5 Routes

- [ ] Extract one `writeRoute(schema, fn)` helper. The parse-body → validate → `signerConfigured()`
      → try/catch-502 block is written out four times, and the catch clause nine times. This is also
      where the Phase 0 auth gate and the label/address validation land **once** instead of four
      times.
- [ ] Validate on POST what GET already validates. `branch/route.ts:11` checks
      `/^[a-z0-9-]{1,32}$/` on GET; the POST one line down checks only `!body.label`, so
      `{"label":"tokyo.attacker"}` reaches a chain write. Same gap in `org/route.ts:22`.
      `branch/route.ts:44` casts `body.owner as Address` unchecked, and `expiry` is an unvalidated
      number — `expiry: 0` opens a perimeter that is born closed.
- [ ] `groups/route.ts` GET with no `registrar` silently falls through to
      `read.ts:111`'s default `ENS.branchRegistrar` — a missing param returns **a different perimeter's
      groups**. Return 400.
- [ ] Give `/api/ens/branches` the same honest failure as `/api/ens/memberships`. It is the only
      perimeter-discovery path and has no fallback: when the staging indexer is down, the Sidebar,
      Perimeters page, Groups page, both forms and the wizard all go empty at once, indistinguishable
      from a new org.
- [ ] Rename the query param: `/api/ens/available?registry=` vs `/api/ens/groups?registrar=`. Two
      different addresses, near-identical names, adjacent routes.

### 7.6 Read layer

- [ ] **[BLOCKER]** `resolveIdentity` — read entitlements from the **name's own resolver**
      (`getResolver`, or `ENS.universalResolver`, which is configured and never used), not from
      `ENS.resolver`.
- [ ] **[BLOCKER]** Bound the `roleNames()` log window. Cache the id→name map persistently (it only
      grows), or scan a rolling window, or read the names from the mirrored enforcer DB. As written
      it scans from block `11782000` to `latest` on the hot admission path.
- [ ] Give `roleNameCache` an eviction policy and key it on a **lowercased** address — an
      indexer-returned checksummed address and a config lowercase address are currently two entries
      for one contract.
- [ ] Stop collapsing three conditions into `role: "unknown"`: "no `ensca.registrar` published",
      "log query returned short" and "genuinely unknown role" are different answers and the caller
      cannot tell them apart.
- [ ] `read.ts:191-194` fetches `orgTree()` **twice** per memberships request — once via
      `getIndexedMemberships`, once via `getIndexedBranches`. Fetch once, derive both.
- [ ] `indexer.ts:101` vs `:120` derive the label two different ways (`slice(-suffix)` vs
      `split(".")[0]`), so a nested name yields `"a.b"` in one and `"a"` in the other, the lookup
      misses, and the row degrades to `role: "unknown"` with HTTP 200.
- [ ] `indexer.ts:129` hardcodes `parts.length !== 4`, assuming a two-label org. Derive the depth
      from `ORG_ENS.split(".").length`, as `resolveIdentity` already does.
- [ ] Add pagination to `orgTree()`. `domains(where:)` has no `first`/`skip`; most indexers cap at
      100–1000 rows, and truncation is indistinguishable from "those names do not exist".
- [ ] `ENTITLEMENT_KEYS` is a closed read list while `GroupForm` invites arbitrary keys
      (`placeholder="avatar, ssh.pubkey"`). Read the real key set from `entitlementsOf(roleId)`.

---

## 8. PHASE 5 — The portal

Under D3: React is the face, Flask stays the enforcer.

- [ ] Implement `POST /wallet-challenge` in `portal/app.py`: issue a single-use nonce with a short
      TTL, keyed by client IP. `PortalFlow.tsx` already expects exactly this shape.
- [ ] Implement `POST /wallet-verify`: `ecrecover` the `personal_sign` signature, then check the
      recovered address equals `getOwner` for the claimed name via `/api/ens/resolve`. **Without this
      the ENS name is a bearer token** — today typing `alice.eth` admits you as Alice, with no
      password, no signature and no nonce.
- [ ] Fix `PORTAL_ORIGIN` (`PortalFlow.tsx:39`): it is `window.location.origin` computed at module
      scope, so under SSR it is `""` and never recomputed on hydration. Point it at `ENFORCER_URL`
      explicitly.
- [ ] Preserve the deny/fallback contract through every new layer: **404 = deny, non-200/timeout =
      fall back.** `proxy.py` gets this right and `portal/app.py` breaks it — `_lookup_ens` returns
      `None` for both "unknown name" and "proxy unreachable", so an outage tells users "ENS name not
      recognized".
- [ ] Cache resolved identities with a short **positive** TTL (~60s) and a zero **negative** TTL, so
      a freshly onboarded attendee is never locked out by a cached deny.
- [ ] Never evict a live session because an RPC is down. The reaper and dhcp-hook must not tear down
      admitted devices on a lookup failure.
- [ ] Guard `TIER_MARK[tier]` (`app.py:126`). Any tier outside the five keys raises `KeyError`
      **inside `_state_lock`** and 500s the login — and `seed_ens.py` creates `hacker`/`partner`
      groups while the API validates against `basic|staff|vip`, so this is reachable today.
- [ ] Fix `_flush_portal_rules()`: it runs `iptables -t nat -F PREROUTING`, wiping the base
      `udp/53 REDIRECT` from `config/99-ensca`, while `_bootstrap_captive_redirect()` restores only
      the `:80` rule — and the boot lock file stops `99-ensca` re-running. After any portal restart,
      unauthed DNS is no longer redirected.
- [ ] `_notify_session_created` returns early when `_resolve_group` finds nothing, so **the device
      gets full network access with no session row**. Log it loudly and fail the admission instead.
- [ ] Add an upload qdisc on `enp2s0`, or stop documenting upload shaping. The `-s <ip>` MARK is
      classified by nothing today.
- [ ] Decide what happens to `portal/templates/login.html`. Under D3 it becomes a fallback for
      non-wallet devices, or it goes.

---

## 9. PHASE 6 — Docs and tests

### 9.1 Correct the drifted docs

- [ ] `docs/07-device-isolation.md` documents `_apply_cross_tier_rules` isolating by **tier**; the
      code implements `_apply_ens_isolation` isolating by **ENS name**.
- [ ] `docs/12-current-infra-vm-setup.md` still lists `basic/basic2026` style credentials that do not
      exist in the code.
- [ ] `docs/04-wifi-network.md` shows `dhcp-option:dns-server,192.168.0.1`; `config/dnsmasq.conf`
      says `8.8.8.8`.
- [ ] `docs/09-api-reference.md` says `GET /admin/resources` returns masked keys; it returns no key
      field at all.
- [ ] `docs/13-ens-design.md` §7 gives `canonicalId = tokenId ^ uint32(tokenId)`; `getResource`
      returns the value with version bits **set**, not zeroed. The doc and the contract disagree.
- [ ] `lib/data.ts`'s header claims "all fixture arrays removed" — four of its seven types are dead
      fixture shapes.

### 9.2 Tests worth having

- [ ] The mirror path end to end: define a group on-chain → assert the enforcer row exists → replay
      the same call → assert no duplicate and no 409.
- [ ] Onboard on-chain → assert `users.ens_name == users.username`, lowercased, and that both
      `/internal/ens-lookup` and `/admin/users/by-ens` find the same person. These two paths join on
      **different columns** today.
- [ ] `resolveIdentity` against a name whose resolver is not the org resolver.
- [ ] `/api/ens/memberships?branch=<x>` with the indexer stubbed down — assert it does **not** return
      another perimeter's rows.
- [ ] `ThroughputChart` with zero and with one sample.
- [ ] Portal: unknown name vs unreachable proxy must produce **different** user-visible outcomes.
- [ ] Portal: `TIER_MARK` covers every tier the enforcer can return — a table-driven test that reads
      both `app.py` and `config/99-ensca` so the two cannot drift with a green suite.
- [ ] A signature-verification test for `/wallet-verify`, including a replayed nonce.

---

## 10. Suggested order

1. **Phase 0** — auth, registrar allow-list, traversal, salt. Nothing else matters first.
2. **Phase 1** — one org constant, correct env names, `ENSCA_WEB_URL` on the VM. Until this lands the
   ENS integration is not running at all.
3. **§7.1 deletions** — especially `fromChain`. One deletion fixes a data-corruption bug and removes
   ~150 lines.
4. **§6.1** — decode receipts. Unbreaks the create wizard.
5. **Phase 2 + §6.2** — idempotent enforcer endpoints, then the write-through.
6. **§7.2 / §7.3** — remove the last mock data, fix the crash, add error states.
7. **Phase 5** — the portal signature flow.
8. **Phase 6** — docs and tests.

## 11. Risk register

| Risk | Mitigation |
|---|---|
| Write-through drift when the mirror call fails after a landed tx | `mirrored: false` in the response, visible in the UI, plus `POST /admin/sync/reconcile`. |
| Public RPC log-range caps break `resolveIdentity` under load | Bound the window (§7.6); until then a 502 correctly falls back to local SQLite rather than denying. |
| Staging indexer (`staging-graphql.ens.dev`) disappears mid-demo | Perimeter discovery has no fallback today. Either add a real one that respects `branchLabel`, or cache the perimeter list server-side. |
| 20-token bcrypt cap silently 401s the mirror | Keep live tokens under 20 until `auth.py` is fixed. |
| `db._migrate()` rebuilds `users` silently on a failed copy | `ALTER TABLE` only; never re-trigger the rebuild path. |
| Demo key in `.env` / `.env.local` | Both verified gitignored and never committed. Rotate before any public demo anyway. |
