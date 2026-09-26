#!/usr/bin/env bash
# Launch the wallet Layer-2 TLS-intercepting listener.
# Prereq: mitmproxy CA generated once (mitmdump --version bootstraps it into
# ~/.mitmproxy) and served by the proxy at /wallet/ca.crt; the device trusts
# it per web/app/wallet/setup. HSTS-preloaded hosts are ignored (real cert,
# no wallet) — that is expected and unbypassable on stock browsers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"

: "${WALLET_L2_BASE:=http://192.168.0.1:8081}"
export WALLET_L2_BASE
export WALLET_L2_PROVIDER_URL="${WALLET_L2_BASE}/wallet/provider.l2.js"

# 1. (Re)generate the absolute-URL provider variant the proxy will serve.
python3 "$HERE/gen_provider.py"

# 2. HSTS-preloaded / cert-pinned hosts that CANNOT be intercepted on a stock
#    browser — pass them through untouched so the tab still loads.
IGNORE='(^|\.)(aave\.com|google\.com|gstatic\.com|googleapis\.com|apple\.com|icloud\.com|mozilla\.org|cloudflare\.com|paypal\.com|stripe\.com)(:443)?$'

exec mitmdump \
  --mode transparent \
  --listen-port 8443 \
  --set connection_strategy=lazy \
  --ignore-hosts "$IGNORE" \
  -s "$HERE/wallet_mitm.py"
