import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

describe('session selection without declared roles', () => {
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
