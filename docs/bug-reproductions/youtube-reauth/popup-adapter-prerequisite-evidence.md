# Popup admission repair: original-child binding and scoped native delivery

## Completed admission repair (2026-10-19)

This repair starts from the substantial staged correction on `ef1584b867adf598b551cdf87b4424a4fd90007f` and integrates the justified native-window association and committed-origin behavior reviewed at `089dfb3e0dedb719befa6d114adc985ef3566436`. The older staged trace and both historical investigations below are preserved. Their failed contracts describe those candidates, not the repaired source. The checkpoint and both worktrees remain intact.

### Association and lifecycle

Script children still bind independently at `app.web-contents-created`, through the concrete child's public `opener` frame and `webContents.fromFrame`. The captured main frame must match that original source document. The app-wide BrowserWindow observer only looks up an already bound concrete child; it has no openerless fallback. Delivered script options never identify its request.

Native OpenURL instead uses the opener's prepended `did-create-window` listener. A private Symbol option carries the admission object itself through Electron's option spreads. The listener requires the exact current admission, no script opener, no bound script child and no previously discarded contents. Missing, foreign and reused identities reject that opener's own reported child. It consumes the callback once. App windows outside that scoped delivery receive neither the callback nor disposal, including foreign-session windows. No second request registry, queue, URL/title correlation or admission-turn timing heuristic is used.

