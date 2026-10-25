# Native chat usage-limit recovery: initial redesign thoughts

Date: 2026-10-24

Status: initial product and implementation guidance for a replacement; this document does not implement the redesign.

## Feedback and original change

- Feedback: https://stablygroup.slack.com/archives/C0BV03ZK1KN/p1792890988638819
- Original PR: https://github.com/stablyai/orca/pull/30396
- Author: Brennan Benson (`brennanb2025`).
- Squash commit: `4a33cd8e7308a362be793006f3ae411ab6e3aaaf`.

The enabled Continue button beside a usage-limit warning suggests it can resolve the warning immediately. Its tooltip instead says to use it once the limit resets, leaving the reader to decide whether the enabled action is useful. The timing requirement belongs in the behavior and visible copy.

The original implementation sends the ordinary user message `Continue where you left off.` immediately. It does not schedule work, wait for reset, or verify remaining quota. Its availability checks the latest failed turn and transport readiness, but does not compare the reported reset timestamp against the current time. A click before reset can hit the same limit again.

The immediate action requested is to revert the entire original PR and ask its author to redo the flow. That rollback also removes the PR's provider detection, reset-time presentation, and mobile changes; it is broader than hiding the button alone. Preserve unrelated changes made after that PR when resolving revert conflicts.

## Proposed replacement behavior

Prefer hiding the inline retry action until a usable, provider-reported reset time has passed. Keep ordinary manual messages available whenever the existing session transport permits them. Do not automatically send anything at reset time.

Before a known reset:

> Claude hit its weekly limit. It resets Tuesday at 1:00 PM.
> Send a message after it resets to resume.

There is no inline Continue button during the wait. Once the reported time passes, the latest unresolved limited turn can offer **Try again**, with wording such as:

> Claude hit its weekly limit. The reported reset time has passed.
> [Try again]

Passing a timestamp makes a retry reasonable; it does not prove quota is available. Avoid claims such as “Usage restored” or “Ready to continue.”

If reset time is unknown, do not invent a deadline. Under this conservative policy, omit the inline shortcut and explain how to check usage or billing and send a message when ready. Credits exhaustion may require a purchase or account change rather than waiting. Provider-specific recovery links must be supported by the actual failure and account context.

Early recovery through an upgrade, account/model change, or added credits remains possible through manual sending. A future explicit retry override could support that case, but it would need clear visible wording and a deliberate product decision.

Only label an action **Resume when limit resets** or **Schedule to resume** if it actually creates scheduled work with a visible scheduled state and cancellation. Scheduling introduces restart, remote-host, ownership, and newer-user-action semantics and should be designed separately.

## Technical approach for the replacement

The following references describe the code before the rollback. Reintroduce only the pieces the replacement needs, and check current equivalents before implementation.

1. Read structured failure evidence from the journal, including `usageLimit.resetsAt` as epoch milliseconds. Do not parse the displayed sentence or derive readiness from a rounded countdown.
2. Extend the latest-usage-limit-turn selection to retain the relevant limit information. Before rollback, `latestNativeChatUsageLimitCut` returned only `turnItemId`, discarding the reset information it read.
3. Derive retry availability from the latest unresolved limited turn, validated reset metadata, current time, and existing transport/pending-send/resume state. Do not persist a separate `resetFinished` flag.
4. Schedule UI updates around the deadline and reconcile on mount, visibility return, wake/reconnect, and relevant journal changes. Every callback must compare fresh time and current state; timer completion alone is not evidence of readiness.
5. Reuse the existing reset-clock machinery where appropriate. `useResetCountdownClock` schedules countdown boundaries, but needs its visibility/wake behavior considered. `useNow` explicitly warns that its initial snapshot can be stale for deadline decisions. Avoid a timer per historical warning or a per-second rerender of the whole transcript.
6. Recheck eligibility in the click handler using current state and fresh time. Use the ordinary send path, retain the composer draft and attachments, and clear only the previous action's error as appropriate.
7. Keep the source-turn identity on supported hosts. The host must validate that the chat has not moved on before queueing or sending, under the existing session mutation rules. The UI's time gate is a recovery affordance, not an authorization or quota-enforcement boundary.
8. Derive display state again on reopening. The wait requires no persisted job and no automatic backend send. Clean up timers/listeners when the session changes or the component unmounts.

Conceptual eligibility:

```text
latest relevant turn is a usage-limit failure
AND reset timestamp is usable
AND fresh current time >= reset timestamp
AND session can accept a new message
AND no send, queued request, or resume supersedes this action
```

## Edge cases and required decisions

