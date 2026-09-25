#!/bin/bash
# Run once on VM to set up proxy service and create first admin token.
set -e

# Install Python deps
pip3 install flask bcrypt requests

# Copy files
mkdir -p /opt/ensca/proxy
cp -r "$(dirname "$0")"/* /opt/ensca/proxy/

# Copy systemd unit
cp "$(dirname "$0")"/../config/ensca-proxy.service /etc/systemd/system/

# Init DB dir + schema
mkdir -p /var/lib/ensca
python3 /opt/ensca/proxy/proxy.py &
PID=$!
sleep 2
kill $PID 2>/dev/null || true
python3 -c "
import sys; sys.path.insert(0,'/opt/ensca/proxy')
from db import init_db; init_db(); print('DB initialised')
"

# Create first admin token via API (server must be started first)
systemctl daemon-reload
systemctl enable --now ensca-proxy.service
sleep 2

TOKEN_JSON=$(curl -s -X POST http://127.0.0.1:8081/admin/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"bootstrap"}')

echo ""
echo "=== SAVE THIS TOKEN — shown only once ==="
echo "$TOKEN_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Token: {d[\"token\"]}')"
echo "========================================="
