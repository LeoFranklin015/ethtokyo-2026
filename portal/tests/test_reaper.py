import app as portalmod


def test_stale_ips_selects_absent_beyond_ttl():
    authed = {"192.168.0.10", "192.168.0.11"}
    last_seen = {"192.168.0.10": 100.0, "192.168.0.11": 60.0}
    # now=85: .10 seen 15s ago (fresh), .11 seen 25s ago (stale, > ttl 20)
    stale = portalmod._stale_ips(last_seen, authed, now=85.0, ttl=20)
    assert stale == {"192.168.0.11"}


def test_never_seen_uses_grace():
    authed = {"192.168.0.10"}
    stale = portalmod._stale_ips({}, authed, now=1000.0, ttl=20)
    # never-seen within grace should not be revoked immediately on first tick
    assert stale == set()
