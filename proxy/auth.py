import time
import bcrypt
from functools import wraps
from flask import request, jsonify, g
from db import get_db


def _hash_token(token: str) -> str:
    return bcrypt.hashpw(token.encode(), bcrypt.gensalt()).decode()


def _check_token(token: str, hashed: str) -> bool:
    return bcrypt.checkpw(token.encode(), hashed.encode())


def verify_admin_token(token: str):
    """Return admin_tokens row or None."""
    db = get_db()
    now = int(time.time())
    # NOTE: bcrypt per token — do not allow unbounded token accumulation.
    # Revoke old tokens regularly. A future version should use HMAC for API tokens.
    rows = db.execute(
        "SELECT * FROM admin_tokens WHERE revoked=0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 20",
        (int(time.time()),)
    ).fetchall()
    for row in rows:
        if _check_token(token, row["token_hash"]):
            db.execute(
                "UPDATE admin_tokens SET last_used_at=? WHERE id=?",
                (now, row["id"])
            )
            db.commit()
            return row
    return None


def get_active_session_for_ip(ip: str):
    """Return sessions row for active session on this IP, or None."""
    db = get_db()
    return db.execute(
        """SELECT s.*, u.username, g.name as group_name, g.network_tier
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           JOIN groups g ON g.id = s.group_id
           WHERE s.ip=? AND s.logged_out_at IS NULL AND s.revoked_at IS NULL
           -- Intentional: for NAT/shared IPs, most recent session wins.
           ORDER BY s.logged_in_at DESC LIMIT 1""",
        (ip,)
    ).fetchone()


def require_admin(f):
    """Decorator: require valid Bearer token. Sets g.admin_token."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return jsonify({"error": "missing_token"}), 401
        token = auth[7:]
        row = verify_admin_token(token)
        if not row:
            return jsonify({"error": "invalid_token"}), 401
        g.admin_token = row
        return f(*args, **kwargs)
    return decorated


def require_authed_ip(f):
    """Decorator: require active portal session for source IP. Sets g.session."""
    @wraps(f)
    def decorated(*args, **kwargs):
        ip = request.remote_addr
        session = get_active_session_for_ip(ip)
        if not session:
            return jsonify({"error": "not_authenticated", "ip": ip}), 403
        g.session = session
        return f(*args, **kwargs)
    return decorated


def require_local(f):
    """Decorator: only allow requests from 127.0.0.1."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.remote_addr not in ("127.0.0.1", "::1"):
            return jsonify({"error": "local_only"}), 403
        return f(*args, **kwargs)
    return decorated
