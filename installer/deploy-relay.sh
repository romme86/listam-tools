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
[[ "$TARGET" != -* ]] || { echo "ssh target cannot start with '-'" >&2; exit 2; }
shift

SSH_KEY=""
REMOTE_STORAGE=""
DO_INSTALL=0
REMOTE_ROOT=""

while [ $# -gt 0 ]; do
    case "$1" in
        --key) SSH_KEY="$2"; shift 2 ;;
        --storage) REMOTE_STORAGE="$2"; shift 2 ;;
        --root) REMOTE_ROOT="$2"; shift 2 ;;
        --install) DO_INSTALL=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15)
[ -n "$SSH_KEY" ] && SSH+=(-i "$SSH_KEY")

# Resolve the remote home ONCE and build absolute paths from it. The generated
# systemd unit bakes these paths in, and a unit cannot expand $HOME — so a
# literal "$HOME/..." here would produce a unit that silently fails to start.
REMOTE_HOME="$("${SSH[@]}" "$TARGET" 'printf %s "$HOME"')"
[ -n "$REMOTE_HOME" ] || { echo "could not resolve the remote home directory" >&2; exit 1; }
: "${REMOTE_STORAGE:=$REMOTE_HOME/listam-relay}"
: "${REMOTE_ROOT:=$REMOTE_HOME/listam}"

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
        "cd $REMOTE_ROOT/listam-headless && $REMOTE_HOME/node22/bin/node headless.mjs install --storage $REMOTE_STORAGE --role relay"
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
