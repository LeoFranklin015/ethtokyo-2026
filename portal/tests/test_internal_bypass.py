import app as portalmod


def test_internal_endpoints_bypass_captive_redirect(monkeypatch):
    """check_authed (before_request) must NOT bounce localhost /internal/*
    calls to the portal. The dnsmasq dhcp-hook POSTs to /internal/revoke-ip
    from 127.0.0.1; if the captive before_request 302-redirects it (because
    127.0.0.1 isn't an authed client IP and the path isn't / or /login), the
    revoke route never runs and a reconnecting device's stale auth is never
    torn down. Internal localhost endpoints must reach their handler."""
    called = {}
    monkeypatch.setattr(portalmod, "revoke_access", lambda ip: called.setdefault("ip", ip))
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    resp = c.post("/internal/revoke-ip", json={"ip": "192.168.0.17"},
                  environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert resp.status_code == 200, f"internal revoke must return 200, got {resp.status_code}"
    assert called.get("ip") == "192.168.0.17", "revoke_access must be invoked for the posted IP"
