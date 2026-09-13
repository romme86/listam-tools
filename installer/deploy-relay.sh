#!/usr/bin/env bash
#
# Deploy the Listam blind relay to an always-on peer box and print the public key
# that has to go into the clients.
#
# Why a relay exists at all: two peers both behind carrier-grade NAT cannot hole
# punch. hyperdht aborts a double-random NAT pair without even attempting a punch
# (hyperdht/lib/connect.js), which is why three phones on 4G could not pair with
# each other on 2026-08-26. A box with a reachable address relays the UDX stream
# between them. The relay is a peer of nothing: no config, no base, no list keys.
# It pairs two peers on a token they exchanged through the DHT and pumps bytes,
# so it can read nothing it carries.
#
# The relay gets its OWN storage dir, deliberately. Every peer role writes the
# same status file, so co-locating a relay with a running participant would have
# the two services overwriting each other's snapshot.
#
# Usage:
#   ./deploy-relay.sh <ssh-target> [--key <identity>] [--storage <remote-dir>] [--root <remote-dir>] [--port <udp-port>] [--install]
#
# Example (the Geekom, from cross-device/devices.local.json):
#   ./deploy-relay.sh cassandrina@cassandrina-app.taile12a8d.ts.net \
#       --key ~/.ssh/cassandrina_app_codex --install
#
# --install additionally registers the systemd user unit so the relay survives
# reboots. Without it the script only syncs, mints the key, and prints it.

set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { echo "usage: $0 <ssh-target> [--key <identity>] [--storage <dir>] [--install]" >&2; exit 2; }
[[ "$TARGET" != -* ]] || { echo "ssh target cannot start with '-'" >&2; exit 2; }
shift

SSH_KEY=""
REMOTE_STORAGE=""
DO_INSTALL=0
REMOTE_ROOT=""
RELAY_PORT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --key) SSH_KEY="$2"; shift 2 ;;
        --storage) REMOTE_STORAGE="$2"; shift 2 ;;
        --root) REMOTE_ROOT="$2"; shift 2 ;;
        --port) RELAY_PORT="$2"; shift 2 ;;
        --install) DO_INSTALL=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ -n "$RELAY_PORT" ]; then
    [[ "$RELAY_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$RELAY_PORT >= 1 && 10#$RELAY_PORT <= 65535 )) \
        || { echo "relay port must be an integer between 1 and 65535" >&2; exit 2; }
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

# Resolve the remote home ONCE and build absolute paths from it. The generated
# systemd unit bakes these paths in, and a unit cannot expand $HOME — so a
# literal "$HOME/..." here would produce a unit that silently fails to start.
REMOTE_HOME="$("${SSH[@]}" "$TARGET" 'printf %s "$HOME"')"
[ -n "$REMOTE_HOME" ] || { echo "could not resolve the remote home directory" >&2; exit 1; }
: "${REMOTE_STORAGE:=$REMOTE_HOME/listam-relay}"
: "${REMOTE_ROOT:=$REMOTE_HOME/listam-relay-app}"

# These paths are interpolated into remote shell commands and a systemd unit.
# Accept a small absolute-path alphabet, including the resolved remote home.
for p in "$REMOTE_STORAGE" "$REMOTE_ROOT" "$REMOTE_HOME"; do
    [[ "$p" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "refusing: remote paths must be absolute and contain only letters, digits, _, ., / or -" >&2; exit 2; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$HERE/listam-headless" ] || { echo "cannot find listam-headless next to listam-tools" >&2; exit 1; }

echo "==> syncing listam-headless and listam-packages to $TARGET"
# tar over ssh rather than rsync: the peer boxes are minimal installs and do not
# all have rsync. Additive on purpose — never delete remote files we did not put
# there (a relay box may also be running a participant peer).
"${SSH[@]}" "$TARGET" "mkdir -p $REMOTE_ROOT/listam-headless $REMOTE_ROOT/listam-packages"
tar czf - -C "$HERE/listam-headless" \
    package.json package-lock.json headless.mjs src scripts README.md LICENSE \
    | "${SSH[@]}" "$TARGET" "tar xzf - -C $REMOTE_ROOT/listam-headless"
tar czf - -C "$HERE/listam-packages" --exclude node_modules \
    package.json package-lock.json packages \
    | "${SSH[@]}" "$TARGET" "tar xzf - -C $REMOTE_ROOT/listam-packages"

echo "==> installing the locked relay dependencies"
"${SSH[@]}" "$TARGET" \
    "export PATH=$REMOTE_HOME/node22/bin:\$PATH; cd $REMOTE_ROOT/listam-packages && npm ci --omit=dev --no-audit --no-fund && cd $REMOTE_ROOT/listam-headless && npm ci --omit=dev --no-audit --no-fund"

echo "==> minting / reading the relay public key"
# --print-key is idempotent: it derives from a persisted seed, so re-running it
# returns the SAME key. The address is baked into client builds and handed to
# people the owner will never speak to again, so it must never rotate silently.
KEY_JSON="$("${SSH[@]}" "$TARGET" \
    "cd $REMOTE_ROOT/listam-headless && $REMOTE_HOME/node22/bin/node headless.mjs relay --storage $REMOTE_STORAGE --print-key")"
echo "$KEY_JSON"

if [ "$DO_INSTALL" = "1" ]; then
    echo "==> installing the systemd user unit (listam-headless-relay)"
    "${SSH[@]}" "$TARGET" \
        "cd $REMOTE_ROOT/listam-headless && $REMOTE_HOME/node22/bin/node headless.mjs install --storage $REMOTE_STORAGE --role relay ${RELAY_PORT:+--port $RELAY_PORT}"
    echo "==> unit status"
    "${SSH[@]}" "$TARGET" "systemctl --user status listam-headless-relay --no-pager | head -20" || true

    # A separate timer checks both configured relays with synthetic encrypted
    # traffic. Failed checks leave a failed unit and a timestamped JSON report;
    # restarting a healthy relay would not repair a remote network outage.
    "${SSH[@]}" "$TARGET" "bash -s -- $REMOTE_ROOT $REMOTE_STORAGE $REMOTE_HOME/node22/bin/node" <<'MONITOR'
set -euo pipefail
DEPLOY_ROOT="$1"
RELAY_STORAGE="$2"
NODE_BIN="$3"
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/listam-relay-check.service" <<UNIT
[Unit]
Description=Verify Listam relay encrypted round trips
[Service]
Type=oneshot
ExecStart=$NODE_BIN $DEPLOY_ROOT/listam-headless/headless.mjs relay-check --storage $RELAY_STORAGE
TimeoutStartSec=150
UNIT
cat > "$HOME/.config/systemd/user/listam-relay-check.timer" <<'UNIT'
[Unit]
Description=Check Listam relay reachability every ten minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
RandomizedDelaySec=60
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now listam-relay-check.timer
MONITOR
fi

cat <<'NEXT'

------------------------------------------------------------------
NEXT STEP — put the key into the clients.

After verifying an encrypted round trip through the relay from another network,
add the `publicKey` printed above to DEFAULT_RELAY_KEYS in:

    listam-packages/packages/backend/lib/relay.mjs

    export const DEFAULT_RELAY_KEYS = ['<existing-key>', '<additional-key>']

Keep existing working keys. Rebuild/ship the apps for clients to use the new
relay; installing this service alone does not update their embedded addresses.

Verify actual use with the relay's matched-pair/session counters.
`relayConfigured` only counts configured candidates; it does not prove use.
Discovery still uses the DHT: a bootstrap address needs a stable public address
and reachable UDP port, separately from the connection relay's public key.
------------------------------------------------------------------
NEXT
