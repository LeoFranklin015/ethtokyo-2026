# mitm — TLS-intercepting wallet Layer 2 injection listener

This package runs a mitmproxy-based listener that transparently intercepts
outbound TLS traffic from a device and injects a wallet provider into
matching HTTP responses. On each intercepted response the listener reuses
`proxy/upstream.inject_provider` to rewrite the payload, keeping the
injection logic in one place shared with the existing proxy subsystem.

The pinned dependency lives in `requirements.txt` (mitmproxy >=9.0); the
launch script (added in a later task) and CI both install from it. To run
the listener locally, invoke that launch script against the repo venv.

Note: HSTS-preloaded hosts cannot be intercepted — the browser refuses any
proxy-presented certificate for them regardless of trust store state. These
hosts are un-interceptable by design and are listed in mitmproxy's
`ignore_hosts` option so the listener passes them through untouched rather
than breaking the connection.
