import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { changeCodexThreadGoal, codexThreadGoalRequests } from './codex-structured-thread-goal'
import type { CodexSession } from './codex-structured-session-state'

const THREAD = 'thread-1'

function session(request: (...args: unknown[]) => Promise<unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the goal path reads only these two fields.
  return { threadId: THREAD, connection: { request } } as unknown as Pick<
    CodexSession,
    'connection' | 'threadId'
  >
}

describe('codex thread goal requests', () => {
  it('sets an objective as an active goal with no turn of its own', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'set', objective: 'Ship it' }, false)).toEqual([
      {
        method: 'thread/goal/set',
        params: { threadId: THREAD, objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('clears the existing goal before setting a new objective, so the new goal starts fresh', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'set', objective: 'Ship it' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD } },
      {
        method: 'thread/goal/set',
        params: { threadId: THREAD, objective: 'Ship it', status: 'active' }
      }
    ])
  })

  it('pauses and resumes by status alone, keeping the objective', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'paused' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, status: 'paused' } }
    ])
    expect(codexThreadGoalRequests(THREAD, { kind: 'status', status: 'active' }, true)).toEqual([
      { method: 'thread/goal/set', params: { threadId: THREAD, status: 'active' } }
    ])
  })

  it('clears with only the thread id', () => {
    expect(codexThreadGoalRequests(THREAD, { kind: 'clear' }, true)).toEqual([
      { method: 'thread/goal/clear', params: { threadId: THREAD } }
    ])
  })

  it('sends each request in order with the session deadline', async () => {
    const request = vi.fn(async () => ({ goal: null }))
    await expect(
      changeCodexThreadGoal(session(request), { kind: 'set', objective: 'Ship it' }, true, 5_000)
    ).resolves.toEqual({ ok: true })
    expect(request.mock.calls).toEqual([
      ['thread/goal/clear', { threadId: THREAD }, { timeoutMs: 5_000 }],
      [
        'thread/goal/set',
        { threadId: THREAD, objective: 'Ship it', status: 'active' },
        { timeoutMs: 5_000 }
      ]
    ])
  })

  it('awaits a revoked clear and never activates the replacement', async () => {
    const clear = Promise.withResolvers<unknown>()
    const authority = new AbortController()
    const request = vi.fn(() => clear.promise)
    const result = changeCodexThreadGoal(
      session(request),
      { kind: 'set', objective: 'Ship it' },
      true,
      undefined,
      authority.signal
    )
    const settled = vi.fn()
    void result.then(settled, settled)
    authority.abort(new Error('stopped'))
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    clear.resolve({ goal: null })
    await expect(result).rejects.toThrow('stopped')
    expect(request).toHaveBeenCalledOnce()
  })

  it('stops at a refused clear, so a refused replacement leaves the old goal alone', async () => {
    const request = vi.fn(async (method: unknown) => {
      if (method === 'thread/goal/clear') {
        throw new CodexAppServerRequestError('thread/goal/clear', -32600, 'goals are disabled')
      }
      return { goal: null }
    })
    await expect(
      changeCodexThreadGoal(session(request), { kind: 'set', objective: 'Ship it' }, true, 5_000)
    ).resolves.toEqual({ ok: false, rejected: 'goals are disabled' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reports a provider refusal and rethrows anything that leaves the effect unknown', async () => {
    const refused = session(async () => {
      throw new CodexAppServerRequestError('thread/goal/set', -32600, 'goals feature is disabled')
    })
    await expect(
      changeCodexThreadGoal(refused, { kind: 'set', objective: 'Ship it' }, false, undefined)
    ).resolves.toEqual({ ok: false, rejected: 'goals feature is disabled' })

    const lost = session(async () => {
      throw new Error('codex app-server request timed out')
    })
    await expect(changeCodexThreadGoal(lost, { kind: 'clear' }, false, undefined)).rejects.toThrow(
      'timed out'
    )
  })
})

