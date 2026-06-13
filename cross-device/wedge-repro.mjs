// Acceptance harness for the unreachable-peer wedge found in the 2026-06-11
// cross-device matrix run: a joined guest whose peer (and DHT) vanished spun
// a full core (~99% CPU), never answered a subsequent `add` op, and ignored
// stdin-EOF shutdown — it had to be SIGKILLed. On the Geekom Proxmox VM this
// pegged a vCPU for 40 minutes and drove the mini-PC past 90°C. Root cause:
// the join flow reused the pre-join 'local' writer core, whose stale block
// (old base's encryption) froze the joined base's writer pipeline, so EVERY
// guest append — connected or not — entered autobase's unbounded retry loop.
//
//   node listam-tools/cross-device/wedge-repro.mjs   (from the repo root)
//
// Healthy output since the fix (scoped per-base join writer + flushable-
// writer gate + op timeouts + shutdown watchdog): "ADD ANSWERED: {... ok
// :true}" (local-first append, replicates on reconnect), cpu≈0% every
// sample, and "exited cleanly" after stdin EOF. CI guards the same contract
// in listam-headless/test/wedge.test.mjs.
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runHeadless, runOneShot } from '../../listam-headless/test/helpers/cli.mjs'

const requireHeadless = createRequire(new URL('../../listam-headless/package.json', import.meta.url))
const createTestnet = requireHeadless('hyperdht/testnet.js')

setTimeout(() => { console.log('HARD-EXIT'); process.exit(0) }, 150_000)

const dirs = []
async function participant(label, bootstrap) {
    const dir = mkdtempSync(join(tmpdir(), `wedge-${label}-`))
    dirs.push(dir)
    await runOneShot(['setup', '--storage', dir, '--role', 'participant'])
    const service = runHeadless(['run', '--storage', dir, '--bootstrap', bootstrap])
    await service.ready()
    return service
}

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap.map(({ host, port }) => `${host}:${port}`).join(',')

const host = await participant('host', bootstrap)
const guest = await participant('guest', bootstrap)

await host.request('add', { text: 'Milk' })
const invite = (await host.request('invite')).inviteKey
await guest.request('join', { invite })
await guest.waitFor((r) => r.joined, { op: 'dump' })
await guest.waitFor((r) => r.items?.length >= 1, { op: 'dump' })
console.log('JOINED+SYNCED ok')

// Sever: host gone, DHT gone.
host.proc.kill('SIGKILL')
await testnet.destroy()
console.log('SEVERED (host killed, testnet destroyed)')

const pid = guest.proc.pid
let addAnswered = false
guest.request('add', { text: 'Eggs' }).then(
    (r) => { addAnswered = true; console.log('ADD ANSWERED:', JSON.stringify(r)) },
    (e) => { addAnswered = true; console.log('ADD REJECTED:', e.message.split('\n')[0]) },
)

for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    let cpu = 'gone'
    try {
        cpu = execSync(`ps -o %cpu= -p ${pid}`).toString().trim()
    } catch {}
    console.log(`t=${(i + 1) * 5}s guest cpu=${cpu}% addAnswered=${addAnswered}`)
}

// Does EOF shutdown work in this state?
guest.proc.stdin.end()
await new Promise((resolve) => setTimeout(resolve, 8000))
let alive = true
try { process.kill(pid, 0) } catch { alive = false }
console.log(`after stdin EOF + 8s: guest ${alive ? 'STILL ALIVE (shutdown blocked)' : 'exited cleanly'}`)
try { process.kill(pid, 'SIGKILL') } catch {}
for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
console.log('DONE')
process.exit(0)
