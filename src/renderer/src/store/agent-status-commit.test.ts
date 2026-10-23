import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState } from './index'
import { getAgentStatusOwner } from './agent-status-commit'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import { assertEditorBufferInvariant } from './editor-buffer-record-lifecycle'
import { makeOpenFile } from './slices/store-session-test-harness'
import { makeWorktree, TEST_REPO } from './slices/worktrees-slice-test-fixtures'
import type { AgentStatusTransition } from './agent-status-observers'

const row = (paneKey: string, state: AgentStatusEntry['state'] = 'working'): AgentStatusEntry => ({
  paneKey,
  state,
  prompt: 'task',
  agentType: 'codex',
  stateStartedAt: 10,
  updatedAt: state === 'done' ? 20 : 10,
  stateHistory: []
})

afterEach(() => vi.restoreAllMocks())

describe('real AppStore status commit boundary', () => {
  it.each([10, 100])(
    'isolates keyed writes across %i rows and preserves net-zero identities',
    (n) => {
      const store = createStore(createAppState)
      const owner = getAgentStatusOwner(store)
      const app = vi.fn()
      const aggregate = vi.fn()
      const points = Array.from({ length: n }, () => vi.fn())
      points.forEach((listener, key) => owner.subscribeEntry(String(key), listener))
      store.subscribe(app)
      owner.subscribeAggregate(aggregate)
      owner.transact((transaction) => {
        for (let key = 0; key < n; key++) {
          transaction.setEntry(String(key), row(String(key)))
        }
      })
      const initial = owner.getSnapshot()
      const first = initial['0']
      points.forEach((point) => point.mockClear())
      aggregate.mockClear()
      owner.transact((transaction) => {
        transaction.setEntry('0', { ...first, prompt: 'changed' })
        expect(transaction.getState().agentStatusByPaneKey['0'].prompt).toBe('changed')
        expect(owner.getEntry('0')).toBe(first)
        transaction.setEntry('0', first)
      })
      expect(owner.getSnapshot()).toBe(initial)
      expect(aggregate).not.toHaveBeenCalled()
      owner.transact((transaction) => {
        transaction.setEntry('0', { ...first, prompt: 'changed' })
        transaction.setEntry('0', {
          ...transaction.getState().agentStatusByPaneKey['0'],
          model: 'next'
        })
      })
      expect(points[0]).toHaveBeenCalledTimes(1)
      expect(points.slice(1).every((point) => point.mock.calls.length === 0)).toBe(true)
      expect(aggregate).toHaveBeenCalledTimes(1)
      expect(app).not.toHaveBeenCalled()
      expect(owner.getSnapshot()['1']).toBe(initial['1'])
      expect(getAgentStatusOwner(createStore(createAppState)).getSnapshot()).toEqual({})
    }
  )

  it('keeps ordinary app recursion and captures completion before synchronous removal', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    owner.transact((transaction) => transaction.setEntry('p', row('p')))
    const pairs: AgentStatusTransition[] = []
    const latest: (AgentStatusEntry | undefined)[] = []
    let nestedFlag = false
    let observedNestedFlag = false
    let nested = false
    owner.subscribeTransitions((transition) => pairs.push(transition), 'p')
    owner.subscribeEntry('p', () => latest.push(owner.getEntry('p')))
    store.subscribe(() => {
      if (nested || owner.getEntry('p')?.state !== 'done') {
        return
      }
      nested = true
      store.setState({ activeWorktreeId: 'nested' })
      observedNestedFlag = nestedFlag
      owner.transact((transaction) => {
        transaction.setEntry('p', undefined)
        store.setState((state) => ({ agentStatusEpoch: state.agentStatusEpoch + 1 }))
      })
    })
    store.subscribe((state) => {
      if (state.activeWorktreeId === 'nested') {
        nestedFlag = true
      }
    })
    owner.transact((transaction) => {
      transaction.setEntry('p', row('p', 'done'))
      store.setState({ agentStatusEpoch: 1 })
    })
    expect(pairs.map((pair) => pair.next.agentStatusByPaneKey.p?.state)).toEqual([
      'done',
      undefined
    ])
    expect(pairs.map((pair) => pair.previous.agentStatusByPaneKey.p?.state)).toEqual([
      'working',
      'done'
    ])
    expect(pairs[0].next.agentStatusEpoch).toBe(1)
    expect(observedNestedFlag).toBe(true)
    expect(pairs[1].next.agentStatusEpoch).toBe(2)
    expect(pairs[0].sequence).toBeLessThan(pairs[1].sequence)
    expect(latest).toEqual([undefined, undefined])
    expect(store.getState().activeWorktreeId).toBe('nested')
    expect(owner.getEntry('p')).toBeUndefined()
  })

  it('prepares real editor invariants once and abandons effects on updater or draft failure', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    store.setState({
      repos: [{ ...TEST_REPO, executionHostId: 'local' }],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      openFiles: ['a', 'b'].map((id) =>
        makeOpenFile({ id, worktreeId: 'wt', filePath: '/same.txt', runtimeEnvironmentId: null })
      )
    })
    expect(Object.values(store.getState().editorBufferViews)).toContainEqual(['a', 'b'])
    const previous = store.getState()
    const initial = owner.getSnapshot()
    const app = vi.fn()
    const accepted = vi.fn()
    const effect = vi.fn()
    const updater = vi.fn(() => {
      expect(owner.getSnapshot()).toBe(initial)
      expect(store.getState()).toBe(previous)
      throw new Error('updater failed')
    })
    store.subscribe(app)
    owner.subscribeTransitions(accepted)
    for (const write of [
      () => store.setState(updater),
      () => store.setState({ editorDrafts: { a: 'only one view' } })
    ]) {
      expect(() =>
        owner.transact((transaction) => {
          transaction.setEntry('p', row('p'))
          transaction.afterCommit(effect)
          write()
        })
      ).toThrow()
      expect(store.getState()).toBe(previous)
      expect(owner.getSnapshot()).toBe(initial)
    }
    expect(updater).toHaveBeenCalledTimes(1)
    expect(app).not.toHaveBeenCalled()
    expect(accepted).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    const valid = vi.fn(() => ({ editorDrafts: { a: 'same', b: 'same' } }))
    const observedPairs: (AgentStatusEntry | undefined)[] = []
    const invariantErrors: unknown[] = []
    store.subscribe((state) => {
      try {
        assertEditorBufferInvariant(state)
      } catch (error) {
        invariantErrors.push(error)
      }
      observedPairs.push(owner.getEntry('p'))
    })
    expect(
      owner.transact((transaction) => {
        transaction.setEntry('p', row('p'))
        store.setState(valid)
        transaction.afterCommit(effect)
        return 'accepted'
      })
    ).toBe('accepted')
    expect(valid).toHaveBeenCalledTimes(1)
    expect(invariantErrors).toEqual([])
    expect(observedPairs.map((entry) => entry?.state)).toEqual(['working'])
    expect(effect).toHaveBeenCalledTimes(1)
    expect(accepted).toHaveBeenCalledTimes(1)
  })

  it('isolates accepted observers, keeps subscription lifetimes and preserves unrelated errors', () => {
    const store = createStore(createAppState)
    const owner = getAgentStatusOwner(store)
    const error = new Error('observer failed')
    const report = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('reporter failed')
    })
    const late = vi.fn()
    const disposed = vi.fn()
    const unsubscribe = owner.subscribeEntry('p', disposed)
    const stopThrowing = store.subscribe(() => {
      unsubscribe()
      owner.subscribeTransitions(late, 'p')
      throw error
    })
    const app = vi.fn()
    store.subscribe(app)
    owner.subscribeEntry('p', () => {
      throw error
    })
    const aggregate = vi.fn()
    owner.subscribeAggregate(aggregate)
    const finalEffect = vi.fn()
    expect(
      owner.transact((transaction) => {
        transaction.setEntry('p', row('p'))
        store.setState({ agentStatusEpoch: 1 })
        transaction.afterCommit(() => {
          throw error
        })
        transaction.afterCommit(finalEffect)
        return true
      })
    ).toBe(true)
    expect(app).toHaveBeenCalledTimes(1)
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(finalEffect).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledTimes(3)
    expect(disposed).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    stopThrowing()
    const stopOrdinary = store.subscribe(() => {
      throw error
    })
    expect(() => store.setState({ activeWorktreeId: 'ordinary' })).toThrow(error)
    stopOrdinary()
    owner.transact((transaction) => transaction.setEntry('p', undefined))
    expect(late).toHaveBeenCalledTimes(1)
  })
})
