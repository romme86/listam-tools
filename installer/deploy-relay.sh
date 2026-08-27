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
#   ./deploy-relay.sh <ssh-target> [--key <identity>] [--storage <remote-dir>] [--install]
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
shift

SSH_KEY=""
REMOTE_STORAGE="\$HOME/listam-relay"
DO_INSTALL=0
REMOTE_ROOT="\$HOME/listam"

while [ $# -gt 0 ]; do
    case "$1" in
        --key) SSH_KEY="$2"; shift 2 ;;
        --storage) REMOTE_STORAGE="$2"; shift 2 ;;
        --root) REMOTE_ROOT="$2"; shift 2 ;;
        --install) DO_INSTALL=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# The generated systemd unit points at on-disk paths, so a storage path with
# spaces, quotes, $ or backticks produces a unit that silently fails to start.
case "$REMOTE_STORAGE" in
    *[\ \'\"\$\`]*) echo "refusing: --storage must be shell-safe (no spaces, quotes, \$ or backticks)" >&2; exit 2 ;;
esac

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -d "$HERE/listam-headless" ] || { echo "cannot find listam-headless next to listam-tools" >&2; exit 1; }

echo "==> syncing listam-headless and listam-packages to $TARGET"
# tar over ssh rather than rsync: the peer boxes are minimal installs and do not
# all have rsync. Additive on purpose — never delete remote files we did not put
# there (a relay box may also be running a participant peer).
"${SSH[@]}" "$TARGET" "mkdir -p $REMOTE_ROOT/listam-headless $REMOTE_ROOT/listam-packages"
tar czf - -C "$HERE/listam-headless" \
    --exclude node_modules --exclude .git --exclude dist --exclude tmp . \
    | "${SSH[@]}" "$TARGET" "tar xzf - -C $REMOTE_ROOT/listam-headless"
tar czf - -C "$HERE/listam-packages" --exclude node_modules --exclude .git . \
    | "${SSH[@]}" "$TARGET" "tar xzf - -C $REMOTE_ROOT/listam-packages"

echo "==> minting / reading the relay public key"
# --print-key is idempotent: it derives from a persisted seed, so re-running it
# returns the SAME key. The address is baked into client builds and handed to
# people the owner will never speak to again, so it must never rotate silently.
KEY_JSON="$("${SSH[@]}" "$TARGET" \
    "cd $REMOTE_ROOT/listam-headless && \$HOME/node22/bin/node headless.mjs relay --storage $REMOTE_STORAGE --print-key")"
echo "$KEY_JSON"

if [ "$DO_INSTALL" = "1" ]; then
    echo "==> installing the systemd user unit (listam-headless-relay)"
    "${SSH[@]}" "$TARGET" \
        "cd $REMOTE_ROOT/listam-headless && \$HOME/node22/bin/node headless.mjs install --storage $REMOTE_STORAGE --role relay"
    echo "==> unit status"
    "${SSH[@]}" "$TARGET" "systemctl --user status listam-headless-relay --no-pager | head -20" || true
fi

cat <<'NEXT'

------------------------------------------------------------------
NEXT STEP — put the key into the clients.

Copy the `publicKey` printed above into DEFAULT_RELAY_KEYS in:

    listam-packages/packages/backend/lib/relay.mjs

    export const DEFAULT_RELAY_KEYS = ['<publicKey>']

Then rebuild/ship the apps. Until that lands, clients have no relay
configured and mobile-data pairing keeps failing exactly as before.

Verify from a client afterwards: the join heartbeat logs
`relayConfigured: 1`, and `randomized: true` on a phone means the
relay is the only reason the connection exists at all.
------------------------------------------------------------------
NEXT
