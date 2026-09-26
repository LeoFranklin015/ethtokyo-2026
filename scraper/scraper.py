"""Persistent-browser ETHGlobal profile scraper.

One headless Chromium persistent context is launched at startup and kept
alive for the whole process, reusing the login session created by login.py.
GET /scrape?url=<url> opens a fresh page in that context, resolves the (JS)
redirect, scrapes the profile name and image, and closes the page. The browser
itself is closed once, at process shutdown.

Playwright's sync API is not thread-safe, so the Flask server runs
single-threaded: every request touches the shared context from the one
serving thread, never concurrently.
"""

import atexit
import os
import threading

from flask import Flask, jsonify, request
from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

PROFILE_DIR = os.path.expanduser("~/ensca_scraper/pw_profile")
NAV_TIMEOUT_MS = 30000
PROFILE_TIMEOUT_MS = 15000
# Dub cloaks the ethglob.al redirect behind user-agent detection: the default
# headless UA gets a Dub preview stub, a real desktop UA gets the profile.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)

app = Flask(__name__)

# One playwright + one persistent context for the process lifetime.
_pw = None
_ctx = None
_lock = threading.Lock()


def _start_browser():
    global _pw, _ctx
    os.makedirs(PROFILE_DIR, exist_ok=True)
    _pw = sync_playwright().start()
    _ctx = _pw.chromium.launch_persistent_context(
        PROFILE_DIR,
        headless=True,
        user_agent=USER_AGENT,
        viewport={"width": 1280, "height": 900},
    )


def _stop_browser():
    global _pw, _ctx
    try:
        if _ctx is not None:
            _ctx.close()
    finally:
        if _pw is not None:
            _pw.stop()
        _ctx = None
        _pw = None


atexit.register(_stop_browser)


def _extract(page):
    """Return (name, image_url) for an ETHGlobal Connect profile page.

    Name is the profile <h1>. Image is the user's avatar, stored under a
    `/users/` path on ETHGlobal's R2 bucket — distinct from the generic
    og:image (og.png) and the event-logo images, so we match on that path.
    """
    name = None
    image = None

    el = page.query_selector("h1")
    if el:
        name = (el.inner_text() or "").strip() or None

    for img in page.query_selector_all("img"):
        src = img.get_attribute("src") or ""
        if "/users/" in src:
            image = src
            break

    return name, image


@app.get("/scrape")
def scrape():
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "missing url"}), 400

    with _lock:
        page = _ctx.new_page()
        try:
            page.goto(url, wait_until="commit", timeout=NAV_TIMEOUT_MS)

            # A Dub short link (ethglob.al/*) redirects client-side to
            # ethglobal.com/connect/*. Wait for that hop off the short domain;
            # if it never happens we got the Dub preview stub, not a profile.
            if "ethglob.al" in url:
                try:
                    page.wait_for_url(
                        lambda u: "ethglob.al" not in u,
                        timeout=PROFILE_TIMEOUT_MS,
                    )
                except PWTimeout:
                    return jsonify({
                        "error": "redirect_not_followed",
                        "detail": "link did not resolve to a profile "
                                  "(expired, gated, or bot-blocked)",
                        "landed_on": page.url,
                    }), 502

            # Profile content renders after navigation; wait for the heading.
            try:
                page.wait_for_selector("h1", timeout=PROFILE_TIMEOUT_MS)
            except PWTimeout:
                pass

            name, image = _extract(page)
            final_url = page.url
        except Exception as e:
            return jsonify({"error": "scrape_failed", "detail": str(e)}), 502
        finally:
            page.close()

    if not name and not image:
        return jsonify({
            "error": "no_profile_data",
            "landed_on": final_url,
        }), 404
    return jsonify({"name": name, "image": image})


@app.get("/health")
def health():
    return jsonify({"ok": _ctx is not None})


if __name__ == "__main__":
    _start_browser()
    # threaded=False: the sync Playwright context is used from one thread only.
    app.run(host="127.0.0.1", port=8090, threaded=False)
