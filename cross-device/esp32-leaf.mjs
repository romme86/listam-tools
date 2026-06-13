// ESP32-S3 leaf-mirror row support for the cross-device matrix.
//
// The board (listam-hardware/leaf-peer/leaf-esp32) is NOT a participant: it is a
// blind, dial-only mirror replica. It joins a known WiFi network, dials the
// hub baked into its cfg.toml, and mirrors every announced core to its FAT
// partition without holding the encryption key. So it gets its own row type
// instead of pair rows: launch the PERSISTENT hub (whose control key is the
// one flashed into the firmware), append items, and assert — via the board's
// own USB-CDC serial log — that its mirrored cores grow to fully contiguous.
//
// Serial is read by wrapping `espflash monitor --non-interactive`: the
// board's console is USB-Serial-JTAG, which emits nothing to a plain reader
// (no DTR/RTS handling), so reading the device node directly yields silence.
// espflash also resets the board on attach — every watcher session starts
// from a deterministic boot. A stale monitor holding the port makes the new
// one silently useless, so any previous monitor on this port is killed
// first. The firmware prints `persisted core …` at boot and
// `status core=<8hex> length=<n> contiguous=<n>` after each hub session,
// which bounds the timing resolution of mirror-lag measurements.
// (Do NOT wrap in `script` for a PTY: macOS `script` needs a TTY stdin and
// dies with "tcgetattr: Operation not supported on socket" under pipes.)
import { appendFileSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline'

export function readFirmwareCfg(cfgPath) {
    const text = readFileSync(cfgPath, 'utf8')
    const controlKey = /^control_key\s*=\s*"([0-9a-f]{64})"/m.exec(text)?.[1] ?? null
    const hubAddr = /^hub_addr\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null
    return { controlKey, hubAddr }
}

export function openSerialWatcher(path, { logPath = '/tmp/listam-xdev-esp32-serial.log' } = {}) {
    const espflash = process.env.LISTAM_XDEV_ESPFLASH ?? join(homedir(), '.cargo', 'bin', 'espflash')
    // `script` allocates a PTY: espflash monitor goes silent when the parent
    // has no controlling terminal (detached matrix runs), and the PTY also
    // makes its output unbuffered.
    spawnSync('pkill', ['-f', `espflash monitor --port ${path}`])
    const proc = spawn(espflash, ['monitor', '--port', path, '--non-interactive'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = []
    const cores = new Map()
    const blocksStored = new Map() // core 8-hex -> count of "block N stored" events
    const checksumErrors = []
    const waiters = new Set()
    let error = null

    const fail = (err) => {
        error = err
        for (const waiter of waiters) {
            waiter.reject(new Error(`serial ${path}: ${err.message}`))
            waiters.delete(waiter)
        }
    }
    proc.on('error', fail)
    proc.on('exit', (code) => {
        if (error) return
        fail(new Error(`espflash monitor exited early (code ${code})`))
    })
    readline.createInterface({ input: proc.stdout }).on('line', (raw) => {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
        lines.push(line)
        if (lines.length > 800) lines.shift()
        if (logPath) {
            try { appendFileSync(logPath, line + '\n') } catch {}
        }
        // `status core=` prints after each hub session ends; `persisted core`
        // prints once at boot from reloaded flash state. Same shape, same map.
        const status = /(?:status|persisted) core=?\s?([0-9a-f]{8}) length=(\d+) contiguous=(\d+)/.exec(line)
        if (status) {
            cores.set(status[1], { length: Number(status[2]), contiguous: Number(status[3]), at: Date.now() })
        }
        // The firmware only prints `status core=` lines when a hub session
        // closes, so a successful in-session download is invisible to status
        // polling. `block N stored` fires per verified block as it lands — the
        // direct, live proof of mirroring. `[<core>] block N stored`.
        const stored = /\[([0-9a-f]{8})\] block (\d+) stored/.exec(line)
        if (stored) {
            const set = blocksStored.get(stored[1]) ?? new Set()
            set.add(Number(stored[2]))
            blocksStored.set(stored[1], set)
        }
        if (/Invalid checksum/.test(line)) checksumErrors.push(line)
        for (const waiter of waiters) {
            if (waiter.regex.test(line)) {
                waiter.resolve(line)
                waiters.delete(waiter)
            }
        }
    })

    return {
        cores,
        blocksStored,
        get lines() { return lines },
        get error() { return error },
        get checksumErrors() { return checksumErrors },
        totalBlocksStored() {
            let total = 0
            for (const set of blocksStored.values()) total += set.size
            return total
        },
        coresWithBlocks() {
            let n = 0
            for (const set of blocksStored.values()) if (set.size > 0) n++
            return n
        },
        totalContiguous() {
            let total = 0
            for (const core of cores.values()) total += core.contiguous
            return total
        },
        allCaughtUp() {
            if (cores.size === 0) return false
            for (const core of cores.values()) if (core.contiguous < core.length) return false
            return true
        },
        waitForLine(regex, timeoutMs, label = String(regex)) {
            if (error) return Promise.reject(new Error(`serial ${path}: ${error.message}`))
            return new Promise((resolve, reject) => {
                for (const line of lines) {
                    if (regex.test(line)) return resolve(line)
                }
                const waiter = { regex, resolve, reject }
                waiters.add(waiter)
                const timer = setTimeout(() => {
                    waiters.delete(waiter)
                    reject(new Error(`serial: no line matching ${label} within ${timeoutMs}ms; last lines:\n${lines.slice(-12).join('\n')}`))
                }, timeoutMs)
                timer.unref?.()
            })
        },
        async waitFor(predicate, { timeoutMs = 120_000, intervalMs = 1000, label = 'condition' } = {}) {
            const deadline = Date.now() + timeoutMs
            for (;;) {
                if (error) throw new Error(`serial ${path}: ${error.message}`)
                if (predicate(this)) return
                if (Date.now() > deadline) {
                    throw new Error(`serial: ${label} not met within ${timeoutMs}ms; cores=${JSON.stringify([...cores.entries()])}; last lines:\n${lines.slice(-12).join('\n')}`)
                }
                await new Promise((resolve) => setTimeout(resolve, intervalMs))
            }
        },
        close() {
            proc.removeAllListeners('exit')
            proc.kill('SIGKILL')
        },
    }
}
