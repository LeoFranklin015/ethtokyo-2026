# ENS-Identity VLAN & Group Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the captive portal's tier login with an ENS-name identity flow where the entered ENS name maps (via SQLite) to a group that determines bandwidth, API access, and per-user quota, with every ENS user network-isolated from every other.

**Architecture:** Portal (root, owns iptables/tc) resolves an entered ENS name to a `users` row + group via a new proxy internal endpoint, rejects unknown names, grants access with the group's fwmark tier, and isolates each ENS user at L3. Proxy gates API access by `group_resource_limits` row existence and meters a new per-ENS-user daily quota bucket. A portal reaper thread revokes stale IPs so the CPL auto-clears on disconnect.

**Tech Stack:** Python 3 / Flask (portal :8080 as root, proxy :8081 local), SQLite (`/var/lib/ensca/ensca.db`), iptables + tc (fwmark HTB) on `enp10s0u1`, systemd services on the Fedora VM.

**Spec:** `docs/superpowers/specs/2026-09-26-ens-identity-vlan-design.md`

## Global Constraints

- DB path is `/var/lib/ensca/ensca.db`; all schema changes must be idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `ALTER TABLE`) — the DB already has live data.
- `network_tier` → group is 1:1 (`group-by-tier` uses `LIMIT 1`); each group gets a distinct `network_tier` (`hacker`, `partner`).
- Bandwidth marks are fixed by `/etc/NetworkManager/dispatcher.d/99-ensca`: 10→5Mbit, 20→10Mbit, 30→1Gbit, 99→1Mbit. Do NOT edit the dispatcher; reuse existing marks (hacker=30, partner=10).
- Portal internal calls go to proxy over `127.0.0.1:8081`; proxy `/internal/*` routes are `@require_local`.
- ENS names are normalized lowercase + stripped before any lookup or storage.
- Unknown ENS name = rejected at portal (no grant, no session).
- Deploy target is the VM at `172.16.0.130` (user `philo`); `/opt/ensca` on the VM is NOT git — deploy by copying worktree files over, keeping `.pre-ens.bak` backups.
- All VM-mutating steps run behind `echo '<sudo-pass>' | sudo -S` where root is needed; never commit the sudo password.
- The local repo `main` proxy is the canonical superset; deploying it to the VM (closing the 1358-vs-1112 drift) is in scope.

## Review Focus

- **Unknown/empty/malformed ENS name at /login** — must re-render login with an error, never grant. Test in the portal login task.
- **Same ENS name, second device** — must join the same user/group/quota bucket and be allowed to talk to the first device, not isolated from it. Test in the isolation task.
- **Two different ENS users in the same group (hacker)** — must be mutually DROPped despite sharing a group. Test in the isolation task.
- **`check_and_increment` called with an ENS name that has no `per_ens_per_day` row** — must fall through to device/group checks without crashing (nullable column). Test in the rate-limit task.
- **Reaper revoking an IP that reconnects immediately** — a brief neigh gap must not revoke an active device before the ~20s threshold; and a revoked IP must be able to re-login cleanly. Test in the reaper task.

---

## File Structure

- `proxy/db.py` — add `daily_ens_counters` table to the `executescript` schema; add `per_ens_per_day` to `group_resource_limits`; add the `ALTER TABLE` for `per_ens_per_day` to the additive migration list (L177-193). Add a seed function for groups/users/resources/grants.
- `proxy/rate_limit.py` — extend `check_and_increment` with an `ens_name` param + per-ENS bucket; extend `get_usage_for_ip`.
- `proxy/proxy.py` — add `/internal/ens-lookup/<name>`; pass the session's `ens_name` into `check_and_increment`.
- `portal/app.py` — rewrite `/login` to resolve+reject via ens-lookup; replace `_apply_cross_tier_rules` with ENS-keyed isolation; start a reaper thread; thread `ens_name`+`user_id` into grant/session-created.
- `scripts/seed_ens.py` (new) — idempotent seed of the two groups, five users, and the Alchemy resource + hacker grant. (May instead live as a `db.py` function invoked by a one-shot; decided in Task 2.)
- Deploy: copy `proxy/*` and `portal/*` to VM `/opt/ensca/`, restart services.

