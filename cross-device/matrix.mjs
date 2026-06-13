// Cross-DEVICE acceptance matrix: the Phase 15 cross-instance rows, but with
// every instance on a real machine instead of a private single-host testnet.
// Each ordered device pairing gets fresh storage roots, a real BlindPairing
// invite/join, and timed convergence checks (join, initial sync, both
// steady-state directions, done-flag and delete propagation), then a final
// all-device mesh row. Timings are wall-clock with a 250ms dump poll, so
// they carry up to +250ms quantization plus SSH round-trip for remote dumps.
//
//   node listam-tools/cross-device/matrix.mjs                 # mainnet DHT (production path)
//   node listam-tools/cross-device/matrix.mjs --net lan       # private DHT bound to this Mac's LAN IP
//   node listam-tools/cross-device/matrix.mjs --devices mac-headless,mac-desktop,geekom,pi
//
// Caveat (observed 2026-06-11): --net lan colocates every testnet DHT node
// with one endpoint machine. Same-machine pairings pass, but cross-machine
// pairings never complete the BlindPairing connect (DHT bootstrap reachable,
// holepunch unresolved) — use mainnet for cross-machine rows until the
// bootstrap runs on a machine that hosts no instances.
//
// Remote targets are headless-only (the desktop surface needs a display).
// Device specifics (SSH hosts, key paths, the board's serial port) are NOT
// hardcoded — they come from a gitignored `devices.local.json` (copy
// `devices.example.json`), overridable per-field by LISTAM_XDEV_* env vars,
// so no one's hostnames/IPs/usernames live in the public repo.
import { homedir, networkInterfaces } from 'node:os'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import {
    launchLocalHeadless,
    launchLocalDesktop,
    launchRemoteHeadless,
    launchLeafHub,
    remoteOneShot,
    REPO_ROOT,
} from './driver.mjs'
import { openSerialWatcher, readFirmwareCfg } from './esp32-leaf.mjs'

process.on('uncaughtException', (error) => {
    if (/connection reset by peer/i.test(error?.message ?? '')) return
    console.error(error)
    process.exit(1)
})

function parseArgs(argv) {
    const args = { _: [] }
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]
        if (token.startsWith('--')) {
            const key = token.slice(2)
            const next = argv[i + 1]
            if (next !== undefined && !next.startsWith('--')) {
                args[key] = next
                i++
            } else {
                args[key] = true
            }
        } else {
            args._.push(token)
        }
    }
    return args
}

const args = parseArgs(process.argv.slice(2))
const NET = args.net ?? 'mainnet'
const REPORT_PATH = args.report ?? '/tmp/listam-xdev-report.json'
const UNORDERED = args.unordered === true
const BUDGET_MS = Number(args['time-budget'] ?? 15) * 60_000
// Local device config — gitignored real values (copy devices.example.json),
// with env-var overrides and non-sensitive fallbacks so the harness still
// parses without it. Keeps hostnames/IPs/usernames/serial out of the repo.
const HERE = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = process.env.LISTAM_XDEV_CONFIG ?? join(HERE, 'devices.local.json')
const fileCfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
const cfgFor = (name) => fileCfg[name] ?? {}

const ESP32 = args.esp32 === true || typeof args.esp32 === 'string'
const ESP32_SERIAL = typeof args.esp32 === 'string'
    ? args.esp32
    : (process.env.LISTAM_XDEV_ESP32_SERIAL ?? cfgFor('esp32').serial ?? '/dev/cu.usbmodemXXXX')
const ESP32_HUB_STORAGE = process.env.LISTAM_XDEV_LEAF_HUB ?? cfgFor('esp32').hubStorage ?? join(homedir(), 'listam-leaf-hub')
const ESP32_CFG = join(REPO_ROOT, 'listam-hardware', 'leaf-peer', 'leaf-esp32', 'cfg.toml')
const now = () => Date.now()
const startedAtMs = now()
const remainingMs = () => BUDGET_MS - (now() - startedAtMs)

const expandHome = (p) => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

