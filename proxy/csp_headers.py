# proxy/csp_headers.py
"""Single source of truth for the response headers that a Content-Security-
Policy or framing restriction rides on. Stripping these is what lets an
injected <script> run on a third-party page. Kept dependency-free (no flask,
no requests) so both the Layer-1 proxy (proxy/upstream.py) and the Layer-2
mitmproxy addon (mitm/wallet_mitm.py) can import it — the addon runs in an
isolated venv that must not load flask.
"""
_CSP_HEADERS = (
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
)