## Task 1: Schema — per-ENS-user quota bucket

**Files:**
- Modify: `proxy/db.py` (schema `executescript` block; migration list L177-193)
- Test: `proxy/tests/test_schema.py` (create)

**Interfaces:**
- Produces: table `daily_ens_counters(date TEXT, ens_name TEXT, resource_id TEXT, count INTEGER DEFAULT 0, PRIMARY KEY(date,ens_name,resource_id))`; column `group_resource_limits.per_ens_per_day INTEGER` (nullable).

- [ ] **Step 1: Write the failing test**

```python
# proxy/tests/test_schema.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && python -m pytest tests/test_schema.py -v`
Expected: FAIL — `daily_ens_counters` has no columns / `per_ens_per_day` missing.

- [ ] **Step 3: Add the table to the schema `executescript`**

In `db.py`, alongside the `daily_group_counters` CREATE, add:

```sql
CREATE TABLE IF NOT EXISTS daily_ens_counters (
    date        TEXT NOT NULL,
    ens_name    TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    count       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, ens_name, resource_id)
);
```

Add `per_ens_per_day INTEGER` to the `group_resource_limits` CREATE (after `group_per_day INTEGER`).

- [ ] **Step 4: Add the migration for existing DBs**

In the additive `ALTER TABLE` list (`db.py` L177-193), add:

```python
("group_resource_limits", "per_ens_per_day", "INTEGER"),
```

matching the existing list's tuple shape (verify the exact shape when editing; the loop swallows duplicate-column errors). If `daily_ens_counters` is only in the `executescript` (run with `IF NOT EXISTS`), no migration entry is needed for the table itself.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd proxy && python -m pytest tests/test_schema.py -v`
Expected: PASS (both).

- [ ] **Step 6: Verify migration is idempotent on a pre-existing DB**

```python
# add to test_schema.py
def test_migration_idempotent(monkeypatch):
    con = _fresh_db(monkeypatch)
    dbmod.init_db()  # run again — must not raise
    cols = {r[1] for r in con.execute("PRAGMA table_info(group_resource_limits)")}
    assert "per_ens_per_day" in cols
```
Run the file again; expected PASS.

- [ ] **Step 7: Commit**

```bash
git add proxy/db.py proxy/tests/test_schema.py
git commit -m "feat(db): add per-ENS-user daily quota bucket schema"
```

## Task 2: Seed groups, users, and Alchemy resource

**Files:**
- Create: `proxy/seed_ens.py`
- Test: `proxy/tests/test_seed.py`

**Interfaces:**
- Consumes: db schema from Task 1.
- Produces: function `seed(db)` that idempotently inserts groups `hacker`(network_tier `hacker`) + `partner`(network_tier `partner`); users bob.doco.eth, alice.eth (default_group=hacker), world.eth, soy.eth, uniswap.eth (default_group=partner) with `password_hash=''`, `ens_name` set; resource `alchemy` (slug `alchemy`, upstream `https://eth-mainnet.g.alchemy.com/v2`, key_placement `url_path`, api_key from env `ALCHEMY_KEY`); `group_resource_limits` row for (hacker, alchemy) with `per_device_per_day=NULL, group_per_day=NULL, per_ens_per_day=1000`; NO row for (partner, alchemy).

- [ ] **Step 1: Write the failing test**

```python
# proxy/tests/test_seed.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && python -m pytest tests/test_seed.py -v`
Expected: FAIL — `seed_ens` module missing.

- [ ] **Step 3: Write `seed_ens.py`**

