# mitm/tests/test_gen_provider.py
import os
import re
import importlib.util

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
SRC = os.path.join(REPO, "web", "public", "wallet", "provider.js")

spec = importlib.util.spec_from_file_location("gen_provider", os.path.join(ROOT, "gen_provider.py"))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

BASE = "http://192.168.0.1:8081"


def _out():
    return gen.generate_l2(open(SRC).read(), BASE)


def test_all_three_fetches_absolute():
    out = _out()
    assert f'fetch("{BASE}/wallet/read-methods.json")' in out
    assert f'fetch("{BASE}/api/wallet/account")' in out
    assert f'fetch("{BASE}/api/wallet/rpc"' in out


def test_no_relative_wallet_or_api_fetch_remains():
    out = _out()
    # No fetch of a /wallet/ or /api/wallet path may remain host-relative.
    assert not re.search(r'fetch\(\s*"/wallet/', out), "relative /wallet/ fetch leaked"
    assert not re.search(r'fetch\(\s*"/api/wallet/', out), "relative /api/wallet/ fetch leaked"


def test_identity_preserved():
    out = _out()
    # uuid + rdns copied byte-for-byte from the Layer-1 provider.
    assert "8f3d1c60-2a4e-4b7a-9e11-6c0f2d5a7b31" in out
    assert "eth.ethglobal2.readonly" in out


def test_base_url_is_parametrized():
    other = gen.generate_l2(open(SRC).read(), "http://10.0.0.5:9999")
    assert 'fetch("http://10.0.0.5:9999/api/wallet/account")' in other
    assert BASE not in other  # default base must not be hardcoded into output
