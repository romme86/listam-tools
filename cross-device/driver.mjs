// Cross-device instance drivers (Phase 15 extension): spawn a Listam backend
// — the headless service or the desktop backend-driver — locally or on a
// remote machine over SSH, and drive the shared JSON-line stdin/stdout
// protocol through a uniform op surface so matrix rows can mix surfaces and
// machines freely. SSH is the transport for remote stdio; headless shuts
// down on stdin EOF, so a dropped SSH session can never leave an orphan.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import process from 'node:process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const HEADLESS_ENTRY = join(ROOT, 'listam-headless', 'headless.mjs')
export const DESKTOP_DRIVER = join(ROOT, 'listam-desktop', 'test', 'helpers', 'backend-driver.mjs')
export const REPO_ROOT = ROOT

export function lineService(proc, label) {
    const pending = new Map()
    let nextId = 0
    let resolveReady
    const readyPromise = new Promise((resolve) => { resolveReady = resolve })
    let stderr = ''
    let exited = false
    let exitCode = null

    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('exit', (code) => { exited = true; exitCode = code })
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let message = null
        try {
            message = JSON.parse(line)
        } catch {
            return
        }
        if (message.event === 'ready') resolveReady(message)
        if (message.id != null && pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })

    return {
        proc,
        label,
        get stderr() { return stderr },
        get exited() { return exited },
        get exitCode() { return exitCode },
        async ready(timeoutMs = 60_000) {
            const result = await Promise.race([
                readyPromise,
                once(proc, 'exit').then(() => null),
                new Promise((resolve) => setTimeout(resolve, timeoutMs, 'timeout')),
            ])
            if (result === 'timeout') {
                proc.kill('SIGKILL')
                throw new Error(`[${label}] not ready after ${timeoutMs}ms\nstderr tail: ${stderr.slice(-2000)}`)
            }
            if (!result) {
                throw new Error(`[${label}] exited before ready (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`)
            }
            return result
        },
        request(op, fields = {}, { timeoutMs = 30_000 } = {}) {
            if (exited) {
                return Promise.reject(new Error(`[${label}] already exited (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`))
            }
            const id = ++nextId
            const response = new Promise((resolve) => pending.set(id, resolve))
            proc.stdin.write(JSON.stringify({ ...fields, id, op }) + '\n')
            const exitWatch = new AbortController()
            const exitRejection = once(proc, 'exit', { signal: exitWatch.signal }).then(() => {
                throw new Error(`[${label}] exited mid-request '${op}' (code ${exitCode})\nstderr tail: ${stderr.slice(-2000)}`)
            })
            exitRejection.catch(() => {})
            // An instance that is alive but never answers (the wedge this
            // harness exists to catch) must fail the row, not hang it.
            let timer
            const deadline = new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`[${label}] request '${op}' timed out after ${timeoutMs}ms (instance alive but unresponsive)\nstderr tail: ${stderr.slice(-2000)}`))
                }, timeoutMs)
                timer.unref?.()
                response.then((value) => { clearTimeout(timer); resolve(value) })
            })
            return Promise.race([deadline, exitRejection]).finally(() => {
                clearTimeout(timer)
                exitWatch.abort()
                pending.delete(id)
            })
        },
        async waitFor(predicate, { timeoutMs = 180_000, intervalMs = 250 } = {}) {
            const deadline = Date.now() + timeoutMs
            for (;;) {
                const snapshot = await this.request('dump')
                if (predicate(snapshot)) return snapshot
                if (Date.now() > deadline) {
                    throw new Error(`[${label}] waitFor timed out after ${timeoutMs}ms; last: ${JSON.stringify(snapshot).slice(0, 600)}\nstderr tail: ${stderr.slice(-2000)}`)
                }
                await new Promise((resolve) => setTimeout(resolve, intervalMs))
            }
        },
        async stop() {
            if (exited) return
            try {
                const done = once(proc, 'exit')
                const timeout = new Promise((resolve) => setTimeout(resolve, 10_000, 'timeout'))
                proc.stdin.write(JSON.stringify({ id: ++nextId, op: 'shutdown' }) + '\n')
                if (await Promise.race([done, timeout]) === 'timeout') {
                    proc.kill('SIGKILL')
                }
            } catch {
                proc.kill('SIGKILL')
            }
        },
    }
}

async function oneShot(command, args, { timeoutMs = 60_000 } = {}) {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    const killer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    const [code] = await once(proc, 'exit')
    clearTimeout(killer)
    return { code, stdout, stderr }
}

function sshArgs(remote) {
    return [
        '-i', remote.key,
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15',
        remote.target,
    ]
}

