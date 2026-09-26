import app as portalmod


def _client():
    portalmod.app.config["TESTING"] = True
    return portalmod.app.test_client()


def _get(client, path="/", ip="192.168.0.50"):
    return client.get(path, environ_overrides={"REMOTE_ADDR": ip})


def test_captive_page_carries_the_whole_flow(monkeypatch):
    """Scan, connect, sign — all four steps live on this page, served with nothing external."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")
    body = _get(_client()).get_data()
    assert b"Scan my badge" in body
    assert b"<video" in body
    assert b"BarcodeDetector" in body
    assert b"personal_sign" in body
    assert b"/api/badge" in body and b"/api/challenge" in body and b"/api/verify" in body
    # Nothing may be fetched from off-device: an unadmitted guest can reach no other host.
    assert b"https://" not in body
    assert b"<script src" not in body


def test_captive_page_says_so_when_there_is_no_console(monkeypatch):
    """A scan that could never be checked is worse than none: name the missing setting."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "")
    body = _get(_client()).get_data()
    assert b"ENSCA_CONSOLE_URL" in body
    assert b"Sign-in is unavailable here" in body


def test_typed_name_form_is_absent_by_default(monkeypatch):
    """An ENS name is public. The fallback form only exists where an operator enabled it."""
    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", False)
    assert b'name="ens_name"' not in _get(_client()).get_data()

    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", True)
    assert b'name="ens_name"' in _get(_client()).get_data()


def test_refused_name_login_still_renders_the_badge_flow(monkeypatch):
    """Refusing must not strand the guest: the page it returns still offers the way in."""
    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", False)
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")
    r = _client().post(
        "/login", data={"ens_name": "bob"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"}
    )
    assert r.status_code == 403
    assert b"Scan my badge" in r.get_data()
    assert b"not proof of membership" in r.get_data()


def test_internal_status_reports_one_device():
    """What the console asks before walking a guest through a badge they do not need to scan."""
    c = _client()
    portalmod.AUTHED_IPS.clear()
    portalmod.ENS_NAMES.clear()
    portalmod.AUTHED_IPS["192.168.0.50"] = "hacker"
    portalmod.ENS_NAMES["192.168.0.50"] = "pdc3u.hfke.ensca-demo-org.eth"

    seen = c.get("/internal/status?ip=192.168.0.50", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert seen.get_json() == {
        "admitted": True,
        "ens_name": "pdc3u.hfke.ensca-demo-org.eth",
        "tier": "hacker",
    }

    unseen = c.get("/internal/status?ip=192.168.0.99", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert unseen.get_json() == {"admitted": False}

    portalmod.AUTHED_IPS.clear()
    portalmod.ENS_NAMES.clear()


def test_internal_status_is_localhost_only():
    """Same boundary as every other /internal route: a client must not read the authed list."""
    c = _client()
    r = c.get("/internal/status?ip=192.168.0.50", environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
    assert r.status_code == 403


def test_internal_status_rejects_a_malformed_address():
    c = _client()
    r = c.get("/internal/status?ip=not-an-ip", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 400


class _Answer:
    def __init__(self, status, payload):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def test_api_survives_the_captive_redirect_when_unadmitted(monkeypatch):
    """The page calls these before it is admitted — by definition. They must answer, not bounce.

    Redirecting them to the portal would hand a JSON caller an HTML login page, and the flow
    would fail with nothing to point at.
    """
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")
    monkeypatch.setattr(portalmod._req, "request", lambda *a, **k: _Answer(200, {"ok": True}))
    portalmod.AUTHED_IPS.clear()
    c = _client()

    for path in ("/api/badge?id=pdc3u", "/api/challenge", "/api/verify"):
        r = c.open(path, method="POST" if "badge" not in path else "GET",
                   environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
        assert r.status_code == 200, path

    # Anything else still gets the captive bounce.
    assert _get(c, "/somewhere").status_code == 302


def test_relay_carries_the_guests_address(monkeypatch):
    """The console binds its nonce to the caller and then asks us to admit that same address.

    Without the forwarded address every guest would look like this gateway, and the wrong device
    would be let onto the network.
    """
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")
    seen = {}

    def record(method, url, headers=None, **kwargs):
        seen["method"], seen["url"], seen["headers"] = method, url, headers
        return _Answer(200, {"ok": True})

    monkeypatch.setattr(portalmod._req, "request", record)
    portalmod.AUTHED_IPS.clear()
    _get(_client(), "/api/badge?id=pdc3u", ip="192.168.0.77")

    assert seen["headers"]["X-Forwarded-For"] == "192.168.0.77"
    assert seen["url"].endswith("/api/portal/badge")


def test_unreachable_console_is_not_a_refusal(monkeypatch):
    """504, not 403. A console that did not answer must never read as "you are not a member"."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(portalmod._req, "request", boom)
    portalmod.AUTHED_IPS.clear()
    r = _get(_client(), "/api/badge?id=pdc3u")
    assert r.status_code == 504
    assert "reach" in r.get_json()["error"]


def test_relay_without_a_console_says_which_knob_is_missing(monkeypatch):
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "")
    portalmod.AUTHED_IPS.clear()
    r = _get(_client(), "/api/badge?id=pdc3u")
    assert r.status_code == 503
    assert "console" in r.get_json()["error"]


def test_relay_passes_the_consoles_own_status_through(monkeypatch):
    """A 404 from the console is "no such badge" and must arrive as one, not as a relay error."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://127.0.0.1:3000")
    monkeypatch.setattr(
        portalmod._req, "request", lambda *a, **k: _Answer(404, {"error": "no membership"})
    )
    portalmod.AUTHED_IPS.clear()
    r = _get(_client(), "/api/badge?id=zzzzz")
    assert r.status_code == 404


def test_an_admitted_device_is_not_asked_to_scan_again():
    """A captive page is reopened constantly. An admitted device belongs on /connected."""
    c = _client()
    portalmod.AUTHED_IPS.clear()
    portalmod.AUTHED_IPS["192.168.0.50"] = "hacker"
    try:
        r = _get(c)
        assert r.status_code == 302
        assert r.headers["Location"].endswith("/connected")
    finally:
        portalmod.AUTHED_IPS.clear()
