import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import { startCodexTurn } from './codex-structured-turn-start'
import type { CodexSession } from './codex-structured-session-state'
import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

function seedMessageDefaults(session: CodexSession): void {
  const store = new AgentModelCatalogStore()
  const fingerprint = 'codex-message-defaults'
  store.recordSuccess(
    fingerprint,
    'codex',
    {
      origin: 'probe',
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: false,
          defaultEffort: 'low',
          serviceTiers: [{ value: 'priority', label: 'Priority' }],
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'model-b',
          label: 'Model B',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    },
    'discovery'
  )
  session.catalogAccess = { store, fingerprint, accountHomePath: '/test-account' }
}

describe('Codex captured message choices', () => {
  it('uses each message’s choices on turn/start without changing the saved next pick', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'turn-1' }
    }))
    const session = optionSession(request)
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'medium')
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    for (const [id, model, effort] of [
      ['first', 'model-a', 'high'],
      ['second', 'model-b', 'low']
    ]) {
      const turnOptions = await resolvedCodexMessageOptions(session, { model, effort })
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }
    expect(
      request.mock.calls
        .filter(([method]) => method === 'turn/start')
        .map(([, params]) => [params?.model, params?.effort])
    ).toEqual([
      ['model-a', 'high'],
      ['model-b', 'low']
    ])
    expect(Object.fromEntries(session.options)).toEqual({ model: 'saved-next', effort: 'medium' })
  })

  it('resets an explicit empty choice after a thread launch and earlier turn override', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/start' ? { turn: { id: 'opened' } } : {}
    )
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', effort: 'high' }
    session.options = new Map([
      ['model', 'model-a'],
      ['effort', 'high'],
      ['personality', 'friendly'],
      ['serviceTier', 'priority']
    ])
    seedMessageDefaults(session)
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }

    for (const [id, choices] of [
      [
        'first',
        { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' }
      ],
      ['second', {}],
      ['third', { model: 'model-a' }]
    ] as const) {
      const turnOptions = await resolvedCodexMessageOptions(session, choices)
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }

    expect(
      request.mock.calls.filter(([method]) => method === 'turn/start').map(([, params]) => params)
    ).toMatchObject([
      { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' },
      { model: 'model-b', effort: 'medium', personality: 'none', serviceTier: 'default' },
      { model: 'model-a', effort: 'low', personality: 'none', serviceTier: 'default' }
    ])
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'turn/start',
      'turn/start',
      'turn/start'
    ])
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-a',
      effort: 'high',
      personality: 'friendly',
      serviceTier: 'priority'
    })
  })

  it('resets to the configured model after opening the thread with an explicit model', async () => {
    const codex = fakeCodex({
      'thread/start': () => ({
        thread: { id: 'thread-abc' },
        model: 'model-a',
        reasoningEffort: 'high'
      }),
      'model/list': () => ({
        data: [
          {
            model: 'model-a',
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
            defaultReasoningEffort: 'high'
          },
          {
            model: 'model-b',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            defaultReasoningEffort: 'medium'
          }
        ],
        nextCursor: null
      }),
      'config/read': () => ({
        config: { model: 'model-b', model_reasoning_effort: 'medium' }
      }),
      'turn/start': () => ({ turn: { id: 'opened' } })
    })
    const adapter = adapterFor(codex, { model: 'model-a' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'model-a', effort: 'high' }
    })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'thread/start')?.params
    ).toMatchObject({
      model: 'model-a'
    })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'a',
      body: USER_MESSAGE,
      executionOptions: { model: 'model-a', effort: 'high' },
      fence: 7
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'b',
      body: USER_MESSAGE,
      executionOptions: {},
      fence: 7
    })
    expect(
      codex.connections[0]?.calls
        .filter((call) => call.method === 'turn/start')
        .map((call) => call.params)
    ).toMatchObject([
      { model: 'model-a', effort: 'high' },
      { model: 'model-b', effort: 'medium', personality: 'none', serviceTier: 'default' }
    ])
  })

  it('preserves the old host path when no message snapshot was supplied', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'legacy' }
    }))
    const session = optionSession(request)
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'high')
    const turnOptions = await resolvedCodexMessageOptions(session, undefined)
    await startCodexTurn(session, {
      clientMessageId: 'legacy',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      turnOptions
    })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: 'saved-next', effort: 'high' })
  })

  it('reads configured defaults when the scoped catalog has not been stored yet', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === 'model/list') {
        return {
          data: [
            {
              model: 'model-b',
              isDefault: false,
              supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
              defaultReasoningEffort: 'medium'
            }
          ],
          nextCursor: null
        }
      }
      return method === 'config/read'
        ? { config: { model: 'model-b', model_reasoning_effort: 'medium' } }
        : { turn: { id: 'default-turn' } }
    })
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', effort: 'high' }
    const turnOptions = await resolvedCodexMessageOptions(session, {})
    await startCodexTurn(session, {
      clientMessageId: 'default',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      turnOptions
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'model/list',
      'config/read',
      'turn/start'
    ])
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      model: 'model-b',
      effort: 'medium',
      personality: 'none',
      serviceTier: 'default'
    })
  })

  it('refuses an unavailable message option before a protocol prompt', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'turn-1' }
    }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    await expect(resolvedCodexMessageOptions(session, { fastMode: 'true' })).rejects.toThrow(
      'does not support Fast mode'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses an unlisted captured model before prompt input', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'unexpected' } }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    await expect(
      resolvedCodexMessageOptions(session, { model: 'unlisted', effort: 'high' })
    ).rejects.toThrow('does not offer model unlisted')
    expect(request).not.toHaveBeenCalled()
  })
})