function remote(name, env) {
    const c = cfgFor(name)
    return {
        name,
        target: process.env[`LISTAM_XDEV_${env}_TARGET`] ?? c.target ?? `user@${name}.example`,
        key: expandHome(process.env[`LISTAM_XDEV_${env}_KEY`] ?? c.key ?? join(homedir(), '.ssh', 'id_ed25519')),
        node: process.env[`LISTAM_XDEV_${env}_NODE`] ?? c.node ?? '$HOME/node22/bin/node',
        entry: process.env[`LISTAM_XDEV_${env}_ENTRY`] ?? c.entry ?? '$HOME/listam/listam-headless/headless.mjs',
    }
}

const REMOTES = {
    geekom: remote('geekom', 'GEEKOM'),
    pi: remote('pi', 'PI'),
}

const DEVICES = {
    'mac-headless': (label, bootstrap) => launchLocalHeadless({ label, bootstrap }),
    'mac-desktop': (label, bootstrap) => launchLocalDesktop({ label, bootstrap }),
    geekom: (label, bootstrap) => launchRemoteHeadless({ label, remote: REMOTES.geekom, bootstrap }),
    pi: (label, bootstrap) => launchRemoteHeadless({ label, remote: REMOTES.pi, bootstrap }),
}

const deviceNames = String(args.devices ?? 'mac-headless,mac-desktop,geekom')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
for (const name of deviceNames) {
    if (!DEVICES[name]) {
        console.error(`unknown device '${name}' (known: ${Object.keys(DEVICES).join(', ')})`)
        process.exit(1)
    }
}

function lanAddress() {
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal && /^(192\.168|10\.|172\.)/.test(entry.address)) {
                return entry.address
            }
        }
    }
    throw new Error('no LAN IPv4 address found for --net lan')
}

// --net lan runs a private DHT on this Mac, reachable from the LAN, so the
// row timings measure pure replication without public-DHT discovery noise.
let testnet = null
let bootstrap = null
if (NET === 'lan') {
    const requireHeadless = createRequire(join(REPO_ROOT, 'listam-headless', 'package.json'))
    const createTestnet = requireHeadless('hyperdht/testnet.js')
    const host = args.host ?? lanAddress()
    testnet = await createTestnet(3, { host })
    bootstrap = {
        string: testnet.bootstrap.map(({ host: h, port }) => `${h}:${port}`).join(','),
        json: testnet.bootstrap,
    }
    console.log(`# private LAN DHT bootstrap: ${bootstrap.string}`)
} else {
    console.log('# bootstrap: public mainnet DHT (production discovery path)')
}

const report = {
    startedAt: new Date().toISOString(),
    net: NET,
    bootstrap: bootstrap?.string ?? 'mainnet',
    devices: deviceNames,
    rows: [],
}
let rowCounter = 0
const progress = (message) => console.log(`# ${new Date().toISOString().slice(11, 19)} ${message}`)
const writeReport = () => writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))

async function launch(device, role) {
    const label = `r${rowCounter}-${device}-${role}`
    const instance = await DEVICES[device](label, bootstrap)
    return instance
}

async function stopAll(instances) {
    for (const instance of instances) {
        try {
            await instance.stop()
        } catch {}
        try {
            await instance.cleanup()
        } catch {}
    }
}

// Time-boxes one row's scenario body. On timeout the body promise is
// abandoned (its instances are torn down by the caller's finally), so its
// eventual rejection must be swallowed to keep teardown quiet.
async function raceRow(bodyPromise, ms, label) {
    let timer
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`row '${label}' exceeded its ${Math.round(ms / 1000)}s time-box`)), ms)
    })
    try {
        return await Promise.race([bodyPromise, deadline])
    } finally {
        clearTimeout(timer)
        bodyPromise.catch(() => {})
    }
}

// A wedged instance ignores stdin-EOF shutdown (the bug this harness
// documents), so killing the local ssh pipe is not enough — sweep the
// remotes by pattern. Two separate ssh calls per remote because a command
// that both pkills and names /tmp/listam-xdev-* paths would regex-match its
// own command line and kill the cleanup shell itself (learned the hard way).
async function cleanupRemotes() {
    for (const name of deviceNames) {
        const remote = REMOTES[name]
        if (!remote) continue
        await remoteOneShot(remote, 'pkill -f "[l]istam-xdev"; true', { timeoutMs: 15_000 }).catch(() => {})
        await remoteOneShot(remote, 'rm -rf /tmp/listam-xdev-*', { timeoutMs: 15_000 }).catch(() => {})
    }
}

function itemByText(dump, text) {
    return (dump.items ?? []).find((item) => item.text === text)
}

