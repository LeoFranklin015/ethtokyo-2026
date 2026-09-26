"""One-time headed login for the ETHGlobal scraper.

Opens a visible Chromium window using the SAME persistent profile directory
the headless scraper uses, so the email+OTP session is written into that
profile and reused by every later headless request. Run this once on the VM's
graphical display (DISPLAY=:0); log in by hand, then press Enter here to save
and close.
"""

import os
import time

from playwright.sync_api import sync_playwright

PROFILE_DIR = os.path.expanduser("~/ensca_scraper/pw_profile")
DONE_FILE = os.path.expanduser("~/ensca_scraper/.login_done")
LOGIN_URL = "https://ethglobal.com/login"


def main():
    os.makedirs(PROFILE_DIR, exist_ok=True)
    if os.path.exists(DONE_FILE):
        os.remove(DONE_FILE)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=["--ozone-platform=wayland", "--enable-features=UseOzonePlatform"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        print("\n" + "=" * 60)
        print("A browser window is open on the VM screen.")
        print("Complete the email + OTP login there.")
        print("When done, this script saves once ~/ensca_scraper/.login_done")
        print("appears (touch it, or it is created remotely).")
        print("=" * 60)
        while not os.path.exists(DONE_FILE):
            time.sleep(1)
        os.remove(DONE_FILE)
        ctx.close()
    print("Session saved to", PROFILE_DIR)


if __name__ == "__main__":
    main()

