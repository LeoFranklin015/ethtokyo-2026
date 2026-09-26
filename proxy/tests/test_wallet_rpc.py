import os
import sqlite3
import tempfile

import db as dbmod
from seed_ens import seed
from wallet_allowlist import SIGNING_METHODS


class _Resp:
    def __init__(self, status, payload=None):
        self.status_code = status
        self._payload = payload

    def json(self):
        return self._payload


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    seed(sqlite3.connect(path))
    import proxy
    proxy.app.config["TESTING"] = True
    return proxy, proxy.app.test_client()


def test_read_method_is_forwarded(monkeypatch):
    proxy, c = _client(monkeypatch)
    called = {}

    def fake_request(method, url, **k):
        called["url"] = url
        called["json"] = k.get("json")
        return _Resp(200, {"jsonrpc": "2.0", "id": 1, "result": "0x64"})

    monkeypatch.setattr(proxy.req_lib, "request", fake_request)
    r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance", "params": ["0xabc", "latest"]})
    assert r.status_code == 200
    assert r.get_json()["result"] == "0x64"
    assert called["json"]["method"] == "eth_getBalance"


def test_signing_method_is_not_forwarded(monkeypatch):
    proxy, c = _client(monkeypatch)

    def must_not_call(*a, **k):
        raise AssertionError("signing method must never reach upstream")

    monkeypatch.setattr(proxy.req_lib, "request", must_not_call)
    for m in SIGNING_METHODS:
        r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 7, "method": m, "params": []})
        assert r.status_code == 200
        body = r.get_json()
        assert body["error"]["code"] == -32601
        assert "id" in body and body["id"] == 7


def test_unknown_method_rejected(monkeypatch):
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(proxy.req_lib, "request", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no forward")))
    r = c.post("/api/wallet/rpc", json={"jsonrpc": "2.0", "id": 1, "method": "eth_signFutureThing"})
    assert r.get_json()["error"]["code"] == -32601


def test_batch_splits_read_and_signing(monkeypatch):
    proxy, c = _client(monkeypatch)

    def fake_request(method, url, **k):
        return _Resp(200, {"jsonrpc": "2.0", "id": k["json"]["id"], "result": "0x1"})

    monkeypatch.setattr(proxy.req_lib, "request", fake_request)
    r = c.post("/api/wallet/rpc", json=[
        {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": []},
        {"jsonrpc": "2.0", "id": 2, "method": "eth_sendTransaction", "params": []},
    ])
    out = r.get_json()
    assert isinstance(out, list) and len(out) == 2
    by_id = {o["id"]: o for o in out}
    assert by_id[1]["result"] == "0x1"
    assert by_id[2]["error"]["code"] == -32601
