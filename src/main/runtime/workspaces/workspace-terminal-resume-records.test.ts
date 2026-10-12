import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../../persistence/loading-store/store-runtime-state'
import type { RuntimeStore } from '../runtime-store-contract'

type ResumeStore = Pick<
  RuntimeStore,
  'getWorkspaceSession' | 'setWorkspaceSession' | 'runDurableMutation'
>
const WORKTREE_ID = 'repo::/workspace'
const HOST_ID = 'runtime:original-partition'

function clear(runtime: InstanceType<typeof OrcaRuntimeService>): Promise<void> {
  return runtime['clearWorktreeTerminalResumeRecords'](WORKTREE_ID, HOST_ID, ['closed'])
}

describe('workspace terminal resume mutation ownership', () => {
  it('reads the current mutation and rollback stores with their original receivers', async () => {
    const runtime = new OrcaRuntimeService(null)
    const reads: string[] = []
    let runMutation = (): void => {
      throw new Error('mutation was not reserved')
    }
    let rollback = (): void => {
      throw new Error('rollback was not installed')
    }
    let finish = (): void => {
      throw new Error('mutation was not staged')
    }
    const before: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: { 'closed:leaf': 'old', 'other:leaf': 'other' }
    }
    let mutationSession = before
    let rollbackSession = before
    const reservation: ResumeStore = {
      getWorkspaceSession: () => {
        throw new Error('reservation store read')
      },
      setWorkspaceSession: () => {
        throw new Error('reservation store write')
      },
      runDurableMutation<Value>(mutate: () => DurableProfileStateMutation<Value>): Promise<Value> {
        expect(this).toBe(reservation)
        const deferred = Promise.withResolvers<Value>()
        runMutation = () => {
          const staged = mutate()
          rollback =
            staged.rollback ??
            (() => {
              throw new Error('rollback absent')
            })
          finish = () => deferred.resolve(staged.value)
        }
        return deferred.promise
      }
    }
    const mutation: ResumeStore = {
      getWorkspaceSession(hostId) {
        expect(this).toBe(mutation)
        expect(hostId).toBe(HOST_ID)
        return mutationSession
      },
      setWorkspaceSession(session, hostId) {
        expect(this).toBe(mutation)
        expect(hostId).toBe(HOST_ID)
        mutationSession = session
      }
    }
    const recovery: ResumeStore = {
      getWorkspaceSession(hostId) {
        expect(this).toBe(recovery)
        expect(hostId).toBe(HOST_ID)
        return rollbackSession
      },
      setWorkspaceSession(session, hostId) {
        expect(this).toBe(recovery)
        expect(hostId).toBe(HOST_ID)
        rollbackSession = session
      }
    }
    let current: ResumeStore | null = reservation
    let phase = 'reserve'
    Object.defineProperty(runtime, 'store', {
      get: () => {
        reads.push(phase)
        return current
      }
    })
    const pending = clear(runtime)
    expect(reads).toEqual(['reserve', 'reserve', 'reserve', 'reserve'])
    current = mutation
    phase = 'mutation'
    runMutation()
    expect(reads.filter((entry) => entry === 'mutation')).toHaveLength(3)
    expect(mutationSession.terminalPtyIncarnationsByPaneKey).toEqual({ 'other:leaf': 'other' })
    rollbackSession = {
      ...mutationSession,
      activeWorktreeId: 'another-worktree',
      terminalPtyIncarnationsByPaneKey: {
        ...mutationSession.terminalPtyIncarnationsByPaneKey,
        'new:leaf': 'new'
      }
    }
    current = recovery
    phase = 'rollback'
    rollback()
    expect(reads.filter((entry) => entry === 'rollback')).toHaveLength(2)
    expect(rollbackSession.activeWorktreeId).toBe('another-worktree')
    expect(rollbackSession.terminalPtyIncarnationsByPaneKey).toEqual({
      'closed:leaf': 'old',
      'other:leaf': 'other',
      'new:leaf': 'new'
    })
    finish()
    await pending
  })

  it.each([
    { label: 'null', store: null, reads: 1 },
    { label: 'missing reader', store: {}, reads: 1 },
    {
      label: 'missing writer',
      store: { getWorkspaceSession: () => getDefaultWorkspaceSession() },
      reads: 2
    },
    {
      label: 'missing reservation',
      store: {
        getWorkspaceSession: () => getDefaultWorkspaceSession(),
        setWorkspaceSession: () => {}
      },
      reads: 3
    }
  ])('preserves admission refusal and lookup count for $label', async ({ store, reads }) => {
    const runtime = new OrcaRuntimeService(null)
    let lookups = 0
    Object.defineProperty(runtime, 'store', {
      get: () => {
        lookups += 1
        return store
      }
    })
    await expect(clear(runtime)).rejects.toThrow('workspace_session_unavailable')
    expect(lookups).toBe(reads)
  })

  it('keeps callback-time missing methods at the original late failure boundary', async () => {
    const runtime = new OrcaRuntimeService(null)
    const store: ResumeStore = {
      getWorkspaceSession: () => getDefaultWorkspaceSession(),
      setWorkspaceSession: () => {},
      async runDurableMutation<Value>(
        mutate: () => DurableProfileStateMutation<Value>
      ): Promise<Value> {
        store.getWorkspaceSession = undefined
        return mutate().value
      }
    }
    Object.defineProperty(runtime, 'store', { get: () => store })
    await expect(clear(runtime)).rejects.toThrow('this.store.getWorkspaceSession is not a function')
  })
  it('keeps a store disappearing during admission at the original property lookup', async () => {
    const runtime = new OrcaRuntimeService(null)
    const initial: ResumeStore = {}
    let current: ResumeStore | null = initial
    Object.defineProperty(initial, 'getWorkspaceSession', {
      get: () => {
        current = null
        return () => getDefaultWorkspaceSession()
      }
    })
    let lookups = 0
    Object.defineProperty(runtime, 'store', {
      get: () => {
        lookups += 1
        return current
      }
    })
    await expect(clear(runtime)).rejects.toThrow(
      /^(?:Cannot read properties of null \(reading 'setWorkspaceSession'\)|null is not an object \(evaluating 'this\.store\.setWorkspaceSession'\))$/
    )
    expect(lookups).toBe(2)
  })
})
