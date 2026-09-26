import app as portalmod


def _client():
    portalmod.app.config["TESTING"] = True
    return portalmod.app.test_client()


def _get(client, path="/", ip="192.168.0.50"):
    return client.get(path, environ_overrides={"REMOTE_ADDR": ip})


def test_captive_page_sends_the_guest_to_the_console(monkeypatch):
    """The page cannot sign anyone in itself, so its one action is the console's /portal."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://192.168.0.2:3000")
    body = _get(_client()).get_data()
    assert b"http://192.168.0.2:3000/portal" in body
    assert b"Scan my badge" in body


def test_captive_page_says_so_when_there_is_no_console(monkeypatch):
    """A button that leads nowhere is worse than none: name the missing setting instead."""
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "")
    body = _get(_client()).get_data()
    assert b"/portal" not in body
    assert b"ENSCA_CONSOLE_URL" in body


def test_typed_name_form_is_absent_by_default(monkeypatch):
    """An ENS name is public. The fallback form only exists where an operator enabled it."""
    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", False)
    assert b'name="ens_name"' not in _get(_client()).get_data()

    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", True)
    assert b'name="ens_name"' in _get(_client()).get_data()


def test_refused_name_login_still_renders_the_badge_flow(monkeypatch):
    """Refusing must not strand the guest: the page it returns still offers the way in."""
    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", False)
    monkeypatch.setattr(portalmod, "CONSOLE_URL", "http://192.168.0.2:3000")
    r = _client().post(
        "/login", data={"ens_name": "bob"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"}
    )
    assert r.status_code == 403
    assert b"http://192.168.0.2:3000/portal" in r.get_data()


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
