import sqlite3, tempfile, os
import db as dbmod
from seed_ens import seed


def _db(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    con = sqlite3.connect(path); con.row_factory = sqlite3.Row
    return con


def test_seed_groups_and_grant(monkeypatch):
    con = _db(monkeypatch)
    seed(con); seed(con)  # twice — must stay idempotent
    tiers = {r[0] for r in con.execute("SELECT network_tier FROM groups")}
    assert {"hacker", "partner"} <= tiers
    hacker = con.execute("SELECT id FROM groups WHERE network_tier='hacker'").fetchone()[0]
    partner = con.execute("SELECT id FROM groups WHERE network_tier='partner'").fetchone()[0]
    alchemy = con.execute("SELECT id FROM resources WHERE slug='alchemy'").fetchone()[0]
    assert con.execute("SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?", (hacker, alchemy)).fetchone()
    assert con.execute("SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?", (partner, alchemy)).fetchone() is None
    users = {r[0]: r[1] for r in con.execute("SELECT username, default_group_id FROM users")}
    assert users["bob.doco.eth"] == hacker
    assert users["world.eth"] == partner
