# VLAN Read-Only Wallet Identity — Design

**Date:** 2026-09-26
**Status:** Draft for review
**Relationship:** A new subsystem alongside the read-only console (`docs/superpowers/specs/2026-09-26-ens-identity-vlan-design.md`) and the write path (`docs/superpowers/specs/2026-09-26-ens-write-path-design.md`). It reuses the console's `/api/ens/resolve` route and the proxy's session store; it changes neither contracts nor the write path.

## Goal

On any device joined to the VLAN, in any dapp, a person's wallet appears **already connected and read-only** — no browser extension, no QR scan, no per-device pairing, no signing. The wallet is the OWNER address of the person's ENS subdomain (e.g. `philo.tokyo.ethglobal2.eth`); "multiple wallets" means the person holds several such member names, each with its own owner address. Read calls (balances, `eth_call`, chain metadata) are answered; every signing request is rejected.

The identity binding is `VLAN session (client source IP) → subdomain owner address`. The proxy already stores this mapping per session and already resolves ENS identity; this feature announces that address to dapps and enforces read-only at the RPC boundary.

## The Governing Invariant

**The announced wallet can never sign. This is enforced twice, and the enforcement is the guarantee — not the UI.**

- The injected provider (client) rejects every signing method locally: `eth_sendTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData` (all versions), and every `wallet_*` mutation, throwing EIP-1193 error `4200` (unsupported method) before any request leaves the page.
- The proxy RPC endpoint (server) independently rejects the same method set with a JSON-RPC error, so a caller that bypasses the provider still cannot sign. The proxy is the source of truth; the provider's rejection is a fast-path convenience.

A read-only wallet that could be tricked into signing is the whole failure this feature must not have. Both layers reject from a single shared allowlist of read methods, so the two cannot drift.

## The Two Layers

The feature is two layers because "any dapp on any device" has two distinct reaches:

### Layer 1 — Served / proxied pages (script only, no cert)

Any page WE serve or proxy carries our provider script. At load, the script fires `eip6963:announceProvider`; the dapp's connect modal lists our wallet (EIP-6963 is supported by Aave and other major dapps); the user clicks it; the owner address shows as connected. Read RPC is forwarded through the proxy; signing is rejected. This works today with zero device setup — it is pure JavaScript in a page whose HTML we control.

This covers: our own demo/portal page, and any third-party dapp loaded **through our proxy origin** (we serve its HTML, so we can inject the script and strip `X-Frame-Options`/CSP on the way through).

### Layer 2 — Cert-injection into cold third-party tabs (VLAN TLS interception)

To make the wallet appear when the person opens `app.aave.com` **cold in their own browser** (a tab we did not serve), the VLAN's TLS-intercepting proxy must be trusted by the device. With a device-trusted root CA, the proxy terminates TLS for any HTTPS page and injects the same provider script into the returned HTML — so the identical wallet appears in the real dapp, not only in pages we host.

This requires a **one-time manual CA install per device** (there is no browser/JS API to install or prompt for a CA — that wall is deliberate and universal). The feature therefore ships a **cert-setup page**: a served page with copy-paste-accurate, per-platform instructions (iOS, Android, macOS, Windows) plus the downloadable CA, so a person on the VLAN can trust the proxy once and then browse any dapp with the wallet present.

## Settled Architectural Choices

1. **Wallet address source:** the OWNER of the person's ENS subdomain, one address per subdomain. Resolved via the existing `GET /api/ens/resolve?name=<subdomain>` route (`web/app/api/ens/resolve/route.ts` → `resolveIdentity`), which returns `{ owner, name, role, entitlements, ... }`. No new resolution logic.
2. **Session → identity:** VLAN client source IP. The proxy's `sessions` table already stores `ip`, `ens_name`, and `wallet_address` per session (`proxy/proxy.py`, `_session_dict`). The announce endpoint reads the active session for the request's source IP and returns its `wallet_address`. No device login, no cookie.
3. **Provider interface:** EIP-1193 provider announced via EIP-6963 (`eip6963:announceProvider` + response to `eip6963:requestProvider`). No WalletConnect, no extension, no QR.
4. **Read/reject boundary:** a single shared allowlist of read-only JSON-RPC methods. The provider rejects non-allowlisted methods client-side; the proxy rejects them server-side. Read calls are forwarded to the Sepolia RPC (`RPC_URL` in `web/lib/ens/config.ts`, chain `11155111`).
5. **Cert layer is a manual one-time device trust.** No attempt to auto-install or prompt for the CA (impossible by design). The setup page documents the manual OS steps per platform and serves the CA for download.
6. **Test target:** the author's own WiFi + device, using the Sepolia **test** key already in the deploy environment. The test key is env-only — never written to repo, ledger, spec, or plan.

