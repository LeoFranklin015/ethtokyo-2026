import json
import os

# The single source of truth lives with the web app so the browser can fetch it;
# the proxy reads the same file so the two enforcement points cannot drift.
_PATH = os.path.join(
    os.path.dirname(__file__), "..", "web", "public", "wallet", "read-methods.json"
)

with open(_PATH) as f:
    _methods = json.load(f)

READ_METHODS = set(_methods["read"])
SIGNING_METHODS = set(_methods["signing"])


def is_read(method: str) -> bool:
    return method in READ_METHODS
