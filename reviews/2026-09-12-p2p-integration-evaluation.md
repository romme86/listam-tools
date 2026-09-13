# P2P research integration evaluation — 12 September 2026

Adopt four compatible library updates first: Autobase 7.28.2, Hyperswarm 4.17.1, Hypercore 11.36.1, and Corestore 7.12.5. The proposed combination passes **848 shared-package tests** in an isolated copy of the current source. Keep the current Autobase architecture, strengthen blind-storage reachability and completeness, and evaluate Pear's new commands for desktop distribution. Autobee migration and notification-driven background sync need separate projects.

This evaluation covers the seven active `listam-*` repositories in this workspace, the 11 September **P2P Relay Research** report, and relevant unfinished recommendations from earlier reports. Upstream releases, source changes, npm metadata, and open PR status were checked on 12 September. Older nested worktrees and downloaded SDK dependencies are excluded. The ESP32 experiment remains paused, consistent with the previous review follow-up.

Application source, dependency manifests, live services, and release channels were not changed. Existing uncommitted work was included when reading and testing the current source. The only workspace addition from this evaluation is this report.

**Current dependency baseline**

| Component | Current resolution | Recommended target | Where it matters |
| --- | --- | --- | --- |
| Autobase | 7.28.1 | **7.28.2** | Shared backend; desktop/mobile; headless participant through `@listam/backend` |
| Hyperswarm | 4.17.0 | **4.17.1** | Shared backend, desktop/mobile, headless participant and blind storage |
| Hypercore | 11.35.3 | **11.36.1** | Shared backend and all storage participants/helpers |
| Corestore | 7.12.2 | **7.12.5** | Shared backend, desktop/mobile, headless storage roles |
| HyperDHT | 6.34.0 | Keep 6.34.0 | Already contains last week's released cleanup/statistics changes |
| udx-native | 1.21.1 | Keep released version; track upstream fixes | Native transport, including relay and NAT tests |
| blind-relay | 1.6.1 | Keep 1.6.1 | Existing headless relay; Pear 3.4 also declares this version range |
| blind-peering / Autobee / ble-swarm | Not in active app dependency graphs | No immediate addition | Different protocols/features from Listam's current implementation |

The first four resolutions agree across the relevant active lockfiles and installed trees. Headless has no direct Autobase dependency: its participant imports the shared backend, which resolves Autobase from the linked shared workspace during local development. Headless blind storage uses Corestore and Hyperswarm directly; the relay-only process uses HyperDHT and blind-relay. These roles need different release verification.

**Disposition of all nine latest research items**

| Research item | Decision | Integration |
| --- | --- | --- |
| Pear 3.4.0 blind-peer/relay CLI | Adopt for a distribution prototype | Test persistent mirroring of the desktop Pear application drive. Keep the existing Listam relay service and its persistent identities. Treat application-drive seeding and list-data replication as separate acceptance tests. |
| Autobase 7.28.2 teardown fix | Upgrade now | Raise the dependency floor in `@listam/backend`, desktop, and mobile; refresh consumer locks and release artifacts. Test overlapping close/reopen and shutdown during active writes/replication. |
| Hyperswarm 4.17.1 network recovery | Upgrade now | Refresh all relevant graphs. Test interface changes and automatic fallback on `CANNOT_HOLEPUNCH`, including initial pairing and shared-list swarms. |
| blind-peering 2.9.0 mirroring fixes | Conditional prototype | Listam does not use this package. Evaluate it as an optional adapter for complete encrypted mirroring, with explicit core registration and revocation, before replacing the custom helper. |
| blind-peering #90 notification balancing | Defer implementation | Still open. Listam already randomizes connection-relay selection. Notification-peer selection is a separate concern for a future push service. |
| Hypercore 11.36.1 latest-block control | Upgrade library; benchmark feature separately | Keep the feature off by default. Test a bounded catch-up window over selected remote cores; measure bytes, duration and successful state reconstruction. |
| Autobee 2.6–2.7 catch-up improvements | Defer migration | Listam's append-only materialized view, membership validation, checkpoints and encryption cannot be assumed compatible with Autobee's Hyperbee view and trust model. |
| libudx #318/#317 timeout changes | Track and simulate | #318 remains open; #317 remains draft. Exercise loss, jitter and outages with released binaries; use an isolated native build only for experiments. |
| libudx #320 lookup/interface use-after-free | Track as a transport risk | Still open and absent from a new released udx-native version. Require repeated interface-change tests; trace the eventual fix into the actual native artifacts before claiming it shipped. |

