# VLAN Read-Only Wallet Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Announce a VLAN session's ENS-subdomain owner address as an already-connected, read-only EIP-1193/EIP-6963 wallet in any dapp — reads forwarded to Sepolia, every signing method rejected — with a proxy cert-injection layer + per-platform cert-setup page for cold third-party tabs.

**Architecture:** A browser provider script (served static asset) announces via EIP-6963 and routes `eth_accounts`/reads to two proxy endpoints; the proxy (Flask, port 8081) owns both endpoints because only it sees the true VLAN source IP. Read enforcement is duplicated — provider rejects signing client-side, proxy RPC endpoint drops it server-side — from one shared read-method allowlist. Layer 2 injects the same script into cold HTTPS tabs via a device-trusted TLS-intercepting proxy, documented by a served setup page.

**Tech Stack:** Python/Flask + pytest (proxy), Next.js 16.3.6 + viem + vitest (web), plain browser JS (provider script). No Solidity.

**Spec:** `docs/superpowers/specs/2026-09-26-ens-readonly-wallet-vlan-design.md`

## Global Constraints

- **Secrets are env-only.** The Sepolia test private key, any Alchemy key, and any WalletConnect projectId are NEVER written to repo, plan, spec, or test files. Tests use fakes.
- **Next 16 is not the Next.js you know.** Before writing ANY file under `web/`, read the relevant guide in `web/node_modules/next/dist/docs/` (resolved from `web/`, per `web/AGENTS.md`). This is a step in every web task.
- **Git in this worktree:** plain separate git commands only — no compound/chained git. No force-push. Commit on the personal github.com identity (already set local: `110274378+Philotheephilix@users.noreply.github.com`).
- **No Solidity.** This feature touches proxy (Python), web (Next.js), and one browser JS asset only.
- **Signing rejection is total.** `eth_sendTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData`, `eth_signTypedData_v1`, `eth_signTypedData_v3`, `eth_signTypedData_v4`, and every `wallet_*` mutation reject with EIP-1193 code `4200` in the provider AND are dropped by the proxy RPC endpoint. Signing-rejection tests enumerate the FULL set so a newly added signing method is not silently allowed.
- **Chain is Sepolia:** chainId `0xaa36a7` / `11155111`. Proxy forwards reads to `RPC_URL` (env `SEPOLIA_RPC_URL`, default `https://ethereum-sepolia-rpc.publicnode.com` — same default as `web/lib/ens/config.ts`).

## Review Focus

- **Batch JSON-RPC with mixed read + signing calls** — a dapp sends `[eth_call, eth_sendTransaction]` in one POST; the reads must be answered and only the signing call rejected, never the whole batch blindly forwarded or blindly refused. (Task 6.)
- **A signing method added to Ethereum later** — the allowlist is a positive list of reads, so anything unknown (including a future `eth_signFoo`) is rejected by default, and the enumerated signing test guards the known set. (Tasks 2, 3, 6.)
- **Source-IP spoof via a forwarded header** — the account/RPC endpoints must bind to `request.remote_addr` (the real VLAN IP the proxy sees), never a client-supplied `X-Forwarded-For`/`X-Real-IP`, or a client could claim another session's wallet. (Tasks 5, 6.)
- **Resolve unreachable vs. definite deny** — `_resolve_via_ens` returns `{"denied": True}` on 404 (no membership → no account) but `None` when the console is unreachable (transient → retryable error); the account endpoint must not collapse the two into "no account". (Task 5.)
- **Provider announce racing the dapp's `requestProvider`** — the provider must both fire `eip6963:announceProvider` at load AND listen for `eip6963:requestProvider` and re-announce, or a dapp that asked before the script loaded never sees the wallet. (Task 4.)
- **CSP surviving the header strip** — Layer 2 must strip response CSP/`X-Frame-Options` that would block the injected inline `<script>`; a `Content-Security-Policy` left in a header OR a `<meta http-equiv>` tag defeats injection silently. (Task 7.)

---

### Task 1: Add vitest to the web package

**Files:**
- Modify: `web/package.json` (add `vitest` devDependency + `test` script)
- Create: `web/vitest.config.ts`
- Create: `web/lib/wallet/__tests__/smoke.test.ts` (proves the runner works, deleted or kept as a trivial guard)

**Interfaces:**
- Consumes: nothing.
- Produces: `npx vitest run` (from `web/`) executes `*.test.ts` under `web/`. Later web tasks rely on this command and on `web/lib/wallet/` being the test home for provider logic.

- [ ] **Step 1: Read the Next 16 test guidance**

Read `web/node_modules/next/dist/docs/` for any testing note, and confirm vitest is compatible with this Next version. Do not skip — `web/AGENTS.md` requires it.

- [ ] **Step 2: Write the smoke test (failing — no runner yet)**

Create `web/lib/wallet/__tests__/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("vitest runner", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run it to verify the runner is absent**

Run: `cd web && npx vitest run 2>&1 | head -5`
Expected: FAIL — `vitest: command not found` or "Cannot find module 'vitest'".

- [ ] **Step 4: Add vitest and config**

Add to `web/package.json` `devDependencies`: `"vitest": "^3.2.4"`. Add to `scripts`: `"test": "vitest run"`. Create `web/vitest.config.ts`. The `@` alias is set here up front (vitest does NOT read tsconfig `paths` on its own) so later tasks can `import ... from "@/public/wallet/read-methods.json"` and it resolves under the runner:

```typescript
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
```

Then install: `cd web && npm install`. (`resolveJsonModule` is already `true` in `web/tsconfig.json`, so JSON imports type-check; the alias above makes them resolve under vitest too.)

- [ ] **Step 5: Run it to verify it passes**

Run: `cd web && npx vitest run`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts web/lib/wallet/__tests__/smoke.test.ts
```
```bash
git commit -m "test: add vitest runner to web for wallet provider tests"
```

