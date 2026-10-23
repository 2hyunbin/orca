import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const context = (id: string, file?: string): HookContext => ({
  sessionManager: { getSessionId: () => id, getSessionFile: () => file },
  isIdle: () => true,
  ui: { setTitle: vi.fn() }
})
const flush = () => vi.advanceTimersByTimeAsync(0)
const payloads = (h: ReturnType<typeof createAgentStatusExtensionHarness>) =>
  h.fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)

describe('selected source lifetime', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('hands fileless new/fork/resume/reload to the announced successor only', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'pi',
      argv: ['node', '/usr/bin/pi'],
      existsSync: () => true
    })
    let active = { callHook: h.callHook }
    let ctx = context('fileless')
    await active.callHook('session_start', { reason: 'startup' }, ctx)
    await active.callHook('agent_start', {}, ctx)
    await flush()
    expect(payloads(h).at(-1)).not.toHaveProperty('session_file')
    const refused = async (reason: string, file?: string) => {
      const child = h.registerSession()
      await child.callHook('session_start', { reason }, context('unannounced', file))
      await child.callHook('agent_start', {}, context('unannounced', file))
      await flush()
      expect(payloads(h).at(-1)?.session_id).not.toBe('unannounced')
    }
    // A cancelled operation never shuts the selected runner down.
    await refused('new')
    for (const [reason, id, file] of [
      ['new', 'new-fileless', undefined],
      ['fork', 'fork-fileless', undefined],
      ['resume', 'persisted', '/persisted.jsonl'],
      ['reload', 'persisted', '/persisted.jsonl']
    ] as const) {
      const old = active
      await old.callHook('session_shutdown', { reason, targetSessionFile: file }, ctx)
      if (reason !== 'reload') {
        await refused('startup')
        await refused(reason === 'new' ? 'fork' : 'new')
        await refused(reason, '/wrong-target.jsonl')
      }
      const next = context(id, file)
      active = h.registerSession()
      await active.callHook(
        'session_start',
        {
          reason,
          ...(reason === 'reload'
            ? {}
            : { previousSessionFile: ctx.sessionManager?.getSessionFile?.() })
        },
        next
      )
      const beforeStart = payloads(h).length
      await active.callHook('agent_start', {}, next)
      await flush()
      expect(payloads(h).length).toBeGreaterThan(beforeStart)
      expect(payloads(h).at(-1)?.hook_event_name).toBe('agent_start')
      await active.callHook('agent_end', {}, next)
      await flush()
      expect(payloads(h).at(-1)).toMatchObject({
        hook_event_name: 'agent_end',
        ...(file ? { session_id: id } : {})
      })
      if (!file) {
        expect(payloads(h).at(-1)).not.toHaveProperty('session_file')
      }
      const count = payloads(h).length
      await old.callHook('agent_start', {}, ctx)
      await flush()
      expect(payloads(h)).toHaveLength(count)
      await refused(reason)
      ctx = next
    }
  })

  it.each(['first', 'last', 'only', undefined] as const)(
    'shares selection with titlebar=%s without retiring the other producer',
    async (titlebar) => {
      const h = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', '/usr/bin/pi'],
        titlebar,
        existsSync: () => true
      })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', { reason: 'startup' }, root)
      await h.callHook('agent_start', {}, root)
      const child = h.registerSession()
      await child.callHook('session_start', { reason: 'startup' }, context('helper'))
      await child.callHook('agent_start', {}, context('helper'))
      if (titlebar) {
        const before = vi.mocked(root.ui!.setTitle!).mock.calls.length
        await vi.advanceTimersByTimeAsync(160)
        expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBeGreaterThan(before)
      }
      await h.callHook('ui_prompt_start', {}, root)
      await h.callHook('session_shutdown', { reason: 'new', targetSessionFile: undefined }, root)
      await flush()
      if (titlebar) {
        expect(vi.mocked(root.ui!.setTitle!).mock.lastCall?.[0]).toBe('π - selected title - repo')
      }
      if (titlebar !== 'only') {
        expect(payloads(h).at(-1)).toMatchObject({
          hook_event_name: 'agent_end',
          session_boundary: true
        })
      }
      const count = vi.mocked(root.ui!.setTitle!).mock.calls.length
      const next = h.registerSession()
      const nextCtx = context('new')
      await next.callHook(
        'session_start',
        { reason: 'new', previousSessionFile: '/lead.jsonl' },
        nextCtx
      )
      await next.callHook('agent_start', {}, nextCtx)
      await flush()
      if (titlebar !== 'only') {
        expect(payloads(h).at(-1)).toMatchObject({
          hook_event_name: 'agent_start'
        })
      }
      expect(payloads(h).at(-1)?.ui_prompt_active).not.toBe(true)
      await h.callHook('agent_start', {}, root)
      await vi.advanceTimersByTimeAsync(160)
      expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBe(count)
      await next.callHook('session_shutdown', { reason: 'reload' }, nextCtx)
      const reloaded = h.registerSession()
      await reloaded.callHook('session_start', { reason: 'reload' }, nextCtx)
      await reloaded.callHook('agent_start', {}, nextCtx)
      await reloaded.callHook('agent_end', {}, nextCtx)
      await flush()
      if (titlebar) {
        expect(vi.mocked(nextCtx.ui!.setTitle!).mock.lastCall?.[0]).toBe(
          'π - selected title - repo'
        )
      }
    }
  )

  it.each(['first', 'last', 'only'] as const)(
    'moves OMP painter through switch with titlebar=%s',
    async (titlebar) => {
      const h = createAgentStatusExtensionHarness({ kind: 'omp', titlebar })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', {}, root)
      await h.callHook('agent_start', {}, root)
      const next = context('fork', '/fork.jsonl')
      await h.callHook('session_branch', { reason: 'fork' }, next)
      await h.callHook('agent_start', {}, next)
      const before = vi.mocked(root.ui!.setTitle!).mock.calls.length
      await vi.advanceTimersByTimeAsync(160)
      expect(vi.mocked(root.ui!.setTitle!).mock.calls.length).toBe(before)
      await h.callHook('agent_end', {}, next)
      await flush()
      expect(vi.mocked(next.ui!.setTitle!).mock.lastCall?.[0]).toBe('π - selected title - repo')
    }
  )

  it.each(['pi', 'omp'] as const)(
    'keeps a pre-upgrade %s process reporting through helper-first reload',
    async (kind) => {
      const h = createAgentStatusExtensionHarness({
        kind,
        env: { ORCA_PI_STATUS_OWNED: '4242' },
        existsSync: () => true
      })
      const child = h.registerSession()
      await child.callHook(
        'session_start',
        { reason: 'startup' },
        context('helper', '/helper.jsonl')
      )
      await h.callHook('session_start', { reason: 'reload' }, context('lead', '/lead.jsonl'))
      await h.callHook('agent_start', {}, context('lead', '/lead.jsonl'))
      await flush()
      expect(payloads(h).at(-1)).toMatchObject({
        session_id: 'lead',
        hook_event_name: 'agent_start'
      })
    }
  )

  it.each(['pi', 'omp'] as const)(
    'retires only the originating %s attention and derives the lead close state',
    async (kind) => {
      const state = createHookListenerState()
      const normalized: string[] = []
      const h = createAgentStatusExtensionHarness({
        kind,
        argv: ['node', kind],
        env: {
          ORCA_TAB_ID: 'source-lifetime',
          ORCA_PANE_KEY: makePaneKey('source-lifetime', '44444444-4444-4444-8444-444444444444'),
          ORCA_AGENT_HOOK_ENV: 'production',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        existsSync: () => true,
        fetchImpl: async (_url, init) => {
          const event = normalizeHookPayload(
            state,
            kind,
            JSON.parse(String(init?.body)),
            'production'
          )
          if (event) {
            normalized.push(event.payload.state)
          }
          return { ok: true }
        }
      })
      const root = context('lead', '/lead.jsonl')
      await h.callHook('session_start', {}, root)
      await h.callHook('agent_start', {}, root)
      await h.callHook('agent_end', {}, root)
      await flush()
      expect(normalized.at(-1)).toBe('done')
      const child = h.registerSession()
      const childCtx = context('child')
      await child.callHook('session_start', {}, childCtx)
      for (const toolName of kind === 'pi'
        ? ['ask_user_question', 'request_user_input', 'AskUserQuestion']
        : ['ask']) {
        await child.callHook(
          'tool_call',
          {
            toolName,
            input: {
              questions: [
                {
                  id: 'choice',
                  question: 'Which output?',
                  options: [{ label: 'A' }, { label: 'B' }]
                }
              ]
            }
          },
          childCtx
        )
        await flush()
        expect(normalized.at(-1)).toBe('blocked')
        await child.callHook('tool_execution_start', { toolName }, childCtx)
        await child.callHook('tool_execution_end', { toolName }, childCtx)
        await flush()
        expect(normalized.at(-1)).toBe('done')
      }
      await h.callHook('agent_start', {}, root)
      await child.callHook(
        'tool_call',
        { toolName: kind === 'pi' ? 'ask_user_question' : 'ask' },
        childCtx
      )
      await child.callHook(
        'tool_execution_end',
        { toolName: kind === 'pi' ? 'ask_user_question' : 'ask' },
        childCtx
      )
      await flush()
      expect(normalized.at(-1)).toBe('working')
      const open = kind === 'pi' ? 'ui_prompt_start' : 'tool_approval_requested'
      const close = kind === 'pi' ? 'ui_prompt_end' : 'tool_approval_resolved'
      await h.callHook(open, { toolName: 'lead-tool' }, root)
      await child.callHook(open, { toolName: 'child-tool' }, childCtx)
      await child.callHook(close, { toolName: 'child-tool' }, childCtx)
      await flush()
      expect(normalized.at(-1)).toBe(kind === 'pi' ? 'waiting' : 'blocked')
      await h.callHook(close, { toolName: 'lead-tool' }, root)
      const other = h.registerSession()
      const otherCtx = context('other')
      await other.callHook('session_start', {}, otherCtx)
      await child.callHook(open, { toolName: 'bash' }, childCtx)
      await other.callHook(open, { toolName: 'read' }, otherCtx)
      await child.callHook('session_shutdown', {}, childCtx)
      await flush()
      expect(normalized.at(-1)).toBe(kind === 'pi' ? 'waiting' : 'blocked')
      await h.callHook('agent_end', {}, root)
      await other.callHook('session_shutdown', {}, otherCtx)
      await flush()
      expect(normalized.at(-1)).toBe('done')
      await h.callHook('agent_start', {}, root)
      await h.callHook(open, { toolName: 'lead-tool' }, root)
      // A new turn also retires an abandoned wait on that same source.
      await h.callHook('agent_start', {}, root)
      const fresh = h.registerSession()
      const freshCtx = context('fresh')
      await fresh.callHook('session_start', {}, freshCtx)
      await fresh.callHook(open, { toolName: 'fresh-tool' }, freshCtx)
      await fresh.callHook(close, { toolName: 'fresh-tool' }, freshCtx)
      await flush()
      expect(normalized.at(-1)).toBe('working')
      expect(payloads(h).every((payload) => payload.session_id === 'lead')).toBe(true)
    }
  )

  it('drains early attention once with linear work and constant ordinary/retirement work', async () => {
    const measure = async (n: number) => {
      let visits = 0
      const h = createAgentStatusExtensionHarness({ kind: 'omp', onMapEntry: () => visits++ })
      const sources = []
      for (let i = 0; i < n; i++) {
        const child = h.registerSession()
        const ctx = { ...context(String(i)), agent: { kind: 'sub' as const } }
        await child.callHook('session_start', {}, ctx)
        await child.callHook('tool_approval_requested', { toolName: 'bash' }, ctx)
        await child.callHook('tool_approval_requested', { toolName: 'read' }, ctx)
        sources.push({ child, ctx })
      }
      const abandoned = sources.pop()!
      let before = visits
      await abandoned.child.callHook('session_shutdown', {}, abandoned.ctx)
      expect(visits - before).toBeLessThanOrEqual(4)
      const root = { ...context('lead'), agent: { kind: 'main' as const } }
      before = visits
      await h.callHook('session_start', {}, root)
      const drain = visits - before
      expect(drain).toBeGreaterThanOrEqual(n - 1)
      expect(drain).toBeLessThanOrEqual(4 * n)
      await flush()
      before = visits
      for (let i = 0; i < 10; i++) {
        await h.callHook('agent_start', {}, root)
      }
      await flush()
      expect(visits - before).toBe(0)
      expect(payloads(h).at(-1)?.hook_event_name).toBe('agent_start')
      return drain
    }
    expect(await measure(100)).toBeLessThanOrEqual(10 * (await measure(10)) + 20)
  })

  it('keeps Prime always active through shutdown and re-registration', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'prime-agent', existsSync: () => true })
    await h.callHook('session_start', {}, context('lead'))
    await h.callHook('session_shutdown', {}, context('lead'))
    h.reload()
    await h.callHook('session_start', {}, context('next', '/next.jsonl'))
    await h.callHook('agent_start', {}, context('next', '/next.jsonl'))
    await flush()
    expect(payloads(h).at(-1)).toMatchObject({ session_id: 'next', hook_event_name: 'agent_start' })
  })
})