Sources: [Pear 3.4.0](https://github.com/holepunchto/pear/releases/tag/v3.4.0), [Autobase teardown fix](https://github.com/holepunchto/autobase/pull/378), [Hyperswarm network update fix](https://github.com/holepunchto/hyperswarm/pull/220), [additional relay fallback](https://github.com/holepunchto/hyperswarm/pull/215), [blind-peering 2.9.0](https://github.com/holepunchto/blind-peering/releases/tag/v2.9.0), [notification selection #90](https://github.com/holepunchto/blind-peering/pull/90), [Hypercore latest-block API](https://github.com/holepunchto/hypercore/pull/869), [Autobee 2.7.0](https://github.com/holepunchto/autobee/releases/tag/v2.7.0), [libudx #318](https://github.com/holepunchto/libudx/pull/318), [#317](https://github.com/holepunchto/libudx/pull/317), [#320](https://github.com/holepunchto/libudx/pull/320).

**Why include Corestore and the full Hypercore update?**

Corestore 7.12.5 adds more than an option for the latest-block experiment. The intervening releases fix group handling and prevent closing a detached child session from removing tracking for a still-open parent. Hypercore's intervening changes include an initial update for empty remote cores. These affect Listam's repeated opening, joining and closing of personal/shared bases, so the recommended update is useful even with latest-block control disabled. Sources: [Corestore changes](https://github.com/holepunchto/corestore/compare/v7.12.2...v7.12.5), [session tracking fix](https://github.com/holepunchto/corestore/pull/164), [remote-core initial update](https://github.com/holepunchto/hypercore/pull/867).

**Repository integration map**

| Repository | Required work | Validation before release |
| --- | --- | --- |
| `listam-packages` | Update `packages/backend/package.json` to minimum Autobase `^7.28.2`, Hyperswarm `^4.17.1`, Corestore `^7.12.5`; resolve Hypercore 11.36.1 in the lock. Centralize optional catch-up control in the shared backend. | Full shared suite; real close/reopen during writes; empty remote-core startup; writer membership, rekey and checkpoint recovery regressions. |
| `listam-mobile` | Match direct dependency floors and refresh its independent lock. Rebuild both Bare backend bundles and both native app artifacts. Preserve the current AppState and drain coordinators. | Clean install and mobile CI; iOS/Android builds; physical Wi-Fi → offline → cellular → Wi-Fi tests; background/foreground during pairing and replication; cold reopen with pending writes. |
| `listam-desktop` | Match direct floors and refresh its lock. Stage a beta Pear build using the updated shared backend. Prototype persistent application-drive seeding with Pear 3.4. | Desktop CI and actual Pear worker smoke test; fresh beta install while the publishing machine is offline; shared-base join and cross-version replication. |
| `listam-headless` | Update direct Hyperswarm/Corestore floors and lock, and consume a versioned release of the updated backend for participant mode. Add relay configuration to blind storage; implement complete durable pin registration before relying on it for offline catch-up. | Participant/blind/relay role tests; ciphertext boundary and quota tests; helper restart and offline-owner recovery; NAT/fallback and relay churn. Preserve relay identity storage. |
| `listam-tools` | Add dependency/artifact version reporting and a real Hyperswarm fallback scenario; extend controlled network scenarios. Document Pear seeding and the release order. | Existing direct-HyperDHT NAT test plus Hyperswarm recovery; one unavailable relay among two; 2,000 relay cycles and failure/restart; network impairment matrix. |
| `listam-website` | No runtime library changes. Update the headless/desktop wiki and downloadable release references when the corresponding artifacts ship. Explain relay, encrypted storage and app seeding accurately. | `node scripts/wiki-facts.mjs --check`, download links/checksums and documented capabilities against the released artifacts. |
| `listam-hardware` | No implementation now. Keep leaf/voice features paused. Record any later protocol or mirroring experiment separately. | If revived: interoperability with the updated JS stack, quotas/buffers and restart behavior. None of the JS version bumps updates the vendored Rust/native stack automatically. |

Shared entry points are [backend lifecycle and view creation](../../listam-packages/packages/backend/backend.mjs), [personal network setup](../../listam-packages/packages/backend/lib/network.mjs), and [shared-base setup](../../listam-packages/packages/backend/lib/shared-base.mjs). Consumer entry points are [mobile backend](../../listam-mobile/backend/backend.mjs), [desktop worker](../../listam-desktop/src/backend-worker.mjs), and [headless participant](../../listam-headless/src/service.mjs).

**Dependency and artifact handling**

Update the backend manifest and the corresponding declarations in desktop/mobile/headless; changing the shared workspace lock alone does not update every installed or bundled graph. Keep Hypercore's resolved version consistent across the graphs. If the application begins depending directly on its new API, make that minimum an explicit package/release requirement instead of relying only on a transitive version chosen today.

The isolated candidate changed exactly four lockfile entries. HyperDHT and udx-native stayed unchanged. This is a suitable scope for the first integration change.

Publish/version the shared backend before building a distributable headless consumer: [the headless packaging script](../../listam-headless/scripts/build-dist.mjs) converts workspace `file:` dependencies into registry version ranges. Test that packaged installation in an empty directory without sibling workspace links. Preserve the updated locks in the workspace deployment path, which currently installs both packages and headless with `npm ci`.

Mobile's [bundle gate](../../listam-mobile/scripts/check-bundles.mjs) checks that producer and import paths match; it does not prove the generated bundle contains the current dependency versions. Rebuild both targets and record a source/lock hash or runtime dependency fingerprint in release evidence. Check the desktop Pear runtime separately: npm's `pear` installer package version is not evidence that the installed Pear CLI/runtime supports the 3.4 commands.

**Blind storage needs two concrete changes**

1. **Relay fallback is missing in this role.** [The helper](../../listam-headless/src/blind.mjs) constructs a Hyperswarm with only bootstrap options. Other backend swarms use the shared relay selector. Pass validated relay keys into blind storage, including defaults and an explicit opt-out, and construct its swarm with the same fallback policy. An updated Hyperswarm cannot select a configured Listam relay if this role never supplies one. Test a blind helper and phone behind randomized NAT with direct punching unavailable.
2. **A configured bootstrap core is not a complete offline replica.** Setup initially pins one core, and the helper's `pin` operation adds entries to an in-memory map. That operation does not persist the new pin set into configuration, and this path does not automatically follow writer/view membership. Introduce an authenticated, versioned pin manifest over the existing control plane, persist it before acknowledging changes, and reconcile writers/views on membership and epoch changes. Retain only public keys and ciphertext on a blind helper. Test multiple advancing writers, owner offline, helper restart, membership changes, and a sleeping client reconstructing the full list.

Evaluate blind-peering 2.9 against those acceptance tests. Its Autobee-specific mirroring fixes do not establish support for Listam's current Autobase layout. Keep the existing helper until interoperability and the encryption boundary are demonstrated.

**Latest-block experiment and mobile wake behavior**

The existing [sleep coordinator](../../listam-packages/packages/backend/lib/sleep-coordinator.mjs) has an eight-second deadline covering network suspension, tracked application work and concurrent `advance()`/`flush()` calls. The [mobile coordinator](../../listam-mobile/app/appLifecycle.ts) uses a ten-second native linger and ignores superseded replies. Preserve these controls. A locally drained backend does not prove that every remote writer has been fetched.

Start the latest-block experiment during ordinary foreground catch-up, which already exists. Use a feature flag and one shared controller for selected remote cores; enable before requesting updates, and disable on completion, deadline, backgrounding and teardown. The new method changes the underlying core replicator shared by sessions, so independent per-screen toggles could undo one another. It also does not itself fetch every intermediate record or validate the resulting Listam state.

Compare feature off/on using identical offline intervals and writer histories. Measure time to a verified current view, downloaded bytes, CPU time and time to local drain. Confirm that a missing writer does not stall reachable bases. Adopt only if repeated physical-device measurements show a useful improvement without extra idle traffic. Source: [Hypercore 11.36.1 implementation and docs](https://github.com/holepunchto/hypercore/compare/v11.35.3...v11.36.1).

Push is still a separate feature: the active mobile manifest and backend have no integrated APNs/FCM delivery service. A useful design needs device registration/revocation, coalesced hints, rate limits, a native-to-Bare wake path, one catch-up deadline and recovery on the next foreground. Hints should identify authorized state changes without carrying list content; unavailable hints must not block reachable updates. [Notification rate limiting #85](https://github.com/holepunchto/blind-peering/pull/85) has now merged, while selection #90 remains open. Neither supplies this entire application integration.

The existing [connection relay selector](../../listam-packages/packages/backend/lib/relay.mjs) already chooses randomly between two configured defaults. A future improvement is bounded retry that avoids an immediately failed relay, with cooldown and success/failure telemetry. Random selection alone does not establish health-aware failover. Test that behavior independently of notification routing.

**What should remain deferred**

Autobee is explicitly described upstream as experimental and subject to breaking changes. Listam creates a JSON append-only view with `store.get()` and `view.append()`, while Autobee exposes a Hyperbee view and different apply/fast-forward contracts. A migration must explicitly map existing bases, membership admission, causal-history validation, epoch keys, rollback, checkpoints, backups and mixed-client rollout. Its `busy`/catch-up APIs are not drop-in replacements for Listam's current drain coordinator. Source: [Autobee 2.7 documentation](https://github.com/holepunchto/autobee/blob/v2.7.0/README.md).

Keep connection-preserving replication suspension deferred: [Hypercore #851](https://github.com/holepunchto/hypercore/pull/851) and [Corestore #154](https://github.com/holepunchto/corestore/pull/154) are still open. Corestore 7.12.5 does not make those proposed APIs available. The earlier ble-swarm recommendation also does not apply directly to the retained React Native BLE provisioning dependency; that feature is currently paused.

Keep released native transport binaries for the initial update. The installed udx-native 1.21.1 build file pins libudx at `a9af5de`; JavaScript dependency updates alone cannot incorporate #320 or #317/#318. When a fix ships, verify which native artifact reaches Node, Pear, iOS and Android. Diagnose interface-change crashes with evidence rather than attributing every crash to an open upstream report. The earlier [HyperDHT relay-abort fix #292](https://github.com/holepunchto/hyperdht/pull/292) also remains open.

**Implementation order and acceptance**

1. Land the four dependency updates, minimum versions and reproducible artifacts. Run shared and consumer gates plus close/reopen and real Hyperswarm fallback regressions. This stage retains existing data formats and application behavior.
2. Add blind-helper relay support and durable, complete pin registration. Verify recovery with the original writers offline and after helper restart. Add retry/failure telemetry where the tests show it is needed.
3. Prototype Pear 3.4 desktop application seeding with a separate storage directory/identity. Verify a fresh beta installation while the original seeder is offline; do not rotate existing connection-relay keys.
4. Benchmark optional latest-block catch-up. Treat push integration and Autobee migration as separately specified changes with their own acceptance tests.

Extend the tools' network matrix to RTT 20/100/200 ms, controlled jitter/loss, MTU 1280/1350/1400, and outages of 1/5/15 seconds. Record convergence, reconnect duration, bytes and socket counts. The current [NAT probe](../cross-device/nat-sim/probe.mjs) uses HyperDHT directly; passing it does not exercise Hyperswarm's new `CANNOT_HOLEPUNCH` fallback. Add a Hyperswarm-level scenario instead of treating the existing NAT test as proof of that change.

The earlier consistency fixes still deserve coordinated release handling when shipping the current workspace. That is a pre-existing application-level requirement from the [5 September follow-up](2026-09-05-follow-up.md), not evidence that these four upstream updates introduce a new wire-format migration.

**Evidence and limits**

| Check performed for this evaluation | Result |
| --- | --- |
| Seven active repositories, manifests, lockfiles, relevant source paths and prior review | Inspected; local source includes existing uncommitted work |
| Upstream releases/source diffs, npm versions and PR status | Verified on 12 September 2026 |
| Current focused lifecycle/relay/checkpoint/mobile lifecycle tests | **39 passed**, no failures or skips |
| Clean install and targeted dependency update in isolated shared-package copy | Succeeded; exactly Autobase, Hyperswarm, Hypercore and Corestore changed |
| Full shared-package suite against the candidate | **848 passed**, no failures, skips or TODOs; Node 24.17.0, approximately 16.8 seconds |
| Candidate native mobile builds, actual Pear worker, headless packaged consumer, new physical-device/NAT runs | Not performed; required during implementation/release |
| Live relay state and deployed app versions | Not inspected or changed |

Test logs and the isolated candidate are under `/tmp/listam-p2p-review-2026-09-12/`. An existing npm cache permissions problem was bypassed with a dedicated temporary cache; global cache ownership/settings were not changed. Passing the shared suite supports proceeding with the dependency integration; it does not substitute for the consumer and physical-device checks above.
