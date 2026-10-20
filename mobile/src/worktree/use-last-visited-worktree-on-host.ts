import { useEffect, useState } from 'react'
import { readMirroredKeyOrStore } from '../storage/mirrored-storage-keys'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from './last-visited-worktree-repo'
import {
  readLastVisitedWorktreeOnHost,
  subscribeLastVisitedWorktree,
  type LastVisitedWorktreeOnHost
} from './last-visited-worktree-by-host'

/** The workspace this phone last opened on `hostId`: stored, then each visit as it is written. */
export function useLastVisitedWorktreeOnHost(
  hostId: string | undefined
): LastVisitedWorktreeOnHost | null {
  const [visited, setVisited] = useState<{
    hostId: string
    value: LastVisitedWorktreeOnHost | null
  } | null>(null)

  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    let written = false
    const unsubscribe = subscribeLastVisitedWorktree((visitedHostId, value) => {
      if (visitedHostId === hostId) {
        written = true
        setVisited({ hostId, value })
      }
    })
    void readMirroredKeyOrStore(LAST_VISITED_WORKTREE_STORAGE_KEY)
      .then((raw) => {
        // A visit written while the read was open is newer than anything it returns.
        if (!stale && !written) {
          setVisited({ hostId, value: readLastVisitedWorktreeOnHost(raw, hostId) })
        }
      })
      .catch(() => {})
    return () => {
      stale = true
      unsubscribe()
    }
  }, [hostId])

  // Keyed by host so a switch to another host never shows the last one's visit.
  return visited && visited.hostId === hostId ? visited.value : null
}
