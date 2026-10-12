import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import type { RuntimeStore } from '../runtime-store-contract'

type Runtime = InstanceType<typeof OrcaRuntimeService>

const WORKTREE_ID = 'repo::/workspace'

function constructRuntime(observe: (runtime: Runtime) => void): Runtime {
  class ConstructorObservedRuntime extends OrcaRuntimeService {
    protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
      const cache = super.canonicalFetchKeyCache
      observe(this)
      return cache
    }
  }
  return new ConstructorObservedRuntime(null)
}

function getNativeMethod(
  runtime: Runtime,
  name: string
): (this: Runtime, ...args: unknown[]) => unknown {
  let prototype = Object.getPrototypeOf(runtime)
  while (prototype) {
    const method = Object.getOwnPropertyDescriptor(prototype, name)?.value
    if (typeof method === 'function') {
      return method
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  throw new Error(`Missing runtime method: ${name}`)
}

describe('workspace persistence during full runtime construction', () => {
  // The fetch-cache getter runs in the base constructor before later runtime fields initialize.
  it('returns a native promise for absent active-workspace context', async () => {
    let observed: Promise<unknown> | undefined
    const observe = vi.fn((runtime: Runtime) => {
      expect(runtime['store']).toBeNull()
      observed = runtime.resolveActiveWorktreeContext()
      expect(observed).toBeInstanceOf(Promise)
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
    await expect(observed).resolves.toBeNull()
  })

  it('collects no public tab ids when no snapshot exists', () => {
    const observe = vi.fn((runtime: Runtime) => {
      const ids = runtime['collectPublicMobileSessionTabIds'](undefined)
      expect(ids).toBeInstanceOf(Set)
      expect(ids.size).toBe(0)
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })

  it('resolves no host tab id when no snapshot exists', () => {
    const observe = vi.fn((runtime: Runtime) => {
      expect(runtime['resolveMobileSessionHostTabId'](undefined, 'absent-tab')).toBeNull()
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })

  it('normalizes an empty group order without a snapshot', () => {
    const observe = vi.fn((runtime: Runtime) => {
      const order = runtime['normalizeMobileSessionTabOrder'](
        undefined,
        { id: 'empty-group', activeTabId: null, tabOrder: [] },
        []
      )
      expect(order).toEqual([])
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })

  it('leaves a title unchanged when persistence is unavailable', () => {
    const observe = vi.fn((runtime: Runtime) => {
      expect(runtime['store']).toBeNull()
      expect(runtime['persistHeadlessTerminalTitle'](WORKTREE_ID, 'absent-tab', 'Title')).toBe(
        undefined
      )
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })

  it('finds no split source in an empty runtime', () => {
    const observe = vi.fn((runtime: Runtime) => {
      expect(
        runtime['resolveTerminalSplitSourceAuthority'](
          WORKTREE_ID,
          'absent-tab',
          'absent-leaf',
          'absent-pty'
        )
      ).toBeNull()
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })

  it('rejects destructive removal asynchronously when no local provider exists', async () => {
    let observed: Promise<unknown> | undefined
    const observe = vi.fn((runtime: Runtime) => {
      observed = runtime['stopPtysForDestructiveWorktreeRemoval'](WORKTREE_ID)
      expect(observed).toBeInstanceOf(Promise)
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
    await expect(observed).rejects.toThrow(
      `PTY provider unavailable for worktree deletion: ${WORKTREE_ID}`
    )
  })

  it('rejects resume-record clearing asynchronously when persistence is unavailable', async () => {
    let observed: Promise<unknown> | undefined
    const observe = vi.fn((runtime: Runtime) => {
      const clear = getNativeMethod(runtime, 'clearWorktreeTerminalResumeRecords')
      const result = clear.call(runtime, WORKTREE_ID, 'local', ['absent-tab'])
      expect(result).toBeInstanceOf(Promise)
      if (!(result instanceof Promise)) {
        throw new Error('Resume clearing must return a native promise')
      }
      observed = result
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
    await expect(observed).rejects.toThrow('workspace_session_unavailable')
  })

  it('keeps the root mutation map and pending promise after construction finishes', async () => {
    const created = Promise.resolve('created')
    const run = vi.fn(() => created)
    let mapDuringConstruction: unknown
    let promiseDuringConstruction: Promise<string> | undefined
    const observe = vi.fn((runtime: Runtime) => {
      mapDuringConstruction = runtime['worktreeCreateByMutationId']
      expect(mapDuringConstruction).toBeInstanceOf(Map)
      expect(Object.getOwnPropertyDescriptor(runtime, 'worktreeCreateByMutationId')).toEqual({
        value: mapDuringConstruction,
        writable: true,
        enumerable: true,
        configurable: true
      })
      promiseDuringConstruction = runtime.dedupeWorktreeCreate('repo', 'mutation', run)
      expect(promiseDuringConstruction).toBe(created)
      expect(runtime['worktreeCreateByMutationId'].get('repo\0mutation')).toBe(created)
    })
    const runtime = constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
    expect(runtime['worktreeCreateByMutationId']).toBe(mapDuringConstruction)
    expect(runtime['worktreeCreateByMutationId'].get('repo\0mutation')).toBe(created)
    const duplicate = vi.fn(() => Promise.resolve('duplicate'))
    expect(runtime.dedupeWorktreeCreate('repo', 'mutation', duplicate)).toBe(created)
    expect(run).toHaveBeenCalledOnce()
    expect(duplicate).not.toHaveBeenCalled()
    await expect(promiseDuringConstruction).resolves.toBe('created')
  })

  it('removes metadata through the narrow store capabilities during construction', () => {
    const worktreeId = 'constructor-metadata::/workspace'
    const removeWorktreeMeta = vi.fn()
    const store: Pick<RuntimeStore, 'getWorktreeMeta' | 'removeWorktreeMeta' | 'getRepos'> = {
      getWorktreeMeta: () => undefined,
      removeWorktreeMeta,
      getRepos: () => []
    }
    let removedMapDuringConstruction: unknown
    let snapshotsDuringConstruction: unknown
    let acceptedSnapshotsDuringConstruction: unknown
    const observe = vi.fn((runtime: Runtime) => {
      expect(runtime['store']).toBeNull()
      removedMapDuringConstruction = runtime['removedMobileSessionWorktreeIds']
      snapshotsDuringConstruction = runtime['mobileSessionTabsByWorktree']
      acceptedSnapshotsDuringConstruction = runtime['acceptedRendererMobileSnapshotByWorktree']
      expect(Object.getOwnPropertyDescriptor(runtime, 'removedMobileSessionWorktreeIds')).toEqual({
        value: removedMapDuringConstruction,
        writable: true,
        enumerable: true,
        configurable: true
      })
      const remove = getNativeMethod(runtime, 'removeWorktreeMetadataAndHistory')
      expect(remove.call(runtime, store, worktreeId, 'local')).toBeUndefined()
      expect(runtime['removedMobileSessionWorktreeIds'].get(worktreeId)).toEqual({})
      expect(removeWorktreeMeta).toHaveBeenCalledExactlyOnceWith(worktreeId, 'local')
    })
    const runtime = constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
    expect(runtime['removedMobileSessionWorktreeIds']).toBe(removedMapDuringConstruction)
    expect(runtime['mobileSessionTabsByWorktree']).toBe(snapshotsDuringConstruction)
    expect(runtime['acceptedRendererMobileSnapshotByWorktree']).toBe(
      acceptedSnapshotsDuringConstruction
    )
    expect(runtime['removedMobileSessionWorktreeIds'].get(worktreeId)).toEqual({})
    expect(runtime['mobileSessionTabsByWorktree'].has(worktreeId)).toBe(false)
    expect(runtime['acceptedRendererMobileSnapshotByWorktree'].has(worktreeId)).toBe(false)
  })

  it('preserves the native metadata-removal failure for an invalid null-store call', () => {
    const observe = vi.fn((runtime: Runtime) => {
      const remove = getNativeMethod(runtime, 'removeWorktreeMetadataAndHistory')
      // This intentionally unsupported input distinguishes body execution from a missing late owner.
      expect(() => remove.call(runtime, null, WORKTREE_ID)).toThrow(
        new TypeError(
          process.versions.bun
            ? "null is not an object (evaluating 'store.getWorktreeMeta')"
            : "Cannot read properties of null (reading 'getWorktreeMeta')"
        )
      )
    })
    constructRuntime(observe)
    expect(observe).toHaveBeenCalledOnce()
  })
})
