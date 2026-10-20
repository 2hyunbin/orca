// One layout command or pane change written to the partitions that hold it, each restorable.

import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  LayoutApplyOutcome,
  LayoutCommand,
  LayoutEffects
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  applyCommandToSession,
  type LayoutLiveContext,
  type PaneLayoutChange
} from './terminal-pane-admission'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'
import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'

/** The runtime's side of a layout command: live facts in, the routed partition's effects out. */
export type LayoutCommandRun = {
  live?: LayoutLiveContext
  noteEffects?: (effects: LayoutEffects) => void
}

// A paused WSL move keeps its local rows as the quiesce left them.
export function keepFrozen(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  context: TerminalTopologyCommitContext
): WorkspaceSessionState {
  return hostId === LOCAL_EXECUTION_HOST_ID
    ? keepWslMoveFrozenSessionsForStore(session, context.getSession(hostId))
    : session
}

export function commitLayoutCommand(
  hostIds: readonly ExecutionHostId[],
  command: LayoutCommand,
  context: TerminalTopologyCommitContext,
  run: LayoutCommandRun
): DurableProfileStateMutation<LayoutApplyOutcome> {
  const changes = hostIds.map((hostId) => ({
    hostId,
    change: applyCommandToSession(hostId, context.getSession(hostId), command, run.live)
  }))
  const routed = changes[0]?.change.value
  if (!routed) {
    return { value: { ok: false, code: 'workspace_not_found' }, persist: false }
  }
  const effects = routed.ok ? changes[0]!.change.effects : undefined
  if (effects) {
    run.noteEffects?.(effects)
  }
  const writes = routed.ok
    ? changes.filter(({ change }) => change.value.ok && change.session !== null)
    : []
  if (writes.length === 0) {
    return { value: routed, persist: false }
  }
  const restores = writes.map(({ hostId, change }) =>
    writeRestorable(
      () => context.getSession(hostId),
      (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
      keepFrozen(hostId, change.session!, context)
    )
  )
  return { value: routed, rollback: () => restores.forEach((restore) => restore()) }
}

export function commitPaneChange<T>(
  hostId: ExecutionHostId,
  change: PaneLayoutChange<T>,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<T> {
  if (!change.session) {
    return { value: change.value, persist: false }
  }
  const restore = writeRestorable(
    () => context.getSession(hostId),
    (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
    keepFrozen(hostId, change.session, context)
  )
  return { value: change.value, rollback: restore }
}
