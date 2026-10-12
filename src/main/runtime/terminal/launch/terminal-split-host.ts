import type { RuntimeTerminalSplitLaunch } from './terminal-split'
import type { Worktree } from '../../../../shared/worktree/types'
import type {
  RuntimePtyWorktreeRecord,
  RuntimeLeafRecord
} from '../../runtime-terminal-state-records'
import type { spawnInAdmittedPane } from '../../runtime-pane-admission'
import type { RuntimeStore } from '../../runtime-store-contract'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'

export type RuntimeTerminalSplitLaunchHost = {
  splitPtyBackedTerminal(): RuntimeTerminalSplitLaunch['splitPtyBackedTerminal']
  spawnInAdmittedPane(): (
    args: Parameters<typeof spawnInAdmittedPane>[2]
  ) => ReturnType<typeof spawnInAdmittedPane>
  getLivePtyForHandle(): (handle: string) => {
    record: TerminalHandleRecord
    pty: RuntimePtyWorktreeRecord
  } | null
  assertGraphReady(): () => void
  getLiveLeafForHandle(): (handle: string) => {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }
  getNotifier(): Pick<RuntimeNotifier, 'splitTerminal' | 'revealTerminalSession'> | null
  waitForLeafInTab(): (tabId: string, leafId: string, timeoutMs?) => Promise<string>
  getPtyController(): RuntimePtyController | null
  resolveTerminalWorkspaceLaunchScope(): (
    selector: string,
    createdWorktree?: Worktree
  ) => Promise<TerminalWorkspaceLaunchScope>
  resolveTerminalSplitSourceAuthority(): (
    worktreeId: string,
    tabId: string,
    leafId: string,
    ptyId: string
  ) => {
    persisted: boolean
    rendererMounted: boolean
    persistedWorktreeId: string | null
    persistedIncarnationId: string | null
    liveIncarnationId: string | null
  } | null
  createPreAllocatedTerminalHandle(): () => string
  buildTerminalWorkspaceEnv(): (
    scope: TerminalWorkspaceLaunchScope,
    baseEnv: Record<string, string>,
    paneKey: string,
    tabId: string,
    agentTeamsEnv?: Record<string, string>
  ) => Promise<Record<string, string>>
  getStore(): RuntimeStore | null
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
  getGraphSequence(): number
  setPairedRendererSessionOwnership(): (ptyId: string, owned: boolean) => void
  getPairedRendererSessionOwnedPtyIds(): Set<string>
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
  issuePtyHandle(): (pty: RuntimePtyWorktreeRecord) => string
}
