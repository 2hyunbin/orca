import type { spawnInAdmittedPane } from '../../runtime-pane-admission'
import type { DesktopTerminalLaunchHost } from './terminal-desktop-create'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ClaudeAgentTeamsService } from '../../claude-agent-teams-service'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { BrowserWindow } from 'electron'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'

export type RuntimeTerminalCreateLaunchHost = {
  spawnInAdmittedPane(): (
    args: Parameters<typeof spawnInAdmittedPane>[2]
  ) => ReturnType<typeof spawnInAdmittedPane>
  getAvailableAuthoritativeWindow(): () => BrowserWindow | null
  getPtyController(): RuntimePtyController | null
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  resolveAgentTerminalCreateOptions(): (
    workspace: TerminalWorkspaceLaunchScope,
    opts: TerminalCreateOptions
  ) => Promise<TerminalCreateOptions>
  resolveWorkspaceTerminalStartupCwd(): (
    workspace: Pick<TerminalWorkspaceLaunchScope, 'path'>,
    requestedCwd?: string | null
  ) => string | undefined
  createPreAllocatedTerminalHandle(): () => string
  getStore(): Pick<RuntimeStore, 'getSettings'> | null
  getClaudeAgentTeams(): Pick<ClaudeAgentTeamsService, 'createLaunchEnv'>
  buildTerminalWorkspaceEnv(): (
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ) => Promise<Record<string, string>>
  assertPtyDidNotExitBeforeRegistration(): (
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ) => void
  releaseRejectedPtyRegistrationFence(): (
    ptyId: string,
    candidateIncarnation?: PtyIncarnationId
  ) => void
  registerPreAllocatedHandleForPty(): (ptyId: string, handle: string) => void
  preparePtyExecutionContext(): (
    ptyId: string,
    wslDistro: string | null,
    options?: { resetIncarnation?: boolean; preserveExisting?: boolean }
  ) => boolean
  registerPty(): (
    ptyId: string,
    worktreeId: string,
    connectionId?: string | null,
    binding?: {
      tabId: string
      leafId: string
      incarnationId?: PtyIncarnationId
      /** Handle allocated for the replacement incarnation, when one is known. */
      terminalHandle?: string
      agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
      providerReattachLaunchIdentity?: {
        incarnationId: PtyIncarnationId
        launchAgent: TuiAgent
      }
    },
    isWsl?: boolean
  ) => void
  getOrCreatePtyWorktreeRecord(): (ptyId: string) => RuntimePtyWorktreeRecord | null
  nextTitleObservationSequence(): () => number
  setPtyManagementTitleFromObservedTitle(): (
    pty: RuntimePtyWorktreeRecord,
    title: string | null | undefined,
    observedAt: number
  ) => void
  getGraphSequence(): number
  issuePtyHandle(): (pty: RuntimePtyWorktreeRecord) => string
  publishPtyBackedMobileSessionTerminal(): (
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    args: {
      tabId: string
      leafId: string
      title: string | null
      activate: boolean
      selectIfNoActiveTab?: boolean
      startupCwd?: string
      viewMode?: 'terminal' | 'chat'
      split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
      notify?: boolean
    }
  ) => void
  getNotifier(): Pick<RuntimeNotifier, 'revealTerminalSession'> | null
  getPtyExecutionHostMetadata(): (
    ptyId: string | null
  ) => Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'>
} & DesktopTerminalLaunchHost
