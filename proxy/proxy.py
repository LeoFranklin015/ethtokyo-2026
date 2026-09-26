import csv
import io
import json
import time
import uuid
import os
import base64
import bcrypt
from datetime import datetime, timezone
from urllib.parse import urlencode
from flask import Flask, request, jsonify, g, Response, stream_with_context, send_from_directory, send_file, abort
import requests as req_lib

import wallet_allowlist
from db import get_db, init_db, close_db
from auth import require_admin, require_authed_ip, require_local, verify_admin_token
from rate_limit import check_and_increment, get_usage_for_ip
from upstream import forward, record_event, _build_url, _inject_auth, inject_provider

app = Flask(__name__)
PORTAL_INTERNAL = "http://127.0.0.1:8080"
WALLET_RPC_URL = os.environ.get("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
app.teardown_appcontext(close_db)


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


def _col(row, key, default=None):
    return row[key] if key in row.keys() else default


def _audit(method: str, path: str, status: int, body=None, db=None):
    """Write audit log row. Called after every control plane write."""
    if db is None:
        db = get_db()
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
    db.execute(
        "INSERT INTO audit_log(ts,admin_token_id,method,path,request_body,response_status,ip) "
        "VALUES(?,?,?,?,?,?,?)",
        (_now(), token_id, method, path, safe_body, status, request.remote_addr)
    )
    db.commit()


VALID_PLACEMENTS = ("url_path", "header", "bearer_token", "basic_auth", "query_param", "no_auth")

_SESSIONS_JOIN = ("FROM sessions s JOIN users u ON u.id=s.user_id "
                  "JOIN groups g ON g.id=s.group_id")


def _local_or_admin_ok() -> bool:
    """Return True if the request comes from localhost OR carries a valid admin Bearer token."""
    if request.remote_addr in ("127.0.0.1", "::1"):
        return True
    auth = request.headers.get("Authorization", "")
    return auth.startswith("Bearer ") and bool(verify_admin_token(auth[7:]))


def _resource_dict(r, include_key=False) -> dict:
    d = {
        "id": r["id"], "slug": r["slug"], "display_name": r["display_name"],
        "upstream_url": r["upstream_url"], "key_placement": r["key_placement"],
        "key_header_name": r["key_header_name"],
        "query_param_name": _col(r, "query_param_name"),
        "strip_path_prefix": bool(_col(r, "strip_path_prefix", False)),
        "enabled": bool(r["enabled"]),
        "has_pending_key": r["api_key_pending"] is not None,
        "created_at": r["created_at"], "notes": r["notes"],
    }
    if include_key:
        d["api_key_masked"] = _mask_key(r["api_key"] or "")
        b64_user = _col(r, "api_key_b64_user")
        if b64_user is not None:
            d["api_key_b64_user"] = b64_user
    return d


def _session_dict(s) -> dict:
    return {
        "id": s["id"], "user_id": s["user_id"],
        "username": _col(s, "username"),
        "group_id": s["group_id"],
        "group_name": _col(s, "group_name"),
        "ip": s["ip"], "network_tier": s["network_tier"],
        "ens_name": _col(s, "ens_name"),
        "wallet_address": _col(s, "wallet_address"),
        "logged_in_at": s["logged_in_at"],
        "logged_out_at": s["logged_out_at"],
        "revoked_at": s["revoked_at"],
        "bytes_in": _col(s, "bytes_in", 0),
        "bytes_out": _col(s, "bytes_out", 0),
    }


# ── health ────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "ts": _now()})


@app.route("/status")
def status():
    if not _local_or_admin_ok():
        return jsonify({"error": "unauthorized"}), 401
    db = get_db()
    try:
        db.execute("SELECT 1")
        db_ok = "ok"
        active = db.execute("SELECT COUNT(*) FROM sessions WHERE logged_out_at IS NULL AND revoked_at IS NULL").fetchone()[0]
        total_res = db.execute("SELECT COUNT(*) FROM resources").fetchone()[0]
        enabled_res = db.execute("SELECT COUNT(*) FROM resources WHERE enabled=1").fetchone()[0]
    except Exception as e:
        return jsonify({"db": str(e), "status": "degraded"}), 200
    return jsonify({
        "db": db_ok, "active_sessions": active,
        "resources_total": total_res, "resources_enabled": enabled_res,
    })


# ── admin tokens ──────────────────────────────────────────────────────────────

@app.route("/admin/tokens", methods=["POST"])
def create_token():
    # Allow from localhost without existing token (bootstrap)
    if not _local_or_admin_ok():
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
    _audit("POST", "/admin/tokens", 201, body=data, db=db)
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
    _audit("DELETE", f"/admin/tokens/{tid}", 200, db=db)
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
    _audit("POST", "/admin/groups", 201, body=data, db=db)
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
    _audit("PATCH", f"/admin/groups/{gid}", 200, body=data, db=db)
    return jsonify(_row(db.execute("SELECT * FROM groups WHERE id=?", (gid,)).fetchone()))


@app.route("/admin/groups/<gid>", methods=["DELETE"])
@require_admin
def delete_group(gid):
    db = get_db()
    if not db.execute("SELECT 1 FROM groups WHERE id=?", (gid,)).fetchone():
        return jsonify({"error": "not_found"}), 404
    if db.execute("SELECT 1 FROM users WHERE default_group_id=?", (gid,)).fetchone():
        return jsonify({"error": "group_has_members"}), 409
    if db.execute("SELECT 1 FROM sessions WHERE group_id = ? AND logged_out_at IS NULL AND revoked_at IS NULL LIMIT 1", (gid,)).fetchone():
        return jsonify({"error": "group_has_active_sessions"}), 409
    db.execute("DELETE FROM group_resource_limits WHERE group_id=?", (gid,))
    db.execute("DELETE FROM groups WHERE id=?", (gid,))
    db.commit()
    _audit("DELETE", f"/admin/groups/{gid}", 200, db=db)
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
    _audit("POST", f"/admin/groups/{gid}/members", 200, body=data, db=db)
    return jsonify({"user_id": uid, "group_id": gid})


@app.route("/admin/groups/<gid>/members/<uid>", methods=["DELETE"])
@require_admin
def remove_member(gid, uid):
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id=? AND default_group_id=?", (uid, gid)).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    db.execute("UPDATE users SET default_group_id = NULL WHERE id = ?", (uid,))
    db.commit()
    _audit("DELETE", f"/admin/groups/{gid}/members/{uid}", 200, db=db)
    return jsonify({"removed": True, "user_id": uid, "group_id": gid})


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
    per_ens = data.get("per_ens_per_day")
    db.execute(
        "INSERT INTO group_resource_limits(group_id,resource_id,per_device_per_day,group_per_day,per_ens_per_day) "
        "VALUES(?,?,?,?,?) ON CONFLICT(group_id,resource_id) DO UPDATE SET "
        "per_device_per_day=excluded.per_device_per_day, group_per_day=excluded.group_per_day, "
        "per_ens_per_day=excluded.per_ens_per_day",
        (gid, rid, per_dev, per_grp, per_ens)
    )
    db.commit()
    _audit("PUT", f"/admin/groups/{gid}/limits/{rid}", 200, body=data, db=db)
    return jsonify({"group_id": gid, "resource_id": rid,
                    "per_device_per_day": per_dev, "group_per_day": per_grp,
                    "per_ens_per_day": per_ens})


@app.route("/admin/groups/<gid>/limits/<rid>", methods=["DELETE"])
@require_admin
def delete_group_limit(gid, rid):
    db = get_db()
    if not db.execute("SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?",
                      (gid, rid)).fetchone():
        return jsonify({"error": "not_found"}), 404
    db.execute("DELETE FROM group_resource_limits WHERE group_id=? AND resource_id=?", (gid, rid))
    db.commit()
    _audit("DELETE", f"/admin/groups/{gid}/limits/{rid}", 200, db=db)
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
        "INSERT INTO users(id,username,password_hash,default_group_id,ens_name,wallet_address,created_at,notes) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (uid, username, pw_hash, group_id,
         data.get("ens_name"), data.get("wallet_address"), _now(), data.get("notes"))
    )
    db.commit()
    _audit("POST", "/admin/users", 201, body=data, db=db)
    return jsonify({"id": uid, "username": username, "group_id": group_id,
                    "ens_name": data.get("ens_name"), "wallet_address": data.get("wallet_address"),
                    "created_at": _now(), "disabled": False}), 201


