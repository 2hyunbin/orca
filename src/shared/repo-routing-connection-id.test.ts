import { describe, expect, it } from 'vitest'
import { getRepoRoutingConnectionId } from './execution-host'

describe('getRepoRoutingConnectionId', () => {
  it.each([
    ['legacy connectionId', { connectionId: 'gpu' }, 'gpu'],
    ['ssh executionHostId only', { executionHostId: 'ssh:gpu' as const }, 'gpu'],
    [
      'runtime host with nested SSH',
      { executionHostId: 'runtime:env' as const, connectionId: 'gpu' },
      'gpu'
    ],
    [
      'local with a stale connectionId',
      { executionHostId: 'local' as const, connectionId: 'gpu' },
      'gpu'
    ],
    ['local', { executionHostId: 'local' as const }, null],
    ['runtime host', { executionHostId: 'runtime:env' as const }, null],
    ['unstamped', {}, null]
  ])('%s', (_label, repo, expected) => {
    expect(getRepoRoutingConnectionId(repo)).toBe(expected)
  })

  it('agrees with a raw truthy connectionId on every row that has one', () => {
    for (const executionHostId of [undefined, 'local', 'runtime:env', 'ssh:gpu'] as const) {
      expect(getRepoRoutingConnectionId({ executionHostId, connectionId: 'gpu' })).toBe('gpu')
    }
  })
})
