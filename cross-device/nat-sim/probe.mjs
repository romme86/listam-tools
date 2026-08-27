// One peer behind one carrier NAT. Runs as `server` or `client`; run.mjs
// starts the server first and only launches the client once the server has
// announced.
//
// Two things are measured, in this order, and the first one is the reason the
// sim exists:
//
//   1. `dht.randomized` — dht-rpc sets it when several DHT nodes report seeing
//      this peer on the same host but a DIFFERENT port. That is the field
//      condition from 2026-08-26; if it is false, the sim did not reproduce
//      anything and any verdict below it is meaningless.
//   2. what `dht.connect()` does about it. With no relay hyperdht aborts —
//      HOLEPUNCH_DOUBLE_RANDOMIZED_NATS (connect.js:652) or HOLEPUNCH_ABORTED
//      (connect.js:673) — *without punching*. With `relayThrough` set it should
//      connect anyway, over the relay.
//
// No rendezvous file and no service discovery: the server's keypair is derived
// from a seed both sides are given, so the client already knows what to dial.
import DHT from 'hyperdht'
import process from 'node:process'
import { Buffer } from 'node:buffer'

const ROLE = process.env.SIM_ROLE ?? 'client'
// `||`, not `??`: compose passes `SIM_SEED: "${SIM_SEED:-}"`, so an unset seed
// arrives as an empty STRING and a nullish fallback would never fire — leaving
// DHT.keyPair() to throw on a zero-byte seed instead of using the placeholder.
const SEED = Buffer.from((process.env.SIM_SEED || '').padEnd(64, '0'), 'hex')
const RELAY_HEX = (process.env.SIM_RELAY_PUBLIC_KEY ?? '').trim()
const CONNECT_TIMEOUT_MS = Number(process.env.SIM_CONNECT_TIMEOUT_MS ?? 90_000)
const NAT_SAMPLE_ROUNDS = Number(process.env.SIM_NAT_SAMPLE_ROUNDS ?? 3)

const bootstrap = (process.env.SIM_BOOTSTRAP ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
        const [host, port] = entry.split(':')
        return { host, port: Number(port) }
    })

const relayThrough = RELAY_HEX ? Buffer.from(RELAY_HEX, 'hex') : null

const emit = (payload) => process.stdout.write(JSON.stringify({ sim: 'probe', role: ROLE, ...payload }) + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Ping every bootstrap node by hand rather than waiting for the routing table
// to fill: each node is a separate conntrack flow, so each one contributes the
// differing mapped port that makes the sampler decide "randomized".
async function sampleNat(dht) {
    for (let round = 0; round < NAT_SAMPLE_ROUNDS; round++) {
        await Promise.all(bootstrap.map((node) => dht.ping(node).catch(() => null)))
        if (dht.randomized) break
        await sleep(750)
    }
    return { randomized: dht.randomized === true, host: dht.host, port: dht.port }
}

const dht = new DHT({ bootstrap })
await dht.ready()
const nat = await sampleNat(dht)

const keyPair = DHT.keyPair(SEED)

if (ROLE === 'server') {
    const server = dht.createServer({ relayThrough }, (socket) => {
        socket.on('error', () => {})
        // Echo, so the client proves a real duplex stream and not just a
        // handshake that dies on first byte.
        socket.on('data', (data) => socket.write(data))
    })
    await server.listen(keyPair)
    emit({ ...nat, listening: true, relay: Boolean(relayThrough) })
    // run.mjs tears the container down; nothing to wait for here.
    await new Promise(() => {})
}

emit({ ...nat, connecting: true, relay: Boolean(relayThrough) })

const startedAt = Date.now()
const outcome = await new Promise((resolve) => {
    const socket = dht.connect(keyPair.publicKey, { relayThrough })
    const timer = setTimeout(() => {
        socket.destroy()
        resolve({ connected: false, error: 'SIM_CONNECT_TIMEOUT' })
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()

    socket.on('error', (error) => {
        clearTimeout(timer)
        resolve({ connected: false, error: error?.code ?? String(error?.message ?? error) })
    })
    socket.on('open', () => socket.write(Buffer.from('listam-nat-sim')))
    socket.on('data', (data) => {
        clearTimeout(timer)
        // `rawStream.remoteHost` is the relay when relayed and the peer when
        // punched — the cheapest evidence of WHICH path carried the bytes.
        resolve({
            connected: true,
            echoed: data.toString(),
            remote: `${socket.rawStream?.remoteHost ?? '?'}:${socket.rawStream?.remotePort ?? '?'}`,
        })
        socket.destroy()
    })
})

emit({ ...nat, ...outcome, connect_ms: Date.now() - startedAt, relay: Boolean(relayThrough), done: true })
await dht.destroy()
process.exit(0)
