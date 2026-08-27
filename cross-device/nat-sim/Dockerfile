# One image for every role in the sim (bootstrap, gateway, peer, relay). The
# gateways need iptables/iproute2; the peers need iproute2 to replace the
# default route with their own NAT gateway.
#
# The deps are installed HERE, not mounted from the sibling checkouts: those
# node_modules are built for the host (udx-native ships a per-platform prebuild),
# so a macOS tree bind-mounted into a Linux container fails to load.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends iproute2 iptables procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /sim
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . /sim
RUN chmod +x /sim/*.sh