```python
import os, time, uuid

GROUPS = [("hacker", "hacker"), ("partner", "partner")]  # (name, network_tier)
USERS = [
    ("bob.doco.eth", "hacker"), ("alice.eth", "hacker"),
    ("world.eth", "partner"), ("soy.eth", "partner"), ("uniswap.eth", "partner"),
]

def _get_or_create_group(db, name, tier):
    row = db.execute("SELECT id FROM groups WHERE network_tier=?", (tier,)).fetchone()
    if row:
        return row[0]
    gid = str(uuid.uuid4())
    db.execute("INSERT INTO groups(id,name,network_tier,notes,created_at) VALUES(?,?,?,?,?)",
               (gid, name, tier, "seeded", int(time.time())))
    return gid

def _get_or_create_user(db, ens, gid):
    row = db.execute("SELECT id FROM users WHERE username=?", (ens,)).fetchone()
    if row:
        db.execute("UPDATE users SET default_group_id=?, ens_name=? WHERE id=?", (gid, ens, row[0]))
        return row[0]
    uid = str(uuid.uuid4())
    db.execute("INSERT INTO users(id,username,password_hash,default_group_id,ens_name,created_at) "
               "VALUES(?,?,?,?,?,?)", (uid, ens, "", gid, ens, int(time.time())))
    return uid

def _get_or_create_alchemy(db):
    row = db.execute("SELECT id FROM resources WHERE slug='alchemy'").fetchone()
    if row:
        return row[0]
    rid = str(uuid.uuid4())
    db.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,api_key,enabled,created_at) "
        "VALUES(?,?,?,?,?,?,1,?)",
        (rid, "alchemy", "Alchemy Mainnet", "https://eth-mainnet.g.alchemy.com/v2",
         "url_path", os.environ.get("ALCHEMY_KEY", ""), int(time.time())))
    return rid

def seed(db):
    gids = {tier: _get_or_create_group(db, name, tier) for name, tier in GROUPS}
    for ens, tier in USERS:
        _get_or_create_user(db, ens, gids[tier])
    alchemy = _get_or_create_alchemy(db)
    # hacker gets Alchemy; partner explicitly does NOT
    db.execute(
        "INSERT OR IGNORE INTO group_resource_limits"
        "(group_id,resource_id,per_device_per_day,group_per_day,per_ens_per_day) "
        "VALUES(?,?,NULL,NULL,1000)", (gids["hacker"], alchemy))
    db.commit()

if __name__ == "__main__":
    import sqlite3
    import db as dbmod
    dbmod.init_db()
    con = sqlite3.connect(dbmod.DB_PATH)
    seed(con)
    print("seeded")
```

