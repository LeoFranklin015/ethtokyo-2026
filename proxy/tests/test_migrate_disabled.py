import sqlite3, tempfile, os
import db as dbmod


def _old_shape_db(monkeypatch):
    """A pre-existing DB whose users table already has a NULLABLE default_group_id
    (so the migrate rebuild is skipped) but LACKS the `disabled` column — the shape
    that slips through _migrate's column list."""
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE users (
            id               TEXT PRIMARY KEY,
            username         TEXT UNIQUE NOT NULL,
            password_hash    TEXT NOT NULL,
            default_group_id TEXT REFERENCES groups(id),
            created_at       INTEGER NOT NULL
        );
    """)
    con.commit(); con.close()
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    return path


def test_migrate_adds_disabled_to_old_users(monkeypatch):
    path = _old_shape_db(monkeypatch)
    dbmod.init_db()
    con = sqlite3.connect(path)
    cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
    assert "disabled" in cols, "migration must add users.disabled to an old DB"


def test_ens_lookup_query_runs_after_migration(monkeypatch):
    """The ens-lookup query filters on u.disabled = 0; it must not raise on a
    migrated old DB."""
    path = _old_shape_db(monkeypatch)
    dbmod.init_db()
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    # must not raise OperationalError: no such column: u.disabled
    con.execute(
        "SELECT u.id FROM users u JOIN groups g ON g.id = u.default_group_id "
        "WHERE u.ens_name = ? AND u.disabled = 0", ("nobody.eth",)
    ).fetchall()
