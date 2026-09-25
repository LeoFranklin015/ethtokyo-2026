import json
import time
import uuid
import os
import bcrypt
from datetime import datetime, timezone
from flask import Flask, request, jsonify, g, Response, stream_with_context
import requests as req_lib

from db import get_db, init_db
from auth import require_admin, require_authed_ip, require_local, verify_admin_token
from rate_limit import check_and_increment, get_usage_for_ip
from upstream import forward, record_event

app = Flask(__name__)
PORTAL_INTERNAL = "http://127.0.0.1:8080"


# ── helpers ──────────────────────────────────────────────────────────────────

def _now() -> int:
    return int(time.time())


def _uuid() -> str:
    return str(uuid.uuid4())


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _mask_key(key: str) -> str:
    if not key or len(key) <= 4:
        return "****"
    return f"****{key[-4:]}"


def _row(r) -> dict:
    return dict(r) if r else None


def _audit(method, path, body, status):
    """Write audit log row. Called after every control plane write."""
    token_id = getattr(g, "admin_token", None)
    token_id = token_id["id"] if token_id else None
    safe_body = None
    if body:
        try:
            d = dict(body)
            for k in ("password", "api_key", "new_key", "token"):
                if k in d:
                    d[k] = "REDACTED"
            safe_body = json.dumps(d)
        except Exception:
            safe_body = "REDACTED"
    db = get_db()
    db.execute(
        "INSERT INTO audit_log(ts,admin_token_id,method,path,request_body,response_status,ip) "
        "VALUES(?,?,?,?,?,?,?)",
        (_now(), token_id, method, path, safe_body, status, request.remote_addr)
    )
    db.commit()


def _resource_dict(r, include_key=False) -> dict:
    d = {
        "id": r["id"], "slug": r["slug"], "display_name": r["display_name"],
        "upstream_url": r["upstream_url"], "key_placement": r["key_placement"],
        "key_header_name": r["key_header_name"],
        "enabled": bool(r["enabled"]),
        "has_pending_key": r["api_key_pending"] is not None,
        "created_at": r["created_at"], "notes": r["notes"],
    }
    if include_key:
        d["api_key_masked"] = _mask_key(r["api_key"])
    return d


def _session_dict(s) -> dict:
    return {
        "id": s["id"], "user_id": s["user_id"],
        "username": s["username"] if "username" in s.keys() else None,
        "group_id": s["group_id"],
        "group_name": s["group_name"] if "group_name" in s.keys() else None,
        "ip": s["ip"], "network_tier": s["network_tier"],
        "logged_in_at": s["logged_in_at"],
        "logged_out_at": s["logged_out_at"],
        "revoked_at": s["revoked_at"],
    }


# ── health ────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "ts": _now()})


@app.route("/status")
def status():
    if request.remote_addr not in ("127.0.0.1", "::1"):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not verify_admin_token(auth[7:]):
            return jsonify({"error": "unauthorized"}), 401
    db = get_db()
    try:
        db.execute("SELECT 1").fetchone()
        db_ok = "ok"
    except Exception as e:
        db_ok = str(e)
    active = db.execute(
        "SELECT COUNT(*) as c FROM sessions WHERE logged_out_at IS NULL AND revoked_at IS NULL"
    ).fetchone()["c"]
    res = db.execute("SELECT COUNT(*) as t, SUM(enabled) as e FROM resources").fetchone()
    return jsonify({
        "db": db_ok, "active_sessions": active,
        "resources_total": res["t"], "resources_enabled": res["e"] or 0,
    })


# ── admin tokens ──────────────────────────────────────────────────────────────

