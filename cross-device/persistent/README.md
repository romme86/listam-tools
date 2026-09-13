# Persistent headless peers

One command per device turns a deployed checkout into an always-on peer (systemd user unit + linger, cron fallback when there is no user bus):

    ssh <device> '~/node22/bin/node ~/listam/listam-headless/headless.mjs install --storage ~/listam-data [--invite <key>]'

It writes `<storage>/run.sh` (wrapper that keeps stdin alive on a read-write FIFO — stdin EOF would shut the service down) and `~/.config/systemd/user/listam-headless.service`, enables `loginctl` linger (falling back to `sudo -n`, then to `@reboot` + watchdog crontab lines), starts the service, and — with `--invite` — joins the project before returning. `uninstall --storage <dir>` reverses everything but keeps the storage dir.

Control a running instance (replies land in the journal; invites are single-use, minted by the project owner):

    echo '{"id":1,"op":"dump"}' > ~/listam-data/control.fifo
    journalctl --user -u listam-headless -o cat -n 20
    ~/node22/bin/node ~/listam/listam-headless/headless.mjs status --storage ~/listam-data   # one-shot, exit 1 if stale

Service ops: `systemctl --user {status,restart,stop} listam-headless`. After a SIGKILL the storage lease (30s TTL) makes the first restart attempts fail with "lease held" — the unit's StartLimit settings absorb that; expect recovery within ~40s.

Deployed peers (2026-06-12): the Raspberry Pi and the Geekom VM (configured per-host in `devices.local.json`), storage `~/listam-data`, joined to the personal project as participants. The cross-device matrix sweeps only `/tmp/listam-xdev-*` and `pkill -f "[l]istam-xdev"`, so these peers coexist with matrix runs — never delete `~/listam-data`. The Geekom VM's ufw drops unsolicited inbound UDP: it works as a join-guest, not as a pairing host.

## Connection relays (13 September 2026)

Both hosts run `listam-headless-relay.service` from a deployment tree separate
from the participant. Deployments preserved the existing relay identities.

| Host | Relay code | Relay storage | Public relay key |
| --- | --- | --- | --- |
| Geekom | `~/listam-relay-app/listam-headless` | `~/listam-relay` | `8kn1epgsuok4zbkq3odaz7xf67yrs81bt7g1ztnr5fdq6aahfj1o` |
| Raspberry Pi | `~/listam-relay-app/listam-headless` | `~/listam-relay` | `mw1ihwc7a66jnxu5c443peu4iadgema95nq7t4wqrk5pzc8aohwy` |

The Pi's local UDP listener is fixed at **49740**. Both nodes report a
firewalled/ephemeral DHT position. They serve connection relays, but do not
supply public discovery/bootstrap addresses. Discovery uses the existing
public DHT. No router or firewall settings were changed.

From the workspace root:

```sh
./listam-tools/installer/deploy-relay.sh cassandrina@raspberrypi.taile12a8d.ts.net \
  --key ~/.ssh/cassandrina_app_codex --port 49740 --install
./listam-tools/installer/deploy-relay.sh cassandrina@cassandrina-app.taile12a8d.ts.net \
  --key ~/.ssh/cassandrina_app_codex --install
```

The installer defaults to `~/listam-relay-app`. Do not point it at participant
code while that participant is running. Before a deployment, preserve the
relay seed, service unit and code; before a participant update, stop that
participant and make a consistent copy of `~/listam-data`. The 13 September
backups on each host are owner-only at
`~/listam-release-backups/2026-09-13/`. Never clone a participant's writable
identity onto a second running device.

`listam-relay-check.timer` runs every ten minutes with up to sixty seconds of
jitter. It performs a synthetic encrypted round trip through each configured
relay with direct hole punching disabled. It writes `relay-health.json`
separately from service status and leaves the probe service failed on an error.
A failed network probe does not automatically restart a healthy relay.

```sh
systemctl --user status listam-headless-relay listam-relay-check.timer
systemctl --user start listam-relay-check.service
cat ~/listam-relay/relay-health.json
~/node22/bin/node ~/listam-relay-app/listam-headless/headless.mjs \
  relay-check --storage ~/listam-relay
```

`relayConfigured` counts candidates; it does not prove actual use. The encrypted
probe and matched-pair/session counters provide that evidence. Both relays
passed after deployment on 13 September. Desktop **0.22.0**, iOS **1.3.5 (25)**
and Android **1.3.5 (22)** contain both configured relay keys and the updated
fallback policy. Older installed builds may still contain only one key.

## List-data storage and application distribution

These are separate roles with separate stores:

- A **participant** at `~/listam-data` has the authorized list keys and can
  decrypt and edit the lists. Both hosts' quotas are now **2 GiB**; their old
  1 GiB quotas were exceeded. Check a fresh `headless-status.json`, not just
  whether systemd reports the process running.
- A **blind-storage helper** retains public core identifiers and ciphertext.
  Version **0.15.0** supports authenticated durable manifests covering the base,
  system, view and writers, with persistent subscriptions and explicit
  withdrawal. Follow the headless README's control-pair/control-connect flow.
  This implementation was tested; neither participant was silently converted
  into a blind list-data helper.
- The Geekom additionally runs **listam-app-mirror.service**, serving the Pear
  desktop application drive. It does not hold users' list encryption keys.

See [the Pear app mirror runbook](app-mirror.md) and
[the release execution record](../../reviews/2026-09-13-p2p-release.md) for
current deployment evidence and the Pi participant's recovery status.
