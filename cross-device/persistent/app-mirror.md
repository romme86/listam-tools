# Geekom desktop application mirror

Pear **3.4.0** is installed separately from the legacy desktop runtime. The
official `pear-v3.4.0-linux-x64.zip` release asset has SHA-256
`0085b0607b341fc5cbef7f6a1e567864f9defd9eb1cda80ab2b3c37b754c4a74`.
Obtain it from the [official release](https://github.com/holepunchto/pear/releases/tag/v3.4.0),
verify the checksum, and install the executable at
`/home/cassandrina/listam-pear-3.4/pear`.

The installed user service is:

```ini
[Unit]
Description=Listam desktop application encrypted drive mirror
After=network-online.target

[Service]
ExecStart=/home/cassandrina/listam-pear-3.4/pear blind-peer start --trusted-peer ut3s5aent3tc6nsf3qtxdr95wafboacw1z9gey4675f9ztcpj8wy
Restart=on-failure
RestartSec=15

[Install]
WantedBy=default.target
```

The trusted peer is the existing release controller. Serving state and identity
persist under `~/.config/pear`; preserve this directory when upgrading. Enable
and start with `systemctl --user enable --now listam-app-mirror`. Check the
journal for its **listening public key**:

`kyyaiwxx3eo1rx1tcabqwjkmp4ckuijq3hn89t7uh8wrdc9psu8o`

`pear blind-peer identity` reports the controller/sidecar identity, which is
not the serving key to pass as `--peer`.

## Release controller on the Mac

The controller executable and state are isolated at:

- `~/Library/Application Support/ListamTools/pear-3.4/out/make/pear`
- `~/Library/Application Support/ListamTools/pear-3.4/pear/`

The `out/make/pear` layout activates Pear 3.4's development-root isolation.
Keep that layout when moving/upgrading it. An ordinary unisolated 3.4 binary
shares the default socket/state paths with the older desktop runtime and can
send commands to the wrong sidecar. The existing desktop runtime is left in
its normal installation directory. The official macOS arm64 asset SHA-256 is
`70c4665c5be3b2e30928179f5d753028e9ee9df5a1fbbadfae4e2410329cf0ac`.

After staging and releasing the production drive using the existing desktop
release workflow, request mirroring with this isolated controller:

```sh
"$HOME/Library/Application Support/ListamTools/pear-3.4/out/make/pear" \
  blind-peer --json request \
  pear://h1jwexik1m9c75rqng8hico4oxqgmm8xskws684skmjepksq5r3o \
  --peer kyyaiwxx3eo1rx1tcabqwjkmp4ckuijq3hn89t7uh8wrdc9psu8o
```

Registration covers both the metadata drive and its content core:
`w1zwhu8odruu5gf1syfrdqx97k1tgemtk37hg5bqyzgf8xk7sdiy`.
A successful request is not download completion. Wait for **Core fully
downloaded** for both cores in the Geekom journal.

## Acceptance evidence, 13 September 2026

Production release **0.22.0**, release/metadata length **6628**, content length
**13302**, was fully downloaded by the helper. A fresh Corestore/Hyperdrive
reader used `swarm.joinPeer(helperKey)` with no discovery join and rejected
connections from any other public key. It read the package version and every
file: **4,380 files, 269,280,848 bytes, exactly one peer**. A second fresh-store
run passed after restarting the helper, proving identity and registration
survive restart. No publishing peer was used by either reader.

Local evidence is in `/tmp/listam-release-2026-09-13/app-recovery/` and
`app-recovery-after-restart/`. This verifies complete app-drive availability;
it does not verify list-data replication or imply Pear 3.4 is the runtime
embedded in the desktop app. List-data mirroring has its own authenticated
manifest and offline-writer tests.
