import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

async function queued(text: string): Promise<string> {
  const result = await rig.send(text, 'queue-if-active').result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('expected queued draft')
  }
  return result.value.queued.messageId
}

it('clears the host snapshot atomically before another client resumes it, and replays the answer', async () => {
  const working = await rig.workingSend()
  const first = await queued('A')
  const second = await queued('B')
  await rig.stop()
  await rig.settleAccepted(working, 'stopped')

  const operationId = '1800000000000-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  const otherClient = { callerKey: 'client-2' }
  const [cleared] = await Promise.all([
    rig.clearQueued([first, second], operationId),
    rig.host.queuedMessagesResume(otherClient, {
      envelope: rig.envelope(
        {},
        'agentSession.queuedMessagesResume',
        '1800000000001-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      )
    })
  ])
  expect(cleared).toMatchObject({
    ok: true,
    value: { withdrawn: [first, second], dispatched: [], missing: [] }
  })
  expect(await rig.drafts()).toEqual([])
  expect(await rig.handoff(first)).toBeUndefined()
  expect(await rig.handoff(second)).toBeUndefined()
  expect(await rig.clearQueued([first, second], operationId)).toMatchObject({
    ok: true,
    replayed: true,
    value: { withdrawn: [first, second] }
  })
})
