import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

it('uses each send’s captured choices when two messages arrive during startup', async () => {
  const releaseStart = rig.holdNextStart()
  const first = rig.send('first', undefined, {
    executionOptions: { model: 'model-a', effort: 'high' }
  })
  const second = rig.send('second', undefined, {
    executionOptions: { model: 'model-b', effort: 'low' }
  })
  expect(await first.result).toMatchObject({ ok: true })
  expect(await second.result).toMatchObject({ ok: true })
  expect(rig.dispatch).not.toHaveBeenCalled()
  releaseStart()
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(1))
  await rig.settleAccepted(first.id, 'a')
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls.map(([input]) => input.executionOptions)).toEqual([
    { model: 'model-a', effort: 'high' },
    { model: 'model-b', effort: 'low' }
  ])
  expect(rig.setOption).not.toHaveBeenCalled()
})

it('keeps a draft’s accepted choices through a host restart and Send now', async () => {
  const working = await rig.workingSend()
  const choices = { model: 'model-b', effort: 'low' }
  const queued = await rig.send('use these choices', 'queue-if-active', {
    executionOptions: choices
  }).result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  const draftId = queued.value.queued.messageId
  await rig.restartHostProcess()
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page.ok && page.page.queuedMessages?.[0]?.executionOptions).toEqual(choices)
  await rig.settleAccepted(working, 'a')
  expect(await rig.sendNow(draftId)).toMatchObject({ ok: true })
  expect((await rig.handoff(draftId))?.executionOptions).toEqual(choices)
})
