import type { RuntimeTerminalIdentityOwner } from './terminal-identity-owner'

export function invalidateAllHandlesForPty(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  preserveHandle?: string
): Set<string> {
  const incarnationHandle = identity.handleByPtyIncarnation.get(ptyId)?.handle
  const preallocatedHandle = identity.handleByPtyId.get(ptyId)
  const invalidated = new Set<string>()
  if (incarnationHandle && incarnationHandle !== preserveHandle) {
    identity.handleByPtyIncarnation.delete(ptyId)
    invalidated.add(incarnationHandle)
  } else if (incarnationHandle) {
    // The retained handle no longer describes the old incarnation. Keep its direct alias,
    // when requested, but discard the incarnation-specific leaf record.
    identity.handleByPtyIncarnation.delete(ptyId)
  }
  if (preallocatedHandle && preallocatedHandle !== preserveHandle) {
    identity.handleByPtyId.delete(ptyId)
    invalidated.add(preallocatedHandle)
  }
  for (const [handle, record] of identity.handles) {
    if (record.ptyId === ptyId && handle !== preserveHandle) {
      invalidated.add(handle)
    }
  }
  for (const handle of invalidated) {
    identity.handles.delete(handle)
    identity.syntheticTerminalHandles.delete(handle)
    identity.host.rejectWaitersForHandle(handle, 'terminal_handle_stale')
  }
  for (const [leafKey, handle] of identity.handleByLeafKey) {
    if (invalidated.has(handle) || (preserveHandle !== undefined && handle === preserveHandle)) {
      identity.handleByLeafKey.delete(leafKey)
    }
  }
  if (preserveHandle !== undefined) {
    // The direct alias is the only identity retained across an incarnation
    // change. Renderer records point at the predecessor pane generation and
    // must be rebuilt by graph sync (or issuePtyHandle) before use.
    identity.handles.delete(preserveHandle)
    identity.syntheticTerminalHandles.delete(preserveHandle)
  }
  return invalidated
}

export function replaceSyntheticTerminalHandlesForRestoredPty(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  controllerHandle: string
): boolean {
  const boundHandles = new Set<string>()
  const directHandle = identity.handleByPtyId.get(ptyId)
  if (directHandle) {
    boundHandles.add(directHandle)
  }
  for (const [handle, record] of identity.handles) {
    if (record.ptyId === ptyId) {
      boundHandles.add(handle)
    } else if (handle === controllerHandle) {
      return false
    }
  }
  for (const [otherPtyId, handle] of identity.handleByPtyId) {
    if (otherPtyId !== ptyId && handle === controllerHandle) {
      return false
    }
  }
  for (const leaf of identity.getLeavesForPty(ptyId)) {
    const handle = identity.handleByLeafKey.get(identity.getLeafKey(leaf.tabId, leaf.leafId))
    if (handle) {
      boundHandles.add(handle)
    }
  }
  if (
    boundHandles.size === 0 ||
    [...boundHandles].some(
      (handle) => handle === controllerHandle || !identity.syntheticTerminalHandles.has(handle)
    )
  ) {
    return false
  }
  identity.invalidateAllHandlesForPty(ptyId)
  return true
}

export function isTerminalHandleAdoptionBlocked(
  identity: RuntimeTerminalIdentityOwner,
  ptyId: string,
  handle: string
): boolean {
  if (identity.handleByPtyId.get(ptyId) ?? identity.findHandleForPtyRecord(ptyId)) {
    return true
  }
  for (const leaf of identity.getLeavesForPty(ptyId)) {
    const issued = identity.handleByLeafKey.get(identity.getLeafKey(leaf.tabId, leaf.leafId))
    if (issued && issued !== handle) {
      return true
    }
  }
  const existingRecord = identity.handles.get(handle)
  if (existingRecord && existingRecord.ptyId !== ptyId) {
    return true
  }
  for (const [otherPtyId, otherHandle] of identity.handleByPtyId) {
    if (otherHandle === handle && otherPtyId !== ptyId) {
      return true
    }
  }
  return false
}
