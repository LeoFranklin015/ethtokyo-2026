import wallet_allowlist as wa


def test_read_method_is_read():
    assert wa.is_read("eth_call") is True


def test_every_signing_method_rejected():
    for m in wa.SIGNING_METHODS:
        assert wa.is_read(m) is False


def test_unknown_method_rejected():
    assert wa.is_read("eth_signFutureThing") is False


def test_no_signing_method_in_read_set():
    assert wa.READ_METHODS.isdisjoint(wa.SIGNING_METHODS)
