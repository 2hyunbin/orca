import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }))

import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { relayHostsFeed } from './relay-hosts-feed'

function desktop(health: () => string): FakeSession {
  const session = new FakeSession('connected')
  session.sendRequest.mockImplementation(async () => ({
    id: 'reply',
    ok: true,
    result: { hosts: [{ hostId: 'runtime:vm', label: 'vm', health: health(), relay: 'ready' }] },
    _meta: { runtimeId: 'runtime-1' }
  }))
  return session
}

function listCalls(session: FakeSession): number {
  return session.sendRequest.mock.calls.filter(
    ([method]) => method === MOBILE_RELAY_HOSTS_LIST_METHOD
  ).length
}

describe('the desktop’s server list', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is read once per poll however many readers share it', async () => {
    const session = desktop(() => 'available')
    const feed = relayHostsFeed(session)
    // The host list reads on its own poll; an open workspace subscribes a second later.
    await feed.read()
    await vi.advanceTimersByTimeAsync(1000)
    const unsubscribe = feed.subscribe(() => {})
    const unsubscribeAgain = feed.subscribe(() => {})
    expect(listCalls(session)).toBe(1)
    // Its timed read waits out the host list's, then both readers share each one.
    await vi.advanceTimersByTimeAsync(1999)
    expect(listCalls(session)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(listCalls(session)).toBe(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(listCalls(session)).toBe(3)
    unsubscribe()
    unsubscribeAgain()
    await vi.advanceTimersByTimeAsync(9000)
    expect(listCalls(session)).toBe(3)
  })

  it('joins a read already in flight', async () => {
    const session = desktop(() => 'available')
    const feed = relayHostsFeed(session)
    const [first, second] = await Promise.all([feed.read(), feed.read()])
    expect(second).toBe(first)
    expect(listCalls(session)).toBe(1)
  })

  it('forgets its answer on a drop, and reads again on reconnect', async () => {
    let health = 'available'
    const session = desktop(() => health)
    const feed = relayHostsFeed(session)
    const unsubscribe = feed.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getSnapshot()?.[0]?.health).toBe('available')
    session.publishState('reconnecting')
    expect(feed.getSnapshot()).toBeNull()
    await vi.advanceTimersByTimeAsync(9000)
    expect(listCalls(session)).toBe(1)
    health = 'error'
    session.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.getSnapshot()?.[0]?.health).toBe('error')
    unsubscribe()
  })
})
