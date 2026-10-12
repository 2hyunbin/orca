import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type {
  WorktreeBaseStatusEvent,
  WorktreeRemoteBranchConflictEvent
} from '../../shared/worktree/base-ref-drift-types'
import type {
  RuntimeBrowserDriverState,
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeTerminalDriverState
} from '../../shared/runtime-types'

type DriverState = RuntimeTerminalDriverState

export type RuntimeNotifier = {
  automationsChanged?(payload: {
    selector?: { kind: 'self' } | { kind: 'ssh'; targetId: string } | { kind: 'orphan' }
    reason?: 'definition' | 'run' | 'usage'
  }): void
  worktreesChanged(
    repoId: string,
    renamed?: { oldWorktreeId: string; newWorktreeId: string },
    // Why: false for metadata-only changes (sort order) that leave Git scan results valid.
    options?: { invalidateGitScans?: boolean }
  ): void
  worktreeBaseStatus?(event: WorktreeBaseStatusEvent): void
  worktreeRemoteBranchConflict?(event: WorktreeRemoteBranchConflictEvent): void
  reposChanged(): void
  readMobileMarkdownTab?(worktreeId: string, tabId: string): Promise<RuntimeMarkdownReadTabResult>
  saveMobileMarkdownTab?(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult>
  sleepWorktree(worktreeId: string): void
  // Why: a phone opening a worktree wakes its slept agents by asking the host
  // renderer to run its own navigation-free wake (experimental agent sleep);
  // the runtime has no in-memory sleeping records or wake authority. Optional to
  // match the many renderer-backed notifier methods only the real bridge wires.
  resumeSleepingAgents?(worktreeId: string): void
  terminalFitOverrideChanged(
    ptyId: string,
    mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit',
    cols: number,
    rows: number
  ): void
  // Why: presence-based lock signal — desktop renderer mounts the lock
  // banner when `driver.kind === 'mobile'` and unmounts otherwise. The
  // structured payload (vs a `locked: boolean`) carries the active mobile
  // actor's clientId so the renderer can disambiguate multi-phone scenarios
  // and so a future write coordinator can use the same signal as scheduling
  // input. See docs/mobile-presence-lock.md.
  terminalDriverChanged(ptyId: string, driver: DriverState): void
  nativeChatLaunchDraftResolved?(
    tabId: string,
    resolution: { text: string; createdAt: number }
  ): void
  browserDriverChanged?(browserPageId: string, driver: RuntimeBrowserDriverState): void
  browserRemoteViewersChanged?(browserPageId: string, hasRemoteViewers: boolean): void
  clientHostedBrowserRowsChanged?(event: ClientHostedBrowserRowsEvent): void
}
