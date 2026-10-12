// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTerminalCreateDeduplication } from './orca-runtime-terminal-create-deduplication'
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import { buildRuntimeAgentTeamsLaunchPlan } from './orca-runtime-agent-teams-launch-plan'
import { createPtySpawnCommitReporter } from './orca-runtime-report-pty-spawn-commit'
import { recordPtySurface, spawnSurfaceClaimSequence } from './pty-recorded-surface-topology'
import { DESKTOP_VIEW_ID } from '../../shared/workspace-layout/workspace-layout-views'

export class OrcaRuntimeWithCreateTerminal extends OrcaRuntimeWithTerminalCreateDeduplication {
  async createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    created?: dependencies.Worktree
  ): Promise<dependencies.RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const callerColors = dependencies.normalizeColorQueryReplyColors(opts.terminalColorQueryReplies)
    // Older paired clients report their theme only at creation.
    if (callerColors) {
      dependencies.setPairedViewerColors(callerColors)
    }
    const presentation = dependencies.resolveTerminalPresentation(opts)
    if (!this.ptyController?.spawn) {
      throw new Error('runtime_unavailable')
    }
    // The shell is resolved on the workspace's execution host, which a workspace-less create lacks.
    if (worktreeSelector === undefined && opts.shellOverride) {
      throw new Error(
        `--shell ${opts.shellOverride} needs a workspace, because the shell is resolved on the workspace's execution host. No terminal was created.`
      )
    }
    // A create that names no workspace opens in the one the desktop view shows, as the window did.
    const shownWorktreeId = this.layoutCommands.views.record(DESKTOP_VIEW_ID).activeWorktreeId
    if (worktreeSelector === undefined && !shownWorktreeId) {
      throw new Error('No workspace is open to create the terminal in')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(
      worktreeSelector ?? `id:${shownWorktreeId}`,
      created
    )
    const launchOpts = await this.resolveAgentTerminalCreateOptions(workspace, opts)
    const reportPtySpawnCommitted = createPtySpawnCommitReporter(launchOpts.onPtySpawnCommitted)
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd) ?? workspace.path
    let preAllocatedHandle =
      launchOpts.preAllocatedHandle ?? this.createPreAllocatedTerminalHandle()
    let { tabId, leafId, paneKey } = dependencies.allocateTerminalPaneIdentity(launchOpts)
    const claimedStablePaneCreate = this.ptyController.claimStablePaneCreate?.({
      worktreeId: workspace.id,
      connectionId: workspace.connectionId,
      tabId,
      leafId
    })
    let stablePaneCreateReleased = false
    const releaseStablePaneCreate = (): void => {
      if (stablePaneCreateReleased) {
        return
      }
      stablePaneCreateReleased = true
      claimedStablePaneCreate?.()
    }
    try {
      if (launchOpts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      const size = launchOpts.initialSize ?? { cols: 120, rows: 40 }
      const adoptedBeforeLaunch = await this.ptyController.adoptStablePane?.({
        ...size,
        cwd,
        connectionId: workspace.connectionId,
        worktreeId: workspace.id,
        preAllocatedHandle,
        tabId,
        leafId
      })
      const launchToken = launchOpts.launchConfig
        ? (launchOpts.launchToken ?? dependencies.randomUUID())
        : undefined
      const baseEnv = {
        ...launchOpts.env,
        ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
      }
      let agentTeamsPlan: Awaited<ReturnType<typeof dependencies.buildClaudeAgentTeamsLaunchPlan>>
      let sequencedStartupCommand: string | undefined
      let effectiveLaunchConfig = launchOpts.launchConfig
      try {
        const agentTeams = await buildRuntimeAgentTeamsLaunchPlan({
          launchConfig: launchOpts.launchConfig,
          command: launchOpts.command,
          claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
          claudeAgentTeamsMode: this.store?.getSettings?.().claudeAgentTeamsMode,
          baseEnv: { ...process.env, ...baseEnv },
          adoptedBeforeLaunch,
          createTeamEnv: (shimDir, shimBin) =>
            this.claudeAgentTeams.createLaunchEnv({
              leaderHandle: preAllocatedHandle,
              baseEnv: { ...process.env, ...baseEnv },
              shimDir,
              shimBin
            }).env
        })
        agentTeamsPlan = agentTeams.plan
        sequencedStartupCommand = agentTeams.sequencedStartupCommand
        effectiveLaunchConfig = agentTeams.effectiveLaunchConfig
      } catch (error) {
        releaseStablePaneCreate?.()
        throw error
      }
      const env = await this.buildTerminalWorkspaceEnv(
        workspace,
        {
          ...baseEnv,
          ...(sequencedStartupCommand
            ? { [dependencies.SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
            : {})
        },
        paneKey,
        tabId,
        agentTeamsPlan?.env
      )
      const terminalColorQueryReplies = dependencies.getTerminalViewerColors()
      if (launchOpts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let result: Awaited<ReturnType<NonNullable<dependencies.RuntimePtyController['spawn']>>>
      try {
        const { launchAgent } = launchOpts
        launchOpts.onPtySpawnDispatched?.({ launchConfig: effectiveLaunchConfig, launchAgent })
        result = await dependencies.spawnInAdmittedPane(this.layoutHolder, this.ptyController, {
          ...size,
          ...(launchOpts.paneStart ? { paneStart: launchOpts.paneStart } : {}),
          cwd,
          command: sequencedStartupCommand
            ? launchOpts.command
            : (agentTeamsPlan?.command ?? launchOpts.command),
          launchAgent: launchOpts.launchAgent,
          commandDelivery: 'provider',
          startupCommandDelivery: launchOpts.startupCommandDelivery,
          env,
          envToDelete: dependencies.mergeTerminalEnvDeletionKeys(
            launchOpts.envToDelete,
            agentTeamsPlan?.envToDelete
          ),
          resumeProviderSession: launchOpts.resumeProviderSession,
          telemetry: launchOpts.telemetry,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId,
          ...(launchOpts.shellOverride ? { shellOverride: launchOpts.shellOverride } : {}),
          ...(terminalColorQueryReplies ? { terminalColorQueryReplies } : {}),
          terminalKittyKeyboardProtocol: launchOpts.terminalKittyKeyboardProtocol,
          ...(launchOpts.agentSessionClaim
            ? {
                agentSessionEnsure: {
                  claim: launchOpts.agentSessionClaim,
                  surface: {
                    worktreeId: workspace.id,
                    tabId,
                    leafId,
                    terminalHandle: preAllocatedHandle
                  }
                }
              }
            : {}),
          ...(launchOpts.agentSessionCreateOperationId
            ? { agentSessionCreateOperationId: launchOpts.agentSessionCreateOperationId }
            : {}),
          ...dependencies.callerSpawnScope(launchOpts),
          ...(launchOpts.onPtySpawnCommitted
            ? { onPtySpawnCommitted: reportPtySpawnCommitted }
            : {}),
          ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
          onSpawned: (spawned) => {
            if (!spawned.stablePaneOwner) {
              reportPtySpawnCommitted()
            }
            try {
              this.assertPtyDidNotExitBeforeRegistration(spawned.id, spawned.incarnationId)
            } catch (error) {
              if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
                this.releaseRejectedPtyRegistrationFence(spawned.id, spawned.incarnationId)
              }
              throw error
            }
          },
          ...this.terminalCreatePlacement(workspace.id, tabId, leafId, launchOpts),
          ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
          ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
          ...dependencies.BACKGROUND_TERMINAL_SPAWN_FLAGS
        })
      } finally {
        releaseStablePaneCreate?.()
      }
      // Why here: refused before a handle, snapshot or reveal could pose the live PTY as new.
      const adoptedStablePane = dependencies.admitStablePaneAdoption(result, launchOpts)
      if (result.agentSessionEnsure) {
        const canonicalSurface = result.agentSessionEnsure.owner.surface
        preAllocatedHandle = canonicalSurface.terminalHandle
        tabId = canonicalSurface.tabId
        leafId = canonicalSurface.leafId
        paneKey = dependencies.makePaneKey(tabId, leafId)
      } else if (result.stablePaneOwner) {
        preAllocatedHandle = result.stablePaneOwner.handle
        tabId = result.stablePaneOwner.tabId
        leafId = result.stablePaneOwner.leafId
        paneKey = dependencies.makePaneKey(tabId, leafId)
      }
      this.registerPreAllocatedHandleForPty(result.id, preAllocatedHandle)
      if (result.wslDistro) {
        this.preparePtyExecutionContext(result.id, result.wslDistro)
      }
      this.registerPty(result.id, workspace.id, workspace.connectionId, {
        tabId,
        leafId,
        terminalHandle: preAllocatedHandle,
        ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
      })
      const pty = this.getOrCreatePtyWorktreeRecord(result.id)
      if (pty) {
        pty.runtimeSessionOwned = true
        if (!adoptedStablePane) {
          if (launchOpts.title) {
            const observedAt = this.nextTitleObservationSequence()
            pty.title = launchOpts.title
            pty.titleUpdatedAt = observedAt
            this.setPtyManagementTitleFromObservedTitle(pty, launchOpts.title, observedAt)
          } else {
            pty.title = null
            pty.titleUpdatedAt = null
          }
          pty.launchConfig = effectiveLaunchConfig
            ? dependencies.copySleepingAgentLaunchConfig(effectiveLaunchConfig)
            : null
          pty.launchToken = launchToken ?? null
          pty.launchIncarnationId = launchToken ? pty.incarnationId : null
          pty.launchAgent = launchOpts.launchAgent ?? null
        }
        recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(this.graphSequence))
      }
      const handle = pty ? this.issuePtyHandle(pty) : preAllocatedHandle
      if (pty && this.desktopViewShowsCreatedTerminal(workspace.id, presentation)) {
        this.focusHeldTerminalInDesktopView(pty, { navigate: presentation === 'focused' })
      }
      // The layout every view reads holds the tab, so a shown create is discoverable.
      const surface: dependencies.RuntimeTerminalCreate['surface'] =
        presentation === 'background' ? 'background' : 'visible'
      return {
        handle,
        tabId,
        paneKey,
        ptyId: result.id,
        worktreeId: workspace.id,
        title: pty?.title ?? launchOpts.title ?? null,
        ...this.getPtyExecutionHostMetadata(result.id),
        surface,
        ...(result.pid ? { processId: result.pid } : {}),
        ...(result.agentSessionEnsure
          ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
          : {}),
        ...(adoptedStablePane ? { isReattach: true as const } : {})
      }
    } finally {
      releaseStablePaneCreate()
    }
  }
}
