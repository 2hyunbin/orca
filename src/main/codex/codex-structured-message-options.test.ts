import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { resolvedCodexMessageOptions } from './codex-structured-message-options'
import { startCodexTurn } from './codex-structured-turn-start'
import { CodexAppServerRequestError } from './codex-app-server-connection'
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
  it('uses each message’s choices on turn/start and tracks the native attempted choice', async () => {
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
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-b',
      effort: 'low',
      personality: 'none',
      serviceTier: 'default'
    })
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
      effort: 'low',
      personality: 'none',
      serviceTier: 'default'
    })
  })

  it('resets to the configured model after opening the thread with an explicit model', async () => {
    const store = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(store, CODEX_STRUCTURED_AGENT, '/test-account')
    if (!access) {
      throw new Error('expected Codex catalog access')
    }
    store.recordSuccess(
      access.fingerprint,
      'codex',
      {
        origin: 'probe',
        models: [
          {
            id: 'model-a',
            label: 'Model A',
            isDefault: false,
            defaultEffort: 'high',
            efforts: [{ value: 'high', label: 'High' }]
          },
          {
            id: 'model-b',
            label: 'Model B',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: [{ value: 'medium', label: 'Medium' }]
          }
        ]
      },
      'discovery'
    )
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
    const adapter = adapterFor(codex, { model: 'model-a', codexHome: '/test-account' }, [], {
      modelCatalog: store
    })
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
    expect(codex.connections[0]?.calls.map((call) => call.method)).not.toContain('model/list')
    expect(codex.connections[0]?.calls.map((call) => call.method)).not.toContain('config/read')
  })

  it('opens from the first captured model even when launch resolution saw a newer saved pick', async () => {
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'opened' } }) })
    const adapter = adapterFor(codex, { model: 'model-b' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'model-a', effort: 'high' }
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      executionOptions: { model: 'model-a', effort: 'high' },
      fence: 7
    })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'thread/start')?.params
    ).toMatchObject({ model: 'model-a' })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'model-a', effort: 'high' })
  })

  it('uses native defaults through a held catalog read and allows the child to close', async () => {
    const codex = fakeCodex({
      'model/list': () => new Promise<never>(() => {}),
      'turn/start': () => ({ turn: { id: 'opened' } })
    })
    const adapter = adapterFor(codex, { model: 'newer-saved-model' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1',
      options: {}
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'default',
      body: USER_MESSAGE,
      executionOptions: {},
      fence: 7
    })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'thread/start')?.params
    ).not.toHaveProperty('model')
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'turn/start')?.params
    ).not.toHaveProperty('model')
    expect(await adapter.closeSession('session-1')).toBe(true)
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

  it('sends a fresh default while model discovery is held', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === 'model/list') {
        return new Promise<never>(() => {})
      }
      return { turn: { id: 'default-turn' } }
    })
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', effort: 'high' }
    session.nativeDefaults = { model: 'model-a', effort: 'high' }
    const turnOptions = await resolvedCodexMessageOptions(session, {})
    await startCodexTurn(session, {
      clientMessageId: 'default',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      turnOptions
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual(['turn/start'])
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      personality: 'none',
      serviceTier: 'default'
    })
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('model')
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('effort')
  })

  it('restores opened native defaults after an explicit override without a catalog', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'opened' }
    }))
    const session = optionSession(request)
    session.reportedOptions = { model: 'native-model', effort: 'medium' }
    session.nativeDefaults = { model: 'native-model', effort: 'medium' }
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    await startCodexTurn(session, {
      clientMessageId: 'override',
      body,
      turnOptions: await resolvedCodexMessageOptions(session, {
        model: 'other-model',
        effort: 'high'
      })
    })
    await startCodexTurn(session, {
      clientMessageId: 'reset',
      body,
      turnOptions: await resolvedCodexMessageOptions(session, {})
    })
    expect(request.mock.calls.map(([, params]) => params)).toMatchObject([
      { model: 'other-model', effort: 'high' },
      { model: 'native-model', effort: 'medium', personality: 'none', serviceTier: 'default' }
    ])
  })

  it('refuses a default reset with no trustworthy default before prompt input', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'unexpected' } }))
    const session = optionSession(request)
    session.options.set('model', 'old-override')
    session.options.set('effort', 'high')
    await expect(resolvedCodexMessageOptions(session, {})).rejects.toThrow(
      'default model is unavailable'
    )
    expect(request).not.toHaveBeenCalled()
  })

  it('restores native options after a known refusal and retains them after an unknown answer', async () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    const known = optionSession(
      vi.fn(async () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
      })
    )
    known.options.set('model', 'prior')
    await expect(
      startCodexTurn(known, { clientMessageId: 'known', body, turnOptions: { model: 'attempted' } })
    ).rejects.toThrow('invalid model')
    expect(Object.fromEntries(known.options)).toEqual({ model: 'prior' })
    const unknown = optionSession(
      vi.fn(async () => {
        throw new Error('connection lost after write')
      })
    )
    unknown.options.set('model', 'prior')
    await expect(
      startCodexTurn(unknown, {
        clientMessageId: 'unknown',
        body,
        turnOptions: { model: 'attempted' }
      })
    ).rejects.toThrow('connection lost after write')
    expect(Object.fromEntries(unknown.options)).toEqual({ model: 'attempted' })
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