| Case                                                                                             | Expected handling                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat stays open across reset                                                                     | Reveal Try again without refreshing, sending, stealing focus, or scrolling unexpectedly.                                                                                                                                                          |
| App restart, navigation, or reopened workspace                                                   | Recompute from journal metadata and current time; do not depend on a lost timer.                                                                                                                                                                  |
| Sleep, background tab, suspended mobile app, or throttled renderer                               | Reconcile when execution/visibility returns. Use fresh time rather than counting timer ticks.                                                                                                                                                     |
| System clock jumps forward or backward                                                           | Recompute and reschedule. Client clock error can make this estimate wrong; do not describe it as verified quota availability. Do not mistake an SSH host's time zone for clock skew.                                                              |
| Remote/client clock disagreement                                                                 | Preserve absolute provider timestamps. Any clock correction must have an explicit trusted basis; a host-time offset alone does not establish the provider's clock.                                                                                |
| Time zone, daylight-saving, locale, or midnight change                                           | Compare epoch values and format dates in the reader's current locale/time zone. Keep “today” and future/past wording current.                                                                                                                     |
| Reset timestamp is absent, zero, negative, non-finite, out of Date range, or implausibly distant | Treat as unknown. Validate before date formatting or timer scheduling; use bounded delays to avoid timer overflow.                                                                                                                                |
| Timestamp already passed when the failure is received                                            | A retry may be offered, but retain past-tense/estimated wording. A newly repeated rejection with a stale timestamp should not imply quota was restored.                                                                                           |
| Multiple exhausted windows                                                                       | Use the latest reset only when every known blocking window has a usable reset. If any blocking reset is unknown, readiness is unknown. The original Claude/Codex adapters attempted this aggregation; preserve that principle in the replacement. |
| Multiple or updated warning rows in the same turn                                                | Combine relevant evidence consistently; do not take the first row's earlier reset or render duplicate retry buttons. Use the same evidence for copy and eligibility.                                                                              |
| Provider sends a warning but the turn continues or succeeds                                      | Do not offer failure recovery based on a nonterminal warning. Restrict this action to the relevant failed root turn.                                                                                                                              |
| Temporary throttling, policy refusal, oversized prompt, or unrelated error                       | Do not classify these as account quota exhaustion without supporting provider evidence. Preserve ordinary error recovery.                                                                                                                         |
| Credits, monthly, model-specific, or unrecognized limits                                         | Avoid guessing a window or assuming every limit has a timed refill. Only name the window the evidence supports.                                                                                                                                   |
| User sends, steers, queues a message, rewinds, or another device advances the session            | Re-evaluate against the journal and existing request semantics. An old warning must not retain a stale recovery action.                                                                                                                           |
| Account/model changes, upgrade, paid overage, or added credits before reset                      | Do not treat the old failure as authoritative for the new selection. Manual sending stays available. Do not match unrelated account-level usage data to the chat without a reliable identity.                                                     |
| Connection lost, session unavailable, authentication expired, or transport blocked               | Preserve existing send restrictions even when the deadline passes. Show the appropriate recovery guidance.                                                                                                                                        |
| Double-click or multiple windows/devices                                                         | Local pending state prevents repeat clicks; supporting hosts must reject stale source turns before accepting work. Reuse existing operation IDs and receipt handling for retransmission.                                                          |
| Send accepted before journal update                                                              | Keep the action unavailable while the accepted/pending send owns the transition; do not briefly redisplay it.                                                                                                                                     |
| Send refused                                                                                     | Show a recoverable error, keep the draft, and derive any subsequent action from current state.                                                                                                                                                    |
| Delivery uncertain after disconnect                                                              | Warn that receipt could not be confirmed. Never automatically resend or claim the message was not delivered.                                                                                                                                      |
| Provider rejects again after the reported reset                                                  | Use the new failure evidence, explain the continued limit, and avoid automatic retry loops. The provider remains the authority.                                                                                                                   |
| Older paired server, desktop, phone, or saved history                                            | Missing optional metadata means unknown. Preserve readable fallback text and capability-gated fields. Older hosts lack the stronger turn-bound race check; do not promise identical concurrency guarantees.                                       |
| Partial history, reconnect, or delayed hydration                                                 | Do not offer recovery from an incompletely established latest turn. Reconcile once authoritative state arrives.                                                                                                                                   |
| Mobile and collapsed transcript                                                                  | Keep warning copy consistent across clients. Where a retry shortcut exists, use the same policy. Keep a relevant warning discoverable when work is collapsed without exposing actions on historical warnings.                                     |
| Git worktree versus folder workspace; macOS/Linux/Windows; local versus remote                   | This policy must not depend on git identity, OS-specific paths, focus APIs, or a local execution host.                                                                                                                                            |
| Accessibility                                                                                    | Put timing/recovery guidance in visible text. Tooltips are supplemental. Button appearance must not steal focus; after an admitted keyboard action, preserve the established composer-focus behavior.                                             |

## Verification for the replacement

Use deterministic time and meaningful state transitions rather than only asserting implementation details:

- Before, exactly at, and after reset, including mounting after the deadline.
- Reopen, sleep/background return, clock changes, changed reset metadata, and timer cleanup.
- Unknown/invalid timestamps and multiple blocking windows, including an unknown reset.
- A nonterminal warning, a successful turn, unrelated failure, historical warning, and multiple limit rows.
- A newer manual message, queued request, rewind, pending resume, and another client's successful continuation.
- Rapid repeated clicks, accepted-before-journal, refusal, uncertain delivery, and a repeated provider limit.
- Preservation of draft text, attachments, model/effort selection, and keyboard focus.
- Mixed client/server versions, remote execution, mobile copy, collapsed warnings, and locale/time-zone formatting.

Run relevant provider, journal/host-send, shared-policy, renderer, and mobile checks. For rendered Orca validation, use the repository's hidden-renderer/CDP workflow with `ORCA_BACKGROUND_LAUNCH=1`; do not activate desktop windows.
