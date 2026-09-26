"""The ens-lookup endpoint resolving through ENS rather than the local users table.

ENS is the authority on which group a name belongs to. The enforcer remains the authority on what
that group means on this network -- its tier, VLAN and quota -- so the on-chain group name is
mapped through the local groups table rather than trusted wholesale.
"""

import os
import sqlite3
import tempfile

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
    seed(sqlite3.connect(path))

    import proxy

    proxy.app.config["TESTING"] = True
    monkeypatch.setattr(proxy, "ENSCA_WEB_URL", web_url)
    return proxy, proxy.app.test_client()


def _local(client, name):
    return client.get(
        f"/internal/ens-lookup/{name}", environ_overrides={"REMOTE_ADDR": "127.0.0.1"}
    )


def test_resolves_group_from_ens(monkeypatch):
    proxy, c = _client(monkeypatch)

    # The console reports the group ENS publishes for this name.
    monkeypatch.setattr(
        proxy.req_lib,
        "get",
        lambda *a, **k: _Resp(
            200,
            {
                "name": "bob.doco.eth",
                "role": "hacker",
                "branch": "doco.eth",
                "entitlements": {"wifi.group": "hacker", "wifi.rate": "5mbps"},
            },
        ),
    )

    r = _local(c, "bob.doco.eth")
    assert r.status_code == 200
    body = r.get_json()
    assert body["source"] == "ens"
    assert body["role"] == "hacker"
    # The tier came from the enforcer's own groups table, not from the chain.
    assert body["network_tier"] == "hacker"
    assert body["group_id"]


def test_ens_404_is_a_definite_deny(monkeypatch):
    """A name holding no membership is denied even though the local table still lists it."""
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(proxy.req_lib, "get", lambda *a, **k: _Resp(404))

    r = _local(c, "bob.doco.eth")
    assert r.status_code == 404
    assert r.get_json()["source"] == "ens"


def test_group_this_enforcer_does_not_run_is_denied(monkeypatch):
    """ENS may name a group this branch has no configuration for. Guessing would be worse."""
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(
        proxy.req_lib,
        "get",
        lambda *a, **k: _Resp(
            200, {"role": "trainer", "entitlements": {"wifi.group": "no-such-group"}}
        ),
    )

    r = _local(c, "bob.doco.eth")
    assert r.status_code == 404
    body = r.get_json()
    assert body["error"] == "unknown_group"
    assert body["group"] == "no-such-group"


def test_falls_back_to_local_when_console_unreachable(monkeypatch):
    """Being unable to ask is not the same as a deny -- the network must keep working."""
    proxy, c = _client(monkeypatch)

    def boom(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(proxy.req_lib, "get", boom)

    r = _local(c, "bob.doco.eth")
    assert r.status_code == 200
    assert r.get_json()["source"] == "local"


def test_unconfigured_console_uses_local_path(monkeypatch):
    proxy, c = _client(monkeypatch, web_url="")

    def fail(*a, **k):
        raise AssertionError("must not call the console when ENSCA_WEB_URL is unset")

    monkeypatch.setattr(proxy.req_lib, "get", fail)

    r = _local(c, "bob.doco.eth")
    assert r.status_code == 200
    assert r.get_json()["source"] == "local"


def test_unknown_name_still_404s_locally(monkeypatch):
    proxy, c = _client(monkeypatch, web_url="")
    r = _local(c, "nobody.eth")
    assert r.status_code == 404
