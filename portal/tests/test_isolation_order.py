import app as portalmod


def _capture(monkeypatch):
    """Record every iptables call grant_access makes, in order."""
    calls = []
    monkeypatch.setattr(portalmod, "_run", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(portalmod, "_run_ok", lambda cmd: calls.append(cmd))
    monkeypatch.setattr(portalmod, "_notify_session_created", lambda *a, **k: None)
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear(); portalmod.SESSION_IDS.clear()
    return calls


def test_isolation_drop_precedes_accept_in_chain(monkeypatch):
    """A cross-user DROP must sit ABOVE the granted IP's -s <ip> ACCEPT in the
    FORWARD chain, or iptables first-match ACCEPTs the packet and isolation never
    fires. Both rules are inserted at position 1 (prepend), so the LAST insert
    lands on top: the ACCEPT must be issued first, then the DROP rules prepend
    above it. In call order that means accept is issued before drop, and the DROP
    must be a position-1 insert (not an append) to reach the top."""
    calls = _capture(monkeypatch)
    # an existing different-ENS peer is already authed
    portalmod.AUTHED_IPS["10.0.0.20"] = "hacker"
    portalmod.ENS_NAMES["10.0.0.20"] = "alice.eth"
    # new user logs in; ENS_NAMES set before grant, as /login does
    portalmod.ENS_NAMES["10.0.0.10"] = "bob.doco.eth"
    portalmod.grant_access("10.0.0.10", "hacker", ens_name="bob.doco.eth")

    flat = [" ".join(c) for c in calls]
    drop_idx = next(i for i, f in enumerate(flat)
                    if "-s 10.0.0.10 -d 10.0.0.20 -j DROP" in f)
    accept_idx = next(i for i, f in enumerate(flat)
                      if "-s 10.0.0.10 -j ACCEPT" in f)
    # both are position-1 inserts; the DROP issued LAST lands above the ACCEPT
    assert accept_idx < drop_idx, (
        f"per-IP ACCEPT (call {accept_idx}) must be issued before the "
        f"isolation DROP (call {drop_idx}) so the position-1 DROP lands on top")
    # and it must be a position-1 insert, not an append, to land on top
    assert "-I FORWARD 1 -s 10.0.0.10 -d 10.0.0.20 -j DROP" in flat[drop_idx]
