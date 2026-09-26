# proxy/tests/test_wallet_same_origin_prefix.py
"""The same-origin /__wallet__/ prefix is normally intercepted by the mitm
addon and answered over loopback. But mitmproxy's lazy connection strategy
occasionally passes a reused-connection flow straight through, and the
device's /__wallet__/ request then lands at the proxy directly. The proxy
must answer that prefix itself — mapping to the very same wallet handlers —
so the read-only wallet backend is reachable whether the flow was
intercepted or bypassed. The map mirrors mitm/wallet_mitm._PATH_MAP.
"""
import os, sys, sqlite3
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import proxy as proxymod
import db as dbmod
from seed_ens import seed


def _seeded_client(monkeypatch, tmp_path):
    """Match test_wallet_account's fixture: a temp seeded DB so the wallet
    handlers reach a real database instead of erroring on connect."""
    path = str(tmp_path / "t.db")
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    conn = sqlite3.connect(path)
    seed(conn)
    proxymod.app.config["TESTING"] = True
    return proxymod.app.test_client()


def test_prefix_provider_matches_static_route():
    c = proxymod.app.test_client()
    direct = c.get("/wallet/provider.l2.js")
    prefixed = c.get("/__wallet__/provider.l2.js")
    assert prefixed.status_code == direct.status_code
    if direct.status_code == 200:
        assert prefixed.data == direct.data
        assert "javascript" in prefixed.headers["Content-Type"]


def test_prefix_read_methods_matches_static_route():
    c = proxymod.app.test_client()
    direct = c.get("/wallet/read-methods.json")
    prefixed = c.get("/__wallet__/read-methods.json")
    assert prefixed.status_code == direct.status_code
    if direct.status_code == 200:
        assert prefixed.data == direct.data


def test_prefix_account_reaches_account_handler(monkeypatch, tmp_path):
    # No session for the test peer -> the account handler's own 404 (no_account),
    # proving the request reached the handler rather than a missing route. The
    # prefix route and the direct route must answer identically.
    c = _seeded_client(monkeypatch, tmp_path)
    prefixed = c.get("/__wallet__/account")
    direct = c.get("/api/wallet/account")
    assert prefixed.status_code == direct.status_code
    assert prefixed.get_json() == direct.get_json()
    assert prefixed.status_code == 404
    assert prefixed.get_json() == {"error": "no_account"}


def test_prefix_rpc_reaches_rpc_handler(monkeypatch, tmp_path):
    # Invalid (non-dict/list) body -> the rpc handler's own 400 invalid-request,
    # proving the POST reached the handler rather than a missing route.
    c = _seeded_client(monkeypatch, tmp_path)
    r = c.post("/__wallet__/rpc", json="not-an-object")
    assert r.status_code == 400
    assert r.get_json()["error"]["message"] == "invalid request"


def test_prefix_unknown_path_404():
    c = proxymod.app.test_client()
    assert c.get("/__wallet__/secrets.env").status_code == 404
    assert c.get("/__wallet__/../proxy.py").status_code in (400, 404)
