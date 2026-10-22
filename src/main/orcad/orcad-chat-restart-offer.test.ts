import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import {
  attach,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session-recovery-capsule'
import { startOrcadWithLifecycle, stopOrcadStructuredAgentSessions } from './orcad-lifecycle'

vi.mock('../runtime/structured-agent-session-runtime', () => ({
  stopStructuredAgentSessionRuntime: async (options: { trigger: 'quit' }) => {
    await hostTestState().host.flushAllStreamedEvents(options)
  }
}))

it('stops a working server chat and lists its durable offer before the profile closes', async () => {
  await attach()
  const { host, acquire, root } = hostTestState()
  const events = acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
    { kind: 'turn', turnId: 'working', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  let childStopped = false
  host.deps.adapter.closeSession = async () => {
    childStopped = true
    return true
  }
  const server = await startOrcadWithLifecycle(
    async (register) => {
      register(async () => {
        expect(childStopped).toBe(true)
        expect(
          (await new AgentSessionRecoveryCapsule(root).list(NOW)).map((row) => row.sessionId)
        ).toEqual([SESSION])
      })
      register(stopOrcadStructuredAgentSessions)
      return {}
    },
    async () => {}
  )
  await server.stop()
  expect(await host.restartResume.list()).toMatchObject([{ sessionId: SESSION, trigger: 'quit' }])
})
