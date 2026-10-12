import { registerCreatedTerminalSurface } from './terminal-created-surface'
import {
  createTerminalRevealWarning,
  ownerSurfacing,
  resolveTerminalPresentation
} from '../../orca-runtime-core'
import { BACKGROUND_TERMINAL_SPAWN_FLAGS, callerSpawnScope } from './terminal-caller-spawn-scope'
import { newTabIn } from '../../runtime-terminal-spawn-placement'
import { normalizeColorQueryReplyColors } from '../../../../shared/pty-owner-color-query-colors'
import { getTerminalViewerColors, setPairedViewerColors } from '../../terminal-view-attribute-store'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import type { buildClaudeAgentTeamsLaunchPlan } from '../../claude-agent-teams-shim-env'
import { mergeTerminalEnvDeletionKeys } from '../../runtime-agent-launch-resolution'
import {
  admitStablePaneAdoption,
  allocateTerminalPaneIdentity
} from '../../runtime-terminal-pane-identity'
import { randomUUID } from 'node:crypto'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createDesktopTerminal } from './terminal-desktop-create'
import { createPtySpawnCommitReporter } from '../../orca-runtime-report-pty-spawn-commit'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import type { RuntimeTerminalCreateLaunchHost } from './terminal-create-host'

export class RuntimeTerminalCreateLaunch {
  constructor(private readonly host: RuntimeTerminalCreateLaunchHost) {}
  private get notifier() {
    return this.host.getNotifier()
  }
  private get ptyController() {
    return this.host.getPtyController()
  }
  async createTerminal(
    worktreeSelector?: string,
    opts: TerminalCreateOptions = {},
    // Internal creation evidence; RPC and preload callers never supply it.
    created?: Worktree
  ): Promise<RuntimeTerminalCreate> {
    if (opts.startupAgent && worktreeSelector === undefined) {
      throw new Error(`startupAgent ${opts.startupAgent} requires a workspace selector.`)
    }
    const callerColors = normalizeColorQueryReplyColors(opts.terminalColorQueryReplies)
    // Older paired clients report their theme only at creation.
    if (callerColors) {
      setPairedViewerColors(callerColors)
    }
    const presentation = resolveTerminalPresentation(opts)
    const requiresRendererFocus = opts.presentation === 'focused' || opts.focus === true
    const availableAuthoritativeWindow = this.host.getAvailableAuthoritativeWindow()()
    const rendererWindow = opts.rendererBacked === true ? availableAuthoritativeWindow : null
    const shouldCreateInBackground =
      worktreeSelector !== undefined &&
      (Boolean(opts.agentSessionClaim) ||
        (!requiresRendererFocus && opts.rendererBacked !== true) ||
        availableAuthoritativeWindow === null)
    if (shouldCreateInBackground) {
      if (!this.ptyController?.spawn) {
        throw new Error('runtime_unavailable')
      }
      const workspace = await this.host.resolveTerminalWorkspaceLaunchScope()(
        worktreeSelector,
        created
      )
      const launchOpts = await this.host.resolveAgentTerminalCreateOptions()(workspace, opts)
      const reportPtySpawnCommitted = createPtySpawnCommitReporter(launchOpts.onPtySpawnCommitted)
      const cwd =
        this.host.resolveWorkspaceTerminalStartupCwd()(workspace, launchOpts.cwd) ?? workspace.path
      let preAllocatedHandle =
        launchOpts.preAllocatedHandle ?? this.host.createPreAllocatedTerminalHandle()()
      let { tabId, leafId, paneKey } = allocateTerminalPaneIdentity(launchOpts)
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
        const adoptedBeforeLaunch = await this.ptyController.adoptStablePane?.({
          cols: 120,
          rows: 40,
          cwd,
          connectionId: workspace.connectionId,
          worktreeId: workspace.id,
          preAllocatedHandle,
          tabId,
          leafId
        })
        const launchToken = launchOpts.launchConfig
          ? (launchOpts.launchToken ?? randomUUID())
          : undefined
        const baseEnv = {
          ...launchOpts.env,
          ...(launchToken ? { ORCA_AGENT_LAUNCH_TOKEN: launchToken } : {})
        }
        let agentTeamsPlan: Awaited<ReturnType<typeof buildClaudeAgentTeamsLaunchPlan>> | undefined
        let sequencedStartupCommand: string | undefined
        let effectiveLaunchConfig = launchOpts.launchConfig
        try {
          const agentTeams = await buildRuntimeAgentTeamsLaunchPlan({
            launchConfig: launchOpts.launchConfig,
            command: launchOpts.command,
            claudeAgentTeamsSourceCommand: launchOpts.claudeAgentTeamsSourceCommand,
            claudeAgentTeamsMode: this.host.getStore()?.getSettings?.().claudeAgentTeamsMode,
            baseEnv: { ...process.env, ...baseEnv },
            adoptedBeforeLaunch: Boolean(adoptedBeforeLaunch),
            createTeamEnv: (shimDir, shimBin) =>
              this.host.getClaudeAgentTeams().createLaunchEnv({
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
        const env = await this.host.buildTerminalWorkspaceEnv()(
          workspace,
          {
            ...baseEnv,
            ...(sequencedStartupCommand
              ? { [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: sequencedStartupCommand }
              : {})
          },
          paneKey,
          tabId,
          agentTeamsPlan?.env
        )
        const terminalColorQueryReplies = getTerminalViewerColors()
        if (launchOpts.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        let result: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
        try {
          const { launchAgent } = launchOpts
          launchOpts.onPtySpawnDispatched?.({ launchConfig: effectiveLaunchConfig, launchAgent })
          result = await this.host.spawnInAdmittedPane()({
            cols: 120,
            rows: 40,
            cwd,
            command: sequencedStartupCommand
              ? launchOpts.command
              : (agentTeamsPlan?.command ?? launchOpts.command),
            launchAgent: launchOpts.launchAgent,
            commandDelivery: 'provider',
            startupCommandDelivery: launchOpts.startupCommandDelivery,
            env,
            envToDelete: mergeTerminalEnvDeletionKeys(
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
            ...callerSpawnScope(launchOpts),
            ...(launchOpts.onPtySpawnCommitted
              ? { onPtySpawnCommitted: reportPtySpawnCommitted }
              : {}),
            ...(adoptedBeforeLaunch ? { adoptedStablePane: adoptedBeforeLaunch } : {}),
            ...newTabIn(launchOpts),
            ...(launchOpts.sessionId ? { sessionId: launchOpts.sessionId } : {}),
            ...(!adoptedBeforeLaunch && launchOpts.isNewSession ? { isNewSession: true } : {}),
            ...BACKGROUND_TERMINAL_SPAWN_FLAGS
          })
        } finally {
          releaseStablePaneCreate?.()
        }
        if (!result.stablePaneOwner) {
          reportPtySpawnCommitted()
        }
        // Why here: refused before a handle, snapshot or reveal could pose the live PTY as new.
        const adoptedStablePane = admitStablePaneAdoption(result, launchOpts)
        if (result.agentSessionEnsure) {
          const canonicalSurface = result.agentSessionEnsure.owner.surface
          preAllocatedHandle = canonicalSurface.terminalHandle
          tabId = canonicalSurface.tabId
          leafId = canonicalSurface.leafId
          paneKey = makePaneKey(tabId, leafId)
        } else if (result.stablePaneOwner) {
          preAllocatedHandle = result.stablePaneOwner.handle
          tabId = result.stablePaneOwner.tabId
          leafId = result.stablePaneOwner.leafId
          paneKey = makePaneKey(tabId, leafId)
        }
        const { pty, handle } = registerCreatedTerminalSurface(this.host, {
          workspace,
          launchOpts,
          presentation,
          cwd,
          result,
          adoptedStablePane,
          effectiveLaunchConfig,
          launchToken,
          preAllocatedHandle,
          tabId,
          leafId,
          paneKey
        })
        let surface: RuntimeTerminalCreate['surface'] = 'background'
        let warning: string | undefined
        if (presentation !== 'background' && this.notifier?.revealTerminalSession) {
          try {
            await this.notifier.revealTerminalSession(workspace.id, {
              ptyId: result.id,
              title: launchOpts.title ?? null,
              ...(cwd !== workspace.path ? { cwd } : {}),
              ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
              ...(launchToken ? { launchToken } : {}),
              ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
              ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
              activate: presentation === 'focused',
              ...(presentation ? { presentation } : {}),
              ...ownerSurfacing(opts.surfaceOwner !== false),
              tabId,
              leafId
            })
            surface = 'visible'
          } catch (err) {
            console.warn(`[terminal-create] failed to create inactive tab for ${result.id}:`, err)
            warning = createTerminalRevealWarning(handle, err)
          }
        } else if (presentation !== 'background') {
          warning = createTerminalRevealWarning(handle)
        }
        return {
          handle,
          tabId,
          paneKey,
          ptyId: result.id,
          worktreeId: workspace.id,
          title: pty?.title ?? launchOpts.title ?? null,
          ...this.host.getPtyExecutionHostMetadata()(result.id),
          surface,
          ...(result.pid ? { processId: result.pid } : {}),
          ...(result.agentSessionEnsure
            ? { agentSessionDisposition: result.agentSessionEnsure.disposition }
            : {}),
          ...(adoptedStablePane ? { isReattach: true as const } : {}),
          ...(warning ? { warning } : {})
        }
      } finally {
        releaseStablePaneCreate()
      }
    }
    // The renderer owns this spawn, so this process cannot see when it is requested.
    opts.onPtySpawnDispatched?.()
    return createDesktopTerminal(
      this.host,
      worktreeSelector,
      opts,
      presentation,
      rendererWindow,
      created
    )
  }
}
