import sqlite3
import os

DB_PATH = os.environ.get("ENSCA_DB", "/var/lib/ensca/ensca.db")


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS admin_tokens (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            token_hash  TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            expires_at  INTEGER,
            last_used_at INTEGER,
            revoked     INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS groups (
            id           TEXT PRIMARY KEY,
            name         TEXT UNIQUE NOT NULL,
            network_tier TEXT NOT NULL,
            notes        TEXT,
            created_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            id               TEXT PRIMARY KEY,
            username         TEXT UNIQUE NOT NULL,
            password_hash    TEXT NOT NULL,
            default_group_id TEXT NOT NULL REFERENCES groups(id),
            ens_name         TEXT,
            wallet_address   TEXT,
            created_at       INTEGER NOT NULL,
            disabled         INTEGER NOT NULL DEFAULT 0,
            notes            TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_users_ens ON users(ens_name) WHERE ens_name IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address) WHERE wallet_address IS NOT NULL;

        -- key_placement: url_path | header | bearer_token | basic_auth | query_param | no_auth
        CREATE TABLE IF NOT EXISTS resources (
            id               TEXT PRIMARY KEY,
            slug             TEXT UNIQUE NOT NULL,
            display_name     TEXT NOT NULL,
            upstream_url     TEXT NOT NULL,
            key_placement    TEXT NOT NULL DEFAULT 'url_path',
            key_header_name  TEXT,
            query_param_name TEXT,
            api_key          TEXT,
            api_key_b64_user TEXT,
            api_key_pending  TEXT,
            enabled          INTEGER NOT NULL DEFAULT 1,
            strip_path_prefix INTEGER NOT NULL DEFAULT 0,
            created_at       INTEGER NOT NULL,
            notes            TEXT
        );

        -- Row existence = access granted. NULL limits = unlimited but allowed.
        CREATE TABLE IF NOT EXISTS group_resource_limits (
            group_id           TEXT NOT NULL REFERENCES groups(id),
            resource_id        TEXT NOT NULL REFERENCES resources(id),
            per_device_per_day INTEGER,
            group_per_day      INTEGER,
            PRIMARY KEY (group_id, resource_id)
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id            TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL REFERENCES users(id),
            group_id      TEXT NOT NULL REFERENCES groups(id),
            ip            TEXT NOT NULL,
            network_tier  TEXT NOT NULL,
            ens_name      TEXT,
            wallet_address TEXT,
            logged_in_at  INTEGER NOT NULL,
            logged_out_at INTEGER,
            revoked_at    INTEGER,
            revoked_by    TEXT REFERENCES admin_tokens(id),
            bytes_in      INTEGER NOT NULL DEFAULT 0,
            bytes_out     INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_ip_active
            ON sessions(ip) WHERE logged_out_at IS NULL AND revoked_at IS NULL;

        CREATE TABLE IF NOT EXISTS usage_events (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            ts             INTEGER NOT NULL,
            session_id     TEXT REFERENCES sessions(id),
            ip             TEXT NOT NULL,
            group_id       TEXT NOT NULL,
            resource_id    TEXT NOT NULL REFERENCES resources(id),
            method         TEXT NOT NULL,
            path           TEXT NOT NULL,
            status         INTEGER NOT NULL,
            upstream_error TEXT,
            req_bytes      INTEGER,
            resp_bytes     INTEGER,
            duration_ms    INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);

        CREATE TABLE IF NOT EXISTS daily_counters (
            date        TEXT NOT NULL,
            ip          TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            count       INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, ip, resource_id)
        );

        CREATE TABLE IF NOT EXISTS daily_group_counters (
            date        TEXT NOT NULL,
            group_id    TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            count       INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (date, group_id, resource_id)
        );

        CREATE TABLE IF NOT EXISTS quota_adjustments (
            id          TEXT PRIMARY KEY,
            date        TEXT NOT NULL,
            scope       TEXT NOT NULL,
            ip          TEXT,
            group_id    TEXT,
            resource_id TEXT NOT NULL REFERENCES resources(id),
            amount      INTEGER NOT NULL,
            reason      TEXT,
            created_by  TEXT REFERENCES admin_tokens(id),
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS audit_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts              INTEGER NOT NULL,
            admin_token_id  TEXT REFERENCES admin_tokens(id),
            method          TEXT NOT NULL,
            path            TEXT NOT NULL,
            request_body    TEXT,
            response_status INTEGER NOT NULL,
            ip              TEXT NOT NULL
        );
    """)
    # Migrations for existing DBs (idempotent ALTER TABLE IF NOT EXISTS via try/except)
    _migrate(conn)
    conn.commit()
    conn.close()


def _migrate(conn):
    """Add columns to existing DBs without breaking fresh installs."""
    migrations = [
        ("users", "ens_name", "TEXT"),
        ("users", "wallet_address", "TEXT"),
        ("sessions", "ens_name", "TEXT"),
        ("sessions", "wallet_address", "TEXT"),
        ("sessions", "bytes_in", "INTEGER NOT NULL DEFAULT 0"),
        ("sessions", "bytes_out", "INTEGER NOT NULL DEFAULT 0"),
        ("resources", "query_param_name", "TEXT"),
        ("resources", "api_key_b64_user", "TEXT"),
        ("resources", "strip_path_prefix", "INTEGER NOT NULL DEFAULT 0"),
    ]
    for table, col, typedef in migrations:
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typedef}")
        except Exception:
            pass  # column already exists
    # key_placement can now be no_auth with no api_key — relax NOT NULL if needed
    try:
        conn.execute("UPDATE resources SET api_key='' WHERE api_key IS NULL")
    except Exception:
        pass
