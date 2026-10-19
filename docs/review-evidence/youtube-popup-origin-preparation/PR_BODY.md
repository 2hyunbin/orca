<!-- Draft title: Keep popup origin chrome tied to committed documents -->

## ELI5

A popup could show the destination it hoped to load while its opener-written blank page was still running. Popup origin chrome now stays at `about:blank` until a document commits, then shows only that document's origin. Opaque error documents use a neutral label even when Electron retains the failed HTTPS URL.

## What Changed

Both the origin bar and native title use committed main-frame state, retain the prior label while another navigation is pending or canceled, and reuse the same safe origin formatter. Added hidden Electron coverage and a production renderer bridge/store/guest harness that records existing replacement-tab profile failures without changing tab behavior.

## Why

A requested URL, page title or load-completion event cannot establish which document is running. Reading Electron's committed frame state preserves existing popup contents and security settings without rebuilding the page or changing routing.

## Linked Issue

YouTube Studio reauthentication investigation; no existing issue link was supplied for this preparation. No new issue was opened.

## Visual Proof

Actual candidate CDP origin-bar images are retained outside Git at `/tmp/orca-youtube-popup-origin-proof/adopted-origin-pending.png` and `/tmp/orca-youtube-popup-origin-proof/adopted-origin-committed.png`. The coordinator has inspected these and can attach them when a PR is authorized. Baseline screenshot unavailable; baseline behavior is source-backed. Native title checks use hidden main-process snapshots, with visible/native-focus validation left to isolated display/CI.

## Testing

- [x] Hidden local Electron 43.7.8 checks on macOS; no visible windows or OS focus.
- [x] Focused presenter/materialization tests: 57 passed, 1 explicitly expected baseline failure, 2 future-contract TODOs.
- [x] Existing local/routed popup regressions: 49 passed.
- [x] Node and renderer typechecks; changed-file code quality.

Detailed scenarios and limits: [preparation evidence](./README.md).

## Review

Routing, association, URL/OAuth classification, replacement-tab authority/handoff and establishment-lifetime correction remain blocked on the prerequisite APIs. This draft does not fix YouTube reauthentication or establish fresh-YouTube success. No prerequisite code has been rebased into this branch, and no PR has been pushed or opened.

## Agent skill upstream boundary

- [x] Not applicable; no upstream skill source was copied.

## Notes

Sandboxing, isolation, route/remote wire and persistence formats remain unchanged. Server-hosted authentication, Linux/Windows runtime behavior and the final fresh YouTube flow remain unverified locally. The new Electron suites are assigned to the existing gated Linux boundary job; its aggregate and check names are unchanged.

## Checklist

- [x] Scope and mechanism explained; self-reviewed.
- [x] Actual candidate screenshots retained for later attachment, with missing baseline proof stated.
- [x] Cross-platform, folder/worktree and remote limits recorded.
- [ ] Full CI/build and isolated native-focus validation (future PR).
- [ ] Prerequisite conversion-safety gate and fresh YouTube challenge (dependent repair).
