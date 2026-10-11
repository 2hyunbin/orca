import { randomUUID } from 'node:crypto'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import type { RuntimeTerminalIdentityOwner } from './terminal-identity-owner'

export function preAllocateHandleForPty(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string
): string {
  const existing = identity.handleByPtyId.get(ptyId)
  if (existing) {
    return existing
  }
  const handle = identity.createPreAllocatedTerminalHandle()
  identity.handleByPtyId.set(ptyId, handle)
  return handle
}

export function createPreAllocatedTerminalHandle(): string {
  return `term_${randomUUID()}`
}

export function rememberPtyHandleReplacementFence(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  incarnationId: PtyIncarnationId,
  staleHandles: Iterable<string>,
  pendingRegistration: boolean
): void {
  const previous = identity.pendingPtyHandleReplacementFences.get(ptyId)
  const merged = new Set(previous?.staleHandles)
  for (const handle of staleHandles) {
    merged.add(handle)
  }
  // A PTY normally has one direct and one renderer alias. Keep a small bound
  // in case a malformed provider emits an unbounded alias stream.
  while (merged.size > 16) {
    const oldest = merged.values().next().value
    if (typeof oldest !== 'string') {
      break
    }
    merged.delete(oldest)
  }
  identity.pendingPtyHandleReplacementFences.set(ptyId, {
    incarnationId,
    staleHandles: merged,
    pendingRegistration
  })
}

export function registerPreAllocatedHandleForPty(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  handle: string
): void {
  if (identity.pendingPtyHandleReplacementFences.get(ptyId)?.staleHandles.has(handle)) {
    // The provider can replay the old env handle after announcing a new
    // incarnation. Never let that predecessor alias be reintroduced.
    return
  }
  const retained = identity.handleByPtyIncarnation.get(ptyId)
  if (retained?.handle === handle) {
    identity.handleByPtyIncarnation.delete(ptyId)
  } else {
    identity.invalidatePtyIncarnationHandle(ptyId)
  }
  identity.handleByPtyId.set(ptyId, handle)
  for (const leaf of identity.getLeavesForPty(ptyId)) {
    identity.adoptPreAllocatedHandle(leaf)
  }
}

export function adoptControllerTerminalHandle(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  handle: string | undefined,
  incarnationId?: string,
  options: { exactRestoredSurface?: boolean } = {}
): void {
  const trimmed = handle?.trim()
  if (!trimmed || !trimmed.startsWith('term_')) {
    return
  }
  const pty = identity.host.ptysById().get(ptyId)
  const changedIncarnation = Boolean(
    incarnationId && pty?.incarnationId && incarnationId !== pty.incarnationId
  )
  if (changedIncarnation) {
    const priorHandle = identity.handleByPtyId.get(ptyId)
    identity.invalidateAllHandlesForPty(ptyId)
    pty!.tabId = null
    pty!.paneKey = null
    // Reusing an exported handle would make stale client metadata name the replacement process.
    if (priorHandle === trimmed) {
      return
    }
  }
  if (identity.isTerminalHandleAdoptionBlocked(ptyId, trimmed)) {
    if (
      !options.exactRestoredSurface ||
      !identity.replaceSyntheticTerminalHandlesForRestoredPty(ptyId, trimmed) ||
      identity.isTerminalHandleAdoptionBlocked(ptyId, trimmed)
    ) {
      return
    }
  }
  // Why: after an app/runtime restart, the live PTY child still has its
  // original ORCA_TERMINAL_HANDLE, but the runtime's in-memory map is gone.
  identity.registerPreAllocatedHandleForPty(ptyId, trimmed)
}

export function issueHandle(
  identity: RuntimeTerminalIdentityOwner,
  leaf: RuntimeLeafRecord
): string {
  const leafKey = identity.getLeafKey(leaf.tabId, leaf.leafId)
  const existingHandle = identity.handleByLeafKey.get(leafKey)
  if (existingHandle) {
    const existingRecord = identity.handles.get(existingHandle)
    if (
      existingRecord &&
      existingRecord.rendererGraphEpoch === identity.host.rendererGraphEpoch() &&
      existingRecord.ptyId === leaf.ptyId &&
      existingRecord.ptyGeneration === leaf.ptyGeneration
    ) {
      return existingHandle
    }
  }

  const preAllocatedHandle = identity.adoptPreAllocatedHandle(leaf)
  if (preAllocatedHandle) {
    return preAllocatedHandle
  }
  const incarnationId = leaf.ptyId
    ? (identity.host.ptysById().get(leaf.ptyId)?.incarnationId ?? null)
    : null
  const retained = leaf.ptyId ? identity.handleByPtyIncarnation.get(leaf.ptyId) : undefined
  if (retained && leaf.ptyId && retained.incarnationId !== incarnationId) {
    identity.invalidatePtyIncarnationHandle(leaf.ptyId)
  } else if (retained) {
    identity.bindPtyIncarnationHandle(retained, leaf)
    return retained.handle
  }
  const handle = `term_${randomUUID()}`
  identity.syntheticTerminalHandles.add(handle)
  identity.handles.set(handle, {
    handle,
    runtimeId: identity.host.runtimeId(),
    rendererGraphEpoch: identity.host.rendererGraphEpoch(),
    worktreeId: leaf.worktreeId,
    tabId: leaf.tabId,
    leafId: leaf.leafId,
    ptyId: leaf.ptyId,
    ptyGeneration: leaf.ptyGeneration
  })
  identity.handleByLeafKey.set(leafKey, handle)
  if (leaf.ptyId) {
    identity.handleByPtyIncarnation.set(leaf.ptyId, { handle, incarnationId, leafKey })
  }
  return handle
}
