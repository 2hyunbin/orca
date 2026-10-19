import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { ensureDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { sourceControlLaunchWorkspace } from './source-control-launch-agent-args-applicability'
import {
  acquireChatProgramFacts,
  agentsOfferedForLaunch,
  resolveChatProgramHost,
  useChatProgramFactsVersion
} from '@/lib/host-chat-program'

type LaunchTarget = Parameters<typeof sourceControlLaunchWorkspace>[0]

/** Detected agents plus those that open as a chat on the workspace's host without their CLI:
 *  what a Source Control action's Start may run. */
export function useSourceControlLaunchableAgents({
  target,
  connectionId,
  connectionUnavailable
}: {
  target: LaunchTarget
  connectionId: string | null | undefined
  connectionUnavailable: boolean
}) {
  const { worktreeId, repoId, executionHostId } = target
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detecting, setDetecting] = useState(false)
  const refreshDetectedAgents = useCallback(async (): Promise<TuiAgent[]> => {
    if (connectionUnavailable) {
      setDetectedAgents([])
      setDetecting(false)
      return []
    }
    setDetecting(true)
    try {
      const state = useAppStore.getState()
      // Why: the workspace's own host answers, including a paired server's SSH workspace.
      const nextAgents = await (worktreeId
        ? ensureDetectedAgentsForWorktree(state, worktreeId)
        : typeof connectionId === 'string'
          ? state.ensureRemoteDetectedAgents(connectionId)
          : state.ensureDetectedAgents())
      setDetectedAgents(nextAgents)
      return nextAgents
    } finally {
      setDetecting(false)
    }
  }, [connectionId, connectionUnavailable, worktreeId])
  const offerLaunchable = useCallback(
    (detected: TuiAgent[]): TuiAgent[] =>
      agentsOfferedForLaunch(
        useAppStore.getState(),
        sourceControlLaunchWorkspace({ worktreeId, repoId, executionHostId }),
        detected
      ),
    [executionHostId, repoId, worktreeId]
  )
  const refreshAgents = useCallback(async () => {
    const state = useAppStore.getState()
    const host = resolveChatProgramHost(
      state,
      sourceControlLaunchWorkspace({ worktreeId, repoId, executionHostId })
    )
    const [detected] = await Promise.all([
      refreshDetectedAgents(),
      acquireChatProgramFacts(state, host.executionHostId, host.hostCapabilities)
    ])
    return { detected, launchable: offerLaunchable(detected) }
  }, [executionHostId, offerLaunchable, refreshDetectedAgents, repoId, worktreeId])
  const refreshLaunchableAgents = useCallback(
    async (): Promise<TuiAgent[]> => (await refreshAgents()).launchable,
    [refreshAgents]
  )
  // Why: host chat facts live outside React state; this re-renders when they change.
  useChatProgramFactsVersion()
  return {
    detecting,
    refreshAgents,
    refreshLaunchableAgents,
    launchableAgents: offerLaunchable(detectedAgents)
  }
}