---

### Task 2: Shared read-method allowlist + drift guard

**Files:**
- Create: `web/public/wallet/read-methods.json` (the single source of truth, served to the browser)
- Create: `web/lib/wallet/allowlist.ts` (loads the JSON for provider + tests)
- Create: `proxy/wallet_allowlist.py` (loads the SAME JSON for the proxy)
- Test: `web/lib/wallet/__tests__/allowlist.test.ts`, `proxy/tests/test_wallet_allowlist.py`

**Interfaces:**
- Consumes: vitest runner (Task 1).
- Produces:
  - `read-methods.json` shape: `{ "read": string[], "signing": string[] }` — `read` is the positive allowlist; `signing` is the enumerated reject set used only by tests to prove no signing method is on `read`.
  - `web/lib/wallet/allowlist.ts` exports `READ_METHODS: Set<string>`, `SIGNING_METHODS: Set<string>`, and `classify(method: string): "read" | "reject"` (reject = anything not in `READ_METHODS`).
  - `proxy/wallet_allowlist.py` exports `READ_METHODS: set[str]`, `SIGNING_METHODS: set[str]`, `is_read(method: str) -> bool` reading the same JSON file (path relative to repo root, resolved via `os.path`).

- [ ] **Step 1: Write the JSON source of truth**

Create `web/public/wallet/read-methods.json`:

```json
{
  "read": [
    "eth_chainId", "net_version", "eth_blockNumber", "eth_call",
    "eth_getBalance", "eth_getCode", "eth_getStorageAt",
    "eth_getTransactionCount", "eth_getBlockByNumber", "eth_getBlockByHash",
    "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getLogs",
    "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas",
    "eth_feeHistory", "eth_getProof"
  ],
  "signing": [
    "eth_sendTransaction", "eth_sendRawTransaction", "eth_sign",
    "personal_sign", "eth_signTransaction",
    "eth_signTypedData", "eth_signTypedData_v1",
    "eth_signTypedData_v3", "eth_signTypedData_v4",
    "wallet_addEthereumChain", "wallet_switchEthereumChain",
    "wallet_watchAsset", "wallet_requestPermissions",
    "wallet_grantPermissions", "wallet_sendCalls"
  ]
}
```

- [ ] **Step 2: Write the failing TS allowlist test**

Create `web/lib/wallet/__tests__/allowlist.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { READ_METHODS, SIGNING_METHODS, classify } from "../allowlist";

describe("wallet allowlist", () => {
  it("classifies a read method as read", () => {
    expect(classify("eth_call")).toBe("read");
  });
  it("rejects every enumerated signing method", () => {
    for (const m of SIGNING_METHODS) {
      expect(classify(m)).toBe("reject");
    }
  });
  it("rejects an unknown/future method by default", () => {
    expect(classify("eth_signFutureThing")).toBe("reject");
  });
  it("no signing method leaks into the read set", () => {
    for (const m of SIGNING_METHODS) {
      expect(READ_METHODS.has(m)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd web && npx vitest run lib/wallet/__tests__/allowlist.test.ts`
Expected: FAIL — cannot resolve `../allowlist`.

- [ ] **Step 4: Implement the TS loader**

Create `web/lib/wallet/allowlist.ts`:

```typescript
import methods from "@/public/wallet/read-methods.json";

export const READ_METHODS = new Set<string>(methods.read);
export const SIGNING_METHODS = new Set<string>(methods.signing);

export function classify(method: string): "read" | "reject" {
  return READ_METHODS.has(method) ? "read" : "reject";
}
```

The `@` alias resolves under vitest because Task 1's `vitest.config.ts` set `resolve.alias` for it, and `resolveJsonModule` is already on in `web/tsconfig.json`. No per-task judgment needed — run the test to confirm.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd web && npx vitest run lib/wallet/__tests__/allowlist.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Write the failing Python allowlist test**

Create `proxy/tests/test_wallet_allowlist.py`:

```python
import wallet_allowlist as wa


def test_read_method_is_read():
    assert wa.is_read("eth_call") is True


def test_every_signing_method_rejected():
    for m in wa.SIGNING_METHODS:
        assert wa.is_read(m) is False


def test_unknown_method_rejected():
    assert wa.is_read("eth_signFutureThing") is False


def test_no_signing_method_in_read_set():
    assert wa.READ_METHODS.isdisjoint(wa.SIGNING_METHODS)
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd proxy && python -m pytest tests/test_wallet_allowlist.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'wallet_allowlist'`.

- [ ] **Step 8: Implement the Python loader**

Create `proxy/wallet_allowlist.py`:

```python
import json
import os

# The single source of truth lives with the web app so the browser can fetch it;
# the proxy reads the same file so the two enforcement points cannot drift.
_PATH = os.path.join(
    os.path.dirname(__file__), "..", "web", "public", "wallet", "read-methods.json"
)

with open(_PATH) as f:
    _methods = json.load(f)

READ_METHODS = set(_methods["read"])
SIGNING_METHODS = set(_methods["signing"])


def is_read(method: str) -> bool:
    return method in READ_METHODS
```

