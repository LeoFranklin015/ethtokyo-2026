#!/usr/bin/env bash
# ENS-identity VLAN real-traffic testbed (VM, root).
#
# Simulates two client "devices" as network namespaces, each on ITS OWN /24, wired
# point-to-point to the VM. The VM is the L3 gateway and routes A<->B, so peer
# traffic transits the real FORWARD chain + mangle MARK — the path the design's
# L3 isolation and fwmark shaping actually act on. (A single shared bridge subnet
# would switch A<->B at L2 and never reach FORWARD; that is why this uses routed
# subnets. It mirrors a real deployment where the AP has client-isolation on and
# the VM is the router — the only topology in which FORWARD-based isolation works.)
#
# Traffic is driven by the REAL portal /login (curl POST from inside each namespace
# -> portal at that namespace's gateway IP). remote_addr = the netns IP, so the
# portal's real grant_access marks/isolates that IP exactly as for a real client.
#
# T4 (bandwidth class): proven by reading the mangle MARK rule packet counters —
# a forwarded A<->B packet incrementing the mark-30 (hacker) / mark-10 (partner)
# rule proves classification fires on real transit. (Actual rate needs iperf; the
# spec test is "hacker in 1:30, partner in 1:10" = correct class, which the mark
# counter demonstrates.)
#
# Idempotent: `setup` runs teardown first. Throwaway 10.99.1.0/24 + 10.99.2.0/24,
# outside the real AP subnet, so never collides with live clients. `teardown` when done.
set -u

NS_A=ens-devA
NS_B=ens-devB
VETH_A=veth-a; VETH_A_P=veth-a-p
VETH_B=veth-b; VETH_B_P=veth-b-p
IP_A=10.99.1.10;  GW_A=10.99.1.1
IP_B=10.99.2.10;  GW_B=10.99.2.1
PORTAL_A=http://$GW_A:8080
PORTAL_B=http://$GW_B:8080

teardown() {
  ip netns del $NS_A 2>/dev/null
  ip netns del $NS_B 2>/dev/null
  ip link del $VETH_A_P 2>/dev/null
  ip link del $VETH_B_P 2>/dev/null
  # remove any grant/isolation rules the portal left for the test IPs
  for ip in $IP_A $IP_B; do
    while iptables -D FORWARD -s $ip -j ACCEPT 2>/dev/null; do :; done
    for m in 10 20 30; do
      while iptables -t mangle -D FORWARD -s $ip -j MARK --set-mark $m 2>/dev/null; do :; done
      while iptables -t mangle -D FORWARD -d $ip -j MARK --set-mark $m 2>/dev/null; do :; done
    done
    while iptables -t nat -D PREROUTING -s $ip -p udp --dport 53 -j DNAT --to-destination 8.8.8.8:53 2>/dev/null; do :; done
  done
  while iptables -D FORWARD -s $IP_A -d $IP_B -j DROP 2>/dev/null; do :; done
  while iptables -D FORWARD -s $IP_B -d $IP_A -j DROP 2>/dev/null; do :; done
  while iptables -D FORWARD -s $IP_A -d $IP_B -j DROP 2>/dev/null; do :; done
  while iptables -D FORWARD -s $IP_B -d $IP_A -j DROP 2>/dev/null; do :; done
}

setup() {
  teardown
  # device A on its own /24, VM holds GW_A
  ip netns add $NS_A
  ip link add $VETH_A type veth peer name $VETH_A_P
  ip link set $VETH_A netns $NS_A
  ip addr add $GW_A/24 dev $VETH_A_P
  ip link set $VETH_A_P up
  ip netns exec $NS_A ip addr add $IP_A/24 dev $VETH_A
  ip netns exec $NS_A ip link set $VETH_A up
  ip netns exec $NS_A ip link set lo up
  ip netns exec $NS_A ip route add default via $GW_A

  # device B on its own /24, VM holds GW_B
  ip netns add $NS_B
  ip link add $VETH_B type veth peer name $VETH_B_P
  ip link set $VETH_B netns $NS_B
  ip addr add $GW_B/24 dev $VETH_B_P
  ip link set $VETH_B_P up
  ip netns exec $NS_B ip addr add $IP_B/24 dev $VETH_B
  ip netns exec $NS_B ip link set $VETH_B up
  ip netns exec $NS_B ip link set lo up
  ip netns exec $NS_B ip route add default via $GW_B

  # VM routes between the two /24s (ip_forward already 1 on the VM)
  echo "setup complete: A=$IP_A (gw $GW_A) B=$IP_B (gw $GW_B) routed via VM FORWARD"
}

# Drive the REAL portal /login from inside a namespace, via that ns's gateway IP.
login() { # <ns> <gw> <ens_name>
  ip netns exec "$1" curl -s -o /dev/null -w "%{http_code}" \
    --data-urlencode "ens_name=$3" "http://$2:8080/login"
  echo " <- /login $3 from $1"
}

case "${1:-}" in
  setup) setup ;;
  teardown) teardown; echo "teardown complete" ;;
  login) login "$2" "$3" "$4" ;;
  *) echo "usage: $0 {setup|teardown|login <ns> <gw> <ens>}"; exit 1 ;;
esac
