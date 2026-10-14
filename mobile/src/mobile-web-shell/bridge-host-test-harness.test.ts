import { expect, it, vi } from 'vitest'
import { readBridgeHostMessage } from './bridge/bridge-envelope'
import type * as BridgeEnvelope from './bridge/bridge-envelope'
import { harness } from './bridge-host-test-harness'

vi.mock('./bridge/bridge-envelope', async (original) => {
  const envelope = await original<typeof BridgeEnvelope>()
  return { ...envelope, readBridgeHostMessage: vi.fn(envelope.readBridgeHostMessage) }
})

it('decodes only unread frames and still rejects malformed requested frames', () => {
  const bridge = harness({ ready: true })
  const initial = bridge.posted.at(0)
  if (initial === undefined) {
    throw new Error('The ready handshake posted no frame')
  }
  const cursor = bridge.posted.length
  bridge.posted.push(initial)
  vi.mocked(readBridgeHostMessage).mockClear()

  expect(bridge.frames(cursor)).toHaveLength(1)
  expect(bridge.frames(bridge.posted.length)).toEqual([])
  expect(readBridgeHostMessage).toHaveBeenCalledTimes(1)

  bridge.posted[0] = 'not JSON'
  expect(bridge.frames(cursor)).toHaveLength(1)
  expect(() => bridge.frames()).toThrow('the page would refuse this frame')
  bridge.posted[cursor] = 'not JSON'
  expect(() => bridge.frames(cursor)).toThrow('the page would refuse this frame')
})
