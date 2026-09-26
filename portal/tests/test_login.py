import app as portalmod


def test_unknown_name_rejected(monkeypatch, name_login):
    monkeypatch.setattr(portalmod, "_lookup_ens", lambda name: None)
    granted = []
    monkeypatch.setattr(portalmod, "grant_access", lambda ip, tier, **k: granted.append((ip, tier)))
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    r = c.post("/login", data={"ens_name": "nobody"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
    assert granted == []
    assert b"not recognized" in r.data.lower() or b"not recognised" in r.data.lower()


def test_known_name_grants_resolved_tier(monkeypatch, name_login):
    monkeypatch.setattr(portalmod, "_lookup_ens",
                        lambda name: {"group_id": "g", "network_tier": "hacker",
                                      "user_id": "u", "ens_name": "bob.doco.eth"})
    granted = {}
    monkeypatch.setattr(portalmod, "grant_access",
                        lambda ip, tier, **k: granted.update({"ip": ip, "tier": tier, "k": k}))
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    r = c.post("/login", data={"ens_name": "Bob.Doco.ETH"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
    assert granted["tier"] == "hacker"
