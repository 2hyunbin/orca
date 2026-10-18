import { describe, expect, it } from 'vitest'
import {
  holdInFlightWorktreeCreate,
  withoutInFlightWorktreeCreates
} from './worktree-create-in-flight'

const rows = [{ path: '/repo' }, { path: '/ws/new' }, { path: '/ws/other' }]

describe('withoutInFlightWorktreeCreates', () => {
  it('omits a held checkout from its own repo until released', () => {
    const release = holdInFlightWorktreeCreate('repo-a', '/ws/new')
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toEqual([
      { path: '/repo' },
      { path: '/ws/other' }
    ])
    expect(withoutInFlightWorktreeCreates('repo-b', rows)).toBe(rows)
    release()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
  })

  it('keeps a second hold on the same path after the first releases', () => {
    const releaseFirst = holdInFlightWorktreeCreate('repo-a', '/ws/new')
    const releaseSecond = holdInFlightWorktreeCreate('repo-a', '/ws/new/')
    releaseFirst()
    releaseFirst()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toHaveLength(2)
    releaseSecond()
    expect(withoutInFlightWorktreeCreates('repo-a', rows)).toBe(rows)
  })
})
