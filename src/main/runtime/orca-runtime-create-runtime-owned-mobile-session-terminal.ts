// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalCreateDeduplication } from './orca-runtime-terminal-create-deduplication'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab,
  RuntimeTerminalCreate
} from '../../shared/runtime-types'
import { randomUUID } from 'node:crypto'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { placeCreatedSessionTab } from '../../shared/session-tab-placement'
import {
  buildHeadlessMobileSessionTabGroups,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from './mobile-session-layout-projection'
import { RuntimeMobileTerminalStartup } from './terminal/launch/mobile-terminal-startup'
import { RuntimeMobileTerminalCreate } from './terminal/launch/mobile-terminal-create'
import { RuntimeMobileTerminalRendererCreate } from './terminal/launch/mobile-terminal-renderer-create'
import { RuntimeMobileTerminalOwnedCreate } from './terminal/launch/mobile-terminal-owned-create'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeOwnedMobileTerminalOptions } from './terminal/launch/mobile-terminal-owned-create'

export class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithTerminalCreateDeduplication {
  protected readonly mobileTerminalStartup = new RuntimeMobileTerminalStartup({
    getStore: () => this.store,
    getAgentLaunchPlatformForWorkspace: () =>
      this.sessionPorts.bindRuntimeMethod(this.getAgentLaunchPlatformForWorkspace)
  })
  protected resolveMobileSessionTerminalCommand(
    workspace: TerminalWorkspaceLaunchScope,
    opts: {
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
    }
  ): Promise<{
    command?: string
    env?: Record<string, string>
    envToDelete?: string[]
    startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
    launchConfig?: SleepingAgentLaunchConfig
    launchAgent?: TuiAgent
  }> {
    return this.mobileTerminalStartup.resolveMobileSessionTerminalCommand(workspace, opts)
  }
  protected readonly mobileTerminalCreate = new RuntimeMobileTerminalCreate({
    getMobileTerminalCreateByMutationId: () => this.mobileTerminalCreateByMutationId,
    runCreateMobileSessionTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.runCreateMobileSessionTerminal),
    getValidatedExplicitWorktreeIdSelector: () =>
      this.sessionPorts.bindRuntimeMethod(this.getValidatedExplicitWorktreeIdSelector),
    resolveWorktreeSelector: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorktreeSelector),
    applyMobileSessionTabNavigation: () =>
      this.sessionPorts.bindRuntimeMethod(this.applyMobileSessionTabNavigation),
    getMobileSessionTabsForWorktree: () =>
      this.sessionPorts.bindRuntimeMethod(this.getMobileSessionTabsForWorktree)
  })
  createMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      select?: boolean
      clientNavigationId?: string
      navigation?: RuntimeNavigationTarget
      clientMutationId?: string
      // Older mobile clients optimistically append; preserve that placement until they advertise
      // split-group ordering support.
      supportsSplitGroupPlacement?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return this.mobileTerminalCreate.createMobileSessionTerminal(worktreeSelector, opts)
  }
  protected readonly mobileTerminalRendererCreate = new RuntimeMobileTerminalRendererCreate({
    captureReadyGraphEpoch: () => this.sessionPorts.bindRuntimeMethod(this.captureReadyGraphEpoch),
    resolveTerminalWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchScope),
    resolveWorkspaceTerminalStartupCwd: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorkspaceTerminalStartupCwd),
    hydrateHeadlessMobileSessionTabsFromWorkspaceSession: () =>
      this.sessionPorts.bindRuntimeMethod(
        this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession
      ),
    getMobileSessionTabsByWorktree: () => this.mobileSessionTabsByWorktree,
    resolveMobileSessionTerminalCommand: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveMobileSessionTerminalCommand),
    assertStableReadyGraph: () => this.sessionPorts.bindRuntimeMethod(this.assertStableReadyGraph),
    createRuntimeOwnedMobileSessionTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.createRuntimeOwnedMobileSessionTerminal),
    getAvailableAuthoritativeWindow: () =>
      this.sessionPorts.bindRuntimeMethod(this.getAvailableAuthoritativeWindow),
    getNotifier: () => this.notifier,
    getPendingMobileTerminalCreatesByKey: () => this.pendingMobileTerminalCreatesByKey,
    ensurePtyBackedMobileSurfaceForRendererTab: () =>
      this.sessionPorts.bindRuntimeMethod(this.ensurePtyBackedMobileSurfaceForRendererTab),
    waitForMobileTerminalSurface: () =>
      this.sessionPorts.bindRuntimeMethod(this.waitForMobileTerminalSurface),
    isReadyMobileTerminalSurface: () =>
      this.sessionPorts.bindRuntimeMethod(this.isReadyMobileTerminalSurface),
    deliverPendingStartupCommandToBareRendererPty: () =>
      this.sessionPorts.bindRuntimeMethod(this.deliverPendingStartupCommandToBareRendererPty),
    findMobileTerminalSurface: () =>
      this.sessionPorts.bindRuntimeMethod(this.findMobileTerminalSurface),
    findLiveRegisteredPtyForRendererTab: () =>
      this.sessionPorts.bindRuntimeMethod(this.findLiveRegisteredPtyForRendererTab),
    hasLiveShellForRendererTab: () =>
      this.sessionPorts.bindRuntimeMethod(this.hasLiveShellForRendererTab)
  })
  protected runCreateMobileSessionTerminal(
    worktreeSelector: string,
    opts: {
      afterTabId?: string
      targetGroupId?: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      agent?: TuiAgent
      agentPrompt?: string
      launchConfig?: SleepingAgentLaunchConfig
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      activate?: boolean
      clientNavigationId?: string
      clientMutationId?: string
      supportsSplitGroupPlacement?: boolean
      signal?: AbortSignal
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return this.mobileTerminalRendererCreate.runCreateMobileSessionTerminal(worktreeSelector, opts)
  }
  protected readonly mobileTerminalOwnedCreate = new RuntimeMobileTerminalOwnedCreate({
    resolveTerminalWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchScope),
    resolveWorkspaceTerminalStartupCwd: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorkspaceTerminalStartupCwd),
    createTerminal: () => this.sessionPorts.bindRuntimeMethod(this.createTerminal),
    dedupeTerminalCreate: () => this.sessionPorts.bindRuntimeMethod(this.dedupeTerminalCreate),
    getLivePtyForHandle: () => this.sessionPorts.bindRuntimeMethod(this.getLivePtyForHandle),
    registerPty: () => this.sessionPorts.bindRuntimeMethod(this.registerPty),
    publishRuntimeOwnedMobileSessionTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.publishRuntimeOwnedMobileSessionTerminal)
  })
  protected createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: {
      command?: string
      cwd?: string
      env?: Record<string, string>
      envToDelete?: string[]
      startupCommandDelivery?: WorktreeStartupLaunch['startupCommandDelivery']
      identity?: { tabId: string; leafId: string; sessionId?: string }
      createMutation?: { clientIdentity: string; id: string }
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      targetGroupId?: string
      supportsSplitGroupPlacement?: boolean
      launchConfig?: SleepingAgentLaunchConfig
      signal?: AbortSignal
      refuseSleptWorktree?: boolean
    } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    return this.mobileTerminalOwnedCreate.createRuntimeOwnedMobileSessionTerminal(
      worktreeId,
      activate,
      afterTabId,
      opts
    )
  }

  protected publishRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId: string | undefined,
    opts: RuntimeOwnedMobileTerminalOptions,
    cwd: string | undefined,
    terminal: RuntimeTerminalCreate,
    livePty: { pty: RuntimePtyWorktreeRecord }
  ): RuntimeMobileSessionCreateTerminalResult {
    const parentTabId = livePty.pty.tabId ?? `pty:${livePty.pty.ptyId}`
    const leafId = parsePaneKey(livePty.pty.paneKey ?? '')?.leafId ?? randomUUID()
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    const parentLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      incarnationId: livePty.pty.incarnationId,
      title: terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(cwd ? { startupCwd: cwd } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      parentLayout,
      isActive: activate
    }
    const tabs = placeCreatedSessionTab(
      (existing?.tabs ?? []).map((candidate) => ({
        ...candidate,
        ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
          ? { parentLayout }
          : {}),
        isActive: activate ? false : candidate.isActive
      })),
      tab,
      afterTabId,
      { afterParentGroup: opts.supportsSplitGroupPlacement !== false }
    )
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      // Why: a fresh epoch retires the current publisher, so clients drop its later tab updates.
      publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Why: activating the new tab also focuses its group, so a "+" targeting a specific split group makes that group active too.
      activeGroupId:
        activate && opts.targetGroupId
          ? opts.targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups: buildHeadlessMobileSessionTabGroups(
        worktreeId,
        tabs,
        activate ? tab : null,
        existing?.tabGroups,
        opts.targetGroupId ? { tabId: parentTabId, groupId: opts.targetGroupId } : undefined
      ),
      // Why: keep group split geometry on new-tab creation, else opening a terminal while split loses the arrangement.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Why: emit the stored snapshot, not the pre-store one — storing grafts on retirement
    // proofs, and subscribers dedupe on version so they would never see them otherwise.
    const stored = this.storeMobileSessionSnapshot(worktreeId, next)
    const result = this.toMobileSessionTabsResult(stored)
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    return {
      tab: created,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
  }
}
