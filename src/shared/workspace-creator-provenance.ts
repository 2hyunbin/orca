import type { WorkspaceCreatorProvenance, WorkspaceOwnerProvenance } from './worktree/types'

function normalizeOwner(value: unknown): WorkspaceOwnerProvenance | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return undefined
  }
  if (value.kind === 'host') {
    return { kind: 'host' }
  }
  if (
    value.kind === 'paired-device' &&
    'deviceId' in value &&
    typeof value.deviceId === 'string' &&
    value.deviceId.trim().length > 0
  ) {
    return { kind: 'paired-device', deviceId: value.deviceId }
  }
  return undefined
}

export function normalizeWorkspaceCreatorProvenance(
  value: unknown
): WorkspaceCreatorProvenance | undefined {
  const creator = normalizeOwner(value)
  if (creator?.kind !== 'paired-device' || !value || typeof value !== 'object') {
    return creator
  }
  const onBehalfOf = 'onBehalfOf' in value ? normalizeOwner(value.onBehalfOf) : undefined
  return onBehalfOf ? { ...creator, onBehalfOf } : creator
}

/** Whose workspace it is: a phone's rows belong to whoever it acts for, other rows to their creator. */
export function workspaceOwnerOf(creator: WorkspaceCreatorProvenance): WorkspaceOwnerProvenance {
  if (creator.kind === 'host') {
    return creator
  }
  return creator.onBehalfOf ?? { kind: 'paired-device', deviceId: creator.deviceId }
}
