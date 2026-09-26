import os
import stat
import subprocess
import textwrap

HOOK = os.path.join(os.path.dirname(__file__), "..", "dhcp-hook.sh")


def _run_hook(tmp_path, action, ip):
    """Run the dhcp hook with a fake curl on PATH that records its args."""
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    log = tmp_path / "curl.log"
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        echo "$@" >> "{log}"
    """))
    fake_curl.chmod(fake_curl.stat().st_mode | stat.S_IEXEC)
    env = dict(os.environ, PATH=f"{fake_bin}:{os.environ['PATH']}")
    subprocess.run(["sh", HOOK, action, "aa:bb:cc:dd:ee:ff", ip],
                   env=env, check=False, capture_output=True)
    return log.read_text() if log.exists() else ""


def test_hook_revokes_on_new_lease(tmp_path):
    """On a fresh/renewed DHCP lease (add/old), the hook must POST the leased
    IP to the portal's /internal/revoke-ip so any stale auth for that IP is
    torn down and the reconnecting device is bounced back to the captive
    portal. Without this, a hard reconnect keeps the device's stale :80
    bypass rule and the OS never shows the connect popup."""
    out = _run_hook(tmp_path, "add", "192.168.0.17")
    assert "/internal/revoke-ip" in out, f"hook must POST to revoke-ip on add:\n{out}"
    assert "192.168.0.17" in out, f"hook must send the leased IP:\n{out}"


def test_hook_revokes_on_lease_renew(tmp_path):
    """dnsmasq fires 'old' on a lease renewal after a reconnect. Treat it the
    same as 'add' — revoke so the device re-authenticates."""
    out = _run_hook(tmp_path, "old", "192.168.0.17")
    assert "/internal/revoke-ip" in out and "192.168.0.17" in out


def test_hook_ignores_del(tmp_path):
    """A 'del' event (lease expiry) needs no revoke POST — the reaper owns
    teardown for genuinely-gone devices, and a del carries no reconnecting
    client to bounce."""
    out = _run_hook(tmp_path, "del", "192.168.0.17")
    assert "/internal/revoke-ip" not in out, f"del must not POST:\n{out}"
