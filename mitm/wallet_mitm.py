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

# Reach proxy/csp_headers — the CSP-header list is the single source of
# truth shared with the Layer-1 injector (proxy/upstream.py). csp_headers is
# dependency-free (no flask/requests), so importing it here does NOT pull the
# proxy's web stack into this isolated mitm venv.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "proxy"))
from csp_headers import _CSP_HEADERS  # noqa: E402

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
