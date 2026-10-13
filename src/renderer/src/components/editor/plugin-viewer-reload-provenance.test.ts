import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { OpenFile } from '@/store/slices/editor'
import { pluginViewerReloadProvenance } from './plugin-viewer-reload-provenance'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(() => replaceRuntimeEnvironmentRevisions([]))

function pairedFixture() {
  const { store, file } = fixture()
  const environment = {
    id: 'viewer-reload-server',
    name: 'Viewer server',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: 'viewer-runtime',
    preferredEndpointId: 'endpoint',
    endpoints: []
  }
  replaceRuntimeEnvironmentRevisions([environment])
  store.setState((state) => ({
    runtimeEnvironments: [environment],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    worktreesByRepo: {
      'repo-1': [
        {
          ...state.worktreesByRepo['repo-1']![0]!,
          hostId: 'runtime:viewer-reload-server',
          runtimeOwnerEnvironmentId: environment.id
        }
      ]
    }
  }))
  const paired: OpenFile = {
    ...file,
    runtimeEnvironmentId: environment.id,
    externalSshTargetId: undefined,
    operationProvenance: captureEditorFileOperationProvenance(
      store.getState(),
      'wt-1',
      environment.id,
      true
    )
  }
  return { store, file: paired, environment }
}

function fixture() {
  const store = createEditorTabsStore()
  const publish = (hostId: 'local' | `ssh:${string}`, generation?: number): void => {
    store.setState((state) => ({
      worktreesByRepo: {
        'repo-1': [{ ...state.worktreesByRepo['repo-1']![0]!, hostId }]
      },
      sshConnectionStates: new Map(
        generation === undefined
          ? []
          : [
              [
                'target',
                {
                  targetId: 'target',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: generation
                }
              ]
            ]
      )
    }))
  }
  publish('ssh:target', 1)
  const file: OpenFile = {
    id: 'tab',
    filePath: '/repo/model.stl',
    relativePath: 'model.stl',
    worktreeId: 'wt-1',
    runtimeEnvironmentId: null,
    externalSshTargetId: 'target',
    mode: 'plugin-viewer',
    language: 'plaintext',
    isDirty: false,
    readOnly: true,
    operationProvenance: captureEditorFileOperationProvenance(store.getState(), 'wt-1', null, true)
  }
  return { store, file, publish }
}

describe('explicit viewer reload authority', () => {
  it('refuses an unproved same-id re-pair even when the workspace route is unchanged', () => {
    const { store, file, environment } = pairedFixture()
    const next = { ...environment, pairingRevision: 2 }
    store.setState({ runtimeEnvironments: [next] })
    replaceRuntimeEnvironmentRevisions([next])
    expect(() => pluginViewerReloadProvenance(store.getState(), file)).toThrow('owner changed')
  })

  it('allows an explicit Reload after a pairing rotation proven to continue the same host', () => {
    const { store, file, environment } = pairedFixture()
    const next = { ...environment, pairingRevision: 2 }
    store.setState({ runtimeEnvironments: [next] })
    replaceRuntimeEnvironmentRevisions([next], {
      retired: [],
      sameHost: [{ id: environment.id, fromRevision: 1, toRevision: 2 }]
    })
    expect(
      pluginViewerReloadProvenance(store.getState(), file).generation.runtimePairingRevision
    ).toBe(2)
    expect(file.operationProvenance?.generation.runtimePairingRevision).toBe(1)
  })

  it('requires workspace reopen when a runtime tab never captured its pairing', () => {
    const { store, file } = pairedFixture()
    if (!file.operationProvenance) {
      throw new Error('Missing fixture provenance')
    }
    file.operationProvenance.generation.runtimePairingRevision = undefined
    expect(() => pluginViewerReloadProvenance(store.getState(), file)).toThrow('owner changed')
  })
  it('refreshes a reconnect generation without mutating the expired tab or changing its host', () => {
    const { store, file, publish } = fixture()
    publish('ssh:target', 2)
    const next = pluginViewerReloadProvenance(store.getState(), file)
    expect(next.expectedSshConnectionGeneration).toBe(2)
    expect(next.generation.route).toEqual(file.operationProvenance?.generation.route)
    expect(file.operationProvenance?.expectedSshConnectionGeneration).toBe(1)
  })
  it.each(['local', 'ssh:replacement'] as const)('rejects reassignment to %s', (host) => {
    const { store, file, publish } = fixture()
    publish(host, 2)
    expect(() => pluginViewerReloadProvenance(store.getState(), file)).toThrow('owner changed')
  })
  it('rejects withdrawn owners, missing generations and mismatching explicit targets', () => {
    const { store, file, publish } = fixture()
    publish('ssh:target')
    expect(() => pluginViewerReloadProvenance(store.getState(), file)).toThrow()
    publish('ssh:target', 2)
    expect(() =>
      pluginViewerReloadProvenance(store.getState(), { ...file, externalSshTargetId: 'other' })
    ).toThrow()
    store.setState({ worktreesByRepo: {}, repos: [] })
    expect(() => pluginViewerReloadProvenance(store.getState(), file)).toThrow()
  })
  it('requires workspace reopen when an expired session has lost its original provenance', () => {
    const { store, file } = fixture()
    expect(() =>
      pluginViewerReloadProvenance(store.getState(), {
        ...file,
        operationProvenance: undefined,
        pluginViewerOwnerExpired: true
      })
    ).toThrow('owner changed')
  })
})