// One ordered pairing: host invites, guest joins, then every convergence
// direction is timed. Tags make every text unique per row so a stray
// cross-row join could never satisfy a predicate by accident.
async function pairRow(hostDevice, guestDevice) {
    rowCounter++
    const row = {
        row: `${hostDevice} → ${guestDevice}`,
        host: hostDevice,
        guest: guestDevice,
        result: 'PASS',
    }
    const tag = `r${rowCounter}`
    let instances = []
    try {
        await raceRow((async () => {
        const t0 = now()
        const [host, guest] = await Promise.all([
            launch(hostDevice, 'host').then((instance) => { instances.push(instance); return instance }),
            launch(guestDevice, 'guest').then((instance) => { instances.push(instance); return instance }),
        ])
        row.launch_ms = now() - t0
        progress(`${row.row} :: launched (${row.launch_ms}ms)`)

        await host.add(`Milk-${tag}`)
        await host.add(`Bread-${tag}`)
        await host.waitFor((dump) => (dump.items?.length ?? 0) >= 2, { timeoutMs: 30_000 })

        let t = now()
        const invite = await host.invite()
        row.invite_ms = now() - t

        t = now()
        await guest.join(invite)
        await guest.waitFor((dump) => dump.joined, { timeoutMs: 90_000 })
        row.join_ms = now() - t
        progress(`${row.row} :: joined (${row.join_ms}ms)`)

        t = now()
        const guestSynced = await guest.waitFor(
            (dump) => itemByText(dump, `Milk-${tag}`) && itemByText(dump, `Bread-${tag}`),
            { timeoutMs: 60_000 },
        )
        row.initial_sync_ms = now() - t
        progress(`${row.row} :: initial sync (${row.initial_sync_ms}ms)`)

        const hostSeed = await host.dump()
        for (const text of [`Milk-${tag}`, `Bread-${tag}`]) {
            if (itemByText(guestSynced, text).id !== itemByText(hostSeed, text).id) {
                throw new Error(`item '${text}' id diverged between host and guest (M1)`)
            }
        }

        // Steady-state: guest → host (the direction that needs main-swarm
        // reconnection, the environment-sensitive path called out in the
        // local matrix).
        t = now()
        await guest.add(`Eggs-${tag}`)
        await host.waitFor((dump) => itemByText(dump, `Eggs-${tag}`), { timeoutMs: 90_000 })
        row.guest_to_host_ms = now() - t
        progress(`${row.row} :: guest→host (${row.guest_to_host_ms}ms)`)

        // Steady-state: host → guest.
        t = now()
        await host.add(`Coffee-${tag}`)
        await guest.waitFor((dump) => itemByText(dump, `Coffee-${tag}`), { timeoutMs: 90_000 })
        row.host_to_guest_ms = now() - t
        progress(`${row.row} :: host→guest (${row.host_to_guest_ms}ms)`)

        // Done-flag propagation (update path, not append-only add).
        t = now()
        const guestEggs = itemByText(await guest.dump(), `Eggs-${tag}`)
        await guest.markDone(guestEggs)
        await host.waitFor(
            (dump) => (dump.items ?? []).some((item) => item.id === guestEggs.id && item.isDone),
            { timeoutMs: 60_000 },
        )
        row.done_flag_ms = now() - t
        progress(`${row.row} :: done-flag (${row.done_flag_ms}ms)`)

        // Delete propagation.
        t = now()
        const hostBread = itemByText(await host.dump(), `Bread-${tag}`)
        await host.remove(hostBread)
        await guest.waitFor(
            (dump) => !(dump.items ?? []).some((item) => item.id === hostBread.id),
            { timeoutMs: 60_000 },
        )
        row.delete_ms = now() - t

        const hostFinal = await host.dump()
        const guestFinal = await guest.dump()
        row.final_items = { host: hostFinal.items?.length ?? 0, guest: guestFinal.items?.length ?? 0 }
        row.peer_count = { host: hostFinal.peerCount ?? null, guest: guestFinal.peerCount ?? null }
        })(), 300_000, row.row)
    } catch (error) {
        row.result = 'FAIL'
        row.error = String(error?.message ?? error).slice(0, 1500)
    } finally {
        await stopAll(instances)
    }
    report.rows.push(row)
    writeReport()
    const status = row.result === 'PASS' ? 'PASS' : `FAIL (${row.error?.split('\n')[0]})`
    console.log(`row ${row.row}: ${status}`)
    return row
}

