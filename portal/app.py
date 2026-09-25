from flask import Flask, request, redirect, render_template, make_response
import subprocess
import os

app = Flask(__name__)
app.secret_key = os.urandom(24)

USERNAME = "admin"
PASSWORD = "ensca2026"

AUTHED_IPS: set[str] = set()

CAPTIVE_PROBE_PATHS = [
    "/hotspot-detect.html",
    "/generate_204",
    "/connecttest.txt",
    "/check_network_status.txt",
    "/canonical.html",
    "/ncsi.txt",
]


def client_ip() -> str:
    return request.remote_addr


def grant_access(ip: str) -> None:
    if ip not in AUTHED_IPS:
        subprocess.run(
            ["iptables", "-I", "FORWARD", "1", "-s", ip, "-j", "ACCEPT"],
            check=True,
        )
        try:
            subprocess.run(
                ["iptables", "-t", "nat", "-I", "PREROUTING", "1",
                 "-s", ip, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
                check=True,
            )
        except Exception:
            subprocess.run(
                ["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"],
                check=False,
            )
            raise
        AUTHED_IPS.add(ip)


def revoke_access(ip: str) -> None:
    if ip in AUTHED_IPS:
        subprocess.run(
            ["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"],
            check=False,
        )
        subprocess.run(
            ["iptables", "-t", "nat", "-D", "PREROUTING",
             "-s", ip, "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
            check=False,
        )
        AUTHED_IPS.discard(ip)


@app.before_request
def check_authed():
    ip = client_ip()
    if ip in AUTHED_IPS:
        # Authed: let probe paths return 204 so OS dismisses captive sheet
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
    if username == USERNAME and password == PASSWORD:
        grant_access(ip)
        # 302 to /connected triggers OS re-probe; authed probe paths now return 204
        return redirect("http://192.168.0.1:8080/connected", 302)
    return render_template("login.html", error="Invalid credentials")


@app.route("/connected", methods=["GET"])
def connected():
    ip = client_ip()
    if ip not in AUTHED_IPS:
        return redirect("http://192.168.0.1:8080/", 302)
    return render_template("success.html", ip=ip)


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


def run_app() -> None:
    """Entry point used by the systemd service (Task 3)."""
    app.run(host="0.0.0.0", port=8080, debug=False)


if __name__ == "__main__":
    run_app()
