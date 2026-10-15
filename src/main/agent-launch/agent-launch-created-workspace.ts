import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { AgentLaunchWorkspaceFactory } from './agent-launch-surface-factories'

export type InitialSurfaceLaunch = NonNullable<
  RuntimeMobileSessionTabsResult['initialSurfaceLaunch']
>

// Keyed by runtime so the fact lives exactly as long as the creation operation that owns it.
const liveLaunches = new WeakMap<object, Map<string, InitialSurfaceLaunch>>()

/** The creation operation owns the new workspace's first surface (chat, agent terminal or folder
 *  agent) from registration until it publishes that surface or fails. */
export function beginCreatedWorkspaceLaunch(
  runtime: object,
  agent: TuiAgent
): {
  onWorkspaceCreated: (worktreeId: string) => void
  createdWorktreeId: () => string | undefined
  release: () => void
} {
  const launch: InitialSurfaceLaunch = { launchId: randomUUID(), agent }
  let worktreeId: string | undefined
  return {
    onWorkspaceCreated: (createdId) => {
      worktreeId = createdId
      let byWorktree = liveLaunches.get(runtime)
      if (!byWorktree) {
        byWorktree = new Map()
        liveLaunches.set(runtime, byWorktree)
      }
      byWorktree.set(createdId, launch)
    },
    createdWorktreeId: () => worktreeId,
    release: () => {
      if (!worktreeId) {
        return
      }
      const byWorktree = liveLaunches.get(runtime)
      if (byWorktree?.get(worktreeId) !== launch) {
        return
      }
      byWorktree.delete(worktreeId)
      if (byWorktree.size === 0) {
        liveLaunches.delete(runtime)
      }
    }
  }
}

export function readCreatedWorkspaceLaunch(
  runtime: object,
  worktreeId: string
): InitialSurfaceLaunch | undefined {
  return liveLaunches.get(runtime)?.get(worktreeId)
}

export async function recoverCreatedWorkspace(
  workspaces: AgentLaunchWorkspaceFactory | undefined,
  worktreeId: string
): Promise<void> {
  try {
    await workspaces?.createRecoveryShell?.(worktreeId)
  } catch (error) {
    console.warn('[agent-launch] Failed to create a recovery shell:', error)
  }
}
