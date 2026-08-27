# NAT simulation — the 4G pairing failure, reproducible on one machine

On 2026-08-26 three people on 4G tried to share a list. Nobody got past join
phase 1. The cause was not Listam code at all: when **both** peers sit behind a
carrier NAT that rewrites the source port per flow, hyperdht classifies both
ends as `FIREWALL.RANDOM` and **aborts without ever attempting a punch** —
`HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` (`hyperdht/lib/connect.js:652`) or
`HOLEPUNCH_ABORTED` (`connect.js:673`, the `if (!c.relayToken) bail` branch).
Listam had no `relayThrough` configured, so there was no fallback, and
blind-pairing's NAT-free DHT mailbox is polled every 7 minutes against a 120 s
deadline — it never fired either.

Nothing in the cross-device matrix could see this. Every machine in that matrix
is on a home LAN behind a consistent NAT, which punches fine. This directory is
the missing environment.

## What it proves

Two claims, in order. The second is worthless without the first.

1. **The sim really is a double-randomized NAT.** Each peer reports
   `dht.randomized === true` — dht-rpc sets that when several DHT nodes report
   seeing the peer at the same host but a *different* port. If either peer
   reports `false`, the run FAILs and says so: whatever happened next was not
   this bug.
2. **What `dht.connect()` does about it.** Without a relay it must abort with a
   double-randomized-NAT code. With `relayThrough` pointed at a locally run
   relay it must connect, and the probe reports the address the bytes actually
   arrived from — the relay's, on a relayed path — so "it connected" cannot be
   confused with "it punched after all".

Observed on Docker Desktop 29.2.1 (linuxkit 6.12.69), 2026-08-27:

```
no relay:  peer-a randomized=true, peer-b randomized=true
           connect → HOLEPUNCH_ABORTED after 11 ms   (no punch attempted)
relay:     peer-a randomized=true, peer-b randomized=true
           connect → open after 18 ms, remote 10.90.0.20 (the relay)
```

## Topology

```
  lan-a                       public                lan-b
  10.91.0.0/24                10.90.0.0/24          10.92.0.0/24

  peer-a .10 ─── gw-a .2/.11 ──── bootstrap .10 ──── gw-b .12/.2 ─── peer-b .10
                                  relay     .20
```

- **`bootstrap`** — a 5-node private hyperdht testnet. Nothing touches mainnet.
  Five nodes, not one: the NAT classifier needs several *distinct* remotes to
  notice that its mapped port keeps changing. One node is one conntrack flow is
  one stable port, which reads as CONSISTENT and would prove the opposite.
- **`gw-a` / `gw-b`** — the carrier NATs. The entire simulation is one flag:
  `iptables -t nat -A POSTROUTING -o <uplink> -j MASQUERADE --random-fully`.
  Plain `MASQUERADE` preserves the source port when it can; `--random-fully`
  picks a fresh random one per flow, which is what a CGNAT does.
- **`peer-a` / `peer-b`** — the peers. `peer.sh` replaces docker's default
  route with the gateway's LAN address, so everything a peer sends leaves
  through its own NAT.
- **`relay`** — runs the real `startRelay()` from
  `listam-headless/src/relay.mjs`. The whole `src` directory is copied out of
  its read-only mount before importing: relay.mjs has a relative import
  (`./status.mjs`) so it cannot travel alone, and its bare imports must resolve
  against the container's Linux-built `node_modules` — the sibling checkout's
  tree is built for the host and `udx-native` will not load. The public key is
  scraped off the container's log line rather than pinned to a seed, so the
  relay keeps minting its own identity the way it does in production.

The peer LANs are deliberately **not** `internal: true`, even though that reads
as the stronger guarantee. Docker implements `internal` by dropping any packet
on that bridge whose peer address is outside the subnet — which drops the hop to
the gateway's public side too, and leaves the peers with no network at all
(symptom: `REQUEST_TIMEOUT` on every bootstrap node, `randomized=false`). The
default-route swap is what forces traffic through the NAT.

## Running it

```bash
node listam-tools/cross-device/nat-sim/run.mjs           # expect the abort
node listam-tools/cross-device/nat-sim/run.mjs --relay   # expect a connection
```

Or as matrix rows, alongside everything else in the harness:

```bash
node listam-tools/cross-device/matrix.mjs --devices mac-headless --nat-sim --time-budget 20
```

The first run builds the image (`npm install` inside the container), so budget
a few minutes; later runs take seconds. `run.mjs` always tears the stack down,
including on failure.

## Reading a failure

| What you see | What it means |
|---|---|
| `SKIP: no reachable docker daemon` | Nothing ran. See the platform note below. |
| `SKIP: listam-headless/src/relay.mjs does not exist yet` | The relay row only. The no-relay row still runs and is still meaningful. |
| `SKIP: relay under test unusable: …` | `startRelay()` loaded but could not run — usually a new import of a package the sim image does not carry. Add it to `package.json` (native deps) or bind-mount it (pure-JS `@listam/*`). |
| `gw-a: iptables MASQUERADE --random-fully rejected` | The kernel or iptables build cannot do the one thing the sim needs. Not a Listam failure. |
| `peer-X is not behind a randomized NAT` | The sim did not reproduce the condition. **Ignore every other line in the run** — they describe a network that is not the one under test. Diagnose with `nat-debug.mjs` (header comment has the invocation): it prints the address each bootstrap node reports seeing, so you can tell "no route out" from "NAT is not randomizing". |
| `the peers connected anyway` | `--random-fully` is not in effect end-to-end. Same reading as above: the run proved nothing. |
| `connect failed with 'X', not a double-randomized-NAT abort` | Something broke before the holepunch decision — usually the private DHT is unreachable from behind the NAT. `docker compose logs bootstrap`. |
| `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` / `HOLEPUNCH_ABORTED` on the **no-relay** run | Correct. This is the field failure, reproduced. |
| `relayThrough did not rescue the connection` on the **relay** run | The regression this directory exists to guard. The relay is reachable (it published a public key) but the connection still died — `docker compose logs relay`. |

## Platform note — read this before assuming it ran

The mechanism is Linux network namespaces plus `iptables`/`nf_nat`. **It cannot
run on macOS directly**: there are no netns, `ip netns` does not exist, and pf's
NAT has no `--random-fully` equivalent. A shell-script variant over `ip netns`
would be Linux-only for exactly the same reason, which is why this is
docker-compose instead.

Docker Desktop for Mac runs its containers inside a Linux VM, so the compose
stack does work from a Mac — the numbers above were taken there — but it is the
VM's kernel doing the NAT, not macOS, and Docker Desktop has to be running. If
the daemon is not reachable, `run.mjs` returns `{ skipped, reason }` and the
matrix row reports SKIP rather than a red that would be indistinguishable from a
real regression.

Requirements either way: a kernel with `nf_nat`/conntrack and `iptables >=
1.6.2` (for `--random-fully`), `NET_ADMIN` on the gateway and peer containers,
and the `10.90–10.92.0.0/24` subnets free.
