import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentViewBridge } from './agent-view-bridge'

const identity = {
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  sessionId: 'parent-session',
  instanceId: 'instance'
}

afterEach(() => vi.useRealTimers())

describe('Claude agent view delivery', () => {
  it('invalidates an in-flight trigger when its mod or session is replaced', async () => {
    const bridge = new ClaudeAgentViewBridge()
    bridge.receive({
      ...identity,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const trigger = vi.fn(async (_input: string, isCurrent: () => boolean) => {
      expect(isCurrent()).toBe(true)
      bridge.receive({
        ...identity,
        instanceId: 'replacement',
        action: 'register',
        keybindings: JSON.stringify({
          bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
        })
      })
      expect(isCurrent()).toBe(false)
      return false
    })
    expect(await bridge.view({ ...identity, trigger })).toEqual({ status: 'unavailable' })
  })
  it('requires a matching live mod and its acknowledgement, and consumes each request once', async () => {
    const bridge = new ClaudeAgentViewBridge()
    const trigger = vi.fn(async () => true)
    expect(await bridge.view({ ...identity, agentId: 'child', trigger })).toEqual({
      status: 'unsupported'
    })
    expect(trigger).not.toHaveBeenCalled()
    bridge.receive({
      ...identity,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    expect(await bridge.view({ ...identity, sessionId: 'another-session', trigger })).toEqual({
      status: 'unsupported'
    })
    let settled = false
    const result = bridge.view({ ...identity, agentId: 'child', trigger }).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    const taken = bridge.receive({ ...identity, action: 'take' })
    expect(taken).toMatchObject({ agentId: 'child' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
    expect(await bridge.view({ ...identity, trigger })).toEqual({ status: 'busy' })
    bridge.receive({ ...identity, action: 'ack', ...taken, deny: 'no agent under that id' })
    expect(await result).toEqual({ status: 'denied', reason: 'no agent under that id' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
  })

  it('expires a swallowed trigger so a later shortcut cannot switch views', async () => {
    vi.useFakeTimers()
    const bridge = new ClaudeAgentViewBridge()
    bridge.receive({
      ...identity,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const result = bridge.view({ ...identity, agentId: 'child', trigger: async () => true })
    await vi.advanceTimersByTimeAsync(1600)
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
    await vi.advanceTimersByTimeAsync(4000)
    expect(await result).toEqual({ status: 'timeout' })
    expect(bridge.receive({ ...identity, action: 'take' })).toEqual({})
  })

  it('rejects late acknowledgements from a replaced mod and sends no keys for a stale registration', async () => {
    vi.useFakeTimers()
    const bridge = new ClaudeAgentViewBridge()
    bridge.receive({
      ...identity,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      })
    })
    const first = bridge.view({ ...identity, trigger: async () => true })
    const taken = bridge.receive({ ...identity, action: 'take' })
    const replacement = { ...identity, instanceId: 'replacement' }
    bridge.receive({
      ...replacement,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+h': 'command:orca-agent-view' } }]
      })
    })
    expect(await first).toEqual({ status: 'unavailable' })
    const second = bridge.view({ ...identity, trigger: async () => true })
    bridge.receive({ ...identity, ...taken, action: 'ack' })
    bridge.clear()
    expect(await second).toEqual({ status: 'unavailable' })
    bridge.receive({
      ...replacement,
      action: 'register',
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+h': 'command:orca-agent-view' } }]
      })
    })
    await vi.advanceTimersByTimeAsync(15001)
    const trigger = vi.fn(async () => true)
    expect(await bridge.view({ ...identity, trigger })).toEqual({ status: 'unsupported' })
    expect(trigger).not.toHaveBeenCalled()
  })
})
