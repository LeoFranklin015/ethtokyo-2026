# Captive Portal (Basic Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a username/password captive portal on the Fedora VM that intercepts all HTTP traffic from AX80 WiFi clients and grants internet access on successful login.

**Architecture:** dnsmasq hijacks DNS for unauthenticated clients returning the VM's IP; iptables blocks forwarding for unauthenticated IPs and redirects port 80/443 to a Flask app; Flask serves the login page, verifies credentials, and adds the client IP to an iptables allow set on success. Session state is kept in memory; a systemd service keeps Flask running across reboots.

**Tech Stack:** Python 3.14, Flask, iptables, dnsmasq, systemd

**Spec:** docs/superpowers/specs/ (no separate spec file — design approved in chat on 2026-09-26)

## Global Constraints

- All files live on the Fedora VM at paths shown below
- Python 3.14 — no pip by default, install via `dnf install python3-pip` or use venv
- Interface: `enp10s0u1` — `192.168.0.1/24`
- dnsmasq already running, config at `/etc/dnsmasq.conf`
- iptables FORWARD chain already has masquerade rules — append, never flush
- Flask app listens on `0.0.0.0:8080` only
- Credentials: username `admin`, password `ensca2026` (hardcoded for now)
- Systemd service runs as root (needs iptables access)

## Review Focus

- Client IP behind AX80 double-NAT: all traffic may appear as `192.168.0.x` — verify `request.remote_addr` returns real device IP, not AX80 WAN IP
- DNS hijack only works for HTTP (port 80) — HTTPS sites will fail silently; portal must redirect HTTP first, not HTTPS
- iptables rule ordering: ACCEPT rules must come before the DROP/REDIRECT rule or authenticated clients stay blocked
- Session persistence: Flask restarts clear the in-memory allow set — re-auth required; iptables rules also lost on restart unless dispatcher script runs
- Captive portal OS probes (Apple, Android, Windows) must return 302 to trigger the native "Sign in to network" popup

---

## File Map

| Path (on Fedora VM) | Purpose |
|---|---|
| `/opt/ensca/portal/app.py` | Flask app — login page, auth, iptables grant |
| `/opt/ensca/portal/templates/login.html` | Login form HTML |
| `/opt/ensca/portal/templates/success.html` | Post-login confirmation page |
| `/etc/systemd/system/ensca-portal.service` | Systemd unit |
| `/etc/dnsmasq.conf` | Add DNS hijack line |
| `/etc/NetworkManager/dispatcher.d/99-ensca` | Add iptables redirect rules (already exists) |

---

## Task 1: Install Flask and scaffold app directory

**Files:**
- Create: `/opt/ensca/portal/app.py` (empty scaffold)
- Create: `/opt/ensca/portal/templates/login.html` (empty)
- Create: `/opt/ensca/portal/templates/success.html` (empty)

**Interfaces:**
- Produces: `/opt/ensca/portal/` directory with Flask importable

- [ ] **Step 1: Install pip and Flask on VM**

```bash
sudo dnf install -y python3-pip
sudo pip3 install flask
```

- [ ] **Step 2: Create app directory**

```bash
sudo mkdir -p /opt/ensca/portal/templates
```

- [ ] **Step 3: Verify Flask installed**

```bash
python3 -c "import flask; print(flask.__version__)"
```

Expected: prints a version string like `3.x.x`

---

## Task 2: Write Flask captive portal app

**Files:**
- Create: `/opt/ensca/portal/app.py`
- Create: `/opt/ensca/portal/templates/login.html`
- Create: `/opt/ensca/portal/templates/success.html`

**Interfaces:**
- Produces: `app.py` with `run_app()` entry point, `grant_access(ip)`, `revoke_access(ip)`

- [ ] **Step 1: Write `app.py`**

```python
from flask import Flask, request, redirect, render_template, session
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
        AUTHED_IPS.add(ip)


def revoke_access(ip: str) -> None:
    if ip in AUTHED_IPS:
        subprocess.run(
            ["iptables", "-D", "FORWARD", "-s", ip, "-j", "ACCEPT"],
            check=False,
        )
        AUTHED_IPS.discard(ip)


@app.before_request
def check_authed():
    ip = client_ip()
    if ip in AUTHED_IPS:
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
        return render_template("success.html", ip=ip)
    return render_template("login.html", error="Invalid credentials")


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
```

- [ ] **Step 2: Write `templates/login.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ENSCA — Sign In</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center;
           align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 320px; }
    h2 { margin: 0 0 1.5rem; font-size: 1.2rem; }
    input { width: 100%; padding: 0.5rem; margin-bottom: 1rem;
            border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { width: 100%; padding: 0.6rem; background: #0070f3;
             color: white; border: none; border-radius: 4px; cursor: pointer; }
    .error { color: red; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Sign in to access the network</h2>
    {% if error %}<p class="error">{{ error }}</p>{% endif %}
    <form method="POST" action="/login">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>
```

- [ ] **Step 3: Write `templates/success.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ENSCA — Connected</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center;
           align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 320px; text-align: center; }
    h2 { color: #0070f3; }
    p { color: #555; font-size: 0.9rem; }
    form { margin-top: 1.5rem; }
    button { padding: 0.5rem 1.5rem; background: #eee; border: none;
             border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="card">
    <h2>You're connected</h2>
    <p>Access granted for {{ ip }}</p>
    <form method="POST" action="/logout">
      <button type="submit">Disconnect</button>
    </form>
  </div>
</body>
</html>
```