@app.route("/admin/users", methods=["GET"])
@require_admin
def list_users():
    db = get_db()
    qp = request.args
    where, params = ["1=1"], []
    if qp.get("group_id"):
        where.append("default_group_id=?"); params.append(qp["group_id"])
    disabled_raw = qp.get("disabled")
    if disabled_raw is not None:
        if disabled_raw not in ("0", "1"):
            return jsonify({"error": "invalid_param"}), 400
        where.append("disabled=?"); params.append(int(disabled_raw))
    try:
        limit = int(qp.get("limit", 50))
        offset = int(qp.get("offset", 0))
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_param"}), 400
    total = db.execute(f"SELECT COUNT(*) as c FROM users WHERE {' AND '.join(where)}", params).fetchone()["c"]
    rows = db.execute(f"SELECT id,username,default_group_id,ens_name,wallet_address,created_at,disabled FROM users "
                      f"WHERE {' AND '.join(where)} LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
    return jsonify({"users": [dict(r) for r in rows], "total": total})


# ── ENS identity lookup ───────────────────────────────────────────────────────

@app.route("/admin/users/by-ens/<path:ens_name>")
@require_admin
def get_user_by_ens(ens_name):
    db = get_db()
    user = db.execute(
        "SELECT u.*, g.name as group_name, g.network_tier FROM users u "
        "LEFT JOIN groups g ON g.id=u.default_group_id WHERE u.ens_name=?", (ens_name,)
    ).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    keys = user.keys()
    return jsonify({
        "id": user["id"], "username": user["username"],
        "ens_name": user["ens_name"], "wallet_address": user["wallet_address"] if "wallet_address" in keys else None,
        "group": {"id": user["default_group_id"], "name": user["group_name"],
                  "network_tier": user["network_tier"]},
        "disabled": bool(user["disabled"]), "created_at": user["created_at"],
    })


@app.route("/admin/users/by-wallet/<wallet_address>")
@require_admin
def get_user_by_wallet(wallet_address):
    db = get_db()
    user = db.execute(
        "SELECT u.*, g.name as group_name, g.network_tier FROM users u "
        "LEFT JOIN groups g ON g.id=u.default_group_id WHERE u.wallet_address=?", (wallet_address,)
    ).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    keys = user.keys()
    return jsonify({
        "id": user["id"], "username": user["username"],
        "ens_name": user["ens_name"] if "ens_name" in keys else None,
        "wallet_address": user["wallet_address"],
        "group": {"id": user["default_group_id"], "name": user["group_name"],
                  "network_tier": user["network_tier"]},
        "disabled": bool(user["disabled"]), "created_at": user["created_at"],
    })


@app.route("/admin/users/<uid>", methods=["GET"])
@require_admin
def get_user(uid):
    db = get_db()
    user = db.execute(
        "SELECT u.*, g.name as group_name, g.network_tier FROM users u "
        "LEFT JOIN groups g ON g.id=u.default_group_id WHERE u.id=?", (uid,)
    ).fetchone()
    if not user:
        return jsonify({"error": "not_found"}), 404
    session = db.execute(
        "SELECT * FROM sessions WHERE user_id=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (uid,)
    ).fetchone()
    usage = get_usage_for_ip(
        session["ip"], session["group_id"],
        session["ens_name"] if session and "ens_name" in session.keys() else None,
    ) if session else {}
    keys = user.keys()
    return jsonify({
        "id": user["id"], "username": user["username"],
        "ens_name": user["ens_name"] if "ens_name" in keys else None,
        "wallet_address": user["wallet_address"] if "wallet_address" in keys else None,
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
    if "ens_name" in data:
        updates["ens_name"] = data["ens_name"]
    if "wallet_address" in data:
        updates["wallet_address"] = data["wallet_address"]
    if updates:
        sets = ", ".join(f"{k}=?" for k in updates)
        db.execute(f"UPDATE users SET {sets} WHERE id=?", (*updates.values(), uid))
        db.commit()
    _audit("PATCH", f"/admin/users/{uid}", 200, body=data, db=db)
    return jsonify(_row(db.execute(
        "SELECT id,username,default_group_id,ens_name,wallet_address,created_at,disabled,notes FROM users WHERE id=?",
        (uid,)
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
    _audit("DELETE", f"/admin/users/{uid}", 200, db=db)
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
    _audit("POST", f"/admin/users/{uid}/revoke", 200, db=db)
    return jsonify({"session_id": session["id"], "revoked": True, "ip": session["ip"]})


# ── resources ─────────────────────────────────────────────────────────────────

@app.route("/admin/resources", methods=["POST"])
@require_admin
def create_resource():
    data = request.get_json(silent=True) or {}
    slug = data.get("slug", "").strip()
    upstream = data.get("upstream_url", "").strip()
    placement = data.get("key_placement", "url_path")
    if not slug or not upstream or placement not in VALID_PLACEMENTS:
        return jsonify({"error": f"slug, upstream_url required; key_placement must be one of {VALID_PLACEMENTS}"}), 400
    if placement == "header" and not data.get("key_header_name"):
        return jsonify({"error": "key_header_name required when key_placement=header"}), 400
    if placement == "query_param" and not data.get("query_param_name"):
        return jsonify({"error": "query_param_name required when key_placement=query_param"}), 400
    if placement != "no_auth" and not data.get("api_key", "").strip():
        return jsonify({"error": "api_key required (omit only for no_auth)"}), 400
    db = get_db()
    if db.execute("SELECT 1 FROM resources WHERE slug=?", (slug,)).fetchone():
        return jsonify({"error": "slug_taken"}), 409
    rid = _uuid()
    db.execute(
        "INSERT INTO resources(id,slug,display_name,upstream_url,key_placement,"
        "key_header_name,query_param_name,api_key,api_key_b64_user,"
        "enabled,strip_path_prefix,created_at,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rid, slug, data.get("display_name", slug), upstream, placement,
         data.get("key_header_name"), data.get("query_param_name"),
         data.get("api_key", "").strip(), data.get("api_key_b64_user"),
         int(data.get("enabled", True)), int(data.get("strip_path_prefix", False)),
         _now(), data.get("notes"))
    )
    db.commit()
    _audit("POST", "/admin/resources", 201, body=data, db=db)
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
    if "key_placement" in data and data["key_placement"] not in VALID_PLACEMENTS:
        return jsonify({"error": f"key_placement must be one of {VALID_PLACEMENTS}"}), 400
    fields = {k: data[k] for k in
              ("display_name", "upstream_url", "key_placement", "key_header_name",
               "query_param_name", "api_key_b64_user", "notes") if k in data}
    if "enabled" in data:
        fields["enabled"] = int(bool(data["enabled"]))
    if "strip_path_prefix" in data:
        fields["strip_path_prefix"] = int(bool(data["strip_path_prefix"]))
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        db.execute(f"UPDATE resources SET {sets} WHERE id=?", (*fields.values(), rid))
        db.commit()
    _audit("PATCH", f"/admin/resources/{rid}", 200, body=data, db=db)
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
    _audit("DELETE", f"/admin/resources/{rid}", 200, db=db)
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
    _audit("PATCH", f"/admin/resources/{rid}/rotate-key", 200, body=data, db=db)
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
    _audit("POST", f"/admin/resources/{rid}/commit-key", 200, db=db)
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
    _audit("DELETE", f"/admin/resources/{rid}/pending-key", 200, db=db)
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
    try:
        limit = int(qp.get("limit", 50))
        offset = int(qp.get("offset", 0))
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_param"}), 400
    base = f"{_SESSIONS_JOIN} WHERE " + " AND ".join(where)
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
        f"SELECT s.*,u.username,g.name as group_name {_SESSIONS_JOIN} WHERE s.id=?", (sid,)
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
    _audit("DELETE", f"/admin/sessions/{sid}", 200, db=db)
    return jsonify({"revoked": True, "ip": s["ip"]})


# ── proxy ─────────────────────────────────────────────────────────────────────

def _handle_rpc_call(call):
    rpc_id = call.get("id") if isinstance(call, dict) else None
    method = call.get("method") if isinstance(call, dict) else None
    if not method or not wallet_allowlist.is_read(method):
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": {"code": -32601, "message": "method not permitted (read-only)"}}
    try:
        resp = req_lib.request("POST", WALLET_RPC_URL, json=call, timeout=30, verify=True)
        return resp.json()
    except Exception as e:
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": {"code": -32000, "message": f"upstream error: {str(e)[:120]}"}}


@app.route("/api/wallet/rpc", methods=["POST"])
def wallet_rpc():
    payload = request.get_json(silent=True)
    if isinstance(payload, list):
        return jsonify([_handle_rpc_call(c) for c in payload])
    if isinstance(payload, dict):
        return jsonify(_handle_rpc_call(payload))
    return jsonify({"jsonrpc": "2.0", "id": None,
                    "error": {"code": -32600, "message": "invalid request"}}), 400


@app.route("/api/wallet/account")
def wallet_account():
    ip = request.remote_addr  # the real VLAN source IP; never a forwarded header
    db = get_db()
    session = db.execute(
        "SELECT * FROM sessions WHERE ip=? AND logged_out_at IS NULL AND revoked_at IS NULL "
        "ORDER BY logged_in_at DESC LIMIT 1", (ip,)
    ).fetchone()
    if not session:
        return jsonify({"error": "no_account"}), 404

    wallet = _col(session, "wallet_address")
    if wallet:
        return jsonify({"address": wallet, "name": _col(session, "ens_name")})

    ens_name = _col(session, "ens_name")
    if not ens_name:
        return jsonify({"error": "no_account"}), 404

    resolved = _resolve_via_ens(ens_name)
    if resolved is None:
        # Could not ask — retryable, not a deny.
        return jsonify({"error": "resolve_unreachable"}), 503
    if resolved.get("denied"):
        return jsonify({"error": "no_account"}), 404
    owner = resolved.get("owner")
    if not owner:
        return jsonify({"error": "no_account"}), 404
    return jsonify({"address": owner, "name": ens_name})


_WALLET_ASSET_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "web", "public", "wallet")
)
_WALLET_ASSET_ALLOW = {"provider.js", "provider.l2.js", "read-methods.json"}


@app.route("/wallet/ca.crt")
def wallet_ca():
    path = os.path.expanduser(
        os.environ.get("WALLET_CA_PATH", "~/.mitmproxy/mitmproxy-ca-cert.pem")
    )
    if not os.path.isfile(path):
        abort(404)
    return send_file(path, mimetype="application/x-x509-ca-cert",
                     as_attachment=True, download_name="ca.crt")


@app.route("/wallet/<path:asset>")
def wallet_asset(asset):
    if asset not in _WALLET_ASSET_ALLOW:
        abort(404)
    return send_from_directory(_WALLET_ASSET_DIR, asset)


@app.route("/proxy/<slug>", defaults={"subpath": ""}, methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"], strict_slashes=False)
@app.route("/proxy/<slug>/<path:subpath>", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS","HEAD"], strict_slashes=False)
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
    resource = db.execute("SELECT * FROM resources WHERE slug=?", (slug,)).fetchone()
    if not resource:
        return jsonify({"error": "resource_not_found"}), 404
    if not resource["enabled"]:
        return jsonify({"error": "resource_disabled"}), 503

    # Access check: row in group_resource_limits must exist
    group_id = session["group_id"]
    access = db.execute(
        "SELECT 1 FROM group_resource_limits WHERE group_id=? AND resource_id=?",
        (group_id, resource["id"])
    ).fetchone()
    if not access:
        return jsonify({"error": "access_denied", "detail": "your group does not have access to this resource"}), 403

    # Rate limit check + increment
    limit_hit = check_and_increment(ip, group_id, resource["id"], session["ens_name"])
    if limit_hit:
        record_event(db, session["id"], ip, group_id, resource["id"],
                     request.method, subpath, 429, "rate_limit_exceeded", 0, 0, 0)
        return jsonify({"error": "rate_limit_exceeded", **limit_hit}), 429

    # Forward
    content, status, req_bytes, resp_bytes, duration_ms, upstream_error, content_type = forward(
        dict(resource), request.method, subpath, request
    )

    record_event(db, session["id"], ip, group_id, resource["id"],
                 request.method, subpath, status, upstream_error,
                 req_bytes, resp_bytes, duration_ms)

    if content is None:
        return jsonify({"error": "upstream_unreachable", "detail": upstream_error}), status

    resp_headers = {}
    if content_type:
        resp_headers["Content-Type"] = content_type
    if os.environ.get("WALLET_INJECT") == "1":
        content, resp_headers = inject_provider(content, content_type or "", resp_headers)

    return Response(content, status=status, headers=resp_headers)


# ── usage & analytics ─────────────────────────────────────────────────────────

@app.route("/usage/me")
@require_authed_ip
def usage_me():
    session = g.session
    usage = get_usage_for_ip(
        session["ip"], session["group_id"],
        session["ens_name"] if "ens_name" in session.keys() else None,
    )
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
    try:
        limit = int(qp.get("limit", 100))
        offset = int(qp.get("offset", 0))
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_param"}), 400
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
    try:
        limit = int(qp.get("limit", 10))
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_param"}), 400
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
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "ts", "ip", "username", "group", "resource", "method", "path",
                         "status", "req_bytes", "resp_bytes", "duration_ms", "upstream_error"])
        rows = db.execute(
            f"SELECT ue.*,r.slug as resource_slug,u.username,g.name as group_name "
            f"FROM usage_events ue JOIN resources r ON r.id=ue.resource_id "
            f"LEFT JOIN sessions s ON s.id=ue.session_id "
            f"LEFT JOIN users u ON u.id=s.user_id "
            f"LEFT JOIN groups g ON g.id=ue.group_id "
            f"WHERE {' AND '.join(where)} ORDER BY ue.ts ASC", params
        ).fetchall()
        for r in rows:
            writer.writerow([
                r["id"], r["ts"], r["ip"], r["username"], r["group_name"],
                r["resource_slug"], r["method"], r["path"], r["status"],
                r["req_bytes"], r["resp_bytes"], r["duration_ms"],
                r["upstream_error"] or ""
            ])
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)

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
    _audit("POST", "/admin/quota/adjust", 201, body=data, db=db)
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
    _audit("DELETE", f"/admin/quota/adjust/{aid}", 200, db=db)
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
    _audit("POST", "/admin/quota/reset", 200, body=data, db=db)
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
    try:
        limit = int(qp.get("limit", 100))
        offset = int(qp.get("offset", 0))
    except (ValueError, TypeError):
        return jsonify({"error": "invalid_param"}), 400
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


# Where the ENS resolution service lives. Set to the console's origin; leave unset to fall
# back to the local users table.
ENSCA_WEB_URL = os.environ.get("ENSCA_WEB_URL", "").rstrip("/")
ENS_RESOLVE_TIMEOUT = float(os.environ.get("ENS_RESOLVE_TIMEOUT", "4"))


def _resolve_via_ens(ens_name):
    """Ask the console what ENS publishes for this name.

    Returns the entitlement records, or None if the service is unreachable. A name that simply
    holds no membership resolves to a definite deny, which is different from "could not ask" --
    the caller must not treat the two the same.
    """
    if not ENSCA_WEB_URL:
        return None
    try:
        resp = req_lib.get(
            ENSCA_WEB_URL + "/api/ens/resolve",
            params={"name": ens_name},
            timeout=ENS_RESOLVE_TIMEOUT,
        )
    except Exception:
        return None
    if resp.status_code == 404:
        return {"denied": True}
    if resp.status_code != 200:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


@app.route("/internal/ens-lookup/<name>")
@require_local
def internal_ens_lookup(name):
    ens = (name or "").strip().lower()
    db = get_db()

    # ENS is the authority on which group a name belongs to. The enforcer stays the authority on
    # what that group means here -- its tier, its VLAN, its quota -- so the group name published
    # on-chain is mapped through the local groups table rather than trusted wholesale.
    resolved = _resolve_via_ens(ens)
    if resolved and resolved.get("denied"):
        return jsonify({"error": "not_found", "source": "ens"}), 404

    if resolved:
        group_name = (resolved.get("entitlements") or {}).get("wifi.group")
        if group_name:
            grp = db.execute(
                "SELECT id, network_tier FROM groups WHERE name = ?", (group_name,)
            ).fetchone()
            if grp:
                usr = db.execute(
                    "SELECT id FROM users WHERE username = ? AND disabled = 0", (ens,)
                ).fetchone()
                return jsonify({
                    "user_id": usr["id"] if usr else None,
                    "ens_name": ens,
                    "group_id": grp["id"],
                    "network_tier": grp["network_tier"],
                    "role": resolved.get("role"),
                    "branch": resolved.get("branch"),
                    "source": "ens",
                })
            # ENS named a group this enforcer does not run. Denying is safer than guessing.
            return jsonify({"error": "unknown_group", "group": group_name,
                            "source": "ens"}), 404

    # Unreachable resolution service: fall back to the local record so the network keeps working.
    row = db.execute(
        "SELECT u.id AS user_id, u.username AS ens_name, g.id AS group_id, g.network_tier "
        "FROM users u JOIN groups g ON g.id = u.default_group_id "
        "WHERE u.username = ? AND u.disabled = 0", (ens,)
    ).fetchone()
    if not row:
        return jsonify({"error": "not_found", "source": "local"}), 404
    return jsonify({"user_id": row["user_id"], "ens_name": row["ens_name"],
                    "group_id": row["group_id"], "network_tier": row["network_tier"],
                    "source": "local"})


@app.route("/internal/session-created", methods=["POST"])
@require_local
def internal_session_created():
    data = request.get_json(silent=True) or {}
    db = get_db()
    user_id = data.get("user_id", "")
    ens_name = data.get("ens_name")
    wallet_address = data.get("wallet_address")

    # Resolve user_id: prefer ENS lookup, then wallet lookup, then sentinel
    if ens_name and not db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
        row = db.execute("SELECT id FROM users WHERE ens_name=?", (ens_name,)).fetchone()
        if row:
            user_id = row["id"]

    if not db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
        # Upsert sentinel portal-anon user — update group if it changes
        db.execute(
            """INSERT INTO users(id, username, password_hash, default_group_id, created_at)
               VALUES('portal-anon', 'portal-anon', '!', ?, ?)
               ON CONFLICT(id) DO UPDATE SET default_group_id = excluded.default_group_id""",
            (data["group_id"], int(time.time()))
        )
        user_id = "portal-anon"

    # Backfill ENS identity: if the portal omitted ens_name but the resolved
    # user carries one, store it so the per-ENS shared-quota bucket keys on the
    # user's real identity across all their devices (I3 — a NULL ens_name would
    # otherwise leave the per-ENS cap unenforced).
    if not ens_name:
        urow = db.execute("SELECT ens_name FROM users WHERE id=?", (user_id,)).fetchone()
        if urow and urow["ens_name"]:
            ens_name = urow["ens_name"]

    db.execute(
        "INSERT INTO sessions(id,user_id,group_id,ip,network_tier,ens_name,wallet_address,logged_in_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (data["session_id"], user_id, data["group_id"],
         data["ip"], data["network_tier"], ens_name, wallet_address, data["logged_in_at"])
    )
    db.commit()
    return jsonify({"ok": True, "user_id": user_id})


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


# ── bandwidth & resource allocation ──────────────────────────────────────────

@app.route("/admin/bandwidth/sessions")
@require_admin
def bandwidth_sessions():
    """Per-session bandwidth totals, optionally filtered to active sessions."""
    db = get_db()
    qp = request.args
    active_only = qp.get("active", "true").lower() == "true"
    where = ["1=1"]
    params = []
    if active_only:
        where.append("s.logged_out_at IS NULL AND s.revoked_at IS NULL")
    if qp.get("group_id"):
        where.append("s.group_id=?"); params.append(qp["group_id"])
    if qp.get("network_tier"):
        where.append("g.network_tier=?"); params.append(qp["network_tier"])
    rows = db.execute(
        f"SELECT s.id, s.ip, s.network_tier, s.ens_name, s.wallet_address, "
        f"u.username, g.name as group_name, g.network_tier as tier, "
        f"s.bytes_in, s.bytes_out, (s.bytes_in + s.bytes_out) as bytes_total, "
        f"s.logged_in_at, s.logged_out_at "
        f"FROM sessions s JOIN users u ON u.id=s.user_id JOIN groups g ON g.id=s.group_id "
        f"WHERE {' AND '.join(where)} ORDER BY bytes_total DESC",
        params
    ).fetchall()
    tier_totals = {}
    for r in rows:
        tier = r["tier"]
        if tier not in tier_totals:
            tier_totals[tier] = {"sessions": 0, "bytes_in": 0, "bytes_out": 0}
        tier_totals[tier]["sessions"] += 1
        tier_totals[tier]["bytes_in"] += r["bytes_in"] or 0
        tier_totals[tier]["bytes_out"] += r["bytes_out"] or 0
    return jsonify({
        "sessions": [dict(r) for r in rows],
        "tier_totals": tier_totals,
        "total_sessions": len(rows),
    })


@app.route("/admin/bandwidth/timeseries", methods=["GET"])
@require_admin
def bandwidth_timeseries():
    db = get_db()
    # 10-minute buckets over the last 6 hours, ordered by bucket
    rows = db.execute("""
        SELECT
            strftime('%H:%M', datetime(ts, 'unixepoch', 'localtime')) AS t,
            CAST(SUM(resp_bytes) * 8.0 / (10.0 * 60.0 * 1000000.0) AS REAL) AS mbps,
            COUNT(DISTINCT ip) AS admitted
        FROM usage_events
        WHERE ts >= strftime('%s', 'now', '-6 hours')
        GROUP BY (ts / 600)
        ORDER BY (ts / 600)
    """).fetchall()
    return jsonify({"samples": [dict(r) for r in rows]})


@app.route("/admin/bandwidth/test", methods=["POST"])
@require_admin
def bandwidth_test():
    """
    Measure effective upstream throughput for a resource by downloading a test payload.
    Body: {"resource_id": "<rid>", "payload_bytes": 65536, "subpath": ""}
    Returns measured throughput (bytes/sec) and latency.
    """
    data = request.get_json(silent=True) or {}
    resource_id = data.get("resource_id")
    payload_bytes = int(data.get("payload_bytes", 65536))
    subpath = data.get("subpath", "")
    if not resource_id:
        return jsonify({"error": "resource_id required"}), 400
    payload_bytes = max(1024, min(payload_bytes, 10 * 1024 * 1024))  # 1KB–10MB

    db = get_db()
    resource = db.execute("SELECT * FROM resources WHERE id=?", (resource_id,)).fetchone()
    if not resource:
        return jsonify({"error": "resource_not_found"}), 404
    if not resource["enabled"]:
        return jsonify({"error": "resource_disabled"}), 503

    r_dict = dict(resource)
    url = _build_url(r_dict, subpath)
    headers = {}
    params = {}
    _inject_auth(r_dict, headers, params)
    if params:
        url = f"{url}?{urlencode(params)}"

    t0 = time.monotonic()
    try:
        resp = req_lib.get(url, headers=headers, timeout=30, stream=True)
        first_byte_ms = int((time.monotonic() - t0) * 1000)
        content = resp.content
        elapsed = time.monotonic() - t0
        resp_bytes = len(content)
        throughput_bps = int(resp_bytes / elapsed) if elapsed > 0 else 0
        return jsonify({
            "resource_id": resource_id,
            "resource_slug": resource["slug"],
            "upstream_url": url.split("?")[0],
            "http_status": resp.status_code,
            "resp_bytes": resp_bytes,
            "elapsed_ms": int(elapsed * 1000),
            "first_byte_ms": first_byte_ms,
            "throughput_bps": throughput_bps,
            "throughput_mbps": round(throughput_bps / 1_000_000, 3),
        })
    except req_lib.exceptions.ConnectionError as e:
        return jsonify({"error": "connection_error", "detail": str(e)[:120]}), 502
    except req_lib.exceptions.Timeout:
        return jsonify({"error": "timeout"}), 504
    except Exception as e:
        return jsonify({"error": "unexpected", "detail": str(e)[:120]}), 500


# ── entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=8081, debug=False)
