import os, tempfile, sqlite3, time, bcrypt
import db as dbmod


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy.app.test_client(), path


def _auth(path):
    tok = "test-admin-token"
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO admin_tokens(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        ("t-1", "test", bcrypt.hashpw(tok.encode(), bcrypt.gensalt()).decode(), int(time.time()), None))
    con.commit()
    return f"Bearer {tok}"


def _fixture(path):
    """Two organizations sharing one enforcer, which is the situation that goes wrong."""
    con = sqlite3.connect(path)
    now = int(time.time())
    for gid, name in (("g-acme", "mentor"), ("g-other", "hacker")):
        con.execute("INSERT INTO groups(id,name,network_tier,notes,created_at) VALUES(?,?,?,?,?)",
                    (gid, name, "basic", None, now))
    people = [
        ("u-1", "alice.tokyo.acme.eth", "g-acme"),
        ("u-2", "bob.tokyo.acme.eth", "g-acme"),
        ("u-3", "carol.osaka.ethglobal2.eth", "g-other"),
    ]
    for uid, ens, gid in people:
        con.execute(
            "INSERT INTO users(id,username,password_hash,default_group_id,ens_name,created_at) "
            "VALUES(?,?,?,?,?,?)", (uid, ens, "x", gid, ens, now))
    con.commit()


def test_users_are_scoped_to_one_organization(monkeypatch):
    """`?org=` must list only that organization's people, with an honest total.

    The enforcer has no organization column, so an unscoped list showed a console that had just
    been pointed at `acme.eth` a page full of somebody else's members."""
    c, path = _client(monkeypatch); auth = _auth(path); _fixture(path)

    body = c.get("/admin/users?org=acme", headers={"Authorization": auth}).get_json()
    assert body["total"] == 2
    assert {u["ens_name"] for u in body["users"]} == {"alice.tokyo.acme.eth", "bob.tokyo.acme.eth"}

    # A suffix match must not be a substring match: `acme.eth` is not `notacme.eth`.
    assert c.get("/admin/users?org=notacme", headers={"Authorization": auth}).get_json()["total"] == 0

    assert c.get("/admin/users", headers={"Authorization": auth}).get_json()["total"] == 3
    assert c.get("/admin/users?org=NOT valid", headers={"Authorization": auth}).status_code == 400


def test_groups_are_scoped_and_counted_per_organization(monkeypatch):
    """A scoped group list carries only groups that organization has people in, counted likewise."""
    c, path = _client(monkeypatch); auth = _auth(path); _fixture(path)

    groups = c.get("/admin/groups?org=acme", headers={"Authorization": auth}).get_json()["groups"]
    assert [g["name"] for g in groups] == ["mentor"]
    assert groups[0]["member_count"] == 2

    assert len(c.get("/admin/groups", headers={"Authorization": auth}).get_json()["groups"]) == 2
    assert c.get("/admin/groups?org=..", headers={"Authorization": auth}).status_code == 400


def test_sessions_are_scoped_to_one_organization(monkeypatch):
    """The overview's session figures must count this organization's people only."""
    c, path = _client(monkeypatch); auth = _auth(path); _fixture(path)
    con = sqlite3.connect(path); now = int(time.time())
    for sid, uid, gid, ip in (("s-1", "u-1", "g-acme", "10.0.0.1"),
                              ("s-2", "u-3", "g-other", "10.0.0.2")):
        con.execute(
            "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,logged_in_at) "
            "VALUES(?,?,?,?,?,?)", (sid, uid, gid, ip, "basic", now))
    con.commit()

    body = c.get("/admin/sessions?active=true&org=acme", headers={"Authorization": auth}).get_json()
    assert body["total"] == 1
    assert body["sessions"][0]["user_id"] == "u-1"
    assert c.get("/admin/sessions?active=true", headers={"Authorization": auth}).get_json()["total"] == 2


def _usage(path):
    """Traffic for one session in each organization, which is what the overview chart reads.

    `usage_events` rows carry no name of their own, so this exists to prove the join back through
    `sessions` to `users` attributes them, and that the last row — an event with no session at
    all — is charged to nobody."""
    _fixture(path)
    con = sqlite3.connect(path)
    now = int(time.time())
    con.execute("INSERT INTO resources(id,slug,display_name,upstream_url,created_at) VALUES(?,?,?,?,?)",
                ("r-1", "api", "API", "http://127.0.0.1:1", now))
    for sid, uid, gid, ip in (("s-1", "u-1", "g-acme", "10.0.0.1"),
                              ("s-2", "u-3", "g-other", "10.0.0.2")):
        con.execute(
            "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,logged_in_at) "
            "VALUES(?,?,?,?,?,?)", (sid, uid, gid, ip, "basic", now))
    events = [("s-1", "10.0.0.1", "g-acme", 1000),
              ("s-2", "10.0.0.2", "g-other", 7000),
              (None, "10.0.0.9", "g-acme", 500)]
    for session_id, ip, gid, resp in events:
        con.execute(
            "INSERT INTO usage_events(ts,session_id,ip,group_id,resource_id,method,path,status,"
            "req_bytes,resp_bytes,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (now - 60, session_id, ip, gid, "r-1", "GET", "/", 200, 10, resp, 1))
    con.commit()


def test_throughput_series_is_scoped_to_one_organization(monkeypatch):
    """The overview chart must plot this organization's traffic, not the whole deployment's.

    A usage event is attributed through its session's account, so an event whose `session_id` is
    NULL belongs to no organization and must not be counted into one."""
    c, path = _client(monkeypatch); auth = _auth(path); _usage(path)

    scoped = c.get("/admin/bandwidth/timeseries?org=acme",
                   headers={"Authorization": auth}).get_json()["samples"]
    assert len(scoped) == 1
    # Only the 1000 bytes of the one attributable acme session: not the other organization's
    # 7000, and not the 500 belonging to no session.
    assert scoped[0]["mbps"] == 1000 * 8.0 / (10.0 * 60.0 * 1000000.0)
    assert scoped[0]["active_ips"] == 1

    unscoped = c.get("/admin/bandwidth/timeseries", headers={"Authorization": auth}).get_json()["samples"]
    assert unscoped[0]["mbps"] == 8500 * 8.0 / (10.0 * 60.0 * 1000000.0)
    assert unscoped[0]["active_ips"] == 3

    assert c.get("/admin/bandwidth/timeseries?org=NOT valid",
                 headers={"Authorization": auth}).status_code == 400


def test_bandwidth_sessions_are_scoped_to_one_organization(monkeypatch):
    """Per-session totals and the tier roll-up they feed must cover one organization only."""
    c, path = _client(monkeypatch); auth = _auth(path); _usage(path)
    con = sqlite3.connect(path)
    con.execute("UPDATE sessions SET bytes_in=100, bytes_out=1000 WHERE id='s-1'")
    con.execute("UPDATE sessions SET bytes_in=200, bytes_out=7000 WHERE id='s-2'")
    con.commit()

    body = c.get("/admin/bandwidth/sessions?org=acme", headers={"Authorization": auth}).get_json()
    assert body["total_sessions"] == 1
    assert body["sessions"][0]["id"] == "s-1"
    assert body["tier_totals"]["basic"] == {"sessions": 1, "bytes_in": 100, "bytes_out": 1000}

    everybody = c.get("/admin/bandwidth/sessions", headers={"Authorization": auth}).get_json()
    assert everybody["tier_totals"]["basic"]["sessions"] == 2

    assert c.get("/admin/bandwidth/sessions?org=..", headers={"Authorization": auth}).status_code == 400
