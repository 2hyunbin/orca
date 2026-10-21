import {
  readTerminalInterface,
  registerTerminalInterfacePresentation,
  terminalInterfaceReleasesChat
} from '../../native-chat/terminal-interface-presentation'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import { isPaneResumingInPlace, isPaneSpawnDeferred } from '@/lib/pane-spawn-deferral-registry'
import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { isRemoteExecutionHostPtyId } from '../../../../../shared/remote-execution-host-pty-id'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPaneTerminalInterfacePresentation(session: ConnectPanePtySession): void {
  const pending = (): boolean =>
    Boolean(
      session.disposed ||
      session.pendingStartupCommand ||
      session.startupInjectTimer !== null ||
      session.transportConnectInFlightSince !== null ||
      session.pendingSpawnDeferral ||
      session.hibernatedWakeTarget ||
      pendingSpawnByPaneKey.has(session.pendingSpawnKey) ||
      isPaneSpawnDeferred(session.cacheKey) ||
      isPaneResumingInPlace(session.cacheKey) ||
      session.restartReplacementPtyId === session.transport.getPtyId() ||
      session.deps.isPtyShutdownPending(session.transport.getPtyId())
    )
  const releasePresentation = registerTerminalInterfacePresentation(session.cacheKey, {
    ptyId: () => session.transport.getPtyId(),
    incarnation: () => session.remotePtyIncarnationId ?? null,
    pending,
    cold: () => {
      const state = useAppStore.getState()
      const ptyId = session.transport.getPtyId()
      const row = state.agentStatusByPaneKey[session.cacheKey]
      return Boolean(
        ptyId &&
        session.spawnedFreshPtyId !== ptyId &&
        !isRemoteExecutionHostPtyId(ptyId) &&
        row &&
        isTuiAgent(row.agentType) &&
        !row.structuredHostOwned &&
        (!row.observation || row.observation.origin === 'hook') &&
        !state.agentLaunchConfigByPaneKey[session.cacheKey] &&
        !session.paneStartup?.launchConfig &&
        !session.paneExpectsLaunchAgent(state) &&
        !session.paneStartup?.command &&
        !pending() &&
        !session.paneForegroundAgentTracker?.hasReadInFlight() &&
        !state.pendingStartupByTabId?.[session.deps.tabId] &&
        !state.automaticAgentResumeClaimsByTabId?.[session.deps.tabId]
      )
    }
  })
  const releaseEffects = useAppStore.subscribe((state, previous) => {
    if (!terminalInterfaceReleasesChat(state, session.cacheKey)) {
      return
    }
    const observation = readTerminalInterface(state, session.cacheKey)?.observation
    const before = readTerminalInterface(previous, session.cacheKey)?.observation
    if (observation?.state === 'shell' && before?.state !== 'shell') {
      session.clearStaleAgentTabTitleOnConfirmedShell()
      session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
    }
  })
  session.unregisterTerminalInterfacePresentation = () => {
    releaseEffects()
    releasePresentation()
  }
}
