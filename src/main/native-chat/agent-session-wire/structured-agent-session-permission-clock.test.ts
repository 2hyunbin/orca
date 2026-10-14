import { expect, it } from 'vitest'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  REST_TEST_SESSION
} from './structured-agent-session-rest-test-rig'

it('persists a permission choice using the execution host clock', async () => {
  const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  try {
    const attached = await rig.host.attach(REST_TEST_CALLER, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    const startsBeforePick = rig.adapter.acquire.mock.calls.length
    rig.clock.now += 1_000
    const fields = { key: AGENT_CHAT_PERMISSION_MODE_OPTION_ID, value: 'full-access' }
    const result = await rig.host.setOption(REST_TEST_CALLER, {
      envelope: {
        sessionId: REST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: rig.store.getRecord(REST_TEST_SESSION)?.lease.runtimeFence ?? null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: REST_TEST_SESSION,
          fields
        })
      },
      ...fields
    })
    expect(result).toMatchObject({ ok: true })
    expect(rig.store.getRecord(REST_TEST_SESSION)).toMatchObject({
      permissionMode: 'full-access',
      updatedAt: rig.clock.now
    })
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(startsBeforePick)
  } finally {
    await rig.dispose()
  }
})
