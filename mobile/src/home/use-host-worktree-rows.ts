import { useEffect, useState } from 'react'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-types'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'

/** The host's worktrees, seeded from the catalog Home last read so the sheet never opens blind.
 *  Proven rows only: Home's cold-start seed is a pathless resume row the name picker cannot read. */
export function useHostWorktreeRows(
  client: RpcClient | null,
  connected: boolean,
  hostId: string
): readonly Pick<Worktree, 'path' | 'repoId' | 'branch'>[] {
  const [rows, setRows] = useState(() => getProvenCachedWorktrees(hostId) ?? [])

  useEffect(() => {
    if (!client || !connected) {
      return
    }
    let live = true
    // Single-flight: shares Home's own catalog read when one is already in the air.
    worktreeCatalogRead
      .requestSingleFlight(client, hostId, { limit: WORKTREE_PS_FULL_LIMIT })
      .then((reply) => {
        const catalog = worktreeCatalogRead.interpret(reply)
        if (live && catalog.accepted && catalog.value.worktrees) {
          setRows(catalog.value.worktrees)
        }
      })
      // A failed read keeps the seeded rows.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, connected, hostId])

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: proven worktree.ps rows, which the host screen's snapshot client admits as `Worktree`; the sheet reads only these three.
  return rows as Pick<Worktree, 'path' | 'repoId' | 'branch'>[]
}
