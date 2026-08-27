// Diagnostic for the one failure the sim cannot interpret for you: a peer
// reporting `randomized: false`. When that happens the run's verdict is
// meaningless (see README), and the question is always the same — is the peer
// reaching the DHT at all, and if so, is its mapped source port actually
// changing per flow?
//
// This prints both, per ping: the address each bootstrap node says it sees, and
// the sampler's running decision. Five different ports for five nodes is the
// sim working. Identical ports means MASQUERADE is not randomizing (the rule
// never applied, or the packets never crossed the gateway). REQUEST_TIMEOUT on
// every node means the peer has no route out — check that peer.sh replaced the
// default route.
//
//   docker compose up -d --build bootstrap gw-a gw-b
//   docker compose logs --no-log-prefix bootstrap        # copy the node list
//   SIM_BOOTSTRAP=<list> docker compose run --rm --entrypoint sh -e SIM_BOOTSTRAP \
//       peer-b -c 'ip route replace default via 10.92.0.2 && node /sim/nat-debug.mjs'
import DHT from 'hyperdht'
import process from 'node:process'

const bootstrap = (process.env.SIM_BOOTSTRAP ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
        const [host, port] = entry.split(':')
        return { host, port: Number(port) }
    })

const dht = new DHT({ bootstrap })
await dht.ready()
console.log(`ready firewalled=${dht.firewalled} host=${dht.host} port=${dht.port} randomized=${dht.randomized}`)

for (let round = 0; round < 4; round++) {
    for (const node of bootstrap) {
        try {
            const reply = await dht.ping(node)
            console.log(`ping ${node.port} -> seen as ${reply?.to?.host}:${reply?.to?.port}`)
        } catch (error) {
            console.log(`ping ${node.port} FAILED ${error?.code ?? error?.message}`)
        }
    }
    console.log(`round ${round}: host=${dht.host} port=${dht.port} randomized=${dht.randomized}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
}

await dht.destroy()
process.exit(0)
