import app as portalmod


def test_revoke_deletes_dnat_with_configured_dns_server(monkeypatch):
    """revoke_access must delete the DNS DNAT rule keyed on the SAME resolver
    grant_access installed it with (DNS_SERVER), not a hardcoded 8.8.8.8. If
    ENSCA_DNS_SERVER is overridden, a hardcoded delete leaves a stale DNAT rule
    behind on every logout/reap."""
    monkeypatch.setattr(portalmod, "DNS_SERVER", "1.1.1.1")
    calls = []
    monkeypatch.setattr(portalmod, "_run_ok", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(portalmod, "_notify_session_ended", lambda sid: None)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear(); portalmod.SESSION_IDS.clear()
    ip = "192.168.0.50"
    portalmod.AUTHED_IPS[ip] = "hacker"
    portalmod.SESSION_IDS[ip] = "sess-x"
    portalmod.revoke_access(ip)
    flat = [" ".join(c) for c in calls]
    assert any("--to-destination 1.1.1.1:53" in f for f in flat), (
        "DNAT delete must use configured DNS_SERVER (1.1.1.1), got: " + "\n".join(flat))
    assert not any("8.8.8.8:53" in f for f in flat), (
        "must not delete with hardcoded 8.8.8.8 when DNS_SERVER overridden")
