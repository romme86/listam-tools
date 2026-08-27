# Cross-Device Acceptance Matrix — Test Plan

> **This matrix IS the network sync gate.** As of 2026-07-28 the multi-backend
> join tests in `listam-desktop/test/sync.test.mjs` are skipped on CI: they pair
> two backends as child processes on ONE machine, which cannot exercise real
> discovery, holepunching or NAT, so a pass never proved the network worked. (They
> were also failing ~75% of CI runs for reasons outside the codebase — both sides
> demonstrably reached `replicate()` on the right base while the connection carried
> zero blocks and died at the ~13s idle timeout. Runner networking, not app code.)
> They still run locally. Real coverage lives here — run this before a release or
> a deploy.
>
> Reference numbers, two real machines over mainnet, 2026-07-28: join 3842 ms,
> initial sync 5 ms, guest→host 262 ms, host→guest 5181 ms, done-flag 270 ms,
> delete 272 ms. A join in seconds, not the 120 s timeouts CI was reporting.
>
> Device targets, users and keys live only in `devices.local.json`, which is
> gitignored — keep them out of the repo. Start from `devices.example.json`. The
> JSON report defaults to `/tmp`, also outside the repo.

The Phase 15 cross-instance matrix, executed across real machines instead of
child processes on one host. Every instance is a real listam backend on its
own storage root; remote instances are spawned over SSH and driven through
the same JSON-line stdin/stdout protocol as the local ones.

## Devices

| Device | What runs | Where | Role in matrix |
|---|---|---|---|
| `mac-headless` | `listam-headless/headless.mjs` | this Mac | full participant (host/guest) |
| `mac-desktop` | desktop backend via `listam-desktop/test/helpers/backend-driver.mjs` (protocol-level desktop row; GUI rows stay manual per the acceptance wiki) | this Mac | full participant |
| `geekom` | headless | a Debian VM on the Geekom Proxmox host (SSH peer; configured in `devices.local.json`), `~/listam` + `~/node22` | full participant — **guest-only in practice** (see constraints) |
| `pi` | headless | Raspberry Pi (aarch64), `~/listam` + `~/node22` | full participant |
| `esp32` | `listam-hardware/leaf-peer/leaf-esp32` firmware on the ESP32-S3-N16R8 board | the board itself (serial on `/dev/cu.usbmodem…`) | **blind dial-only leaf mirror** — own row type, never a pair participant |

## Row types

1. **Pair rows** — every ordered (or `--unordered`) host→guest pairing of the
   participant devices. Each row on fresh storage: invite → join → initial
   sync (id-consistency, M1) → steady-state add in both directions →
   done-flag propagation → delete propagation, all timed.
2. **Mesh row** — all participants in one base: first device hosts, others
   join, everyone writes one item, all converge by id.
