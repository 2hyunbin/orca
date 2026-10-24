import { expect, it, vi } from 'vitest'
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