- [ ] **Step 9: Run it to verify it passes**

Run: `cd proxy && python -m pytest tests/test_wallet_allowlist.py -v`
Expected: PASS — 4 tests.

- [ ] **Step 10: Commit**

```bash
git add web/public/wallet/read-methods.json web/lib/wallet/allowlist.ts web/lib/wallet/__tests__/allowlist.test.ts proxy/wallet_allowlist.py proxy/tests/test_wallet_allowlist.py
```
```bash
git commit -m "feat: shared read-method allowlist for wallet provider and proxy"
```

---

### Task 3: Provider request-routing + signing rejection (pure, node-tested)

**Files:**
- Create: `web/lib/wallet/handler.ts` (the pure, injectable-fetch request handler)
- Test: `web/lib/wallet/__tests__/handler.test.ts`

**Interfaces:**
- Consumes: `classify`, `READ_METHODS`, `SIGNING_METHODS` from `web/lib/wallet/allowlist.ts` (Task 2).
- Produces: `createHandler(opts: { chainIdHex: string; accountFetch: () => Promise<string[]>; rpcFetch: (body: unknown) => Promise<unknown> }) => (req: { method: string; params?: unknown[] }) => Promise<unknown>`. Local answers: `eth_chainId` → `opts.chainIdHex`, `net_version` → decimal string of it; `eth_accounts`/`eth_requestAccounts` → `opts.accountFetch()`. Reads → `opts.rpcFetch`. Reject → throws `{ code: 4200, message: "read-only wallet: <method> not permitted" }`. Task 4 wires the real fetches and the announce side effects around this.

- [ ] **Step 1: Write the failing handler test**

Create `web/lib/wallet/__tests__/handler.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createHandler } from "../handler";
import { SIGNING_METHODS } from "../allowlist";

const opts = () => ({
  chainIdHex: "0xaa36a7",
  accountFetch: vi.fn(async () => ["0xabc0000000000000000000000000000000000001"]),
  rpcFetch: vi.fn(async () => "0x64"),
});

describe("provider handler", () => {
  it("answers eth_chainId locally without touching rpc", async () => {
    const o = opts();
    const h = createHandler(o);
    expect(await h({ method: "eth_chainId" })).toBe("0xaa36a7");
    expect(o.rpcFetch).not.toHaveBeenCalled();
  });

  it("answers net_version as the decimal chain id", async () => {
    const h = createHandler(opts());
    expect(await h({ method: "net_version" })).toBe("11155111");
  });

  it("returns the fetched account for eth_accounts", async () => {
    const h = createHandler(opts());
    expect(await h({ method: "eth_accounts" })).toEqual([
      "0xabc0000000000000000000000000000000000001",
    ]);
  });

  it("forwards a read method to rpcFetch", async () => {
    const o = opts();
    const h = createHandler(o);
    await h({ method: "eth_getBalance", params: ["0xabc", "latest"] });
    expect(o.rpcFetch).toHaveBeenCalledWith({
      method: "eth_getBalance",
      params: ["0xabc", "latest"],
    });
  });

  it("throws 4200 for every enumerated signing method", async () => {
    const h = createHandler(opts());
    for (const m of SIGNING_METHODS) {
      await expect(h({ method: m })).rejects.toMatchObject({ code: 4200 });
    }
  });

  it("throws 4200 for an unknown method", async () => {
    const h = createHandler(opts());
    await expect(h({ method: "eth_signFutureThing" })).rejects.toMatchObject({
      code: 4200,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run lib/wallet/__tests__/handler.test.ts`
Expected: FAIL — cannot resolve `../handler`.

- [ ] **Step 3: Implement the handler**

Create `web/lib/wallet/handler.ts`:

```typescript
import { classify } from "./allowlist";

export type HandlerOpts = {
  chainIdHex: string;
  accountFetch: () => Promise<string[]>;
  rpcFetch: (body: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function createHandler(opts: HandlerOpts) {
  return async function handle(req: { method: string; params?: unknown[] }) {
    switch (req.method) {
      case "eth_chainId":
        return opts.chainIdHex;
      case "net_version":
        return String(parseInt(opts.chainIdHex, 16));
      case "eth_accounts":
      case "eth_requestAccounts":
        return opts.accountFetch();
    }
    if (classify(req.method) === "read") {
      return opts.rpcFetch({ method: req.method, params: req.params });
    }
    throw { code: 4200, message: `read-only wallet: ${req.method} not permitted` };
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run lib/wallet/__tests__/handler.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/wallet/handler.ts web/lib/wallet/__tests__/handler.test.ts
```
```bash
git commit -m "feat: read-only provider request handler with signing rejection"
```

---

### Task 4: Provider EIP-6963 announce + served demo page (Layer 1)

**Files:**
- Create: `web/public/wallet/provider.js` (the served, no-bundler EIP-1193/6963 provider)
- Create: `web/app/wallet/demo/page.tsx` (a served page that loads the provider so the wallet is testable in an EIP-6963 modal)
- Test: manual/visual browser check (documented in step) — the pure logic is already covered by Task 3; `provider.js` here is the DOM/announce shell.

