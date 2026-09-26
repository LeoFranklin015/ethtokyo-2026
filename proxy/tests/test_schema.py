import sqlite3, tempfile, os
import db as dbmod


def _fresh_db(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    return sqlite3.connect(path)


def test_daily_ens_counters_exists(monkeypatch):
    con = _fresh_db(monkeypatch)
    cols = {r[1] for r in con.execute("PRAGMA table_info(daily_ens_counters)")}
    assert cols == {"date", "ens_name", "resource_id", "count"}


def test_per_ens_per_day_column(monkeypatch):
    con = _fresh_db(monkeypatch)
    cols = {r[1] for r in con.execute("PRAGMA table_info(group_resource_limits)")}
    assert "per_ens_per_day" in cols


def test_migration_idempotent(monkeypatch):
    con = _fresh_db(monkeypatch)
    dbmod.init_db()  # run again — must not raise
    cols = {r[1] for r in con.execute("PRAGMA table_info(group_resource_limits)")}
    assert "per_ens_per_day" in cols
