# Wallet Layer 2 — TLS-Intercepting Provider Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject the existing EIP-6963 read-only wallet provider into cold, third-party HTTPS dapp tabs (Uniswap, Curve, Compound, etc.) opened directly in a VLAN device's browser, via a device-trusted TLS-intercepting proxy — so the wallet appears in real dapps, not only in pages served through `/proxy/<slug>`.

**Architecture:** A `mitmproxy` transparent listener on the VLAN host (`mitm/wallet_mitm.py` addon) terminates TLS for HTTPS tabs and, on HTML responses, injects a `<script>` tag for a **Layer-2 provider variant** whose three backend fetches point at ABSOLUTE proxy URLs (relative URLs would resolve to the intercepted dapp's own origin and 404). The proxy (Flask :8081) grows a static route serving `/wallet/*` assets — including the Layer-2 provider and the mitmproxy-generated CA — so VLAN clients have one reachable origin for provider + account + rpc + read-methods + CA, closing the "VM has no web service" gap. HSTS-preloaded and cert-pinned hosts (aave.com and the browser preload list) go in the addon's `ignore_hosts` so those tabs pass through untouched and still load. The portal adds a per-authed-IP `:443 → :8443` iptables REDIRECT in `grant_access` (removed in `revoke_access`) to steer client HTTPS into the listener.

**Tech Stack:** Python 3 / mitmproxy (9.0.1 local dev venv py3.9; 12.2.3 on VM py3.14 — addon `response`/`http_connect` hooks and `ignore_hosts`/`tls_version_client_min` options are stable across both), Flask (proxy static route), iptables (portal), a generated JS provider variant, pytest.

**Spec:** `docs/superpowers/specs/2026-09-26-ens-readonly-wallet-vlan-design.md` — this plan builds the Layer 2 listener that spec §32-36 and §80-82 define and that the prior plan (`2026-09-26-ens-readonly-wallet-vlan.md`, Task 7/8) explicitly deferred as "out of scope for a unit test … exercised in the final E2E."

## Global Constraints

- **Test key is env-only.** The Sepolia TEST private key, `ALCHEMY_KEY`, and any WalletConnect projectId are NEVER written to repo, ledger, spec, plan, or test. `SEPOLIA_RPC_URL` must stay a KEYLESS endpoint (default `https://ethereum-sepolia-rpc.publicnode.com`) — a keyed URL would leak to any VLAN client through the open read-proxy.
- **The governing invariant (spec §13-20): the announced wallet can never sign.** Layer 2 changes only WHERE the provider is injected; it reuses the same provider logic and the same `/api/wallet/rpc` server-side signing rejection. This plan adds NO new RPC path and MUST NOT weaken the double rejection.
- **Reuse, do not fork, the read allowlist.** The Layer-2 provider variant still fetches `read-methods.json` at runtime; the JSON stays the single source of truth across TS lib, JS provider, and Python proxy. No hand-copied method list.
- **aave.com is un-MITM-able and that is expected.** aave.com/app.aave.com are HSTS-preloaded; every stock browser refuses a user-installed CA for them. They go in `ignore_hosts`. Never claim the injected wallet works on aave on a stock browser. Build and demo against non-preloaded DeFi frontends.
- **No new device login / cookie / header trust.** Source-IP binding is preserved: account + rpc endpoints stay on the proxy, read `request.remote_addr`, and are reached by the client's own browser over the client's own connection (the listener does not proxy those fetches on the client's behalf — the injected absolute URLs make the browser connect to the proxy directly).
- **Web is "NOT the Next.js you know."** Any `web/` change requires reading `node_modules/next/dist/docs/` first (per `web/AGENTS.md`). This plan avoids `web/` runtime changes; the Layer-2 provider is generated into `web/public/wallet/` as a static asset (no Next routing), and the generator is plain Node/Python.
- **Worktree isolation.** Plain separate git commands only; no force-push; ff-only; shared stash stack — never bare `git stash`/`pop`.

## Review Focus

- **Relative-URL leak in the injected provider** — if any fetch in the Layer-2 provider stays relative, it resolves to the intercepted dapp's origin (`https://app.uniswap.org/api/wallet/account`) and silently returns the dapp's 404 HTML, so the wallet shows no account with no error. Task 2's generator test asserts ZERO relative `fetch(` remain and all three point at the configured absolute base. (Task 2.)
- **CSP `<meta>` tag surviving header strip** — the addon strips CSP/XFO response *headers*, but a dapp with `<meta http-equiv="Content-Security-Policy">` in its HTML still blocks the injected external script. Task 3's injector neutralizes CSP `<meta>` tags in the HTML body too, not only headers. (Task 3.)
- **Non-HTML / already-gzipped bodies** — the addon must inject only into `text/html` responses and must let mitmproxy handle content-encoding (use `flow.response.text`/`.content` which auto-decodes), or it corrupts JS/JSON/image bytes and breaks the page. Task 3 asserts a `application/json` and a gzip-encoded HTML response are handled correctly (JSON untouched, HTML injected after decode). (Task 3.)
- **HSTS-preloaded / pinned host still loads** — a host in `ignore_hosts` must pass through with its REAL certificate (TLS not terminated), so the page loads normally with no wallet; a bug that terminates it anyway gives a cert error and a broken tab. Task 4 asserts `ignore_hosts` is a compiled regex covering `aave.com`, `app.aave.com`, and that the option is set as `tls` passthrough, not just request-drop. (Task 4.)
- **Listener down / not installed** — if mitmproxy is not running or the CA is not trusted, HTTPS tabs must still reach the internet (fail-open at the iptables layer is NOT acceptable silently, but a documented "wallet absent" is). Task 5's iptables REDIRECT is paired with a documented rollback and the setup page states the fail mode; Task 6 E2E records honestly whether cert-injection was exercisable. (Task 5, Task 6.)

---

### Task 1: `mitm/` package scaffold + pinned mitmproxy dependency

**Files:**
- Create: `mitm/requirements.txt`
- Create: `mitm/README.md`
- Create: `mitm/__init__.py` (empty)
- Test: `mitm/tests/test_scaffold.py`

**Interfaces:**
- Consumes: nothing.
- Produces: an importable `mitm` package and a pinned dependency file the launch script (Task 5) and CI install from. No runtime symbols yet.

- [ ] **Step 1: Write the failing test**

```python
# mitm/tests/test_scaffold.py
import os
import re

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)


def test_requirements_pins_mitmproxy():
    req = open(os.path.join(ROOT, "requirements.txt")).read()
    # Pinned floor that has the stable addon API on both py3.9 (dev) and py3.14 (VM).
    assert re.search(r"^mitmproxy>=9\.0", req, re.M), "mitmproxy must be pinned with a >=9.0 floor"


def test_package_importable():
    import mitm  # noqa: F401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest mitm/tests/test_scaffold.py -v`
Expected: FAIL — `mitm/requirements.txt` and `mitm/__init__.py` do not exist (import error / file-open error).

- [ ] **Step 3: Create the scaffold**

`mitm/__init__.py`: empty file.

`mitm/requirements.txt`:
```
# TLS-intercepting listener for wallet Layer 2 injection.
# Floor >=9.0: the response / http_connect addon hooks and the
# ignore_hosts option are stable from 9.x (py3.9 dev venv) through
# 12.x (py3.14 VM). pip resolves the newest wheel for the running
# interpreter — 9.0.1 on py3.9, 12.2.3 on py3.14.
mitmproxy>=9.0
```

`mitm/README.md`: short prose — what the listener does, that it reuses `proxy/upstream.inject_provider`, how to run it locally (Task 5's script), and the hard note that HSTS-preloaded hosts are un-interceptable and live in `ignore_hosts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest mitm/tests/test_scaffold.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add mitm/__init__.py mitm/requirements.txt mitm/README.md mitm/tests/test_scaffold.py
git commit -m "feat: mitm package scaffold + pinned mitmproxy for wallet layer 2"
```

---

### Task 2: Layer-2 provider generator (absolute-URL variant) + drift guard

**Files:**
- Create: `mitm/gen_provider.py` (generator: reads `web/public/wallet/provider.js`, rewrites the 3 relative fetches to absolute, writes `web/public/wallet/provider.l2.js`)
- Test: `mitm/tests/test_gen_provider.py`

**Interfaces:**
- Consumes: the committed `web/public/wallet/provider.js` (Layer-1 provider, relative fetches) as the SOURCE. The three relative fetch literals it must rewrite, verbatim from the current file: `fetch("/wallet/read-methods.json")`, `fetch("/api/wallet/account")`, `fetch("/api/wallet/rpc"`.
- Produces: `generate_l2(source: str, base_url: str) -> str` — returns the provider source with each of the three relative fetch targets prefixed by `base_url` (e.g. `base_url="http://192.168.0.1:8081"` → `fetch("http://192.168.0.1:8081/wallet/read-methods.json")`). Also a `main()` that writes `web/public/wallet/provider.l2.js` using `base_url` from `WALLET_L2_BASE` env (default `http://192.168.0.1:8081`). The `uuid`, `rdns`, name, and classify logic are copied byte-for-byte from source — ONLY the fetch origins change.

- [ ] **Step 1: Write the failing test**

```python
# mitm/tests/test_gen_provider.py
import os
import re
import importlib.util

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
SRC = os.path.join(REPO, "web", "public", "wallet", "provider.js")

spec = importlib.util.spec_from_file_location("gen_provider", os.path.join(ROOT, "gen_provider.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

BASE = "http://192.168.0.1:8081"


def _out():
    return gen.generate_l2(open(SRC).read(), BASE)


def test_all_three_fetches_absolute():
    out = _out()
    assert f'fetch("{BASE}/wallet/read-methods.json")' in out
    assert f'fetch("{BASE}/api/wallet/account")' in out
    assert f'fetch("{BASE}/api/wallet/rpc"' in out


def test_no_relative_wallet_or_api_fetch_remains():
    out = _out()
    # No fetch of a /wallet/ or /api/wallet path may remain host-relative.
    assert not re.search(r'fetch\(\s*"/wallet/', out), "relative /wallet/ fetch leaked"
    assert not re.search(r'fetch\(\s*"/api/wallet/', out), "relative /api/wallet/ fetch leaked"


def test_identity_preserved():
    out = _out()
    # uuid + rdns copied byte-for-byte from the Layer-1 provider.
    assert "8f3d1c60-2a4e-4b7a-9e11-6c0f2d5a7b31" in out
    assert "eth.ethglobal2.readonly" in out


def test_base_url_is_parametrized():
    other = gen.generate_l2(open(SRC).read(), "http://10.0.0.5:9999")
    assert 'fetch("http://10.0.0.5:9999/api/wallet/account")' in other
    assert BASE not in other  # default base must not be hardcoded into output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest mitm/tests/test_gen_provider.py -v`
Expected: FAIL — `mitm/gen_provider.py` does not exist (module load error).

- [ ] **Step 3: Write the generator**

```python
# mitm/gen_provider.py
"""Generate the Layer-2 provider variant from the Layer-1 provider.

The Layer-1 provider (web/public/wallet/provider.js) fetches its backend
with HOST-RELATIVE URLs, which is correct when the page is served from our
own origin (Layer 1: /proxy/<slug>). Under Layer-2 TLS injection the page
is a THIRD-PARTY origin (app.uniswap.org), so a relative fetch would hit
that dapp's origin and 404. This rewrites exactly the three backend fetches
to an absolute proxy base; everything else — uuid, rdns, classify, the
signing rejection — is copied verbatim so the two providers cannot drift in
behavior, only in fetch origin.
"""
import os

# (relative literal, absolute-prefixed replacement builder)
_TARGETS = [
    '"/wallet/read-methods.json"',
    '"/api/wallet/account"',
    '"/api/wallet/rpc"',
]


def generate_l2(source: str, base_url: str) -> str:
    base = base_url.rstrip("/")
    out = source
    for rel in _TARGETS:
        # rel is a quoted literal like "/api/wallet/rpc"; splice base inside the quotes.
        inner = rel[1:-1]                       # /api/wallet/rpc
        absolute = '"' + base + inner + '"'     # "http://host:8081/api/wallet/rpc"
        assert rel in out, f"expected fetch literal {rel} not found in provider source"
        out = out.replace(rel, absolute)
    header = ("// GENERATED by mitm/gen_provider.py from provider.js — do not edit.\n"
              "// Layer-2 variant: backend fetches rewritten to an absolute proxy base\n"
              f"// so injection into a third-party origin still reaches the proxy ({base}).\n")
    return header + out


def main():
    here = os.path.dirname(__file__)
    repo = os.path.dirname(os.path.dirname(here))
    src = os.path.join(repo, "web", "public", "wallet", "provider.js")
    dst = os.path.join(repo, "web", "public", "wallet", "provider.l2.js")
    base = os.environ.get("WALLET_L2_BASE", "http://192.168.0.1:8081")
    out = generate_l2(open(src).read(), base)
    with open(dst, "w") as f:
        f.write(out)
    print(f"wrote {dst} (base {base})")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest mitm/tests/test_gen_provider.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add mitm/gen_provider.py mitm/tests/test_gen_provider.py
git commit -m "feat: layer-2 provider generator rewrites fetches to absolute proxy base"
```

---

### Task 3: The mitmproxy addon — HTML detection, body-safe injection, CSP-meta strip

**Files:**
- Create: `mitm/wallet_mitm.py` (the addon)
- Test: `mitm/tests/test_addon_inject.py`

**Interfaces:**
- Consumes: `proxy.upstream.inject_provider(content: bytes, content_type: str, headers: dict) -> tuple[bytes, dict]` (existing header-strip + `<script>` splice). `mitm/gen_provider.py` is NOT imported at runtime — the generated `provider.l2.js` is served by the proxy (Task 4); the addon only injects a `<script src>` pointing at it.
- Produces: a module-level `addons = [WalletInjector()]` list (mitmproxy convention) and a `WalletInjector` class with:
  - `strip_csp_meta(html: bytes) -> bytes` — removes `<meta http-equiv="Content-Security-Policy" ...>` tags (case-insensitive) from an HTML body.
  - `inject_html(body: bytes, content_type: str) -> bytes` — returns `body` unchanged unless `content_type` starts with `text/html`; for HTML, strips CSP meta then splices `<script src="{PROVIDER_L2_URL}"></script>` before `</head>` (falling back to prepend). Uses `PROVIDER_L2_URL` from env `WALLET_L2_PROVIDER_URL` (default `http://192.168.0.1:8081/wallet/provider.l2.js`).
  - `response(flow)` — mitmproxy hook: for a `text/html` response, replaces `flow.response.text`/`.content` with the injected body and removes CSP/XFO response headers via the shared `inject_provider` header logic. Non-HTML flows untouched.

- [ ] **Step 1: Write the failing test**

```python
# mitm/tests/test_addon_inject.py
import os, sys, importlib.util

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
sys.path.insert(0, os.path.join(REPO, "proxy"))  # so the addon can import upstream

spec = importlib.util.spec_from_file_location("wallet_mitm", os.path.join(ROOT, "wallet_mitm.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

inj = mod.WalletInjector()


def test_html_gets_script_before_head_close():
    body = b"<html><head><title>x</title></head><body>hi</body></html>"
    out = inj.inject_html(body, "text/html; charset=utf-8")
    assert b"provider.l2.js" in out
    assert out.index(b"provider.l2.js") < out.index(b"</head>")


def test_non_html_untouched():
    js = b'{"a":1}'
    assert inj.inject_html(js, "application/json") == js
    img = b"\x89PNG\r\n"
    assert inj.inject_html(img, "image/png") == img


def test_csp_meta_stripped():
    body = (b'<html><head>'
            b'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
            b'</head><body></body></html>')
    out = inj.inject_html(body, "text/html")
    assert b"Content-Security-Policy" not in out
    assert b"provider.l2.js" in out


def test_addons_list_present():
    assert hasattr(mod, "addons") and isinstance(mod.addons, list) and mod.addons


def test_injected_url_is_absolute_l2():
    body = b"<html><head></head></html>"
    out = inj.inject_html(body, "text/html").decode()
    assert 'src="http' in out and "provider.l2.js" in out  # absolute, not relative
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest mitm/tests/test_addon_inject.py -v`
Expected: FAIL — `mitm/wallet_mitm.py` does not exist.

- [ ] **Step 3: Write the addon**

```python
# mitm/wallet_mitm.py
"""mitmproxy addon: inject the Layer-2 read-only wallet provider into cold
third-party HTML tabs. Reuses proxy/upstream.inject_provider's header-strip
and <script> splice; adds CSP-<meta> stripping (a body-level CSP defeats an
external-script injection that a header strip alone would miss). Only
text/html responses are touched; everything else passes through byte-for-byte.
"""
import os
import re
import sys

# Reach proxy/upstream — the shared injector lives there so Layer 1 and
# Layer 2 splice identically.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "proxy"))
from upstream import _CSP_HEADERS  # noqa: E402

PROVIDER_L2_URL = os.environ.get(
    "WALLET_L2_PROVIDER_URL", "http://192.168.0.1:8081/wallet/provider.l2.js"
)

_CSP_META_RE = re.compile(
    rb'<meta[^>]+http-equiv\s*=\s*["\']?content-security-policy["\']?[^>]*>',
    re.IGNORECASE,
)


class WalletInjector:
    def strip_csp_meta(self, html: bytes) -> bytes:
        return _CSP_META_RE.sub(b"", html)

    def inject_html(self, body: bytes, content_type: str) -> bytes:
        if not content_type or not content_type.lower().startswith("text/html"):
            return body
        body = self.strip_csp_meta(body)
        tag = f'<script src="{PROVIDER_L2_URL}"></script>'.encode()
        idx = body.lower().find(b"</head>")
        if idx != -1:
            return body[:idx] + tag + body[idx:]
        return tag + body

    def response(self, flow):
        # mitmproxy hook. flow.response.content is already content-decoded
        # (gzip/br handled by mitmproxy); .text re-encodes on set.
        ct = flow.response.headers.get("content-type", "")
        if not ct.lower().startswith("text/html"):
            return
        injected = self.inject_html(flow.response.content, ct)
        flow.response.content = injected
        for h in _CSP_HEADERS:
            if h in flow.response.headers:
                del flow.response.headers[h]


addons = [WalletInjector()]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest mitm/tests/test_addon_inject.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add mitm/wallet_mitm.py mitm/tests/test_addon_inject.py
git commit -m "feat: mitmproxy addon injects layer-2 provider, strips CSP header+meta"
```

---

### Task 4: Proxy static route for `/wallet/*` assets + CA download

**Files:**
- Modify: `proxy/proxy.py` (add a `/wallet/<path:asset>` route serving from `web/public/wallet/` for provider/read-methods/provider.l2, and `/wallet/ca.crt` from a host CA path)
- Test: `proxy/tests/test_wallet_static.py`

**Interfaces:**
- Consumes: Flask `send_from_directory`, `send_file`, `abort` (add to the existing `from flask import ...` line — currently imports `Flask, request, jsonify, Response, ...`; add the three). The generated `provider.l2.js` from Task 2's `main()`.
- Produces: routes
  - `GET /wallet/ca.crt` → serves the file at env `WALLET_CA_PATH` (default `~/.mitmproxy/mitmproxy-ca-cert.pem`) as `application/x-x509-ca-cert`, `404` if absent.
  - `GET /wallet/<path:asset>` → serves `provider.js`, `provider.l2.js`, `read-methods.json` from `web/public/wallet/` (dir resolved relative to the repo root: `../web/public/wallet` from `proxy/`). Any other asset name → `404` (allowlist the three filenames; never an open static dir).
- Both are unauthenticated (the CA and provider must be fetchable before/without a session — the provider then calls the source-IP-bound account endpoint).

- [ ] **Step 1: Write the failing test**

```python
# proxy/tests/test_wallet_static.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import proxy as proxymod


def _client(tmp_path, monkeypatch):
    proxymod.app.config["TESTING"] = True
    return proxymod.app.test_client()


def test_provider_l2_served(monkeypatch):
    c = proxymod.app.test_client()
    r = c.get("/wallet/provider.l2.js")
    # Generated asset must exist (Task 2 main() run in CI/deploy); if the
    # generated file is present it is 200 JS, else 404 — never 500.
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert "javascript" in r.headers["Content-Type"]


def test_unknown_asset_404():
    c = proxymod.app.test_client()
    assert c.get("/wallet/../proxy.py").status_code in (400, 404)
    assert c.get("/wallet/secrets.env").status_code == 404


def test_ca_absent_is_404(monkeypatch, tmp_path):
    monkeypatch.setenv("WALLET_CA_PATH", str(tmp_path / "nope.pem"))
    # re-read env inside handler; route reads env per request
    c = proxymod.app.test_client()
    assert c.get("/wallet/ca.crt").status_code == 404


def test_ca_present_served(monkeypatch, tmp_path):
    p = tmp_path / "ca.pem"
    p.write_text("-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("WALLET_CA_PATH", str(p))
    c = proxymod.app.test_client()
    r = c.get("/wallet/ca.crt")
    assert r.status_code == 200
    assert b"BEGIN CERTIFICATE" in r.data
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest proxy/tests/test_wallet_static.py -v`
Expected: FAIL — routes 404 across the board because they don't exist yet (and `test_ca_present_served` fails asserting 200).

- [ ] **Step 3: Add the routes**

Add near the other `/api/wallet/*` routes in `proxy/proxy.py`. Extend the Flask import with `send_from_directory, send_file, abort`.

```python
_WALLET_ASSET_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "web", "public", "wallet")
)
_WALLET_ASSET_ALLOW = {"provider.js", "provider.l2.js", "read-methods.json"}


@app.route("/wallet/ca.crt")
def wallet_ca():
    path = os.path.expanduser(
        os.environ.get("WALLET_CA_PATH", "~/.mitmproxy/mitmproxy-ca-cert.pem")
    )
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype="application/x-x509-ca-cert",
                     as_attachment=True, download_name="ca.crt")


@app.route("/wallet/<path:asset>")
def wallet_asset(asset):
    if asset not in _WALLET_ASSET_ALLOW:
        abort(404)
    return send_from_directory(_WALLET_ASSET_DIR, asset)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest proxy/tests/test_wallet_static.py -v`
Expected: PASS (4 passed). `test_provider_l2_served` passes on either branch; run `.venv/bin/python mitm/gen_provider.py` first if you want the 200 branch exercised.

- [ ] **Step 5: Full proxy suite (no regression)**

Run: `.venv/bin/python -m pytest proxy/tests/ -q`
Expected: all pass — the new routes add surface, touch no existing route.

- [ ] **Step 6: Commit**

```bash
git add proxy/proxy.py proxy/tests/test_wallet_static.py
git commit -m "feat: proxy serves /wallet provider assets and mitmproxy CA download"
```

---

### Task 5: Launch script + iptables :443 REDIRECT hook (portal)

**Files:**
- Create: `mitm/run_mitm.sh` (generates provider.l2.js, then launches mitmdump transparent on :8443 with the addon + ignore_hosts)
- Modify: `portal/app.py` (`grant_access` adds `:443 → :8443` REDIRECT for the authed IP; `revoke_access` + `_flush_portal_rules` remove it)
- Test: `portal/tests/test_https_redirect.py` (asserts the rule strings; firewall disabled so no real iptables runs)

**Interfaces:**
- Consumes: portal's existing `_run`/`_run_ok` iptables helpers and `AP_IFACE`, the `FIREWALL_ENABLED` guard (so tests run rule-free on macOS).
- Produces:
  - `run_mitm.sh`: runs `python3 mitm/gen_provider.py` (writes provider.l2.js with `WALLET_L2_BASE`), then `mitmdump --mode transparent --listen-port 8443 -s mitm/wallet_mitm.py --set connection_strategy=lazy --ignore-hosts '<preloaded-regex>'`. The ignore regex covers aave + a documented set of HSTS-preloaded/pinned hosts.
  - `grant_access`: one added rule — `iptables -t nat -I PREROUTING 1 -s <ip> -p tcp --dport 443 -j REDIRECT --to-ports 8443` — inserted alongside the existing :80 handling. `revoke_access`: the matching `-D`.

- [ ] **Step 1: Write the failing test**

```python
# portal/tests/test_https_redirect.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["ENSCA_FIREWALL"] = "0"   # no real iptables
import importlib
import app as portal
importlib.reload(portal)

CALLS = []

def _fake_run(cmd):
    CALLS.append(cmd)

def test_grant_adds_443_redirect(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(portal, "_run", _fake_run)
    monkeypatch.setattr(portal, "_run_ok", _fake_run)
    monkeypatch.setattr(portal, "FIREWALL_ENABLED", True)
    monkeypatch.setattr(portal, "_notify_session_created", lambda *a, **k: None)
    portal.AUTHED_IPS.clear(); portal.SESSION_IDS.clear(); portal.ENS_NAMES.clear()
    portal.grant_access("10.9.9.9", "staff", ens_name="marco.tokyo.ethglobal2.eth", user_id="u")
    flat = [" ".join(c) for c in CALLS]
    assert any("--dport 443" in f and "REDIRECT" in f and "8443" in f and "10.9.9.9" in f for f in flat), \
        "grant_access must add a :443->:8443 REDIRECT for the authed IP"

def test_revoke_removes_443_redirect(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(portal, "_run", _fake_run)
    monkeypatch.setattr(portal, "_run_ok", _fake_run)
    monkeypatch.setattr(portal, "FIREWALL_ENABLED", True)
    monkeypatch.setattr(portal, "_notify_session_created", lambda *a, **k: None)
    monkeypatch.setattr(portal, "_notify_session_ended", lambda *a, **k: None)
    portal.AUTHED_IPS.clear(); portal.SESSION_IDS.clear(); portal.ENS_NAMES.clear()
    portal.grant_access("10.9.9.9", "staff", ens_name="x", user_id="u")
    CALLS.clear()
    portal.revoke_access("10.9.9.9")
    flat = [" ".join(c) for c in CALLS]
    assert any("-D" in c and "--dport 443" in " ".join(c) and "REDIRECT" in " ".join(c) for c in CALLS), \
        "revoke_access must delete the :443 REDIRECT"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest portal/tests/test_https_redirect.py -v`
Expected: FAIL — no `--dport 443 REDIRECT` rule is emitted yet.

- [ ] **Step 3: Add the REDIRECT to `grant_access` and `revoke_access`**

In `grant_access`, inside the `try:` block after the existing `:80` RETURN rule:
```python
            # HTTPS :443 -> :8443 transparent MITM listener (wallet Layer 2).
            # Injects the read-only provider into cold third-party HTTPS tabs.
            # Only authed IPs are steered into the listener; unauthed traffic
            # never reaches it. HSTS-preloaded hosts pass through inside mitm
            # (ignore_hosts), so those tabs still load with their real cert.
            _run(["iptables", "-t", "nat", "-I", "PREROUTING", "1",
                  "-s", ip, "-p", "tcp", "--dport", "443",
                  "-j", "REDIRECT", "--to-ports", "8443"])
```
In `revoke_access`, alongside the other `_run_ok(... -D ...)` calls:
```python
        _run_ok(["iptables", "-t", "nat", "-D", "PREROUTING",
                 "-s", ip, "-p", "tcp", "--dport", "443",
                 "-j", "REDIRECT", "--to-ports", "8443"])
```
(`_flush_portal_rules` already flushes the whole `nat PREROUTING` chain on startup, so stale :443 rules are cleared there — no extra change needed.)

- [ ] **Step 4: Write the launch script**

`mitm/run_mitm.sh` (chmod +x):
```bash
#!/usr/bin/env bash
# Launch the wallet Layer-2 TLS-intercepting listener.
# Prereq: mitmproxy CA generated once (mitmdump --version bootstraps it into
# ~/.mitmproxy) and served by the proxy at /wallet/ca.crt; the device trusts
# it per web/app/wallet/setup. HSTS-preloaded hosts are ignored (real cert,
# no wallet) — that is expected and unbypassable on stock browsers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"

: "${WALLET_L2_BASE:=http://192.168.0.1:8081}"
export WALLET_L2_BASE
export WALLET_L2_PROVIDER_URL="${WALLET_L2_BASE}/wallet/provider.l2.js"

# 1. (Re)generate the absolute-URL provider variant the proxy will serve.
python3 "$HERE/gen_provider.py"

# 2. HSTS-preloaded / cert-pinned hosts that CANNOT be intercepted on a stock
#    browser — pass them through untouched so the tab still loads.
IGNORE='(^|\.)(aave\.com|google\.com|gstatic\.com|googleapis\.com|apple\.com|icloud\.com|mozilla\.org|cloudflare\.com|paypal\.com|stripe\.com)(:443)?$'

exec mitmdump \
  --mode transparent \
  --listen-port 8443 \
  --set connection_strategy=lazy \
  --ignore-hosts "$IGNORE" \
  -s "$HERE/wallet_mitm.py"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest portal/tests/test_https_redirect.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Full portal suite (no regression)**

Run: `.venv/bin/python -m pytest portal/tests/ -q` (if a portal tests dir exists; otherwise run the repo suite touching portal)
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add mitm/run_mitm.sh portal/app.py portal/tests/test_https_redirect.py
git commit -m "feat: portal :443->:8443 redirect + mitm launch script for wallet layer 2"
```

---

### Task 6: Wire the CA link on the connected page + local browser E2E

**Files:**
- Modify: `portal/templates/success.html` (add an "Install security certificate" step linking the setup page / CA)
- Create: `mitm/tests/test_e2e_notes.md` (records the live-test procedure and results — not an automated test)

**Interfaces:**
- Consumes: the connected page already renders `ens_name`, `tier`, `ip`, Disconnect. The setup page exists at `/wallet/setup` (web) and the CA at `/wallet/ca.crt` (proxy, Task 4).
- Produces: a visible link on the post-login card to the cert-setup flow, and a written E2E record.

- [ ] **Step 1: Add the cert step to the connected page**

In `portal/templates/success.html`, add a card section (below the identity, above Disconnect):
> **Optional — see your wallet in any dapp.** Install the network security certificate once, then your read-only wallet appears in real dapps you open directly. [Set up the certificate →] (links to the setup page). Without it, the wallet still works on pages opened through the portal.

Link target: the served setup page. On the VM (no web service) point it at the proxy-served asset path if the setup page is relocated there; otherwise the web `/wallet/setup` URL. State the chosen URL inline in the template.

- [ ] **Step 2: Local interceptor E2E (Mac, browser I control)**

This is the whole-working test on real DeFi apps, run locally where a CA can be trusted in a test browser profile:

1. `.venv/bin/pip install -r mitm/requirements.txt` (mitmproxy 9.0.1 on py3.9).
2. Bootstrap the CA: `.venv/bin/mitmdump --version` (writes `~/.mitmproxy/mitmproxy-ca-cert.pem`).
3. Start proxy (`:8081`) with `WALLET_CA_PATH` default; confirm `curl -sI localhost:8081/wallet/ca.crt` → 200 and `curl -s localhost:8081/wallet/provider.l2.js | head` shows absolute fetch URLs.
4. `WALLET_L2_BASE=http://127.0.0.1:8081 bash mitm/run_mitm.sh` — listener on `:8443` (use `--mode regular` locally instead of transparent, since there's no VLAN iptables; configure the test browser's HTTPS proxy to `127.0.0.1:8443`).
5. Trust `~/.mitmproxy/mitmproxy-ca-cert.pem` in a **throwaway browser profile** (or macOS login keychain, removed after).
6. Load a NON-preloaded dapp cold (e.g. `https://app.uniswap.org`), open devtools → confirm `provider.l2.js` loaded, `window`-level EIP-6963 announce fired, the dapp's connect modal lists "VLAN Read-Only Wallet".
7. With a live session for `127.0.0.1` (seed one via the portal/proxy so `/api/wallet/account` returns an address — a DUMMY test address is fine; do NOT use the real Sepolia key), click connect → the dummy owner address shows connected; run a balance read → forwarded via `/api/wallet/rpc`; attempt `personal_sign` in console → throws `4200`.
8. Load `https://app.aave.com` → confirm it loads normally with NO wallet (ignore_hosts passthrough) and NO cert error.
9. Record every step's result in `mitm/tests/test_e2e_notes.md`, explicitly stating what ran locally vs. what remains for the on-VLAN device test (transparent mode + real phone). If a step could not be exercised, say so — do not claim success.

- [ ] **Step 3: Commit**

```bash
git add portal/templates/success.html mitm/tests/test_e2e_notes.md
git commit -m "feat: connected-page cert link + layer-2 local E2E record"
```

---

## Notes for the executor

- **Dummy wallet for testing:** the user asked to test by injecting a dummy wallet. `/api/wallet/account` returns whatever the active session's `wallet_address`/resolved owner is. For the local E2E, seed a session with a DUMMY address (any valid-looking `0x…40hex`) — never the real test key, which is signing material and env-only regardless. The read-only guarantee means even a real address cannot sign; the dummy just avoids needing on-chain state.
- **Local vs VLAN mode:** transparent mode (`--mode transparent` + iptables REDIRECT) is the VM/VLAN deploy path (Task 5 script default). Locally on the Mac there's no VLAN, so the E2E uses `--mode regular` with the browser's proxy setting — same addon, same injection, same provider; only the traffic-steering differs. Both are documented so neither is mistaken for the other.
- **VM deploy is a separate pass** (not in this plan's tasks): install `mitm/requirements.txt` on the VM, run `mitm/run_mitm.sh` under the same nohup+redirect+`</dev/null` discipline as proxy/portal, ensure `WALLET_CA_PATH` points at the VM's `~/.mitmproxy` CA, and confirm the portal's :443 REDIRECT is live for an authed IP. The on-device (phone) cert-trust + real-dapp test happens there.