**Interfaces:**
- Consumes: `createHandler` semantics from Task 3 (re-implemented in plain JS inside `provider.js` since the served asset has no bundler — it fetches `/wallet/read-methods.json` at load and applies the same `classify` rule), the account endpoint `GET /api/wallet/account` (Task 5), the RPC endpoint `POST /api/wallet/rpc` (Task 6). Those endpoints are on the proxy; the provider calls them relative to the current origin so the proxy sees the VLAN source IP.
- Produces: a `window`-side EIP-1193 provider announced via EIP-6963 with `info` `{ uuid: "8f3d1c60-2a4e-4b7a-9e11-6c0f2d5a7b31", name: "VLAN Read-Only Wallet", icon: <data-uri>, rdns: "eth.ethglobal2.readonly" }`. The `uuid` is this exact hardcoded literal — a fresh, stable per-page-load identifier assigned as a constant, NEVER `crypto.randomUUID()` (a regenerated uuid breaks EIP-6963 provider dedupe across re-announces).

- [ ] **Step 1: Read the Next 16 static-asset + page guidance**

Read `web/node_modules/next/dist/docs/` for `public/` static serving and the app-router page conventions in this version before creating the page.

- [ ] **Step 2: Write the provider script**

Create `web/public/wallet/provider.js`. It must:
- On load, kick off `const readyPromise = fetch("/wallet/read-methods.json").then(r => r.json()).then(j => new Set(j.read))` ONCE, storing the promise (not just the resolved set). `request()` for any classified method must `await readyPromise` before classifying, so a dapp calling `request()` before the JSON resolves is not mis-rejected — this closes the read-methods fetch race (distinct from the announce race). Apply the same classify rule as `handler.ts` (in the awaited read set → forward; else reject 4200). The `uuid` in `info` is the exact literal from the Interfaces block, assigned as a `const`, never `crypto.randomUUID()`.
- Implement `request({ method, params })`: `eth_chainId` → `"0xaa36a7"` and `net_version` → `"11155111"` answered immediately (no await needed); `eth_accounts`/`eth_requestAccounts` → `fetch("/api/wallet/account").then(r => r.ok ? r.json().then(j => [j.address]) : [])` (404/no session → `[]`, never a fabricated address); read methods → after `await readyPromise`, `POST /api/wallet/rpc` with `{ method, params }`, returning `result` or throwing on the JSON-RPC `error`; anything else → `throw { code: 4200, message: ... }`.
- Support EIP-1193 events: `on`/`removeListener`; emit `connect` with `{ chainId: "0xaa36a7" }` after the first successful account fetch, and `accountsChanged([address])`.
- Announce for EIP-6963: define `const info = {...}` and a `function announce(){ window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) })); }`; call `announce()` at load AND `window.addEventListener("eip6963:requestProvider", announce)` — covering the announce-vs-requestProvider race (Review Focus).

- [ ] **Step 3: Create the served demo page**

Create `web/app/wallet/demo/page.tsx` — a client page that includes `<script src="/wallet/provider.js" />` (or a `useEffect` that injects it) and renders a minimal EIP-6963 discovery panel: listen for `eip6963:announceProvider`, dispatch `eip6963:requestProvider`, list discovered providers, and on click call `provider.request({ method: "eth_requestAccounts" })` and show the returned address. This is the "open VE directly, announce the provider, click it, show the address" path.

- [ ] **Step 4: Manual browser check**

