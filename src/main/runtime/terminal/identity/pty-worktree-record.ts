import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle
} from '../../../../shared/agent-detection'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { cloneAgentSessionOwnerBinding } from '../../../../shared/claimed-agent-pty-owner-snapshot'
import { advertisedUrlWatcher } from '../../../ports/advertised-url-watcher'
import { maxTimestamp } from '../../runtime-worktree-status-projection'
import type { RuntimeSyncedLeaf } from '../../../../shared/runtime-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import { inferWorktreeIdFromPtyId } from '../../runtime-worktree-path-identity'
import {
  recordPtySurfaceClaim,
  SURFACE_CLAIM_WITHOUT_STANDING
} from '../../pty-recorded-surface-topology'
import type { RuntimeTerminalIdentityOwner } from './terminal-identity-owner'

export type PtyWorktreeRecordUpdate = Partial<
  Pick<
    RuntimePtyWorktreeRecord,
    | 'connected'
    | 'lastOutputAt'
    | 'preview'
    | 'tabId'
    | 'paneKey'
    | 'surfaceRecordedAtGraphSequence'
    | 'title'
    | 'connectionId'
    | 'runtimeSessionOwned'
    | 'isWsl'
    | 'wslDistro'
    | 'incarnationId'
    | 'agentSessionOwners'
  >
>

export function recordPtyWorktree(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  worktreeId: string,
  state: PtyWorktreeRecordUpdate = {}
): RuntimePtyWorktreeRecord {
  let pty = identity.host.ptysById().get(ptyId)
  if (!pty) {
    const titleObservedAt = state.title ? identity.nextTitleObservationSequence() : null
    const connectionId = state.connectionId ?? parseAppSshPtyId(ptyId)?.connectionId ?? null
    const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
    const fallbackWslDistro =
      process.platform === 'win32' && connectionId === null && worktreePath
        ? parseWslUncPath(worktreePath)?.distro
        : undefined
    const wslDistro =
      connectionId === null
        ? (state.wslDistro ??
          identity.host.wslDistroByPtyId().get(ptyId) ??
          fallbackWslDistro ??
          null)
        : null
    pty = {
      ptyId,
      incarnationId: state.incarnationId ?? null,
      worktreeId,
      connectionId,
      runtimeSessionOwned: state.runtimeSessionOwned ?? false,
      isWsl: state.isWsl ?? null,
      wslDistro,
      tabId: state.tabId ?? null,
      paneKey: state.paneKey ?? null,
      // A PTY the runtime is meeting for the first time has no prior observation for a graph
      // statement to contradict, and the leaf map cannot answer for a pane no statement has ever
      // named — a headless workspace has no renderer graph at all. The next statement decides it.
      surfaceRecordedAtGraphSequence: Math.max(
        identity.host.graphSequence(),
        state.surfaceRecordedAtGraphSequence ?? identity.host.graphSequence()
      ),
      launchConfig: null,
      launchToken: null,
      launchIncarnationId: null,
      launchAgent: null,
      agentSessionOwners: (state.agentSessionOwners ?? []).map(cloneAgentSessionOwnerBinding),
      foregroundAgent: null,
      connected: state.connected ?? true,
      disconnectedAt: state.connected === false ? Date.now() : null,
      lastExitCode: null,
      lastExitCause: null,
      lastAgentStatus: null,
      lastAgentStatusObservedLive: false,
      lastAgentStatusStartedAtEpochMs: null,
      lastAgentStatusRichInvalidatedAtEpochMs: null,
      lastOscTitle: null,
      lastOscTitleAt: null,
      lastOscTitleEpochMs: null,
      managementTitle: null,
      managementTitleAt: null,
      controllerTitle: null,
      title: state.title ?? null,
      titleUpdatedAt: titleObservedAt,
      lastOutputAt: state.lastOutputAt ?? null,
      tailBuffer: [],
      tailTranscriptBuffer: [],
      tailTranscriptChars: 0,
      tailPartialLine: '',
      tailPendingAnsi: '',
      tailRedrawCursor: null,
      tailTruncated: false,
      tailLinesTotal: 0,
      preview: state.preview ?? '',
      waitBlockedAt: null
    }
    if (state.title) {
      identity.setPtyManagementTitleFromObservedTitle(pty, state.title, titleObservedAt ?? 0)
    }
    identity.host.ptysById().set(ptyId, pty)
    if (wslDistro) {
      identity.host.wslDistroByPtyId().set(ptyId, wslDistro)
    } else if (connectionId !== null) {
      // Why: restored SSH IDs can collide with stale local parser state; connection ownership must win before their first output is parsed.
      identity.host.wslDistroByPtyId().delete(ptyId)
    }
    // Why: restored/controller-discovered PTYs learn their worktree here without registerPty(), so URL enrichment must bind at this source.
    advertisedUrlWatcher.bindPty(ptyId, worktreeId)
    return pty
  }

  pty.worktreeId = worktreeId
  if (
    state.incarnationId !== undefined &&
    pty.incarnationId !== null &&
    state.incarnationId !== pty.incarnationId
  ) {
    pty.agentSessionOwners = []
  }
  if (state.incarnationId !== undefined) {
    if (pty.incarnationId && state.incarnationId && pty.incarnationId !== state.incarnationId) {
      identity.invalidatePtyIncarnationHandle(ptyId)
    }
    pty.incarnationId = state.incarnationId
  }
  if (state.agentSessionOwners !== undefined) {
    pty.agentSessionOwners = state.agentSessionOwners.map(cloneAgentSessionOwnerBinding)
  }
  if (state.connectionId !== undefined) {
    pty.connectionId = state.connectionId
    if (state.connectionId !== null) {
      pty.wslDistro = null
      identity.host.wslDistroByPtyId().delete(ptyId)
    }
  }
  if (state.runtimeSessionOwned !== undefined) {
    pty.runtimeSessionOwned = state.runtimeSessionOwned
  }
  if (state.isWsl !== undefined) {
    pty.isWsl = state.isWsl
  }
  if (state.wslDistro !== undefined) {
    pty.wslDistro = state.wslDistro
    if (state.wslDistro) {
      identity.host.wslDistroByPtyId().set(ptyId, state.wslDistro)
    } else {
      identity.host.wslDistroByPtyId().delete(ptyId)
    }
  }
  if (state.tabId !== undefined) {
    pty.tabId = state.tabId
  }
  if (state.paneKey !== undefined) {
    // A caller that does not say where the pane came from does not get graph standing for it:
    // the unsafe default is what let a persisted replay un-drop a pane (#18191).
    recordPtySurfaceClaim(
      pty,
      state.paneKey,
      state.surfaceRecordedAtGraphSequence ?? SURFACE_CLAIM_WITHOUT_STANDING
    )
  }
  if (state.connected !== undefined) {
    pty.connected = state.connected
    pty.disconnectedAt = state.connected ? null : (pty.disconnectedAt ?? Date.now())
  }
  if (state.lastOutputAt !== undefined) {
    pty.lastOutputAt = maxTimestamp(pty.lastOutputAt, state.lastOutputAt)
  }
  if (state.preview !== undefined && state.preview.length > 0) {
    pty.preview = state.preview
  }
  if (state.title !== undefined && state.title !== null && state.title.length > 0) {
    const observedAt = identity.nextTitleObservationSequence()
    pty.title = state.title
    pty.titleUpdatedAt = observedAt
    identity.setPtyManagementTitleFromObservedTitle(pty, state.title, observedAt)
  }
  // Why: recordPtyWorktree is the common lifecycle point for every path that resolves a PTY's worktree (renderer restore, controller list).
  advertisedUrlWatcher.bindPty(ptyId, worktreeId)
  return pty
}

