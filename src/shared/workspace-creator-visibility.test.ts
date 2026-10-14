import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import type { WorkspaceOwnerProvenance } from './worktree/types'
import { normalizeWorkspaceCreatorProvenance } from './workspace-creator-provenance'
import {
  filterFolderWorkspacesFromOtherDevices,
  isWorkspaceCreatedBySomeoneElse
} from './workspace-creator-visibility'

function makeFolderWorkspace(
  id: string,
  creatorProvenance: FolderWorkspace['creatorProvenance']
): FolderWorkspace {
  return {
    id,
    projectGroupId: 'project',
    name: id,
    folderPath: `/tmp/${id}`,
    executionHostId: 'runtime:env-1',
    creatorProvenance,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('filterFolderWorkspacesFromOtherDevices', () => {
  it('uses the same client ownership rules as git workspaces', () => {
    const own = makeFolderWorkspace('own', {
      kind: 'paired-device',
      deviceId: 'device-a'
    })
    const other = makeFolderWorkspace('other', {
      kind: 'paired-device',
      deviceId: 'device-b'
    })
    const host = makeFolderWorkspace('host', { kind: 'host' })
    const legacy = makeFolderWorkspace('legacy', undefined)

    const result = filterFolderWorkspacesFromOtherDevices(
      [own, other, host, legacy],
      new Map([['env-1', 'device-a']])
    )

    expect(result.map((workspace) => workspace.id)).toEqual(['own', 'legacy'])
  })
})

describe('isWorkspaceCreatedBySomeoneElse', () => {
  const desktopOnServer = new Map([['server', 'desktop']])
  const phone = (onBehalfOf?: WorkspaceOwnerProvenance) => ({
    kind: 'paired-device' as const,
    deviceId: 'phone',
    ...(onBehalfOf ? { onBehalfOf } : {})
  })

  function hidden(creatorProvenance: unknown, runtimeOwnerEnvironmentId?: string): boolean {
    return isWorkspaceCreatedBySomeoneElse(
      { creatorProvenance, runtimeOwnerEnvironmentId },
      desktopOnServer
    )
  }

  it("keeps this desktop's own rows and its phones' rows", () => {
    expect(hidden({ kind: 'host' })).toBe(false)
    expect(hidden(phone({ kind: 'host' }))).toBe(false)
  })

  it('hides a local row another paired client or its phone created', () => {
    expect(hidden({ kind: 'paired-device', deviceId: 'laptop' })).toBe(true)
    expect(hidden(phone({ kind: 'paired-device', deviceId: 'laptop' }))).toBe(true)
  })

  it('keeps a legacy local phone row hidden: an older host never said whom the phone acted for', () => {
    expect(hidden(phone())).toBe(true)
  })

  it('keeps a server row this desktop or its relayed phone created', () => {
    expect(hidden({ kind: 'paired-device', deviceId: 'desktop' }, 'server')).toBe(false)
    expect(hidden(phone({ kind: 'paired-device', deviceId: 'desktop' }), 'server')).toBe(false)
  })

  it('hides a server row another client, its phone, or the server itself created', () => {
    expect(hidden({ kind: 'paired-device', deviceId: 'laptop' }, 'server')).toBe(true)
    expect(hidden(phone({ kind: 'paired-device', deviceId: 'laptop' }), 'server')).toBe(true)
    expect(hidden(phone({ kind: 'host' }), 'server')).toBe(true)
    expect(hidden({ kind: 'host' }, 'server')).toBe(true)
  })

  it('keeps rows with no creator, or on a server whose pairing is unknown', () => {
    expect(hidden(undefined)).toBe(false)
    expect(hidden(undefined, 'server')).toBe(false)
    expect(hidden({ kind: 'paired-device', deviceId: 'laptop' }, 'unpaired')).toBe(false)
  })
})

describe('normalizeWorkspaceCreatorProvenance', () => {
  it('keeps whom a phone acted for and drops a malformed one', () => {
    expect(
      normalizeWorkspaceCreatorProvenance({
        kind: 'paired-device',
        deviceId: 'phone',
        onBehalfOf: { kind: 'host', extra: 1 }
      })
    ).toEqual({ kind: 'paired-device', deviceId: 'phone', onBehalfOf: { kind: 'host' } })
    expect(
      normalizeWorkspaceCreatorProvenance({
        kind: 'paired-device',
        deviceId: 'phone',
        onBehalfOf: { kind: 'paired-device', deviceId: ' ' }
      })
    ).toEqual({ kind: 'paired-device', deviceId: 'phone' })
  })
})
