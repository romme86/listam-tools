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
