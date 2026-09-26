# portal/tests/test_https_redirect.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["ENSCA_FIREWALL"] = "0"   # no real iptables
import importlib
import app as portal
importlib.reload(portal)

CALLS = []

def _fake_run(cmd):
    CALLS.append(cmd)

def test_grant_adds_443_redirect(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(portal, "_run", _fake_run)
    monkeypatch.setattr(portal, "_run_ok", _fake_run)
    monkeypatch.setattr(portal, "FIREWALL_ENABLED", True)
    monkeypatch.setattr(portal, "_notify_session_created", lambda *a, **k: None)
    portal.AUTHED_IPS.clear(); portal.SESSION_IDS.clear(); portal.ENS_NAMES.clear()
    portal.grant_access("10.9.9.9", "staff", ens_name="marco.tokyo.ethglobal2.eth", user_id="u")
    flat = [" ".join(c) for c in CALLS]
    assert any("--dport 443" in f and "REDIRECT" in f and "8443" in f and "10.9.9.9" in f for f in flat), \
        "grant_access must add a :443->:8443 REDIRECT for the authed IP"

def test_revoke_removes_443_redirect(monkeypatch):
    CALLS.clear()
    monkeypatch.setattr(portal, "_run", _fake_run)
    monkeypatch.setattr(portal, "_run_ok", _fake_run)
    monkeypatch.setattr(portal, "FIREWALL_ENABLED", True)
    monkeypatch.setattr(portal, "_notify_session_created", lambda *a, **k: None)
    monkeypatch.setattr(portal, "_notify_session_ended", lambda *a, **k: None)
    portal.AUTHED_IPS.clear(); portal.SESSION_IDS.clear(); portal.ENS_NAMES.clear()
    portal.grant_access("10.9.9.9", "staff", ens_name="x", user_id="u")
    CALLS.clear()
    portal.revoke_access("10.9.9.9")
    flat = [" ".join(c) for c in CALLS]
    assert any("-D" in c and "--dport 443" in " ".join(c) and "REDIRECT" in " ".join(c) for c in CALLS), \
        "revoke_access must delete the :443 REDIRECT"
