import { describe, expect, it, vi } from 'vitest'
import { ClaudeControlRequestError } from './claude-stream-json-connection'
import {
  acquired,
  claudeFrame,
  fakeClaude,
  USER_MESSAGE
} from './claude-structured-session-test-support'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

const MODELS = [
  { value: 'default', resolvedModel: 'claude-sonnet-5' },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  }
]

describe('Claude accepted message choices', () => {
  it('applies a held message A before its prompt, then message B on the existing child', async () => {
    const order: string[] = []
    let currentEffort = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        set_model: ({ model } = {}) => order.push(`model:${String(model)}`),
        apply_flag_settings: ({ settings } = {}) => {
          order.push(`effort:${JSON.stringify(settings)}`)
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'effortLevel' in settings &&
            typeof settings.effortLevel === 'string'
          ) {
            currentEffort = settings.effortLevel
          }
        }
      }
    })
    const adapter = await acquired(claude)
    const connection = claude.connections[0]!
    connection.getSettings = async () => ({ effective: { effortLevel: currentEffort } })
    const send = connection.send
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const enteredSend = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    connection.send = async (message, beforeDispatch) => {
      if (first) {
        first = false
        entered()
        await held
      }
      const result = await send(message, beforeDispatch)
      order.push('prompt')
      return result
    }

    const a = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'A',
      body: USER_MESSAGE,
      executionOptions: { model: 'sonnet', effort: 'low' },
      fence: 7
    })
    await enteredSend
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'opus', fence: 7 })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    order.length = 0
    release()
    await expect(a).resolves.toEqual({ state: 'admitted' })
    expect(order).toEqual(['model:sonnet', 'effort:{"effortLevel":"low"}', 'prompt'])

    order.length = 0
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'B',
        body: USER_MESSAGE,
        executionOptions: { model: 'opus', effort: 'high' },
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(order).toEqual(['model:opus', 'effort:{"effortLevel":"high"}', 'prompt'])
  })

  it('restores the configured model and effort for an empty snapshot', async () => {
    let currentEffort = 'high'
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        apply_flag_settings: ({ settings } = {}) => {
          if (
            typeof settings === 'object' &&
            settings !== null &&
            'effortLevel' in settings &&
            typeof settings.effortLevel === 'string'
          ) {
            currentEffort = settings.effortLevel
          }
        }
      }
    })
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(claude, {}, events)
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: 'options-reported' }))
    )
    claude.connections[0]!.getSettings = async () => ({ effective: { effortLevel: currentEffort } })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'A',
      body: USER_MESSAGE,
      executionOptions: { model: 'opus', effort: 'low' },
      fence: 7
    })
    const connection = claude.connections[0]!
    claudeFrame(connection, { type: 'system', subtype: 'init', model: 'claude-opus-5' })
    connection.calls.length = 0
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'default',
        body: USER_MESSAGE,
        executionOptions: {},
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(
      connection.calls.filter((call) => ['set_model', 'apply_flag_settings'].includes(call.subtype))
    ).toEqual([
      { subtype: 'set_model', params: { model: 'claude-sonnet-5' } },
      { subtype: 'apply_flag_settings', params: { settings: { effortLevel: 'high' } } }
    ])
    expect(connection.sent).toHaveLength(2)
  })

  it('rejects a refused model before any prompt is handed to Claude', async () => {
    const claude = fakeClaude({
      routes: {
        list_models: () => MODELS,
        set_model: () => {
          throw new ClaudeControlRequestError('set_model', 'model unavailable')
        }
      }
    })
    const adapter = await acquired(claude)
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'refused',
        body: USER_MESSAGE,
        executionOptions: { model: 'opus', effort: 'low' },
        fence: 7
      })
    ).resolves.toMatchObject({
      state: 'rejected',
      rejection: { kind: 'providerRejected' }
    })
    expect(claude.connections[0]!.sent).toHaveLength(0)
  })
})
