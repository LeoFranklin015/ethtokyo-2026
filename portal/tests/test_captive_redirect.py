import app as portalmod


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(portalmod, "_run", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(portalmod, "_run_ok", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(portalmod, "_notify_session_created", lambda *a, **k: None)
    monkeypatch.setattr(portalmod, "_notify_session_ended", lambda *a, **k: None)
    monkeypatch.setattr(portalmod, "_apply_ens_isolation", lambda *a, **k: None)
    return calls


def test_bootstrap_installs_captive_port80_redirect(monkeypatch):
    """On startup the portal must install a baseline nat PREROUTING REDIRECT
    that sends unauthed clients' HTTP (:80) to the portal on :8080. Without it,
    the DNS hijack points a device probe at the gateway on :80 where nothing
    listens (portal is on :8080), the probe connection fails, and the OS never
    shows the captive-portal popup."""
    calls = _capture(monkeypatch)
    portalmod._bootstrap_captive_redirect()
    flat = [" ".join(c) for c in calls]
    assert any(
        "-t nat" in f and "PREROUTING" in f and "-i " + portalmod.AP_IFACE in f
        and "--dport 80" in f and "REDIRECT" in f and "8080" in f
        for f in flat
    ), f"expected baseline :80->:8080 REDIRECT on {portalmod.AP_IFACE}, got:\n" + "\n".join(flat)


def test_grant_excludes_authed_ip_from_port80_redirect(monkeypatch):
    """An authed client has a per-IP FORWARD ACCEPT and must reach the real
    internet on :80. grant_access must insert a per-IP RETURN in nat PREROUTING
    ABOVE the baseline REDIRECT so the authed client's :80 is not bounced back
    to the portal."""
    calls = _capture(monkeypatch)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    portalmod.grant_access("192.168.0.20", "hacker", ens_name="bob.doco.eth", user_id="u")
    flat = [" ".join(c) for c in calls]
    assert any(
        "-t nat" in f and "-I PREROUTING 1" in f and "-s 192.168.0.20" in f
        and "--dport 80" in f and "RETURN" in f
        for f in flat
    ), "grant must insert a per-IP :80 RETURN above the redirect:\n" + "\n".join(flat)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()


def test_revoke_removes_authed_ip_port80_exclusion(monkeypatch):
    """revoke_access must delete the per-IP :80 RETURN it installed on grant,
    so a disconnected/logged-out client is bounced back to the portal again."""
    calls = _capture(monkeypatch)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    portalmod.grant_access("192.168.0.21", "hacker", ens_name="bob.doco.eth", user_id="u")
    calls.clear()
    portalmod.revoke_access("192.168.0.21")
    flat = [" ".join(c) for c in calls]
    assert any(
        "-t nat" in f and "-D PREROUTING" in f and "-s 192.168.0.21" in f
        and "--dport 80" in f and "RETURN" in f
        for f in flat
    ), "revoke must delete the per-IP :80 RETURN:\n" + "\n".join(flat)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
