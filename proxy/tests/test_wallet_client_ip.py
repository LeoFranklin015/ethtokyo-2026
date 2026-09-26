# proxy/tests/test_wallet_client_ip.py
"""The Layer-2 wallet backend reaches /api/wallet/account over loopback and
forwards the device IP as X-VLAN-Client-IP. Trust that header ONLY on the
loopback hop; a VLAN client must never spoof its identity with it.
"""
import os
import sys
import importlib.util

HERE = os.path.dirname(__file__)
PROXY = os.path.dirname(HERE)
sys.path.insert(0, PROXY)

spec = importlib.util.spec_from_file_location("proxy_mod", os.path.join(PROXY, "proxy.py"))
proxy_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy_mod)

app = proxy_mod.app


def _ip_for(remote, header=None):
    """Drive _wallet_client_ip() inside a request context with a chosen peer."""
    environ = {"REMOTE_ADDR": remote}
    headers = {}
    if header is not None:
        headers["X-VLAN-Client-IP"] = header
    with app.test_request_context("/api/wallet/account",
                                  environ_base=environ, headers=headers):
        return proxy_mod._wallet_client_ip()


def test_loopback_peer_trusts_forwarded_header():
    # mitm -> proxy over loopback: the forwarded device IP is used.
    assert _ip_for("127.0.0.1", "192.168.0.17") == "192.168.0.17"
    assert _ip_for("::1", "192.168.0.17") == "192.168.0.17"


def test_loopback_peer_without_header_falls_back_to_peer():
    assert _ip_for("127.0.0.1", None) == "127.0.0.1"


def test_vlan_client_cannot_spoof_header():
    # A real device (non-loopback peer) sending the header is ignored — its
    # packet source IP is the only identity that counts.
    assert _ip_for("192.168.0.99", "192.168.0.17") == "192.168.0.99"


def test_vlan_client_without_header_uses_peer():
    assert _ip_for("192.168.0.17", None) == "192.168.0.17"