export function makeRuntimePaneKey(
  leaf: Pick<RuntimeSyncedLeaf, 'tabId' | 'leafId' | 'paneRuntimeId'>
): string {
  return isTerminalLeafId(leaf.leafId)
    ? makePaneKey(leaf.tabId, leaf.leafId)
    : `${leaf.tabId}:${leaf.paneRuntimeId}`
}

export function getOrCreatePtyWorktreeRecord(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string
): RuntimePtyWorktreeRecord | null {
  const existing = identity.host.ptysById().get(ptyId)
  if (existing) {
    return existing
  }
  const inferredWorktreeId = inferWorktreeIdFromPtyId(ptyId)
  if (!inferredWorktreeId) {
    return null
  }
  // Why: daemon-backed PTY session IDs are prefixed with the worktree ID so mobile summaries survive renderer graph gaps and reloads.
  return identity.recordPtyWorktree(ptyId, inferredWorktreeId)
}

export function setPtyManagementTitleFromObservedTitle(
  pty: RuntimePtyWorktreeRecord,
  title: string | null | undefined,
  observedAt: number
): void {
  const trimmed = title?.trim()
  if (!trimmed) {
    return
  }
  if (isClaudeManagementTitle(trimmed)) {
    pty.managementTitle = trimmed
    pty.managementTitleAt = observedAt
    return
  }
  if (detectAgentStatusFromTitle(trimmed) !== null && observedAt >= (pty.managementTitleAt ?? -1)) {
    pty.managementTitle = null
    pty.managementTitleAt = null
  }
}

export function nextTitleObservationSequence(identity: RuntimeTerminalIdentityOwner): number {
  identity.host.setTitleObservationSequence(identity.host.titleObservationSequence() + 1)
  return identity.host.titleObservationSequence()
}
