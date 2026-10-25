import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { selectFreshExplicitAgentStatusRow } from '../runtime/runtime-hook-agent-row-selection'
import { makePaneKey } from '../../shared/stable-pane-id'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const paneKey = makePaneKey('real-pi-managers', '44444444-4444-4444-8444-444444444444')
class Sink extends AgentHookServer {
  accept(body: unknown) {
    const event = normalizeHookPayload(this.state, 'pi', body, 'production')
    if (event) {
      this.applyNormalizedStatus(event)
    }
    return event
  }
  visibleRow() {
    return selectFreshExplicitAgentStatusRow({
      handles: [],
      paneKeys: [paneKey],
      hookRows: this.getStatusSnapshot()
    })
  }
  savedSession() {
    return JSON.parse(this.serializeStatusFile()).entries[paneKey]?.providerSession
  }
}

// The pinned-package smoke supplies this path; ordinary unit runs need no provider install.
it.skipIf(!process.env.ORCA_PI_TEST_PACKAGE)(
  'keeps real Pi managers selected across helper creation and runtime replacement',
  async () => {
    const root = process.env.ORCA_PI_TEST_PACKAGE!
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('1.3.0')
    const { SessionManager } = await import(
      /* @vite-ignore */ pathToFileURL(join(root, 'dist/core/session-manager.js')).href
    )
    const directory = await mkdtemp(join(tmpdir(), 'orca-pi-session-'))
    const sink = new Sink()
    try {
      const append = (manager: ReturnType<typeof SessionManager.create>) =>
        manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'saved reply' }],
          timestamp: 1700000000000
        })
      const lead = SessionManager.create(directory, join(directory, 'lead'))
      append(lead)
      const accepted: ReturnType<typeof normalizeHookPayload>[] = []
      const h = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', join(root, 'dist/cli.js')],
        existsSync,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'real-pi-managers',
          ORCA_AGENT_HOOK_ENV: 'production',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        fetchImpl: async (_url, init) => {
          accepted.push(sink.accept(JSON.parse(String(init?.body))))
          return { ok: true }
        }
      })
      await h.callHook('session_start', { reason: 'startup' }, { sessionManager: lead })
      await h.callHook('before_agent_start', { prompt: 'Lead work' }, { sessionManager: lead })
      await h.callHook('agent_start', {}, { sessionManager: lead })
      await h.callHook('tool_execution_start', { toolName: 'task' }, { sessionManager: lead })
      const helper = SessionManager.create(directory, join(directory, 'helper'), {
        parentSession: lead.getSessionFile()
      })
      append(helper)
      expect(helper.getHeader().parentSession).toBe(lead.getSessionFile())
      const child = h.registerSession()
      await child.callHook('session_start', { reason: 'startup' }, { sessionManager: helper })
      await child.callHook('agent_start', {}, { sessionManager: helper })
      await vi.waitFor(() => expect(accepted.length).toBeGreaterThan(0))
      expect(accepted.every((event) => event?.providerSession?.id === lead.getSessionId())).toBe(
        true
      )
      await h.callHook('agent_end', {}, { sessionManager: lead })
      await child.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'helper answer' } },
        { sessionManager: helper }
      )
      await child.callHook('agent_end', {}, { sessionManager: helper })
      await vi.waitFor(() =>
        expect(
          JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.hook_event_name
        ).toBe('agent_end')
      )
      expect(accepted.at(-1)?.payload.state).toBe('done')
      expect(sink.savedSession()).toMatchObject({
        id: lead.getSessionId(),
        transcriptPath: lead.getSessionFile()
      })
      let manager = lead
      let runtime = { callHook: h.callHook }
      for (const reason of ['resume', 'new', 'fork', 'reload'] as const) {
        const previousSessionFile = manager.getSessionFile()
        const next =
          reason === 'new'
            ? SessionManager.create(directory, join(directory, 'new'))
            : reason === 'resume'
              ? SessionManager.open(helper.getSessionFile())
              : reason === 'fork'
                ? SessionManager.open(manager.getSessionFile())
                : manager
        if (reason === 'fork') {
          next.createBranchedSession(next.getLeafId())
          expect(next.getHeader().parentSession).toBe(previousSessionFile)
        }
        if (reason !== 'new') {
          append(next)
        }
        await runtime.callHook(
          'session_shutdown',
          { reason, targetSessionFile: next.getSessionFile() },
          { sessionManager: manager }
        )
        runtime = h.registerSession()
        manager = next
        const previousVisible = sink.visibleRow()
        const startupCount = h.fetchMock.mock.calls.length
        await runtime.callHook(
          'session_start',
          { reason, ...(reason === 'reload' ? {} : { previousSessionFile }) },
          { sessionManager: manager }
        )
        if (reason !== 'reload') {
          await vi.waitFor(() => {
            expect(h.fetchMock.mock.calls.length).toBeGreaterThan(startupCount)
            expect(
              JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.hook_event_name
            ).toBe('session_start')
          })
        }
        if (reason === 'new') {
          expect(previousVisible).toMatchObject({
            state: 'done',
            prompt: 'Selected resume',
            providerSession: { id: helper.getSessionId() }
          })
          expect(existsSync(manager.getSessionFile())).toBe(false)
          expect(sink.visibleRow()).toEqual(previousVisible)
          append(manager)
        } else if (reason === 'resume') {
          expect(accepted.at(-1)).toMatchObject({
            providerSessionOnly: true,
            providerSession: { id: helper.getSessionId() }
          })
          expect(sink.visibleRow()).toBeNull()
        }
        await runtime.callHook(
          'before_agent_start',
          { prompt: `Selected ${reason}` },
          { sessionManager: manager }
        )
        await vi.waitFor(() => expect(accepted.at(-1)?.payload.prompt).toBe(`Selected ${reason}`))
        await runtime.callHook('agent_start', {}, { sessionManager: manager })
        await vi.waitFor(() =>
          expect(accepted.at(-1)?.providerSession?.id).toBe(manager.getSessionId())
        )
        expect(sink.savedSession()).toMatchObject({
          id: manager.getSessionId(),
          transcriptPath: manager.getSessionFile()
        })
        await runtime.callHook('agent_end', {}, { sessionManager: manager })
        await vi.waitFor(() =>
          expect(
            JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.hook_event_name
          ).toBe('agent_end')
        )
      }
      const fileless = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', join(root, 'dist/cli.js'), '--no-session']
      })
      manager = SessionManager.inMemory(directory)
      runtime = { callHook: fileless.callHook }
      await runtime.callHook('session_start', { reason: 'startup' }, { sessionManager: manager })
      for (const reason of ['new', 'fork'] as const) {
        await runtime.callHook(
          'session_shutdown',
          { reason, targetSessionFile: undefined },
          { sessionManager: manager }
        )
        if (reason === 'new') {
          manager = SessionManager.inMemory(directory)
        } else {
          manager.newSession()
        }
        const count = fileless.fetchMock.mock.calls.length
        runtime = fileless.registerSession()
        await runtime.callHook(
          'session_start',
          { reason, previousSessionFile: undefined },
          { sessionManager: manager }
        )
        await runtime.callHook('agent_start', {}, { sessionManager: manager })
        await vi.waitFor(() => expect(fileless.fetchMock.mock.calls.length).toBeGreaterThan(count))
        expect(
          JSON.parse(String(fileless.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload
        ).not.toHaveProperty('session_file')
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
