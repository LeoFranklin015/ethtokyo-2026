from upstream import inject_provider


def test_injects_script_before_head_close():
    html = b"<html><head><title>x</title></head><body>hi</body></html>"
    out, headers = inject_provider(html, "text/html; charset=utf-8", {})
    assert b"/wallet/provider.js" in out
    assert out.index(b"provider.js") < out.index(b"</head>")


def test_strips_csp_and_frame_headers():
    html = b"<html><head></head></html>"
    hdrs = {"Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY", "Content-Type": "text/html"}
    out, headers = inject_provider(html, "text/html", hdrs)
    assert "Content-Security-Policy" not in headers
    assert "X-Frame-Options" not in headers


def test_non_html_is_untouched():
    data = b'{"ok":true}'
    out, headers = inject_provider(data, "application/json", {"Content-Type": "application/json"})
    assert out == data


def test_html_without_head_still_injects():
    html = b"<html><body>hi</body></html>"
    out, headers = inject_provider(html, "text/html", {})
    assert b"/wallet/provider.js" in out


import os
import sqlite3
import tempfile
import time

import db as dbmod
from seed_ens import seed


def _client(monkeypatch):
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    monkeypatch.setattr(dbmod, "DB_PATH", path)
    dbmod.init_db()
    conn = sqlite3.connect(path)
    seed(conn)
    # a resource + a session with access, mirroring the /proxy/<slug> preconditions
    gid = conn.execute("SELECT id FROM groups LIMIT 1").fetchone()[0]
    conn.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,enabled,created_at) "
        "VALUES('res-1','demo','Demo','http://upstream.test','no_auth',1,?)",
        (int(time.time()),),
    )
    conn.execute(
        "INSERT INTO group_resource_limits(group_id,resource_id) VALUES(?, 'res-1')", (gid,)
    )
    conn.execute(
        "INSERT OR IGNORE INTO users(id,username,password_hash,default_group_id,created_at) "
        "VALUES('u1','u1','!',?,?)",
        (gid, int(time.time())),
    )
    conn.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,logged_in_at) "
        "VALUES('s1','u1',?, '127.0.0.1','hacker',?)",
        (gid, int(time.time())),
    )
    conn.commit()

    import proxy

    proxy.app.config["TESTING"] = True
    return proxy, proxy.app.test_client()


def test_proxy_injects_provider_into_html_when_enabled(monkeypatch):
    monkeypatch.setenv("WALLET_INJECT", "1")
    proxy, c = _client(monkeypatch)
    # forward returns the 7-tuple: content, status, req_b, resp_b, dur, err, content_type
    monkeypatch.setattr(
        proxy, "forward",
        lambda *a, **k: (b"<html><head></head><body>x</body></html>", 200, 0, 22, 1, None, "text/html; charset=utf-8"),
    )
    r = c.get("/proxy/demo", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.status_code == 200
    assert b"/wallet/provider.js" in r.data


def test_proxy_leaves_non_html_untouched(monkeypatch):
    monkeypatch.setenv("WALLET_INJECT", "1")
    proxy, c = _client(monkeypatch)
    monkeypatch.setattr(
        proxy, "forward",
        lambda *a, **k: (b'{"ok":true}', 200, 0, 11, 1, None, "application/json"),
    )
    r = c.get("/proxy/demo", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
    assert r.data == b'{"ok":true}'
