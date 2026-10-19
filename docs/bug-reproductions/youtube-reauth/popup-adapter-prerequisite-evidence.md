# Popup adapter prerequisite: BLOCKED

This is a compatibility investigation, not an implemented reauthentication repair. Production routing, popup admission, URL/OAuth classification, tab handoff, persistence and presentation policy are unchanged. Do not broaden routing on the strength of passing probe tests.

## Candidate and environment

- Branch: `youtube-popup-adapter-prerequisite`.
- Baseline: `37beafdd6da532d41ad2a1e13c84de9f309b2afd`.
- Tested source candidate: `c765bacac804846ad2b642981fcf7bc569796807`. Later evidence-only commits do not change the tested source.
- Runtime: installed Electron **43.7.8**, Chromium **150.0.7871.250**, macOS arm64.
- All launches/tests used `ORCA_BACKGROUND_LAUNCH=1`. Hidden windows and Playwright CDP supplied real input. The harness throws on window presentation/focus methods. No visible/native-focus test ran.
- Fixtures use synthetic loopback destinations and synthetic cookies. No YouTube challenge, saved callback, account data or authentication token was used.
- Evidence: [sanitized trace](popup-adapter-electron-43.7.8-trace.json). Sequence numbers retain original event order; ephemeral loopback ports are normalized to `PORT`, the synthetic session object is labeled instead of serialized, and repeated preferences are interned in `preferenceSnapshots`.

## Required gate verdicts

| Gate | Adopted `createWindow` | Native creation |
| --- | --- | --- |
| Exact association, cancellation isolation, bind once, captured claim/gesture/intent and policy before the matching child's first request | **BLOCKED**. Natural orders matched in raw probes; the required adversarial guarantee and immutable captured claim binding are not implemented/proven. A per-request closure is insufficient proof given Electron's staging. | **BLOCKED**. A real same-session unrelated app window consumed the production adapter's admission. Five desired-contract unit cases remain expected failures. |
| Distinguish restricted openerless GET from replay-safe controls before discard/first request | **BLOCKED** for script children: restricted/escape controls expose identical synchronous metadata/preferences. Missing OpenURL contents are a separate unsupported observation. | **BLOCKED** for script children: the same indistinguishability holds. Native OpenURL link options expose a useful flag, but this does not solve script creation. |
| Existing regression checks | **PASS** for the exercised hidden fixtures; see validation below. | **PASS** for the exercised hidden fixtures; expected admission failures are separately counted. |

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

- [Electron 43.7.8 web-contents.ts, 674–775](https://github.com/electron/electron/blob/v43.7.8/lib/browser/api/web-contents.ts#L674-L775) stores one opener-level script options/callback selection, then consumes it at later child delivery. Handler details have no request token or inherited sandbox flags.
- [Electron 43.7.8 guest-window-manager.ts, 24–123](https://github.com/electron/electron/blob/v43.7.8/lib/browser/guest-window-manager.ts#L24-L123) passes inherited OpenURL flags into construction options. Its custom `createWindow` branch returns without calling the private navigation continuation; native construction invokes that continuation before emitting `did-create-window`.
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