// All devices in one base: first device hosts, the rest join one by one,
// everyone writes one item, everyone must converge on the full set by id.
async function meshRow(devices) {
    rowCounter++
    const row = { row: `mesh: ${devices.join(' + ')}`, result: 'PASS', joins: {} }
    const tag = `r${rowCounter}`
    let instances = []
    try {
        await raceRow((async () => {
        const launched = await Promise.all(devices.map((device) =>
            launch(device, 'mesh').then((instance) => { instances.push(instance); return instance })))
        const [alpha, ...rest] = launched
        progress(`${row.row} :: all launched`)

        await alpha.add(`From-${alpha.label}`)
        for (const member of rest) {
            const invite = await alpha.invite()
            const t = now()
            await member.join(invite)
            await member.waitFor((dump) => dump.joined, { timeoutMs: 90_000 })
            row.joins[member.label] = now() - t
            progress(`${row.row} :: ${member.label} joined (${row.joins[member.label]}ms)`)
            await member.add(`From-${member.label}`)
        }

        const expected = instances.map((instance) => `From-${instance.label}`)
        const t = now()
        for (const member of instances) {
            await member.waitFor(
                (dump) => expected.every((text) => itemByText(dump, text)),
                { timeoutMs: 120_000 },
            )
        }
        row.full_convergence_ms = now() - t

        // Every member must agree on every item's id (M1 across the mesh).
        const dumps = await Promise.all(instances.map((instance) => instance.dump()))
        for (const text of expected) {
            const ids = new Set(dumps.map((dump) => itemByText(dump, text)?.id))
            if (ids.size !== 1) throw new Error(`mesh id divergence for '${text}': ${[...ids].join(', ')}`)
        }
        row.items_total = expected.length
        })(), 360_000, row.row)
    } catch (error) {
        row.result = 'FAIL'
        row.error = String(error?.message ?? error).slice(0, 1500)
    } finally {
        await stopAll(instances)
    }
    report.rows.push(row)
    writeReport()
    console.log(`row ${row.row}: ${row.result === 'PASS' ? 'PASS' : `FAIL (${row.error?.split('\n')[0]})`}`)
    return row
}

// The ESP32 leaf row: the board is a blind dial-only mirror, so instead of a
// pairing we launch the persistent hub it was provisioned against, append
// items, and require the board's own serial log to show every announced core
// fully mirrored (contiguous == length) with growth past the pre-add state.
async function esp32LeafRow() {
    rowCounter++
    const row = { row: 'esp32-leaf mirror', result: 'PASS' }
    const tag = `r${rowCounter}`
    let serial = null
    let hub = null
    try {
        await raceRow((async () => {
            const cfg = readFirmwareCfg(ESP32_CFG)
            serial = openSerialWatcher(ESP32_SERIAL)
            hub = await launchLeafHub({ label: `${tag}-leaf-hub`, storageDir: ESP32_HUB_STORAGE })
            const status = await hub.status()
            row.control_key = status.leafBridge?.controlKey?.slice(0, 16)
            if (!status.leafBridge?.controlKey) throw new Error('hub has no leaf bridge (LISTAM_LEAF_BRIDGE_PORT not honored?)')
            if (cfg.controlKey && status.leafBridge.controlKey !== cfg.controlKey) {
                throw new Error(`control-key mismatch: hub ${status.leafBridge.controlKey.slice(0, 12)}… vs firmware cfg ${cfg.controlKey.slice(0, 12)}… — reflash the board against this hub`)
            }

            // First contact: the watcher's attach reset the board, so this
            // covers full boot + WiFi join + TCP dial to the hub.
            let t = now()
            await serial.waitForLine(/connected to \d+\.\d+\.\d+\.\d+:\d+/, 120_000, 'board "connected to <hub>" line')
            row.first_contact_ms = now() - t
            progress(`${row.row} :: board connected to hub (${row.first_contact_ms}ms)`)

            // Assert on live `block N stored` events — the direct proof of
            // mirroring as each verified block lands. (The firmware's
            // `status core=` lines only print on session close, so they miss
            // an in-session download entirely.) Append a few items to grow the
            // hub's cores, then require the board to verify-and-store blocks
            // across at least two distinct cores (control + at least one
            // autobase core).
            t = now()
            for (let i = 1; i <= 3; i++) await hub.add(`Esp32-${tag}-${i}`)
            await serial.waitFor(
                (watcher) => watcher.totalBlocksStored() >= 3 && watcher.coresWithBlocks() >= 2,
                { timeoutMs: 90_000, label: '≥3 verified blocks stored across ≥2 cores (live block-stored events)' },
            )
            row.mirror_lag_ms = now() - t
            row.cores = serial.cores.size
            row.blocks_mirrored = serial.totalBlocksStored()
            row.cores_with_blocks = serial.coresWithBlocks()
            // Surface the persisted-FAT-state corruption (Phase 2) without
            // failing the row — mirroring itself is proven by the assertion
            // above; reload-durability is tracked separately.
            if (serial.checksumErrors.length > 0) {
                row.warning = `${serial.checksumErrors.length} "Invalid checksum" events (persisted-FAT reload corruption — Phase 2)`
            }
        })(), 360_000, row.row)
    } catch (error) {
        row.result = 'FAIL'
        row.error = String(error?.message ?? error).slice(0, 1500)
    } finally {
        try { serial?.close() } catch {}
        if (hub) {
            try { await hub.stop() } catch {}
        }
    }
    report.rows.push(row)
    writeReport()
    console.log(`row ${row.row}: ${row.result === 'PASS' ? 'PASS' : `FAIL (${row.error?.split('\n')[0]})`}`)
    return row
}

