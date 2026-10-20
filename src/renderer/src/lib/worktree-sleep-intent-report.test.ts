import { beforeEach, describe, expect, it, vi } from 'vitest'

const reported = vi.hoisted((): string[][] => [])
vi.mock('./sidebar-list-session', () => ({
  reportWindowSleptWorkspaces: (ids: readonly string[]) => reported.push([...ids])
}))

import {
  clearWorktreeSleepIntent,
  forgetWorktreeSleepIntent,
  markWorktreeSleepIntent
} from './worktree-sleep-intent'

describe('the window reports the workspaces it holds asleep', () => {
  beforeEach(() => {
    forgetWorktreeSleepIntent('wt-a')
    forgetWorktreeSleepIntent('wt-b')
    reported.length = 0
  })

  it('reports the whole set on each change, synchronously, so it precedes the PTY kills', () => {
    markWorktreeSleepIntent('wt-a')
    expect(reported).toEqual([['wt-a']])
    markWorktreeSleepIntent('wt-b')
    markWorktreeSleepIntent('wt-b')
    clearWorktreeSleepIntent('wt-a')
    forgetWorktreeSleepIntent('wt-b')
    expect(reported).toEqual([['wt-a'], ['wt-a', 'wt-b'], ['wt-b'], []])
  })

  it('reports nothing for a workspace it did not hold asleep', () => {
    clearWorktreeSleepIntent('wt-a')
    forgetWorktreeSleepIntent('wt-a')
    expect(reported).toEqual([])
  })
})
