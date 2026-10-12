// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { spawnInAdmittedPane } from './runtime-pane-admission'
import { WorkspaceCreateIdempotency } from './workspaces/workspace-create-idempotency'
import type { RuntimeTerminalCreate, RuntimeTerminalSplit } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { RuntimeTerminalCreateIdentity } from './terminal/launch/terminal-create-identity'
import { RuntimeAgentTerminalLaunch } from './terminal/launch/agent-terminal-launch'
import { RuntimeTerminalCreateLaunch } from './terminal/launch/terminal-create'
import { RuntimeTerminalSplitLaunch } from './terminal/launch/terminal-split'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { Worktree } from '../../shared/worktree/types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

export class OrcaRuntimeWithTerminalCreateDeduplication extends WorkspaceCreateIdempotency {
  protected readonly terminalCreateIdentity = new RuntimeTerminalCreateIdentity({
    getTerminalCreateIdempotency: () => this.terminalCreateIdempotency,
    reconcileRemoteTerminalCreate: () =>
      this.sessionPorts.bindRuntimeMethod(this.reconcileRemoteTerminalCreate),
    resolveTerminalWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchScope),
    getPtyController: () => this.ptyController,
    adoptControllerTerminalHandle: () =>
      this.sessionPorts.bindRuntimeMethod(this.adoptControllerTerminalHandle),
    recordPtyWorktree: () => this.sessionPorts.bindRuntimeMethod(this.recordPtyWorktree),
    issuePtyHandle: () => this.sessionPorts.bindRuntimeMethod(this.issuePtyHandle),
    getPtysById: () => this.ptysById
  })
  dedupeTerminalCreate(
    clientIdentity: string,
    worktreeSelector: string | undefined,
    clientMutationId: string | undefined,
    reconcileExisting: boolean,
    run: (
      canonicalWorktreeSelector: string | undefined,
      preAllocatedHandle: string | undefined
    ) => Promise<RuntimeTerminalCreate>
  ): Promise<RuntimeTerminalCreate> {
    return this.terminalCreateIdentity.dedupeTerminalCreate(
      clientIdentity,
      worktreeSelector,
      clientMutationId,
      reconcileExisting,
      run
    )
  }
  protected reconcileRemoteTerminalCreate(
    worktreeId: string,
    terminalHandle: string,
    // Why: an aggregate listing drops a non-answering SSH host silently, which would read as
    // absence. Scoping to the owning host makes an unreachable relay throw instead.
    connectionId?: string | null
  ): Promise<RuntimeTerminalCreate | null> {
    return this.terminalCreateIdentity.reconcileRemoteTerminalCreate(
      worktreeId,
      terminalHandle,
      connectionId
    )
  }
  protected getPtyExecutionHostMetadata(
    ptyId: string | null
  ): Pick<RuntimeTerminalCreate, 'executionHostId' | 'hostPlatform' | 'incarnationId'> {
    return this.terminalCreateIdentity.getPtyExecutionHostMetadata(ptyId)
  }
  protected readonly agentTerminalLaunch = new RuntimeAgentTerminalLaunch({
    resolveWorktreeSelector: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorktreeSelector),
    getStore: () => this.store,
    buildStartupForAgent: () => this.sessionPorts.bindRuntimeMethod(this.buildStartupForAgent),
    createTerminal: () => this.sessionPorts.bindRuntimeMethod(this.createTerminal),
    sendStartupFollowupWhenReady: () =>
      this.sessionPorts.bindRuntimeMethod(this.sendStartupFollowupWhenReady)
  })
  launchAgentTerminal(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string; extraAgentArgs?: string }
  ): Promise<RuntimeTerminalCreate> {
    return this.agentTerminalLaunch.launchAgentTerminal(worktreeSelector, opts)
  }
  protected readonly terminalCreate = new RuntimeTerminalCreateLaunch({
    assertGraphReady: () => this.sessionPorts.bindRuntimeMethod(this.assertGraphReady),
    getAuthoritativeWindow: () => this.getAuthoritativeWindow(),
    waitForTerminalHandle: () => this.sessionPorts.bindRuntimeMethod(this.waitForTerminalHandle),
    getHandles: () => this.handles,
    spawnInAdmittedPane: () => {
      const spawn = spawnInAdmittedPane
      const store = this.store
      const controller = this.ptyController
      return (args) => spawn(store, controller, args)
    },
    getAvailableAuthoritativeWindow: () =>
      this.sessionPorts.bindRuntimeMethod(this.getAvailableAuthoritativeWindow),
    getPtyController: () => this.ptyController,
    resolveTerminalWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchScope),
    resolveAgentTerminalCreateOptions: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveAgentTerminalCreateOptions),
    resolveWorkspaceTerminalStartupCwd: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveWorkspaceTerminalStartupCwd),
    createPreAllocatedTerminalHandle: () =>
      this.sessionPorts.bindRuntimeMethod(this.createPreAllocatedTerminalHandle),
    getStore: () => this.store,
    getClaudeAgentTeams: () => this.claudeAgentTeams,
    buildTerminalWorkspaceEnv: () =>
      this.sessionPorts.bindRuntimeMethod(this.buildTerminalWorkspaceEnv),
    assertPtyDidNotExitBeforeRegistration: () =>
      this.sessionPorts.bindRuntimeMethod(this.assertPtyDidNotExitBeforeRegistration),
    releaseRejectedPtyRegistrationFence: () =>
      this.sessionPorts.bindRuntimeMethod(this.releaseRejectedPtyRegistrationFence),
    registerPreAllocatedHandleForPty: () =>
      this.sessionPorts.bindRuntimeMethod(this.registerPreAllocatedHandleForPty),
    preparePtyExecutionContext: () =>
      this.sessionPorts.bindRuntimeMethod(this.preparePtyExecutionContext),
    registerPty: () => this.sessionPorts.bindRuntimeMethod(this.registerPty),
    getOrCreatePtyWorktreeRecord: () =>
      this.sessionPorts.bindRuntimeMethod(this.getOrCreatePtyWorktreeRecord),
    nextTitleObservationSequence: () =>
      this.sessionPorts.bindRuntimeMethod(this.nextTitleObservationSequence),
    setPtyManagementTitleFromObservedTitle: () =>
      this.sessionPorts.bindRuntimeMethod(this.setPtyManagementTitleFromObservedTitle),
    getGraphSequence: () => this.graphSequence,
    issuePtyHandle: () => this.sessionPorts.bindRuntimeMethod(this.issuePtyHandle),
    publishPtyBackedMobileSessionTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.publishPtyBackedMobileSessionTerminal),
    getNotifier: () => this.notifier,
    getPtyExecutionHostMetadata: () =>
      this.sessionPorts.bindRuntimeMethod(this.getPtyExecutionHostMetadata)
  })
  createTerminal(
    worktreeSelector?: string,
    opts: TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    created?: Worktree
  ): Promise<RuntimeTerminalCreate> {
    return this.terminalCreate.createTerminal(worktreeSelector, opts, created)
  }
  protected readonly terminalSplit = new RuntimeTerminalSplitLaunch({
    splitPtyBackedTerminal: () => this.sessionPorts.bindRuntimeMethod(this.splitPtyBackedTerminal),
    spawnInAdmittedPane: () => {
      const spawn = spawnInAdmittedPane
      const store = this.store
      const controller = this.ptyController
      return (args) => spawn(store, controller, args)
    },
    getLivePtyForHandle: () => this.sessionPorts.bindRuntimeMethod(this.getLivePtyForHandle),
    assertGraphReady: () => this.sessionPorts.bindRuntimeMethod(this.assertGraphReady),
    getLiveLeafForHandle: () => this.sessionPorts.bindRuntimeMethod(this.getLiveLeafForHandle),
    getNotifier: () => this.notifier,
    waitForLeafInTab: () => this.sessionPorts.bindRuntimeMethod(this.waitForLeafInTab),
    getPtyController: () => this.ptyController,
    resolveTerminalWorkspaceLaunchScope: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalWorkspaceLaunchScope),
    resolveTerminalSplitSourceAuthority: () =>
      this.sessionPorts.bindRuntimeMethod(this.resolveTerminalSplitSourceAuthority),
    createPreAllocatedTerminalHandle: () =>
      this.sessionPorts.bindRuntimeMethod(this.createPreAllocatedTerminalHandle),
    buildTerminalWorkspaceEnv: () =>
      this.sessionPorts.bindRuntimeMethod(this.buildTerminalWorkspaceEnv),
    getStore: () => this.store,
    registerPreAllocatedHandleForPty: () =>
      this.sessionPorts.bindRuntimeMethod(this.registerPreAllocatedHandleForPty),
    preparePtyExecutionContext: () =>
      this.sessionPorts.bindRuntimeMethod(this.preparePtyExecutionContext),
    registerPty: () => this.sessionPorts.bindRuntimeMethod(this.registerPty),
    getOrCreatePtyWorktreeRecord: () =>
      this.sessionPorts.bindRuntimeMethod(this.getOrCreatePtyWorktreeRecord),
    getGraphSequence: () => this.graphSequence,
    setPairedRendererSessionOwnership: () =>
      this.sessionPorts.bindRuntimeMethod(this.setPairedRendererSessionOwnership),
    getPairedRendererSessionOwnedPtyIds: () => this.pairedRendererSessionOwnedPtyIds,
    publishPtyBackedMobileSessionTerminal: () =>
      this.sessionPorts.bindRuntimeMethod(this.publishPtyBackedMobileSessionTerminal),
    issuePtyHandle: () => this.sessionPorts.bindRuntimeMethod(this.issuePtyHandle)
  })
  splitTerminal(
    handle: string,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    return this.terminalSplit.splitTerminal(handle, opts, createdWorktree)
  }
  protected splitPtyBackedTerminal(
    pty: RuntimePtyWorktreeRecord,
    opts: {
      direction?: 'horizontal' | 'vertical'
      command?: string
      env?: Record<string, string>
      envToDelete?: string[]
      activate?: boolean
      // Why: same split as createTerminal — adopt the pane without revealing its
      // workspace, for splits the user never asked to see.
      surfaceOwner?: false
      telemetrySource?: TerminalPaneSplitSource
    } = {},
    createdWorktree?: Worktree
  ): Promise<RuntimeTerminalSplit> {
    return this.terminalSplit.splitPtyBackedTerminal(pty, opts, createdWorktree)
  }
}
