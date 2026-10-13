// Saving a choice never waits for the live agent.

import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { framesOf, openAttachedHostRig, stop } from './acp-structured-host.test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

function pick(host: StructuredAgentSessionHost, value: string) {
  const fields = { key: 'model', value }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

/** Whether `promise` settled within `ms`, and how. */
async function within(promise: Promise<unknown>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ settled: 'resolved' as const, value }),
        (error: unknown) => ({ settled: 'rejected' as const, value: error })
      ),
      late
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('a saved Grok pick', () => {
  it.each(['Stop', 'Close'] as const)(
    'never contacts Grok or holds %s behind a setter',
    async (ending) => {
      const { rig, host, store } = await openAttachedHostRig({
        script: (agent) => agent.on('session/set_config_option', () => {})
      })
      expect(await within(pick(host, 'grok-4.6'), 1_000)).toMatchObject({
        settled: 'resolved',
        value: { ok: true }
      })
      expect(store.getRecord(SESSION)?.options?.model).toBe('grok-4.6')
      expect(framesOf(rig.child(), 'session/set_config_option')).toEqual([])
      const ended = ending === 'Stop' ? stop(host) : host.close(SESSION, 'user-close')
      expect(await within(ended, 2_000)).toMatchObject({ settled: 'resolved' })
      await host.close(SESSION, 'user-close')
    }
  )
})