- [ ] **Step 4: Test app starts**

```bash
sudo python3 /opt/ensca/portal/app.py &
sleep 2
curl -s http://192.168.0.1:8080/ | grep "Sign in"
sudo kill %1
```

Expected: HTML containing "Sign in to access the network"

---

## Task 3: iptables — block unauthenticated, redirect to portal

**Files:**
- Modify: `/etc/NetworkManager/dispatcher.d/99-ensca`

**Interfaces:**
- Consumes: `enp10s0u1` interface, `enp2s0` interface
- Produces: unauthenticated HTTP redirected to port 8080; all other traffic blocked until granted

- [ ] **Step 1: Add redirect and block rules to dispatcher script**

Open `/etc/NetworkManager/dispatcher.d/99-ensca` and replace contents with:

```bash
#!/bin/bash
# NAT masquerade
iptables -t nat -A POSTROUTING -o enp2s0 -j MASQUERADE

# Redirect unauthenticated HTTP to captive portal
iptables -t nat -A PREROUTING -i enp10s0u1 -p tcp --dport 80 -j REDIRECT --to-port 8080

# Allow established/related through
iptables -A FORWARD -i enp2s0 -o enp10s0u1 -m state --state RELATED,ESTABLISHED -j ACCEPT

# Allow portal traffic (port 8080) from clients
iptables -A INPUT -i enp10s0u1 -p tcp --dport 8080 -j ACCEPT

# Allow DNS from clients to Fedora
iptables -A INPUT -i enp10s0u1 -p udp --dport 53 -j ACCEPT

# Block all other forwarding from clients by default
# (Flask grants per-IP ACCEPT rules above this DROP)
iptables -A FORWARD -i enp10s0u1 -j DROP
```

- [ ] **Step 2: Flush existing duplicate rules and reload**

```bash
sudo iptables -F FORWARD
sudo iptables -t nat -F
sudo bash /etc/NetworkManager/dispatcher.d/99-ensca
```

- [ ] **Step 3: Verify rules loaded**

```bash
sudo iptables -L FORWARD -n --line-numbers
sudo iptables -t nat -L -n
```

Expected: FORWARD has DROP at end, nat PREROUTING has REDIRECT to 8080

---

## Task 4: DNS hijack via dnsmasq

**Files:**
- Modify: `/etc/dnsmasq.conf`

**Interfaces:**
- Produces: all DNS from unauthenticated clients returns `192.168.0.1`

- [ ] **Step 1: Enable DNS and add catch-all in dnsmasq.conf**

```bash
sudo sed -i 's/^port=0//' /etc/dnsmasq.conf
echo "address=/#/192.168.0.1" | sudo tee -a /etc/dnsmasq.conf
```

- [ ] **Step 2: Stop systemd-resolved to free port 53**

```bash
sudo systemctl disable --now systemd-resolved
sudo systemctl restart dnsmasq
```

- [ ] **Step 3: Verify dnsmasq answers DNS**

```bash
dig @192.168.0.1 google.com +short
```

Expected: `192.168.0.1`

- [ ] **Step 4: Allow authenticated clients real DNS**

After `grant_access(ip)` in `app.py`, also run:

```python
subprocess.run(
    ["iptables", "-t", "nat", "-I", "PREROUTING", "1",
     "-s", ip, "-p", "udp", "--dport", "53",
     "-j", "ACCEPT"],
    check=True,
)
```

And add a corresponding cleanup in `revoke_access`:

```python
subprocess.run(
    ["iptables", "-t", "nat", "-D", "PREROUTING",
     "-s", ip, "-p", "udp", "--dport", "53",
     "-j", "ACCEPT"],
    check=False,
)
```

This lets authenticated clients bypass the DNS hijack and reach real DNS (`8.8.8.8` as set in dnsmasq DHCP option).

---

## Task 5: systemd service

**Files:**
- Create: `/etc/systemd/system/ensca-portal.service`

**Interfaces:**
- Produces: portal starts on boot before network clients connect

- [ ] **Step 1: Write service file**

```ini
[Unit]
Description=ENSCA Captive Portal
After=network.target dnsmasq.service
Wants=dnsmasq.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/ensca/portal/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Write to `/etc/systemd/system/ensca-portal.service`

- [ ] **Step 2: Enable and start**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ensca-portal
sudo systemctl status ensca-portal | grep Active
```

Expected: `Active: active (running)`

---

## Task 6: End-to-end test

- [ ] **Step 1: Connect a device to AX80 WiFi**

- [ ] **Step 2: Open any HTTP URL in browser**

Expected: redirected to `http://192.168.0.1:8080/` showing login page

- [ ] **Step 3: Enter wrong credentials**

Expected: "Invalid credentials" error shown

- [ ] **Step 4: Enter correct credentials (`admin` / `ensca2026`)**

Expected: success page, internet works

- [ ] **Step 5: Verify device IP in iptables**

```bash
sudo iptables -L FORWARD -n | grep ACCEPT
```

Expected: client IP appears in an ACCEPT rule

- [ ] **Step 6: Test logout**

Click Disconnect → browser redirects to login page → internet stops working

- [ ] **Step 7: Reboot VM and retest**

```bash
sudo reboot
```

After reboot: connect device → should hit captive portal again (session cleared, iptables ACCEPT rules gone — expected behavior)
