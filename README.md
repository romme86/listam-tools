# listam-tools

Developer tooling for [Listam](https://github.com/romme86). Expects the sibling `listam-*` checkouts (`listam-headless`, `listam-desktop`, `listam-hardware`) laid out next to this repo.

## `cross-device/` — cross-device acceptance matrix

Drives real Listam instances across machines — Mac (headless + desktop backend), a remote Debian VM, a Raspberry Pi, and the ESP32-S3 leaf board — over the shared JSON-line protocol, and times invite/join/sync/steady-state/mesh convergence plus the ESP32 leaf-mirror row.

```bash
cp cross-device/devices.example.json cross-device/devices.local.json   # fill in your hosts (gitignored)
node listam-tools/cross-device/matrix.mjs --devices mac-headless,geekom,pi,mac-desktop \
  --net mainnet --unordered --time-budget 15 --esp32
```

- **`driver.mjs`** — uniform launcher: local headless/desktop or SSH-spawned remote instances.
- **`matrix.mjs`** — the matrix runner (per-request deadlines, row time-boxes, `--time-budget` watchdog, guaranteed remote cleanup).
- **`esp32-leaf.mjs`** — ESP32 leaf-mirror row (drives a persistent hub, asserts on the board's serial block-stored events).
- **`wedge-repro.mjs`** — regression repro for the disconnected-peer wedge.
- **`devices.local.json`** — your SSH hosts, key paths, and board serial (gitignored; see `devices.example.json`).
- **`TESTPLAN.md`** — the full plan, device roster, and known constraints.
- **`persistent/`** — turning a deployed checkout into an always-on systemd peer.

## `listam-npm`

Helper for npm publish-token management via the macOS Keychain.
