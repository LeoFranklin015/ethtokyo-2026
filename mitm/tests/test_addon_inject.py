# mitm/tests/test_addon_inject.py
import os, sys, importlib.util

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(ROOT)
sys.path.insert(0, os.path.join(REPO, "proxy"))  # so the addon can import upstream

spec = importlib.util.spec_from_file_location("wallet_mitm", os.path.join(ROOT, "wallet_mitm.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

inj = mod.WalletInjector()


def test_html_gets_script_before_head_close():
    body = b"<html><head><title>x</title></head><body>hi</body></html>"
    out = inj.inject_html(body, "text/html; charset=utf-8")
    assert b"provider.l2.js" in out
    assert out.index(b"provider.l2.js") < out.index(b"</head>")


def test_non_html_untouched():
    js = b'{"a":1}'
    assert inj.inject_html(js, "application/json") == js
    img = b"\x89PNG\r\n"
    assert inj.inject_html(img, "image/png") == img


def test_csp_meta_stripped():
    body = (b'<html><head>'
            b'<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">'
            b'</head><body></body></html>')
    out = inj.inject_html(body, "text/html")
    assert b"Content-Security-Policy" not in out
    assert b"provider.l2.js" in out


def test_addons_list_present():
    assert hasattr(mod, "addons") and isinstance(mod.addons, list) and mod.addons


def test_injected_url_is_absolute_l2():
    body = b"<html><head></head></html>"
    out = inj.inject_html(body, "text/html").decode()
    assert 'src="http' in out and "provider.l2.js" in out  # absolute, not relative
