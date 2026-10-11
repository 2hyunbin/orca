import { randomUUID } from 'node:crypto'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { RuntimeTerminalIdentityOwner } from './terminal-identity-owner'

export function bindPtyIncarnationHandle(
  identity: RuntimeTerminalIdentityOwner,
  retained: PtyIncarnationHandleRecord,
  leaf: RuntimeLeafRecord
): void {
  const leafKey = identity.getLeafKey(leaf.tabId, leaf.leafId)
  if (retained.leafKey !== leafKey) {
    if (identity.handleByLeafKey.get(retained.leafKey) === retained.handle) {
      identity.handleByLeafKey.delete(retained.leafKey)
    }
    retained.leafKey = leafKey
  }
  identity.handles.set(retained.handle, {
    handle: retained.handle,
    runtimeId: identity.host.runtimeId(),
    rendererGraphEpoch: identity.host.rendererGraphEpoch(),
    worktreeId: leaf.worktreeId,
    tabId: leaf.tabId,
    leafId: leaf.leafId,
    ptyId: leaf.ptyId,
    ptyGeneration: leaf.ptyGeneration
  })
  identity.handleByLeafKey.set(leafKey, retained.handle)
}

export function invalidatePtyIncarnationHandle(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string
): void {
  const retained = identity.handleByPtyIncarnation.get(ptyId)
  if (!retained) {
    return
  }
  identity.handleByPtyIncarnation.delete(ptyId)
  if (identity.handleByLeafKey.get(retained.leafKey) === retained.handle) {
    identity.handleByLeafKey.delete(retained.leafKey)
  }
  identity.handles.delete(retained.handle)
  identity.syntheticTerminalHandles.delete(retained.handle)
  identity.host.rejectWaitersForHandle(retained.handle, 'terminal_handle_stale')
}

export function clearPtyIncarnationHandles(identity: RuntimeTerminalIdentityOwner): void {
  for (const retained of identity.handleByPtyIncarnation.values()) {
    identity.syntheticTerminalHandles.delete(retained.handle)
  }
  identity.handleByPtyIncarnation.clear()
}

export function reconcilePtyIncarnationHandles(identity: RuntimeTerminalIdentityOwner): void {
  for (const [ptyId, retained] of identity.handleByPtyIncarnation) {
    const pty = identity.host.ptysById().get(ptyId)
    const leaves = identity.getLeavesForPty(ptyId)
    // Why: a handle issued before the host reported the incarnation is un-fenced, so
    // learning it is not a replacement; only a known-to-different incarnation is.
    const incarnationReplaced =
      retained.incarnationId !== null &&
      pty !== undefined &&
      pty.incarnationId !== retained.incarnationId
    if (!pty || incarnationReplaced || leaves.length !== 1 || identity.handleByPtyId.has(ptyId)) {
      identity.invalidatePtyIncarnationHandle(ptyId)
      continue
    }
    retained.incarnationId = pty.incarnationId
    identity.bindPtyIncarnationHandle(retained, leaves[0])
  }
}

export function adoptPreAllocatedHandle(
  identity: RuntimeTerminalIdentityOwner,
  leaf: RuntimeLeafRecord
): string | null {
  if (!leaf.ptyId) {
    return null
  }
  const preAllocated = identity.handleByPtyId.get(leaf.ptyId)
  if (!preAllocated) {
    return null
  }
  const leafKey = identity.getLeafKey(leaf.tabId, leaf.leafId)
  identity.handles.set(preAllocated, {
    handle: preAllocated,
    runtimeId: identity.host.runtimeId(),
    rendererGraphEpoch: identity.host.rendererGraphEpoch(),
    worktreeId: leaf.worktreeId,
    tabId: leaf.tabId,
    leafId: leaf.leafId,
    ptyId: leaf.ptyId,
    ptyGeneration: leaf.ptyGeneration
  })
  identity.handleByLeafKey.set(leafKey, preAllocated)
  return preAllocated
}

export function issuePtyHandle(
  identity: RuntimeTerminalIdentityOwner,
  pty: RuntimePtyWorktreeRecord
): string {
  const retained = identity.handleByPtyIncarnation.get(pty.ptyId)
  if (retained?.incarnationId === pty.incarnationId) {
    return retained.handle
  }
  const existingHandle =
    identity.handleByPtyId.get(pty.ptyId) ?? identity.findHandleForPtyRecord(pty.ptyId)
  if (existingHandle) {
    const existingRecord = identity.handles.get(existingHandle)
    if (
      existingRecord &&
      existingRecord.runtimeId === identity.host.runtimeId() &&
      existingRecord.ptyId === pty.ptyId
    ) {
      identity.handleByPtyId.set(pty.ptyId, existingHandle)
      return existingHandle
    }
  }

  const handle = existingHandle ?? `term_${randomUUID()}`
  if (!existingHandle) {
    identity.syntheticTerminalHandles.add(handle)
  }
  const syntheticId = `pty:${pty.ptyId}`
  identity.handles.set(handle, {
    handle,
    runtimeId: identity.host.runtimeId(),
    rendererGraphEpoch: identity.host.rendererGraphEpoch(),
    worktreeId: pty.worktreeId,
    tabId: syntheticId,
    leafId: syntheticId,
    ptyId: pty.ptyId,
    ptyGeneration: 0
  })
  identity.handleByPtyId.set(pty.ptyId, handle)
  return handle
}

export function findHandleForPtyRecord(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string
): string | null {
  for (const [handle, record] of identity.handles) {
    if (
      record.runtimeId === identity.host.runtimeId() &&
      record.ptyId === ptyId &&
      record.tabId.startsWith('pty:')
    ) {
      return handle
    }
  }
  return null
}

export function invalidateLeafHandle(
  identity: RuntimeTerminalIdentityOwner,
  leafKey: string
): void {
  const handle = identity.handleByLeafKey.get(leafKey)
  if (!handle) {
    return
  }
  const record = identity.handles.get(handle)
  if (record?.ptyId && identity.handleByPtyIncarnation.get(record.ptyId)?.handle === handle) {
    identity.handleByPtyIncarnation.delete(record.ptyId)
  }
  identity.handleByLeafKey.delete(leafKey)
  identity.handles.delete(handle)
  identity.syntheticTerminalHandles.delete(handle)
  identity.host.rejectWaitersForHandle(handle, 'terminal_handle_stale')
}

export function adoptFirstPtyForLeafHandle(
  identity: RuntimeTerminalIdentityOwner,
  leafKey: string,
  ptyId: string | null,
  ptyGeneration: number
): boolean {
  const handle = identity.handleByLeafKey.get(leafKey)
  const record = handle ? identity.handles.get(handle) : null
  if (!handle || !record || record.ptyId !== null || ptyId === null) {
    return false
  }
  identity.handles.set(handle, { ...record, ptyId, ptyGeneration })
  return true
}

export function rememberDetachedPreAllocatedLeaves(identity: RuntimeTerminalIdentityOwner): void {
  for (const leaf of identity.host.leaves().values()) {
    if (leaf.ptyId && identity.handleByPtyId.has(leaf.ptyId)) {
      // Why: ORCA_TERMINAL_HANDLE is an agent identity, so CLI control survives renderer graph loss while the PTY is alive.
      identity.detachedPreAllocatedLeaves.set(leaf.ptyId, leaf)
    }
  }
}