describe('direct goal settings application', () => {
  async function fixture(timeout = 1_000) {
    const { fakeCodex, adapterFor, acquireReadyCodexForTest, identityFor } =
      await import('./codex-structured-session-adapter-fixture')
    const codex = fakeCodex()
    const adapter = adapterFor(codex, {}, [], { requestTimeoutMs: timeout })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn'
    })
    const apply = (model = 'gpt-live', effort: string | null = 'medium') =>
      codex.connections[0].handlers.onNotification?.('thread/settings/updated', {
        threadId: 'thread-abc',
        threadSettings: { model, effort }
      })
    const goal = (model = 'gpt-live', effort?: string) =>
      adapter.changeThreadGoal({
        sessionId: 'session-1',
        fence: 7,
        change: { kind: 'status', status: 'active' },
        replacesGoal: false,
        executionOptions: { model, ...(effort ? { effort } : {}) }
      })
    return { codex, adapter, apply, goal }
  }

  it('retains authoritative A after a definitely rejected turn B, so a no-op Resume A needs no notification', async () => {
    const { codex, adapter, goal } = await fixture()
    codex.routes['turn/start'] = () => {
      throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
    }
    expect(
      await adapter.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'message',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Try B' }] },
        executionOptions: { model: 'model-b', effort: 'high' }
      })
    ).toMatchObject({ state: 'rejected' })
    expect(await goal()).toEqual({ ok: true })
    expect(codex.connections[0].calls.some((r) => r.method === 'thread/settings/update')).toBe(
      false
    )
    await adapter.closeAll()
  })

  it.each([false, true])(
    'requires RPC success even when matching application arrives before its reply (reject=%s)',
    async (reject) => {
      const { codex, adapter, apply, goal } = await fixture()
      const answer = Promise.withResolvers<unknown>()
      codex.routes['thread/settings/update'] = () => {
        apply('model-b', 'high')
        return answer.promise
      }
      const pending = goal('model-b', 'high')
      await Promise.resolve()
      expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(false)
      if (reject) {
        answer.reject(
          new CodexAppServerRequestError('thread/settings/update', -32602, 'invalid model')
        )
      } else {
        answer.resolve({})
      }
      expect(await pending).toMatchObject({ ok: !reject })
      expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(!reject)
      await adapter.closeAll()
    }
  )

  it('bounds an acknowledged but unapplied update, and cancels its waiter on connection end', async () => {
    const { codex, adapter, goal, apply } = await fixture(10)
    vi.useFakeTimers()
    try {
      const pending = goal('model-b', 'high')
      await vi.advanceTimersByTimeAsync(10)
      expect(await pending).toMatchObject({
        ok: false,
        rejected: expect.stringContaining('did not confirm')
      })
      expect(codex.connections[0].calls.some((r) => r.method === 'thread/goal/set')).toBe(false)
      apply('model-b', null)
      // Null is known provider state; an omitted effort is no override.
      expect(await goal('model-b')).toEqual({ ok: true })
      const closing = goal('model-c', 'high')
      await adapter.closeSession('session-1')
      expect(await closing).toMatchObject({
        ok: false,
        rejected: expect.stringContaining('did not confirm')
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      await adapter.closeAll()
    }
  })
})

it('stops a settings wait as a definite pre-goal rejection without leaving an active waiter', async () => {
  const { fakeCodex, adapterFor, acquireReadyCodexForTest, identityFor } =
    await import('./codex-structured-session-adapter-fixture')
  const codex = fakeCodex()
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn'
  })
  const signal = new AbortController()
  const result = adapter.changeThreadGoal({
    sessionId: 'session-1',
    fence: 7,
    change: { kind: 'set', objective: 'not sent' },
    replacesGoal: true,
    executionOptions: { model: 'new-model' },
    signal: signal.signal
  })
  signal.abort(new Error('stopped'))
  expect(await result).toMatchObject({
    ok: false,
    rejected: expect.stringContaining('This goal change was not sent.')
  })
  codex.connections[0].handlers.onNotification?.('thread/settings/updated', {
    threadId: 'thread-abc',
    threadSettings: { model: 'new-model', effort: null }
  })
  expect(codex.connections[0].calls.some((r) => r.method.startsWith('thread/goal/'))).toBe(false)
  await adapter.closeAll()
})
