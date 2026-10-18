import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceRef } from './sort-stamp-records'

/** At most one write per workspace per minute; cleanup judges idleness in days. */
export const TERMINAL_USE_THROTTLE_MS = 60_000

type TerminalUseRecord = { lastTerminalUseAt?: number }
type TerminalUseUpdate = { lastTerminalUseAt: number }

/** The record reads and writes this needs, which the runtime's store satisfies. */
export type TerminalUseStore = {
  getWorktreeMeta: (worktreeId: string) => TerminalUseRecord | undefined
  setWorktreeMeta: (worktreeId: string, updates: TerminalUseUpdate) => unknown
  getWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId
  ) => TerminalUseRecord | undefined
  setWorktreeMetaForHost?: (
    worktreeId: string,
    hostId: ExecutionHostId,
    updates: TerminalUseUpdate
  ) => unknown
  getFolderWorkspace?: (folderWorkspaceId: string) => TerminalUseRecord | undefined
  updateFolderWorkspace?: (folderWorkspaceId: string, updates: TerminalUseUpdate) => unknown
}

export type TerminalUseSources = {
  store: () => TerminalUseStore | null
  /** The workspace a PTY belongs to on this host, or null when this host does not know it. */
  workspaceOfPty: (ptyId: string) => WorkspaceRef | null
  isWriteFenced: (worktreeId: string) => boolean
}

/**
 * Writes when a workspace's terminal was last used, on the host that owns it, for every device:
 * input from the window, a phone or the CLI, and a phone attaching. Output never counts.
 */
export class TerminalUseProducer {
  private readonly writtenAt = new Map<string, number>()

  constructor(private readonly sources: TerminalUseSources) {}

  noteTerminalUse(ptyId: string, now: number): void {
    const workspace = this.sources.workspaceOfPty(ptyId)
    if (!workspace) {
      return
    }
    const key = `${workspace.sshHostId ?? ''}|${workspace.worktreeId}`
    const last = this.writtenAt.get(key)
    if (last !== undefined && now - last < TERMINAL_USE_THROTTLE_MS) {
      return
    }
    // A WSL move only takes this machine's projects.
    if (!workspace.sshHostId && this.sources.isWriteFenced(workspace.worktreeId)) {
      return
    }
    if (this.write(workspace, now)) {
      this.writtenAt.set(key, now)
    }
  }

  // Only a workspace with a record is written; writing would create one for a stale id.
  private write({ worktreeId, sshHostId }: WorkspaceRef, now: number): boolean {
    const store = this.sources.store()
    const update = { lastTerminalUseAt: now }
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      if (!store?.getFolderWorkspace?.(scope.folderWorkspaceId)) {
        return false
      }
      store.updateFolderWorkspace?.(scope.folderWorkspaceId, update)
    } else if (sshHostId) {
      if (!store?.getWorktreeMetaForHost?.(worktreeId, sshHostId)) {
        return false
      }
      store.setWorktreeMetaForHost?.(worktreeId, sshHostId, update)
    } else {
      if (!store?.getWorktreeMeta(worktreeId)) {
        return false
      }
      store.setWorktreeMeta(worktreeId, update)
    }
    return true
  }
}