This distinction follows [Electron's script staging](https://github.com/electron/electron/blob/v43.7.8/lib/browser/api/web-contents.ts#L686-L790) and [OpenURL's stack-local creation/options/continuation](https://github.com/electron/electron/blob/v43.7.8/lib/browser/guest-window-manager.ts#L49-L125). The runtime tests separately cover scripted creation and native links with unrelated app windows inserted inside the handler. Native navigation, POST bodies, referrer, initiator, cookies and inherited HTML sandbox behavior remain Chromium's own continuation; no navigation is replayed.

Overlap cancels the outstanding admission, stops/closes its known original and denies the overlapping request. Recovery follows confirmed original-child destruction or confirmed window delivery/rejection. It does not latch an opener-wide quarantine. There is no expiration timer. A genuinely unbound admission remains fenced while its source frame is live; only actual source-frame destruction can release that otherwise unidentified slot. Merely changing a URL, waiting, or observing a navigation event does not prove cancellation. Old bound/discarded children cannot take the successor's callback, even with its delivered options. Unit tests cover these adversarial cases; the source-frame teardown case is not claimed as a reproduced runtime overlap.

That residual unbound fence is intentional: the public handler exposes no cancellation identity/event before Electron wraps a child in [AddNewContents](https://github.com/electron/electron/blob/v43.7.8/shell/browser/api/electron_api_web_contents.cc#L1414-L1473). Clearing it while the same source frame remains live would permit an unidentified late child to consume the new admission. Unlike the staged quarantine, an observed canceled child and its opener recover normally. A new document only releases an unbound slot when the original frame is actually destroyed; a retained frame does not qualify.

### Network and title trust

Bound script children retain the temporary navigation fence until their own preparation. A navigation attempt before delayed window delivery cancels that child without replay. Rejection installs persistent navigation/descendant guards and calls `stop()` before asynchronous `close()`, with window destruction after construction. Existing local owner and route controllers still bind security, session, WebRTC and route ownership once.

Native OpenURL starts navigation before emitting `did-create-window`; its first navigation-start event is therefore earlier than policy installation. The repaired tests now measure the actual `session.webRequest.onBeforeRequest` boundary. Native route children have the correct route owner and `disable_non_proxied_udp` there, before the request proceeds. Failed route authority, WebRTC preparation and throwing close controls reach neither `onBeforeRequest` nor the destination server. These assertions replace the earlier assumption that native construction could be associated safely at the app-wide constructor notification.

Native titles start at `about:blank` and read only `mainFrame.url`/`mainFrame.origin` after commits/failures. Pending and failed redirect targets cannot lend their origins to an older document. Network URLs with opaque security origins show `unknown`; blank, data and error documents remain neutral. The common origin description was extracted unchanged from the existing origin bar and reused with the checkpoint's committed-frame description. Hostile page titles cannot replace the native trust title.

### Validation

Run from this checkout, with current-source fixture builds before every Electron launch:

```bash
ORCA_BACKGROUND_LAUNCH=1 ORCA_POPUP_FIXTURE_ARTIFACT_DIR=/tmp/orca-popup-repaired-final \
  pnpm test --no-file-parallelism \
  src/main/browser/browser-popup-native-window.test.ts \
  src/main/browser/browser-popup-adapter-compatibility.electron.test.ts \
  src/main/browser/browser-popup-compatibility.electron.test.ts \
  src/main/browser/browser-popup-native-compatibility.electron.test.ts \
  src/main/browser/browser-popup-background-compatibility.electron.test.ts \
  src/main/browser/browser-route-guest-popups.test.ts \
  src/main/browser/browser-manager-popup-child.test.ts \
  src/main/browser/browser-manager-popup-routing.test.ts \
  src/main/browser/browser-manager-popup-openerless-tab.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node
pnpm run check:code-quality:changed
```

Final results are recorded in [the repair trace](popup-admission-repair-electron-43.7.8-trace.json), including exact source and raw-artifact SHA-256 values. The focused run passes **141 tests in 9 files, with zero expected failures or skipped contracts**. Node typecheck passes **16,899 files**. Changed-code quality, targeted oxlint, formatting and `git diff --check` pass. The earlier staged report's three failing isolation contracts are now ordinary passing tests; their assertions remain binding.

Runtime cases include same/foreign-session unrelated windows during script and native-link creation, exact scripted request/original-name correspondence, held cancellation, late live delivery, overlap rejection and subsequent successful recovery. The three held originals make zero `onBeforeRequest` calls. The overlap sequence is allow A, deny B, confirmed A destruction, allow C with C's original child. The retained fixture delays the real private engine event; this is controlled fault injection, not a naturally reproduced overlap. Natural delivery, POST/referrer/cookie/initiator/sandbox and local/route controls also pass.

All runtime evidence is synthetic loopback data on **macOS arm64, Electron 43.7.8 / Chromium 150.0.7871.250**. Hidden CDP screenshots show the actual fixture pages and origin bar; native titles are verified through Electron state. The recorded windows are hidden and presentation-call lists are empty. No native OS chrome, foreground/native-focus behavior, full visible Orca UI, Windows/Linux runtime, remote SSH authentication or fresh YouTube challenge is claimed. Foreground readiness remains unit-tested. Existing route-session tests exercise proxy/authority ownership locally; no remote wire or persistence schema changed.

This completes the requested popup-admission repair. The older investigation's separate adopted-`createWindow` association and inherited-script-sandbox/tab-conversion questions remain outside this change; passing admission tests does not authorize broader URL/OAuth routing or claim a complete YouTube reauthentication solution. No push, PR publication or merge was performed.

## Superseded staged correction (2026-10-19)

This branch now changes production admission. The historical investigation below describes a different source candidate; its five expected failures and unchanged-production statements apply only to that candidate. The original committed trace remains historical evidence, not a trace of this correction.

The superseded `ef1584b867a` implementation generated request arguments and looked them up in `did-create-window` options. That does not establish original-child identity. [Electron 43.7.8 stores one script options/callback slot per opener and consumes it at later delivery](https://github.com/electron/electron/blob/v43.7.8/lib/browser/api/web-contents.ts#L630-L725). In the review's controlled real-engine delayed-delivery probe, original A received B's callback and B was rejected. Ordinary delivery did not reproduce this order naturally.

The correction removes those production arguments and uses the actual script `WebContents` observed at `app.web-contents-created`, resolved to its source through the public `opener` frame and `webContents.fromFrame`. Only one admission may remain unresolved per opener, through the matching concrete `BrowserWindow` creation. There is no queue or delivered-options lookup. Both local and route popup handlers check overlap before selecting another creation/tab path. On overlap, the adapter closes the bound original child, denies the new request, and blocks subsequent popup requests for that opener. An unresolved 30-second timeout also blocks that opener. Destroying the opener clears its state; timeout or guessed cancellation never lends a late child a fresh request's callback. A known bound child that actually emits `destroyed` can release the slot safely.

Holding Electron's real `-add-new-contents` delivery exposed another boundary: Chromium can start the original child's navigation before `BrowserWindow` construction. The adapter now installs temporary navigation guards on the bound original contents at creation. Ordinary synchronous construction removes them immediately before normal preparation. If a held child attempts navigation before preparation, the guards prevent it and its eventual window is rejected without replay. Native construction is hidden; admitted foreground/background windows present at readiness with their captured presentation policy, subject to the existing launch/authority/session checks.

The new runtime tests hold the actual engine child, identify it independently through its public contents ID and the renderer-assigned `window.name`, and never invent a child/options pairing. The overlap control admits A, withholds its delivery, denies B, and verifies that A is destroyed, neither callback runs, and neither original destination is requested. The cancellation control destroys A while delivery is withheld, then verifies that B alone gets its own original child and first request. A third control releases the genuinely late live original child after its attempted navigation was blocked and verifies rejection without a callback or destination request. Natural delivery now checks each request's callback ID against that child's eventual original name rather than comparing a sorted collection of names. The harness refuses to construct a window from a destroyed held child or missing hidden options.

### Unresolved blockers at the staged checkpoint

**This is still not a complete reauthentication repair or a merge-ready admission architecture.** Native OpenURL creation exposes no matching original contents in the handler and resumes its private navigation before `did-create-window`. Its synchronous fallback still selects an openerless app window created in the admission turn. A same-session unrelated window can therefore receive the callback, a foreign-session unrelated window can be closed, and multiple parents can prepare one notification. The existing three `KNOWN BLOCKER` expected-failure unit cases remain, and the real unrelated-window reproducer still asserts the violation. The actual unadmitted script child is now discarded, so the reproducer does not wait for its destination to load.

Safely removing that fallback requires an Electron API that exposes the actual native child before the continuation, or an explicit change to native navigation/presentation architecture. Another options marker, FIFO queue, title marker or asynchronous inspection cannot supply that guarantee. The adopted callback path and script sandbox/conversion-safety gates below remain outside this correction. No URL/OAuth classification was broadened, no authentication challenge was replayed, and no remote wire or persistence format changed. SSH/route session policy and folder workspace routing remain in the existing owners; Linux, Windows and server-hosted authentication were not exercised locally.

### Staged-checkpoint validation

Final correction checks on macOS arm64, Electron 43.7.8:

```bash
ORCA_BACKGROUND_LAUNCH=1 ORCA_POPUP_FIXTURE_ARTIFACT_DIR=/tmp/orca-popup-correction-final-painted \
  pnpm test --no-file-parallelism \
  src/main/browser/browser-popup-native-window.test.ts \
  src/main/browser/browser-popup-adapter-compatibility.electron.test.ts \
  src/main/browser/browser-popup-compatibility.electron.test.ts \
  src/main/browser/browser-popup-native-compatibility.electron.test.ts \
  src/main/browser/browser-popup-background-compatibility.electron.test.ts \
  src/main/browser/browser-route-guest-popups.test.ts \
  src/main/browser/browser-manager-popup-child.test.ts \
  src/main/browser/browser-manager-popup-routing.test.ts \
  src/main/browser/browser-manager-popup-openerless-tab.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node
pnpm run check:code-quality:changed
```

Result: **9 files passed; 124 tests passed and 3 expected failures, 127 total** (56.87 seconds). The adapter runtime file has 16 passing cases. Node typecheck passed for 16,897 files; changed-code quality reported zero new findings. Formatting and `git diff --check` passed. The expected failures remain failed admission contracts, not accepted behavior. Four additional foreground readiness assertions were then added, and `ORCA_BACKGROUND_LAUNCH=1 pnpm test src/main/browser/browser-popup-native-window.test.ts` passed with **32 passed and 3 expected failures**. No production or runtime-fixture code changed after the combined run.

Current evidence: [sanitized scripted-admission trace](popup-script-admission-correction-electron-43.7.8-trace.json), including exact source SHA-256 values and raw-artifact hash. The three held originals made zero session `onBeforeRequest` calls; cancellation produced only the successor callback, and late delivery/overlap produced neither callback. The final status reports hidden windows and zero presentation calls. The raw test artifact is under `/tmp/orca-popup-correction-final-painted` and is reproducible with the command above.

All final Electron launches build current source and use `ORCA_BACKGROUND_LAUNCH=1`; tests use hidden Electron/CDP and synthetic loopback data. Raw iframe probes now acknowledge mode changes and wait for the replacement iframe's painted state before real input; this addresses an observed missing-click admission flake without retrying the popup or weakening assertions. No native-focus or visible-window validation is claimed. Foreground readiness behavior is covered by policy unit tests; the new foreground presentation branch remains unverified on a visible desktop. Full repository checks, remote CI and unlisted environments were not run.

## Historical prerequisite investigation

The remainder of this report is retained for attribution to `c765bacac804846ad2b642981fcf7bc569796807`. References to “current”, “unchanged”, five expected failures and the failed prerequisite outcome in this section describe that historical candidate, not the correction above.

This is a compatibility investigation, not an implemented reauthentication repair. Production routing, popup admission, URL/OAuth classification, tab handoff, persistence and presentation policy are unchanged. Do not broaden routing on the strength of passing probe tests.

## Historical candidate and environment

- Branch: `youtube-popup-adapter-prerequisite`.
- Baseline: `37beafdd6da532d41ad2a1e13c84de9f309b2afd`.
- Tested source candidate: `c765bacac804846ad2b642981fcf7bc569796807`. Later evidence-only commits do not change the tested source.
- Runtime: installed Electron **43.7.8**, Chromium **150.0.7871.250**, macOS arm64.
- All launches/tests used `ORCA_BACKGROUND_LAUNCH=1`. Hidden windows and Playwright CDP supplied real input. The harness throws on window presentation/focus methods. No visible/native-focus test ran.
- Fixtures use synthetic loopback destinations and synthetic cookies. No YouTube challenge, saved callback, account data or authentication token was used.
- Evidence: [sanitized trace](popup-adapter-electron-43.7.8-trace.json). Sequence numbers retain original event order; ephemeral loopback ports are normalized to `PORT`, the synthetic session object is labeled instead of serialized, and repeated preferences are interned in `preferenceSnapshots`.

## Required gate verdicts

| Gate                                                                                                                                     | Adopted `createWindow`                                                                                                                                                                                                       | Native creation                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact association, cancellation isolation, bind once, captured claim/gesture/intent and policy before the matching child's first request | **BLOCKED**. Natural orders matched in raw probes; the required adversarial guarantee and immutable captured claim binding are not implemented/proven. A per-request closure is insufficient proof given Electron's staging. | **BLOCKED**. A real same-session unrelated app window consumed the production adapter's admission. Five desired-contract unit cases remain expected failures.    |
| Distinguish restricted openerless GET from replay-safe controls before discard/first request                                             | **BLOCKED** for script children: restricted/escape controls expose identical synchronous metadata/preferences. Missing OpenURL contents are a separate unsupported observation.                                              | **BLOCKED** for script children: the same indistinguishability holds. Native OpenURL link options expose a useful flag, but this does not solve script creation. |
| Existing regression checks                                                                                                               | **PASS** for the exercised hidden fixtures; see validation below.                                                                                                                                                            | **PASS** for the exercised hidden fixtures; expected admission failures are separately counted.                                                                  |

The current design therefore remains blocked on both creation paths. No supported synchronous mechanism sufficient for all required script-child distinctions was established. The coordinator was asked through orchestration and confirmed that the contract must remain binding pending an explicit API/presentation decision. No new preloads, semantic marker preferences, sandbox serialization, URL replay workaround or blanket window conversion were introduced into production.

## Observable sandbox result

Each script experiment opens an unnamed HTTP GET using `window.open(destination, '_blank', 'noopener')` from a real iframe. The restricted iframe has `sandbox="allow-scripts allow-popups"`, omitting both `allow-forms` and `allow-popups-to-escape-sandbox`. Controls add the escape token or omit sandboxing.

For **both actual supplied-contents adoption and native script creation**, the committed child has `window.opener === null`. Restricted children emit Chromium's blocked-form diagnostic and make zero form POST requests. Escape-token and unsandboxed children each submit successfully. Every observed child keeps effective `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` preferences; Electron's renderer sandbox is distinct from inherited HTML document sandbox flags.

Before navigation, restricted and escape script controls have the same handler details after removing only the intentionally distinct test destination. Both have an empty referrer, unnamed target, `noopener`, and foreground disposition. Their actual contents have the same initial frame origin and the same complete exposed `getLastWebPreferences()` snapshot. Adopted callback preferences also match after removing only the diagnostic request argument and session object. Neither exposed preference snapshot contains inherited document sandbox flags. The test argument appears in creation options but is omitted from `getLastWebPreferences()`; it is diagnostic telemetry, never an association or authority mechanism.

This proves openerlessness alone is insufficient and that these synchronous Electron surfaces cannot distinguish this restricted/safe pair. It does not claim that inspecting a mutable iframe DOM attribute, awaiting JavaScript/CDP, or guessing from referrer would be a valid substitute before first request.

For **native OpenURL Shift-link** creation, options contain `openerSandboxFlags: 4294836015` in the restricted control, and omit it in both safe controls. The real native child keeps the restriction and produces the same positive blocked-form diagnostic. With `createWindow` selected instead, the OpenURL callback receives **no contents** but does receive those options; Electron does not resume the returned contents' navigation. The fixture deliberately does not load the URL itself. There are zero target requests for all three adopted missing-contents controls. These are options/API observations, not proof of an adopted original child or safe replacement-tab materialization.

Baseline local production routing still dispatches the restricted non-OAuth script to the existing tab-open path and denies original creation. The dispatch is recorded once, with no original-child destination receipt. The fixture does not mount the replacement tab, so this does **not** prove materialization or observed loss of restrictions on a replacement page.

## Association and event order

The raw creation probes intentionally bypass URL routing to inspect Electron's boundary. They are not corrected production adapters. Same-parent identical URLs were exercised with ordinary, Shift and Cmd/Control intent, and two parents sharing one session opened identical destinations with distinct intents. Request callbacks/options and eventual original `window.name` values matched in the orders actually observed. This comparison uses known test stimulus order to check telemetry; production is not authorized to correlate by that order.

Observed script sequence: handler admission → child `web-contents-created` → adopted callback, or native `browser-window-created`/`did-create-window` → navigation events → session `onBeforeRequest` → commit/load. Each tested same-parent creation callback arrived before the next admission. The natural immediate-close/reopen probe delivered both creation callbacks before the renderer's close could cancel the first child. It therefore does **not** exercise missing-callback cancellation, delayed/reversed delivery, or establish that those orders are unreachable.

The raw observer installs the existing WebRTC restriction before returning supplied contents or handling native `did-create-window`. At the session's actual `onBeforeRequest`, the matching original child ID has that effective restriction. These are before-request assertions for the observed raw paths, not proof of the production adapter's full owner/document/registration/route authorization contract.

The real unrelated-window reproducer calls production `allowNativeBrowserPopup`, then constructs a separate hidden same-session BrowserWindow during admission. The adapter's prepended app-wide once listener marks that unrelated window and calls the request's `onCreated` with it. The actual popup has another contents ID and does not receive that callback. The fixture's callback only records the violation; it does not install full BrowserManager policies on the unrelated window. This nevertheless demonstrates that the production adapter authorizes the wrong actual window. Fixture cleanup is separate from adapter disposal.

Faithful EventEmitter unit delivery also exposes five desired-contract failures:

1. Reverse-delivered scripted A/B cannot both retain their captured admissions.
2. A late child attributed to canceled A consumes B's pending callback.
3. Two shared-session parents both prepare one app-wide notification.
4. An unrelated same-session window receives the admission callback.
5. An unrelated foreign-session window is closed/destroyed by the adapter.

These are named `KNOWN BLOCKER` `it.fails` cases, not accepted behavior. Cancellation/reverse-delivery cases are adversarial mocks, not claimed Electron runtime traces. The existing link/script interleaving control and a new duplicate `did-create-window` control pass. Mocks do not prove runtime association.

## Exact source limitations

- [Electron 43.7.8 web-contents.ts, 630–725](https://github.com/electron/electron/blob/v43.7.8/lib/browser/api/web-contents.ts#L630-L725) stores one opener-level script options/callback selection, then consumes it at later child delivery. Handler details have no request token or inherited sandbox flags.
- [Electron 43.7.8 guest-window-manager.ts, 21–115](https://github.com/electron/electron/blob/v43.7.8/lib/browser/guest-window-manager.ts#L21-L115) passes inherited OpenURL flags into construction options. Its custom `createWindow` branch returns without calling the private navigation continuation; native construction invokes that continuation before emitting `did-create-window`.
- [Electron 43.7.8 electron_api_web_contents.cc, 1319–1369](https://github.com/electron/electron/blob/v43.7.8/shell/browser/api/electron_api_web_contents.cc#L1319-L1369) associates staged preferences with newly created script contents. That internal association is not a public original-request token or sandbox-flag getter.
- [Electron 43.7.8 web_contents_preferences.cc, 370–390](https://github.com/electron/electron/blob/v43.7.8/shell/browser/web_contents_preferences.cc#L370-L390) returns a limited saved-preferences dictionary, omitting `additionalArguments` and inherited HTML sandbox flags. [WebFrameMain](https://www.electronjs.org/docs/latest/api/web-frame-main) exposes origin/frame identity and asynchronous script execution, not a synchronous effective sandbox flag getter.

## Validation and coverage

`browser-popup-adapter-compatibility.electron.test.ts` has 12 passing cases (five per-path parameterized pairs and two single cases):

- `records same-parent identical URLs with foreground, background and window intent`
- `records two parents sharing a session with distinct simultaneous intent`
- `records immediate close, then reopen without inferring cancellation from delivery order`
- `cannot distinguish inherited script restrictions synchronously`
- `exposes inherited flags on native OpenURL link options only`
- `records baseline early tab dispatch for the restricted script with zero original-child requests`
- `reproduces production native admission attaching to an unrelated same-session app window`

The final commands and results are recorded below. Existing local/route fixtures cover original POST bodies/cookies/referrer behavior, effective security preferences, native/adopted preparation failures, descendants, route authority/WebRTC preparation, origin-title protection, minimum size and background launch. They do not validate new captured-document claims or delayed replacement-tab materialization.

Not closed by this prerequisite: stale owner/root commits at held adapter boundaries; retirement/re-registration/profile/route identity captured through binding; actual reversed/delayed native-link versus script delivery; cancellation before child delivery; actual duplicate notifications; adopted adversarial association; first-request discard with replacement dispatch held; renderer store/guest materialization and selection; stress/resource comparison; broader folder/SSH/server-hosted authentication; or a fresh YouTube challenge. The remaining repair matrix, committed-origin changes and visible/native-focus checks are outside this evidence-only result. No remote wire or persistence schema changed.

### Final checks

At source candidate `c765bacac804846ad2b642981fcf7bc569796807`:

```bash
ORCA_BACKGROUND_LAUNCH=1 ORCA_POPUP_FIXTURE_ARTIFACT_DIR=/tmp/orca-popup-adapter-final-evidence \
  pnpm test --no-file-parallelism \
  src/main/browser/browser-popup-adapter-compatibility.electron.test.ts \
  src/main/browser/browser-popup-native-window.test.ts \
  src/main/browser/browser-popup-compatibility.electron.test.ts \
  src/main/browser/browser-popup-native-compatibility.electron.test.ts \
  src/main/browser/browser-popup-background-compatibility.electron.test.ts \
  src/main/browser/browser-route-guest-popups.test.ts
```

Result: **6 files passed; 94 tests passed and 5 expected failures, 99 total** (68.85 seconds). The expected failures remain failed release-contract cases even though Vitest treats an expected failure as a successful test execution.

```bash
ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node
ORCA_BACKGROUND_LAUNCH=1 pnpm test \
  config/scripts/vitest-node-runtime-boundary.test.ts \
  config/scripts/vitest-runtime-boundary.test.ts \
  config/scripts/ci-unit-exclusion-coverage.test.mjs \
  config/scripts/pr-code-change-scope.test.mjs
pnpm run check:code-quality:changed
```

Node typecheck: **PASS**. Runtime/CI routing: **4 files, 51 tests passed**. The first routing check found a missing package-change trigger for the new test; its exact path was added to `pr-package-test-paths.mjs` and the checks rerun successfully. That final routing-list correction is separate from the tested popup source commit and changes no popup code. Changed-file quality: **PASS**, zero new findings. Commit hooks also passed targeted oxlint, React Doctor lint and formatting; `git diff --check` passed. Full repository lint/build, other typecheck projects and remote CI were not run.

The new test is excluded from ordinary sharded unit discovery, uses the Node runtime under Bun, and is named in the existing Linux lifecycle boundary step with background launch set. Workflow job names, `verify` dependencies and aggregate failure handling are unchanged. No claim is made that the remote workflow has already passed.

Local PR text is [prepared here](popup-adapter-prerequisite-pr.md). No GitHub draft URL exists: the coordinator explicitly owns publishing. The requested implementation is **not complete**; both association paths and both script conversion-safety paths remain **BLOCKED**, so the worker outcome is **failed**.
