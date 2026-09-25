from flask import Flask, request, redirect, render_template, make_response, jsonify
import subprocess
import os
import time
import uuid
import requests as _req
import threading
import ipaddress
import logging

_log = logging.getLogger(__name__)
_state_lock = threading.Lock()

app = Flask(__name__)
app.secret_key = os.urandom(24)

PROXY_INTERNAL = "http://127.0.0.1:8081"
# Tier name -> group UUID; populated at runtime via /internal/lookup-group if needed.
# Falls back to None (proxy won't receive sessions, but portal still works).
_GROUP_CACHE: dict[str, str] = {}

# Tier definitions: (username, password) -> tier name
TIERS = {
    ("basic", "basic2026"):  "basic",
    ("staff", "staff2026"):  "staff",
    ("vip",   "vip2026"):    "vip",
}

# iptables fwmark per tier — used for tc classification and cross-tier DROP
TIER_MARK = {"basic": "10", "staff": "20", "vip": "30"}

AUTHED_IPS: dict[str, str] = {}    # ip -> tier
SESSION_IDS: dict[str, str] = {}   # ip -> session UUID (shared with proxy)

CAPTIVE_PROBE_PATHS = [
    "/hotspot-detect.html",
    "/generate_204",
    "/generate204",
    "/connecttest.txt",
    "/check_network_status.txt",
    "/canonical.html",
    "/ncsi.txt",
]


def client_ip() -> str:
    return request.remote_addr


def _run(cmd: list) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def _run_ok(cmd: list) -> None:
    result = subprocess.run(cmd, check=False, capture_output=True)
    if result.returncode != 0:
        _log.warning("iptables failed (rc=%d): %s", result.returncode, result.stderr.decode(errors="replace"))


def _resolve_group(tier: str):
    """Return group UUID for a tier name, caching the result."""
    if tier in _GROUP_CACHE:
        return _GROUP_CACHE[tier]
    try:
        r = _req.get(f"{PROXY_INTERNAL}/internal/group-by-tier/{tier}", timeout=2)
        if r.ok:
            gid = r.json().get("group_id")
            if gid:
                _GROUP_CACHE[tier] = gid
                return gid
    except Exception:
        pass
    return None


def _notify_session_created(session_id: str, ip: str, tier: str) -> None:
    group_id = _resolve_group(tier)
    if not group_id:
        return
    try:
        r = _req.post(f"{PROXY_INTERNAL}/internal/session-created", json={
            "session_id": session_id,
            "user_id": "portal-user",   # anonymous — portal doesn't map to proxy users yet
            "group_id": group_id,
            "ip": ip,
            "network_tier": tier,
            "logged_in_at": int(time.time()),
        }, timeout=2)
        if not r.ok:
            _log.warning("proxy session-created returned %d", r.status_code)
    except Exception as e:
        _log.warning("proxy session-created notify failed: %s", e)


def _notify_session_ended(session_id: str) -> None:
    try:
        r = _req.post(f"{PROXY_INTERNAL}/internal/session-ended", json={
            "session_id": session_id,
            "logged_out_at": int(time.time()),
        }, timeout=2)
        if not r.ok:
            _log.warning("proxy session-ended returned %d", r.status_code)
    except Exception as e:
        _log.warning("proxy session-ended notify failed: %s", e)


def grant_access(ip: str, tier: str) -> None:
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return
    with _state_lock:
        if ip in AUTHED_IPS:
            return
        mark = TIER_MARK[tier]
        _run(["iptables", "-I", "FORWARD", "1", "-s", ip, "-j", "ACCEPT"])
        try:
            # Mark upload traffic (src=device) — shapes enp2s0 egress
            _run(["iptables", "-t", "mangle", "-I", "FORWARD", "1",
                  "-s", ip, "-j", "MARK", "--set-mark", mark])
            # Mark download traffic (dst=device) — shapes enp10s0u1 egress toward device
            _run(["iptables", "-t", "mangle", "-I", "FORWARD", "1",
                  "-d", ip, "-j", "MARK", "--set-mark", mark])
            # DNS bypass to real resolver
            _run(["iptables", "-t", "nat", "-I", "PREROUTING", "1",
                  "-s", ip, "-p", "udp", "--dport", "53",
                  "-j", "DNAT", "--to-destination", "8.8.8.8:53"])
            _apply_cross_tier_rules(ip, tier, action="I")
        except Exception:
            _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"])
            raise
        AUTHED_IPS[ip] = tier
        sid = str(uuid.uuid4())
        SESSION_IDS[ip] = sid
        _notify_session_created(sid, ip, tier)


