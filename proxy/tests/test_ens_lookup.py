import os, tempfile
import db as dbmod
from seed_ens import seed


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db"); os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    import sqlite3; seed(sqlite3.connect(path))
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy.app.test_client()


def test_known_name(monkeypatch):
    c = _client(monkeypatch)
    r = c.get("/internal/ens-lookup/BOB.DOCO.ETH", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 200
    assert r.get_json()["network_tier"] == "hacker"


def test_unknown_name(monkeypatch):
    c = _client(monkeypatch)
    r = c.get("/internal/ens-lookup/nobody.eth", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 404


def test_requires_local(monkeypatch):
    c = _client(monkeypatch)
    r = c.get("/internal/ens-lookup/bob.doco.eth", environ_overrides={"REMOTE_ADDR": "10.0.0.9"})
    assert r.status_code == 403
