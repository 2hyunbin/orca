import type { TerminalTitleFactMeta } from '../../../../shared/terminal-output-side-effects'
import { detectAgentStatusFromTitle } from '../../../../shared/agent-detection'
import { terminalTitleBlocksExplicitAgentStatus } from '../../runtime-worktree-status-projection'
import type { ClaudeTerminalEvidence } from '../../../../shared/claude-terminal-interrupt'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function observeClaudeTerminalEvidence(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  evidence: ClaudeTerminalEvidence
): void {
  if (!output.host.onClaudeTerminalEvidence || output.host.ptysById.get(ptyId)?.connectionId) {
    return
  }
  for (const paneKey of output.host.collectPaneKeysForPty(ptyId)) {
    output.host.invokeClaudeTerminalEvidence(paneKey, evidence)
  }
}

export function applyTrackedPtyTitle(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  rawTitle: string,
  normalizedTitle: string,
  meta?: TerminalTitleFactMeta
): boolean {
  if (meta?.staleWorkingTitleClear) {
    return output.applyStaleWorkingTitleClear(ptyId, rawTitle, normalizedTitle)
  }
  output.host.observeClaudeTerminalEvidence(ptyId, { kind: 'title', title: rawTitle })
  // Why: status is detected from the RAW title (mirrors the renderer tracker),
  // so working/idle transitions are unaffected by normalization; the records
  // store the NORMALIZED title so rotating Grok/Pi/Gemini frames collapse to
  // one stable stored label (#7880) instead of churning `ps`/mobile tabs.
  //
  // Why the identity-only case: the bare cursor-agent literal identifies the pane without
  // asserting activity, so it records NO title/status evidence — only the tracker keeps it,
  // for display (#10258). Nulling the status here rather than trusting the detector keeps
  // that contract local, since every activity-gated effect below is keyed on status.
  const identityOnlyTitle = output.host.isLiveCursorNativeTitle(rawTitle, meta)
  const recordedTitle = identityOnlyTitle ? null : normalizedTitle
  const agentStatus = identityOnlyTitle ? null : detectAgentStatusFromTitle(rawTitle)
  // Why before retiring the clear: the lifecycle counts a turn from the status the clear showed.
  output.host.recordAgentPromptLifecycleState(ptyId, agentStatus)
  let ptyRecordChanged = false
  const pty = output.host.ptysById.get(ptyId)
  if (pty) {
    pty.titleDisplayClear = null
    const prevStatus = pty.lastAgentStatus
    const prevTitle = pty.lastOscTitle
    const observedAt = output.host.nextTitleObservationSequence()
    const observedAtEpochMs = identityOnlyTitle ? null : Date.now()
    pty.lastOscTitle = recordedTitle
    pty.lastOscTitleAt = identityOnlyTitle ? null : observedAt
    pty.lastOscTitleEpochMs = observedAtEpochMs
    pty.lastAgentStatus = agentStatus
    pty.lastAgentStatusObservedLive = true
    if (prevStatus === 'working' && agentStatus === null) {
      output.host.confirmPtyAgentExit(ptyId, true)
    }
    if (prevStatus !== agentStatus) {
      pty.lastAgentStatusStartedAtEpochMs = observedAtEpochMs
    }
    if (
      identityOnlyTitle ||
      terminalTitleBlocksExplicitAgentStatus(recordedTitle) ||
      (prevStatus !== null && agentStatus !== null && prevStatus !== agentStatus)
    ) {
      pty.lastAgentStatusRichInvalidatedAtEpochMs = observedAtEpochMs ?? Date.now()
    }
    if (identityOnlyTitle) {
      pty.managementTitle = null
      pty.managementTitleAt = null
    } else {
      output.host.setPtyManagementTitleFromObservedTitle(pty, normalizedTitle, observedAt)
    }
    ptyRecordChanged = prevTitle !== recordedTitle || prevStatus !== agentStatus
    // Why `!== 'permission'` rather than `!== 'idle'`: a name-only idle leaves the waiter
    // parked on its poll, so the later explicit idle is an idle→idle step that still has
    // to be offered. The resolve helper re-ranks and returns early when it is not yet
    // satisfying evidence, which is what the old edge guard was really protecting.
    // Why also gated on a change: the resolver settles only a blocked tail or strong
    // ready, and the poll catches either between title changes; repainted frames would
    // otherwise re-scan the pane tail for nothing.
    if (agentStatus === 'idle' && prevStatus !== 'permission' && ptyRecordChanged) {
      output.host.resolvePtyTuiIdleWaiters(pty, ptyId)
    }
    const shouldDelayMobileSnapshot =
      ptyRecordChanged &&
      output.host.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, normalizedTitle)
    let foregroundRefresh: Promise<boolean> | undefined
    // Why: gate on an actual status transition — braille spinner frames
    // mutate the title every tick, so probing per-title-change would stream
    // a foreground query per frame during active work.
    if (prevStatus !== agentStatus) {
      foregroundRefresh = output.host.ptyForegroundAgent.refresh(ptyId, observedAt)
    } else if (shouldDelayMobileSnapshot) {
      // Why: same-status compatible title changes can arrive before the
      // foreground owner probe settles; publishing them would flicker.
      foregroundRefresh = output.host.getPendingForegroundAgentRefreshForTitle(ptyId, observedAt)
    }
    if (foregroundRefresh && shouldDelayMobileSnapshot) {
      // Why: report "unchanged" so the per-chunk batch skips the mobile
      // snapshot fan-out; the delayed publish fires when the probe settles.
      ptyRecordChanged = false
      output.host.delayPtyBackedMobileSnapshotForForegroundAgent(
        ptyId,
        observedAt,
        foregroundRefresh
      )
    }
  }
  if (agentStatus === 'working' || agentStatus === 'permission') {
    output.host.orchestrationMailboxPointerDelivery.observeAgentWorking(ptyId)
  } else if (agentStatus === 'idle') {
    output.host.orchestrationMailboxPointerDelivery.observeAgentIdle(ptyId)
  }
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    // Why: keep the latest OSC title on the leaf so worktree.ps can
    // recompute status from the live title each call. Without this,
    // daemon-hosted terminals (no renderer pushing pane titles) had no
    // way to clear a stale 'working' status after the agent exited and
    // the shell took over the title — the stuck-spinner bug in #1437.
    const prevStatus = leaf.lastAgentStatus
    const prevObservedLive = leaf.lastAgentStatusObservedLive
    const prevLeafTitle = leaf.lastOscTitle
    leaf.lastOscTitle = recordedTitle
    leaf.lastOscTitleAt = identityOnlyTitle ? null : output.host.nextTitleObservationSequence()
    // Why: when a new OSC title doesn't classify as an agent state (e.g.
    // bare shell title after the agent exits), clear lastAgentStatus so
    // it is no longer sticky. Tui-idle waiters that needed the previous
    // 'idle' transition were already resolved at the moment of the
    // transition below; only fresh waiters registered after the agent
    // exits would observe the cleared value, and they correctly fall
    // back to title-based detection / polling.
    leaf.lastAgentStatus = agentStatus
    leaf.lastAgentStatusObservedLive = true
    // Why: resolve tui-idle on any transition TO idle (not just working→idle).
    // Claude Code may skip "working" entirely on fast tasks, going null→idle,
    // and the coordinator's tui-idle waiter would hang forever waiting for a
    // working→idle transition that never comes. Permission→idle is excluded:
    // it means the agent was blocked on user approval and the user said no,
    // which isn't a task-completion signal.
    // Why not `prevStatus !== 'idle'`: see the pty branch — the resolve helper re-ranks,
    // so an idle→idle step that upgrades weak evidence to explicit must still be offered.
    // Why the change gate: see the pty branch — repainted frames must not re-scan the tail.
    if (
      agentStatus === 'idle' &&
      prevStatus !== 'permission' &&
      (prevStatus !== agentStatus || prevLeafTitle !== recordedTitle)
    ) {
      output.host.resolveTuiIdleWaiters(leaf)
    }
    // Why the second condition: push delivery is gated on LIVE idle, so its
    // authorizing edge is liveness as well as status. A restore seed or a
    // status kept across a same-id respawn leaves a stale 'idle' behind, and
    // an agent whose first live title is already idle (claude --resume at its
    // prompt) then shows no transition — the row would strand, which is
    // exactly #12536. Waiter semantics stay transition-only above.
    // Why the title change joins the edge: a name-only frame routinely lands before the
    // hook's `X ready`, and it consumes the working→idle transition. The later ready title
    // is an idle→idle step, so gating delivery on `prevStatus !== 'idle'` meant the
    // strongest evidence this pane will ever emit never reached delivery at all. The
    // waiter branch above already re-offers on that step; the gate makes a repeat harmless.
    if (
      agentStatus === 'idle' &&
      (prevStatus !== 'idle' || !prevObservedLive || prevLeafTitle !== recordedTitle) &&
      output.host.checkDeliverySettledAndArmRecheck(leaf)
    ) {
      output.host.deliverPendingMessagesForLeaf(leaf)
    }
  }
  return ptyRecordChanged
}

export function applyStaleWorkingTitleClear(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  rawTitle: string,
  normalizedTitle: string
): boolean {
  const pty = output.host.ptysById.get(ptyId)
  if (!pty) {
    return false
  }
  const nativeStatus = pty.lastAgentStatus
  const clearedStatus = detectAgentStatusFromTitle(rawTitle)
  const observedAt = output.host.nextTitleObservationSequence()
  const previousTitle = pty.titleDisplayClear?.title ?? pty.lastOscTitle
  pty.titleDisplayClear = { title: normalizedTitle, observedAt, observedAtEpochMs: Date.now() }
  if (nativeStatus === 'working' && clearedStatus === null) {
    output.host.confirmPtyAgentExit(ptyId, true)
  }
  if (nativeStatus === clearedStatus) {
    return previousTitle !== normalizedTitle
  }
  const foregroundRefresh = output.host.ptyForegroundAgent.refresh(ptyId, observedAt)
  if (output.host.shouldDelayPtyBackedMobileSnapshotForForegroundAgent(pty, normalizedTitle)) {
    output.host.delayPtyBackedMobileSnapshotForForegroundAgent(ptyId, observedAt, foregroundRefresh)
    return false
  }
  return true
}
