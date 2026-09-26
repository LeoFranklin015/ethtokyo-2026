# mitm/tests/test_scaffold.py
import os
import re

HERE = os.path.dirname(__file__)
ROOT = os.path.dirname(HERE)


def test_requirements_pins_mitmproxy():
    req = open(os.path.join(ROOT, "requirements.txt")).read()
    # Pinned floor that has the stable addon API on both py3.9 (dev) and py3.14 (VM).
    assert re.search(r"^mitmproxy>=9\.0", req, re.M), "mitmproxy must be pinned with a >=9.0 floor"


def test_package_importable():
    import mitm  # noqa: F401
