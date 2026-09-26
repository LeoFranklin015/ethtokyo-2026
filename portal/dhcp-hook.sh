#!/bin/sh
# dnsmasq dhcp-script: on a new or renewed lease, tell the portal to revoke
# any stale auth for that IP so a reconnecting device is bounced back to the
# captive portal and its OS shows the connect popup again.
#
# dnsmasq calls this as: $1=action(add|old|del) $2=mac $3=ip
# 'add'  = new lease (fresh connect or hard reconnect)
# 'old'  = lease renewal (reconnect keeping the same IP)
# 'del'  = lease expiry (reaper owns teardown; nothing to bounce)
#
# revoke_access is a no-op for an IP that was never authed, so a first-time
# connect POSTs harmlessly and still lands on the portal via the baseline
# REDIRECT.
action="$1"
ip="$3"

case "$action" in
  add|old)
    [ -n "$ip" ] || exit 0
    curl -s -m 2 -X POST "http://127.0.0.1:8080/internal/revoke-ip" \
      -H "Content-Type: application/json" \
      -d "{\"ip\": \"$ip\"}" >/dev/null 2>&1 || true
    ;;
esac
exit 0
