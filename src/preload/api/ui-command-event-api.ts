import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch
} from '../../shared/worktree/launch-types'
import type { FeatureInteractionId } from '../../shared/feature-interactions'
import type { KeybindingActionId } from '../../shared/keybindings'
import type { BrowserFindSource } from '../../shared/browser-find-source'
import type {
  BrowserHistoryNavigateCommand,
  BrowserPageCommandTarget
} from '../../shared/browser-page-command-target'
import type { BrowserPageZoomCommand } from '../../shared/browser-page-zoom'
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'

export type CloseActiveTabPayload = { sourceId: string }

export type UiCommandEventApi = {
  get: () => Promise<PersistedUIState>
  set: (args: Partial<PersistedUIState>) => Promise<void>
  /** Like set, but REJECTS when the update did not reach the host (the web preload's set
   *  swallows transport failures for offline use). The diff writer needs the distinction:
   *  folding an unacked patch into its baseline would silently stop retrying it (STA-5781). */
  setWithAck?: (args: Partial<PersistedUIState>) => Promise<void>
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<PersistedUIState>
  onStateChanged: (callback: (ui: PersistedUIState) => void) => () => void
  onOpenSettings: (callback: () => void) => () => void
  /** Consumes a one-shot tray/menu-bar "open settings" intent queued before mount. */
  consumePendingOpenSettings: () => Promise<boolean>
  onOpenSkillShare: (callback: (shareId: string) => void) => () => void
  consumePendingSkillShare: () => Promise<string | null>
  /** OS "Open With" Markdown/CSV/TSV documents; the local IPC name is retained. */
  onOpenMarkdownFiles: (callback: (documents: MarkdownDocument[]) => void) => () => void
  /** Drains the "Open With" paths queued before this renderer's listener attached. */
  consumePendingMarkdownFileOpens: () => Promise<MarkdownDocument[]>
  onOpenSetupGuide: (callback: () => void) => () => void
  onOpenFeatureTour: (callback: () => void) => () => void
  onOpenCrashReport: (callback: () => void) => () => void
  onToggleLeftSidebar: (callback: () => void) => () => void
  onToggleRightSidebar: (callback: () => void) => () => void
  onToggleWorktreePalette: (callback: () => void) => () => void
  onToggleFloatingTerminal: (callback: () => void) => () => void
  onTerminalShortcutCaptured: (
    callback: (data: { actionId: KeybindingActionId }) => void
  ) => () => void
  onOpenQuickOpen: (callback: () => void) => () => void
  onToggleQuickCommandsMenu: (callback: () => void) => () => void
  onOpenNewWorkspace: (callback: () => void) => () => void
  onDeleteCurrentWorkspace: (callback: () => void) => () => void
  onOpenWorkspaceBoard: (callback: () => void) => () => void
  onOpenTasks: (callback: () => void) => () => void
  onToggleAgentDashboard: (callback: () => void) => () => void
  onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
  onJumpToTabIndex: (callback: (index: number) => void) => () => void
  onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
  onNewBrowserTab: (callback: () => void) => () => void
  onNewMarkdownTab: (callback: () => void) => () => void
  onNewSimulatorTab: (callback: () => void) => () => void
  onNewTerminalTab: (callback: () => void) => () => void
  onFocusBrowserAddressBar: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onFindInBrowserPage: (source: BrowserFindSource, callback: () => void) => () => void
  onReloadBrowserPage: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onBrowserHistoryNavigate: (
    callback: (command: BrowserHistoryNavigateCommand) => void
  ) => () => void
  onZoomBrowserPage: (callback: (command: BrowserPageZoomCommand) => void) => () => void
  onScrollBrowserPage?: (
    callback: (event: { browserPageId: string; deltaX: number; deltaY: number }) => void
  ) => () => void
  onHardReloadBrowserPage: (callback: (target: BrowserPageCommandTarget) => void) => () => void
  onCloseActiveTab: (callback: (payload?: CloseActiveTabPayload) => void) => () => void
  onCloseFloatingItem: (callback: (payload: { sourceId: string }) => void) => () => void
  onSelectFloatingIndex: (callback: (payload: { index: number }) => void) => () => void
  onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
  onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void) => () => void
  onSwitchRecentTab: (callback: () => void) => () => void
  onSwitchTerminalTab: (callback: (direction: 1 | -1) => void) => () => void
  onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void) => () => void
  onCtrlTabKeyUp: (callback: () => void) => () => void
  onToggleStatusBar: (callback: () => void) => () => void
  onDictationKeyDown: (callback: () => void) => () => void
  onExportPdfRequested: (callback: () => void) => () => void
  onAppMenuPaste: (callback: () => void) => () => void
  onAppMenuSelectionAction: (callback: (action: 'copy' | 'select-all') => void) => () => void
  onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void) => () => void
  onActivateWorktree: (
    callback: (data: {
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: WorktreeStartupLaunch
      defaultTabs?: WorktreeDefaultTabsLaunch
    }) => void
  ) => () => void
  onFocusTerminal: (
    callback: (data: {
      tabId: string
      worktreeId: string
      leafId?: string | null
      ackPaneKeyOnSuccess?: string
      flashFocusedPane?: boolean
      scrollToBottomIfOutputSinceLastView?: boolean
    }) => void
  ) => () => void
  onFocusEditorTab: (
    callback: (data: {
      tabId: string
      worktreeId: string
      /** The user clicked a notification, so revealing the tab is navigation and not a courtesy. */
      userInitiated?: boolean
    }) => void
  ) => () => void
  onMobileMarkdownRequest: (callback: (request: RuntimeMobileMarkdownRequest) => void) => () => void
  respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse) => void
  onSleepWorktree: (callback: (data: { worktreeId: string }) => void) => () => void
  onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void) => () => void
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
  onSystemResumed: (callback: () => void) => () => void
}
