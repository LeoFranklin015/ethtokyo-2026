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

# Gateway IP — used in redirects and iptables rules.
# Override with ENSCA_GATEWAY_IP env var (default: 192.168.0.1 per dnsmasq.conf).
GATEWAY_IP = os.environ.get("ENSCA_GATEWAY_IP", "192.168.0.1")
PORTAL_URL = f"http://{GATEWAY_IP}:8080"
# DNS server used for per-IP bypass rules.
# Override with ENSCA_DNS_SERVER env var (default: 8.8.8.8).
DNS_SERVER = os.environ.get("ENSCA_DNS_SERVER", "8.8.8.8")
# AP-facing interface (client side) — used by the reaper's neighbor scan.
# Override with ENSCA_AP_IFACE env var (default: enp10s0u1 per VM).
AP_IFACE = os.environ.get("ENSCA_AP_IFACE", "enp10s0u1")

# iptables fwmark per tier — used for tc classification and cross-tier DROP
TIER_MARK = {"basic": "10", "staff": "20", "vip": "30", "partner": "10", "hacker": "30"}

AUTHED_IPS: dict[str, str] = {}    # ip -> tier
SESSION_IDS: dict[str, str] = {}   # ip -> session UUID (shared with proxy)
ENS_NAMES: dict[str, str] = {}     # ip -> ENS name entered at portal login

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


def _notify_session_created(session_id: str, ip: str, tier: str, ens_name=None, user_id=None) -> None:
    group_id = _resolve_group(tier)
    if not group_id:
        return
    try:
        r = _req.post(f"{PROXY_INTERNAL}/internal/session-created", json={
            "session_id": session_id,
            "user_id": user_id or "portal-anon",   # proxy resolves to real user via ENS/wallet; falls back to portal-anon sentinel
            "group_id": group_id,
            "ip": ip,
            "network_tier": tier,
            "ens_name": ens_name,
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


def grant_access(ip: str, tier: str, ens_name=None, user_id=None) -> None:
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
                  "-j", "DNAT", "--to-destination", f"{DNS_SERVER}:53"])
            # HTTP :80 bypass — authed clients forward to the real internet.
            # Sits ABOVE the baseline captive REDIRECT so their probes/browsing
            # are not bounced back to the portal.
            _run(["iptables", "-t", "nat", "-I", "PREROUTING", "1",
                  "-s", ip, "-p", "tcp", "--dport", "80", "-j", "RETURN"])
            _apply_ens_isolation(ip, action="I")
        except Exception:
            _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"])
            raise
        AUTHED_IPS[ip] = tier
        sid = str(uuid.uuid4())
        SESSION_IDS[ip] = sid
        _notify_session_created(sid, ip, tier, ens_name, user_id)


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
                 "-j", "DNAT", "--to-destination", f"{DNS_SERVER}:53"])
        _run_ok(["iptables", "-t", "nat", "-D", "PREROUTING",
                 "-s", ip, "-p", "tcp", "--dport", "80", "-j", "RETURN"])
        _apply_ens_isolation(ip, action="D")
        sid = SESSION_IDS.pop(ip, None)
        ENS_NAMES.pop(ip, None)
        del AUTHED_IPS[ip]
        if sid:
            _notify_session_ended(sid)


def _apply_ens_isolation(ip: str, action: str) -> None:
    """Insert (I) or delete (D) DROP rules between ip and every authed IP on a DIFFERENT ENS name.

    On insert, DROP rules are prepended (-I FORWARD 1) so they sit ABOVE the
    per-IP `-s ip -j ACCEPT` rule; iptables is first-match, so an appended DROP
    below the ACCEPT would never fire and isolation would silently fail.
    """
    my_name = ENS_NAMES.get(ip)
    for other_ip in list(AUTHED_IPS.keys()):
        if other_ip == ip:
            continue
        if ENS_NAMES.get(other_ip) == my_name and my_name is not None:
            continue  # same ENS user — allowed to talk
        if action == "I":
            _run_ok(["iptables", "-I", "FORWARD", "1", "-s", ip, "-d", other_ip, "-j", "DROP"])
            _run_ok(["iptables", "-I", "FORWARD", "1", "-s", other_ip, "-d", ip, "-j", "DROP"])
        else:
            _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-d", other_ip, "-j", "DROP"])
            _run_ok(["iptables", "-D", "FORWARD", "-s", other_ip, "-d", ip, "-j", "DROP"])


