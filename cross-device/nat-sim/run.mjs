// Host-side driver for the NAT sim. Brings the compose stack up in the order
// the probes need, scrapes their JSON lines back out, and always tears down.
//
//   node listam-tools/cross-device/nat-sim/run.mjs            # no relay — expects the abort
//   node listam-tools/cross-device/nat-sim/run.mjs --relay    # with relay — expects a connection
//
// Also imported by matrix.mjs for the `nat-sim` and `nat-sim + relay` rows.
// Never returns a bare throw for "this machine cannot run it": a missing docker
// daemon or a missing relay.mjs comes back as `{ skipped, reason }` so the row
// reports SKIP instead of a red that means nothing. See README.md.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPOSE_FILE = join(HERE, 'docker-compose.yml')
const HEADLESS_RELAY = join(HERE, '..', '..', '..', 'listam-headless', 'src', 'relay.mjs')

const BUILD_TIMEOUT_MS = 600_000
const COMPOSE_TIMEOUT_MS = 120_000

function run(command, args, { timeoutMs = COMPOSE_TIMEOUT_MS, env = {} } = {}) {
    return new Promise((resolve) => {
        const proc = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        })
        let stdout = ''
        let stderr = ''
        proc.stdout.on('data', (chunk) => { stdout += chunk })
        proc.stderr.on('data', (chunk) => { stderr += chunk })
        const killer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
        // No docker BINARY at all (a CI box, the Pi) emits 'error' and never
        // 'exit'. Unhandled, that is a thrown ENOENT that takes the whole matrix
        // run down — the exact opposite of the SKIP contract this module owes
        // its callers, so turn it into an ordinary nonzero result.
        proc.on('error', (error) => {
            clearTimeout(killer)
            resolve({ code: -1, stdout, stderr: `${stderr}${error?.message ?? error}` })
        })
        once(proc, 'exit').then(([code]) => {
            clearTimeout(killer)
            resolve({ code, stdout, stderr })
        })
    })
}

// Compose prefixes every log line with the service name unless asked not to;
// strip it anyway so a compose version that ignores the flag still parses.
function jsonLines(text) {
    const out = []
    for (const raw of text.split('\n')) {
        const line = raw.replace(/^\S+\s*\|\s*/, '').trim()
        if (!line.startsWith('{')) continue
        try {
            out.push(JSON.parse(line))
        } catch {}
    }
    return out
}

function createStack({ relay, env }) {
    const base = ['compose', '-f', COMPOSE_FILE, ...(relay ? ['--profile', 'relay'] : [])]
    const compose = (args, opts) => run('docker', [...base, ...args], { env, ...opts })
    return {
        compose,
        async up(services, { build = false } = {}) {
            const result = await compose(['up', '-d', ...(build ? ['--build'] : []), ...services], {
                timeoutMs: build ? BUILD_TIMEOUT_MS : COMPOSE_TIMEOUT_MS,
            })
            if (result.code !== 0) {
                throw new Error(`docker compose up ${services.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(-800)}`)
            }
        },
        // Poll rather than stream: `logs --follow` would need its own lifetime
        // management for every service, and the probes are chatty in bursts.
        async waitForLine(service, predicate, { timeoutMs, label }) {
            const deadline = Date.now() + timeoutMs
            for (;;) {
                const result = await compose(['logs', '--no-color', '--no-log-prefix', service])
                for (const entry of jsonLines(result.stdout)) {
                    if (predicate(entry)) return entry
                }
                if (Date.now() > deadline) {
                    throw new Error(`${service}: ${label} never appeared within ${Math.round(timeoutMs / 1000)}s; last log: ${result.stdout.trim().slice(-600)}`)
                }
                await new Promise((resolve) => setTimeout(resolve, 1000))
            }
        },
        down() {
            return compose(['down', '-v', '--remove-orphans', '-t', '5'])
        },
    }
}

