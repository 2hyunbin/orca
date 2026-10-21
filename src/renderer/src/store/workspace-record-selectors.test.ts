import { describe, expect, it } from 'vitest'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from './types'
import { makeFolderWorkspace, makeWorktree } from './slices/worktrees-slice-test-fixtures'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorkspace,
  selectWorkspaceByHostTarget,
  selectWorkspaces,
  selectWorktreeRowsByBareId,
  selectWorktreesByRepo
} from './workspace-record-selectors'

const SHARED_ID = 'repo-1::/work/orca'
const localRow = makeWorktree({ id: SHARED_ID, repoId: 'repo-1', hostId: 'local' })
const sshRow = makeWorktree({ id: SHARED_ID, repoId: 'repo-1', hostId: 'ssh:build-box' })
const otherRepoRow = makeWorktree({ id: 'repo-2::/work/api', repoId: 'repo-2', hostId: 'local' })
const folder = makeFolderWorkspace({ id: 'folder-1', executionHostId: 'local' })

function makeState(
  overrides: Partial<Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>> = {}
): Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces' | 'detectedWorktreesByRepo'> {
  return {
    worktreesByRepo: { 'repo-1': [localRow, sshRow], 'repo-2': [otherRepoRow] },
    folderWorkspaces: [folder],
    detectedWorktreesByRepo: {},
    ...overrides
  }
}

describe('compatibility views', () => {
  it('return the store fields by reference', () => {
    const state = makeState()
    expect(selectWorktreesByRepo(state)).toBe(state.worktreesByRepo)
    expect(selectFolderWorkspaces(state)).toBe(state.folderWorkspaces)
    expect(selectDetectedWorktreesByRepo(state)).toBe(state.detectedWorktreesByRepo)
  })

  it('lists every host twin for a bare id', () => {
    expect(selectWorktreeRowsByBareId(makeState(), SHARED_ID)).toEqual([localRow, sshRow])
  })
})

describe('selectWorkspace', () => {
  it('keeps a same-id twin on another host apart', () => {
    const state = makeState()
    expect(selectWorkspace(state, composeWorktreeHostIdentity('local', SHARED_ID))).toBe(localRow)
    expect(selectWorkspace(state, composeWorktreeHostIdentity('ssh:build-box', SHARED_ID))).toBe(
      sshRow
    )
    expect(selectWorkspace(state, composeWorktreeHostIdentity('ssh:other', SHARED_ID))).toBe(
      undefined
    )
  })

  it('finds a folder workspace by its workspace key on its host', () => {
    const row = selectWorkspace(
      makeState(),
      composeWorktreeHostIdentity('local', folderWorkspaceKey('folder-1'))
    )
    expect(row?.path).toBe(folder.folderPath)
  })
})

describe('selectWorkspaces', () => {
  it('returns one stable array per snapshot and filter', () => {
    const state = makeState()
    const first = selectWorkspaces(state, { hostId: 'local' })
    expect(selectWorkspaces({ ...state }, { hostId: 'local' })).toBe(first)
    expect(selectWorkspaces(state)).toBe(selectWorkspaces(state))
    expect(first.map((row) => row.id)).toEqual([
      SHARED_ID,
      otherRepoRow.id,
      folderWorkspaceKey('folder-1')
    ])
  })

  it('rebuilds when either source changes', () => {
    const state = makeState()
    const before = selectWorkspaces(state)
    expect(selectWorkspaces({ ...state, folderWorkspaces: [] })).not.toBe(before)
    expect(selectWorkspaces({ ...state, worktreesByRepo: { 'repo-2': [otherRepoRow] } })).toEqual([
      otherRepoRow,
      selectWorkspaces(state, { kind: 'folder' })[0]
    ])
  })

  it('filters by kind and repo', () => {
    const state = makeState()
    expect(selectWorkspaces(state, { kind: 'worktree', repoId: 'repo-1' })).toEqual([
      localRow,
      sshRow
    ])
    expect(selectWorkspaces(state, { kind: 'folder' }).map((row) => row.id)).toEqual([
      folderWorkspaceKey('folder-1')
    ])
    expect(selectWorkspaces(state, { repoId: 'missing' })).toBe(
      selectWorkspaces(state, { hostId: 'ssh:missing' })
    )
  })
})

describe('selectWorkspaceByHostTarget', () => {
  it('resolves the target host only', () => {
    const state = makeState()
    expect(
      selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: SHARED_ID, hostId: 'local' }))
    ).toBe(localRow)
    expect(
      selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: SHARED_ID, hostId: 'ssh:build-box' })
      )
    ).toBe(sshRow)
  })

  it("answers a paired runtime's logical host alias", () => {
    const hubRow = makeWorktree({
      id: 'repo-3::/srv/app',
      repoId: 'repo-3',
      hostId: 'ssh:hub',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const state = makeState({ worktreesByRepo: { 'repo-3': [hubRow] } })
    expect(
      selectWorkspaceByHostTarget(
        state,
        hostWorktreeTarget({ id: hubRow.id, hostId: 'runtime:env-1' })
      )
    ).toBe(hubRow)
  })

  it('matches a folder workspace on its host only', () => {
    const state = makeState()
    const key = folderWorkspaceKey('folder-1')
    expect(
      selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: key, hostId: 'local' }))?.path
    ).toBe(folder.folderPath)
    expect(
      selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: key, hostId: 'ssh:build-box' }))
    ).toBe(undefined)
  })
})

describe('selectWorkspaceByHostTarget bucket keys', () => {
  it('finds a row filed under a bucket that is not its repo id', () => {
    const row = makeWorktree({ id: 'wt-9', repoId: 'repo-9', hostId: 'ssh:remote' })
    const state = makeState({ worktreesByRepo: { remote: [row] } })
    expect(
      selectWorkspaceByHostTarget(state, hostWorktreeTarget({ id: 'wt-9', hostId: 'ssh:remote' }))
    ).toBe(row)
  })
})
