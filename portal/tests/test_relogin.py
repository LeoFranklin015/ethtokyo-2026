import app as portalmod


def _known(name):
    m = {
        "bob.doco.eth": {"group_id": "g", "network_tier": "hacker",
                         "user_id": "ub", "ens_name": "bob.doco.eth"},
        "alice.eth": {"group_id": "g", "network_tier": "hacker",
                      "user_id": "ua", "ens_name": "alice.eth"},
    }
    return m.get((name or "").strip().lower())


def test_relogin_different_ens_rebuilds_isolation(monkeypatch, name_login):
    """Same device re-logs in under a DIFFERENT ENS name. grant_access
    early-returns when the IP is already authed, so a stale ENS_NAMES entry
    would leave the old name's cross-DROP rules in place — an isolation
    desync. /login must revoke the old grant first so the new ENS identity's
    isolation is rebuilt cleanly, and ENS_NAMES must reflect the new name."""
    monkeypatch.setattr(portalmod, "_lookup_ens", _known)
    events = []
    monkeypatch.setattr(portalmod, "grant_access",
                        lambda ip, tier, **k: (events.append(("grant", ip, k.get("ens_name"))),
                                               portalmod.AUTHED_IPS.__setitem__(ip, tier),
                                               portalmod.ENS_NAMES.__setitem__(ip, k.get("ens_name")))[0])
    monkeypatch.setattr(portalmod, "revoke_access",
                        lambda ip: (events.append(("revoke", ip)),
                                    portalmod.AUTHED_IPS.pop(ip, None),
                                    portalmod.ENS_NAMES.pop(ip, None))[0])
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    ip = "192.168.0.60"

    c.post("/login", data={"ens_name": "bob.doco.eth"}, environ_overrides={"REMOTE_ADDR": ip})
    c.post("/login", data={"ens_name": "alice.eth"}, environ_overrides={"REMOTE_ADDR": ip})

    assert ("revoke", ip) in events, "re-login under a different ENS must revoke the stale grant first"
    assert events.index(("revoke", ip)) < events.index(("grant", ip, "alice.eth")), \
        "revoke must precede the re-grant so isolation is rebuilt"
    assert portalmod.ENS_NAMES[ip] == "alice.eth"


def test_relogin_same_ens_is_noop(monkeypatch, name_login):
    """Re-login under the SAME ENS from the same IP must NOT churn rules —
    no revoke, isolation already correct."""
    monkeypatch.setattr(portalmod, "_lookup_ens", _known)
    events = []
    monkeypatch.setattr(portalmod, "grant_access",
                        lambda ip, tier, **k: (events.append(("grant", ip, k.get("ens_name"))),
                                               portalmod.AUTHED_IPS.__setitem__(ip, tier),
                                               portalmod.ENS_NAMES.__setitem__(ip, k.get("ens_name")))[0])
    monkeypatch.setattr(portalmod, "revoke_access",
                        lambda ip: events.append(("revoke", ip)))
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    ip = "192.168.0.61"
    c.post("/login", data={"ens_name": "bob.doco.eth"}, environ_overrides={"REMOTE_ADDR": ip})
    c.post("/login", data={"ens_name": "bob.doco.eth"}, environ_overrides={"REMOTE_ADDR": ip})
    assert ("revoke", ip) not in events, "same-ENS re-login must not revoke"
