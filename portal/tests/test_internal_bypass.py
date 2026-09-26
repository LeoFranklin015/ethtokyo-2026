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


def test_internal_endpoints_reject_nonlocal_clients(monkeypatch):
    """check_authed must centrally forbid /internal/* from any non-loopback
    source, BEFORE the route runs, so a future /internal/* route that forgets
    its own remote_addr check is not exposed to unauthed LAN clients. Uses a
    path with no matching route: a 403 proves the central gate fired (a route
    self-gate cannot, since there is no route); the old blanket `return None`
    would fall through to a 404."""
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    resp = c.post("/internal/does-not-exist", json={},
                  environ_overrides={"REMOTE_ADDR": "192.168.0.99"})
    assert resp.status_code == 403, f"non-local /internal/* must be 403 at the gate, got {resp.status_code}"