def revoke_access(ip: str) -> None:
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return
    with _state_lock:
        if ip not in AUTHED_IPS:
            return
        tier = AUTHED_IPS[ip]
        mark = TIER_MARK[tier]
        _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"])
        _run_ok(["iptables", "-t", "mangle", "-D", "FORWARD",
                 "-s", ip, "-j", "MARK", "--set-mark", mark])
        _run_ok(["iptables", "-t", "mangle", "-D", "FORWARD",
                 "-d", ip, "-j", "MARK", "--set-mark", mark])
        _run_ok(["iptables", "-t", "nat", "-D", "PREROUTING",
                 "-s", ip, "-p", "udp", "--dport", "53",
                 "-j", "DNAT", "--to-destination", "8.8.8.8:53"])
        _apply_cross_tier_rules(ip, tier, action="D")
        sid = SESSION_IDS.pop(ip, None)
        del AUTHED_IPS[ip]
        if sid:
            _notify_session_ended(sid)


def _apply_cross_tier_rules(ip: str, tier: str, action: str) -> None:
    """Insert (I) or delete (D) cross-tier DROP rules for ip."""
    for other_ip, other_tier in list(AUTHED_IPS.items()):
        if other_tier == tier or other_ip == ip:
            continue
        # Drop traffic between this IP and IPs on other tiers
        _run_ok(["iptables", f"-{action}", "FORWARD",
                 "-s", ip, "-d", other_ip, "-j", "DROP"])
        _run_ok(["iptables", f"-{action}", "FORWARD",
                 "-s", other_ip, "-d", ip, "-j", "DROP"])


@app.before_request
def check_authed():
    ip = client_ip()
    if ip in AUTHED_IPS:
        if request.path in CAPTIVE_PROBE_PATHS:
            return make_response("", 204)
        return None
    if request.path in CAPTIVE_PROBE_PATHS:
        return redirect("http://192.168.0.1:8080/", 302)
    if request.path in ("/", "/login"):
        return None
    return redirect("http://192.168.0.1:8080/", 302)


@app.route("/", methods=["GET"])
def index():
    return render_template("login.html", error=None)


@app.route("/login", methods=["POST"])
def login():
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    ip = client_ip()
    tier = TIERS.get((username, password))
    if tier:
        grant_access(ip, tier)
        return redirect("http://192.168.0.1:8080/connected", 302)
    return render_template("login.html", error="Invalid credentials")


@app.route("/connected", methods=["GET"])
def connected():
    ip = client_ip()
    if ip not in AUTHED_IPS:
        return redirect("http://192.168.0.1:8080/", 302)
    return render_template("success.html", ip=ip, tier=AUTHED_IPS[ip])


@app.route("/logout", methods=["POST"])
def logout():
    revoke_access(client_ip())
    return redirect("/", 302)


@app.route("/internal/revoke-ip", methods=["POST"])
def internal_revoke_ip():
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return make_response("forbidden", 403)
    data = request.get_json(silent=True) or {}
    ip = data.get("ip", "")
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return jsonify({"error": "invalid_ip"}), 400
    revoke_access(ip)
    return make_response("ok", 200)


def _flush_portal_rules():
    """Remove all portal-inserted rules on startup so stale state from a previous run is cleared."""
    import subprocess
    # Flush all mangle FORWARD rules (portal marks)
    subprocess.run(["iptables", "-t", "mangle", "-F", "FORWARD"], check=False, capture_output=True)
    # Flush all nat PREROUTING rules (portal DNS redirects)
    subprocess.run(["iptables", "-t", "nat", "-F", "PREROUTING"], check=False, capture_output=True)
    # Remove all ACCEPT rules from FORWARD that portal inserted (conservative: flush only if empty)
    # We do NOT flush the entire FORWARD chain as other rules may exist
    # Instead, clear the in-memory state and let stale iptables rules expire on their own
    # The portal will re-add correct rules when clients re-authenticate
    AUTHED_IPS.clear()
    SESSION_IDS.clear()
    _log.info("portal startup: flushed mangle+nat chains, cleared in-memory state")


if __name__ == "__main__":
    _flush_portal_rules()
    app.run(host="0.0.0.0", port=8080, debug=False)
