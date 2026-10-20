// Tabs this window asked main to open or close in a layout-owner build, until the frame holding
// main's answer is in. An action on such a tab (select, focus, reveal, clean up) waits for it here.

/** The tab main's frame shows (its own id for a repeat open), or null when main refused. */
type Outcome = string | null

type PendingTab = { worktreeId: string; entityId: string; waiters: ((outcome: Outcome) => void)[] }

const pending = new Map<string, PendingTab>()

/** Marks a tab as asked for; the returned settle runs its waiters once, with main's outcome. */
export function beginPendingTab(
  tabId: string,
  worktreeId: string,
  entityId: string
): (outcome: Outcome) => void {
  const entry: PendingTab = { worktreeId, entityId, waiters: [] }
  pending.set(tabId, entry)
  return (outcome) => {
    if (pending.get(tabId) !== entry) {
      return
    }
    pending.delete(tabId)
    for (const run of entry.waiters) {
      try {
        run(outcome)
      } catch (error) {
        console.warn('[layout-owner] pending tab waiter threw:', error)
      }
    }
  }
}

/** Runs `run` once main answered for this tab; at once with its own id when nothing is pending. */
export function afterPendingTab(tabId: string, run: (outcome: Outcome) => void): void {
  const entry = pending.get(tabId)
  if (entry) {
    entry.waiters.push(run)
  } else {
    run(tabId)
  }
}

/** Runs `run` once every pending tab showing this entity is answered; at once when none is. */
export function afterPendingEntityTabs(
  worktreeId: string,
  entityId: string,
  run: () => void
): void {
  const tabIds = [...pending]
    .filter(([, entry]) => entry.worktreeId === worktreeId && entry.entityId === entityId)
    .map(([tabId]) => tabId)
  afterPendingTabs(tabIds, () => run())
}

/** Runs `run` once each of these tabs is answered, with every outcome in order. */
export function afterPendingTabs(
  tabIds: readonly string[],
  run: (outcomes: Outcome[]) => void
): void {
  const outcomes: Outcome[] = []
  let left = tabIds.length
  if (left === 0) {
    run(outcomes)
    return
  }
  tabIds.forEach((tabId, index) =>
    afterPendingTab(tabId, (outcome) => {
      outcomes[index] = outcome
      left -= 1
      if (left === 0) {
        run(outcomes)
      }
    })
  )
}

export function _resetPendingTabsForTests(): void {
  pending.clear()
}
