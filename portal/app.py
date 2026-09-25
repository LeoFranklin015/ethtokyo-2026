from flask import Flask, request, redirect, render_template, make_response
import subprocess
import os

app = Flask(__name__)
app.secret_key = os.urandom(24)

# Tier definitions: (username, password) -> tier name
TIERS = {
    ("basic", "basic2026"):  "basic",
    ("staff", "staff2026"):  "staff",
    ("vip",   "vip2026"):    "vip",
}

# iptables fwmark per tier — used for tc classification and cross-tier DROP
TIER_MARK = {"basic": "10", "staff": "20", "vip": "30"}

AUTHED_IPS: dict[str, str] = {}  # ip -> tier

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
    subprocess.run(cmd, check=True)


def _run_ok(cmd: list) -> None:
    subprocess.run(cmd, check=False)


def grant_access(ip: str, tier: str) -> None:
    if ip in AUTHED_IPS:
        return
    mark = TIER_MARK[tier]
    # FORWARD ACCEPT for this IP
    _run(["iptables", "-I", "FORWARD", "1", "-s", ip, "-j", "ACCEPT"])
    try:
        # Mark outbound traffic for tc shaping
        _run(["iptables", "-t", "mangle", "-I", "FORWARD", "1",
              "-s", ip, "-j", "MARK", "--set-mark", mark])
        # DNS bypass to real resolver
        _run(["iptables", "-t", "nat", "-I", "PREROUTING", "1",
              "-s", ip, "-p", "udp", "--dport", "53",
              "-j", "DNAT", "--to-destination", "8.8.8.8:53"])
        # Block cross-tier traffic: drop packets FROM this IP TO other-tier authed IPs
        _apply_cross_tier_rules(ip, tier, action="I")
    except Exception:
        _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"])
        raise
    AUTHED_IPS[ip] = tier


def revoke_access(ip: str) -> None:
    if ip not in AUTHED_IPS:
        return
    tier = AUTHED_IPS[ip]
    mark = TIER_MARK[tier]
    _run_ok(["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"])
    _run_ok(["iptables", "-t", "mangle", "-D", "FORWARD",
             "-s", ip, "-j", "MARK", "--set-mark", mark])
    _run_ok(["iptables", "-t", "nat", "-D", "PREROUTING",
             "-s", ip, "-p", "udp", "--dport", "53",
             "-j", "DNAT", "--to-destination", "8.8.8.8:53"])
    _apply_cross_tier_rules(ip, tier, action="D")
    del AUTHED_IPS[ip]


def _apply_cross_tier_rules(ip: str, tier: str, action: str) -> None:
    """Insert (I) or delete (D) cross-tier DROP rules for ip."""
    for other_ip, other_tier in AUTHED_IPS.items():
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


for path in CAPTIVE_PROBE_PATHS:
    app.add_url_rule(
        path,
        endpoint=f"probe_{path.replace('/', '_')}",
        view_func=lambda: redirect("http://192.168.0.1:8080/", 302),
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