export async function runNatSim({ relay = false, connectTimeoutMs = 90_000, progress = () => {} } = {}) {
    const daemon = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30_000 })
    if (daemon.code !== 0) {
        return {
            skipped: true,
            reason: 'no reachable docker daemon — the NAT sim needs Linux network namespaces '
                + '(iptables MASQUERADE --random-fully), which on macOS means Docker Desktop\'s Linux VM must be running'
                + ` (docker info: ${daemon.stderr.trim().split('\n').at(-1)?.slice(0, 200) ?? 'no output'})`,
        }
    }
    if (relay && !existsSync(HEADLESS_RELAY)) {
        return {
            skipped: true,
            reason: 'listam-headless/src/relay.mjs does not exist yet — startRelay() is the fix under construction, '
                + 'so there is nothing to point relayThrough at',
        }
    }

    const env = {
        SIM_SEED: randomBytes(32).toString('hex'),
        SIM_CONNECT_TIMEOUT_MS: String(connectTimeoutMs),
        SIM_BOOTSTRAP: '',
        SIM_RELAY_PUBLIC_KEY: '',
    }
    const stack = createStack({ relay, env })
    const result = { skipped: false, relay, peers: {} }

    try {
        await stack.down()

        progress('building images and starting the private DHT')
        await stack.up(['bootstrap'], { build: true })
        const bootstrap = await stack.waitForLine('bootstrap', (e) => e.sim === 'bootstrap' && e.ready, {
            timeoutMs: 90_000,
            label: 'bootstrap ready line',
        })
        env.SIM_BOOTSTRAP = bootstrap.nodes.join(',')
        result.bootstrap_nodes = bootstrap.nodes.length

        if (relay) {
            progress('starting the relay under test')
            await stack.up(['relay'])
            const line = await stack.waitForLine('relay', (e) => e.sim === 'relay' && (e.ready || e.missing || e.error), {
                timeoutMs: 90_000,
                label: 'relay ready line',
            })
            if (line.missing) return { skipped: true, reason: `relay under test unusable: ${line.reason}` }
            if (line.error) throw new Error(line.error)
            if (!line.publicKey) throw new Error('startRelay() reported no public key — nothing to set relayThrough to')
            env.SIM_RELAY_PUBLIC_KEY = line.publicKey
            result.relay_public_key = line.publicKey.slice(0, 16)
        }

        progress('bringing up both carrier NATs')
        await stack.up(['gw-a', 'gw-b'])
        for (const gateway of ['gw-a', 'gw-b']) {
            const line = await stack.waitForLine(gateway, (e) => e.sim === 'gateway', {
                timeoutMs: 60_000,
                label: 'gateway ready line',
            })
            if (!line.ready) throw new Error(`${gateway}: ${line.error}`)
        }

        progress('peer-a: listening behind NAT a')
        await stack.up(['peer-a'])
        const server = await stack.waitForLine('peer-a', (e) => e.sim === 'probe' && (e.listening || e.error), {
            timeoutMs: 120_000,
            label: 'server listening line',
        })
        result.peers['peer-a'] = { randomized: server.randomized === true, host: server.host, port: server.port }

        progress('peer-b: dialling peer-a from behind NAT b')
        await stack.up(['peer-b'])
        const client = await stack.waitForLine('peer-b', (e) => e.sim === 'probe' && e.done, {
            timeoutMs: connectTimeoutMs + 120_000,
            label: 'client verdict line',
        })
        result.peers['peer-b'] = { randomized: client.randomized === true, host: client.host, port: client.port }
        result.connect = {
            connected: client.connected === true,
            error: client.error ?? null,
            ms: client.connect_ms ?? null,
            remote: client.remote ?? null,
        }
    } finally {
        await stack.down()
    }

    return result
}

// The abort codes that mean "hyperdht gave up because both ends are randomized"
// — i.e. the sim reproduced the field condition rather than merely failing.
export const DOUBLE_NAT_ABORT_CODES = new Set(['HOLEPUNCH_DOUBLE_RANDOMIZED_NATS', 'HOLEPUNCH_ABORTED'])

// Both peers randomized is the precondition; what connect() then did is the
// verdict. Split out so the CLI and matrix.mjs judge a run the same way.
export function judgeNatSim(outcome, { relay }) {
    const problems = []
    for (const [name, peer] of Object.entries(outcome.peers ?? {})) {
        if (!peer.randomized) {
            problems.push(`${name} is not behind a randomized NAT (dht.randomized=false) — the sim did not reproduce the field condition, so its verdict means nothing`)
        }
    }
    const connect = outcome.connect ?? {}
    if (relay) {
        if (!connect.connected) problems.push(`relayThrough did not rescue the connection: ${connect.error ?? 'no verdict'}`)
    } else if (connect.connected) {
        problems.push('the peers connected anyway — the NATs are not actually randomizing source ports (is --random-fully in effect?)')
    } else if (!DOUBLE_NAT_ABORT_CODES.has(connect.error)) {
        problems.push(`connect failed with '${connect.error}', not a double-randomized-NAT abort — something else broke first`)
    }
    return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const relay = process.argv.includes('--relay')
    const outcome = await runNatSim({ relay, progress: (message) => console.log(`# ${message}`) })
    console.log(JSON.stringify(outcome, null, 2))
    if (outcome.skipped) {
        console.log(`SKIP: ${outcome.reason}`)
        process.exit(0)
    }
    const problems = judgeNatSim(outcome, { relay })
    for (const problem of problems) console.log(`FAIL: ${problem}`)
    if (problems.length === 0) console.log(relay ? 'PASS: relayThrough carried the connection through two randomized NATs' : 'PASS: reproduced the double-randomized-NAT abort')
    process.exit(problems.length === 0 ? 0 : 1)
}
