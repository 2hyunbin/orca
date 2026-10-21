import type { ExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../worktree/host-qualified-identity'
import { worktreeIdentityKey } from '../worktree/id'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import { isIdleWorkspaceActivity, type WorkspaceActivityFacts } from './workspace-activity-facts'
import type { WorkspaceLifecycleHint } from './workspace-lifecycle-hints'

/** The lifecycle hint main publishes for one host's copy of a workspace. */
export function feedLifecycleHint(
  inProgress: SidebarFeedDomains['inProgress'],
  worktreeId: string,
  executionHostId: ExecutionHostId | null
): WorkspaceLifecycleHint | undefined {
  return executionHostId
    ? inProgress.get(composeWorktreeHostIdentity(executionHostId, worktreeIdentityKey(worktreeId)))
    : undefined
}

/**
 * Whether a workspace reads asleep, for both the sleeping glyph and Hide sleeping, on every client
 * of main's feed. A sleep main is running counts from the moment it is requested; one its host
 * could not confirm (the queue's pause) never does. Otherwise asleep is idle: no live or
 * unverifiable terminal, browser, chat or agent, and not held through a rebind gap.
 */
export function isWorkspaceAsleep(facts: {
  hint: WorkspaceLifecycleHint | undefined
  retained: boolean
  activity: WorkspaceActivityFacts | undefined
}): boolean {
  if (facts.hint?.paused) {
    return false
  }
  if (facts.hint?.kind === 'sleep') {
    return true
  }
  return !facts.retained && (!facts.activity || isIdleWorkspaceActivity(facts.activity))
}

/**
 * How main's sleep of any host's copy of this workspace overrides what its activity says: true
 * while one runs, false while one went unconfirmed, undefined when none is in flight.
 */
export function feedSleepOverride(
  inProgress: SidebarFeedDomains['inProgress'],
  worktreeId: string
): boolean | undefined {
  const wanted = worktreeIdentityKey(worktreeId)
  let override: boolean | undefined
  for (const [key, hint] of inProgress) {
    if (getWorktreeIdFromHostIdentity(key) !== wanted) {
      continue
    }
    if (hint.paused) {
      return false
    }
    if (hint.kind === 'sleep') {
      override = true
    }
  }
  return override
}
