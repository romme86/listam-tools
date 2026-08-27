#!/bin/sh
# A peer sees only its own private LAN. Docker still installs a default route
# via the bridge's own gateway, which on an `internal: true` network goes
# nowhere — replace it with our NAT box so every packet out of here is
# source-port-randomised on the way.
set -e

ip route replace default via "$SIM_GATEWAY"

exec node /sim/probe.mjs