// The uniform instance contract every launcher returns. `item` arguments are
// items as they appear in that instance's own dump (full objects), so the
// desktop update path can resend the whole item the way the GUI would.
function instanceSurface({ label, surface, where, service, cleanup }) {
    const desktop = surface === 'desktop'
    return {
        label,
        surface,
        where,
        service,
        async invite() {
            const reply = await service.request('invite')
            if (!reply.inviteKey) throw new Error(`[${label}] invite produced no key: ${JSON.stringify(reply)}`)
            return reply.inviteKey
        },
        join(invite) {
            // The fixed join op answers only after the pairing acknowledgment
            // round-trip, which crosses devices here — give it its own budget
            // so we measure real pairing latency instead of capping it at the
            // generic 30s request deadline.
            return service.request('join', { invite }, { timeoutMs: 120_000 })
        },
        add(text) {
            return service.request('add', { text })
        },
        markDone(item) {
            return desktop
                ? service.request('update', { item: { ...item, isDone: true, timeOfCompletion: 1, updatedAt: Date.now() } })
                : service.request('done', { itemId: item.id })
        },
        rename(item, text) {
            return desktop
                ? service.request('update', { item: { ...item, text, updatedAt: Date.now() } })
                : service.request('edit', { itemId: item.id, text })
        },
        remove(item) {
            return desktop
                ? service.request('delete', { item })
                : service.request('delete', { itemId: item.id })
        },
        dump() {
            return service.request('dump')
        },
        waitFor(predicate, opts) {
            return service.waitFor(predicate, opts)
        },
        stop() {
            return service.stop()
        },
        cleanup,
    }
}

export async function launchLocalHeadless({ label, bootstrap = null }) {
    const dir = mkdtempSync(join(tmpdir(), `listam-xdev-${label}-`))
    const setup = await oneShot(process.execPath, [HEADLESS_ENTRY, 'setup', '--storage', dir, '--role', 'participant'])
    if (setup.code !== 0) throw new Error(`[${label}] local setup failed: ${setup.stdout} ${setup.stderr}`)
    const args = [HEADLESS_ENTRY, 'run', '--storage', dir]
    if (bootstrap) args.push('--bootstrap', bootstrap.string)
    const proc = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const service = lineService(proc, label)
    await service.ready()
    return instanceSurface({
        label,
        surface: 'headless',
        where: 'mac',
        service,
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
    })
}

export async function launchLocalDesktop({ label, bootstrap = null }) {
    const dir = mkdtempSync(join(tmpdir(), `listam-xdev-${label}-`))
    const args = [DESKTOP_DRIVER, dir]
    if (bootstrap) args.push(JSON.stringify(bootstrap.json))
    const proc = spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: join(ROOT, 'listam-desktop'),
    })
    const service = lineService(proc, label)
    await service.ready()
    return instanceSurface({
        label,
        surface: 'desktop',
        where: 'mac',
        service,
        cleanup: async () => rmSync(dir, { recursive: true, force: true }),
    })
}

export async function launchRemoteHeadless({ label, remote, bootstrap = null }) {
    const mkdir = `D=$(mktemp -d /tmp/listam-xdev-${label}-XXXXXX) && ${remote.node} ${remote.entry} setup --storage "$D" --role participant >/dev/null 2>&1 && echo "$D"`
    const setup = await oneShot('ssh', [...sshArgs(remote), mkdir])
    const dir = setup.stdout.trim().split('\n').at(-1)
    if (setup.code !== 0 || !dir?.startsWith('/tmp/listam-xdev-')) {
        throw new Error(`[${label}] remote setup on ${remote.name} failed (code ${setup.code}): ${setup.stdout} ${setup.stderr}`)
    }
    const runCmd = `${remote.node} ${remote.entry} run --storage "${dir}"`
        + (bootstrap ? ` --bootstrap ${bootstrap.string}` : '')
    const proc = spawn('ssh', [...sshArgs(remote), runCmd], { stdio: ['pipe', 'pipe', 'pipe'] })
    const service = lineService(proc, label)
    await service.ready()
    return instanceSurface({
        label,
        surface: 'headless',
        where: remote.name,
        service,
        cleanup: async () => {
            await oneShot('ssh', [...sshArgs(remote), `rm -rf "${dir}"`], { timeoutMs: 20_000 })
        },
    })
}

export async function remoteOneShot(remote, command, opts) {
    return oneShot('ssh', [...sshArgs(remote), command], opts)
}

// The ESP32 leaf's hub: a normal local participant with the TCP leaf bridge
// enabled, on PERSISTENT storage. Persistence is the point — the firmware
// bakes this hub's control core key in at build time (cfg.toml), so the hub
// identity must survive across matrix runs. Never rm this storage; cleanup
// is a no-op by design.
export async function launchLeafHub({ label, storageDir, port = 9993 }) {
    if (!existsSync(join(storageDir, 'headless-config.json'))) {
        const setup = await oneShot(process.execPath, [HEADLESS_ENTRY, 'setup', '--storage', storageDir, '--role', 'participant'])
        if (setup.code !== 0) throw new Error(`[${label}] leaf-hub setup failed: ${setup.stdout} ${setup.stderr}`)
    }
    // The persistent storage may briefly hold a stale lease (e.g. ~30s TTL
    // after a SIGKILLed previous hub) — retry once before giving up.
    let service = null
    for (let attempt = 1; ; attempt++) {
        const proc = spawn(process.execPath, [HEADLESS_ENTRY, 'run', '--storage', storageDir], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, LISTAM_LEAF_BRIDGE_PORT: String(port) },
        })
        service = lineService(proc, label)
        try {
            await service.ready()
            break
        } catch (error) {
            if (attempt < 2 && /storage lease/i.test(String(error?.message))) {
                await new Promise((resolve) => setTimeout(resolve, 35_000))
                continue
            }
            throw error
        }
    }
    const surface = instanceSurface({
        label,
        surface: 'headless',
        where: 'mac',
        service,
        cleanup: async () => {},
    })
    surface.status = () => service.request('status')
    return surface
}
