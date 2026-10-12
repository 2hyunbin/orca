import type { RuntimeMobileTerminalStartup } from './mobile-terminal-startup'
import type { RuntimeMobileTerminalOwnedCreate } from './mobile-terminal-owned-create'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { BrowserWindow } from 'electron'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'

export type PendingMobileTerminalCreate = {
  activate: boolean
  paired: boolean
  selectIfNoActiveTab: boolean
  viewMode?: 'terminal' | 'chat'
  startupCommand?: string
}

export type RuntimeMobileTerminalRendererCreateHost = {
  captureReadyGraphEpoch(): () => number
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  resolveWorkspaceTerminalStartupCwd(): (
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ) => string | undefined
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): (
    worktreeId?: string,
    options?: {
      force?: boolean
      allowAttachedWindow?: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      workspaceSession?: WorkspaceSessionState
    }
  ) => Set<string>
  getMobileSessionTabsByWorktree(): ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
  resolveMobileSessionTerminalCommand(): RuntimeMobileTerminalStartup['resolveMobileSessionTerminalCommand']
  assertStableReadyGraph(): (expectedGraphEpoch: number) => void
  createRuntimeOwnedMobileSessionTerminal(): RuntimeMobileTerminalOwnedCreate['createRuntimeOwnedMobileSessionTerminal']
  getAvailableAuthoritativeWindow(): () => BrowserWindow | null
  getNotifier(): Pick<RuntimeNotifier, 'focusTerminal' | 'closeTerminal'> | null
  getPendingMobileTerminalCreatesByKey(): Pick<
    Map<string, PendingMobileTerminalCreate>,
    'set' | 'delete'
  >
  ensurePtyBackedMobileSurfaceForRendererTab(): (
    worktreeId: string,
    tabId: string
  ) => RuntimeMobileSessionCreateTerminalResult | null
  waitForMobileTerminalSurface(): (
    worktreeId: string,
    parentTabId: string,
    options?: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal }
  ) => Promise<RuntimeMobileSessionCreateTerminalResult>
  isReadyMobileTerminalSurface(): (
    surface: RuntimeMobileSessionCreateTerminalResult | null
  ) => boolean
  deliverPendingStartupCommandToBareRendererPty(): (worktreeId: string, tabId: string) => void
  findMobileTerminalSurface(): (
    worktreeId: string,
    parentTabId: string,
    options?: { requireReady?: boolean }
  ) => RuntimeMobileSessionCreateTerminalResult | null
  findLiveRegisteredPtyForRendererTab(): (
    worktreeId: string,
    tabId: string
  ) => RuntimePtyWorktreeRecord | null
  hasLiveShellForRendererTab(): (worktreeId: string, tabId: string) => boolean
}
