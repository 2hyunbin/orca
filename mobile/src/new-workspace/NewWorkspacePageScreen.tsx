import { useMemo, useState } from 'react'
import { useLocalSearchParams } from 'expo-router'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from '../components/bottom-drawer-constants'
import { InstantDrawerEnterContext } from '../components/instant-drawer-enter'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { useHostWorktreeRows } from '../home/use-host-worktree-rows'
import { useRouteHandoff } from '../navigation/route-handoff'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { firstParam } from '../navigation/route-param-reader'
import { openExternalLink } from '../platform/external-link'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostStatusGates } from '../transport/host-status-gates'

const NO_HOST_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/**
 * The host screen's Create Workspace sheet, alone on a transparent page that the native modal route
 * lays over Home. It opens already in place: the shell's placeholder sheet stood there while loading.
 */
export function NewWorkspacePageScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostStatusGates({ hostId, client, connState })
  const worktrees = useHostWorktreeRows(client, connState === 'connected', hostId)
  const worktreePaths = useMemo(() => worktrees.map((worktree) => worktree.path), [worktrees])
  const [instantEnter] = useState(() => ({ consumed: false }))
  const [visible, setVisible] = useState(true)

  return (
    <InstantDrawerEnterContext.Provider value={instantEnter}>
      <NewWorktreeModalController
        visible={visible}
        client={client}
        hostCapabilities={hostCapabilities}
        hostId={hostId}
        hostLabelById={NO_HOST_LABELS}
        existingWorktreePaths={worktreePaths}
        existingWorktrees={worktrees}
        openExternalUrl={openExternalLink}
        onCreated={(worktreeId, name, warning, executionHost) =>
          router.replace(
            workspaceRouteHref(
              hostNewWorktreeSessionRoute(hostId, worktreeId, name, warning),
              executionHost
            )
          )
        }
        onClose={() => {
          // The sheet slides out first; the native modal under it then goes without a frame.
          setVisible(false)
          setTimeout(() => router.back(), CLOSE_AFTER_SLIDE_MS)
        }}
      />
    </InstantDrawerEnterContext.Provider>
  )
}

const CLOSE_AFTER_SLIDE_MS = BOTTOM_DRAWER_HIDE_DURATION_MS + 16
