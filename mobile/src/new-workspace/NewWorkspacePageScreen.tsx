import { useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { InlineDrawerPresentation } from '../components/inline-drawer-presentation'
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
 * The Create Workspace form as a whole screen: the native drawer route hosts this page, so the
 * form fills that drawer and its pickers replace it in place rather than opening sheets of their own.
 */
export function NewWorkspacePageScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostStatusGates({ hostId, client, connState })
  const worktrees = useHostWorktreeRows(client, connState === 'connected', hostId)
  const worktreePaths = useMemo(() => worktrees.map((worktree) => worktree.path), [worktrees])

  return (
    <InlineDrawerPresentation>
      <NewWorktreeModalController
        visible
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
        onClose={() => router.back()}
      />
    </InlineDrawerPresentation>
  )
}
