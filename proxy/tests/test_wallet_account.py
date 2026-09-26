import os
import sqlite3
import tempfile
import time

import db as dbmod
from seed_ens import seed


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _client(monkeypatch, web_url="http://console.test"):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    conn = sqlite3.connect(path)
    seed(conn)
    import proxy
    proxy.app.config["TESTING"] = True
    monkeypatch.setattr(proxy, "ENSCA_WEB_URL", web_url)
    return proxy, proxy.app.test_client(), conn


def _add_session(conn, ip, ens_name, wallet_address):
    # sessions.user_id and group_id are NOT NULL REFERENCES with foreign_keys=ON
    # (proxy/db.py), so the user row MUST exist before the session row is inserted.
    gid = conn.execute("SELECT id FROM groups LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT OR IGNORE INTO users(id,username,password_hash,default_group_id,created_at) "
        "VALUES('sess-user','sess-user','!',?,?)",
        (gid, int(time.time())),
    )
    conn.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,ens_name,wallet_address,logged_in_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("sess-1", "sess-user", gid, ip, "hacker", ens_name, wallet_address, int(time.time())),
    )
    conn.commit()


def test_returns_wallet_for_active_session(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.5", "philo.tokyo.ethglobal2.eth", "0xOWNER")
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.5"})
    assert r.status_code == 200
    assert r.get_json()["address"] == "0xOWNER"


def test_no_session_is_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.9"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "no_account"


def test_falls_back_to_resolve_owner_when_session_lacks_wallet(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.6", "leo.tokyo.ethglobal2.eth", None)
    monkeypatch.setattr(
        proxy.req_lib, "get",
        lambda *a, **k: _Resp(200, {"owner": "0xRESOLVED", "name": "leo.tokyo.ethglobal2.eth"}),
    )
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.6"})
    assert r.status_code == 200
    assert r.get_json()["address"] == "0xRESOLVED"


def test_resolve_404_is_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.7", "ghost.tokyo.ethglobal2.eth", None)
    monkeypatch.setattr(proxy.req_lib, "get", lambda *a, **k: _Resp(404))
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.7"})
    assert r.status_code == 404
    assert r.get_json()["error"] == "no_account"


def test_resolve_unreachable_is_retryable_not_no_account(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.8", "leo.tokyo.ethglobal2.eth", None)

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(proxy.req_lib, "get", boom)
    r = c.get("/api/wallet/account", environ_overrides={"REMOTE_ADDR": "10.0.0.8"})
    assert r.status_code == 503
    assert r.get_json()["error"] == "resolve_unreachable"


def test_ignores_forwarded_header_spoof(monkeypatch):
    proxy, c, conn = _client(monkeypatch)
    _add_session(conn, "10.0.0.5", "philo.tokyo.ethglobal2.eth", "0xOWNER")
    # Attacker on .99 forges XFF claiming .5 — must NOT get .5's wallet.
    r = c.get(
        "/api/wallet/account",
        environ_overrides={"REMOTE_ADDR": "10.0.0.99"},
        headers={"X-Forwarded-For": "10.0.0.5", "X-Real-IP": "10.0.0.5"},
    )
    assert r.status_code == 404
