import os, sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

import app as portalmod


@pytest.fixture
def name_login(monkeypatch):
    """Turn on the typed-name fallback for tests that exercise it.

    `ALLOW_NAME_LOGIN` is off in production, so `/login` refuses before it reaches any of the
    logic these tests are about. Without this the assertions passed vacuously or failed for the
    wrong reason — `test_relogin_same_ens_is_noop` in particular was green only because nothing
    was ever granted.
    """
    monkeypatch.setattr(portalmod, "ALLOW_NAME_LOGIN", True)
