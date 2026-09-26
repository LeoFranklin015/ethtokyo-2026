import os, tempfile, sqlite3, time, bcrypt
import db as dbmod


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    from seed_ens import seed
    seed(sqlite3.connect(path))
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy.app.test_client(), path


def _admin_token(path):
    """Mint an admin token directly in the DB, return the bearer string."""
    tok = "test-admin-token"
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO admin_tokens(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        ("t-1", "test", bcrypt.hashpw(tok.encode(), bcrypt.gensalt()).decode(), int(time.time()), None)
    )
    con.commit()
    return f"Bearer {tok}"


def test_set_group_limit_persists_per_ens(monkeypatch):
    """PUT /admin/groups/<g>/limits/<r> with per_ens_per_day must persist it.
    Spec §6 makes per-ENS a first-class independent knob; the admin API must be
    able to set it, else operators cannot configure the shared per-user cap."""
    c, path = _client(monkeypatch)
    auth = _admin_token(path)
    con = sqlite3.connect(path); con.row_factory = sqlite3.Row
    g = con.execute("SELECT id FROM groups WHERE network_tier='hacker'").fetchone()["id"]
    r = con.execute("SELECT id FROM resources WHERE slug='alchemy'").fetchone()["id"]

    resp = c.put(f"/admin/groups/{g}/limits/{r}",
                 json={"per_device_per_day": 50, "group_per_day": None, "per_ens_per_day": 777},
                 headers={"Authorization": auth})
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.get_json().get("per_ens_per_day") == 777

    stored = con.execute(
        "SELECT per_ens_per_day FROM group_resource_limits WHERE group_id=? AND resource_id=?",
        (g, r)).fetchone()
    assert stored["per_ens_per_day"] == 777, "per_ens_per_day must be persisted by the PUT"