## Grounded Facts (verified against the worktree)

- `proxy/proxy.py` `/proxy/<slug>` authenticates by `request.remote_addr`, looks up the active session for that IP, then forwards via `upstream.forward`. This is the exact chokepoint pattern the RPC endpoint mirrors: source-IP → session → forward-or-reject.
- The `sessions` table columns `ip`, `ens_name`, `wallet_address` exist and are returned by `_session_dict` (proxy.py:109-123) and `internal_get_session` (proxy.py:1326-1334). Session creation already accepts `wallet_address` (proxy.py:1271-1312).
- `_resolve_via_ens` (proxy.py:1195-1219) already calls `ENSCA_WEB_URL + "/api/ens/resolve"`. The announce endpoint reuses this route; `resolveIdentity` returns `owner`.
- `GET /api/ens/resolve?name=<name>` returns `200` with `{ owner, ... }`, `404` for no membership (definite deny), `502` on read failure (fall back, never silent deny) — the `force-dynamic` try/catch→status pattern in `web/app/api/ens/resolve/route.ts`.
- `RPC_URL` and `SEPOLIA_CHAIN_ID = 11155111` are in `web/lib/ens/config.ts`. `organization: "ethglobal2.eth"`, default perimeter `tokyo.ethglobal2.eth`.
- This feature touches **proxy (Python/Flask) + web (Next.js 16) + a browser provider script**. It writes no Solidity, so the `@ens-v2` submodule / `forge build` blocker that gates the write path does NOT gate this feature.
- Web code: `web/AGENTS.md` — "This is NOT the Next.js you know"; read `node_modules/next/dist/docs/` before writing any web code.

## Components & Data Flow

### The read-only provider script (`web/public/wallet/provider.js` or served asset)

A self-contained EIP-1193 provider, no bundler dependency, injectable both by our served pages (`<script>`) and by the proxy (Layer 2 injection into arbitrary HTML).

- On load: announce via EIP-6963 with provider `info` (name "VLAN Read-Only Wallet", a stable `uuid`, an `icon` data-URI, `rdns` e.g. `eth.ethglobal2.readonly`), and respond to `eip6963:requestProvider`.
- `request({ method, params })`:
  - `eth_requestAccounts` / `eth_accounts`: fetch the announce endpoint (`GET /api/wallet/account`, proxied through our origin so the source IP is the VLAN client) → return `[owner]`. Cache for the page's life.
  - `eth_chainId` / `net_version`: return the Sepolia id (`0xaa36a7` / `11155111`).
  - Read methods on the allowlist (`eth_call`, `eth_getBalance`, `eth_getCode`, `eth_getTransactionCount`, `eth_getBlockByNumber`, `eth_estimateGas`, `eth_gasPrice`, `eth_getLogs`, `eth_getTransactionReceipt`, `eth_blockNumber`, and the rest of the read set): forward to `POST /api/wallet/rpc` (proxied → Sepolia RPC).
  - Anything else, and every signing/mutation method: throw EIP-1193 `{ code: 4200, message: "read-only wallet: <method> not permitted" }`.
- Emit `connect` and `accountsChanged([owner])` so dapps that listen render the connected state.

### The account endpoint (`GET /api/wallet/account`)

Resolves the request's source IP → active session → `wallet_address`; returns `{ address, name }` or `404` if no session. **It lives on the proxy (Flask, port 8081), not the web origin.** The proxy is the only tier that sees the true VLAN source IP (`request.remote_addr`); the web origin sits behind the proxy, so a request reaching it does not carry the client's VLAN IP. Placing the endpoint anywhere but the proxy would force forwarding the source IP as a header, which a client could forge — defeating the source-IP binding. The endpoint reuses the same session lookup pattern as `/proxy/<slug>` (`SELECT ... FROM sessions WHERE ip=? AND logged_out_at IS NULL AND revoked_at IS NULL`), reads `wallet_address`, and — when that column is absent for a session — falls back to `_resolve_via_ens(ens_name)` → the `owner` field. The provider fetches it through the proxy origin so the request carries the VLAN source IP.