Run: `cd web && npm run dev`, open the demo page, confirm the "VLAN Read-Only Wallet" appears in the discovery panel, clicking it shows the account (empty until Task 5's endpoint exists — state that here), and that `provider.request({method:"personal_sign"})` in the console throws `4200`. Record what was and wasn't exercisable. If live account resolution isn't up yet, say so rather than claim success.

- [ ] **Step 5: Commit**

```bash
git add web/public/wallet/provider.js web/app/wallet/demo/page.tsx
```
```bash
git commit -m "feat: EIP-6963 read-only provider script and served demo page"
```

---

### Task 5: Proxy account endpoint (`GET /api/wallet/account`)

**Files:**
- Modify: `proxy/proxy.py` (add the route; reuse the `/proxy/<slug>` session-lookup pattern and `_resolve_via_ens`)
- Test: `proxy/tests/test_wallet_account.py`

**Interfaces:**
- Consumes: the sessions table (`ip`, `ens_name`, `wallet_address`), `_resolve_via_ens(ens_name)` (returns `{"denied": True}` on 404, `None` when unreachable, else JSON with `owner`).
- Produces: `GET /api/wallet/account` → `200 {"address": "0x..", "name": "<ens_name>"}` when an active session for `request.remote_addr` has a wallet; `404 {"error": "no_account"}` when the session's name definitely holds no membership OR there is no active session; `503 {"error": "resolve_unreachable"}` when the console cannot be reached (retryable — distinct from 404). Binds to `request.remote_addr` only.

- [ ] **Step 1: Write the failing tests**

Create `proxy/tests/test_wallet_account.py`, following the `_Resp`/`_client` pattern from `tests/test_ens_lookup_via_ens.py`:

```python
import os
import sqlite3
import tempfile
import time

import db as dbmod
from seed_ens import seed


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _client(monkeypatch, web_url="http://console.test"):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    conn = sqlite3.connect(path)
    seed(conn)
    import proxy
    proxy.app.config["TESTING"] = True
    monkeypatch.setattr(proxy, "ENSCA_WEB_URL", web_url)
    return proxy, proxy.app.test_client(), conn


def _add_session(conn, ip, ens_name, wallet_address):
    # sessions.user_id and group_id are NOT NULL REFERENCES with foreign_keys=ON
    # (proxy/db.py), so the user row MUST exist before the session row is inserted.
    gid = conn.execute("SELECT id FROM groups LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT OR IGNORE INTO users(id,username,password_hash,default_group_id,created_at) "
        "VALUES('sess-user','sess-user','!',?,?)",
        (gid, int(time.time())),
    )
    conn.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,ens_name,wallet_address,logged_in_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("sess-1", "sess-user", gid, ip, "hacker", ens_name, wallet_address, int(time.time())),
    )
    conn.commit()


def test_returns_wallet_for_active_session(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.5", "philo.tokyo.ethglobal2.eth", "0xOWNER")
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.5"})
    assert r.status_code == 200
    assert r.get_json()["address"] == "0xOWNER"


def test_no_session_is_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.9"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "no_account"


def test_falls_back_to_resolve_owner_when_session_lacks_wallet(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.6", "leo.tokyo.ethglobal2.eth", None)
    monkeypatch.setattr(
        proxy.req_lib, "get",
        lambda *a, **k: _Resp(200, {"owner": "0xRESOLVED", "name": "leo.tokyo.ethglobal2.eth"}),
    )
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.6"})
    assert r.status_code == 200
    assert r.get_json()["address"] == "0xRESOLVED"


def test_resolve_404_is_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.7", "ghost.tokyo.ethglobal2.eth", None)
    monkeypatch.setattr(proxy.req_lib, "get", lambda *a, **k: _Resp(404))
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.7"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "no_account"


def test_resolve_unreachable_is_retryable_not_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.8", "leo.tokyo.ethglobal2.eth", None)

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(proxy.req_lib, "get", boom)
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.8"})
    assert r.status_code == 503
    assert r.get_json()["error"] == "resolve_unreachable"


def test_ignores_forwarded_header_spoof(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.5", "philo.tokyo.ethglobal2.eth", "0xOWNER")
    # Attacker on .99 forges XFF claiming .5 — must NOT get .5's wallet.
    r = c.get(
        "/api/wallet/account",
        environ_overrides={"REMOTE_ADDR": "10.0.0.99"},
        headers={"X-Forwarded-For": "10.0.0.5", "X-Real-IP": "10.0.0.5"},
    )
    assert r.status_code == 404
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd proxy && python -m pytest tests/test_wallet_account.py -v`
Expected: FAIL — route `/api/wallet/account` returns 404 from Flask's default (no route) for the positive cases; assertion failures confirm the endpoint is missing.

- [ ] **Step 3: Implement the route in `proxy/proxy.py`**

Add near the `/proxy` section (after the imports already present — `_resolve_via_ens`, `req_lib`, `get_db` are in scope):

```python
@app.route("/api/wallet/account")
def wallet_account():
    ip = request.remote_addr  # the real VLAN source IP; never a forwarded header
    db = get_db()
    session = db.execute(
        "SELECT * FROM sessions WHERE ip=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (ip,)
    ).fetchone()
    if not session:
        return jsonify({"error": "no_account"}), 404

    wallet = _col(session, "wallet_address")
    if wallet:
        return jsonify({"address": wallet, "name": _col(session, "ens_name")})

    ens_name = _col(session, "ens_name")
    if not ens_name:
        return jsonify({"error": "no_account"}), 404

    resolved = _resolve_via_ens(ens_name)
    if resolved is None:
        # Could not ask — retryable, not a deny.
        return jsonify({"error": "resolve_unreachable"}), 503
    if resolved.get("denied"):
        return jsonify({"error": "no_account"}), 404
    owner = resolved.get("owner")
    if not owner:
        return jsonify({"error": "no_account"}), 404
    return jsonify({"address": owner, "name": ens_name})
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd proxy && python -m pytest tests/test_wallet_account.py -v`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add proxy/proxy.py proxy/tests/test_wallet_account.py
```
```bash
git commit -m "feat: proxy wallet account endpoint bound to VLAN source IP"
```

---

### Task 6: Proxy RPC endpoint (`POST /api/wallet/rpc`) — read forward + signing drop

**Files:**
- Modify: `proxy/proxy.py` (add the route; forward reads to `RPC_URL` via `req_lib.request`)
- Test: `proxy/tests/test_wallet_rpc.py`

**Interfaces:**
- Consumes: `wallet_allowlist.is_read` (Task 2), `req_lib` (already imported as `requests`), `RPC_URL` (add `WALLET_RPC_URL = os.environ.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")` at module scope).
- Produces: `POST /api/wallet/rpc` accepting a single JSON-RPC object or a batch array. Read calls forwarded to `WALLET_RPC_URL`; non-read calls answered in place with JSON-RPC error `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32601,"message":"method not permitted (read-only)"}}` and NEVER forwarded. A batch is split: each element handled independently, results returned in a batch array.

- [ ] **Step 1: Write the failing tests**

Create `proxy/tests/test_wallet_rpc.py`:

```python
import os
import sqlite3
import tempfile

import db as dbmod
from seed_ens import seed
from wallet_allowlist import SIGNING_METHODS


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    seed(sqlite3.connect(path))
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy, proxy.app.test_client()


def test_read_method_is_forwarded(monkeypatch):
    proxy, c = _client(monkeypatch)
    called = {}

    def fake_request(method, url, **k):
        called["url"] = url
        called["json"] = k.get("json")
        return _Resp(200, {"jsonrpc": "2.0", "id": 1, "result": "0x64"})

    monkeypatch.setattr(proxy.req_lib, "request", fake_request)
    r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": ["0xabc", "latest"]})
    assert r.status_code == 200
    assert r.get_json()["result"] == "0x64"
    assert called["json"]["method"] == "eth_getBalance"


def test_signing_method_is_not_forwarded(monkeypatch):
    proxy, c = _client(monkeypatch)

    def must_not_call(*a, **k):
        raise AssertionError("signing method must never reach upstream")

    monkeypatch.setattr(proxy.req_lib, "request", must_not_call)
    for m in SIGNING_METHODS:
        r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 7, "method": m, "params": []})
        assert r.status_code == 200
        body = r.get_json()
        assert body["error"]["code"] == -32601
        assert "id" in body and body["id"] == 7


def test_unknown_method_rejected(monkeypatch):
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(proxy.req_lib, "request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no forward")))
    r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 1, "method": "eth_signFutureThing"})
    assert r.get_json()["error"]["code"] == -32601


def test_batch_splits_read_and_signing(monkeypatch):
    proxy, c = _client(monkeypatch)

    def fake_request(method, url, **k):
        return _Resp(200, {"jsonrpc": "2.0", "id": k["json"]["id"], "result": "0x1"})

    monkeypatch.setattr(proxy.req_lib, "request", fake_request)
    r = c.post("/api/wallet/rpc", json=[
        {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": []},
        {"jsonrpc": "2.0", "id": 2, "method": "eth_sendTransaction", "params": []},
    ])
    out = r.get_json()
    assert isinstance(out, list) and len(out) == 2
    by_id = {o["id"]: o for o in out}
    assert by_id[1]["result"] == "0x1"
    assert by_id[2]["error"]["code"] == -32601
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd proxy && python -m pytest tests/test_wallet_rpc.py -v`
Expected: FAIL — no `/api/wallet/rpc` route.

- [ ] **Step 3: Implement the route**

Add `import wallet_allowlist` at the top of `proxy.py` and `WALLET_RPC_URL = os.environ.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")` at module scope, then:

```python
def _handle_rpc_call(call):
    rpc_id = call.get("id") if isinstance(call, dict) else None
    method = call.get("method") if isinstance(call, dict) else None
    if not method or not wallet_allowlist.is_read(method):
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": {"code": -32601, "message": "method not permitted (read-only)"}}
    try:
        resp = req_lib.request("POST", WALLET_RPC_URL, json=call, timeout=30, verify=True)
        return resp.json()
    except Exception as e:
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": {"code": -32000, "message": f"upstream error: {str(e)[:120]}"}}


@app.route("/api/wallet/rpc", methods=["POST"])
def wallet_rpc():
    payload = request.get_json(silent=True)
    if isinstance(payload, list):
        return jsonify([_handle_rpc_call(c) for c in payload])
    if isinstance(payload, dict):
        return jsonify(_handle_rpc_call(payload))
    return jsonify({"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32600, "message": "invalid request"}}), 400
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd proxy && python -m pytest tests/test_wallet_rpc.py -v`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add proxy/proxy.py proxy/tests/test_wallet_rpc.py
```
```bash
git commit -m "feat: proxy wallet RPC endpoint forwards reads, drops signing"
```

---

### Task 7: Layer 1/2 — proxy HTML script injection + CSP/frame header strip, wired into `/proxy/<slug>`

**Files:**
- Modify: `proxy/upstream.py` (add `inject_provider`; extend `forward` to surface the upstream `Content-Type` so the route can decide whether to inject)
- Modify: `proxy/proxy.py` (call `inject_provider` on the `/proxy/<slug>` response so pages served THROUGH our proxy origin carry the provider — spec §Layer 1 "any third-party dapp loaded through our proxy origin")
- Test: `proxy/tests/test_wallet_inject.py`

**Interfaces:**
- Consumes: `forward(resource, method, subpath, incoming_req)` (Task-independent, exists today) currently returns the 6-tuple `(content, status, req_bytes, resp_bytes, duration_ms, upstream_error)` and drops the upstream response headers. This task extends it to a 7-tuple, appending `content_type: str | None` (the upstream `Content-Type` header, or `None`). Every existing caller of `forward` in `proxy.py` must be updated to unpack 7 values.
- Produces:
  - `inject_provider(content: bytes, content_type: str, headers: dict) -> tuple[bytes, dict]` — when `content_type` starts with `text/html`, inserts `<script src="<PROVIDER_URL>"></script>` before `</head>` (or at document start if no `</head>`), and removes `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, and `X-Frame-Options` from `headers`. `PROVIDER_URL = os.environ.get("WALLET_PROVIDER_URL", "/wallet/provider.js")`. Non-HTML content is returned unchanged (headers returned as-is).
  - The `/proxy/<slug>` route calls `inject_provider` on the forwarded body+content-type when `WALLET_INJECT` is enabled (`os.environ.get("WALLET_INJECT") == "1"`, default off so existing API-proxy behavior is unchanged), preserving the injected `Content-Type` on the returned `Response`.

Wiring note: Layer 1 (this task) injects into pages we serve through `/proxy/<slug>`. Layer 2 (cold third-party tabs) reuses the same `inject_provider` helper from the TLS-intercepting listener that exists only on the VLAN host at deploy — that listener is out of scope for a unit test and is exercised in the final E2E. This task makes the helper live on a real forward path (Layer 1), not merely unit-tested.

- [ ] **Step 1: Write the failing tests**

Create `proxy/tests/test_wallet_inject.py`:

```python
from upstream import inject_provider


def test_injects_script_before_head_close():
    html = b"<html><head><title>x</title></head><body>hi</body></html>"
    out, headers = inject_provider(html, "text/html; charset=utf-8", {})
    assert b"/wallet/provider.js" in out
    assert out.index(b"provider.js") < out.index(b"</head>")


def test_strips_csp_and_frame_headers():
    html = b"<html><head></head></html>"
    hdrs = {"Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY", "Content-Type": "text/html"}
    out, headers = inject_provider(html, "text/html", hdrs)
    assert "Content-Security-Policy" not in headers
    assert "X-Frame-Options" not in headers


def test_non_html_is_untouched():
    data = b'{"ok":true}'
    out, headers = inject_provider(data, "application/json", {"Content-Type": "application/json"})
    assert out == data


def test_html_without_head_still_injects():
    html = b"<html><body>hi</body></html>"
    out, headers = inject_provider(html, "text/html", {})
    assert b"/wallet/provider.js" in out
```

Then add the wiring test in the same file. It uses the existing proxy test idiom (`_client`, `seed`, monkeypatching `req_lib`/upstream) so it exercises the live `/proxy/<slug>` path, not just the helper:

```python
import os
import sqlite3
import tempfile
import time

import db as dbmod
from seed_ens import seed


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    conn = sqlite3.connect(path)
    seed(conn)
    # a resource + a session with access, mirroring the /proxy/<slug> preconditions
    gid = conn.execute("SELECT id FROM groups LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,enabled,created_at) "
        "VALUES('res-1','demo','Demo','http://upstream.test','no_auth',1,?)",
        (int(time.time()),),
    )
    conn.execute(
        "INSERT INTO group_resource_limits(group_id,resource_id) VALUES(?, 'res-1')", (gid,)
    )
    conn.execute(
        "INSERT OR IGNORE INTO users(id,username,password_hash,default_group_id,created_at) "
        "VALUES('u1','u1','!',?,?)",
        (gid, int(time.time())),
    )
    conn.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,logged_in_at) "
        "VALUES('s1','u1',?, '127.0.0.1','hacker',?)",
        (gid, int(time.time())),
    )
    conn.commit()

    import proxy

    proxy.app.config["TESTING"] = True
    return proxy, proxy.app.test_client()


def test_proxy_injects_provider_into_html_when_enabled(monkeypatch):
    monkeypatch.setenv("WALLET_INJECT", "1")
    proxy, c = _client(monkeypatch)
    # forward returns the 7-tuple: content, status, req_b, resp_b, dur, err, content_type
    monkeypatch.setattr(
        proxy, "forward",
        lambda *a, **k: (b"<html><head></head><body>x</body></html>", 200, 0, 22, 1, None, "text/html; charset=utf-8"),
    )
    r = c.get("/proxy/demo", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 200
    assert b"/wallet/provider.js" in r.data


def test_proxy_leaves_non_html_untouched(monkeypatch):
    monkeypatch.setenv("WALLET_INJECT", "1")
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(
        proxy, "forward",
        lambda *a, **k: (b'{"ok":true}', 200, 0, 11, 1, None, "application/json"),
    )
    r = c.get("/proxy/demo", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.data == b'{"ok":true}'
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd proxy && python -m pytest tests/test_wallet_inject.py -v`
Expected: FAIL — `ImportError: cannot import name 'inject_provider'` (helper tests) and a tuple-unpacking / missing-injection failure (wiring tests).

- [ ] **Step 3: Implement `inject_provider` in `proxy/upstream.py`**

```python
import os

PROVIDER_URL = os.environ.get("WALLET_PROVIDER_URL", "/wallet/provider.js")
_CSP_HEADERS = ("content-security-policy", "content-security-policy-report-only", "x-frame-options")


def inject_provider(content: bytes, content_type: str, headers: dict) -> tuple:
    if not content_type or not content_type.lower().startswith("text/html"):
        return content, headers
    stripped = {k: v for k, v in headers.items() if k.lower() not in _CSP_HEADERS}
    tag = f'<script src="{PROVIDER_URL}"></script>'.encode()
    lower = content.lower()
    idx = lower.find(b"</head>")
    if idx != -1:
        injected = content[:idx] + tag + content[idx:]
    else:
        injected = tag + content
    return injected, stripped
```

- [ ] **Step 3b: Extend `forward` to surface the upstream `Content-Type`**

`forward` currently returns a 6-tuple and drops the upstream headers. In `proxy/upstream.py`, capture the content-type and append it, so the route can decide whether to inject. Change every `return` in `forward` to add the content-type as the 7th element:

- Success return (after `resp_bytes = len(content)`): `return content, resp.status_code, req_bytes, resp_bytes, duration_ms, None, resp.headers.get("Content-Type")`
- The `413` early return: append `, None`.
- Each of the three exception returns (`502`): append `, None`.

Then update the docstring's `Returns` line to name the 7th element `content_type`.

- [ ] **Step 3c: Wire `inject_provider` into `/proxy/<slug>`**

Extend the existing `from upstream import` line in `proxy/proxy.py` to also import `inject_provider`. Update the `forward` unpack in the `/proxy/<slug>` route to 7 values and inject before building the `Response`. Read the `WALLET_INJECT` flag **live from the environment inside the route** — do NOT capture it in a module-scope constant, because `proxy` is imported once per `pytest` session and a module constant would freeze to whatever the env was at first import (an earlier sibling test importing `proxy` freezes it off, so a later `monkeypatch.setenv` has no effect and the wiring test fails order-dependently):

```python
content, status, req_bytes, resp_bytes, duration_ms, upstream_error, content_type = forward(
    dict(resource), request.method, subpath, request
)

record_event(db, session["id"], ip, group_id, resource["id"],
             request.method, subpath, status, upstream_error,
             req_bytes, resp_bytes, duration_ms)

if content is None:
    return jsonify({"error": "upstream_unreachable", "detail": upstream_error}), status

resp_headers = {}
if content_type:
    resp_headers["Content-Type"] = content_type
if os.environ.get("WALLET_INJECT") == "1":
    content, resp_headers = inject_provider(content, content_type or "", resp_headers)

return Response(content, status=status, headers=resp_headers)
```

Note: the live env-read (not a module constant) means every existing proxy/API test still sees the untouched body, `monkeypatch.setenv("WALLET_INJECT", "1")` takes effect regardless of import order, and only when the flag is set (the wallet-portal deployment) does HTML get the script. Layer 2 (cold third-party tabs) calls the same `inject_provider` from the TLS listener on the VLAN host at deploy — out of scope for these unit tests, exercised in the final E2E.

- [ ] **Step 4: Run to verify they pass**

Run: `cd proxy && python -m pytest tests/test_wallet_inject.py -v`
Expected: PASS — 6 tests (4 helper + 2 wiring).

- [ ] **Step 4b: Run the full proxy suite to confirm the 7-tuple change broke nothing**

Run: `cd proxy && python -m pytest -v`
Expected: PASS — every existing `/proxy/<slug>` / forward test still green (they unpack via the route, and `WALLET_INJECT` defaults off).

- [ ] **Step 5: Commit**

```bash
git add proxy/upstream.py proxy/proxy.py proxy/tests/test_wallet_inject.py
```
```bash
git commit -m "feat: proxy HTML provider-script injection wired into /proxy, CSP/frame strip"
```

---

### Task 8: Cert-setup page (per-platform CA trust)

**Files:**
- Create: `web/app/wallet/setup/page.tsx`
- Test: manual/visual check (no component test harness in web; vitest is node-env). State this explicitly.

**Interfaces:**
- Consumes: nothing (content page). Links to the CA download served by the VLAN host (path stated on the page, e.g. `/wallet/ca.crt` — the actual CA file is provisioned on the host at deploy, never committed).
- Produces: a served page at `/wallet/setup` with four platform sections.

- [ ] **Step 1: Read the Next 16 page guidance**

Read `web/node_modules/next/dist/docs/` for app-router page + metadata conventions in this version.

- [ ] **Step 2: Write the page**

Create `web/app/wallet/setup/page.tsx` with four clearly separated sections — **iOS**, **Android**, **macOS**, **Windows** — each with accurate manual steps:
- **iOS:** download the CA profile → Settings → General → VPN & Device Management → install profile → then General → About → Certificate Trust Settings → toggle full trust on. State that both steps are required (install alone does not trust it).
- **Android:** Settings → Security → install as a **CA certificate** (user store); note it works in **Chrome only**, not native WebViews, and some apps ignore user CAs.
- **macOS:** download CA → open in Keychain Access (System keychain) → set to **Always Trust**.
- **Windows:** download CA → `certmgr` → import into **Trusted Root Certification Authorities**.
- A plain statement at top: this is a one-time manual OS operation with no browser shortcut; without it the wallet appears only in pages served through the VLAN portal (Layer 1).
- A download link to the CA (`/wallet/ca.crt`).

- [ ] **Step 3: Manual browser check**

Run: `cd web && npm run dev`, open `/wallet/setup`, confirm all four platform sections render with their steps and the download link is present. If actually trusting the CA + hitting a cold dapp can't be exercised in this environment, say so rather than claim it works.

- [ ] **Step 4: Commit**

```bash
git add web/app/wallet/setup/page.tsx
```
```bash
git commit -m "feat: per-platform CA cert-setup page for wallet layer 2"
```

---

## Notes for the executor

- **Full proxy suite** after Tasks 5–7: `cd proxy && python -m pytest -v` — confirm no existing ENS/session/rate-limit test regressed.
- **Full web suite** after Tasks 1–3: `cd web && npx vitest run`.
- **Live E2E** (author's WiFi + device, Sepolia test key, env-only) belongs to a separate verification pass, mirroring the write-path spec's Phase 6: join the VLAN, open the demo page → wallet auto-listed → click → owner address → a balance read succeeds → a signing attempt is refused; then set `WALLET_INJECT=1`, load a third-party dapp THROUGH the proxy origin (`/proxy/<slug>`) → the same wallet appears (Layer 1, now integration-tested in Task 7); then, with the CA installed per the setup page, open a real dapp cold → same wallet appears (Layer 2, TLS listener on the VLAN host, may not be fully exercisable on every platform — report honestly).
- The provider script (`provider.js`) duplicates the classify rule in plain JS because it ships without a bundler; the drift test (Task 2) plus the handler test (Task 3) pin the TS side, and `provider.js` fetches the same `read-methods.json` at runtime, so the JSON stays the single source of truth across all three consumers (TS lib, JS provider, Python proxy).
