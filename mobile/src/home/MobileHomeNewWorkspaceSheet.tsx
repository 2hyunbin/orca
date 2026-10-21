import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { getProvenCachedWorktrees } from '../cache/worktree-cache'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { openExternalLink } from '../platform/external-link'
import type { MobileSessionRouteParams } from '../session/mobile-session-route'
import { useHostClient } from '../transport/host-client-hooks'
import type { RpcClient } from '../transport/rpc-client'
import { useHostStatusGates } from '../transport/host-status-gates'
import type { Worktree } from '../worktree/workspace-list-types'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'

const NO_HOST_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

type Props = {
  hostId: string
  /** Owned by Home, not this sheet: the sheet unmounts as it closes, which would cancel the push. */
  onCreated: (session: MobileSessionRouteParams) => void
  onClose: () => void
}

/** The host screen's Create Workspace sheet, opened over Home for one desktop. */
export function MobileHomeNewWorkspaceSheet({ hostId, onCreated, onClose }: Props) {
  const router = useRouter()
  const { client, state: connState } = useHostClient(hostId)
  const { hostCapabilities, compatVerdict } = useHostStatusGates({ hostId, client, connState })
  const blocked = compatVerdict.kind === 'blocked'
  const worktrees = useHostWorktreeRows(client, connState === 'connected', hostId)
  const worktreePaths = useMemo(() => worktrees.map((worktree) => worktree.path), [worktrees])

  // Why: the host route owns the block screen that explains an incompatible desktop.
  useEffect(() => {
    if (blocked) {
      onClose()
      router.push(hostStackHostRoute(hostId))
    }
  }, [blocked, hostId, onClose, router])

  return (
    <NewWorktreeModalController
      visible={!blocked}
      client={client}
      hostCapabilities={hostCapabilities}
      hostId={hostId}
      hostLabelById={NO_HOST_LABELS}
      existingWorktreePaths={worktreePaths}
      existingWorktrees={worktrees}
      openExternalUrl={openExternalLink}
      onCreated={(worktreeId, name, warning, executionHost) =>
        onCreated({ hostId, worktreeId, name, executionHost, created: true, warning })
      }
      onClose={onClose}
    />
  )
}

/** The host's worktrees, seeded from the catalog Home last read so the sheet never opens blind.
 *  Proven rows only: Home's cold-start seed is a pathless resume row the name picker cannot read. */
function useHostWorktreeRows(
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
