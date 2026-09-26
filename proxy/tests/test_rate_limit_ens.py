import os, tempfile, sqlite3
import db as dbmod


def _setup(monkeypatch, per_ens):
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


def test_shared_bucket_blocks_second_device(monkeypatch):
    con = _setup(monkeypatch, 2)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    assert rate_limit.check_and_increment("1.1.1.1", "g", "r", "bob.eth") is None
    assert rate_limit.check_and_increment("2.2.2.2", "g", "r", "bob.eth") is None  # same ENS, 2nd device
    blocked = rate_limit.check_and_increment("3.3.3.3", "g", "r", "bob.eth")       # 3rd hit, over cap 2
    assert blocked and blocked["scope"] == "ens"


def test_null_per_ens_is_noop(monkeypatch):
    con = _setup(monkeypatch, None)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    for _ in range(5):
        assert rate_limit.check_and_increment("1.1.1.1", "g", "r", "bob.eth") is None
