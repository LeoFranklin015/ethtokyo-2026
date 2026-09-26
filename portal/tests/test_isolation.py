import app as portalmod


def test_isolate_different_ens_allow_same(monkeypatch):
    calls = []
    monkeypatch.setattr(portalmod, "_run_ok", lambda cmd: calls.append(cmd))
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    # three already-authed peers
    portalmod.AUTHED_IPS.update({"192.168.0.11": "hacker", "192.168.0.12": "hacker",
                                 "192.168.0.13": "partner"})
    portalmod.ENS_NAMES.update({"192.168.0.11": "bob.doco.eth",
                                "192.168.0.12": "alice.eth",
                                "192.168.0.13": "world.eth"})
    # new bob device joins
    portalmod.AUTHED_IPS["192.168.0.10"] = "hacker"
    portalmod.ENS_NAMES["192.168.0.10"] = "bob.doco.eth"
    portalmod._apply_ens_isolation("192.168.0.10", action="I")
    flat = [" ".join(c) for c in calls]
    joined = "\n".join(flat)
    # dropped vs alice (.12) and world (.13) — different ENS — both directions
    assert any("-s 192.168.0.10 -d 192.168.0.12" in f for f in flat)
    assert any("-s 192.168.0.12 -d 192.168.0.10" in f for f in flat)
    assert any("-d 192.168.0.13" in f and "192.168.0.10" in f for f in flat)
    # NOT dropped vs the other bob device (.11) — same ENS
    assert "192.168.0.11" not in joined
