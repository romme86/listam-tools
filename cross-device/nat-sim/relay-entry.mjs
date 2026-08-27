// Runs the REAL relay under test — `startRelay` from listam-headless/src/relay.mjs
// — on the sim's public network, so the relay row exercises the shipped server
// rather than a stand-in written to make the test pass.
//
// The whole `src` directory is copied out of its read-only mount before
// importing, for two reasons that pull in opposite directions: relay.mjs has a
// relative import (`./status.mjs`) so it cannot be copied alone, and its bare
// imports must resolve against THIS image's Linux-built node_modules — node
// resolves those from the importing file's directory upwards, and from inside
// the mount that walk finds the sibling checkout's tree, which is built for the
// host (udx-native ships per-platform prebuilds and will not load here).
//
// run.mjs scrapes the public key off this container's log line rather than
// deriving it from a shared seed, so the relay stays free to mint its own
// identity — which is exactly what it does, from a seed it persists.
import { cpSync, existsSync } from 'node:fs'
import process from 'node:process'

const SOURCE_DIR = '/listam-headless-src'
const LOADED_DIR = '/sim/headless-src'
const STORAGE_DIR = '/sim/relay-storage'

const emit = (payload) => process.stdout.write(JSON.stringify({ sim: 'relay', ...payload }) + '\n')

if (!existsSync(`${SOURCE_DIR}/relay.mjs`)) {
    emit({ missing: true, reason: 'listam-headless/src/relay.mjs is not on disk' })
    process.exit(3)
}

let startRelay = null
try {
    cpSync(SOURCE_DIR, LOADED_DIR, { recursive: true })
    ;({ startRelay } = await import(`${LOADED_DIR}/relay.mjs`))
} catch (error) {
    emit({ missing: true, reason: `relay.mjs failed to load: ${error?.message ?? error}` })
    process.exit(3)
}
if (typeof startRelay !== 'function') {
    emit({ missing: true, reason: 'relay.mjs does not export startRelay()' })
    process.exit(3)
}

const bootstrap = (process.env.SIM_BOOTSTRAP ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
        const [host, port] = entry.split(':')
        return { host, port: Number(port) }
    })

// Relay logs go to stderr: stdout is the JSON channel run.mjs scrapes.
const logger = { log: (...args) => process.stderr.write(args.map(String).join(' ') + '\n') }

try {
    const relay = await startRelay({
        storageDir: STORAGE_DIR,
        bootstrap,
        logger,
        // A five-minute heartbeat is right for an always-on box and pure noise
        // for a container that lives for one row.
        statsIntervalMs: 0,
    })
    if (!relay?.publicKeyHex) throw new Error('startRelay() returned no publicKeyHex')
    emit({ ready: true, publicKey: relay.publicKeyHex })
} catch (error) {
    emit({ error: `startRelay threw: ${error?.message ?? error}` })
    process.exit(4)
}

await new Promise(() => {})