Note: `db.py` exposes NO standalone connection getter — `get_db()` is Flask-request-bound. Scripts use `sqlite3.connect(db.DB_PATH)` directly (`DB_PATH = os.environ.get("ENSCA_DB", "/var/lib/ensca/ensca.db")`, db.py L5). The test helper and `__main__` above already do this.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd proxy && python -m pytest tests/test_seed.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add proxy/seed_ens.py proxy/tests/test_seed.py
git commit -m "feat: seed hacker/partner groups, ENS users, Alchemy resource+grant"
```

## Task 3: Proxy `/internal/ens-lookup/<name>` endpoint

**Files:**
- Modify: `proxy/proxy.py` (add route near the other `/internal/*` routes, ~L1169)
- Test: `proxy/tests/test_ens_lookup.py`

**Interfaces:**
- Consumes: `users` + `groups` from Task 2; `@require_local` decorator (auth.py L81).
- Produces: `GET /internal/ens-lookup/<name>` → `200 {"group_id","network_tier","user_id","ens_name"}` for a known name; `404 {"error":"not_found"}` for unknown. Name is lowercased+stripped before lookup.

- [ ] **Step 1: Write the failing test**

```python
# proxy/tests/test_ens_lookup.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && python -m pytest tests/test_ens_lookup.py -v`
Expected: FAIL — route 404 for the known name too (route absent).

- [ ] **Step 3: Add the route**

Next to `/internal/group-by-tier` (proxy.py ~L1169):

```python
@app.route("/internal/ens-lookup/<name>")
@require_local
def internal_ens_lookup(name):
    ens = (name or "").strip().lower()
    db = get_db()
    row = db.execute(
        "SELECT u.id AS user_id, u.username AS ens_name, g.id AS group_id, g.network_tier "
        "FROM users u JOIN groups g ON g.id = u.default_group_id "
        "WHERE u.username = ? AND u.disabled = 0", (ens,)
    ).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"user_id": row["user_id"], "ens_name": row["ens_name"],
                    "group_id": row["group_id"], "network_tier": row["network_tier"]})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd proxy && python -m pytest tests/test_ens_lookup.py -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add proxy/proxy.py proxy/tests/test_ens_lookup.py
git commit -m "feat(proxy): add /internal/ens-lookup for portal ENS resolution"
```

## Task 4: Per-ENS-user quota in `check_and_increment`

**Files:**
- Modify: `proxy/rate_limit.py` (`check_and_increment` L34; `get_usage_for_ip` L134)
- Modify: `proxy/proxy.py` (call site L823)
- Test: `proxy/tests/test_rate_limit_ens.py`

**Interfaces:**
- Consumes: `daily_ens_counters` + `per_ens_per_day` (Task 1); session `ens_name` (present on `sessions`, Task 5 threads it in).
- Produces: new signature `check_and_increment(ip, group_id, resource_id, ens_name=None)`. When the grant row's `per_ens_per_day` is not NULL and `ens_name` is given, enforce + increment `daily_ens_counters` keyed on `ens_name`. NULL `per_ens_per_day` or `ens_name=None` → behaves exactly as before.

- [ ] **Step 1: Write the failing test**

```python
# proxy/tests/test_rate_limit_ens.py
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

def test_shared_bucket_blocks_second_device(monkeypatch):
    con = _setup(monkeypatch, 2)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    assert rate_limit.check_and_increment("1.1.1.1", "g", "r", "bob.eth") is None
    assert rate_limit.check_and_increment("2.2.2.2", "g", "r", "bob.eth") is None  # same ENS, 2nd device
    blocked = rate_limit.check_and_increment("3.3.3.3", "g", "r", "bob.eth")       # 3rd hit, over cap 2
    assert blocked and blocked["scope"] == "ens"

def test_null_per_ens_is_noop(monkeypatch):
    con = _setup(monkeypatch, None)
    monkeypatch.setattr("rate_limit.get_db", lambda: con)
    import rate_limit
    for _ in range(5):
        assert rate_limit.check_and_increment("1.1.1.1", "g", "r", "bob.eth") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd proxy && python -m pytest tests/test_rate_limit_ens.py -v`
Expected: FAIL — signature rejects 4th arg / no `ens` scope.

- [ ] **Step 3: Extend `check_and_increment`**

Change signature to `def check_and_increment(ip, group_id, resource_id, ens_name=None):`. In the SELECT of limits, also read `per_ens_per_day`. After the device check and before the group increment path, add an ENS check mirroring the device atomic pattern (rate_limit.py L58-66 style) but on `daily_ens_counters` keyed `(date, ens_name, resource_id)`:

```python
per_ens = limits["per_ens_per_day"] if "per_ens_per_day" in limits.keys() else None
if ens_name and per_ens is not None:
    row = db.execute(
        "INSERT INTO daily_ens_counters(date,ens_name,resource_id,count) VALUES(?,?,?,1) "
        "ON CONFLICT(date,ens_name,resource_id) DO UPDATE SET count=count+1 "
        "WHERE count < ? RETURNING count",
        (date, ens_name, resource_id, per_ens)
    ).fetchone()
    if row is None:
        used = (db.execute("SELECT COALESCE(count,0) c FROM daily_ens_counters "
                           "WHERE date=? AND ens_name=? AND resource_id=?",
                           (date, ens_name, resource_id)).fetchone() or {"c": 0})["c"]
        return {"scope": "ens", "limit": per_ens, "used": used, "resets_at": _resets_at()}
```

Follow the file's existing atomic-increment + block-shape conventions exactly (match how device/group scopes build their return dict and how `_resets_at` is named). The ENS increment must happen in the same allowed path ordering the existing code uses so a blocked device/group check does not leave the ENS counter incremented (mirror the existing order: check device → check group → the tracking increments; slot the ENS atomic where the group atomic sits).

- [ ] **Step 4: Update the proxy call site**

`proxy/proxy.py` L823 — pass the session's ENS name:

```python
limit_hit = check_and_increment(ip, group_id, resource["id"], session["ens_name"])
```

(`sessions.ens_name` exists per schema; the session row is already fetched at L798-802. If `ens_name` can be NULL for legacy rows, `session["ens_name"]` NULL → no-op, which is correct.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd proxy && python -m pytest tests/test_rate_limit_ens.py tests/test_schema.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add proxy/rate_limit.py proxy/proxy.py proxy/tests/test_rate_limit_ens.py
git commit -m "feat(ratelimit): per-ENS-user shared daily quota bucket"
```

## Task 5: Portal `/login` — resolve + reject + thread ENS through

**Files:**
- Modify: `portal/app.py` (`/login` L217; `_notify_session_created` L98; `grant_access` L129; `_resolve_group` L82)
- Test: `portal/tests/test_login.py`

**Interfaces:**
- Consumes: proxy `GET /internal/ens-lookup/<name>` (Task 3).
- Produces: `/login` looks the entered ENS name up; unknown → re-render login with error and NO grant; known → `grant_access(ip, network_tier)` with the resolved tier and stores `ENS_NAMES[ip]`, and the ENS name + user_id ride into `_notify_session_created`.

- [ ] **Step 1: Write the failing test**

```python
# portal/tests/test_login.py
import app as portalmod

def test_unknown_name_rejected(monkeypatch):
    monkeypatch.setattr(portalmod, "_lookup_ens", lambda name: None)
    granted = []
    monkeypatch.setattr(portalmod, "grant_access", lambda ip, tier, **k: granted.append((ip, tier)))
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    r = c.post("/login", data={"ens_name": "nobody"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
    assert granted == []
    assert b"not recognized" in r.data.lower() or b"not recognised" in r.data.lower()

def test_known_name_grants_resolved_tier(monkeypatch):
    monkeypatch.setattr(portalmod, "_lookup_ens",
                        lambda name: {"group_id": "g", "network_tier": "hacker",
                                      "user_id": "u", "ens_name": "bob.doco.eth"})
    granted = {}
    monkeypatch.setattr(portalmod, "grant_access",
                        lambda ip, tier, **k: granted.update({"ip": ip, "tier": tier, "k": k}))
    portalmod.app.config["TESTING"] = True
    c = portalmod.app.test_client()
    r = c.post("/login", data={"ens_name": "Bob.Doco.ETH"}, environ_overrides={"REMOTE_ADDR": "192.168.0.50"})
    assert granted["tier"] == "hacker"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && python -m pytest tests/test_login.py -v`
Expected: FAIL — `_lookup_ens` missing; /login grants "basic" for any name.

- [ ] **Step 3: Add `_lookup_ens` and rewrite `/login`**

Add near `_resolve_group` (app.py L82). Note: `requests` is imported as `_req`, and the proxy base constant is `PROXY_INTERNAL = "http://127.0.0.1:8081"`:

```python
def _lookup_ens(name):
    ens = (name or "").strip().lower()
    if not ens:
        return None
    try:
        r = _req.get(f"{PROXY_INTERNAL}/internal/ens-lookup/{ens}", timeout=3)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return None
```

Rewrite `/login` (app.py L217-226):

```python
@app.route("/login", methods=["POST"])
def login():
    ens_name = request.form.get("ens_name", "").strip().lower()
    ip = client_ip()
    ident = _lookup_ens(ens_name)
    if not ident:
        return render_template("login.html", error="ENS name not recognized")
    ENS_NAMES[ip] = ident["ens_name"]
    grant_access(ip, ident["network_tier"], ens_name=ident["ens_name"], user_id=ident["user_id"])
    return redirect(f"{PORTAL_URL}/connected", 302)
```

- [ ] **Step 4: Thread ENS + user_id into grant/session-created**

The real signatures are `grant_access(ip, tier)` (L129) and `_notify_session_created(session_id, ip, tier)` (L98), and the latter hardcodes `"user_id": "portal-anon"` (L105). Widen both:

`grant_access` → `def grant_access(ip, tier, ens_name=None, user_id=None):`. Its last line (L157) `_notify_session_created(sid, ip, tier)` becomes `_notify_session_created(sid, ip, tier, ens_name, user_id)`.

`_notify_session_created` → `def _notify_session_created(session_id, ip, tier, ens_name=None, user_id=None):`. In the POST JSON body: change `"user_id": "portal-anon"` to `"user_id": user_id or "portal-anon"` and add `"ens_name": ens_name`. (The proxy INSERT at proxy.py L1205 already has an `ens_name` column and re-resolves user_id; sending the real values lets it store the ENS identity instead of the sentinel.)

Add the resolved tiers to `TIER_MARK` (L51):

```python
TIER_MARK = {"basic": "10", "staff": "20", "vip": "30", "partner": "10", "hacker": "30"}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd portal && python -m pytest tests/test_login.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add portal/app.py portal/tests/test_login.py
git commit -m "feat(portal): resolve ENS name to group, reject unknown, thread identity"
```

## Task 6: Per-ENS-user L2 isolation

**Files:**
- Modify: `portal/app.py` — replace `_apply_cross_tier_rules` (L186-195) with ENS-keyed isolation; it is already called from `grant_access` (L150) and `revoke_access` (L178).
- Test: `portal/tests/test_isolation.py`

**Interfaces:**
- Consumes: `AUTHED_IPS{ip→tier}` (L53), `ENS_NAMES{ip→name}` (L55), `_run_ok(cmd: list)` (L76).
- Produces: `_apply_ens_isolation(ip, action)` (replaces `_apply_cross_tier_rules`) that inserts/deletes FORWARD DROP rules between `ip` and every other authed IP whose **ENS name differs** — same-name IPs are never dropped. Bandwidth mark unchanged (still set in grant_access from the group's tier).

Note: the existing `_apply_cross_tier_rules(ip, tier, action)` takes `tier`; the replacement drops the `tier` param and reads `ENS_NAMES` instead. Update BOTH call sites: `grant_access` L150 `_apply_cross_tier_rules(ip, tier, action="I")` → `_apply_ens_isolation(ip, action="I")`; `revoke_access` L178 `_apply_cross_tier_rules(ip, tier, action="D")` → `_apply_ens_isolation(ip, action="D")`. Both call it while holding `_state_lock`, so the function must NOT re-acquire the lock (reads `ENS_NAMES` directly). In `grant_access`, `ENS_NAMES[ip]` must be set BEFORE the `_apply_ens_isolation(ip, "I")` call — currently `/login` sets `ENS_NAMES[ip]` before calling `grant_access`, so it is present; assert this ordering holds.

- [ ] **Step 1: Write the failing test**

```python
# portal/tests/test_isolation.py
import app as portalmod

def test_isolate_different_ens_allow_same(monkeypatch):
    calls = []
    monkeypatch.setattr(portalmod, "_run_ok", lambda cmd: calls.append(cmd))
    portalmod.AUTHED_IPS.clear(); portalmod.ENS_NAMES.clear()
    # three already-authed peers
    portalmod.AUTHED_IPS.update({"192.168.0.11": "hacker", "192.168.0.12": "hacker",
                                 "192.168.0.13": "partner"})
    portalmod.ENS_NAMES.update({"192.168.0.11": "bob.doco.eth",
                                "192.168.0.12": "alice.eth",
                                "192.168.0.13": "world.eth"})
    # new bob device joins
    portalmod.AUTHED_IPS["192.168.0.10"] = "hacker"
    portalmod.ENS_NAMES["192.168.0.10"] = "bob.doco.eth"
    portalmod._apply_ens_isolation("192.168.0.10", action="I")
    flat = [" ".join(c) for c in calls]
    joined = "\n".join(flat)
    # dropped vs alice (.12) and world (.13) — different ENS — both directions
    assert any("-s 192.168.0.10 -d 192.168.0.12" in f for f in flat)
    assert any("-s 192.168.0.12 -d 192.168.0.10" in f for f in flat)
    assert any("-d 192.168.0.13" in f and "192.168.0.10" in f for f in flat)
    # NOT dropped vs the other bob device (.11) — same ENS
    assert "192.168.0.11" not in joined
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && python -m pytest tests/test_isolation.py -v`
Expected: FAIL — `_apply_ens_isolation` missing.

- [ ] **Step 3: Replace `_apply_cross_tier_rules` with `_apply_ens_isolation`**

Replace the function at L186-195 with:

```python
def _apply_ens_isolation(ip: str, action: str) -> None:
    """Insert (I) or delete (D) DROP rules between ip and every authed IP on a DIFFERENT ENS name."""
    my_name = ENS_NAMES.get(ip)
    for other_ip in list(AUTHED_IPS.keys()):
        if other_ip == ip:
            continue
        if ENS_NAMES.get(other_ip) == my_name and my_name is not None:
            continue  # same ENS user — allowed to talk
        _run_ok(["iptables", f"-{action}", "FORWARD",
                 "-s", ip, "-d", other_ip, "-j", "DROP"])
        _run_ok(["iptables", f"-{action}", "FORWARD",
                 "-s", other_ip, "-d", ip, "-j", "DROP"])
```

Then update the two call sites (grant_access L150, revoke_access L178) to `_apply_ens_isolation(ip, action="I")` / `_apply_ens_isolation(ip, action="D")` and drop the now-unused `tier` argument at those sites. `revoke_access` still has `tier`/`mark` locals for the MARK deletes — leave those; only the isolation call changes. Note `revoke_access` pops `ENS_NAMES[ip]` at L180 AFTER the L178 isolation call, so `my_name` is still resolvable during the delete — keep that ordering.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd portal && python -m pytest tests/test_isolation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portal/app.py portal/tests/test_isolation.py
git commit -m "feat(portal): per-ENS-user L2 isolation replacing tier isolation"
```

## Task 7: Disconnect reaper thread (CPL auto-clear)

**Files:**
- Modify: `portal/app.py` (add reaper thread + start it under `__main__` / app init)
- Test: `portal/tests/test_reaper.py`

**Interfaces:**
- Consumes: `AUTHED_IPS` (L53), `revoke_access` (L160), `ip neigh show dev enp10s0u1`.
- Produces: a daemon thread that every ~10s reads the neighbor table; an authed IP absent/`FAILED` for ≥~20s (2 consecutive misses) is passed to `revoke_access(ip)`. Pure logic (which IPs to revoke given last-seen map + now) is factored into a testable function `_stale_ips(last_seen, authed, now, ttl=20)`.

- [ ] **Step 1: Write the failing test**

```python
# portal/tests/test_reaper.py
import app as portalmod

def test_stale_ips_selects_absent_beyond_ttl():
    authed = {"192.168.0.10", "192.168.0.11"}
    last_seen = {"192.168.0.10": 100.0, "192.168.0.11": 60.0}
    # now=85: .10 seen 15s ago (fresh), .11 seen 25s ago (stale, > ttl 20)
    stale = portalmod._stale_ips(last_seen, authed, now=85.0, ttl=20)
    assert stale == {"192.168.0.11"}

def test_never_seen_uses_grace():
    authed = {"192.168.0.10"}
    stale = portalmod._stale_ips({}, authed, now=1000.0, ttl=20)
    # never-seen within grace should not be revoked immediately on first tick
    assert stale == set()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd portal && python -m pytest tests/test_reaper.py -v`
Expected: FAIL — `_stale_ips` missing.

- [ ] **Step 3: Implement `_stale_ips` + reaper loop**

```python
def _stale_ips(last_seen, authed, now, ttl=20):
    stale = set()
    for ip in list(authed):
        seen = last_seen.get(ip)
        if seen is None:
            continue  # grace: recorded on first sighting, not revoked before first miss
        if now - seen > ttl:
            stale.add(ip)
    return stale

def _neigh_ips(dev="enp10s0u1"):
    out = subprocess.run(["ip", "neigh", "show", "dev", dev],
                         capture_output=True, text=True).stdout
    live = set()
    for line in out.splitlines():
        parts = line.split()
        if not parts:
            continue
        ip = parts[0]
        if "REACHABLE" in line or "STALE" in line or "DELAY" in line or "PROBE" in line:
            live.add(ip)
    return live

def _reaper_loop():
    last_seen = {}
    while True:
        now = time.time()
        live = _neigh_ips()
        for ip in live:
            last_seen[ip] = now
        with _state_lock:
            authed = set(AUTHED_IPS.keys())
        for ip in authed:  # first sighting seeds last_seen so grace applies
            last_seen.setdefault(ip, now)
        for ip in _stale_ips(last_seen, authed, now):
            revoke_access(ip)
            last_seen.pop(ip, None)
        time.sleep(10)
```

Start it once at app init: `threading.Thread(target=_reaper_loop, daemon=True).start()`. Ensure `subprocess`, `time`, `threading` imports exist. Guard against double-start under Flask reloader (start only in the main process / when `__name__=="__main__"` or a module-level `_reaper_started` flag).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd portal && python -m pytest tests/test_reaper.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add portal/app.py portal/tests/test_reaper.py
git commit -m "feat(portal): disconnect reaper revokes stale IPs (CPL auto-clear)"
```

## Task 8: Deploy to VM + full self-test

**Files:**
- No dispatcher change (isolation is inline FORWARD rules). Deploy repo files + verify on VM.

**Interfaces:**
- Consumes: all prior tasks, committed.

- [ ] **Step 1: Run the full local test suite**

Run: `cd proxy && python -m pytest -q && cd ../portal && python -m pytest -q`
Expected: all PASS. Do not deploy on any failure.

- [ ] **Step 2: Back up current VM files**

```bash
ssh philo@172.16.0.130 'cd /opt/ensca && for f in proxy/proxy.py proxy/db.py proxy/rate_limit.py portal/app.py; do cp "$f" "$f.pre-ens2.bak"; done'
```

- [ ] **Step 3: Copy worktree files to VM**

```bash
scp proxy/proxy.py proxy/db.py proxy/rate_limit.py proxy/seed_ens.py philo@172.16.0.130:/opt/ensca/proxy/
scp portal/app.py philo@172.16.0.130:/opt/ensca/portal/
```

- [ ] **Step 4: Run migration + seed on VM**

```bash
ssh philo@172.16.0.130 "cd /opt/ensca/proxy && ALCHEMY_KEY='<real-key>' python3 -c 'import db; db.init_db()' && ALCHEMY_KEY='<real-key>' python3 seed_ens.py"
```
Expected: prints `seeded`; `groups` has `hacker`+`partner`, `users` has the 5 ENS names, `group_resource_limits` has hacker→alchemy only.

- [ ] **Step 5: Restart services**

Isolation is inline FORWARD DROP rules inserted per-IP by the portal (no new chain, no dispatcher edit needed). Confirm the real unit names, then restart:
```bash
ssh philo@172.16.0.130 "systemctl list-units | grep ensca"
ssh philo@172.16.0.130 "echo '<sudo-pass>' | sudo -S systemctl restart ensca-proxy ensca-portal"
```

- [ ] **Step 6: Self-test — the 8 spec tests, from the VM**

Run each and record PASS/FAIL (simulate multiple devices via distinct source IPs / namespaces):

1. **ENS→group:** login bob.doco.eth → session network_tier `hacker`, mark 30; world.eth → `partner`, mark 10.
2. **Shared identity:** two source IPs, same ENS name → same group; they can ping each other; one shared quota bucket.
3. **Per-user isolation:** bob-IP and alice-IP (both hacker) → cannot reach each other (ENSCA_ISO DROP).
4. **Bandwidth:** `tc -s class show dev enp10s0u1` shows hacker traffic in class 1:30, partner in 1:10.
5. **API access:** proxy request as hacker → Alchemy 200; as partner → 403 `access_denied`.
6. **Rate limit:** exceed `per_ens_per_day` on device A → device B (same ENS) also blocked with scope `ens`.
7. **Reaper:** drop an IP from neigh (disconnect) → within ~20s AUTHED_IPS cleared, session revoked; re-login works fresh with no manual cache clear.
8. **Unknown name:** login `nobody.eth` → login re-rendered with "not recognized", no session, no grant.

- [ ] **Step 7: Record results in the ledger and report to the user**

Summarize the 8 results. Only after all pass (or the user accepts any caveats) hand off for real-device testing. Do not `git commit` VM-only state; the repo is already committed from prior tasks.