3. **esp32-leaf row** (`--esp32`) — launches the *persistent* leaf hub
   (`~/listam-leaf-hub`, leaf bridge on TCP 9993), verifies the hub's control
   key matches the firmware's `cfg.toml`, appends items, and asserts via the
   board's serial status lines (`status core=… length=… contiguous=…`) that
   all announced cores become fully contiguous and grow past the pre-add
   state. Metrics: first-contact latency, mirror lag (~10s resolution — the
   firmware's status interval).
4. **Invite-contention row** (`--contention [host,joiner,joiner,…]`) — ONE
   invite, several joiners racing it. Every other row mints a fresh invite per
   joiner, so invite contention had never been exercised. Exactly one joiner may
   land on the base; the assertion that matters is on the LOSERS — each must
   settle inside 20 s with a reason a machine can name, not sit on
   blind-pairing's 120 s deadline. Defaults to four local headless instances
   (it is a protocol race, not a network one — real machines only add SSH
   latency, and the remotes are the owner's live peers). Run it with `--net lan`.
5. **NAT-simulation rows** (`--nat-sim`) — both peers behind a source-port-
   randomizing carrier NAT, in containers (`cross-device/nat-sim/`, own README),
   never against a device. Without a relay, hyperdht must abort *without
   punching* (`HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` / `HOLEPUNCH_ABORTED`) — that
   is the 2026-08-26 field failure reproduced. With `relayThrough` pointed at a
   locally run `listam-headless` relay, the connection must complete. Both rows
   first assert `dht.randomized === true` on each peer: without that the sim
   isn't the environment under test and its verdict means nothing. Reports SKIP
   (not FAIL) where docker is unavailable. Wants `--time-budget 20`+ on a cold
   run — the first one builds a container image.

The leaf's offline-serve guarantee (fresh peer syncs from the leaf while the
hub is dead) is covered on-host by `listam-hardware/leaf-peer/bridge-js/e2e.mjs`;
the on-device variant needs the firmware's listen mode, which doesn't exist
yet — when it lands, add a row: kill hub, fresh local corestore peer dials
the board, expects verified blocks.

Known-failing (2026-06-12): the esp32-leaf row FAILs on an on-device protocol
bug — the board's first session syncs the control core and learns the
announced keys (storage stack proven end-to-end, including a persisted
block), but every multi-core session stalls before "handshake done" and
mirrors nothing; leaf-host passes the same flow. Until that handshake stall
is fixed, expect `row esp32-leaf mirror: FAIL` with cores registered at
length 0. Serial gotcha for anyone debugging: espflash monitor resets the
board on attach AND detach — use --no-reset to observe without restarting
the cycle.

## Network modes

- **mainnet (default)** — production discovery path; the only mode that
  exercises real cross-machine holepunching. Use this for cross-machine rows.
- **lan** — private hyperdht testnet bound to this Mac's LAN IP. Deterministic
  but **broken for cross-machine pairing**: the whole testnet colocates with
  one endpoint machine and BlindPairing connects never complete (observed
  2026-06-11; same-machine rows pass). Keep for local-only debugging until
  the bootstrap can run on a machine that hosts no instances.

## Budgets and failure containment

- `--time-budget <min>` (default 15): hard watchdog — skips new rows when low,
  force-writes the report, sweeps the remotes, exits 2 at the cap.
- Per-row time-box (5 min pair+contention / 6 min mesh+leaf) and per-request 30s
  deadline (join: 120s — it answers only after the pairing ack round-trip) so an
  alive-but-unresponsive instance fails its row in seconds, not hours. The
  nat-sim rows manage their own deadlines inside `nat-sim/run.mjs` and always
  tear the container stack down.
- A row may report **SKIP**, meaning it could not run on this machine (no docker
  daemon, no relay to point at). SKIP does not fail the run: conflating "could
  not run here" with "regressed" is how a red stops meaning anything.
- Remote sweep runs even on abort. Never combine a `pkill` pattern and its
  target paths in one ssh command line — it regex-matches its own shell.

## Provisioning

- **geekom / pi**: tar `listam-headless` + `listam-packages/{package.json,
  package-lock.json,packages}` (workspace root required for the `file:` deps),
  stream over ssh stdin, `npm ci --omit=dev` in both trees against
  `~/node22/bin/node` (Node 22.17.1). Pi SSH is Tailscale SSH (check mode —
  needs the user's browser click when the ~12h window lapses).
- **esp32**: build-time config in `listam-hardware/leaf-peer/leaf-esp32/cfg.toml`
  (gitignored; `cfg.toml.bak` holds the previous provisioning): WiFi networks,
  `hub_addr` (comma-separated fallbacks), `control_key` = the persistent hub's
  key (read it from the hub's `status` op → `leafBridge.controlKey`). Then
  `source ~/export-esp.sh && cargo build --release` and
  `espflash flash --flash-size 16mb --partition-table partitions.csv
  target/xtensa-esp32s3-espidf/release/leaf-esp32`. Erase flash first when
  switching control keys so stale mirrored cores don't linger.
  The matrix row fails fast with "reflash the board" if hub and firmware keys
  diverge.

## Known constraints

- **geekom as host fails**: the VM runs ufw with INPUT policy DROP — outbound
  (guest) connections ride conntrack, inbound pairing punches are dropped.
  Open inbound UDP (user decision) or keep the VM guest-only.
- The Mac runs the user's personal headless instance — test instances always
  use `listam-xdev-` prefixed temp dirs; never pkill broadly, never touch the
  personal storage. The esp32 hub is its own dedicated persistent storage
  (`~/listam-leaf-hub`), not the personal instance.
- SIGKILLed instances can't restart on the same storage within the ~30s
  storage-lease TTL.
- Wedge regression guard: `node listam-tools/cross-device/wedge-repro.mjs` (and CI:
  `listam-headless/test/wedge.test.mjs`).

## Runbook

```bash
# full matrix: 6 unordered pair rows + 4-way mesh + esp32 leaf row, 15-min cap
node listam-tools/cross-device/matrix.mjs \
  --devices mac-headless,geekom,pi,mac-desktop \
  --net mainnet --unordered --time-budget 15 --esp32

# single pairing re-check (e.g. after a firewall change)
node listam-tools/cross-device/matrix.mjs --devices geekom,pi --net mainnet

# esp32 row only
node listam-tools/cross-device/matrix.mjs --devices mac-headless --esp32
```

Progress streams to stdout (`# …` step lines, `row …` results); the JSON
report (`--report`, default `/tmp/listam-xdev-report.json`) is written
incrementally after every row.
