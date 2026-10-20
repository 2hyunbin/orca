Draft title: fix(browser): bind popup admission to the original child and opener

## ELI5

An unrelated app window could take a popup's handling, and overlapping opens could disable later popups for the rest of the page's lifetime. Only the originating child now receives its handling; overlap cancels safely and later requests recover after the original is accounted for.

## What Changed

Kept the staged original-script-child binding and navigation fence. Replaced openerless app-wide native admission with the opener's own creation event and a consumed-once private identity. Removed the synchronous candidate set, expiry timers and sticky quarantine. Recovery follows confirmed child/window/source-frame lifecycle. Reused the checkpoint's committed-frame title behavior, including neutral blank/opaque/error states, and stop navigation before asynchronously closing rejected contents.

## Why

Electron reuses script options, so those options cannot establish the original child. Native OpenURL instead has a scoped event with stack-local options; it can keep Chromium's POST/referrer/sandbox continuation. Using each existing association avoids a queue, replay, timing guesses and a second request registry. Unidentified admissions remain fenced until their original frame is actually destroyed, because elapsed time cannot establish cancellation.

## Linked Issue

Internal popup-admission review handoff. No issue was opened.

## Visual Proof

[Hidden Electron/CDP evidence and limits](popup-adapter-prerequisite-evidence.md). Synthetic fixture pages/origin bars were rendered and inspected; native titles were read through Electron. Foreground/native-focus and visible app/native chrome validation remain for an isolated display or CI. No remote attachment was published.

## Testing

- [x] Nine requested suites: 141 tests passed, zero expected failures.
- [x] Real Electron suites ran without file parallelism with `ORCA_BACKGROUND_LAUNCH=1`; fixtures rebuild current source before launch.
- [x] Same/foreign-session unrelated-window isolation on script and native-link paths; callback consumption, old-child/successor isolation, overlap/cancellation/recovery, title trust and first-request failure fences.
- [x] Local/route POST bodies, referrer, cookies, initiator/sandbox semantics and route owner/WebRTC policy before `onBeforeRequest`.
- [x] Node typecheck (16,899 files), changed-code quality, targeted oxlint, formatting and diff whitespace checks.

## Review

The three former expected-failure isolation contracts are ordinary passing assertions. Controlled engine-event delay remains explicitly distinguished from natural overlap. Native policy assertions now use the actual first-network-request boundary, because native navigation-start precedes its scoped creation event. No test contract was waived.

## Agent skill upstream boundary

- [x] Not applicable: no upstream skill implementation or resources copied.

## Notes

An admission whose child has never been observed remains fenced while its original source frame lives. Bound-child cancellation and rejected-window delivery recover without retiring the opener. Windows/Linux runtime, remote SSH authentication, foreground/native-focus and a fresh YouTube challenge were not exercised. The separate adopted-path and inherited-script-sandbox conversion questions remain outside this admission repair. URL classification, remote protocols and persistence formats are unchanged.

## Checklist

- [x] Explained before/after behavior, mechanism and alternative tradeoffs.
- [x] Self-reviewed the change and retained staged corrections/evidence.
- [x] Focused validation passed; full repository build/lint/test and remote CI were not run.
- [ ] Visible app/native chrome before/after proof remains for an isolated display or CI.

No push, PR publication or merge is requested or performed.
