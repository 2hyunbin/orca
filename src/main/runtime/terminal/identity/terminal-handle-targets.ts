import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveTerminalIdentityFromProbes,
  type RuntimeTerminalIdentity
} from '../../terminal-identity-probe'
import type { RuntimeTerminalIdentityOwner } from './terminal-identity-owner'

export function getLiveLeafForHandle(
  identity: RuntimeTerminalIdentityOwner,
  handle: string
): {
  record: TerminalHandleRecord
  leaf: RuntimeLeafRecord
} {
  identity.host.assertGraphReady()
  const record = identity.handles.get(handle)
  if (!record || record.runtimeId !== identity.host.runtimeId()) {
    // A structured worker's handle is not stale — nothing went dead. It names a live agent
    // session that simply has no terminal, and saying `terminal_handle_stale` sent callers
    // hunting for a remint that will never exist. Read paths (`terminal read`,
    // `isTerminalRunningAgent`, the identity probe) answer for it BEFORE reaching here.
    throw identity.host.structuredTerminalRefusal(handle)
  }
  if (record.rendererGraphEpoch !== identity.host.rendererGraphEpoch()) {
    throw new Error('terminal_handle_stale')
  }

  const leaf = identity.host.leaves().get(identity.getLeafKey(record.tabId, record.leafId))
  if (!leaf || leaf.ptyId !== record.ptyId || leaf.ptyGeneration !== record.ptyGeneration) {
    throw new Error('terminal_handle_stale')
  }
  return { record, leaf }
}

export function getLivePtyForHandle(
  identity: RuntimeTerminalIdentityOwner,
  handle: string
): {
  record: TerminalHandleRecord
  pty: RuntimePtyWorktreeRecord
} | null {
  let record = identity.handles.get(handle)
  if (!record) {
    const ptyId = [...identity.handleByPtyId.entries()].find(
      ([, mappedHandle]) => mappedHandle === handle
    )?.[0]
    const pty = ptyId ? identity.host.ptysById().get(ptyId) : null
    if (pty) {
      // Why: graph reload clears renderer handle records, but runtime-owned PTY handles remain the caller's control identity.
      identity.issuePtyHandle(pty)
      record = identity.handles.get(handle)
    }
  }
  if (
    !record ||
    record.runtimeId !== identity.host.runtimeId() ||
    !record.tabId.startsWith('pty:')
  ) {
    return null
  }
  if (!record.ptyId) {
    return null
  }
  const pty = identity.host.ptysById().get(record.ptyId)
  if (!pty || pty.ptyId !== record.ptyId) {
    return null
  }
  // Why: renderer adoption can race with CLI reads; keep ptyId → handle populated so summaries don't mint a second handle for the same terminal.
  identity.handleByPtyId.set(record.ptyId, handle)
  return { record, pty }
}

export function assertLiveTerminalHandleTargetsPty(
  identity: RuntimeTerminalIdentityOwner,
  handle: string,
  expectedPtyId: string
): void {
  const runtimePty = identity.getLivePtyForHandle(handle)
  if (runtimePty) {
    if (runtimePty.pty.ptyId !== expectedPtyId) {
      throw new Error('terminal_handle_stale')
    }
    return
  }
  const { leaf } = identity.getLiveLeafForHandle(handle)
  if (leaf.ptyId !== expectedPtyId) {
    throw new Error('terminal_handle_stale')
  }
}

export function getPtyRecordForPaneKey(
  identity: RuntimeTerminalIdentityOwner,
  paneKey: string
): RuntimePtyWorktreeRecord | null {
  const parsed = parsePaneKey(paneKey)
  let leafPty: RuntimePtyWorktreeRecord | null = null
  if (parsed) {
    const leaf = identity.host.leaves().get(identity.getLeafKey(parsed.tabId, parsed.leafId))
    const pty = leaf?.ptyId ? identity.host.ptysById().get(leaf.ptyId) : undefined
    if (pty?.connected) {
      return pty
    }
    leafPty = pty ?? null
    for (const candidate of identity.host.leaves().values()) {
      if (candidate.leafId !== parsed.leafId || !candidate.ptyId) {
        continue
      }
      const remintedPty = identity.host.ptysById().get(candidate.ptyId)
      if (remintedPty?.connected) {
        return remintedPty
      }
      leafPty ??= remintedPty ?? null
    }
  }
  let newestMatch: RuntimePtyWorktreeRecord | null = null
  for (const pty of identity.host.ptysById().values()) {
    const ptyPane = parsePaneKey(pty.paneKey ?? '')
    if (pty.paneKey === paneKey || (parsed && ptyPane && parsed.leafId === ptyPane.leafId)) {
      if (pty.connected) {
        return pty
      }
      newestMatch = pty
    }
  }
  return leafPty ?? newestMatch
}

export function getPaneKeyForTerminalHandle(
  identity: RuntimeTerminalIdentityOwner,
  handle: string
): string | null {
  const livePty = identity.getLivePtyForHandle(handle)
  if (livePty?.pty.paneKey) {
    return livePty.pty.paneKey
  }
  const record = identity.handles.get(handle)
  if (!record || record.runtimeId !== identity.host.runtimeId()) {
    return null
  }
  if (!isTerminalLeafId(record.leafId)) {
    return null
  }
  return makePaneKey(record.tabId, record.leafId)
}

export function getTerminalWorktreeIdForHandle(
  identity: RuntimeTerminalIdentityOwner,
  handle: string
): string | null {
  const livePty = identity.getLivePtyForHandle(handle)
  if (livePty?.pty.worktreeId) {
    return livePty.pty.worktreeId
  }
  const record = identity.handles.get(handle)
  if (!record || record.runtimeId !== identity.host.runtimeId()) {
    return null
  }
  return record.worktreeId
}

export function resolveTerminalIdentity(
  identity: RuntimeTerminalIdentityOwner,
  handle: string
): RuntimeTerminalIdentity {
  return resolveTerminalIdentityFromProbes(handle, {
    isLiveStructuredWorker: () => identity.host.isLiveStructuredWorker(handle),
    hasLivePty: () => Boolean(identity.getLivePtyForHandle(handle)),
    assertLiveLeaf: () => {
      identity.getLiveLeafForHandle(handle)
    }
  })
}

export function leafExistsForPty(identity: RuntimeTerminalIdentityOwner, ptyId: string): boolean {
  return (identity.host.leavesByPtyId().get(ptyId)?.length ?? 0) > 0
}

export function getLeavesForPty(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string
): RuntimeLeafRecord[] {
  return identity.host.leavesByPtyId().get(ptyId) ?? []
}

export function getLeafKey(tabId: string, leafId: string): string {
  return `${tabId}::${leafId}`
}
