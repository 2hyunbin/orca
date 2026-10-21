import { useMemo } from 'react'
import { useLocalSearchParams } from 'expo-router'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { useHostWorktreeRows } from './use-host-worktree-rows'
import { useRouteHandoff } from '../navigation/route-handoff'
import { firstParam } from '../navigation/route-param-reader'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { openExternalLink } from '../platform/external-link'
import { useHostClient } from '../transport/host-client-hooks'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'

const NO_HOST_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/**
 * The host screen's Create Workspace drawer, alone on a transparent page. Closing it leaves the
 * screen that opened it; creating opens the new workspace's session in its place.
 */
export function NewWorkspacePageScreen() {
  const params = useLocalSearchParams<{ hostId?: string | string[] }>()
  const hostId = firstParam(params.hostId)
  const router = useRouteHandoff()
  const { client, state: connState } = useHostClient(hostId)
  const { hostCapabilities } = useHostProtocolGates()
  const worktrees = useHostWorktreeRows(client, connState === 'connected', hostId)
  const worktreePaths = useMemo(() => worktrees.map((worktree) => worktree.path), [worktrees])

  return (
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
  )
}
