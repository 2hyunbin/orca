import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

describe('session selection without declared roles', () => {
  it.each(['pi', 'omp'] as const)(
    'keeps %s helper attention on the selected lead',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({ kind, existsSync: () => true })
      const root = {
        sessionManager: { getSessionId: () => 'lead', getSessionFile: () => '/lead.jsonl' }
      }
      const child = {
        sessionManager: { getSessionId: () => 'helper', getSessionFile: () => '/helper.jsonl' }
      }
      await harness.callHook('session_start', {}, root)
      await harness.callHook('agent_start', {}, root)
      const helper = harness.registerSession()
      await helper.callHook('session_start', {}, child)
      await helper.callHook('tool_call', { toolName: 'ask', input: { question: 'choose' } }, child)
      await vi.waitFor(() =>
        expect(
          JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.tool_name
        ).toBe('ask')
      )
      expect(
        JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.session_id
      ).toBe('lead')
      if (kind === 'pi') {
        await helper.callHook('ui_prompt_start', {}, child)
        await vi.waitFor(() =>
          expect(
            JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload
              .ui_prompt_active
          ).toBe(true)
        )
        await helper.callHook('ui_prompt_end', {}, { ...child, isIdle: () => true })
        await vi.waitFor(() =>
          expect(
            JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.is_idle
          ).toBe(false)
        )
      }
      await helper.callHook('session_shutdown', {}, child)
      await harness.callHook('agent_end', {}, root)
      await vi.waitFor(() =>
        expect(
          JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.hook_event_name
        ).toBe('agent_end')
      )
    }
  )

  it('allows a declaration to replace a startup-order guess', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const guessed = {
      sessionManager: { getSessionId: () => 'early', getSessionFile: () => '/early.jsonl' }
    }
    await harness.callHook('session_start', {}, guessed)
    const declared = harness.registerSession()
    const main = {
      agent: { kind: 'main' as const },
      sessionManager: { getSessionId: () => 'lead', getSessionFile: () => '/lead.jsonl' }
    }
    await declared.callHook('session_start', {}, main)
    await declared.callHook('agent_start', {}, main)
    await vi.waitFor(() =>
      expect(
        JSON.parse(String(harness.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload.session_id
      ).toBe('lead')
    )
    const count = harness.fetchMock.mock.calls.length
    await harness.callHook('agent_end', {}, guessed)
    const undeclared = harness.registerSession()
    await undeclared.callHook('session_switch', {}, guessed)
    expect(harness.fetchMock).toHaveBeenCalledTimes(count)
  })
})
