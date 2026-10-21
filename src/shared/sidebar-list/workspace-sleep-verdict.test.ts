import { describe, expect, it } from 'vitest'
import { IDLE_WORKSPACE_ACTIVITY } from './workspace-activity-facts'
import { feedSleepOverride, isWorkspaceAsleep } from './workspace-sleep-verdict'
import type { WorkspaceLifecycleHint } from './workspace-lifecycle-hints'

const live = { ...IDLE_WORKSPACE_ACTIVITY, terminal: 'live' as const }
const sleeping: WorkspaceLifecycleHint = { kind: 'sleep', queuedBehind: 0 }

describe('isWorkspaceAsleep', () => {
  it('reads a requested sleep as asleep, and an unconfirmed one as awake', () => {
    expect(isWorkspaceAsleep({ hint: sleeping, retained: false, activity: live })).toBe(true)
    expect(
      isWorkspaceAsleep({
        hint: { ...sleeping, paused: true },
        retained: false,
        activity: undefined
      })
    ).toBe(false)
  })

  it('reads idle as asleep unless held through a rebind gap', () => {
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: undefined })).toBe(true)
    expect(isWorkspaceAsleep({ hint: undefined, retained: true, activity: undefined })).toBe(false)
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: live })).toBe(false)
    const unverifiable = { ...IDLE_WORKSPACE_ACTIVITY, terminal: 'unverifiable' as const }
    expect(isWorkspaceAsleep({ hint: undefined, retained: false, activity: unverifiable })).toBe(
      false
    )
  })
})

describe('feedSleepOverride', () => {
  it("finds any host's sleep of the workspace; an unconfirmed one wins", () => {
    expect(feedSleepOverride(new Map(), 'r::/w/a')).toBeUndefined()
    expect(feedSleepOverride(new Map([['ssh:box|r::/w/a', sleeping]]), 'r::/w/a')).toBe(true)
    expect(
      feedSleepOverride(
        new Map<string, WorkspaceLifecycleHint>([
          ['ssh:box|r::/w/a', sleeping],
          ['local|r::/w/a', { kind: 'wake' as const, queuedBehind: 0, paused: true as const }]
        ]),
        'r::/w/a'
      )
    ).toBe(false)
    expect(
      feedSleepOverride(
        new Map([['local|r::/w/a', { kind: 'close' as const, queuedBehind: 0 }]]),
        'r::/w/a'
      )
    ).toBeUndefined()
  })
})
