// The sim's "internet": a private hyperdht testnet on the public network, so
// nothing here ever touches the mainnet DHT.
//
// Node COUNT is load-bearing, not cosmetic. hyperdht decides it is behind a
// randomized NAT by comparing the address several DIFFERENT nodes report seeing
// it from (dht-rpc's NatSampler, and nat.js needs >= 3 samples). One bootstrap
// node means one conntrack flow means one stable mapped port — which reads as
// CONSISTENT and would make the sim prove the opposite of what it is for.
import createTestnet from 'hyperdht/testnet.js'
import process from 'node:process'

const HOST = process.env.SIM_PUBLIC_IP ?? '10.90.0.10'
const SIZE = Number(process.env.SIM_BOOTSTRAP_NODES ?? 5)

const testnet = await createTestnet(SIZE, { host: HOST })

// Every node's address, not just the seed's: run.mjs hands the whole list to
// the peers so their NAT sampling has distinct remotes to talk to from the
// first packet instead of waiting on routing-table discovery.
const nodes = testnet.nodes.map((node) => `${HOST}:${node.address().port}`)
process.stdout.write(JSON.stringify({ sim: 'bootstrap', ready: true, nodes }) + '\n')

process.on('SIGTERM', async () => {
    await testnet.destroy()
    process.exit(0)
})
