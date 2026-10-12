import type { RuntimeTerminalCreateLaunchHost } from './terminal-create-host'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { copySleepingAgentLaunchConfig } from '../../runtime-agent-launch-resolution'
import { recordPtySurface, spawnSurfaceClaimSequence } from '../../pty-recorded-surface-topology'

type TerminalCreatePublication = {
  workspace: TerminalWorkspaceLaunchScope
  launchOpts: TerminalCreateOptions
  presentation: RuntimeTerminalPresentation | undefined
  cwd: string
  result: Awaited<ReturnType<NonNullable<RuntimePtyController['spawn']>>>
  adoptedStablePane: boolean
  effectiveLaunchConfig: TerminalCreateOptions['launchConfig']
  launchToken: string | undefined
  preAllocatedHandle: string
  tabId: string
  leafId: string
  paneKey: string
}
export function registerCreatedTerminalSurface(
  host: Pick<
    RuntimeTerminalCreateLaunchHost,
    | 'assertPtyDidNotExitBeforeRegistration'
    | 'releaseRejectedPtyRegistrationFence'
    | 'registerPreAllocatedHandleForPty'
    | 'preparePtyExecutionContext'
    | 'registerPty'
    | 'getOrCreatePtyWorktreeRecord'
    | 'nextTitleObservationSequence'
    | 'setPtyManagementTitleFromObservedTitle'
    | 'getGraphSequence'
    | 'issuePtyHandle'
    | 'publishPtyBackedMobileSessionTerminal'
  >,
  args: TerminalCreatePublication
): { pty: RuntimePtyWorktreeRecord | null; handle: string } {
  const {
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
  } = args
  try {
    host.assertPtyDidNotExitBeforeRegistration()(result.id, result.incarnationId)
  } catch (error) {
    if (error instanceof Error && error.message === 'agent_session_exited_during_start') {
      host.releaseRejectedPtyRegistrationFence()(result.id, result.incarnationId)
    }
    throw error
  }
  host.registerPreAllocatedHandleForPty()(result.id, preAllocatedHandle)
  if (result.wslDistro) {
    host.preparePtyExecutionContext()(result.id, result.wslDistro)
  }
  host.registerPty()(result.id, workspace.id, workspace.connectionId, {
    tabId,
    leafId,
    terminalHandle: preAllocatedHandle,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
  })
  const pty = host.getOrCreatePtyWorktreeRecord()(result.id)
  if (pty) {
    pty.runtimeSessionOwned = true
    if (!adoptedStablePane) {
      if (launchOpts.title) {
        const observedAt = host.nextTitleObservationSequence()()
        pty.title = launchOpts.title
        pty.titleUpdatedAt = observedAt
        host.setPtyManagementTitleFromObservedTitle()(pty, launchOpts.title, observedAt)
      } else {
        pty.title = null
        pty.titleUpdatedAt = null
      }
      pty.launchConfig = effectiveLaunchConfig
        ? copySleepingAgentLaunchConfig(effectiveLaunchConfig)
        : null
      pty.launchToken = launchToken ?? null
      pty.launchIncarnationId = launchToken ? pty.incarnationId : null
      pty.launchAgent = launchOpts.launchAgent ?? null
    }
    recordPtySurface(pty, tabId, paneKey, spawnSurfaceClaimSequence(host.getGraphSequence()))
  }
  const handle = pty ? host.issuePtyHandle()(pty) : preAllocatedHandle
  if (pty && !adoptedStablePane && launchOpts.deferMobileSessionPublish !== true) {
    host.publishPtyBackedMobileSessionTerminal()(workspace.id, pty, {
      tabId,
      leafId,
      title: launchOpts.title ?? null,
      activate: presentation === 'focused',
      selectIfNoActiveTab: presentation !== 'background',
      ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
      ...(cwd !== workspace.path ? { startupCwd: cwd } : {})
    })
  }
  return { pty, handle }
}
