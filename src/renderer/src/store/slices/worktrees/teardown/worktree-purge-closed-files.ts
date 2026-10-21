import type { AppState } from '../../../types'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { collectRemovedHostTwinState } from '../../../repos/repo-removal-host-twin-attribution'
import { fullPurgeFileIds } from './worktree-purge-doomed-ids'
import { collectHostTwinPurgeScopes, twinPurgeFileIds } from './host-twin-worktree-purge'

/**
 * Editor tab ids a purge of `targets` would close, decided the way `buildWorktreePurgeState`
 * decides it: a host target whose id another host still publishes closes only that host's tabs.
 */
export function worktreePurgeClosedFileIds(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): Set<string> {
  const twinScopes = collectHostTwinPurgeScopes(s, targets)
  const twinIds = new Set([...twinScopes.values()].flatMap((twins) => [...twins.keys()]))
  const fullIds = new Set(
    targets.filter((target) => !target.hostId || !twinIds.has(target.id)).map((t) => t.id)
  )
  const closed = fullPurgeFileIds(s, fullIds)
  for (const [hostId, twins] of twinScopes) {
    for (const id of twinPurgeFileIds(
      s,
      collectRemovedHostTwinState(s, new Set(twins.keys()), hostId, twins)
    )) {
      closed.add(id)
    }
  }
  return closed
}
