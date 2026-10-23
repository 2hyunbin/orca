import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { createAppState, useAppStore } from './index'
import { getAgentStatusOwner } from './agent-status-commit'
import { applyAgentStatusPatch } from './agent-status-patch'
import { applyWebSessionTabsStorePatch } from '@/runtime/web-session-tabs-sync/store-patch'

const pane = 'source:11111111-1111-4111-8111-111111111111'
const destination = 'destination:22222222-2222-4222-8222-222222222222'
afterEach(() => vi.useRealTimers())

describe('accepted status authority boundaries', () => {
  it('discards prepared aliases and observations without changing another store', () => {
    vi.useFakeTimers()
    const a = createStore(createAppState),
      b = createStore(createAppState)
    const status = getAgentStatusOwner(a),
      other = getAgentStatusOwner(b)
    const authority = status.observations().getAuthorityId()
    expect(() =>
      status.transact(() => {
        a.getState().transferAgentPaneAuthority({ fromPaneKey: pane, toPaneKey: destination })
        a.getState().setAgentStatus(pane, { state: 'working', prompt: 'aborted' })
        throw new Error('abort')
      })
    ).toThrow('abort')
    expect(status.getSnapshot()).toEqual({})
    a.getState().setAgentStatus(pane, { state: 'working', prompt: 'A' })
    b.getState().setAgentStatus(pane, { state: 'working', prompt: 'B' })
    expect(status.getEntry(pane)?.prompt).toBe('A')
    expect(other.getEntry(pane)?.prompt).toBe('B')
    expect(other.getEntry(destination)).toBeUndefined()
    expect(status.observations().getAuthorityId()).toBe(authority)
    a.getState().transferAgentPaneAuthority({ fromPaneKey: pane, toPaneKey: destination })
    a.getState().setAgentStatus(pane, { state: 'done', prompt: 'accepted' })
    expect(status.getEntry(destination)?.prompt).toBe('accepted')
    expect(other.getEntry(pane)?.prompt).toBe('B')
  })

  it('installs host status through the canonical owner and aborts a throwing mirror builder', () => {
    vi.useFakeTimers()
    const owner = getAgentStatusOwner(useAppStore),
      original = owner.getState()
    const entry = {
      paneKey: pane,
      agentType: 'codex',
      state: 'working',
      prompt: 'host',
      stateHistory: [],
      stateStartedAt: 10,
      updatedAt: 20
    } as const
    const observed = vi.fn(() => {
      expect(useAppStore.getState()).not.toHaveProperty('agentStatusByPaneKey')
      expect(owner.getEntry(pane)).toEqual(entry)
    })
    const unsubscribe = useAppStore.subscribe(observed)
    try {
      expect(() =>
        applyWebSessionTabsStorePatch(
          () => {
            throw new Error('abort mirror')
          },
          { frames: [] }
        )
      ).toThrow('abort mirror')
      expect(owner.getState()).toBe(original)
      applyWebSessionTabsStorePatch(
        () => ({
          agentStatusByPaneKey: { [pane]: { ...entry, stateHistory: [] } },
          sortEpoch: original.sortEpoch + 1
        }),
        { frames: [] }
      )
      expect(observed).toHaveBeenCalledTimes(1)
      expect(owner.getEntry(pane)?.prompt).toBe('host')
      expect(useAppStore.getState()).not.toHaveProperty('agentStatusByPaneKey')
    } finally {
      unsubscribe()
      applyAgentStatusPatch(useAppStore, original)
    }
  })
})