@app.route("/admin/tokens", methods=["POST"])
def create_token():
    # Allow from localhost without existing token (bootstrap)
    if request.remote_addr not in ("127.0.0.1", "::1"):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or not verify_admin_token(auth[7:]):
            return jsonify({"error": "unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "name required"}), 400
    raw = str(uuid.uuid4()).replace("-", "")
    hashed = bcrypt.hashpw(raw.encode(), bcrypt.gensalt()).decode()
    tid = _uuid()
    db = get_db()
    db.execute(
        "INSERT INTO admin_tokens(id,name,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        (tid, name, hashed, _now(), data.get("expires_at"))
    )
    db.commit()
    _audit("POST", "/admin/tokens", data, 201)
    return jsonify({"id": tid, "name": name, "token": raw,
                    "expires_at": data.get("expires_at")}), 201


@app.route("/admin/tokens", methods=["GET"])
@require_admin
def list_tokens():
    rows = get_db().execute("SELECT * FROM admin_tokens ORDER BY created_at DESC").fetchall()
    return jsonify({"tokens": [
        {"id": r["id"], "name": r["name"], "created_at": r["created_at"],
         "expires_at": r["expires_at"], "last_used_at": r["last_used_at"],
         "revoked": bool(r["revoked"])} for r in rows
    ]})


@app.route("/admin/tokens/<tid>", methods=["DELETE"])
@require_admin
def revoke_token(tid):
    db = get_db()
    if not db.execute("SELECT 1 FROM admin_tokens WHERE id=?", (tid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    db.execute("UPDATE admin_tokens SET revoked=1 WHERE id=?", (tid,))
    db.commit()
    _audit("DELETE", f"/admin/tokens/{tid}", None, 200)
    return jsonify({"revoked": True})


# ── groups ────────────────────────────────────────────────────────────────────

@app.route("/admin/groups", methods=["POST"])
@require_admin
def create_group():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    tier = data.get("network_tier", "")
    if not name or tier not in ("basic", "staff", "vip"):
        return jsonify({"error": "name and valid network_tier required"}), 400
    db = get_db()
    if db.execute("SELECT 1 FROM groups WHERE name=?", (name,)).fetchone():
        return jsonify({"error": "name_taken"}), 409
    gid = _uuid()
    db.execute(
        "INSERT INTO groups(id,name,network_tier,notes,created_at) VALUES(?,?,?,?,?)",
        (gid, name, tier, data.get("notes"), _now())
    )
    db.commit()
    _audit("POST", "/admin/groups", data, 201)
    return jsonify(_row(db.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone())), 201


@app.route("/admin/groups", methods=["GET"])
@require_admin
def list_groups():
    db = get_db()
    rows = db.execute("""
        SELECT g.*, COUNT(DISTINCT u.id) as member_count,
               COUNT(DISTINCT CASE WHEN s.logged_out_at IS NULL AND s.revoked_at IS NULL THEN s.id END) as active_session_count
        FROM groups g
        LEFT JOIN users u ON u.default_group_id = g.id
        LEFT JOIN sessions s ON s.group_id = g.id
        GROUP BY g.id ORDER BY g.name
    """).fetchall()
    return jsonify({"groups": [dict(r) for r in rows]})


@app.route("/admin/groups/<gid>", methods=["GET"])
@require_admin
def get_group(gid):
    db = get_db()
    g_row = db.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()
    if not g_row:
        return jsonify({"error": "not_found"}), 404
    members = db.execute(
        "SELECT id,username,disabled FROM users WHERE default_group_id=?", (gid,)
    ).fetchall()
    limits = db.execute(
        "SELECT grl.*, r.slug FROM group_resource_limits grl "
        "JOIN resources r ON r.id=grl.resource_id WHERE grl.group_id=?", (gid,)
    ).fetchall()
    today = _today()
    usage = {}
    for lim in limits:
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
            (today, gid, lim["resource_id"])
        ).fetchone() or {"c": 0})["c"]
        usage[lim["slug"]] = {"used": used, "limit": lim["group_per_day"]}
    return jsonify({
        **dict(g_row),
        "members": [dict(m) for m in members],
        "limits": {l["slug"]: {"per_device_per_day": l["per_device_per_day"],
                                "group_per_day": l["group_per_day"]} for l in limits},
        "usage_today": usage,
    })


@app.route("/admin/groups/<gid>", methods=["PATCH"])
@require_admin
def update_group(gid):
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    data = request.get_json(silent=True) or {}
    if "network_tier" in data and data["network_tier"] not in ("basic", "staff", "vip"):
        return jsonify({"error": "invalid network_tier"}), 400
    fields = {k: data[k] for k in ("name", "network_tier", "notes") if k in data}
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE groups SET {sets} WHERE id=?", (*fields.values(), gid))
        db.commit()
    _audit("PATCH", f"/admin/groups/{gid}", data, 200)
    return jsonify(_row(db.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()))


@app.route("/admin/groups/<gid>", methods=["DELETE"])
@require_admin
def delete_group(gid):
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    if db.execute("SELECT 1 FROM users WHERE default_group_id=?", (gid,)).fetchone():
        return jsonify({"error": "group_has_members"}), 409
    db.execute("DELETE FROM group_resource_limits WHERE group_id=?", (gid,))
    db.execute("DELETE FROM groups WHERE id=?", (gid,))
    db.commit()
    _audit("DELETE", f"/admin/groups/{gid}", None, 200)
    return jsonify({"deleted": True})


@app.route("/admin/groups/<gid>/members", methods=["POST"])
@require_admin
def add_member(gid):
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
        return jsonify({"error": "group_not_found"}), 404
    data = request.get_json(silent=True) or {}
    uid = data.get("user_id")
    if not uid or not db.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify({"error": "user_not_found"}), 404
    db.execute("UPDATE users SET default_group_id=? WHERE id=?", (gid, uid))
    db.commit()
    _audit("POST", f"/admin/groups/{gid}/members", data, 200)
    return jsonify({"user_id": uid, "group_id": gid})


@app.route("/admin/groups/<gid>/members/<uid>", methods=["DELETE"])
@require_admin
def remove_member(gid, uid):
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id=? AND default_group_id=?", (uid, gid)).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    _audit("DELETE", f"/admin/groups/{gid}/members/{uid}", None, 200)
    return jsonify({"removed": True, "note": "Use PATCH /admin/users/:id to reassign to another group"})


@app.route("/admin/groups/<gid>/limits/<rid>", methods=["PUT"])
@require_admin
def set_group_limit(gid, rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
        return jsonify({"error": "group_not_found"}), 404
    if not db.execute("SELECT 1 FROM resources WHERE id=?", (rid,)).fetchone():
        return jsonify({"error": "resource_not_found"}), 404
    data = request.get_json(silent=True) or {}
    per_dev = data.get("per_device_per_day")  # None = unlimited
    per_grp = data.get("group_per_day")
    db.execute(
        "INSERT INTO group_resource_limits(group_id,resource_id,per_device_per_day,group_per_day) "
        "VALUES(?,?,?,?) ON CONFLICT(group_id,resource_id) DO UPDATE SET "
        "per_device_per_day=excluded.per_device_per_day, group_per_day=excluded.group_per_day",
        (gid, rid, per_dev, per_grp)
    )
    db.commit()
    _audit("PUT", f"/admin/groups/{gid}/limits/{rid}", data, 200)
    return jsonify({"group_id": gid, "resource_id": rid,
                    "per_device_per_day": per_dev, "group_per_day": per_grp})


@app.route("/admin/groups/<gid>/limits/<rid>", methods=["DELETE"])
@require_admin
def delete_group_limit(gid, rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?",
                      (gid, rid)).fetchone():
        return jsonify({"error": "not_found"}), 404
    db.execute("DELETE FROM group_resource_limits WHERE group_id=? AND resource_id=?", (gid, rid))
    db.commit()
    _audit("DELETE", f"/admin/groups/{gid}/limits/{rid}", None, 200)
    return jsonify({"deleted": True, "note": "Access to this resource revoked for the group"})


# ── users ─────────────────────────────────────────────────────────────────────

@app.route("/admin/users", methods=["POST"])
@require_admin
def create_user():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    group_id = data.get("group_id", "")
    if not username or not password or not group_id:
        return jsonify({"error": "username, password, group_id required"}), 400
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (group_id,)).fetchone():
        return jsonify({"error": "group_not_found"}), 404
    if db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return jsonify({"error": "username_taken"}), 409
    uid = _uuid()
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    db.execute(
        "INSERT INTO users(id,username,password_hash,default_group_id,created_at,notes) VALUES(?,?,?,?,?,?)",
        (uid, username, pw_hash, group_id, _now(), data.get("notes"))
    )
    db.commit()
    _audit("POST", "/admin/users", data, 201)
    return jsonify({"id": uid, "username": username, "group_id": group_id,
                    "created_at": _now(), "disabled": False}), 201


@app.route("/admin/users", methods=["GET"])
@require_admin
def list_users():
    db = get_db()
    qp = request.args
    where, params = ["1=1"], []
    if qp.get("group_id"):
        where.append("default_group_id=?"); params.append(qp["group_id"])
    if qp.get("disabled") is not None:
        where.append("disabled=?"); params.append(int(qp["disabled"]))
    limit = int(qp.get("limit", 50))
    offset = int(qp.get("offset", 0))
    total = db.execute(f"SELECT COUNT(*) as c FROM users WHERE {' AND '.join(where)}", params).fetchone()["c"]
    rows = db.execute(f"SELECT id,username,default_group_id,created_at,disabled FROM users "
                      f"WHERE {' AND '.join(where)} LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
    return jsonify({"users": [dict(r) for r in rows], "total": total})


@app.route("/admin/users/<uid>", methods=["GET"])
@require_admin
def get_user(uid):
    db = get_db()
    user = db.execute(
        "SELECT u.*, g.name as group_name, g.network_tier FROM users u "
        "JOIN groups g ON g.id=u.default_group_id WHERE u.id=?", (uid,)
    ).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    session = db.execute(
        "SELECT * FROM sessions WHERE user_id=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (uid,)
    ).fetchone()
    usage = get_usage_for_ip(session["ip"], session["group_id"]) if session else {}
    return jsonify({
        "id": user["id"], "username": user["username"],
        "group": {"id": user["default_group_id"], "name": user["group_name"],
                  "network_tier": user["network_tier"]},
        "disabled": bool(user["disabled"]), "created_at": user["created_at"],
        "notes": user["notes"],
        "active_session": _session_dict(session) if session else None,
        "usage_today": usage,
    })


@app.route("/admin/users/<uid>", methods=["PATCH"])
@require_admin
def update_user(uid):
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    data = request.get_json(silent=True) or {}
    updates = {}
    if "group_id" in data:
        if not db.execute("SELECT 1 FROM groups WHERE id=?", (data["group_id"],)).fetchone():
            return jsonify({"error": "group_not_found"}), 404
        updates["default_group_id"] = data["group_id"]
    if "password" in data:
        updates["password_hash"] = bcrypt.hashpw(data["password"].encode(), bcrypt.gensalt()).decode()
    if "disabled" in data:
        updates["disabled"] = int(bool(data["disabled"]))
    if "notes" in data:
        updates["notes"] = data["notes"]
    if updates:
        sets = ", ".join(f"{k}=?" for k in updates)
        db.execute(f"UPDATE users SET {sets} WHERE id=?", (*updates.values(), uid))
        db.commit()
    _audit("PATCH", f"/admin/users/{uid}", data, 200)
    return jsonify(_row(db.execute(
        "SELECT id,username,default_group_id,created_at,disabled,notes FROM users WHERE id=?", (uid,)
    ).fetchone()))


@app.route("/admin/users/<uid>", methods=["DELETE"])
@require_admin
def delete_user(uid):
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    # Null out session references in usage_events before deleting sessions
    db.execute("UPDATE usage_events SET session_id=NULL WHERE session_id IN "
               "(SELECT id FROM sessions WHERE user_id=?)", (uid,))
    db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
    db.execute("DELETE FROM users WHERE id=?", (uid,))
    db.commit()
    _audit("DELETE", f"/admin/users/{uid}", None, 200)
    return jsonify({"deleted": True})


@app.route("/admin/users/<uid>/revoke", methods=["POST"])
@require_admin
def revoke_user(uid):
    db = get_db()
    if not db.execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    session = db.execute(
        "SELECT * FROM sessions WHERE user_id=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (uid,)
    ).fetchone()
    if not session:
        return jsonify({"session_id": None, "revoked": True})
    db.execute("UPDATE sessions SET revoked_at=?, revoked_by=? WHERE id=?",
               (_now(), g.admin_token["id"], session["id"]))
    db.commit()
    # Tell portal to flush iptables rule
    try:
        req_lib.post(f"{PORTAL_INTERNAL}/internal/revoke-ip",
                     json={"ip": session["ip"]}, timeout=5)
    except Exception:
        pass
    _audit("POST", f"/admin/users/{uid}/revoke", None, 200)
    return jsonify({"session_id": session["id"], "revoked": True, "ip": session["ip"]})


# ── resources ─────────────────────────────────────────────────────────────────

@app.route("/admin/resources", methods=["POST"])
@require_admin
def create_resource():
    data = request.get_json(silent=True) or {}
    slug = data.get("slug", "").strip()
    upstream = data.get("upstream_url", "").strip()
    placement = data.get("key_placement", "")
    api_key = data.get("api_key", "").strip()
    if not slug or not upstream or placement not in ("url_path", "header") or not api_key:
        return jsonify({"error": "slug, upstream_url, key_placement, api_key required"}), 400
    if placement == "header" and not data.get("key_header_name"):
        return jsonify({"error": "key_header_name required when key_placement=header"}), 400
    db = get_db()
    if db.execute("SELECT 1 FROM resources WHERE slug=?", (slug,)).fetchone():
        return jsonify({"error": "slug_taken"}), 409
    rid = _uuid()
    db.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,"
        "key_header_name,api_key,enabled,created_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (rid, slug, data.get("display_name", slug), upstream, placement,
         data.get("key_header_name"), api_key,
         int(data.get("enabled", True)), _now(), data.get("notes"))
    )
    db.commit()
    _audit("POST", "/admin/resources", data, 201)
    row = db.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
    return jsonify(_resource_dict(row, include_key=True)), 201


@app.route("/admin/resources", methods=["GET"])
@require_admin
def list_resources():
    rows = get_db().execute("SELECT * FROM resources ORDER BY slug").fetchall()
    return jsonify({"resources": [_resource_dict(r) for r in rows]})


@app.route("/admin/resources/<rid>", methods=["GET"])
@require_admin
def get_resource(rid):
    db = get_db()
    row = db.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    limits = db.execute(
        "SELECT grl.*, g.name as group_name FROM group_resource_limits grl "
        "JOIN groups g ON g.id=grl.group_id WHERE grl.resource_id=?", (rid,)
    ).fetchall()
    d = _resource_dict(row, include_key=True)
    d["group_access"] = [{"group_id": l["group_id"], "group_name": l["group_name"],
                           "per_device_per_day": l["per_device_per_day"],
                           "group_per_day": l["group_per_day"]} for l in limits]
    return jsonify(d)


@app.route("/admin/resources/<rid>", methods=["PATCH"])
@require_admin
def update_resource(rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM resources WHERE id=?", (rid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    data = request.get_json(silent=True) or {}
    fields = {k: data[k] for k in
              ("display_name", "upstream_url", "key_placement", "key_header_name", "notes") if k in data}
    if "enabled" in data:
        fields["enabled"] = int(bool(data["enabled"]))
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE resources SET {sets} WHERE id=?", (*fields.values(), rid))
        db.commit()
    _audit("PATCH", f"/admin/resources/{rid}", data, 200)
    return jsonify(_resource_dict(db.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone(),
                                  include_key=True))


@app.route("/admin/resources/<rid>", methods=["DELETE"])
@require_admin
def delete_resource(rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM resources WHERE id=?", (rid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    if db.execute("SELECT 1 FROM group_resource_limits WHERE resource_id=?", (rid,)).fetchone():
        return jsonify({"error": "resource_has_active_limits — remove group limits first"}), 409
    db.execute("DELETE FROM resources WHERE id=?", (rid,))
    db.commit()
    _audit("DELETE", f"/admin/resources/{rid}", None, 200)
    return jsonify({"deleted": True})


@app.route("/admin/resources/<rid>/rotate-key", methods=["PATCH"])
@require_admin
def rotate_key(rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM resources WHERE id=?", (rid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    data = request.get_json(silent=True) or {}
    new_key = data.get("new_key", "").strip()
    if not new_key:
        return jsonify({"error": "new_key required"}), 400
    db.execute("UPDATE resources SET api_key_pending=? WHERE id=?", (new_key, rid))
    db.commit()
    _audit("PATCH", f"/admin/resources/{rid}/rotate-key", data, 200)
    return jsonify({"staged": True, "commit_url": f"/admin/resources/{rid}/commit-key"})


@app.route("/admin/resources/<rid>/commit-key", methods=["POST"])
@require_admin
def commit_key(rid):
    db = get_db()
    row = db.execute("SELECT * FROM resources WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    if not row["api_key_pending"]:
        return jsonify({"error": "no_pending_key"}), 409
    db.execute("UPDATE resources SET api_key=api_key_pending, api_key_pending=NULL WHERE id=?", (rid,))
    db.commit()
    _audit("POST", f"/admin/resources/{rid}/commit-key", None, 200)
    return jsonify({"committed": True, "activated_at": _now()})


@app.route("/admin/resources/<rid>/pending-key", methods=["DELETE"])
@require_admin
def discard_pending_key(rid):
    db = get_db()
    row = db.execute("SELECT api_key_pending FROM resources WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    if not row["api_key_pending"]:
        return jsonify({"error": "no_pending_key"}), 404
    db.execute("UPDATE resources SET api_key_pending=NULL WHERE id=?", (rid,))
    db.commit()
    _audit("DELETE", f"/admin/resources/{rid}/pending-key", None, 200)
    return jsonify({"discarded": True})


# ── sessions ──────────────────────────────────────────────────────────────────

@app.route("/admin/sessions", methods=["GET"])
@require_admin
def list_sessions():
    db = get_db()
    qp = request.args
    where, params = ["1=1"], []
    if qp.get("active") == "true":
        where.append("s.logged_out_at IS NULL AND s.revoked_at IS NULL")
    elif qp.get("active") == "false":
        where.append("(s.logged_out_at IS NOT NULL OR s.revoked_at IS NOT NULL)")
    if qp.get("user_id"):
        where.append("s.user_id=?"); params.append(qp["user_id"])
    if qp.get("group_id"):
        where.append("s.group_id=?"); params.append(qp["group_id"])
    limit = int(qp.get("limit", 50))
    offset = int(qp.get("offset", 0))
    base = ("FROM sessions s JOIN users u ON u.id=s.user_id "
            "JOIN groups g ON g.id=s.group_id WHERE " + " AND ".join(where))
    total = db.execute(f"SELECT COUNT(*) as c {base}", params).fetchone()["c"]
    rows = db.execute(
        f"SELECT s.*,u.username,g.name as group_name {base} "
        f"ORDER BY s.logged_in_at DESC LIMIT ? OFFSET ?", params + [limit, offset]
    ).fetchall()
    return jsonify({"sessions": [_session_dict(r) for r in rows], "total": total})


@app.route("/admin/sessions/<sid>", methods=["GET"])
@require_admin
def get_session(sid):
    db = get_db()
    s = db.execute(
        "SELECT s.*,u.username,g.name as group_name FROM sessions s "
        "JOIN users u ON u.id=s.user_id JOIN groups g ON g.id=s.group_id WHERE s.id=?", (sid,)
    ).fetchone()
    if not s:
        return jsonify({"error": "not_found"}), 404
    usage = db.execute(
        "SELECT r.slug, COUNT(*) as count, COALESCE(SUM(req_bytes),0) as req_bytes, "
        "COALESCE(SUM(resp_bytes),0) as resp_bytes FROM usage_events ue "
        "JOIN resources r ON r.id=ue.resource_id WHERE ue.session_id=? GROUP BY ue.resource_id",
        (sid,)
    ).fetchall()
    d = _session_dict(s)
    d["usage"] = {r["slug"]: {"count": r["count"], "req_bytes": r["req_bytes"],
                               "resp_bytes": r["resp_bytes"]} for r in usage}
    return jsonify(d)


@app.route("/admin/sessions/<sid>", methods=["DELETE"])
@require_admin
def revoke_session(sid):
    db = get_db()
    s = db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if not s:
        return jsonify({"error": "not_found"}), 404
    if s["logged_out_at"] or s["revoked_at"]:
        return jsonify({"error": "session_already_ended"}), 409
    db.execute("UPDATE sessions SET revoked_at=?, revoked_by=? WHERE id=?",
               (_now(), g.admin_token["id"], sid))
    db.commit()
    try:
        req_lib.post(f"{PORTAL_INTERNAL}/internal/revoke-ip",
                     json={"ip": s["ip"]}, timeout=5)
    except Exception:
        pass
    _audit("DELETE", f"/admin/sessions/{sid}", None, 200)
    return jsonify({"revoked": True, "ip": s["ip"]})


# ── proxy ─────────────────────────────────────────────────────────────────────

@app.route("/proxy/<slug>", defaults={"subpath": ""}, methods=["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"])
@app.route("/proxy/<slug>/<path:subpath>", methods=["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"])
def proxy(slug, subpath):
    ip = request.remote_addr
    db = get_db()

    # Auth: active session for this IP
    session = db.execute(
        "SELECT s.*, g.id as gid FROM sessions s JOIN groups g ON g.id=s.group_id "
        "WHERE s.ip=? AND s.logged_out_at IS NULL AND s.revoked_at IS NULL "
        "ORDER BY s.logged_in_at DESC LIMIT 1", (ip,)
    ).fetchone()
    if not session:
        return jsonify({"error": "not_authenticated"}), 403

    # Resource lookup
    resource = db.execute("SELECT * FROM resources WHERE slug=? AND enabled=1", (slug,)).fetchone()
    if not resource:
        disabled = db.execute("SELECT 1 FROM resources WHERE slug=? AND enabled=0", (slug,)).fetchone()
        return jsonify({"error": "resource_disabled" if disabled else "resource_not_found"}), 503 if disabled else 404

    # Access check: row in group_resource_limits must exist
    group_id = session["group_id"]
    access = db.execute(
        "SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?",
        (group_id, resource["id"])
    ).fetchone()
    if not access:
        return jsonify({"error": "access_denied", "detail": "your group does not have access to this resource"}), 403

    # Rate limit check + increment
    limit_hit = check_and_increment(ip, group_id, resource["id"])
    if limit_hit:
        record_event(db, session["id"], ip, group_id, resource["id"],
                     request.method, subpath, 429, "rate_limit_exceeded", 0, 0, 0)
        return jsonify({"error": "rate_limit_exceeded", **limit_hit}), 429

    # Forward
    resp, status, req_bytes, resp_bytes, duration_ms, upstream_error = forward(
        dict(resource), request.method, subpath, request
    )

    record_event(db, session["id"], ip, group_id, resource["id"],
                 request.method, subpath, status, upstream_error,
                 req_bytes, resp_bytes, duration_ms)

    if resp is None:
        return jsonify({"error": "upstream_unreachable", "detail": upstream_error}), 502

    # Stream response back
    excluded = {"transfer-encoding", "content-encoding", "content-length"}
    headers = [(k, v) for k, v in resp.headers.items() if k.lower() not in excluded]
    return Response(resp.content, status=status, headers=headers)


# ── usage & analytics ─────────────────────────────────────────────────────────

@app.route("/usage/me")
@require_authed_ip
def usage_me():
    session = g.session
    usage = get_usage_for_ip(session["ip"], session["group_id"])
    return jsonify({
        "ip": session["ip"], "group": session["group_name"],
        "date": _today(), "resources": usage,
    })


@app.route("/admin/usage")
@require_admin
def admin_usage():
    db = get_db()
    qp = request.args
    where, params = ["1=1"], []
    if qp.get("date"):
        where.append("date(ue.ts,'unixepoch')=?"); params.append(qp["date"])
    else:
        where.append("date(ue.ts,'unixepoch')=?"); params.append(_today())
    if qp.get("resource_id"):
        where.append("ue.resource_id=?"); params.append(qp["resource_id"])
    if qp.get("group_id"):
        where.append("ue.group_id=?"); params.append(qp["group_id"])
    if qp.get("ip"):
        where.append("ue.ip=?"); params.append(qp["ip"])
    limit = int(qp.get("limit", 100))
    offset = int(qp.get("offset", 0))
    base = ("FROM usage_events ue "
            "JOIN resources r ON r.id=ue.resource_id "
            "LEFT JOIN sessions s ON s.id=ue.session_id "
            "LEFT JOIN users u ON u.id=s.user_id "
            "LEFT JOIN groups g ON g.id=ue.group_id "
            f"WHERE {' AND '.join(where)}")
    total = db.execute(f"SELECT COUNT(*) as c {base}", params).fetchone()["c"]
    rows = db.execute(
        f"SELECT ue.*,r.slug as resource_slug,u.username,g.name as group_name {base} "
        f"ORDER BY ue.ts DESC LIMIT ? OFFSET ?", params + [limit, offset]
    ).fetchall()
    return jsonify({"events": [dict(r) for r in rows], "total": total})


@app.route("/admin/usage/summary")
@require_admin
def usage_summary():
    db = get_db()
    qp = request.args
    frm = qp.get("from", _today())
    to = qp.get("to", _today())
    where, params = ["date(ue.ts,'unixepoch') BETWEEN ? AND ?"], [frm, to]
    if qp.get("group_id"):
        where.append("ue.group_id=?"); params.append(qp["group_id"])
    if qp.get("resource_id"):
        where.append("ue.resource_id=?"); params.append(qp["resource_id"])
    rows = db.execute(
        f"SELECT date(ue.ts,'unixepoch') as date, ue.group_id, g.name as group_name, "
        f"ue.resource_id, r.slug as resource_slug, "
        f"COUNT(*) as request_count, COALESCE(SUM(ue.req_bytes),0) as total_req_bytes, "
        f"COALESCE(SUM(ue.resp_bytes),0) as total_resp_bytes "
        f"FROM usage_events ue JOIN resources r ON r.id=ue.resource_id "
        f"JOIN groups g ON g.id=ue.group_id WHERE {' AND '.join(where)} "
        f"GROUP BY date, ue.group_id, ue.resource_id ORDER BY date DESC, request_count DESC",
        params
    ).fetchall()
    return jsonify({"rows": [dict(r) for r in rows]})


@app.route("/admin/usage/top-consumers")
@require_admin
def top_consumers():
    db = get_db()
    qp = request.args
    scope = qp.get("scope", "device")
    metric = qp.get("metric", "count")
    date = qp.get("date", _today())
    limit = int(qp.get("limit", 10))
    metric_col = {"count": "COUNT(*)", "req_bytes": "COALESCE(SUM(req_bytes),0)",
                  "resp_bytes": "COALESCE(SUM(resp_bytes),0)"}.get(metric, "COUNT(*)")
    where, params = ["date(ue.ts,'unixepoch')=?"], [date]
    if qp.get("resource_id"):
        where.append("ue.resource_id=?"); params.append(qp["resource_id"])
    if scope == "device":
        group_col, label_col = "ue.ip", "ue.ip as display"
    else:
        group_col, label_col = "ue.group_id", "g.name as display"
    rows = db.execute(
        f"SELECT {group_col} as key, {label_col}, r.slug as resource_slug, "
        f"{metric_col} as value FROM usage_events ue "
        f"JOIN resources r ON r.id=ue.resource_id "
        f"LEFT JOIN groups g ON g.id=ue.group_id "
        f"WHERE {' AND '.join(where)} GROUP BY {group_col}, ue.resource_id "
        f"ORDER BY value DESC LIMIT ?", params + [limit]
    ).fetchall()
    return jsonify({"rows": [dict(r) for r in rows]})


@app.route("/admin/usage/export")
@require_admin
def export_usage():
    db = get_db()
    qp = request.args
    frm = qp.get("from", _today())
    to = qp.get("to", _today())
    where, params = ["date(ue.ts,'unixepoch') BETWEEN ? AND ?"], [frm, to]
    if qp.get("resource_id"):
        where.append("ue.resource_id=?"); params.append(qp["resource_id"])
    if qp.get("group_id"):
        where.append("ue.group_id=?"); params.append(qp["group_id"])

    def generate():
        yield "id,ts,ip,username,group,resource,method,path,status,req_bytes,resp_bytes,duration_ms,upstream_error\n"
        rows = db.execute(
            f"SELECT ue.*,r.slug as resource_slug,u.username,g.name as group_name "
            f"FROM usage_events ue JOIN resources r ON r.id=ue.resource_id "
            f"LEFT JOIN sessions s ON s.id=ue.session_id "
            f"LEFT JOIN users u ON u.id=s.user_id "
            f"LEFT JOIN groups g ON g.id=ue.group_id "
            f"WHERE {' AND '.join(where)} ORDER BY ue.ts ASC", params
        ).fetchall()
        for r in rows:
            yield (f"{r['id']},{r['ts']},{r['ip']},{r['username'] or ''},\"{r['group_name']}\","
                   f"{r['resource_slug']},{r['method']},{r['path']},{r['status']},"
                   f"{r['req_bytes'] or 0},{r['resp_bytes'] or 0},{r['duration_ms'] or 0},"
                   f"{r['upstream_error'] or ''}\n")

    return Response(
        stream_with_context(generate()),
        content_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=usage-{frm}-to-{to}.csv"}
    )


# ── quota management ──────────────────────────────────────────────────────────

@app.route("/admin/quota")
@require_admin
def get_quota():
    db = get_db()
    qp = request.args
    scope = qp.get("scope")
    resource_id = qp.get("resource_id")
    date = qp.get("date", _today())
    if scope == "device":
        ip = qp.get("ip")
        if not ip:
            return jsonify({"error": "ip required for scope=device"}), 400
        group = db.execute(
            "SELECT group_id FROM sessions WHERE ip=? AND logged_out_at IS NULL AND revoked_at IS NULL "
            "ORDER BY logged_in_at DESC LIMIT 1", (ip,)
        ).fetchone()
        group_id = group["group_id"] if group else None
        lim = db.execute(
            "SELECT per_device_per_day FROM group_resource_limits WHERE group_id=? AND resource_id=?",
            (group_id, resource_id)
        ).fetchone() if group_id else None
        base = lim["per_device_per_day"] if lim else None
        adj = (db.execute(
            "SELECT COALESCE(SUM(amount),0) as t FROM quota_adjustments "
            "WHERE date=? AND scope='device' AND ip=? AND resource_id=?",
            (date, ip, resource_id)
        ).fetchone() or {"t": 0})["t"]
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_counters WHERE date=? AND ip=? AND resource_id=?",
            (date, ip, resource_id)
        ).fetchone() or {"c": 0})["c"]
    else:
        group_id = qp.get("group_id")
        if not group_id:
            return jsonify({"error": "group_id required for scope=group"}), 400
        lim = db.execute(
            "SELECT group_per_day FROM group_resource_limits WHERE group_id=? AND resource_id=?",
            (group_id, resource_id)
        ).fetchone()
        base = lim["group_per_day"] if lim else None
        adj = (db.execute(
            "SELECT COALESCE(SUM(amount),0) as t FROM quota_adjustments "
            "WHERE date=? AND scope='group' AND group_id=? AND resource_id=?",
            (date, group_id, resource_id)
        ).fetchone() or {"t": 0})["t"]
        used = (db.execute(
            "SELECT COALESCE(count,0) as c FROM daily_group_counters WHERE date=? AND group_id=? AND resource_id=?",
            (date, group_id, resource_id)
        ).fetchone() or {"c": 0})["c"]
    adj = max(0, adj)
    effective = (base + adj) if base is not None else None
    return jsonify({
        "scope": scope, "resource_id": resource_id, "date": date,
        "base_limit": base, "adjustments": adj, "effective_limit": effective,
        "used": used, "remaining": (effective - used) if effective is not None else None,
    })


@app.route("/admin/quota/adjust", methods=["POST"])
@require_admin
def adjust_quota():
    db = get_db()
    data = request.get_json(silent=True) or {}
    scope = data.get("scope")
    resource_id = data.get("resource_id")
    amount = data.get("amount")
    date = data.get("date", _today())
    if scope not in ("device", "group") or not resource_id or amount is None:
        return jsonify({"error": "scope, resource_id, amount required"}), 400
    if not db.execute("SELECT 1 FROM resources WHERE id=?", (resource_id,)).fetchone():
        return jsonify({"error": "resource_not_found"}), 404
    aid = _uuid()
    db.execute(
        "INSERT INTO quota_adjustments(id,date,scope,ip,group_id,resource_id,amount,reason,created_by,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (aid, date, scope, data.get("ip"), data.get("group_id"),
         resource_id, amount, data.get("reason"), g.admin_token["id"], _now())
    )
    db.commit()
    _audit("POST", "/admin/quota/adjust", data, 201)
    return jsonify({"id": aid, "scope": scope, "resource_id": resource_id,
                    "date": date, "amount": amount}), 201


@app.route("/admin/quota/adjust/<aid>", methods=["DELETE"])
@require_admin
def delete_adjustment(aid):
    db = get_db()
    if not db.execute("SELECT 1 FROM quota_adjustments WHERE id=?", (aid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    db.execute("DELETE FROM quota_adjustments WHERE id=?", (aid,))
    db.commit()
    _audit("DELETE", f"/admin/quota/adjust/{aid}", None, 200)
    return jsonify({"deleted": True})


@app.route("/admin/quota/reset", methods=["POST"])
@require_admin
def reset_quota():
    db = get_db()
    data = request.get_json(silent=True) or {}
    scope = data.get("scope")
    date = data.get("date", _today())
    resource_id = data.get("resource_id")
    rows_cleared = 0
    if scope == "device":
        ip = data.get("ip")
        if not ip:
            return jsonify({"error": "ip required"}), 400
        where = "ip=? AND date=?" + (" AND resource_id=?" if resource_id else "")
        p = [ip, date] + ([resource_id] if resource_id else [])
        c = db.execute(f"DELETE FROM daily_counters WHERE {where}", p)
        rows_cleared = c.rowcount
    else:
        gid = data.get("group_id")
        if not gid:
            return jsonify({"error": "group_id required"}), 400
        where = "group_id=? AND date=?" + (" AND resource_id=?" if resource_id else "")
        p = [gid, date] + ([resource_id] if resource_id else [])
        c = db.execute(f"DELETE FROM daily_group_counters WHERE {where}", p)
        rows_cleared = c.rowcount
    db.commit()
    _audit("POST", "/admin/quota/reset", data, 200)
    return jsonify({"rows_cleared": rows_cleared})


# ── audit log ─────────────────────────────────────────────────────────────────

@app.route("/admin/audit")
@require_admin
def list_audit():
    db = get_db()
    qp = request.args
    where, params = ["1=1"], []
    if qp.get("admin_token_id"):
        where.append("al.admin_token_id=?"); params.append(qp["admin_token_id"])
    if qp.get("method"):
        where.append("al.method=?"); params.append(qp["method"].upper())
    if qp.get("path_prefix"):
        where.append("al.path LIKE ?"); params.append(qp["path_prefix"] + "%")
    if qp.get("from"):
        where.append("al.ts>=?"); params.append(int(qp["from"]))
    if qp.get("to"):
        where.append("al.ts<=?"); params.append(int(qp["to"]))
    limit = int(qp.get("limit", 100))
    offset = int(qp.get("offset", 0))
    base = (f"FROM audit_log al LEFT JOIN admin_tokens t ON t.id=al.admin_token_id "
            f"WHERE {' AND '.join(where)}")
    total = db.execute(f"SELECT COUNT(*) as c {base}", params).fetchone()["c"]
    rows = db.execute(
        f"SELECT al.id,al.ts,al.admin_token_id,t.name as admin_token_name,"
        f"al.method,al.path,al.response_status,al.ip {base} "
        f"ORDER BY al.ts DESC LIMIT ? OFFSET ?", params + [limit, offset]
    ).fetchall()
    return jsonify({"entries": [dict(r) for r in rows], "total": total})


@app.route("/admin/audit/<int:aid>")
@require_admin
def get_audit(aid):
    db = get_db()
    row = db.execute(
        "SELECT al.*,t.name as admin_token_name FROM audit_log al "
        "LEFT JOIN admin_tokens t ON t.id=al.admin_token_id WHERE al.id=?", (aid,)
    ).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify(dict(row))


# ── internal (localhost only) ─────────────────────────────────────────────────

@app.route("/internal/group-by-tier/<tier>")
@require_local
def internal_group_by_tier(tier):
    """Portal calls this to resolve tier name → group_id."""
    db = get_db()
    row = db.execute("SELECT id FROM groups WHERE network_tier=? LIMIT 1", (tier,)).fetchone()
    if not row:
        return jsonify({"error": "not_found"}), 404
    return jsonify({"group_id": row["id"]})


@app.route("/internal/session-created", methods=["POST"])
@require_local
def internal_session_created():
    data = request.get_json(silent=True) or {}
    db = get_db()
    # user_id may be a real user UUID or "portal-user" sentinel — coerce to sentinel UUID
    user_id = data.get("user_id", "")
    if not db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
        # Ensure sentinel portal user exists
        db.execute(
            "INSERT OR IGNORE INTO users(id,username,password_hash,default_group_id,created_at) "
            "VALUES('portal-anon','portal-anon','!',?,?)",
            (data["group_id"], int(time.time()))
        )
        user_id = "portal-anon"
    db.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,logged_in_at) VALUES(?,?,?,?,?,?)",
        (data["session_id"], user_id, data["group_id"],
         data["ip"], data["network_tier"], data["logged_in_at"])
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/internal/session-ended", methods=["POST"])
@require_local
def internal_session_ended():
    data = request.get_json(silent=True) or {}
    db = get_db()
    db.execute("UPDATE sessions SET logged_out_at=? WHERE id=? AND logged_out_at IS NULL",
               (data["logged_out_at"], data["session_id"]))
    db.commit()
    return jsonify({"ok": True})


@app.route("/internal/session/<ip>")
@require_local
def internal_get_session(ip):
    db = get_db()
    row = db.execute(
        "SELECT id FROM sessions WHERE ip=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (ip,)
    ).fetchone()
    return jsonify({"active": row is not None, "session_id": row["id"] if row else None})


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=8081, debug=False)
