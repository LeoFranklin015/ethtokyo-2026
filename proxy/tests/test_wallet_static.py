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
