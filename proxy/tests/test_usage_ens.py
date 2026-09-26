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


def test_usage_surfaces_ens_bucket(monkeypatch):
    """hacker/alchemy grant is device=NULL group=NULL per_ens=1000; usage must
    report the ENS bucket (ens_limit + ens_used shared across the user's devices)."""
    con = _setup(monkeypatch, 1000)
    today = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat()
    con.execute("INSERT INTO daily_ens_counters(date,ens_name,resource_id,count) VALUES(?,?,?,?)",
                (today, "bob.eth", "r", 7))
    con.commit()
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    usage = rate_limit.get_usage_for_ip("1.1.1.1", "g", "bob.eth")
    assert usage["alchemy"]["ens_limit"] == 1000
    assert usage["alchemy"]["ens_used"] == 7


def test_usage_no_ens_name_omits_bucket(monkeypatch):
    """Called without an ens_name, the ENS keys are absent (partner/no-ENS callers)."""
    con = _setup(monkeypatch, 1000)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    usage = rate_limit.get_usage_for_ip("1.1.1.1", "g")
    assert usage["alchemy"].get("ens_used") is None
