Draft title: test(browser): record blocked popup adapter prerequisites on Electron 43.7.8

## ELI5

An openerless popup can still inherit browser restrictions that disappear if it is reopened as an ordinary tab. Electron 43.7.8 does not expose enough synchronous information to distinguish the tested restricted and safe script popups, so this prerequisite remains **BLOCKED** and changes no production routing.

## What Changed

Added hidden Electron probes for actual adopted/native script children, restricted iframe controls, native link flags, missing adopted link contents, same-session parents, creation order and an unrelated-window admission reproducer. Replaced the single-listener native app mock with EventEmitter delivery and five explicit expected-failure assertions for the desired no-theft contract, plus a duplicate control. Reused the existing compatibility harness and included the new probe in Node runtime and the existing Linux boundary job.

## Why

A passing mock or a fresh callback closure cannot prove that Electron supplies the matching original child. Real probes show that the production native adapter can grant an admission to an unrelated same-session window, and that the restricted/escape script controls have indistinguishable synchronous metadata despite different browser-enforced behavior. Recording the API limits keeps routing changes behind the required gate until the API or presentation tradeoff is explicitly resolved.

## Linked Issue

Internal prerequisite to the supplied YouTube reauthentication design. No new issue was opened; the separate WebContentsView architecture investigation is not this change's scope.

## Visual Proof

N/A — production behavior and UI are unchanged. Hidden runtime observations and sanitized event/network traces are in [the evidence report](popup-adapter-prerequisite-evidence.md).

## Testing

- [x] I manually tested these changes locally through hidden synthetic Electron/CDP fixtures on macOS arm64.
- [x] Automated tests added/updated. Five named expected failures document unresolved admission contract violations; they are not passed release gates.

See the evidence report for exact candidate commit, commands, results, limitations and unexercised matrix rows. Native focus/visible windows, Linux/Windows runtime, SSH/server-hosted authentication, replacement-tab materialization, stress comparison and a fresh YouTube challenge remain unverified here.

## Review

**Do not treat this draft as approval to broaden popup routing.** Adopted association, native association, adopted script conversion safety and native script conversion safety are each **BLOCKED**. No production admission workaround is included.

## Agent skill upstream boundary

- [x] Not applicable, or this change copies or mechanically translates no upstream skill-installer source, tests, fixtures, registry entries, path tables, comments, or documentation.

## Notes

This is a local PR body prepared for the coordinator. No branch push, draft PR creation, GitHub comment or merge was performed by the worker. All app/test launches used `ORCA_BACKGROUND_LAUNCH=1`; no tokens or saved callbacks were replayed, and no remote/persistence schema changed.

## Checklist

- [x] This PR is small and focused on compatibility evidence and faithful mocks.
- [x] I explained what changed and why (ELI5, user behavior, mechanism and alternatives).
- [x] N/A with reason provided for production visual changes.
- [x] Self-reviewed for correctness, security and performance.
- [x] Cross-platform, SSH/remote and path/shortcut impact considered; actual untested environments are listed.
- [ ] Full repository lint/typecheck/test/build and remote CI were not all run; focused checks and their exact results are recorded in the evidence report.
