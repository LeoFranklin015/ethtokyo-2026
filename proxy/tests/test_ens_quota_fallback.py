import os, tempfile, sqlite3
import db as dbmod


def _con(monkeypatch, per_ens):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    con = sqlite3.connect(path); con.row_factory = sqlite3.Row
    con.execute("INSERT INTO groups(id,name,network_tier,created_at) VALUES('g','g','hacker',0)")
    con.execute("INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,created_at) "
                "VALUES('r','alchemy','A','http://x','url_path',0)")
    con.execute("INSERT INTO group_resource_limits(group_id,resource_id,per_device_per_day,group_per_day,per_ens_per_day) "
                "VALUES('g','r',NULL,NULL,?)", (per_ens,))
    con.commit()
    return con


def test_configured_per_ens_without_ens_name_fails_closed(monkeypatch):
    """A per-ENS limit is configured (hacker/alchemy=1000) but the caller passes
    no ens_name. The request must NOT silently fall through to the no-limits tail
    and get unlimited access — it must be blocked (fail closed), because the
    per-ENS cap is meant to always apply for this resource."""
    con = _con(monkeypatch, 1000)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    result = rate_limit.check_and_increment("1.1.1.1", "g", "r", None)
    assert result is not None, (
        "per_ens limit configured but ens_name missing must block, not pass")
    assert result["scope"] == "ens"


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    from seed_ens import seed
    seed(sqlite3.connect(path))
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy.app.test_client(), path


def test_session_created_backfills_ens_from_user(monkeypatch):
    """When the portal omits ens_name but supplies a user_id that resolves to a
    real user carrying an ens_name, session-created backfills the stored
    session.ens_name from that user, so the per-ENS shared bucket still applies
    across the user's devices."""
    c, path = _client(monkeypatch)
    con = sqlite3.connect(path); con.row_factory = sqlite3.Row
    urow = con.execute("SELECT id, default_group_id AS g FROM users WHERE ens_name='bob.doco.eth'").fetchone()
    r = c.post("/internal/session-created",
               json={"session_id": "sess-nulless", "user_id": urow["id"],
                     "group_id": urow["g"], "ip": "10.0.0.7", "network_tier": "hacker",
                     "ens_name": None, "logged_in_at": 0},
               environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 200
    stored = con.execute("SELECT ens_name FROM sessions WHERE id='sess-nulless'").fetchone()
    assert stored["ens_name"] == "bob.doco.eth"
