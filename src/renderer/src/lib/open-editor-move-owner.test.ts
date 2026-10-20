import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { editorMoveOwnerFromContext, isOpenFileOnMoveOwner } from './open-editor-move-owner'

function captured(route: WorktreeOperationRoute): EditorFileOperationProvenance {
  return {
    ownershipProjection: 'explicit',
    generation: {
      route,
      runtimeConnectionGeneration: null,
      runtimePairingRevision: undefined,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}

const tab = (operationProvenance?: EditorFileOperationProvenance, runtimeEnvironmentId = null) => ({
  worktreeId: 'wt-1',
  runtimeEnvironmentId,
  ...(operationProvenance ? { operationProvenance } : {})
})

describe('isOpenFileOnMoveOwner', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('moves only the tab on the renaming host of a local and direct-SSH same-id twin', () => {
    const state = useAppStore.getState()
    const local = tab(captured({ executionHostId: 'local', runtimeEnvironmentId: null }))
    const ssh = tab(captured({ executionHostId: 'ssh:box', runtimeEnvironmentId: null }))
    const fromLocal = editorMoveOwnerFromContext(
      state,
      { target: { kind: 'local' }, expectedExecutionHostId: 'local' },
      'wt-1'
    )
    const fromSsh = editorMoveOwnerFromContext(
      state,
      { target: { kind: 'local' }, expectedExecutionHostId: 'ssh:box' },
      'wt-1'
    )
    expect([local, ssh].map((file) => isOpenFileOnMoveOwner(state, file, fromLocal))).toEqual([
      true,
      false
    ])
    expect([local, ssh].map((file) => isOpenFileOnMoveOwner(state, file, fromSsh))).toEqual([
      false,
      true
    ])
  })

  it('moves a server tab whose route names only the server when the rename ran on its SSH host', () => {
    const state = useAppStore.getState()
    const serverTab = tab(
      captured({ executionHostId: 'runtime:env-a', runtimeEnvironmentId: 'env-a' })
    )
    const owner = editorMoveOwnerFromContext(
      state,
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        expectedExecutionHostId: 'ssh:box'
      },
      'wt-1'
    )
    expect(isOpenFileOnMoveOwner(state, serverTab, owner)).toBe(true)
  })

  it('never moves another server’s tab for the same workspace id', () => {
    const state = useAppStore.getState()
    const owner = editorMoveOwnerFromContext(
      state,
      { target: { kind: 'environment', environmentId: 'env-a' }, expectedExecutionHostId: 'local' },
      'wt-1'
    )
    expect(
      isOpenFileOnMoveOwner(
        state,
        tab(captured({ executionHostId: 'runtime:env-b', runtimeEnvironmentId: 'env-b' })),
        owner
      )
    ).toBe(false)
    expect(isOpenFileOnMoveOwner(state, tab(undefined, null), owner)).toBe(false)
  })
})
