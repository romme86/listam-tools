#!/bin/sh
# One carrier-grade NAT. The whole sim turns on the flag on the last line.
#
# Plain MASQUERADE keeps the source port whenever it is free, which hyperdht's
# NAT sampler reads as FIREWALL.CONSISTENT — and a consistent NAT punches fine,
# so a sim without --random-fully proves nothing. --random-fully picks a fresh
# random source port for every new conntrack flow, which is what a carrier NAT
# does and what makes hyperdht classify BOTH ends as FIREWALL.RANDOM. That is
# the exact precondition for connect.js aborting with
# HOLEPUNCH_DOUBLE_RANDOMIZED_NATS *without attempting a punch*.
set -e

# Which interface faces the public network is up to docker's attach order, so
# match on the subnet rather than assuming eth0/eth1.
UPLINK=$(ip -o -4 addr show | awk -v prefix="$SIM_PUBLIC_PREFIX" '$4 ~ "^"prefix {print $2; exit}')
if [ -z "$UPLINK" ]; then
    echo "{\"sim\":\"gateway\",\"error\":\"no interface on $SIM_PUBLIC_PREFIX\"}"
    exit 1
fi

if ! iptables -t nat -A POSTROUTING -o "$UPLINK" -j MASQUERADE --random-fully; then
    # Worth failing loudly: a silent fallback to plain MASQUERADE would make the
    # sim pass while reproducing nothing.
    echo '{"sim":"gateway","error":"iptables MASQUERADE --random-fully rejected (kernel without nf_nat, or iptables < 1.6.2)"}'
    exit 1
fi

echo "{\"sim\":\"gateway\",\"ready\":true,\"uplink\":\"$UPLINK\"}"

# Nothing else to do — the container exists to hold the netns and the rules.
exec tail -f /dev/null
