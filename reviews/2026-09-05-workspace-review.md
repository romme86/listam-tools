> Follow-up: the remaining findings were addressed further in [the 5 September follow-up](2026-09-05-follow-up.md), including consensus fixes, mobile dependencies, sleep coordination, native builds, and the pause of ESP32 features. The findings and counts below describe the initial review.

# Listam workspace review — 5 September 2026

Reviewed all seven repositories: shared packages, desktop, mobile, headless, hardware, tools, and website. This review includes source inspection, dependency/advisory checks, existing test gates, targeted regressions, a desktop settings preview, a firmware compile, and a private-network relay stress test.

The changes are local and uncommitted. No release, remote relay deployment, or hardware flash was performed. Pre-existing hardware wake-word/audio changes and the website's untracked `.claude/` directory were preserved. The firmware build includes that existing hardware work.

## Findings that remain open

These are material qualifications to the passing CI gates.

| Priority | Finding and evidence | Required follow-up |
| --- | --- | --- |
| P1 | Owner membership/re-key decisions remain dependent on apply order when competing signed records originate from a forked owner writer. The existing regression at `listam-packages/packages/backend/lib/apply-discard-reorder.test.mjs:661` still fails under `todo`. This requires the owner writer to fork, such as through a restored/cloned writer identity; it is not evidence that an arbitrary peer can sign owner records. | Complete the deterministic membership/causal-order work before claiming this recovery case is safe. Preserve the failing regression and its owner-fork precondition. |
| P2 | An older, unstamped ticket written concurrently with enabling rigor can be accepted or rejected according to apply order. Reproduced by the existing `todo` at `apply-discard-reorder.test.mjs:391`. Current stamped writers have separate passing coverage. | Finish the causal-past validation rule and mixed-version coverage; a UI toggle or another flag cannot repair this consensus behavior. |
| P2 | Mobile still has **24 affected dependency entries: 8 high and 16 moderate**, arising from four underlying advisories. `image-size` affects image parsing in Expo/Metro tooling; `decode-uri-component` is also in the navigation dependency chain; `uuid` remains under Xcode tooling. | Follow compatible upstream fixes and plan an Expo/navigation migration with native builds. Do not classify all remaining findings as build-only. See the [image-size ICNS](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr), [image-size JXL/HEIF](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), [URI decoder](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr), and [UUID](https://github.com/advisories/GHSA-w5hq-g745-h8pq) advisories. |
| P2 | Rust's patched-vulnerability entries are cleared, but informational **unsound/unmaintained** advisories remain. Host dependencies include `async-std`, `atty`, `failure`, and `instant`; firmware includes `failure`, `instant`, and `proc-macro-error2`. `atty` and `failure` also carry unsoundness warnings. | Migrate the affected older dependency trees, including vendored Hypercore code. This is not a clean security bill of health merely because cargo-audit's `vulnerabilities.count` is zero. |
| P2 | Listam does not yet implement the report's complete bounded push-wake architecture or a database “safe to sleep” resource signal. | Implement this as an explicit architectural change when push/background replication is introduced. Lifecycle RPC timeouts alone do not prove that database work has drained. |

The two consensus regressions were present before this review. Their `todo` annotations were not added or weakened here. The workspace status summary now explicitly reports known TODOs rather than displaying only a zero-failure count.

## Fixes by repository

| Repository | Changes and their purpose |
| --- | --- |
| `listam-packages` | Suspend/resume now covers currently registered personal, shared-list, and temporary pairing swarms. Transitions are serialized per swarm, rapid requests coalesce, and one stuck swarm cannot delay the others. The lifecycle call has an eight-second deadline; the ordered native operation can still finish later. Removed the extra discovery-flush wait on foreground recovery. Added socket-pool data to transport diagnostics. Shared-list catch-up reads locally available blocks without waiting for missing peers and scans a fixed head, retaining the previous projection when incomplete. Normal boot/apply checkpoint reads retain their previous waiting behavior. BLE provisioning now bounds subscription and writes, supports cancellation, stops on terminal status, and releases late subscriptions. Noble transport covers scan/connect/discovery with a deadline, releases failed/late connections, detaches subscriptions on close, and refuses stale operations. Added the workspace lockfile to versioned files and changed its CI install to `npm ci`. |
| `listam-mobile` | BLE attempts are exclusive and disposable: backgrounding/unmount cancels the attempt and disposes its manager; the next attempt waits for prior native teardown. One 60-second budget covers permissions, adapter startup, scan, connection, discovery, MTU, and provisioning. Native cleanup cannot keep the UI waiting indefinitely. Android before version 12 requests the location permission needed for scanning; newer Android requests Bluetooth scan/connect permissions. Removed eight unused dependencies, including the unused `blind-peering`/Autopass stack. Replaced a CLI `latest` range with a bounded major range. Applied compatible dependency/security updates and refreshed both backend bundles. |
| `listam-desktop` | Receives the shared lifecycle and synchronization fixes. Corrected the public device-key button's accessible label/tooltip from “Copy invite” to “Copy key,” using an existing translated string. Fixed accumulating child-process exit/error listeners in the synchronization test driver. Updated compatible dependencies. |
| `listam-headless` | A blind storage helper over quota now stops download ranges, disconnects existing peers, rejects new replication connections, and leaves discovery topics; it resumes downloads/discovery after usage falls below quota. Previously, leaving topics allowed established replication to keep filling the disk. Status reporting now uses the cached quota sample instead of rescanning the storage tree every five seconds. Relay startup failures clean up allocated resources; status includes DHT punch, relay, and socket-pool counters. Added a repeatable relay churn/failure harness and patched the optional Linux Bluetooth build dependency chain. |
| `listam-hardware` | Serialized opening a core in the Rust mirror registry so simultaneous connections cannot open multiple writers on the same store. Added a 16-caller concurrency regression. Updated compatible Rust packages and removed an unused vulnerable `remove_dir_all` dev dependency from vendored Hypercore. Repaired the legacy serial bridge's broken local package paths, declared its directly imported parser, accepted current structured/bucket snapshots, checked actual add acknowledgements, validated baud values, and shut down cleanly with a failing exit code when the serial port cannot open. |
| `listam-tools` | Matrix RPC requests now remove timers/pending entries and exit listeners after completion or timeout. Workspace checks fail on missing repos, broken package links, or failed gates, and include website/tools gates. NAT simulation now has a lockfile and uses `npm ci` in Docker. The relay deploy script validates remote paths and the SSH target, uploads an explicit source allowlist, and installs copied lockfiles before starting/querying the service. Previously, copying source alone could leave the old HyperDHT installed. The deployment script was checked locally, not executed remotely. |
| `listam-website` | Wiki navigation now handles Firebase's extensionless clean URLs, optional search elements are guarded, and scroll work is coalesced to one animation frame. Corrected desktop source-version facts to 0.21.0 while retaining installer links at the actually published 0.19.13 release. The fact checker now distinguishes installer versions from source versions rather than silently suggesting an unreleased download. |

The blind-helper quota remains a periodically checked soft limit. It can overshoot between samples; this change does not implement a filesystem-enforced cap or delete stored cores.

## Dependency update results

Updates stayed within compatible declared ranges, with explicit security overrides where needed. The main application lockfiles now resolve:

| Library | Previous app lockfiles | Updated |
| --- | --- | --- |
| HyperDHT | 6.32.0 | **6.34.0**, with a declared minimum of 6.34.0 |
| Hypercore | 11.33.1 | 11.35.3 |
| Corestore | 7.10.1 | 7.12.2 |
| Autobase | 7.28.1 | 7.28.1, retained |
| bare-fs / bare-path / bare-url | 4.7.2 / 3.0.1 / 2.4.5 | 4.8.1 / 3.1.2 / 2.5.4 |
| Expo | 54.0.35 | 54.0.37; React Native 0.81.5 retained |

Also refreshed compatible supporting dependencies, patched `postcss` in mobile and `tar` in headless, and updated Rust `crossbeam-epoch` to 0.9.20. Unused mobile packages removed: `@inquirer/prompts`, `autopass`, `blind-peering`, `hyperdb`, `hyperdispatch`, `hyperschema`, `make-dir`, and `protomux-wakeup`, together with their unused transitive dependencies.

| npm audit target | Before | After |
| --- | ---: | ---: |
| Shared packages | 0 | 0 |
| Desktop | 2 high | 0 |
| Headless | 10 total, including 1 critical | 0 |
| Mobile | 67 total, including 1 critical | 24 total; 0 critical, 8 high, 16 moderate |
| Desktop appling | 0 | 0 |
| Hardware serial bridge | 0 | 0 |
| Tools NAT simulator | No baseline lockfile | 0 |

Counts are affected dependency entries, not counts of independently exploitable flaws. Rust patched-vulnerability counts went from 2 to 0 for the host and 1 to 0 for firmware, with the warnings described above still present. No forced framework major upgrade or consensus-library substitution was made to silence audit output.

## Application of the weekly P2P report

| Report item | Applicability and outcome |
| --- | --- |
| [HyperDHT 6.34.0](https://github.com/holepunchto/hyperdht/releases/tag/v6.34.0) | Adopted. A private three-node DHT exercised **2,000 forced-relay connection/echo/disconnect cycles**, alternating graceful and abrupt closure. Guest, host, and relay socket pools returned to their post-warmup baseline of zero. A separate final 20-cycle run passed relay shutdown/restart injection: loss detection closed the client after **18,011 ms** using production-default keepalives, and a fresh relayed connection worked. The test's original five-second failure deadline was below the transport's loss-detection interval and was corrected to a 30-second acceptance ceiling; no production timeout was changed to obtain this result. Real TRY_LATER behavior remains untested. |
| [ble-swarm 2.3.0](https://github.com/holepunchto/ble-swarm/releases/tag/v2.3.0) | Listam does not use ble-swarm/L2CAP. It uses GATT provisioning through BLE PLX, Noble, and Web Bluetooth. Applied the disposable-session and terminal-refusal principles to those existing paths. Automated coverage includes 100 simulated mobile scan/background cycles and 100 simulated swarm lifecycle cycles. These are not the report's 50–100 physical-phone relink cycles. No automatic retry/cooldown machinery was added: provisioning remains an explicit attempt and terminal refusal stops it. |
| [blind-peering push limiter #85](https://github.com/holepunchto/blind-peering/pull/85) | No notification sender/wake pipeline consumes the previously declared package, so the unused dependency was removed. Future push work should coalesce by application/core and newest head, enforce bounded work, and discard queued work when the client closes. Installing a draft limiter would not create this missing application layer. |
| [Autobee rc.35](https://github.com/holepunchto/autobee/releases/tag/v2.0.0-rc.35) | Listam uses **Autobase**, not Autobee. Autobee's `busy` getter cannot be assumed to exist on this backend. Retained the stable current architecture; a separate Autobee experiment must first establish data/API compatibility, no-head bootstrap behavior, and a usable drain signal. |
| [Autobee unavailable hints #210](https://github.com/holepunchto/autobee/pull/210) | Its internal fix does not apply directly to Autobase. Applied the relevant local-read principle to shared-list catch-up: a missing block yields an incomplete result rather than waiting indefinitely or replacing visible state with a partial snapshot. The exact notification/offline-hint scenario is not implemented or proven by this test. |
| [Autobee trusted-head lookup #226](https://github.com/holepunchto/autobee/pull/226) | Bounded the existing lifecycle RPC and BLE workflow. A common deadline across future push bootstrap, trusted-head lookup, catch-up, and drain is still required. Swarms created after a suspend snapshot also need explicit lifecycle registration before this becomes a full mobile sleep coordinator. |
| [Bare Bluetooth Linux #13](https://github.com/holepunchto/bare-bluetooth/pull/13) | Retained the existing thin transport interface and optional Noble adapter. No dependency on a draft Linux API was introduced. A Linux-phone/Bare implementation remains a prototype task. |
| [Hypercore mark/sweep #863](https://github.com/holepunchto/hypercore/pull/863) | No aggressive per-sleep pruning was introduced. Over-quota helpers stop replication and retain existing data. Concurrent mark/clear/prune stress coverage is still needed before adopting frequent cache reclamation. |

## Settings review

Inspected desktop Settings and Diagnostics in a browser fixture and compared the settings presentation with `listam-desktop/design-guide/kinetic_minimalist/DESIGN.md` and its advanced-settings example. Confirmed the corrected “Copy key” label in the current source preview. The fixture is not a native Pear/Bluetooth test.

The report's networking changes belong in runtime lifecycle policy. Adding user-facing “safe to sleep,” push frequency, or Autobee toggles would currently promise capabilities the application does not implement. Socket counters were added to backend/operator diagnostics; the desktop's compact Diagnostics view is not a full socket dashboard. A future power-settings surface should distinguish queued work, active synchronization, drained state, and deadline expiry.

History flattening remains a manual operation with its existing explanation; it was not tied to backgrounding. Backups remain opt-in through the existing password flow. Existing user preferences and credentials were not changed. The current long settings dialog could be grouped using the design guide's advanced sections in a separate UI change, once actual power-management capabilities are defined. Mobile settings were reviewed in source; they were not visually verified on a physical phone.

## Validation and limits

| Check | Result |
| --- | --- |
| Shared-package CI, final run | **824 passed, 2 existing TODO regressions, 0 blocking failures**; 826 tests total |
| Desktop CI | 250 passed; lint passed. The six real-backend synchronization tests also passed after the final driver cleanup. |
| Mobile CI | Passed lint/type/dependency/security/i18n checks, 152 Node tests across its suites, and grocery checks. The three new hook tests run within the nine-test hook suite. |
| Mobile backend packaging | iOS and Android backend bundles rebuilt successfully. Full Xcode/Gradle native application builds were not run. |
| Headless CI | 50 passed, including a real replication/quota stop-and-recovery regression. |
| Rust host workspace | 57 passed, 2 pre-existing ignored tests. |
| ESP32 firmware | Locked release build of `leaf-esp32` succeeded; compiler warnings remain. No device flashed. |
| Serial bridge | Dependency imports and syntax passed. A missing-port run with isolated temporary storage shut down and exited 1 as expected. |
| Tools | 200-request listener regression and timeout regression passed; deploy-script shell syntax passed. |
| Website | All seven generated facts match source; JavaScript syntax passed; clean-URL desktop wiki navigation verified in the browser. |
| Lockfile consistency | All seven npm install targets passed `npm ci --dry-run --ignore-scripts`; mobile still emits an existing rich-editor React peer-version warning. |
| Source hygiene | All seven repositories passed `git diff --check`. |

The Docker daemon was unavailable, including after an attempted Docker app launch, so the randomized NAT/TRY_LATER matrix could not run. Private-loopback relay tests do not prove carrier-grade NAT behavior. Physical phone/ESP32 provisioning and background/relink cycles, real cross-device/mainnet testing, native app builds, and remote deployment verification remain release checks.

Detailed local logs and audit JSON are in `/tmp/listam-review-2026-09-05/`. Keep the shared-package and consumer updates together when preparing commits: the workspace uses local `file:` links, so an application lockfile alone does not publish the shared implementation.
