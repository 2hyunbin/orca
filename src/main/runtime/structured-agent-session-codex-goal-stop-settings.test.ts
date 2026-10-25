import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { AGENT_SESSION_GOAL_CONTROL_COPY as COPY } from '../../shared/agent-session-goal-control-copy'
import type { AgentSessionThreadGoalChange } from '../../shared/agent-session-thread-goal-wire'
import { CodexAppServerRequestError } from '../codex/app-server/codex-app-server-request-error'
import {
  CODEX_SCRIPTED_THREAD as THREAD,
  codexScriptedChild
} from '../codex/codex-scripted-child.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

const CALLER = { callerKey: 'goal-stop-settings' }
let root: string | undefined
let operation = 0
const eventually = (check: () => void | Promise<void>) => vi.waitFor(check, { timeout: 10_000 })

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

function envelope(
  host: StructuredAgentSessionHost,
  method: string,
  fields: Record<string, unknown>
) {
  return {
    sessionId: SESSION,
    clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
    expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function openChat(child: ReturnType<typeof codexScriptedChild>) {
  root = await mkdtemp(join(tmpdir(), 'orca-goal-stop-settings-'))
  child.holdHandshakes = false
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root ?? '',
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    ...child.deps
  })
  const params = hostTestAttachParams(null, {
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex') },
    providerHandle: undefined
  })
  params.envelope.clientOperationId = `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await eventually(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
  return host
}

const goal = (host: StructuredAgentSessionHost, change: AgentSessionThreadGoalChange) =>
  host.changeThreadGoal(CALLER, {
    envelope: envelope(host, 'agentSession.threadGoal', { change }),
    change
  })
const stop = (host: StructuredAgentSessionHost) =>
  host.cancel(CALLER, { envelope: envelope(host, 'agentSession.cancel', {}) })
const setOption = (host: StructuredAgentSessionHost, key: string, value: string) =>
  host.setOption(CALLER, {
    envelope: envelope(host, 'agentSession.setOption', { key, value }),
    key,
    value
  })
async function rows(host: StructuredAgentSessionHost) {
  return (await host.journalSnapshot(SESSION)).items.flatMap((row) =>
    row.body.kind === 'status' ? [row.body.text] : []
  )
}

it('waits for applied saved model/effort before direct Set and Resume, and keeps settings when the goal fails', async () => {
  const reply = Promise.withResolvers<unknown>()
  let child: ReturnType<typeof codexScriptedChild>
  let rejectGoal = false
  child = codexScriptedChild({
    'thread/settings/update': () => reply.promise,
    'thread/goal/set': () => {
      if (rejectGoal) {
        throw new CodexAppServerRequestError('thread/goal/set', -32602, 'refused goal')
      }
      return {}
    }
  })
  const host = await openChat(child)
  expect(await setOption(host, 'model', 'scripted-alt-model')).toMatchObject({ ok: true })
  expect(await setOption(host, 'effort', 'high')).toMatchObject({ ok: true })
  const change = { kind: 'set' as const, objective: 'Use selected settings' }
  const pending = goal(host, change)
  await eventually(() =>
    expect(child.requests().some((r) => r.method === 'thread/settings/update')).toBe(true)
  )
  reply.resolve({})
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toEqual([])
  child.notify('thread/settings/updated', {
    threadId: 'unrelated',
    threadSettings: { model: 'scripted-alt-model', effort: 'high' }
  })
  await Promise.resolve()
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toEqual([])
  child.notify('thread/settings/updated', {
    threadId: THREAD,
    threadSettings: { model: 'scripted-alt-model', effort: 'high' }
  })
  expect(await pending).toMatchObject({ ok: true })
  expect(child.requests().find((r) => r.method === 'thread/settings/update')?.params).toEqual({
    threadId: THREAD,
    model: 'scripted-alt-model',
    effort: 'high'
  })
  rejectGoal = true
  expect(await goal(host, { kind: 'status', status: 'active' })).toMatchObject({ ok: false })
  rejectGoal = false
  expect(await goal(host, { kind: 'status', status: 'active' })).toMatchObject({ ok: true })
  expect(child.requests().filter((r) => r.method === 'thread/settings/update')).toHaveLength(1)
})

it.each(['rejected', 'unsupported'] as const)(
  'keeps pre-goal %s effects definite through host settlement',
  async (mode) => {
    const child = codexScriptedChild({
      'thread/settings/update': () => {
        throw new CodexAppServerRequestError(
          'thread/settings/update',
          mode === 'unsupported' ? -32601 : -32602,
          mode
        )
      }
    })
    const host = await openChat(child)
    await setOption(host, 'model', 'scripted-alt-model')
    const result = await goal(host, {
      kind: 'set',
      objective: 'Do not erase a goal for a settings failure'
    })
    expect(result.ok).toBe(mode === 'unsupported')
    expect(child.requests().some((r) => r.method === 'thread/goal/set')).toBe(
      mode === 'unsupported'
    )
    expect(child.requests().some((r) => r.method === 'thread/goal/clear')).toBe(false)
    const snapshot = await host.journalSnapshot(SESSION)
    expect(snapshot.items.some((r) => r.body.kind === 'message' && r.body.sentAs === 'goal')).toBe(
      mode === 'unsupported'
    )
  }
)

it.each([null, 'complete'] as const)(
  'repairs a model-created goal after the first %s read, joins close, and preserves durable uncertainty',
  async (initial) => {
    let state: string | null = initial
    let reads = 0
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        const observed = state
        if (++reads === 1) {
          state = 'active'
        }
        return { goal: observed === null ? null : { status: observed } }
      },
      'thread/goal/set': (params) => {
        state = String(params?.status)
        return { goal: { status: state } }
      }
    })
    const host = await openChat(child)
    const request = { envelope: envelope(host, 'agentSession.cancel', {}) }
    expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
    expect(child.closes()).toBe(1)
    expect(state).toBe('paused')
    expect(
      child
        .requests()
        .filter((r) => r.method.startsWith('thread/goal/'))
        .map((r) => r.method)
    ).toEqual(['thread/goal/get', 'thread/goal/get', 'thread/goal/set'])
    expect(await rows(host)).toContain(COPY.pauseUnconfirmed)
    const calls = child.requests().length
    expect(await host.cancel(CALLER, request)).toMatchObject({ ok: true })
    expect(child.requests()).toHaveLength(calls)
  }
)

it.each(['pause', 'interrupt', 'workload', 'root', 'note'] as const)(
  'retains %s failure after shutdown, including turnless work and strict note failure',
  async (failure) => {
    const child = codexScriptedChild({
      'thread/goal/get': () => ({ goal: { status: 'active' } }),
      'thread/goal/set': () => {
        if (failure === 'pause') {
          throw new CodexAppServerRequestError('thread/goal/set', -32602, 'refused')
        }
        return { goal: { status: 'paused' } }
      },
      ...(failure === 'interrupt'
        ? {
            'turn/interrupt': () => {
              throw new Error('lost interrupt')
            }
          }
        : {})
    })
    const host = await openChat(child)
    if (failure === 'interrupt') {
      child.notify('turn/started', { threadId: THREAD, turn: { id: 'autonomous' } })
    }
    if (failure === 'workload') {
      child.closeEvidence = { root: 'exited', tree: 'unverifiable' }
    }
    if (failure === 'root') {
      vi.spyOn(host.deps.adapter, 'disposeSession').mockResolvedValue(false)
    }
    if (failure === 'note') {
      const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
      if (!journal) {
        throw new Error('missing journal')
      }
      const append = journal.appendLifecycleBatch.bind(journal)
      vi.spyOn(journal, 'appendLifecycleBatch').mockImplementation((batch) => {
        if (batch.settlementId.startsWith('stop-outcome:')) {
          return Promise.reject(new Error('note store unavailable'))
        }
        return append(batch)
      })
      await expect(stop(host)).rejects.toThrow('note store unavailable')
    } else {
      expect(await stop(host)).toMatchObject({ ok: true })
      expect(await rows(host)).toContain(
        failure === 'root' || failure === 'workload' ? COPY.stopUnconfirmed : COPY.pauseUnconfirmed
      )
      if (failure === 'root') {
        expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.close).toBeDefined()
        expect(await stop(host)).toMatchObject({ ok: true })
        expect(await rows(host)).toContain(COPY.stopUnconfirmed)
      } else {
        expect(child.closes()).toBe(1)
      }
    }
  }
)

it('pauses before resolving an autonomous turn and interrupts before the final goal read', async () => {
  const child = codexScriptedChild({
    'thread/goal/get': () => ({ goal: { status: 'active' } }),
    'thread/goal/set': () => {
      child.notify('turn/started', { threadId: THREAD, turn: { id: 'newest' } })
      return { goal: { status: 'paused' } }
    }
  })
  const host = await openChat(child)
  expect(await stop(host)).toMatchObject({ ok: true })
  const calls = child
    .requests()
    .filter((r) => r.method === 'turn/interrupt' || r.method.startsWith('thread/goal/'))
  expect(calls.map((r) => r.method)).toEqual([
    'thread/goal/get',
    'thread/goal/set',
    'turn/interrupt',
    'thread/goal/get',
    'thread/goal/set'
  ])
  expect(calls[2].params?.turnId).toBe('newest')
  expect(child.closes()).toBe(1)
})

it.each(['first-read', 'interrupt'] as const)(
  'bounds %s by original Stop grace and still closes the child',
  async (hung) => {
    const reached = Promise.withResolvers<void>()
    let reads = 0
    const child = codexScriptedChild({
      'thread/goal/get': () => {
        reads++
        if (hung === 'first-read') {
          reached.resolve()
          return new Promise(() => {})
        }
        return { goal: null }
      },
      'turn/interrupt': () => {
        if (hung === 'interrupt') {
          reached.resolve()
          return new Promise(() => {})
        }
        return {}
      }
    })
    const host = await openChat(child)
    child.notify('turn/started', { threadId: THREAD, turn: { id: 'running' } })
    await host.flushStreamedEvents(SESSION)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const pending = stop(host)
    await reached.promise
    await vi.advanceTimersByTimeAsync(1_667)
    expect(child.requests().some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(child.closes()).toBe(0)
    expect(reads).toBe(hung === 'first-read' ? 2 : 1)
    await vi.advanceTimersByTimeAsync(3_333)
    expect(await pending).toMatchObject({ ok: true })
    expect(child.closes()).toBe(1)
    expect(reads).toBe(hung === 'first-read' ? 2 : 1)
    expect(await rows(host)).toContain(COPY.pauseUnconfirmed)
  }
)

it('treats an exact goals-disabled declaration as inapplicable without skipping close', async () => {
  const child = codexScriptedChild({
    'thread/goal/get': () => {
      throw new CodexAppServerRequestError('thread/goal/get', -32600, 'goals feature is disabled')
    }
  })
  const host = await openChat(child)
  expect(await stop(host)).toMatchObject({ ok: true })
  expect(child.closes()).toBe(1)
  expect(child.requests().filter((r) => r.method.startsWith('thread/goal/'))).toHaveLength(1)
  expect(await rows(host)).not.toContain(COPY.pauseUnconfirmed)
})

it('orders Stop behind active-Set handler effects and closes the old child before a later goal', async () => {
  const reply = Promise.withResolvers<unknown>()
  const effects = Promise.withResolvers<void>()
  const reading = Promise.withResolvers<void>()
  let state: string | null = null
  let reads = 0
  let activations = 0
  const trace: string[] = []
  const child = codexScriptedChild({
    'thread/goal/set': (params) => {
      const status = String(params?.status)
      trace.push(status)
      if (status === 'active' && ++activations === 1) {
        return reply.promise
      }
      state = status
      if (status === 'active') {
        expect(child.closes()).toBe(1)
      }
      return { goal: { status } }
    },
    'thread/goal/get': async () => {
      trace.push('get')
      if (++reads === 1) {
        reading.resolve()
        // Both supported provider versions finish the earlier exclusive handler before this Get.
        await effects.promise
        state = 'active'
        child.notify('turn/started', { threadId: THREAD, turn: { id: 'continued' } })
      }
      return { goal: state === null ? null : { status: state } }
    },
    'turn/interrupt': () => {
      trace.push('interrupt')
      child.notify('turn/completed', {
        threadId: THREAD,
        turn: { id: 'continued', status: 'interrupted' }
      })
      return {}
    }
  })
  const host = await openChat(child)
  const first = goal(host, { kind: 'set', objective: 'Earlier goal' })
  await eventually(() => expect(activations).toBe(1))
  const stopping = stop(host)
  reply.resolve({ goal: { status: 'active' } })
  expect(await first).toMatchObject({ ok: true })
  await reading.promise
  const later = goal(host, { kind: 'set', objective: 'Later goal' })
  expect(trace).toEqual(['active', 'get'])
  effects.resolve()
  expect(await stopping).toMatchObject({ ok: true })
  expect(await later).toMatchObject({ ok: true })
  expect(trace).toEqual(['active', 'get', 'paused', 'interrupt', 'get', 'active'])
  expect(state).toBe('active')
  expect(child.closes()).toBe(1)
})