// Pre-clean stale storage from earlier aborted runs on the remotes in play.
for (const name of deviceNames) {
    if (REMOTES[name]) {
        await remoteOneShot(REMOTES[name], 'rm -rf /tmp/listam-xdev-* 2>/dev/null; true', { timeoutMs: 20_000 })
    }
}

// Hard stop at the budget no matter what is in flight: persist what we have,
// sweep the remotes, exit nonzero. unref'd so it never holds the process open.
const watchdog = setTimeout(async () => {
    progress(`time budget (${Math.round(BUDGET_MS / 60_000)} min) exhausted — aborting run`)
    report.aborted = 'time-budget'
    writeReport()
    await cleanupRemotes()
    process.exit(2)
}, BUDGET_MS)
watchdog.unref()

console.log(`# devices: ${deviceNames.join(', ')} | net: ${NET} | pairs: ${UNORDERED ? 'unordered' : 'ordered'} | budget: ${Math.round(BUDGET_MS / 60_000)} min`)
pairs: for (let i = 0; i < deviceNames.length; i++) {
    for (let j = 0; j < deviceNames.length; j++) {
        if (i === j) continue
        if (UNORDERED && j < i) continue
        if (remainingMs() < 120_000) {
            progress('time budget low — skipping remaining pair rows')
            report.skipped = 'pair rows skipped on low budget'
            break pairs
        }
        await pairRow(deviceNames[i], deviceNames[j])
    }
}
if (deviceNames.length >= 3 && remainingMs() > 150_000) {
    await meshRow(deviceNames)
} else if (deviceNames.length >= 3) {
    progress('time budget low — skipping mesh row')
    report.skipped = (report.skipped ? report.skipped + '; ' : '') + 'mesh skipped on low budget'
}
if (ESP32 && remainingMs() > 120_000) {
    await esp32LeafRow()
} else if (ESP32) {
    progress('time budget low — skipping esp32-leaf row')
    report.skipped = (report.skipped ? report.skipped + '; ' : '') + 'esp32-leaf skipped on low budget'
}

await cleanupRemotes()
report.finishedAt = new Date().toISOString()
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))

const failed = report.rows.filter((row) => row.result !== 'PASS')
console.log('')
console.table(report.rows.map((row) => ({
    row: row.row,
    result: row.result,
    join_ms: row.join_ms ?? row.full_convergence_ms ?? row.first_contact_ms ?? null,
    initial_sync_ms: row.initial_sync_ms ?? null,
    'guest→host_ms': row.guest_to_host_ms ?? null,
    'host→guest_ms': row.host_to_guest_ms ?? row.mirror_lag_ms ?? null,
    done_ms: row.done_flag_ms ?? null,
    delete_ms: row.delete_ms ?? null,
})))
console.log(`report: ${REPORT_PATH}`)

if (testnet) await testnet.destroy()
process.exit(failed.length === 0 ? 0 : 1)
