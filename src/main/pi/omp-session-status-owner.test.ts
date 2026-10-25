import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

it('keeps a later SDK-default main off the selected OMP status and painter until explicit switch', async () => {
  const h = createAgentStatusExtensionHarness({ kind: 'omp', titlebar: 'first' })
  const context = (id: string) => ({
    // The SDK defaults to main when taskDepth and parentTaskPrefix are omitted.
    agent: { kind: 'main' as const },
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/${id}.jsonl` },
    ui: { setTitle: vi.fn() }
  })
  const root = context('lead')
  await h.callHook('session_start', {}, root)
  await h.callHook('agent_start', {}, root)
  await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalled())
  const child = h.registerSession()
  const helper = context('sdk-helper')
  const count = h.fetchMock.mock.calls.length
  await child.callHook('session_start', {}, helper)
  await child.callHook('agent_start', {}, helper)
  expect(helper.ui.setTitle).not.toHaveBeenCalled()
  expect(h.fetchMock).toHaveBeenCalledTimes(count)
  await h.callHook(
    'tool_execution_start',
    { toolName: 'bash', args: { command: 'pwd' } },
    { ...root, agent: { kind: 'sub' } }
  )
  await vi.waitFor(() =>
    expect(JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload).toMatchObject({
      session_id: 'lead',
      tool_name: 'bash'
    })
  )
  await child.callHook('session_switch', { reason: 'resume' }, helper)
  await child.callHook('agent_start', {}, helper)
  await vi.waitFor(() =>
    expect(JSON.parse(String(h.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.session_id).toBe(
      'sdk-helper'
    )
  )
  expect(helper.ui.setTitle).toHaveBeenCalled()
  const titles = root.ui.setTitle.mock.calls.length
  await h.callHook('agent_end', {}, root)
  expect(root.ui.setTitle).toHaveBeenCalledTimes(titles)
  await child.callHook('session_shutdown', {}, helper)
})

const payloadsOf = (harness: ReturnType<typeof createAgentStatusExtensionHarness>) =>
  harness.fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).payload)

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('Pi in-process subagent sessions', () => {
  // Pi caches the extension factory per cwd, so pi-subagents children share module state with the lead.
  it('keeps the lead pane identity and completion while a child session runs', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true })
    const session = (id: string) => ({
      sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
    })
    const lead = session('lead')
    await harness.callHook('session_start', { reason: 'startup' }, lead)
    await harness.callHook('agent_start', {}, lead)
    await settle()
    const leadHandlers = { ...harness.handlers }
    harness.reload()
    const child = {
      sessionManager: {
        ...session('child').sessionManager,
        getHeader: () => ({ parentSession: '/sessions/lead.jsonl' })
      }
    }
    for (const name of ['session_start', 'agent_start', 'message_end', 'agent_end']) {
      await harness.callHook(
        name,
        { reason: 'startup', message: { role: 'assistant', content: 'child done' } },
        child
      )
      await settle()
    }
    await leadHandlers.message_end({ message: { role: 'assistant', content: 'lead done' } }, lead)
    await settle()
    await leadHandlers.agent_end({}, lead)
    await settle()

    const payloads = payloadsOf(harness)
    expect(payloads.map((payload) => payload.session_id).filter(Boolean)).not.toContain('child')
    expect(payloads.at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'lead' })

    harness.reload()
    await harness.callHook(
      'session_start',
      { reason: 'new', previousSessionFile: '/sessions/lead.jsonl' },
      session('next')
    )
    await settle()
    expect(payloadsOf(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'next'
    })
  })
})