@app.before_request
def check_authed():
    ip = client_ip()
    # Internal endpoints self-gate on localhost; the captive redirect must not
    # intercept them, or the dhcp-hook's revoke POST never reaches its handler.
    # Enforce the loopback gate centrally so a future /internal/* route that
    # forgets its own remote_addr check is not exposed to LAN clients.
    if request.path.startswith("/internal/"):
        if request.remote_addr in ("127.0.0.1", "::1"):
            return None
        return make_response("forbidden", 403)
    if ip in AUTHED_IPS:
        if request.path in CAPTIVE_PROBE_PATHS:
            return make_response("", 204)
        return None
    if request.path in CAPTIVE_PROBE_PATHS:
        return redirect(f"{PORTAL_URL}/", 302)
    if request.path in ("/", "/login"):
        return None
    return redirect("http://192.168.0.1:8080/", 302)


@app.route("/", methods=["GET"])
def index():
    return render_template("login.html", error=None)


@app.route("/login", methods=["POST"])
def login():
    ens_name = request.form.get("ens_name", "").strip().lower()
    ip = client_ip()
    ident = _lookup_ens(ens_name)
    if not ident:
        return render_template("login.html", error="ENS name not recognized")
    # Re-login from the same device under a DIFFERENT ENS: grant_access
    # early-returns for an already-authed IP, so revoke first to tear down the
    # old identity's cross-user isolation and let grant rebuild it cleanly.
    if ip in AUTHED_IPS and ENS_NAMES.get(ip) != ident["ens_name"]:
        revoke_access(ip)
    ENS_NAMES[ip] = ident["ens_name"]
    grant_access(ip, ident["network_tier"], ens_name=ident["ens_name"], user_id=ident["user_id"])
    return redirect(f"{PORTAL_URL}/connected", 302)


@app.route("/connected", methods=["GET"])
def connected():
    ip = client_ip()
    if ip not in AUTHED_IPS:
        return redirect(f"{PORTAL_URL}/", 302)
    return render_template("success.html", ip=ip, tier=AUTHED_IPS[ip], ens_name=ENS_NAMES.get(ip, ""))


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


def _stale_ips(last_seen, authed, now, ttl=20):
    stale = set()
    for ip in list(authed):
        seen = last_seen.get(ip)
        if seen is None:
            continue  # grace: recorded on first sighting, not revoked before first miss
        if now - seen > ttl:
            stale.add(ip)
    return stale


def _neigh_ips(dev=None):
    dev = dev or AP_IFACE
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


def _bootstrap_captive_redirect() -> None:
    """Install the baseline captive-portal HTTP trap: any AP-side client HTTP
    (:80) is REDIRECTed to the portal on :8080. Combined with the dnsmasq
    wildcard DNS hijack, this makes OS captive-portal probes reach the portal
    and get a 302, which triggers the connect popup. Authed clients get a
    per-IP :80 RETURN inserted above this by grant_access, so they browse the
    real internet normally."""
    _run_ok(["iptables", "-t", "nat", "-A", "PREROUTING",
             "-i", AP_IFACE, "-p", "tcp", "--dport", "80",
             "-j", "REDIRECT", "--to-ports", "8080"])


def _flush_portal_rules():
    """Remove all portal-inserted rules on startup so stale state from a previous run is cleared."""
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
    ENS_NAMES.clear()
    _log.info("portal startup: flushed mangle+nat chains, cleared in-memory state")


if __name__ == "__main__":
    _flush_portal_rules()
    _bootstrap_captive_redirect()
    threading.Thread(target=_reaper_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=8080, debug=False)
