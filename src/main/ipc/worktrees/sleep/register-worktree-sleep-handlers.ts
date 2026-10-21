import { ipcMain } from 'electron'
import type { WorkspaceSleepRequest } from '../../../../shared/workspace-sleep'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

/** The window's Sleep: main runs it on each workspace's hosts and the window follows its notices. */
export function registerWorktreeSleepHandlers(context: WorktreeIpcContext): void {
  ipcMain.handle('worktrees:sleep', (_event, request: WorkspaceSleepRequest) =>
    context.runtime.sleepWorkspaces(request)
  )
}