### The RPC endpoint (`POST /api/wallet/rpc`)

- Lives on the proxy for the same reason (a signing rejection is only trustworthy where the request cannot be laundered around it). Accepts a JSON-RPC request (or batch). For each call: if `method` is on the shared read allowlist, forward to `RPC_URL` and return the result; otherwise return JSON-RPC error `{ code: -32601-family, message: "method not permitted (read-only)" }`. Never forwards a signing method regardless of what the provider sent.
- The allowlist is the single shared source of truth with the provider, so the two enforcement points cannot diverge. Since both endpoints are on the proxy (Python) and the provider is browser JavaScript, the shared allowlist is defined once and served to the provider (or generated into it at build), never hand-copied into two languages.

### The proxy injection (Layer 2)

The TLS-intercepting proxy, for HTML responses, injects `<script src="…/provider.js"></script>` before `</head>` and strips framing/CSP headers that would block the announce. Read/reject still runs through `/api/wallet/rpc`; injection only places the script into pages we did not originally serve.

### The cert-setup page (`/wallet/setup` or similar served page)

Per-platform (iOS / Android / macOS / Windows) manual CA-trust instructions and the CA download. Accurate to each OS's real steps (e.g. iOS: install profile in Settings, then enable under General → About → Certificate Trust Settings; Android: install as a user CA, Chrome-only, no native webview). States plainly that this is a one-time manual OS operation with no shortcut, and that without it the wallet appears only in pages served through the VLAN portal (Layer 1).

## Error Handling

- **No active session for the source IP:** `/api/wallet/account` → `404`; the provider announces but `eth_requestAccounts` returns an empty array, so the dapp shows "no account" rather than a wrong one. Never invent an address.
- **`/api/ens/resolve` unreachable (`502`) vs. no membership (`404`):** the account endpoint must distinguish them — a `502` is "cannot tell", surfaced as a transient error the provider retries; a `404` is a definite "this session's subdomain holds no membership", surfaced as no account. A partial answer must never look like a positive account.
- **RPC upstream failure:** `/api/wallet/rpc` returns a JSON-RPC error with the upstream detail; the provider propagates it so the dapp shows a read error, not a fabricated result.
- **Signing attempt:** rejected at both layers with a clear read-only message; never silently dropped, so the dapp can show the user why.
- **Cert not installed (Layer 2):** cold third-party tabs simply do not show the wallet; the setup page is the remedy. This is a documented limitation, not a runtime error.

## Testing

- **Provider unit tests:** `eth_accounts` returns the resolved owner; each read method forwards; every signing method throws `4200`; `eth_chainId` returns Sepolia. The signing-rejection test enumerates the full mutation set so a newly added signing method is not silently allowed.
- **RPC endpoint tests:** allowlisted method forwards (mocked upstream); non-allowlisted / signing method returns the JSON-RPC error without forwarding; batch with a mixed set rejects only the disallowed calls.
- **Account endpoint tests:** source IP with an active session returns its `wallet_address`; no session → `404`; `resolve` `502` → transient error (not an account); `resolve` `404` → no account.
- **Allowlist-drift test:** a single test asserts the provider's allowlist and the endpoint's allowlist are the same set, so the two enforcement points cannot diverge.
- **Live browser check (author's WiFi + device, Sepolia test key):** join the VLAN; open a served page → wallet auto-listed in the EIP-6963 modal, click → owner address shows, a balance/`eth_call` read succeeds, a signing attempt is refused. Then, with the CA installed per the setup page, open a real dapp cold → same wallet appears. If live cert-injection cannot be fully exercised on a given platform, say so rather than claim success.

## Build Order (relative to the write path)

This feature is built **before** the ENS write-path setup, per the decision to have the read-only wallet + cert-setup page first. It does not depend on the write path and does not touch contracts.

## Non-Goals

- No signing, ever — no "approve once" path, no session-scoped signing.
- No WalletConnect, no browser extension, no QR pairing, no per-device login.
- No automatic CA install or in-browser CA prompt (impossible by design; the setup page documents the manual step).
- No change to the ENS contracts or the write path.
- No new ENS resolution logic — the existing `/api/ens/resolve` + `resolveIdentity` are reused as-is.
- Multiple owner addresses per single subdomain (one subdomain = one owner; a person's several wallets are several subdomains).
